export class NotionConfigurationError extends Error {
  override name = 'NotionConfigurationError';
}

export class NotionCheckError extends Error {
  override name = 'NotionCheckError';
}

export function mapNotionApiError(
  error: unknown,
  resource: 'database' | 'data_source' = 'database',
): NotionCheckError {
  const record = asRecord(error);
  const status = typeof record?.status === 'number' ? record.status : undefined;
  const code = safeCode(record?.code);

  if (status === 401 || code === 'unauthorized') {
    return new NotionCheckError('Notion authentication failed.\nCheck NOTION_TOKEN.');
  }
  if (status === 403 || code === 'restricted_resource') {
    return new NotionCheckError(
      'The Notion connection does not have permission to read this database.\n'
      + 'Check that the database is shared with the connection.',
    );
  }
  if (status === 404 || code === 'object_not_found') {
    if (resource === 'data_source') {
      return new NotionCheckError(
        'A Notion data source was not found.\n'
        + 'Check that the database and related data sources are shared with the connection.',
      );
    }
    return new NotionCheckError(
      'The Notion database was not found.\nCheck the database URL and connection access.',
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
