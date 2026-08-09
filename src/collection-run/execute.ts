import { formatWarningLine } from '../ai/warning-severity.ts';
import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import {
  prepareNotionRegistrationRuntime,
  resolveRegistrationSourceContext,
  unwrapNotionRegistrationRuntimeError,
  type NotionRegistrationRuntime,
  type NotionRegistrationRuntimeDependencies,
} from '../notion-register/runtime.ts';
import { collectSourceCandidates } from '../source-check/index.ts';
import type { SourceCheckSample } from '../source-check/types.ts';
import type { Organization, Source } from '../source-registry/schema.ts';
import {
  formatClaudeUsageLimitStop,
  formatCollectionRunItem,
  formatCollectionRunStarted,
} from './format.ts';
import {
  filterCandidatesByPeriod,
  processCollectedCandidates,
  selectUniqueCandidates,
} from './run.ts';
import {
  resolveCollectionPeriod,
  writeCollectionStateAtomic,
  type CollectionState,
} from './state.ts';
import type {
  ClaudeUsageLimitStop,
  CollectionRunCliOptions,
  CollectionRunReport,
  CollectionStateOutcome,
} from './types.ts';

export type CollectionExecutionDependencies = NotionRegistrationRuntimeDependencies & {
  collectCandidates?: (
    source: Source,
    organization: Organization,
  ) => Promise<SourceCheckSample[]>;
  writeState?: (state: CollectionState) => Promise<void>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export type ExecuteSourceCollectionInput = {
  options: CollectionRunCliOptions;
  /** 実行開始時刻。バッチでは全Sourceで同じ値を使う。 */
  runStartedAt: Date;
  /** 直前までの収集状態。バッチでは前のSourceの更新結果を渡す。 */
  state: CollectionState;
};

export type ExecuteSourceCollectionOutcome = {
  /** Source取得自体に失敗した場合は null。 */
  report: CollectionRunReport | null;
  /** 更新後の収集状態。stateを進めなかった場合は入力と同じ。 */
  state: CollectionState;
  exitCode: 0 | 1;
  /** Source単位の失敗メッセージ。成功時は undefined。 */
  failure?: string;
  /** Claude CLIの利用上限で打ち切った場合だけ設定する。呼び出し側は後続を止める。 */
  usageLimit?: ClaudeUsageLimitStop;
};

/**
 * 1つのSourceに対する収集フローを実行する。
 *
 * collect:run と collect:batch がこの関数を共有する。Candidate収集・期間判定・
 * Notion重複確認・HTML/PDF取得・Claude分析・Notion登録・収集状態の更新は
 * すべてここを通るため、CLIごとに再実装しない。
 */
export async function executeSourceCollection(
  input: ExecuteSourceCollectionInput,
  dependencies: CollectionExecutionDependencies = {},
): Promise<ExecuteSourceCollectionOutcome> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const { options, state } = input;

  let sourceContext: Awaited<ReturnType<typeof resolveRegistrationSourceContext>>;
  try {
    sourceContext = await resolveRegistrationSourceContext(options.sourceId, dependencies);
  } catch (error) {
    const message = safeNotionRegistrationErrorMessage(error);
    stderr(message);
    return { report: null, state, exitCode: 1, failure: message };
  }

  const { source, organization } = sourceContext;
  const previousSuccessfulCheck = state[options.sourceId]?.last_successful_check_at ?? null;
  const period = resolveCollectionPeriod(
    input.runStartedAt,
    previousSuccessfulCheck,
    options.since,
  );
  stdout(formatCollectionRunStarted(options, period));

  let candidates: SourceCheckSample[];
  try {
    const collectCandidates = dependencies.collectCandidates
      ?? ((selectedSource, selectedOrganization) =>
        collectSourceCandidates(selectedSource, selectedOrganization));
    candidates = await collectCandidates(source, organization);
  } catch (error) {
    const message = safeNotionRegistrationErrorMessage(error);
    stderr(message);
    return { report: null, state, exitCode: 1, failure: message };
  }

  const uniqueCandidates = selectUniqueCandidates(candidates);
  const periodSelection = filterCandidatesByPeriod(
    uniqueCandidates,
    period.effectiveSince,
    period.runStartedAt,
  );
  for (const candidate of periodSelection.unknownDateCandidates) {
    stderr([
      'Notice:',
      'Candidate publication date is unavailable.',
      '',
      'URL:',
      candidate.url,
    ].join('\n'));
  }

  if (periodSelection.candidates.length === 0) {
    const report: CollectionRunReport = {
      write: options.write,
      sourceId: options.sourceId,
      effectiveSince: period.effectiveSince,
      runStartedAt: period.runStartedAt,
      candidatesCollected: candidates.length,
      uniqueCandidates: uniqueCandidates.length,
      candidatesInPeriod: 0,
      newCandidatesFound: 0,
      processedNewCandidates: 0,
      remainingNewCandidates: 0,
      results: [],
      collectionState: notEvaluatedState(),
    };
    const finalized = await finalizeCollectionState(
      report,
      options,
      period.runStartedAt,
      state,
      dependencies,
      stderr,
    );
    return { report, state: finalized.state, exitCode: finalized.exitCode };
  }

  let runtime: NotionRegistrationRuntime;
  try {
    runtime = await prepareNotionRegistrationRuntime(
      sourceContext,
      options.databaseId,
      dependencies,
    );
  } catch (error) {
    const message = safeNotionRegistrationErrorMessage(
      unwrapNotionRegistrationRuntimeError(error),
    );
    stderr(message);
    return { report: null, state, exitCode: 1, failure: message };
  }

  const report = await processCollectedCandidates({
    sourceId: options.sourceId,
    candidates: periodSelection.candidates,
    candidatesCollected: candidates.length,
    uniqueCandidates: uniqueCandidates.length,
    effectiveSince: period.effectiveSince,
    runStartedAt: period.runStartedAt,
    limit: options.limit,
    write: options.write,
    checkDuplicate: runtime.checkDuplicate,
    processor: (candidate) => runtime.register(candidate.url, options.write),
    onResult: (item, index, total) => {
      for (const warning of item.result.warnings) {
        stderr(formatWarningLine(warning, `[${index}/${total}] `));
      }
      stdout(formatCollectionRunItem(item, index, total));
    },
  });

  const finalized = await finalizeCollectionState(
    report,
    options,
    period.runStartedAt,
    state,
    dependencies,
    stderr,
  );
  if (report.usageLimit !== undefined) {
    stderr(formatClaudeUsageLimitStop(report.usageLimit));
  }
  const hasFailure = report.results.some((item) => item.result.status === 'failed');
  return {
    report,
    state: finalized.state,
    exitCode: finalized.exitCode === 1 || hasFailure ? 1 : 0,
    ...(report.usageLimit === undefined ? {} : { usageLimit: report.usageLimit }),
  };
}

async function finalizeCollectionState(
  report: CollectionRunReport,
  options: CollectionRunCliOptions,
  runStartedAt: string,
  state: CollectionState,
  dependencies: CollectionExecutionDependencies,
  stderr: (message: string) => void,
): Promise<{ state: CollectionState; exitCode: 0 | 1 }> {
  const outcome = determineCollectionStateOutcome(report, options, runStartedAt);
  report.collectionState = outcome;
  if (outcome.status !== 'advanced') return { state, exitCode: 0 };

  const nextState: CollectionState = {
    ...state,
    [options.sourceId]: { last_successful_check_at: runStartedAt },
  };
  try {
    await (dependencies.writeState ?? writeCollectionStateAtomic)(nextState);
    return { state: nextState, exitCode: 0 };
  } catch {
    report.collectionState = {
      status: 'not_advanced',
      reason: 'Failed to write collection state.',
    };
    stderr('Failed to write collection state.');
    return { state, exitCode: 1 };
  }
}

function determineCollectionStateOutcome(
  report: CollectionRunReport,
  options: CollectionRunCliOptions,
  runStartedAt: string,
): CollectionStateOutcome {
  if (report.usageLimit !== undefined) {
    return {
      status: 'not_advanced',
      reason: 'Claude CLI usage limit reached.',
    };
  }
  if (!options.write) {
    return { status: 'not_advanced', reason: 'Preview mode.' };
  }
  if (options.since !== undefined) {
    return {
      status: 'not_advanced',
      reason: 'Manual --since override was used.',
    };
  }
  if (report.results.some((item) => item.result.status === 'failed')) {
    return {
      status: 'not_advanced',
      reason: 'One or more candidates failed.',
    };
  }
  if (report.remainingNewCandidates > 0) {
    return {
      status: 'not_advanced',
      reason: 'Unprocessed candidates remain because of --limit.',
    };
  }
  return { status: 'advanced', newLastSuccessfulCheck: runStartedAt };
}

function notEvaluatedState(): CollectionStateOutcome {
  return {
    status: 'not_advanced',
    reason: 'Collection state has not been evaluated.',
  };
}
