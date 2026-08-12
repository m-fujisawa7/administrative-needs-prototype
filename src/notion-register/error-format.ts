import { AiAnalyzerError, AiConfigurationError } from '../ai/errors.ts';
import { ContentExtractionError } from '../content-check/errors.ts';
import { NotionCheckError, NotionConfigurationError } from '../notion-check/errors.ts';
import { SourceCheckFetchError } from '../source-check/fetch.ts';
import { NotionRegistrationError } from './errors.ts';

export function safeNotionRegistrationErrorMessage(error: unknown): string {
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
  if (error instanceof ContentExtractionError) {
    return `Failed to extract HTML content. ${error.message}`;
  }
  return 'Notion registration failed before a safe error response was available.';
}

export function isNotionRegistrationConfigurationError(error: unknown): boolean {
  return error instanceof AiConfigurationError
    || error instanceof NotionConfigurationError;
}
