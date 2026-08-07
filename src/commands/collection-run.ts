import { pathToFileURL } from 'node:url';
import {
  formatCollectionRunItem,
  formatCollectionRunStarted,
  formatCollectionRunSummary,
} from '../collection-run/format.ts';
import {
  filterCandidatesByPeriod,
  processCollectedCandidates,
  selectUniqueCandidates,
} from '../collection-run/run.ts';
import {
  CollectionStateError,
  parseSinceDate,
  readCollectionState,
  resolveCollectionPeriod,
  writeCollectionStateAtomic,
  type CollectionState,
} from '../collection-run/state.ts';
import type {
  CollectionRunCliOptions,
  CollectionRunReport,
  CollectionStateOutcome,
} from '../collection-run/types.ts';
import { NotionConfigurationError } from '../notion-check/errors.ts';
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
import type {
  Organization,
  Source,
} from '../source-registry/schema.ts';
import {
  parseValueOption,
  resolveNotionDatabaseId,
  setOptionOnce,
} from './cli-options.ts';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export type CollectionRunCommandDependencies = NotionRegistrationRuntimeDependencies & {
  collectCandidates?: (
    source: Source,
    organization: Organization,
  ) => Promise<SourceCheckSample[]>;
  now?: () => Date;
  readState?: () => Promise<CollectionState>;
  writeState?: (state: CollectionState) => Promise<void>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseCollectionRunArgs(argv: string[]): CollectionRunCliOptions {
  let sourceId: string | undefined;
  let databaseUrl: string | undefined;
  let databaseId: string | undefined;
  let limit = DEFAULT_LIMIT;
  let limitSpecified = false;
  let write = false;
  let since: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') {
      if (write) throw new NotionConfigurationError('--write may only be specified once.');
      write = true;
      continue;
    }
    const parsed = parseValueOption(
      argv,
      index,
      argument,
      ['--source', '--since', '--limit', '--database-url', '--database-id'],
    );
    if (parsed === null) throw new NotionConfigurationError(`Unknown option: ${argument}`);
    index += parsed.consumedNext ? 1 : 0;
    if (parsed.name === '--source') {
      sourceId = setOptionOnce(sourceId, parsed.value, parsed.name);
    }
    if (parsed.name === '--database-url') {
      databaseUrl = setOptionOnce(databaseUrl, parsed.value, parsed.name);
    }
    if (parsed.name === '--database-id') {
      databaseId = setOptionOnce(databaseId, parsed.value, parsed.name);
    }
    if (parsed.name === '--since') {
      since = setOptionOnce(since, parseSinceDate(parsed.value), parsed.name);
    }
    if (parsed.name === '--limit') {
      if (limitSpecified) {
        throw new NotionConfigurationError('--limit may only be specified once.');
      }
      limit = parseLimit(parsed.value);
      limitSpecified = true;
    }
  }

  if (sourceId === undefined) throw new NotionConfigurationError('--source is required.');
  const options: CollectionRunCliOptions = {
    sourceId,
    limit,
    databaseId: resolveNotionDatabaseId(databaseUrl, databaseId),
    write,
  };
  if (since !== undefined) options.since = since;
  return options;
}

export async function runCollection(
  argv = process.argv.slice(2),
  dependencies: CollectionRunCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const runStartedAt = (dependencies.now ?? (() => new Date()))();

  let options: CollectionRunCliOptions;
  let sourceContext: Awaited<ReturnType<typeof resolveRegistrationSourceContext>>;
  let state: CollectionState;
  try {
    options = parseCollectionRunArgs(argv);
    sourceContext = await resolveRegistrationSourceContext(options.sourceId, dependencies);
    state = await (dependencies.readState ?? readCollectionState)();
  } catch (error) {
    stderr(error instanceof CollectionStateError
      ? error.message
      : safeNotionRegistrationErrorMessage(error));
    return 1;
  }
  const { source, organization } = sourceContext;
  const previousSuccessfulCheck = state[options.sourceId]?.last_successful_check_at ?? null;
  const period = resolveCollectionPeriod(
    runStartedAt,
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
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  const uniqueCandidates = selectUniqueCandidates(candidates);
  const periodSelection = filterCandidatesByPeriod(
    uniqueCandidates,
    period.effectiveSince,
    period.runStartedAt,
  );
  for (const candidate of periodSelection.unknownDateCandidates) {
    stderr([
      'Warning:',
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
    const stateExitCode = await finalizeCollectionState(
      report,
      options,
      period.runStartedAt,
      state,
      dependencies,
      stderr,
    );
    stdout(formatCollectionRunSummary(report));
    return stateExitCode;
  }

  let runtime: NotionRegistrationRuntime;
  try {
    runtime = await prepareNotionRegistrationRuntime(
      sourceContext,
      options.databaseId,
      dependencies,
    );
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(unwrapNotionRegistrationRuntimeError(error)));
    return 1;
  }
  const collectionReport = await processCollectedCandidates(
    {
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
          stderr(`[${index}/${total}] [WARNING] [${warning.code}] ${warning.message}`);
        }
        stdout(formatCollectionRunItem(item, index, total));
      },
    },
  );
  const stateExitCode = await finalizeCollectionState(
    collectionReport,
    options,
    period.runStartedAt,
    state,
    dependencies,
    stderr,
  );
  stdout(formatCollectionRunSummary(collectionReport));
  return stateExitCode === 1
    || collectionReport.results.some((item) => item.result.status === 'failed')
    ? 1
    : 0;
}

async function finalizeCollectionState(
  report: CollectionRunReport,
  options: CollectionRunCliOptions,
  runStartedAt: string,
  state: CollectionState,
  dependencies: CollectionRunCommandDependencies,
  stderr: (message: string) => void,
): Promise<0 | 1> {
  const outcome = determineCollectionStateOutcome(report, options, runStartedAt);
  report.collectionState = outcome;
  if (outcome.status !== 'advanced') return 0;

  const nextState: CollectionState = {
    ...state,
    [options.sourceId]: { last_successful_check_at: runStartedAt },
  };
  try {
    await (dependencies.writeState ?? writeCollectionStateAtomic)(nextState);
    return 0;
  } catch {
    report.collectionState = {
      status: 'not_advanced',
      reason: 'Failed to write collection state.',
    };
    stderr('Failed to write collection state.');
    return 1;
  }
}

function determineCollectionStateOutcome(
  report: CollectionRunReport,
  options: CollectionRunCliOptions,
  runStartedAt: string,
): CollectionStateOutcome {
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

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new NotionConfigurationError(`--limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCollection().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
