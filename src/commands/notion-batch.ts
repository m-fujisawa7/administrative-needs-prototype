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
import { processSelectedUrls } from '../notion-batch/batch.ts';
import { NotionBatchConfigurationError } from '../notion-batch/errors.ts';
import {
  formatNotionBatchItem,
  formatNotionBatchSummary,
} from '../notion-batch/format.ts';
import { readSelectedUrlFile } from '../notion-batch/input.ts';
import type {
  NotionBatchCliOptions,
  ParsedSelectedUrls,
} from '../notion-batch/types.ts';
import { checkNotionConnection } from '../notion-check/check.ts';
import { createNotionRegistrationClient } from '../notion-check/client.ts';
import {
  loadRepositoryEnvironment,
  requireNotionToken,
} from '../notion-check/environment.ts';
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
import { loadSourceRegistry } from '../source-registry/load.ts';
import type { SourceRegistry } from '../source-registry/schema.ts';

export type NotionBatchCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  readSelectedUrls?: (path: string) => Promise<ParsedSelectedUrls>;
  loadEnvironment?: () => void;
  loadRegistry?: () => Promise<SourceRegistry>;
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

export function parseNotionBatchArgs(argv: string[]): NotionBatchCliOptions {
  let sourceId: string | undefined;
  let file: string | undefined;
  let databaseUrl: string | undefined;
  let databaseId: string | undefined;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') {
      if (write) throw new NotionBatchConfigurationError('--write may only be specified once.');
      write = true;
      continue;
    }
    const parsed = parseValueOption(argv, index, argument);
    if (parsed === null) throw new NotionBatchConfigurationError(`Unknown option: ${argument}`);
    index += parsed.consumedNext ? 1 : 0;
    if (parsed.name === '--source') sourceId = setOnce(sourceId, parsed.value, parsed.name);
    if (parsed.name === '--file') file = setOnce(file, parsed.value, parsed.name);
    if (parsed.name === '--database-url') {
      databaseUrl = setOnce(databaseUrl, parsed.value, parsed.name);
    }
    if (parsed.name === '--database-id') {
      databaseId = setOnce(databaseId, parsed.value, parsed.name);
    }
  }

  if (sourceId === undefined) throw new NotionBatchConfigurationError('--source is required.');
  if (file === undefined) throw new NotionBatchConfigurationError('--file is required.');
  if (databaseUrl !== undefined && databaseId !== undefined) {
    throw new NotionBatchConfigurationError(
      'Specify either --database-url or --database-id, not both.',
    );
  }
  if (databaseUrl === undefined && databaseId === undefined) {
    throw new NotionBatchConfigurationError('Specify either --database-url or --database-id.');
  }
  return {
    sourceId,
    file,
    databaseId: databaseUrl === undefined
      ? normalizeNotionDatabaseId(databaseId!)
      : extractNotionDatabaseId(databaseUrl),
    write,
  };
}

export async function runNotionBatch(
  argv = process.argv.slice(2),
  dependencies: NotionBatchCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const env = dependencies.env ?? process.env;

  let options: NotionBatchCliOptions;
  let selectedUrls: ParsedSelectedUrls;
  try {
    options = parseNotionBatchArgs(argv);
    selectedUrls = await (
      dependencies.readSelectedUrls ?? readSelectedUrlFile
    )(options.file);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  let registry: SourceRegistry;
  let client: NotionRegistrationClient;
  try {
    (dependencies.loadEnvironment ?? loadRepositoryEnvironment)();
    const token = requireNotionToken(env);
    registry = await (dependencies.loadRegistry ?? loadSourceRegistry)();
    client = (dependencies.createClient ?? createNotionRegistrationClient)(token);
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

  let report: NotionConnectionReport;
  let limits: ReturnType<typeof aiInputLimitsFromEnvironment>;
  try {
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
  const batchReport = await processSelectedUrls(
    selectedUrls,
    options.write,
    (officialUrl) => registerOne({
      source,
      organization,
      officialUrl,
      write: options.write,
      client,
      report,
      limits,
    }, {
      loadAnalysisContext,
      checkNeed: dependencies.checkNeed,
    }),
    (result, index, total) => {
      for (const warning of result.warnings) {
        stderr(`[${index}/${total}] [WARNING] [${warning.code}] ${warning.message}`);
      }
      stdout(formatNotionBatchItem(result, index, total));
    },
  );
  stdout(formatNotionBatchSummary(batchReport));
  return batchReport.results.some((result) => result.status === 'failed') ? 1 : 0;
}

function parseValueOption(
  argv: string[],
  index: number,
  argument: string | undefined,
): { name: string; value: string; consumedNext: boolean } | null {
  const names = ['--source', '--file', '--database-url', '--database-id'];
  for (const name of names) {
    if (argument === name) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new NotionBatchConfigurationError(`${name} requires a value.`);
      }
      return { name, value, consumedNext: true };
    }
    const prefix = `${name}=`;
    if (argument?.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      if (value === '') throw new NotionBatchConfigurationError(`${name} requires a value.`);
      return { name, value, consumedNext: false };
    }
  }
  return null;
}

function setOnce(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) {
    throw new NotionBatchConfigurationError(`${option} may only be specified once.`);
  }
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNotionBatch().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
