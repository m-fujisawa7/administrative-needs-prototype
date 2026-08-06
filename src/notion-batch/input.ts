import { readFile } from 'node:fs/promises';
import { NotionBatchConfigurationError } from './errors.ts';
import type { ParsedSelectedUrls, SelectedUrlEntry } from './types.ts';

export const MAX_SELECTED_URLS = 20;

export type SelectedUrlFileReader = (path: string) => Promise<Uint8Array>;

export async function readSelectedUrlFile(
  path: string,
  reader: SelectedUrlFileReader = readFile,
): Promise<ParsedSelectedUrls> {
  let bytes: Uint8Array;
  try {
    bytes = await reader(path);
  } catch {
    throw new NotionBatchConfigurationError(
      `Could not read the selected URL file: ${path}`,
    );
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new NotionBatchConfigurationError(
      `The selected URL file must be valid UTF-8: ${path}`,
    );
  }
  return parseSelectedUrls(content);
}

export function parseSelectedUrls(content: string): ParsedSelectedUrls {
  const candidates = content
    .split(/\r?\n/gu)
    .map((line, index) => ({ value: line.trim(), lineNumber: index + 1 }))
    .filter(({ value }) => value !== '' && !value.startsWith('#'));

  if (candidates.length === 0) {
    throw new NotionBatchConfigurationError(
      'The selected URL file did not contain any URLs.',
    );
  }
  if (candidates.length > MAX_SELECTED_URLS) {
    throw new NotionBatchConfigurationError(
      `The selected URL file may contain at most ${MAX_SELECTED_URLS} URL lines.`,
    );
  }

  const seen = new Set<string>();
  const entries: SelectedUrlEntry[] = [];
  for (const candidate of candidates) {
    validateHttpUrl(candidate.value, candidate.lineNumber);
    const inputDuplicate = seen.has(candidate.value);
    entries.push({
      officialUrl: candidate.value,
      inputDuplicate,
    });
    seen.add(candidate.value);
  }
  return { entries, uniqueUrlCount: seen.size };
}

function validateHttpUrl(value: string, lineNumber: number): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidUrlError(lineNumber);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidUrlError(lineNumber);
  }
}

function invalidUrlError(lineNumber: number): NotionBatchConfigurationError {
  return new NotionBatchConfigurationError(
    `Selected URL line ${lineNumber} must be a valid HTTP or HTTPS URL.`,
  );
}
