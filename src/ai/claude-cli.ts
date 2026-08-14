import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AiAnalyzerError, AiConfigurationError, ClaudeUsageLimitError } from './errors.ts';
import { formatAnalysisInput } from './prompt.ts';
import { detectClaudeUsageLimit } from './usage-limit.ts';
import { type ChildProcessRunner, runChildProcess } from './process.ts';
import {
  administrativeNeedJsonSchema,
  parseAdministrativeNeedAnalysis,
} from './schema.ts';
import type {
  AdministrativeNeedAnalysis,
  AdministrativeNeedAnalysisInput,
  AdministrativeNeedAnalyzer,
  AdministrativeNeedAnalyzerRunInfo,
} from './types.ts';

const RESULT_DIAGNOSTIC_SEGMENT_MAX_CHARACTERS = 500;
const PARSE_ERROR_CONTEXT_RADIUS_CHARACTERS = 200;
const SECRET_NAMES = [
  'NOTION_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_API_KEY',
  'API_KEY',
  'ACCESS_TOKEN',
  'AUTH_TOKEN',
  'TOKEN',
] as const;

class ClaudeResultJsonParseError extends AiAnalyzerError {
  override name = 'ClaudeResultJsonParseError';
}

export type ClaudeCliAnalyzerOptions = {
  executable: string;
  timeoutMs: number;
  systemPrompt: string;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  runner?: ChildProcessRunner;
};

export class ClaudeCliAnalyzer implements AdministrativeNeedAnalyzer {
  readonly provider = 'claude_cli' as const;
  readonly model = null;
  private readonly options: ClaudeCliAnalyzerOptions;
  private readonly runner: ChildProcessRunner;
  private lastRunInfo: AdministrativeNeedAnalyzerRunInfo = { jsonParseRetryCount: 0 };

  constructor(options: ClaudeCliAnalyzerOptions) {
    this.options = options;
    this.runner = options.runner ?? runChildProcess;
  }

  async analyze(input: AdministrativeNeedAnalysisInput): Promise<AdministrativeNeedAnalysis> {
    this.lastRunInfo = { jsonParseRetryCount: 0 };
    const jsonSchema = JSON.stringify(administrativeNeedJsonSchema());
    const initialPrompt = formatClaudePrompt(this.options.systemPrompt, jsonSchema, input);
    try {
      return await this.analyzeOnce(initialPrompt);
    } catch (error) {
      if (!(error instanceof ClaudeResultJsonParseError)) throw error;
    }

    this.lastRunInfo = { jsonParseRetryCount: 1 };
    try {
      return await this.analyzeOnce(formatJsonParseRetryPrompt(initialPrompt));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `Claude CLI JSON parse retry was attempted once but failed.\n${detail}`;
      if (error instanceof AiConfigurationError) throw new AiConfigurationError(message);
      throw new AiAnalyzerError(message);
    }
  }

  getLastRunInfo(): AdministrativeNeedAnalyzerRunInfo {
    return { ...this.lastRunInfo };
  }

  private async analyzeOnce(prompt: string): Promise<AdministrativeNeedAnalysis> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--max-turns', '1',
    ];
    const result = await this.runner({
      executable: this.options.executable,
      args,
      stdin: prompt,
      cwd: tmpdir(),
      timeoutMs: this.options.timeoutMs,
      maxStdoutBytes: this.options.maxStdoutBytes ?? 2 * 1024 * 1024,
      maxStderrBytes: this.options.maxStderrBytes ?? 64 * 1024,
    });
    if (result.exitCode !== 0) {
      const limitMessage = detectClaudeUsageLimit(result.stdout, result.stderr);
      if (limitMessage !== null) throw new ClaudeUsageLimitError(limitMessage);
      throw new AiAnalyzerError(formatExecutionFailure(result));
    }
    if (result.stdout.trim() === '') {
      throw new AiAnalyzerError(
        `Claude CLI returned empty stdout (${formatProcessSummary(result)}).${formatStderr(result.stderr)}`,
      );
    }
    // usage が取れたときだけ記録する。取得のために引数も呼び出し方式も変えない。
    const inputTokens = extractInputTokens(result.stdout);
    if (inputTokens !== undefined) {
      this.lastRunInfo = { ...this.lastRunInfo, inputTokens };
    }
    try {
      return parseClaudeOutput(result.stdout);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `${detail} (${formatProcessSummary(result)}).${formatStderr(result.stderr)}`;
      if (error instanceof ClaudeResultJsonParseError) {
        throw new ClaudeResultJsonParseError(message);
      }
      throw new AiAnalyzerError(message);
    }
  }
}

export function parseClaudeOutput(stdout: string): AdministrativeNeedAnalysis {
  let rawEnvelope: unknown;
  try {
    rawEnvelope = JSON.parse(stdout);
  } catch {
    throw new AiAnalyzerError('Claude CLI stdout was not valid outer JSON at stage 1.');
  }

  const envelope = asRecord(rawEnvelope);
  if (envelope === null) {
    throw new AiAnalyzerError('Claude CLI outer JSON was not an object at stage 1.');
  }
  if (envelope.type !== 'result') {
    throw new AiAnalyzerError('Claude CLI outer JSON type was not "result" at stage 2.');
  }
  if (envelope.subtype !== 'success') {
    throw new AiAnalyzerError('Claude CLI outer JSON subtype was not "success" at stage 3.');
  }
  if (envelope.is_error !== false) {
    throw new AiAnalyzerError('Claude CLI outer JSON is_error was not false at stage 4.');
  }
  if (typeof envelope.result !== 'string') {
    throw new AiAnalyzerError('Claude CLI outer JSON result was not a string at stage 5.');
  }

  const candidate = parseResultString(envelope.result);
  try {
    return parseAdministrativeNeedAnalysis(candidate);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AiAnalyzerError(
        `Claude result did not match the expected Zod schema at stage 8: ${z.prettifyError(error)}`,
      );
    }
    throw error;
  }
}

function parseResultString(value: string): unknown {
  const prepared = prepareResultString(value);
  try {
    return JSON.parse(prepared.json);
  } catch (error) {
    throw new ClaudeResultJsonParseError([
      'Claude result string was not valid administrative-needs JSON at stage 7.',
      formatResultParseDiagnostics(prepared, error),
    ].join('\n'));
  }
}

type PreparedResultString = {
  json: string;
  resultCharacters: number;
  codeFenceDetected: boolean;
  codeFenceRemoved: boolean;
};

function prepareResultString(value: string): PreparedResultString {
  const trimmed = value.trim();
  const codeFenceDetected = /(?:^|\r?\n)[ \t]*```(?:json)?[ \t]*(?:\r?\n|$)/iu
    .test(trimmed);
  const jsonFence = trimmed.match(
    /^```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```$/iu,
  );
  if (jsonFence?.[1] !== undefined) {
    return {
      json: jsonFence[1],
      resultCharacters: characterCount(value),
      codeFenceDetected,
      codeFenceRemoved: true,
    };
  }

  const unlabelledFence = trimmed.match(
    /^```[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```$/u,
  );
  return {
    json: unlabelledFence?.[1] ?? trimmed,
    resultCharacters: characterCount(value),
    codeFenceDetected,
    codeFenceRemoved: unlabelledFence?.[1] !== undefined,
  };
}

function formatResultParseDiagnostics(
  prepared: PreparedResultString,
  error: unknown,
): string {
  const sanitized = sanitizeResultForDebug(prepared.json);
  const characters = Array.from(sanitized);
  const head = characters.slice(0, RESULT_DIAGNOSTIC_SEGMENT_MAX_CHARACTERS).join('');
  const tail = characters.slice(-RESULT_DIAGNOSTIC_SEGMENT_MAX_CHARACTERS).join('');
  const parseError = error instanceof Error ? error.message : String(error);
  const parseErrorContext = formatParseErrorContext(prepared.json, parseError);
  return [
    'Claude result parse diagnostics:',
    `Result characters: ${prepared.resultCharacters}`,
    `Code fence detected: ${yesNo(prepared.codeFenceDetected)}`,
    `Code fence removed: ${yesNo(prepared.codeFenceRemoved)}`,
    `Prepared JSON characters: ${characterCount(prepared.json)}`,
    `JSON.parse error: ${sanitizeResultForDebug(parseError)}`,
    ...(parseErrorContext === null ? [] : [
      `Parse error context (up to ${PARSE_ERROR_CONTEXT_RADIUS_CHARACTERS} characters before and after):`,
      parseErrorContext,
    ]),
    `Prepared JSON head (up to ${RESULT_DIAGNOSTIC_SEGMENT_MAX_CHARACTERS} characters):`,
    head || '(empty)',
    `Prepared JSON tail (up to ${RESULT_DIAGNOSTIC_SEGMENT_MAX_CHARACTERS} characters):`,
    tail || '(empty)',
  ].join('\n');
}

function formatParseErrorContext(value: string, parseError: string): string | null {
  const match = parseError.match(/\bposition\s+(\d+)\b/iu);
  const position = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(position) || position < 0 || position > value.length) return null;

  const sanitized = sanitizeResultForDebugPreservingOffsets(value);
  const before = Array.from(sanitized.slice(0, position))
    .slice(-PARSE_ERROR_CONTEXT_RADIUS_CHARACTERS)
    .join('');
  const after = Array.from(sanitized.slice(position))
    .slice(0, PARSE_ERROR_CONTEXT_RADIUS_CHARACTERS)
    .join('');
  return [before, '<<< PARSE ERROR POSITION >>>', after].join('\n');
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function yesNo(value: boolean): 'Yes' | 'No' {
  return value ? 'Yes' : 'No';
}

function sanitizeResultForDebug(value: string): string {
  let sanitized = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '\uFFFD')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+={0,2}/giu, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{10,}|secret_[A-Za-z0-9_-]{10,}|ntn_[A-Za-z0-9_-]{10,})\b/giu, '[REDACTED]');

  for (const secretName of SECRET_NAMES) {
    const assignment = new RegExp(
      `(["']?${secretName}["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,}\\]]+)`,
      'giu',
    );
    sanitized = sanitized.replace(assignment, '$1[REDACTED]');
  }
  return sanitized;
}

function sanitizeResultForDebugPreservingOffsets(value: string): string {
  let sanitized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '\uFFFD')
    .replace(
      /(\bBearer\s+)([A-Za-z0-9._~+/-]+={0,2})/giu,
      (_match, prefix: string, secret: string) => prefix + maskSameLength(secret),
    )
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{10,}|secret_[A-Za-z0-9_-]{10,}|ntn_[A-Za-z0-9_-]{10,})\b/giu,
      maskSameLength,
    );

  for (const secretName of SECRET_NAMES) {
    const assignment = new RegExp(
      `(["']?${secretName}["']?\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,}\\]]+)`,
      'giu',
    );
    sanitized = sanitized.replace(
      assignment,
      (_match, prefix: string, secret: string) => prefix + maskSameLength(secret),
    );
  }

  return sanitized.replace(/\b[A-Za-z0-9_+./=-]{32,}\b/gu, maskSameLength);
}

function maskSameLength(value: string): string {
  return '\u2588'.repeat(value.length);
}

function formatClaudePrompt(
  systemPrompt: string,
  jsonSchema: string,
  input: AdministrativeNeedAnalysisInput,
): string {
  return [
    systemPrompt,
    '',
    '# 出力JSON Schema',
    '次のJSON Schemaに適合するJSONオブジェクトだけを返してください。',
    jsonSchema,
    '',
    '# 分析対象',
    formatAnalysisInput(input),
  ].join('\n');
}

function formatJsonParseRetryPrompt(initialPrompt: string): string {
  return [
    initialPrompt,
    '',
    '# JSON形式エラーによる再試行',
    '前回の回答はJSON.parseできない不正JSONでした。元の分析対象をもう一度分析し、回答全体を作り直してください。',
    String.raw`JSON文字列の値にダブルクォート（"）を含める場合は、必ずバックスラッシュでエスケープして \" としてください。`,
    'Markdownコードフェンス、説明文、見出し、注釈を付けず、有効なJSONオブジェクトだけを返してください。',
  ].join('\n');
}

/**
 * 外側JSONの usage.input_tokens を取れたときだけ返す。
 *
 * usage は Claude CLI 側の都合で変わり得るため、欠落・型違い・JSON不正はすべて
 * undefined として扱い、行政ニーズの解析そのものは絶対に失敗させない。
 * 表示は診断目的なので、取れない環境では文字数だけで運用する。
 */
function extractInputTokens(stdout: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const envelope = asRecord(parsed);
  if (envelope === null) return undefined;
  const usage = asRecord(envelope.usage);
  const tokens = usage?.input_tokens;
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatExecutionFailure(result: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}): string {
  return `Claude CLI execution failed (${formatProcessSummary(result)}).${formatStderr(result.stderr)}`;
}

function formatProcessSummary(result: {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}): string {
  return [
    `exit=${result.exitCode ?? 'null'}`,
    `signal=${result.signal ?? 'none'}`,
    `stdoutCharacters=${result.stdout.length}`,
  ].join(', ');
}

function formatStderr(stderr: string): string {
  const normalized = stderr.replace(/\0/gu, '').trim();
  return normalized === '' ? ' stderr: (empty)' : ` stderr:\n${normalized}`;
}
