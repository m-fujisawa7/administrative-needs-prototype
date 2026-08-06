import { pathToFileURL } from 'node:url';
import { fetchAndExtractDocument } from '../content-check/index.ts';
import type {
  ContentCheckCliOptions,
  ContentCheckReport,
  ExtractedDocument,
} from '../content-check/types.ts';
import { defaultCheckOutputPath } from '../io/check-output-path.ts';
import { writeJsonFile } from '../io/write-json.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';

const BODY_PREVIEW_LENGTH = 500;

export function parseContentCheckArgs(argv: string[]): ContentCheckCliOptions {
  let sourceId: string | undefined;
  let url: string | undefined;
  let outputPath: string | undefined;
  let outputRequested = false;
  let full = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') {
      sourceId = setOnce(sourceId, requireValue(argv, index, argument), '--source');
      index += 1;
      continue;
    }
    if (argument?.startsWith('--source=')) {
      sourceId = setOnce(
        sourceId,
        requireInlineValue(argument, '--source='),
        '--source',
      );
      continue;
    }
    if (argument === '--url') {
      url = setOnce(url, requireValue(argv, index, argument), '--url');
      index += 1;
      continue;
    }
    if (argument?.startsWith('--url=')) {
      url = setOnce(url, requireInlineValue(argument, '--url='), '--url');
      continue;
    }
    if (argument === '--output') {
      outputRequested = setOutputRequested(outputRequested);
      const value = optionalValue(argv, index);
      if (value !== undefined) {
        outputPath = value;
        index += 1;
      }
      continue;
    }
    if (argument?.startsWith('--output=')) {
      outputRequested = setOutputRequested(outputRequested);
      outputPath = requireInlineValue(argument, '--output=');
      continue;
    }
    if (argument === '--full') {
      if (full) throw new Error('--full は1回だけ指定してください。');
      full = true;
      continue;
    }
    throw new Error(`不明なオプションです: ${argument}`);
  }

  if (sourceId === undefined) throw new Error('--source を指定してください。');
  if (url === undefined) throw new Error('--url を指定してください。');
  validateHttpUrl(url);
  if (outputRequested && outputPath === undefined) {
    outputPath = defaultCheckOutputPath('content-check', sourceId);
  }

  return {
    sourceId,
    url,
    full,
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

export async function runContentCheck(argv = process.argv.slice(2)): Promise<number> {
  const options = parseContentCheckArgs(argv);
  const registry = await loadSourceRegistry();
  const source = registry.sources.find((candidate) => candidate.id === options.sourceId);
  if (source === undefined) {
    throw new Error(`情報源ID「${options.sourceId}」は登録されていません。`);
  }
  const organization = registry.organizations.find(
    (candidate) => candidate.id === source.organization_id,
  );
  if (organization === undefined) {
    throw new Error(`情報源「${source.id}」の組織「${source.organization_id}」が見つかりません。`);
  }

  try {
    const document = await fetchAndExtractDocument({
      source,
      organization,
      url: options.url,
    });
    console.log(formatContentCheckResult(document, options.full));
    if (options.outputPath !== undefined) {
      const report = createContentCheckReport(options, document);
      const savedPath = await writeJsonFile(options.outputPath, report);
      console.log(`結果を保存しました: ${savedPath}`);
    }
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(formatContentCheckError(options, detail));
    if (options.outputPath !== undefined) {
      const report = createContentCheckReport(options, undefined, detail);
      const savedPath = await writeJsonFile(options.outputPath, report);
      console.error(`エラー結果を保存しました: ${savedPath}`);
    }
    return 1;
  }
}

export function formatContentCheckResult(
  document: ExtractedDocument,
  full: boolean,
): string {
  const status = document.warnings.length === 0 ? 'OK' : 'WARNING';
  const body = full
    ? document.bodyText
    : preview(document.bodyText, BODY_PREVIEW_LENGTH);
  const lines = [
    `[${status}] Content check completed.`,
    `Source: ${document.sourceId}`,
    `Source enabled: ${document.sourceEnabled ? 'yes' : 'no'}`,
    `Requested URL: ${document.requestedUrl}`,
    `Final URL: ${document.url}`,
    `HTTP: ${document.httpStatus}`,
    `Content-Type: ${document.contentType}`,
    `Response size: ${document.responseBytes} bytes`,
    `Duration: ${document.durationMs} ms`,
    `Redirects: ${document.redirectCount}`,
    `Title: ${document.title}`,
    `Published at candidate: ${document.publishedAtCandidate ?? 'not found'}`,
    `Published at source: ${document.publishedAtSource ?? 'not found'}`,
    `Body length: ${document.bodyLength} characters`,
    `Content selector configured: ${document.contentSelectorConfigured ?? 'not configured'}`,
    `Content selector used: ${document.contentSelectorUsed}`,
    `Fallback used: ${document.usedFallback ? 'yes' : 'no'}`,
    `PDF links: ${document.pdfUrls.length}`,
  ];

  for (const url of document.pdfUrls) lines.push(`  - ${url}`);
  if (document.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of document.warnings) lines.push(`  - ${warning}`);
  }
  lines.push(full ? 'Body:' : `Body preview (first ${BODY_PREVIEW_LENGTH} characters):`);
  lines.push(body);
  return lines.join('\n');
}

export function createContentCheckReport(
  options: ContentCheckCliOptions,
  document?: ExtractedDocument,
  error?: string,
  generatedAt = new Date(),
): ContentCheckReport {
  if (document === undefined) {
    return {
      schemaVersion: 1,
      generatedAt: generatedAt.toISOString(),
      status: 'error',
      exitCode: 1,
      sourceId: options.sourceId,
      requestedUrl: options.url,
      error: error ?? '不明なエラー',
    };
  }

  const { bodyText, ...metadata } = document;
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    status: document.warnings.length === 0 ? 'ok' : 'warning',
    exitCode: 0,
    sourceId: options.sourceId,
    requestedUrl: options.url,
    result: {
      ...metadata,
      bodyPreview: preview(bodyText, BODY_PREVIEW_LENGTH),
    },
  };
}

function formatContentCheckError(options: ContentCheckCliOptions, detail: string): string {
  return [
    '[ERROR] Content check failed.',
    `Source: ${options.sourceId}`,
    `URL: ${options.url}`,
    `Error: ${detail}`,
  ].join('\n');
}

function preview(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length)}…`;
}

function setOnce(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) throw new Error(`${option} は1回だけ指定してください。`);
  return value;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} の値を指定してください。`);
  }
  return value;
}

function requireInlineValue(argument: string, prefix: string): string {
  const value = argument.slice(prefix.length);
  if (value === '') throw new Error(`${prefix.slice(0, -1)} の値を指定してください。`);
  return value;
}

function optionalValue(argv: string[], index: number): string | undefined {
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function setOutputRequested(current: boolean): true {
  if (current) throw new Error('--output は1回だけ指定してください。');
  return true;
}

function validateHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--url は正しいURLで指定してください。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--url は http または https で指定してください。');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runContentCheck()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
