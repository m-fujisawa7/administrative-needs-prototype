import { NotionConfigurationError } from './errors.ts';

const COMPACT_ID = /^[0-9a-f]{32}$/iu;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EMBEDDED_COMPACT_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/iu;
const EMBEDDED_UUID_ID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/iu;

export function normalizeNotionDatabaseId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (UUID_ID.test(normalized)) return normalized;
  if (!COMPACT_ID.test(normalized)) {
    throw new NotionConfigurationError('The supplied Notion database ID is invalid.');
  }
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20),
  ].join('-');
}

export function extractNotionDatabaseId(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw extractionError();
  }
  if (url.protocol !== 'https:' || !isNotionHostname(url.hostname)) {
    throw extractionError();
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '').reverse();
  for (const rawSegment of segments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw extractionError();
    }
    const uuid = segment.match(EMBEDDED_UUID_ID)?.[0];
    if (uuid !== undefined) return normalizeNotionDatabaseId(uuid);
    const compact = segment.match(EMBEDDED_COMPACT_ID)?.[0];
    if (compact !== undefined) return normalizeNotionDatabaseId(compact);
  }
  throw extractionError();
}

function isNotionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'notion.com'
    || normalized.endsWith('.notion.com')
    || normalized === 'notion.so'
    || normalized.endsWith('.notion.so')
    || normalized === 'notion.site'
    || normalized.endsWith('.notion.site');
}

function extractionError(): NotionConfigurationError {
  return new NotionConfigurationError(
    'Could not extract a Notion database ID from the supplied URL.',
  );
}
