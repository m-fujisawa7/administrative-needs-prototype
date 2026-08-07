import { pathToFileURL } from 'node:url';
import { fetchAndExtractPdf } from '../pdf-check/index.ts';
import type {
  ExtractedPdf,
  PdfCheckCliOptions,
  PdfCheckReport,
} from '../pdf-check/types.ts';
import { defaultCheckOutputPath } from '../io/check-output-path.ts';
import { writeJsonFile } from '../io/write-json.ts';
import { getTrustedAttachmentDomains } from '../source-registry/domains.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';

const TEXT_PREVIEW_LENGTH = 500;

export function parsePdfCheckArgs(argv: string[]): PdfCheckCliOptions {
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
      sourceId = setOnce(sourceId, requireInlineValue(argument, '--source='), '--source');
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
    outputPath = defaultCheckOutputPath('pdf-check', sourceId);
  }
  return {
    sourceId,
    url,
    full,
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

export async function runPdfCheck(argv = process.argv.slice(2)): Promise<number> {
  const options = parsePdfCheckArgs(argv);
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
    const pdf = await fetchAndExtractPdf({
      source,
      organization,
      url: options.url,
      trustedPdfDomains: getTrustedAttachmentDomains(registry, organization),
    });
    console.log(formatPdfCheckResult(pdf, options.full));
    if (options.outputPath !== undefined) {
      const savedPath = await writeJsonFile(
        options.outputPath,
        createPdfCheckReport(options, pdf),
      );
      console.log(`結果を保存しました: ${savedPath}`);
    }
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(formatPdfCheckError(options, detail));
    if (options.outputPath !== undefined) {
      const savedPath = await writeJsonFile(
        options.outputPath,
        createPdfCheckReport(options, undefined, detail),
      );
      console.error(`エラー結果を保存しました: ${savedPath}`);
    }
    return 1;
  }
}

export function formatPdfCheckResult(pdf: ExtractedPdf, full: boolean): string {
  const status = pdf.warnings.length === 0 ? 'OK' : 'WARNING';
  const outputText = full ? pdf.text : preview(pdf.text, TEXT_PREVIEW_LENGTH);
  const lines = [
    `[${status}] PDF check completed.`,
    `Source: ${pdf.sourceId}`,
    `Source enabled: ${pdf.sourceEnabled ? 'yes' : 'no'}`,
    `Requested URL: ${pdf.requestedUrl}`,
    `Final URL: ${pdf.url}`,
    `HTTP: ${pdf.httpStatus}`,
    `Content-Type: ${pdf.contentType}`,
    `Response size: ${pdf.responseBytes} bytes`,
    `Duration: ${pdf.durationMs} ms`,
    `Redirects: ${pdf.redirectCount}`,
    `Parser: ${pdf.parser}`,
    `Pages: ${pdf.pageCount}`,
    `Pages with text: ${pdf.pagesWithText}`,
    `Empty pages: ${pdf.emptyPageCount}`,
    `Text length: ${pdf.characterCount} characters`,
  ];
  if (pdf.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of pdf.warnings) lines.push(`  - [${warning.code}] ${warning.message}`);
  }
  lines.push(full ? 'Text:' : `Text preview (first ${TEXT_PREVIEW_LENGTH} characters):`);
  lines.push(outputText);
  return lines.join('\n');
}

export function createPdfCheckReport(
  options: PdfCheckCliOptions,
  pdf?: ExtractedPdf,
  error?: string,
  generatedAt = new Date(),
): PdfCheckReport {
  if (pdf === undefined) {
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

  const { text, pageTexts, ...metadata } = pdf;
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    status: pdf.warnings.length === 0 ? 'ok' : 'warning',
    exitCode: 0,
    sourceId: options.sourceId,
    requestedUrl: options.url,
    result: {
      ...metadata,
      textPreview: preview(text, TEXT_PREVIEW_LENGTH),
      pageCharacterCounts: pageTexts.map((pageText) => pageText.length),
    },
  };
}

function formatPdfCheckError(options: PdfCheckCliOptions, detail: string): string {
  return [
    '[ERROR] PDF check failed.',
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
  runPdfCheck()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
