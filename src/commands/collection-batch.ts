import { pathToFileURL } from 'node:url';
import {
  runCollectionBatch,
  type CollectionBatchDependencies,
} from '../collection-run/batch.ts';
import { formatCollectionBatchSummary } from '../collection-run/format.ts';
import {
  CollectionStateError,
  parseSinceDate,
  readCollectionState,
  type CollectionState,
} from '../collection-run/state.ts';
import { NotionConfigurationError } from '../notion-check/errors.ts';
import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import {
  getEnabledSources,
  getSourcesByMunicipality,
  listOrganizationNames,
  loadSourceRegistry,
} from '../source-registry/load.ts';
import type { SourceRegistry } from '../source-registry/schema.ts';
import {
  parseValueOption,
  resolveNotionDatabaseId,
  setOptionOnce,
} from './cli-options.ts';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export type CollectionBatchSelection =
  | { kind: 'municipality'; municipality: string }
  | { kind: 'all' }
  | { kind: 'sources'; sourceIds: string[] };

export type CollectionBatchCliOptions = {
  selection: CollectionBatchSelection;
  limit: number;
  databaseId: string;
  write: boolean;
  since?: string;
};

export type CollectionBatchCommandDependencies = CollectionBatchDependencies & {
  now?: () => Date;
  loadRegistry?: () => Promise<SourceRegistry>;
  readState?: () => Promise<CollectionState>;
};

export function parseCollectionBatchArgs(argv: string[]): CollectionBatchCliOptions {
  let municipality: string | undefined;
  let sources: string | undefined;
  let all = false;
  let databaseUrl: string | undefined;
  let databaseId: string | undefined;
  let since: string | undefined;
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
    if (argument === '--all') {
      if (all) throw new NotionConfigurationError('--all may only be specified once.');
      all = true;
      continue;
    }

    const parsed = parseValueOption(argv, index, argument, [
      '--municipality',
      '--sources',
      '--database-url',
      '--database-id',
      '--since',
      '--limit',
    ]);
    if (parsed === null) throw new NotionConfigurationError(`Unknown option: ${argument}`);
    index += parsed.consumedNext ? 1 : 0;

    if (parsed.name === '--municipality') {
      municipality = setOptionOnce(municipality, parsed.value, '--municipality');
    } else if (parsed.name === '--sources') {
      sources = setOptionOnce(sources, parsed.value, '--sources');
    } else if (parsed.name === '--database-url') {
      databaseUrl = setOptionOnce(databaseUrl, parsed.value, '--database-url');
    } else if (parsed.name === '--database-id') {
      databaseId = setOptionOnce(databaseId, parsed.value, '--database-id');
    } else if (parsed.name === '--since') {
      since = parseSinceDate(setOptionOnce(since, parsed.value, '--since'));
    } else {
      if (limitSpecified) {
        throw new NotionConfigurationError('--limit may only be specified once.');
      }
      limit = parseLimit(parsed.value);
      limitSpecified = true;
    }
  }

  const options: CollectionBatchCliOptions = {
    selection: resolveSelection({ municipality, all, sources }),
    limit,
    databaseId: resolveNotionDatabaseId(databaseUrl, databaseId),
    write,
  };
  if (since !== undefined) options.since = since;
  return options;
}

function resolveSelection(input: {
  municipality: string | undefined;
  all: boolean;
  sources: string | undefined;
}): CollectionBatchSelection {
  const specified = [
    input.municipality !== undefined,
    input.all,
    input.sources !== undefined,
  ].filter(Boolean).length;

  if (specified === 0) {
    throw new NotionConfigurationError(
      'One of --municipality, --all, or --sources is required.',
    );
  }
  if (specified > 1) {
    throw new NotionConfigurationError(
      '--municipality, --all, and --sources may not be combined.',
    );
  }

  if (input.municipality !== undefined) {
    return { kind: 'municipality', municipality: input.municipality };
  }
  if (input.all) return { kind: 'all' };

  const sourceIds = (input.sources ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (sourceIds.length === 0) {
    throw new NotionConfigurationError('--sources requires at least one source ID.');
  }
  const duplicates = sourceIds.filter((id, index) => sourceIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new NotionConfigurationError(
      `--sources contains duplicate source IDs: ${[...new Set(duplicates)].join(', ')}`,
    );
  }
  return { kind: 'sources', sourceIds };
}

/** 台帳から対象Source IDを決める。開始前に検出できる不正はここで例外にする。 */
export function selectBatchSourceIds(
  registry: SourceRegistry,
  selection: CollectionBatchSelection,
): string[] {
  if (selection.kind === 'all') {
    const sources = getEnabledSources(registry);
    if (sources.length === 0) {
      throw new NotionConfigurationError('No enabled sources are registered.');
    }
    return sources.map((source) => source.id);
  }

  if (selection.kind === 'municipality') {
    const sources = getSourcesByMunicipality(registry, selection.municipality);
    if (sources.length === 0) {
      throw new NotionConfigurationError(
        `No enabled sources found for municipality: ${selection.municipality}\n`
        + `Registered organizations: ${listOrganizationNames(registry).join(', ')}`,
      );
    }
    return sources.map((source) => source.id);
  }

  const known = new Set(registry.sources.map((source) => source.id));
  const unknown = selection.sourceIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new NotionConfigurationError(`Source not found: ${unknown.join(', ')}`);
  }
  return [...selection.sourceIds];
}

export async function runCollectionBatchCommand(
  argv = process.argv.slice(2),
  dependencies: CollectionBatchCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const runStartedAt = (dependencies.now ?? (() => new Date()))();

  let options: CollectionBatchCliOptions;
  let sourceIds: string[];
  let state: CollectionState;
  try {
    options = parseCollectionBatchArgs(argv);
    const registry = await (dependencies.loadRegistry ?? loadSourceRegistry)();
    sourceIds = selectBatchSourceIds(registry, options.selection);
    state = await (dependencies.readState ?? readCollectionState)();
  } catch (error) {
    stderr(error instanceof CollectionStateError
      ? error.message
      : safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  const { report, exitCode } = await runCollectionBatch({
    sourceIds,
    limit: options.limit,
    databaseId: options.databaseId,
    write: options.write,
    ...(options.since === undefined ? {} : { since: options.since }),
    runStartedAt,
    state,
  }, dependencies);

  stdout(`\n${formatCollectionBatchSummary(report)}`);
  return exitCode;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new NotionConfigurationError(`--limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCollectionBatchCommand().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
