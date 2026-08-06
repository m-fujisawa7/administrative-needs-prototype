import { ClaudeCliAnalyzer } from './claude-cli.ts';
import { AiConfigurationError } from './errors.ts';
import { MockAnalyzer } from './mock.ts';
import type { ChildProcessRunner } from './process.ts';
import { AI_PROVIDERS, type AdministrativeNeedAnalyzer } from './types.ts';

export type CreateAnalyzerOptions = {
  systemPrompt: string;
  env?: NodeJS.ProcessEnv;
  runner?: ChildProcessRunner;
};

export function createAnalyzer(options: CreateAnalyzerOptions): AdministrativeNeedAnalyzer {
  const env = options.env ?? process.env;
  const provider = env.AI_PROVIDER ?? 'claude_cli';
  if (!AI_PROVIDERS.some((candidate) => candidate === provider)) {
    throw new AiConfigurationError(`Unsupported AI_PROVIDER: ${provider}`);
  }
  if (provider === 'mock') return new MockAnalyzer();

  return new ClaudeCliAnalyzer({
    executable: requireNonEmpty(env.CLAUDE_CLI_PATH ?? 'claude', 'CLAUDE_CLI_PATH'),
    timeoutMs: parseInteger(env.AI_TIMEOUT_MS, 180_000, 'AI_TIMEOUT_MS', 1_000, 600_000),
    systemPrompt: options.systemPrompt,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim() === '') throw new AiConfigurationError(`${name} を空にできません。`);
  return value;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AiConfigurationError(
      `${name} は ${minimum} から ${maximum} の整数で指定してください。`,
    );
  }
  return parsed;
}
