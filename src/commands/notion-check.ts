import { pathToFileURL } from 'node:url';
import { checkNotionConnection } from '../notion-check/check.ts';
import { createNotionReadClient } from '../notion-check/client.ts';
import {
  loadRepositoryEnvironment,
  requireNotionToken,
} from '../notion-check/environment.ts';
import { NotionCheckError, NotionConfigurationError } from '../notion-check/errors.ts';
import { formatNotionConnectionReport } from '../notion-check/format.ts';
import { extractNotionDatabaseId, normalizeNotionDatabaseId } from '../notion-check/id.ts';
import type { NotionCheckTarget, NotionReadClient } from '../notion-check/types.ts';

export type NotionCheckCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  loadEnvironment?: () => void;
  createClient?: (token: string) => NotionReadClient;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseNotionCheckArgs(argv: string[]): NotionCheckTarget {
  let databaseUrl: string | undefined;
  let databaseId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--database-url') {
      databaseUrl = setOnce(
        databaseUrl,
        requireValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument?.startsWith('--database-url=')) {
      databaseUrl = setOnce(
        databaseUrl,
        requireInlineValue(argument, '--database-url='),
        '--database-url',
      );
      continue;
    }
    if (argument === '--database-id') {
      databaseId = setOnce(
        databaseId,
        requireValue(argv, index, argument),
        argument,
      );
      index += 1;
      continue;
    }
    if (argument?.startsWith('--database-id=')) {
      databaseId = setOnce(
        databaseId,
        requireInlineValue(argument, '--database-id='),
        '--database-id',
      );
      continue;
    }
    throw new NotionConfigurationError(`Unknown option: ${argument}`);
  }

  if (databaseUrl !== undefined && databaseId !== undefined) {
    throw new NotionConfigurationError(
      'Specify either --database-url or --database-id, not both.',
    );
  }
  if (databaseUrl === undefined && databaseId === undefined) {
    throw new NotionConfigurationError('Specify either --database-url or --database-id.');
  }
  return {
    databaseId: databaseUrl === undefined
      ? normalizeNotionDatabaseId(databaseId!)
      : extractNotionDatabaseId(databaseUrl),
  };
}

export async function runNotionCheck(
  argv = process.argv.slice(2),
  dependencies: NotionCheckCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    (dependencies.loadEnvironment ?? loadRepositoryEnvironment)();
    const env = dependencies.env ?? process.env;
    const token = requireNotionToken(env);
    const target = parseNotionCheckArgs(argv);
    const client = (dependencies.createClient ?? createNotionReadClient)(token);
    const report = await checkNotionConnection(client, target.databaseId);
    stdout(formatNotionConnectionReport(report));
    return 0;
  } catch (error) {
    if (error instanceof NotionConfigurationError) {
      stderr(error.message);
      return 2;
    }
    if (error instanceof NotionCheckError) {
      stderr(error.message);
      return 1;
    }
    stderr('Notion connection check failed before a safe API response was available.');
    return 1;
  }
}

function setOnce(current: string | undefined, value: string, option: string): string {
  if (current !== undefined) {
    throw new NotionConfigurationError(`${option} may only be specified once.`);
  }
  return value;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new NotionConfigurationError(`${option} requires a value.`);
  }
  return value;
}

function requireInlineValue(argument: string, prefix: string): string {
  const value = argument.slice(prefix.length);
  if (value === '') {
    throw new NotionConfigurationError(`${prefix.slice(0, -1)} requires a value.`);
  }
  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNotionCheck().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
