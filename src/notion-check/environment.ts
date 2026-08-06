import { loadEnvFile } from 'node:process';
import { NotionConfigurationError } from './errors.ts';

export function loadRepositoryEnvironment(): void {
  try {
    loadEnvFile('.env');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw new NotionConfigurationError('Could not load .env.');
  }
}

export function requireNotionToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.NOTION_TOKEN?.trim();
  if (token === undefined || token === '') {
    throw new NotionConfigurationError('NOTION_TOKEN is not set in .env.');
  }
  return token;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
