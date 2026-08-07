import { checkAdministrativeNeed } from '../ai/check.ts';
import { loadCompanyFitCriteria } from '../ai/company-fit-criteria.ts';
import { createAnalyzer } from '../ai/create-analyzer.ts';
import { aiInputLimitsFromEnvironment } from '../ai/input.ts';
import { loadAiCheckPrompt } from '../ai/prompt.ts';
import type {
  AdministrativeNeedAnalyzer,
  CompanyFitCriteria,
} from '../ai/types.ts';
import { checkNotionConnection } from '../notion-check/check.ts';
import { createNotionRegistrationClient } from '../notion-check/client.ts';
import {
  loadRepositoryEnvironment,
  requireNotionToken,
} from '../notion-check/environment.ts';
import { NotionConfigurationError } from '../notion-check/errors.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../notion-check/types.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';
import type {
  Organization,
  Source,
  SourceRegistry,
} from '../source-registry/schema.ts';
import {
  registerOneAdministrativeNeed,
  type RegisterOneInput,
} from './register-one.ts';
import type {
  NotionRegistrationAnalysisContext,
  RegisterOneResult,
} from './types.ts';

export type RegistrationSourceContext = {
  source: Source;
  organization: Organization;
};

export type NotionRegistrationRuntimeDependencies = {
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
  registerOne?: (
    input: RegisterOneInput,
    dependencies: {
      loadAnalysisContext: () => Promise<NotionRegistrationAnalysisContext>;
      checkNeed?: typeof checkAdministrativeNeed;
    },
  ) => Promise<RegisterOneResult>;
};

export type NotionRegistrationRuntime = RegistrationSourceContext & {
  register: (officialUrl: string, write: boolean) => Promise<RegisterOneResult>;
};

export type RuntimePreparationPhase = 'setup' | 'connection';

export class NotionRegistrationRuntimeError extends Error {
  override name = 'NotionRegistrationRuntimeError';
  readonly phase: RuntimePreparationPhase;
  readonly originalError: unknown;

  constructor(phase: RuntimePreparationPhase, originalError: unknown) {
    super(`Notion registration runtime failed during ${phase}.`);
    this.phase = phase;
    this.originalError = originalError;
  }
}

export async function resolveRegistrationSourceContext(
  sourceId: string,
  dependencies: Pick<NotionRegistrationRuntimeDependencies, 'loadRegistry'> = {},
): Promise<RegistrationSourceContext> {
  const registry = await (dependencies.loadRegistry ?? loadSourceRegistry)();
  const source = registry.sources.find((candidate) => candidate.id === sourceId);
  if (source === undefined) {
    throw new NotionConfigurationError(`Source not found: ${sourceId}`);
  }
  const organization = registry.organizations.find(
    (candidate) => candidate.id === source.organization_id,
  );
  if (organization === undefined) {
    throw new NotionConfigurationError(`Organization not found: ${source.organization_id}`);
  }
  return { source, organization };
}

export async function prepareNotionRegistrationRuntime(
  sourceContext: RegistrationSourceContext,
  databaseId: string,
  dependencies: NotionRegistrationRuntimeDependencies = {},
): Promise<NotionRegistrationRuntime> {
  const env = dependencies.env ?? process.env;
  let client: NotionRegistrationClient;
  let limits: ReturnType<typeof aiInputLimitsFromEnvironment>;
  try {
    (dependencies.loadEnvironment ?? loadRepositoryEnvironment)();
    const token = requireNotionToken(env);
    client = (dependencies.createClient ?? createNotionRegistrationClient)(token);
    limits = aiInputLimitsFromEnvironment(env);
  } catch (error) {
    throw new NotionRegistrationRuntimeError('setup', error);
  }

  let report: NotionConnectionReport;
  try {
    report = await (
      dependencies.checkConnection
      ?? ((notionClient, targetDatabaseId) =>
        checkNotionConnection(notionClient, targetDatabaseId))
    )(client, databaseId);
  } catch (error) {
    throw new NotionRegistrationRuntimeError('connection', error);
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

  return {
    ...sourceContext,
    register: (officialUrl, write) => registerOne({
      ...sourceContext,
      officialUrl,
      write,
      client,
      report,
      limits,
    }, {
      loadAnalysisContext,
      checkNeed: dependencies.checkNeed,
    }),
  };
}

export function unwrapNotionRegistrationRuntimeError(error: unknown): unknown {
  return error instanceof NotionRegistrationRuntimeError ? error.originalError : error;
}
