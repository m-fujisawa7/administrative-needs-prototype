import { NotionConfigurationError } from '../notion-check/errors.ts';

export class NotionBatchConfigurationError extends NotionConfigurationError {
  override name = 'NotionBatchConfigurationError';
}
