import { pathToFileURL } from 'node:url';
import {
  formatCollectionRunItem,
  formatCollectionRunSummary,
} from '../collection-run/format.ts';
import { processCollectedCandidates } from '../collection-run/run.ts';
import type {
  CollectionRunCliOptions,
  CollectionRunReport,
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
    limit: number,
  ) => Promise<SourceCheckSample[]>;
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
      ['--source', '--limit', '--database-url', '--database-id'],
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
    if (parsed.name === '--limit') {
      if (limitSpecified) {
        throw new NotionConfigurationError('--limit may only be specified once.');
      }
      limit = parseLimit(parsed.value);
      limitSpecified = true;
    }
  }

  if (sourceId === undefined) throw new NotionConfigurationError('--source is required.');
  return {
    sourceId,
    limit,
    databaseId: resolveNotionDatabaseId(databaseUrl, databaseId),
    write,
  };
}

export async function runCollection(
  argv = process.argv.slice(2),
  dependencies: CollectionRunCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;

  let options: CollectionRunCliOptions;
  let sourceContext: Awaited<ReturnType<typeof resolveRegistrationSourceContext>>;
  try {
    options = parseCollectionRunArgs(argv);
    sourceContext = await resolveRegistrationSourceContext(options.sourceId, dependencies);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }
  const { source, organization } = sourceContext;

  let candidates: SourceCheckSample[];
  try {
    const collectCandidates = dependencies.collectCandidates
      ?? ((selectedSource, selectedOrganization, limit) =>
        collectSourceCandidates(selectedSource, selectedOrganization, {}, limit));
    candidates = await collectCandidates(source, organization, options.limit);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  if (candidates.length === 0) {
    const report: CollectionRunReport = {
      write: options.write,
      sourceId: options.sourceId,
      candidatesCollected: 0,
      uniqueCandidates: 0,
      results: [],
    };
    stdout(formatCollectionRunSummary(report));
    return 0;
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
    options.sourceId,
    candidates,
    options.limit,
    options.write,
    (candidate) => runtime.register(candidate.url, options.write),
    (item, index, total) => {
      for (const warning of item.result.warnings) {
        stderr(`[${index}/${total}] [WARNING] [${warning.code}] ${warning.message}`);
      }
      stdout(formatCollectionRunItem(item, index, total));
    },
  );
  stdout(formatCollectionRunSummary(collectionReport));
  return collectionReport.results.some((item) => item.result.status === 'failed') ? 1 : 0;
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
