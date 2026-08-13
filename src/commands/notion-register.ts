import { pathToFileURL } from 'node:url';
import { ClaudeUsageLimitError } from '../ai/errors.ts';
import { formatWarningLine } from '../ai/warning-severity.ts';
import { formatClaudeUsageLimitStop } from '../collection-run/format.ts';
import { NotionConfigurationError } from '../notion-check/errors.ts';
import {
  isNotionRegistrationConfigurationError,
  safeNotionRegistrationErrorMessage,
} from '../notion-register/error-format.ts';
import {
  formatNotionRegistrationCompleted,
  formatNotionDuplicateSkip,
  formatNotionRegistrationPreview,
} from '../notion-register/format.ts';
import {
  NotionRegistrationRuntimeError,
  prepareNotionRegistrationRuntime,
  resolveRegistrationSourceContext,
  unwrapNotionRegistrationRuntimeError,
  type NotionRegistrationRuntime,
  type NotionRegistrationRuntimeDependencies,
} from '../notion-register/runtime.ts';
import type { NotionRegisterCliOptions } from '../notion-register/types.ts';
import {
  parseValueOption,
  resolveNotionDatabaseId,
  setOptionOnce,
} from './cli-options.ts';

export type NotionRegisterCommandDependencies = NotionRegistrationRuntimeDependencies & {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseNotionRegisterArgs(argv: string[]): NotionRegisterCliOptions {
  let sourceId: string | undefined;
  let url: string | undefined;
  let databaseUrl: string | undefined;
  let databaseId: string | undefined;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') {
      if (write) throw new NotionConfigurationError('--write may only be specified once.');
      write = true;
      continue;
    }
    const parsed = parseValueOption(
      argv,
      index,
      argument,
      ['--source', '--url', '--database-url', '--database-id'],
    );
    if (parsed === null) throw new NotionConfigurationError(`Unknown option: ${argument}`);
    index += parsed.consumedNext ? 1 : 0;
    if (parsed.name === '--source') {
      sourceId = setOptionOnce(sourceId, parsed.value, parsed.name);
    }
    if (parsed.name === '--url') url = setOptionOnce(url, parsed.value, parsed.name);
    if (parsed.name === '--database-url') {
      databaseUrl = setOptionOnce(databaseUrl, parsed.value, parsed.name);
    }
    if (parsed.name === '--database-id') {
      databaseId = setOptionOnce(databaseId, parsed.value, parsed.name);
    }
  }

  if (sourceId === undefined) throw new NotionConfigurationError('--source is required.');
  if (url === undefined) throw new NotionConfigurationError('--url is required.');
  validateHttpUrl(url);
  return {
    sourceId,
    url,
    databaseId: resolveNotionDatabaseId(databaseUrl, databaseId),
    write,
  };
}

export async function runNotionRegister(
  argv = process.argv.slice(2),
  dependencies: NotionRegisterCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  let options: NotionRegisterCliOptions;
  try {
    options = parseNotionRegisterArgs(argv);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 2;
  }

  let sourceContext: Awaited<ReturnType<typeof resolveRegistrationSourceContext>>;
  try {
    sourceContext = await resolveRegistrationSourceContext(options.sourceId, dependencies);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 2;
  }

  let runtime: NotionRegistrationRuntime;
  try {
    runtime = await prepareNotionRegistrationRuntime(
      sourceContext,
      options.databaseId,
      dependencies,
    );
  } catch (error) {
    const originalError = unwrapNotionRegistrationRuntimeError(error);
    stderr(safeNotionRegistrationErrorMessage(originalError));
    if (error instanceof NotionRegistrationRuntimeError && error.phase === 'setup') return 2;
    return isNotionRegistrationConfigurationError(originalError) ? 2 : 1;
  }

  let result: Awaited<ReturnType<typeof runtime.register>>;
  try {
    result = await runtime.register(options.url, options.write);
  } catch (error) {
    // 利用上限はClaude全体の状態なので、stack traceではなく整形した停止表示にする。
    // それ以外の未知の例外は握りつぶさず、そのまま呼び出し側へ渡す。
    if (!(error instanceof ClaudeUsageLimitError)) throw error;
    stderr(formatClaudeUsageLimitStop({ message: error.limitMessage }));
    return 1;
  }

  for (const warning of result.warnings) {
    stderr(formatWarningLine(warning));
  }
  if (result.status === 'duplicate') {
    if (result.preview !== undefined) {
      stdout(formatNotionRegistrationPreview(result.preview));
    } else {
      stdout(formatNotionDuplicateSkip(options.url, {
        id: result.existingPageId,
        url: result.existingPageUrl,
      }));
    }
    return 0;
  }
  if (result.status === 'previewed') {
    stdout(formatNotionRegistrationPreview(result.preview));
    return 0;
  }
  if (result.status === 'created') {
    stdout(formatNotionRegistrationPreview(result.preview));
    stdout(formatNotionRegistrationCompleted(result.preview, {
      id: result.notionPageId,
      url: result.notionPageUrl,
    }));
    return 0;
  }
  if (result.preview !== undefined) {
    stdout(formatNotionRegistrationPreview(result.preview));
  }
  stderr(result.message);
  return result.configurationError ? 2 : 1;
}

function validateHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotionConfigurationError('--url must be a valid HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NotionConfigurationError('--url must be a valid HTTP or HTTPS URL.');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNotionRegister().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
