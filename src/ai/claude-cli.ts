import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AiAnalyzerError } from './errors.ts';
import { formatAnalysisInput } from './prompt.ts';
import { type ChildProcessRunner, runChildProcess } from './process.ts';
import {
  administrativeNeedJsonSchema,
  parseAdministrativeNeedAnalysis,
} from './schema.ts';
import type {
  AdministrativeNeedAnalysis,
  AdministrativeNeedAnalysisInput,
  AdministrativeNeedAnalyzer,
} from './types.ts';

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

  constructor(options: ClaudeCliAnalyzerOptions) {
    this.options = options;
    this.runner = options.runner ?? runChildProcess;
  }

  async analyze(input: AdministrativeNeedAnalysisInput): Promise<AdministrativeNeedAnalysis> {
    const jsonSchema = JSON.stringify(administrativeNeedJsonSchema());
    const args = [
      '-p',
      '--output-format', 'json',
      '--max-turns', '1',
    ];
    const result = await this.runner({
      executable: this.options.executable,
      args,
      stdin: formatClaudePrompt(this.options.systemPrompt, jsonSchema, input),
      cwd: tmpdir(),
      timeoutMs: this.options.timeoutMs,
      maxStdoutBytes: this.options.maxStdoutBytes ?? 2 * 1024 * 1024,
      maxStderrBytes: this.options.maxStderrBytes ?? 64 * 1024,
    });
    if (result.exitCode !== 0) {
      throw new AiAnalyzerError(formatExecutionFailure(result));
    }
    if (result.stdout.trim() === '') {
      throw new AiAnalyzerError(
        `Claude CLI returned empty stdout (${formatProcessSummary(result)}).${formatStderr(result.stderr)}`,
      );
    }
    try {
      return parseClaudeOutput(result.stdout);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AiAnalyzerError(
        `${detail} (${formatProcessSummary(result)}).${formatStderr(result.stderr)}`,
      );
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
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu);
  const json = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(json);
  } catch {
    throw new AiAnalyzerError('Claude result string was not valid administrative-needs JSON at stage 7.');
  }
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
