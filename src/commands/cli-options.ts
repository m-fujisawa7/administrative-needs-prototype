import { NotionConfigurationError } from '../notion-check/errors.ts';
import {
  extractNotionDatabaseId,
  normalizeNotionDatabaseId,
} from '../notion-check/id.ts';

export type ConfigurationErrorFactory = (message: string) => Error;

export type ParsedValueOption<TName extends string> = {
  name: TName;
  value: string;
  consumedNext: boolean;
};

export function parseValueOption<TName extends string>(
  argv: string[],
  index: number,
  argument: string | undefined,
  names: readonly TName[],
  createError: ConfigurationErrorFactory = defaultError,
): ParsedValueOption<TName> | null {
  for (const name of names) {
    if (argument === name) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw createError(`${name} requires a value.`);
      }
      return { name, value, consumedNext: true };
    }
    const prefix = `${name}=`;
    if (argument?.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      if (value === '') throw createError(`${name} requires a value.`);
      return { name, value, consumedNext: false };
    }
  }
  return null;
}

export function setOptionOnce(
  current: string | undefined,
  value: string,
  option: string,
  createError: ConfigurationErrorFactory = defaultError,
): string {
  if (current !== undefined) {
    throw createError(`${option} may only be specified once.`);
  }
  return value;
}

export function resolveNotionDatabaseId(
  databaseUrl: string | undefined,
  databaseId: string | undefined,
  createError: ConfigurationErrorFactory = defaultError,
): string {
  if (databaseUrl !== undefined && databaseId !== undefined) {
    throw createError('Specify either --database-url or --database-id, not both.');
  }
  if (databaseUrl === undefined && databaseId === undefined) {
    throw createError('Specify either --database-url or --database-id.');
  }
  return databaseUrl === undefined
    ? normalizeNotionDatabaseId(databaseId!)
    : extractNotionDatabaseId(databaseUrl);
}

function defaultError(message: string): NotionConfigurationError {
  return new NotionConfigurationError(message);
}
