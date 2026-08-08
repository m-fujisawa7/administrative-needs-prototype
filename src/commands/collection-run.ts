import { pathToFileURL } from 'node:url';
import { formatCollectionRunSummary } from '../collection-run/format.ts';
import {
  executeSourceCollection,
  type CollectionExecutionDependencies,
} from '../collection-run/execute.ts';
import {
  CollectionStateError,
  parseSinceDate,
  readCollectionState,
  type CollectionState,
} from '../collection-run/state.ts';
import type { CollectionRunCliOptions } from '../collection-run/types.ts';
import { NotionConfigurationError } from '../notion-check/errors.ts';
import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import {
  parseValueOption,
  resolveNotionDatabaseId,
  setOptionOnce,
} from './cli-options.ts';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export type CollectionRunCommandDependencies = CollectionExecutionDependencies & {
  now?: () => Date;
  readState?: () => Promise<CollectionState>;
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
  let state: CollectionState;
  try {
    options = parseCollectionRunArgs(argv);
    state = await (dependencies.readState ?? readCollectionState)();
  } catch (error) {
    stderr(error instanceof CollectionStateError
      ? error.message
      : safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  const outcome = await executeSourceCollection(
    { options, runStartedAt, state },
    dependencies,
  );
  if (outcome.report === null) return outcome.exitCode;
  stdout(formatCollectionRunSummary(outcome.report));
  return outcome.exitCode;
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
