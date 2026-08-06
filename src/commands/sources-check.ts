import { pathToFileURL } from 'node:url';
import { defaultCheckOutputPath } from '../io/check-output-path.ts';
import { writeJsonFile } from '../io/write-json.ts';
import { loadSourceRegistry } from '../source-registry/load.ts';
import { checkSourceRegistry } from '../source-check/index.ts';
import type {
  SourceCheckReport,
  SourceCheckResult,
  SourceCheckRunOptions,
  SourceCheckSelection,
} from '../source-check/types.ts';

const DEFAULT_SAMPLE_LIMIT = 3;
const MAX_SAMPLE_LIMIT = 20;

export function parseSourceCheckArgs(argv: string[]): SourceCheckRunOptions {
  const selections: SourceCheckSelection[] = [];
  let limit = DEFAULT_SAMPLE_LIMIT;
  let outputPath: string | undefined;
  let outputRequested = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') {
      selections.push({ mode: 'source', sourceId: requireValue(argv, index, argument) });
      index += 1;
      continue;
    }
    if (argument?.startsWith('--source=')) {
      selections.push({ mode: 'source', sourceId: requireInlineValue(argument, '--source=') });
      continue;
    }
    if (argument === '--enabled') {
      selections.push({ mode: 'enabled' });
      continue;
    }
    if (argument === '--all') {
      selections.push({ mode: 'all' });
      continue;
    }
    if (argument === '--limit') {
      limit = parseLimit(requireValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument?.startsWith('--limit=')) {
      limit = parseLimit(requireInlineValue(argument, '--limit='));
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
    throw new Error(`不明なオプションです: ${argument}`);
  }

  if (selections.length !== 1) {
    throw new Error('--source、--enabled、--all のいずれか1つだけを指定してください。');
  }
  if (outputRequested && outputPath === undefined) {
    outputPath = defaultCheckOutputPath('source-check', selectionOutputKey(selections[0]!));
  }
  return {
    selection: selections[0]!,
    limit,
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

export async function runSourcesCheck(argv = process.argv.slice(2)): Promise<number> {
  const options = parseSourceCheckArgs(argv);
  const registry = await loadSourceRegistry();
  const results = await checkSourceRegistry(registry, options);

  for (const [index, result] of results.entries()) {
    if (index > 0) console.log('');
    console.log(formatSourceCheckResult(result));
  }
  console.log('');
  console.log(formatSourceCheckSummary(results));
  const exitCode = sourceCheckExitCode(results, options.selection);
  if (options.outputPath !== undefined) {
    const report = createSourceCheckReport(results, options);
    const savedPath = await writeSourceCheckReport(options.outputPath, report);
    console.log(`結果を保存しました: ${savedPath}`);
  }
  return exitCode;
}

export function createSourceCheckReport(
  results: SourceCheckResult[],
  options: SourceCheckRunOptions,
  generatedAt = new Date(),
): SourceCheckReport {
  const counts = countStatuses(results);
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    selection: options.selection,
    sampleLimit: options.limit,
    summary: {
      total: results.length,
      ...counts,
      exitCode: sourceCheckExitCode(results, options.selection),
    },
    results,
  };
}

export async function writeSourceCheckReport(
  outputPath: string,
  report: SourceCheckReport,
): Promise<string> {
  return writeJsonFile(outputPath, report);
}

export function formatSourceCheckResult(result: SourceCheckResult): string {
  const status = result.status.toLocaleUpperCase('en');
  const lines = [
    `[${status}] ${result.sourceId}`,
    `情報源名: ${result.sourceName}`,
    `組織: ${result.organizationName}`,
    `形式: ${result.collectorType}`,
    `有効: ${result.sourceEnabled ? 'はい' : 'いいえ'}`,
    `URL: ${result.sourceUrl}`,
  ];

  if (result.finalUrl !== undefined && result.finalUrl !== result.sourceUrl) {
    lines.push(`最終URL: ${result.finalUrl}`);
  }
  if (result.httpStatus !== undefined) lines.push(`HTTP: ${result.httpStatus}`);
  if (result.contentType !== undefined) lines.push(`Content-Type: ${result.contentType ?? 'なし'}`);
  if (result.responseBytes !== undefined) lines.push(`応答サイズ: ${result.responseBytes} bytes`);
  if (result.durationMs !== undefined) lines.push(`所要時間: ${result.durationMs} ms`);
  if (result.redirectCount !== undefined) lines.push(`リダイレクト: ${result.redirectCount} 回`);
  if (
    result.rawItemCount !== undefined
    && result.structurallyValidItemCount !== undefined
    && result.usableItemCount !== undefined
  ) {
    lines.push(
      `件数: 生 ${result.rawItemCount} / 構造上有効 ${result.structurallyValidItemCount} / 利用可能 ${result.usableItemCount}`,
    );
  }
  if (result.latestPublishedAt !== undefined) {
    lines.push(`最新公開日候補: ${result.latestPublishedAt ?? '取得できず'}`);
  }
  if (result.linkSelectorStatus !== undefined) {
    lines.push(`link_selector: ${formatSelectorStatus(result.linkSelectorStatus)}`);
  }
  if (result.contentSelectorStatus !== undefined) {
    lines.push(`content_selector: ${formatSelectorStatus(result.contentSelectorStatus)}`);
  }

  if (result.exclusions.length > 0) {
    lines.push('除外内訳:');
    for (const exclusion of result.exclusions) {
      lines.push(`  - ${exclusion.reason}: ${exclusion.count} 件`);
    }
  }
  if (result.samples.length > 0) {
    lines.push('サンプル:');
    for (const [index, sample] of result.samples.entries()) {
      lines.push(`  ${index + 1}. ${sample.title}`);
      if (sample.publishedAt !== null) lines.push(`     ${sample.publishedAt}`);
      lines.push(`     ${sample.url}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push('警告:');
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  if (result.error !== undefined) {
    lines.push('エラー:');
    lines.push(`  ${result.error}`);
  }
  return lines.join('\n');
}

export function formatSourceCheckSummary(results: SourceCheckResult[]): string {
  const counts = countStatuses(results);
  return [
    '情報源チェックが完了しました。',
    `確認件数: ${results.length}`,
    `OK: ${counts.ok}`,
    `Warning: ${counts.warning}`,
    `Error: ${counts.error}`,
    `Unsupported: ${counts.unsupported}`,
  ].join('\n');
}

function countStatuses(results: SourceCheckResult[]): {
  ok: number;
  warning: number;
  error: number;
  unsupported: number;
} {
  return {
    ok: results.filter((result) => result.status === 'ok').length,
    warning: results.filter((result) => result.status === 'warning').length,
    error: results.filter((result) => result.status === 'error').length,
    unsupported: results.filter((result) => result.status === 'unsupported').length,
  };
}

export function sourceCheckExitCode(
  results: SourceCheckResult[],
  selection: SourceCheckSelection,
): number {
  if (results.some((result) => result.status === 'error')) return 1;
  if (
    results.some((result) =>
      result.status === 'unsupported' && (result.sourceEnabled || selection.mode === 'source'))
  ) return 1;
  return 0;
}

function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SAMPLE_LIMIT) {
    throw new Error(`--limit は1から${MAX_SAMPLE_LIMIT}の整数で指定してください。`);
  }
  return parsed;
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

function selectionOutputKey(selection: SourceCheckSelection): string {
  if (selection.mode === 'source') return selection.sourceId;
  return selection.mode;
}

function formatSelectorStatus(status: 'ok' | 'not_configured' | 'not_checked'): string {
  if (status === 'ok') return 'OK';
  if (status === 'not_configured') return '未設定';
  return '未確認（個別ページは取得しません）';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSourcesCheck()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
