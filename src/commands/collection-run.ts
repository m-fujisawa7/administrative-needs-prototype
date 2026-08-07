import { pathToFileURL } from 'node:url';
import { checkAdministrativeNeed } from '../ai/check.ts';
import { loadCompanyFitCriteria } from '../ai/company-fit-criteria.ts';
import { createAnalyzer } from '../ai/create-analyzer.ts';
import { aiInputLimitsFromEnvironment } from '../ai/input.ts';
import { loadAiCheckPrompt } from '../ai/prompt.ts';
import type {
  AdministrativeNeedAnalyzer,
  CompanyFitCriteria,
} from '../ai/types.ts';
import {
  formatCollectionRunItem,
  formatCollectionRunSummary,
} from '../collection-run/format.ts';
import { processCollectedCandidates } from '../collection-run/run.ts';
import type {
  CollectionRunCliOptions,
  CollectionRunReport,
} from '../collection-run/types.ts';
import { checkNotionConnection } from '../notion-check/check.ts';
import { createNotionRegistrationClient } from '../notion-check/client.ts';
import {
  loadRepositoryEnvironment,
  requireNotionToken,
} from '../notion-check/environment.ts';
import { NotionConfigurationError } from '../notion-check/errors.ts';
import {
  extractNotionDatabaseId,
  normalizeNotionDatabaseId,
} from '../notion-check/id.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../notion-check/types.ts';
import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import {
  registerOneAdministrativeNeed,
  type RegisterOneInput,
} from '../notion-register/register-one.ts';
import type {
  NotionRegistrationAnalysisContext,
  RegisterOneResult,
} from '../notion-register/types.ts';
import { collectSourceCandidates } from '../source-check/index.ts';
import type { SourceCheckSample } from '../source-check/types.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';
import type {
  Organization,
  Source,
  SourceRegistry,
} from '../source-registry/schema.ts';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export type CollectionRunCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  loadEnvironment?: () => void;
  loadRegistry?: () => Promise<SourceRegistry>;
  collectCandidates?: (
    source: Source,
    organization: Organization,
    limit: number,
  ) => Promise<SourceCheckSample[]>;
  loadFitCriteria?: () => Promise<CompanyFitCriteria>;
  loadPrompt?: () => Promise<string>;
  analyzerFactory?: (systemPrompt: string) => AdministrativeNeedAnalyzer;
  checkNeed?: typeof checkAdministrativeNeed;
  createClient?: (token: string) => NotionRegistrationClient;
  checkConnection?: (
    client: NotionRegistrationClient,
    databaseId: string,
  ) => Promise<NotionConnectionReport>;
  registerOne?: (
    input: RegisterOneInput,
    dependencies: {
      loadAnalysisContext: () => Promise<NotionRegistrationAnalysisContext>;
      checkNeed?: typeof checkAdministrativeNeed;
    },
  ) => Promise<RegisterOneResult>;
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
    const parsed = parseValueOption(argv, index, argument);
    if (parsed === null) throw new NotionConfigurationError(`Unknown option: ${argument}`);
    index += parsed.consumedNext ? 1 : 0;
    if (parsed.name === '--source') sourceId = setOnce(sourceId, parsed.value, parsed.name);
    if (parsed.name === '--database-url') {
      databaseUrl = setOnce(databaseUrl, parsed.value, parsed.name);
    }
    if (parsed.name === '--database-id') {
      databaseId = setOnce(databaseId, parsed.value, parsed.name);
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
  if (databaseUrl !== undefined && databaseId !== undefined) {
    throw new NotionConfigurationError(
      'Specify either --database-url or --database-id, not both.',
    );
  }
  if (databaseUrl === undefined && databaseId === undefined) {
    throw new NotionConfigurationError('Specify either --database-url or --database-id.');
  }
  return {
    sourceId,
    limit,
    databaseId: databaseUrl === undefined
      ? normalizeNotionDatabaseId(databaseId!)
      : extractNotionDatabaseId(databaseUrl),
    write,
  };
}

export async function runCollection(
  argv = process.argv.slice(2),
  dependencies: CollectionRunCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const env = dependencies.env ?? process.env;

  let options: CollectionRunCliOptions;
  let registry: SourceRegistry;
  try {
    options = parseCollectionRunArgs(argv);
    registry = await (dependencies.loadRegistry ?? loadSourceRegistry)();
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  const source = registry.sources.find((candidate) => candidate.id === options.sourceId);
  if (source === undefined) {
    stderr(`Source not found: ${options.sourceId}`);
    return 1;
  }
  const organization = registry.organizations.find(
    (candidate) => candidate.id === source.organization_id,
  );
  if (organization === undefined) {
    stderr(`Organization not found: ${source.organization_id}`);
    return 1;
  }

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

  let client: NotionRegistrationClient;
  let report: NotionConnectionReport;
  let limits: ReturnType<typeof aiInputLimitsFromEnvironment>;
  try {
    (dependencies.loadEnvironment ?? loadRepositoryEnvironment)();
    const token = requireNotionToken(env);
    client = (dependencies.createClient ?? createNotionRegistrationClient)(token);
    limits = aiInputLimitsFromEnvironment(env);
    report = await (
      dependencies.checkConnection
      ?? ((notionClient, databaseId) => checkNotionConnection(notionClient, databaseId))
    )(client, options.databaseId);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  let analysisContext: Promise<NotionRegistrationAnalysisContext> | undefined;
  const loadAnalysisContext = (): Promise<NotionRegistrationAnalysisContext> => {
    analysisContext ??= (async () => {
      const companyFitCriteria = await (
        dependencies.loadFitCriteria ?? loadCompanyFitCriteria
      )();
      const systemPrompt = await (dependencies.loadPrompt ?? loadAiCheckPrompt)();
      const analyzer = dependencies.analyzerFactory?.(systemPrompt)
        ?? createAnalyzer({ systemPrompt, env });
      return { analyzer, companyFitCriteria };
    })();
    return analysisContext;
  };

  const registerOne = dependencies.registerOne ?? registerOneAdministrativeNeed;
  const collectionReport = await processCollectedCandidates(
    options.sourceId,
    candidates,
    options.limit,
    options.write,
    (candidate) => registerOne({
      source,
      organization,
      officialUrl: candidate.url,
      write: options.write,
      client,
      report,
      limits,
    }, {
      loadAnalysisContext,
      checkNeed: dependencies.checkNeed,
    }),
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

function parseValueOption(
  argv: string[],
  index: number,
  argument: string | undefined,
): { name: string; value: string; consumedNext: boolean } | null {
  const names = ['--source', '--limit', '--database-url', '--database-id'];
  for (const name of names) {
    if (argument === name) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new NotionConfigurationError(`${name} requires a value.`);
      }
      return { name, value, consumedNext: true };
    }
    const prefix = `${name}=`;
    if (argument?.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      if (value === '') throw new NotionConfigurationError(`${name} requires a value.`);
      return { name, value, consumedNext: false };
    }
  }
  return null;
}

function setOnce(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) {
    throw new NotionConfigurationError(`${option} may only be specified once.`);
  }
  return value;
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
