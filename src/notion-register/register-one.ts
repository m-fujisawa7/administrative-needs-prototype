import { checkAdministrativeNeed } from '../ai/check.ts';
import { AiAnalyzerError, ClaudeUsageLimitError } from '../ai/errors.ts';
import type { AiInputLimits } from '../ai/input.ts';
import { ContentExtractionError } from '../content-check/errors.ts';
import { NotionCheckError } from '../notion-check/errors.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../notion-check/types.ts';
import { SourceCheckFetchError } from '../source-check/fetch.ts';
import type { Organization, Source } from '../source-registry/schema.ts';
import {
  isNotionRegistrationConfigurationError,
  safeNotionRegistrationErrorMessage,
} from './error-format.ts';
import {
  createNotionRegistrationPage,
  findExistingNotionPage,
  prepareNotionRegistration,
} from './registration.ts';
import { selectRegistrationDataSource } from './schema.ts';
import type {
  NotionRegistrationAnalysisContext,
  RegisterOneFailureStage,
  RegisterOneResult,
} from './types.ts';

export type RegisterOneInput = {
  source: Source;
  organization: Organization;
  officialUrl: string;
  write: boolean;
  client: NotionRegistrationClient;
  report: NotionConnectionReport;
  limits: AiInputLimits;
  /** 添付PDFの取得時にだけ追加で許可するドメイン（親組織の公式ドメインなど）。 */
  trustedPdfDomains?: readonly string[];
};

export type RegisterOneDependencies = {
  loadAnalysisContext: () => Promise<NotionRegistrationAnalysisContext>;
  checkNeed?: typeof checkAdministrativeNeed;
};

export async function registerOneAdministrativeNeed(
  input: RegisterOneInput,
  dependencies: RegisterOneDependencies,
): Promise<RegisterOneResult> {
  let dataSourceId: string;
  try {
    dataSourceId = selectRegistrationDataSource(input.report).id;
  } catch (error) {
    return failure(input.officialUrl, 'notion_schema', error);
  }

  try {
    const duplicate = await findExistingNotionPage(
      input.client,
      dataSourceId,
      input.officialUrl,
    );
    if (duplicate !== null) {
      return {
        status: 'duplicate',
        officialUrl: input.officialUrl,
        existingPageId: duplicate.id,
        existingPageUrl: duplicate.url,
        phase: 'preflight',
        warnings: [],
      };
    }
  } catch (error) {
    return failure(input.officialUrl, 'duplicate_check', error);
  }

  let context: NotionRegistrationAnalysisContext;
  try {
    context = await dependencies.loadAnalysisContext();
    if (input.write && context.analyzer.provider !== 'claude_cli') {
      return {
        status: 'failed',
        officialUrl: input.officialUrl,
        stage: 'ai_analysis',
        message: 'Write mode requires AI_PROVIDER=claude_cli. Mock analysis cannot be registered.',
        configurationError: true,
        warnings: [],
      };
    }
  } catch (error) {
    // 利用上限は1件の失敗ではなくClaude全体の状態なので、呼び出し側が停止できるよう再throwする。
    if (error instanceof ClaudeUsageLimitError) throw error;
    return failure(input.officialUrl, 'ai_analysis', error);
  }

  let analysisResult;
  try {
    analysisResult = await (dependencies.checkNeed ?? checkAdministrativeNeed)({
      source: input.source,
      organization: input.organization,
      url: input.officialUrl,
      noPdf: false,
      analyzer: context.analyzer,
      companyFitCriteria: context.companyFitCriteria,
      limits: input.limits,
      trustedPdfDomains: input.trustedPdfDomains ?? [],
    });
  } catch (error) {
    if (error instanceof ClaudeUsageLimitError) throw error;
    return failure(input.officialUrl, analysisFailureStage(error), error);
  }

  let preview;
  try {
    preview = await prepareNotionRegistration(
      input.client,
      input.report,
      analysisResult,
      input.write,
    );
  } catch (error) {
    return failure(
      input.officialUrl,
      preparationFailureStage(error),
      error,
      analysisResult.warnings,
    );
  }

  if (preview.duplicate !== null) {
    return {
      status: 'duplicate',
      officialUrl: preview.values.officialUrl,
      existingPageId: preview.duplicate.id,
      existingPageUrl: preview.duplicate.url,
      phase: 'before_create',
      preview,
      warnings: analysisResult.warnings,
    };
  }
  if (!input.write) {
    return {
      status: 'previewed',
      officialUrl: preview.values.officialUrl,
      title: preview.values.title,
      preview,
      warnings: analysisResult.warnings,
    };
  }
  if (preview.missingOptions.length > 0) {
    return {
      status: 'failed',
      officialUrl: preview.values.officialUrl,
      stage: 'notion_select_options',
      message: 'Notion registration was blocked because creating missing select options would change the data source schema.',
      configurationError: false,
      preview,
      warnings: analysisResult.warnings,
    };
  }

  try {
    const page = await createNotionRegistrationPage(input.client, preview);
    return {
      status: 'created',
      officialUrl: preview.values.officialUrl,
      title: preview.values.title,
      notionPageId: page.id,
      notionPageUrl: page.url,
      preview,
      warnings: analysisResult.warnings,
    };
  } catch (error) {
    return failure(
      preview.values.officialUrl,
      'notion_create',
      error,
      analysisResult.warnings,
    );
  }
}

function failure(
  officialUrl: string,
  stage: RegisterOneFailureStage,
  error: unknown,
  warnings: RegisterOneResult['warnings'] = [],
): RegisterOneResult {
  return {
    status: 'failed',
    officialUrl,
    stage,
    message: safeNotionRegistrationErrorMessage(error),
    configurationError: isNotionRegistrationConfigurationError(error),
    warnings,
  };
}

function analysisFailureStage(error: unknown): RegisterOneFailureStage {
  if (error instanceof SourceCheckFetchError) return 'html_fetch';
  // 本文抽出の失敗はClaudeへ渡す前に起きるため、ai_analysisと混ぜない。
  if (error instanceof ContentExtractionError) return 'content_extract';
  if (error instanceof AiAnalyzerError && error.message.includes('Zod schema')) {
    return 'ai_validation';
  }
  return 'ai_analysis';
}

function preparationFailureStage(error: unknown): RegisterOneFailureStage {
  if (error instanceof NotionCheckError) return 'duplicate_check';
  const message = error instanceof Error ? error.message : '';
  return message.includes('Unsupported category') ? 'ai_validation' : 'notion_schema';
}
