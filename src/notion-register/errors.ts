import { NotionCheckError } from '../notion-check/errors.ts';

export class NotionRegistrationError extends Error {
  override name = 'NotionRegistrationError';
}

export function mapNotionRegistrationApiError(
  error: unknown,
  operation: 'query' | 'create',
): NotionCheckError {
  const record = asRecord(error);
  const status = typeof record?.status === 'number' ? record.status : undefined;
  const code = safeCode(record?.code);

  if (status === 401 || code === 'unauthorized') {
    return new NotionCheckError('Notion authentication failed.\nCheck NOTION_TOKEN.');
  }
  if (status === 403 || code === 'restricted_resource') {
    if (operation === 'create') {
      return new NotionCheckError(
        'The Notion connection does not have permission to write to this data source.',
      );
    }
    return new NotionCheckError(
      'The Notion connection does not have permission to query this data source.',
    );
  }
  if (status === 404 || code === 'object_not_found') {
    return new NotionCheckError(
      'The Notion data source was not found or is not shared with the connection.',
    );
  }
  return new NotionCheckError(
    `Notion API request failed. HTTP status: ${status ?? 'unknown'}. Code: ${code ?? 'unknown'}.`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_]+$/iu.test(value) ? value : undefined;
}
