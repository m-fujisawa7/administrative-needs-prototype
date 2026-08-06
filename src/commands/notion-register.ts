import { pathToFileURL } from 'node:url';
import { checkAdministrativeNeed } from '../ai/check.ts';
import { loadCompanyFitCriteria } from '../ai/company-fit-criteria.ts';
import { createAnalyzer } from '../ai/create-analyzer.ts';
import { AiAnalyzerError, AiConfigurationError } from '../ai/errors.ts';
import { aiInputLimitsFromEnvironment } from '../ai/input.ts';
import { loadAiCheckPrompt } from '../ai/prompt.ts';
import type {
  AdministrativeNeedAnalyzer,
  CompanyFitCriteria,
} from '../ai/types.ts';
import { SourceCheckFetchError } from '../source-check/fetch.ts';
import { checkNotionConnection } from '../notion-check/check.ts';
import { createNotionRegistrationClient } from '../notion-check/client.ts';
import {
  loadRepositoryEnvironment,
  requireNotionToken,
} from '../notion-check/environment.ts';
import {
  NotionCheckError,
  NotionConfigurationError,
} from '../notion-check/errors.ts';
import {
  extractNotionDatabaseId,
  normalizeNotionDatabaseId,
} from '../notion-check/id.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../notion-check/types.ts';
import { NotionRegistrationError } from '../notion-register/errors.ts';
import {
  formatNotionRegistrationCompleted,
  formatNotionRegistrationPreview,
} from '../notion-register/format.ts';
import {
  createNotionRegistrationPage,
  prepareNotionRegistration,
} from '../notion-register/registration.ts';
import type { NotionRegisterCliOptions } from '../notion-register/types.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';
import type { SourceRegistry } from '../source-registry/schema.ts';

export type NotionRegisterCommandDependencies = {
  env?: NodeJS.ProcessEnv;
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
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseNotionRegisterArgs(argv: string[]): NotionRegisterCliOptions {
  let sourceId: string | undefined;
  let url: string | undefined;
  let databaseUrl: string | undefined;
  let databaseId: string | undefined;
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
    if (parsed.name === '--url') url = setOnce(url, parsed.value, parsed.name);
    if (parsed.name === '--database-url') {
      databaseUrl = setOnce(databaseUrl, parsed.value, parsed.name);
    }
    if (parsed.name === '--database-id') {
      databaseId = setOnce(databaseId, parsed.value, parsed.name);
    }
  }

  if (sourceId === undefined) throw new NotionConfigurationError('--source is required.');
  if (url === undefined) throw new NotionConfigurationError('--url is required.');
  validateHttpUrl(url);
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
    url,
    databaseId: databaseUrl === undefined
      ? normalizeNotionDatabaseId(databaseId!)
      : extractNotionDatabaseId(databaseUrl),
    write,
  };
}

export async function runNotionRegister(
  argv = process.argv.slice(2),
  dependencies: NotionRegisterCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const env = dependencies.env ?? process.env;

  let options: NotionRegisterCliOptions;
  let registry: SourceRegistry;
  let analyzer: AdministrativeNeedAnalyzer;
  let companyFitCriteria: CompanyFitCriteria;
  let client: NotionRegistrationClient;
  try {
    options = parseNotionRegisterArgs(argv);
    (dependencies.loadEnvironment ?? loadRepositoryEnvironment)();
    const token = requireNotionToken(env);
    registry = await (dependencies.loadRegistry ?? loadSourceRegistry)();
    companyFitCriteria = await (
      dependencies.loadFitCriteria ?? loadCompanyFitCriteria
    )();
    const systemPrompt = await (dependencies.loadPrompt ?? loadAiCheckPrompt)();
    analyzer = dependencies.analyzerFactory?.(systemPrompt)
      ?? createAnalyzer({ systemPrompt, env });
    if (options.write && analyzer.provider !== 'claude_cli') {
      throw new NotionConfigurationError(
        'Write mode requires AI_PROVIDER=claude_cli. Mock analysis cannot be registered.',
      );
    }
    client = (dependencies.createClient ?? createNotionRegistrationClient)(token);
  } catch (error) {
    stderr(formatRegistrationError(error));
    return 2;
  }

  const source = registry.sources.find((candidate) => candidate.id === options.sourceId);
  if (source === undefined) {
    stderr(`Source not found: ${options.sourceId}`);
    return 2;
  }
  const organization = registry.organizations.find(
    (candidate) => candidate.id === source.organization_id,
  );
  if (organization === undefined) {
    stderr(`Organization not found: ${source.organization_id}`);
    return 2;
  }

  try {
    const analysisResult = await (dependencies.checkNeed ?? checkAdministrativeNeed)({
      source,
      organization,
      url: options.url,
      noPdf: false,
      analyzer,
      companyFitCriteria,
      limits: aiInputLimitsFromEnvironment(env),
    });
    for (const warning of analysisResult.warnings) {
      stderr(`[WARNING] [${warning.code}] ${warning.message}`);
    }

    const report = await (
      dependencies.checkConnection
      ?? ((notionClient, databaseId) => checkNotionConnection(notionClient, databaseId))
    )(client, options.databaseId);
    const preview = await prepareNotionRegistration(
      client,
      report,
      analysisResult,
      options.write,
    );
    stdout(formatNotionRegistrationPreview(preview));

    if (preview.duplicate !== null) return 0;
    if (!options.write) return 0;
    if (preview.missingOptions.length > 0) {
      stderr(
        'Notion registration was blocked because creating missing select options would change the data source schema.',
      );
      return 1;
    }

    const page = await createNotionRegistrationPage(client, preview);
    stdout(formatNotionRegistrationCompleted(preview, page));
    return 0;
  } catch (error) {
    stderr(formatRegistrationError(error));
    return error instanceof AiConfigurationError
      || error instanceof NotionConfigurationError
      ? 2
      : 1;
  }
}

function formatRegistrationError(error: unknown): string {
  if (
    error instanceof NotionConfigurationError
    || error instanceof NotionCheckError
    || error instanceof NotionRegistrationError
    || error instanceof AiConfigurationError
    || error instanceof AiAnalyzerError
  ) {
    return error.message;
  }
  if (error instanceof SourceCheckFetchError) {
    return `Failed to fetch or extract HTML content. ${error.message}`;
  }
  return 'Notion registration failed before a safe error response was available.';
}

function parseValueOption(
  argv: string[],
  index: number,
  argument: string | undefined,
): { name: string; value: string; consumedNext: boolean } | null {
  const names = ['--source', '--url', '--database-url', '--database-id'];
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

function validateHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotionConfigurationError('--url must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NotionConfigurationError('--url must be a valid HTTP or HTTPS URL.');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNotionRegister().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
