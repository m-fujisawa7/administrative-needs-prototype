import type { CollectionExecutionDependencies } from './execute.ts';
import { executeSourceCollection } from './execute.ts';
import type { CollectionState } from './state.ts';
import type { CollectionRunItemResult, CollectionRunReport } from './types.ts';

export type CollectionBatchSourceOutcome = {
  sourceId: string;
  created: number;
  previewed: number;
  duplicates: number;
  failed: number;
  remaining: number;
  /** Advanced（stateを進めた） / Not advanced / Failed（Source取得自体が失敗） */
  state: 'Advanced' | 'Not advanced' | 'Failed';
  reason?: string;
};

export type CollectionBatchReport = {
  write: boolean;
  sourcesSelected: number;
  outcomes: CollectionBatchSourceOutcome[];
  totals: {
    created: number;
    previewed: number;
    duplicates: number;
    failed: number;
    remaining: number;
  };
};

export type RunCollectionBatchInput = {
  sourceIds: readonly string[];
  limit: number;
  databaseId: string;
  write: boolean;
  since?: string;
  runStartedAt: Date;
  state: CollectionState;
};

export type CollectionBatchDependencies = CollectionExecutionDependencies & {
  /** テストで差し替える。既定は共通サービスの executeSourceCollection。 */
  executeSource?: typeof executeSourceCollection;
};

/**
 * 複数Sourceを逐次収集する。
 *
 * Source単位の処理は executeSourceCollection（collect:run と共有）に委譲するため、
 * Candidate収集・期間判定・Notion重複確認・Claude分析・Notion登録・収集状態の更新は
 * バッチ用に再実装していない。
 *
 * 1つのSourceが失敗しても残りのSourceを続行する。収集状態はSourceごとに判定され、
 * バッチ全体の成否では進めない。
 */
export async function runCollectionBatch(
  input: RunCollectionBatchInput,
  dependencies: CollectionBatchDependencies = {},
): Promise<{ report: CollectionBatchReport; exitCode: 0 | 1 }> {
  const stdout = dependencies.stdout ?? console.log;
  const executeSource = dependencies.executeSource ?? executeSourceCollection;

  const outcomes: CollectionBatchSourceOutcome[] = [];
  // 前のSourceが進めた収集状態を引き継ぐ。一括更新はしない。
  let state = input.state;
  let anyFailure = false;

  for (const [index, sourceId] of input.sourceIds.entries()) {
    stdout(formatBatchSourceHeader(sourceId, index + 1, input.sourceIds.length));

    const options = {
      sourceId,
      limit: input.limit,
      databaseId: input.databaseId,
      write: input.write,
      ...(input.since === undefined ? {} : { since: input.since }),
    };

    const outcome = await executeSource(
      { options, runStartedAt: input.runStartedAt, state },
      dependencies,
    );
    state = outcome.state;
    if (outcome.exitCode === 1) anyFailure = true;
    outcomes.push(summarizeSource(sourceId, outcome.report, outcome.failure));
  }

  const report: CollectionBatchReport = {
    write: input.write,
    sourcesSelected: input.sourceIds.length,
    outcomes,
    totals: {
      created: sum(outcomes, (outcome) => outcome.created),
      previewed: sum(outcomes, (outcome) => outcome.previewed),
      duplicates: sum(outcomes, (outcome) => outcome.duplicates),
      failed: sum(outcomes, (outcome) => outcome.failed),
      remaining: sum(outcomes, (outcome) => outcome.remaining),
    },
  };
  return { report, exitCode: anyFailure ? 1 : 0 };
}

export function formatBatchSourceHeader(
  sourceId: string,
  index: number,
  total: number,
): string {
  return `\n===== [${index}/${total}] ${sourceId} =====`;
}

function summarizeSource(
  sourceId: string,
  report: CollectionRunReport | null,
  failure: string | undefined,
): CollectionBatchSourceOutcome {
  if (report === null) {
    return {
      sourceId,
      created: 0,
      previewed: 0,
      duplicates: 0,
      failed: 0,
      remaining: 0,
      state: 'Failed',
      ...(failure === undefined ? {} : { reason: failure }),
    };
  }

  const count = (status: CollectionRunItemResult['result']['status']): number =>
    report.results.filter((item) => item.result.status === status).length;

  const base = {
    sourceId,
    created: count('created'),
    previewed: count('previewed'),
    duplicates: count('duplicate'),
    failed: count('failed'),
    remaining: report.remainingNewCandidates,
  };
  return report.collectionState.status === 'advanced'
    ? { ...base, state: 'Advanced' }
    : { ...base, state: 'Not advanced', reason: report.collectionState.reason };
}

function sum(
  outcomes: readonly CollectionBatchSourceOutcome[],
  pick: (outcome: CollectionBatchSourceOutcome) => number,
): number {
  return outcomes.reduce((total, outcome) => total + pick(outcome), 0);
}
