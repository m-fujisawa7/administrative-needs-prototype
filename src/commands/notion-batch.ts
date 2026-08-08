import { pathToFileURL } from 'node:url';
import { formatWarningLine } from '../ai/warning-severity.ts';
import { processSelectedUrls } from '../notion-batch/batch.ts';
import { NotionBatchConfigurationError } from '../notion-batch/errors.ts';
import {
  formatNotionBatchItem,
  formatNotionBatchSummary,
} from '../notion-batch/format.ts';
import { readSelectedUrlFile } from '../notion-batch/input.ts';
import type {
  NotionBatchCliOptions,
  ParsedSelectedUrls,
} from '../notion-batch/types.ts';
import { safeNotionRegistrationErrorMessage } from '../notion-register/error-format.ts';
import {
  prepareNotionRegistrationRuntime,
  resolveRegistrationSourceContext,
  unwrapNotionRegistrationRuntimeError,
  type NotionRegistrationRuntime,
  type NotionRegistrationRuntimeDependencies,
} from '../notion-register/runtime.ts';
import {
  parseValueOption,
  resolveNotionDatabaseId,
  setOptionOnce,
} from './cli-options.ts';

export type NotionBatchCommandDependencies = NotionRegistrationRuntimeDependencies & {
  readSelectedUrls?: (path: string) => Promise<ParsedSelectedUrls>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseNotionBatchArgs(argv: string[]): NotionBatchCliOptions {
  let sourceId: string | undefined;
  let file: string | undefined;
  let databaseUrl: string | undefined;
  let databaseId: string | undefined;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') {
      if (write) throw new NotionBatchConfigurationError('--write may only be specified once.');
      write = true;
      continue;
    }
    const parsed = parseValueOption(
      argv,
      index,
      argument,
      ['--source', '--file', '--database-url', '--database-id'],
      createBatchError,
    );
    if (parsed === null) throw new NotionBatchConfigurationError(`Unknown option: ${argument}`);
    index += parsed.consumedNext ? 1 : 0;
    if (parsed.name === '--source') {
      sourceId = setOptionOnce(sourceId, parsed.value, parsed.name, createBatchError);
    }
    if (parsed.name === '--file') {
      file = setOptionOnce(file, parsed.value, parsed.name, createBatchError);
    }
    if (parsed.name === '--database-url') {
      databaseUrl = setOptionOnce(databaseUrl, parsed.value, parsed.name, createBatchError);
    }
    if (parsed.name === '--database-id') {
      databaseId = setOptionOnce(databaseId, parsed.value, parsed.name, createBatchError);
    }
  }

  if (sourceId === undefined) throw new NotionBatchConfigurationError('--source is required.');
  if (file === undefined) throw new NotionBatchConfigurationError('--file is required.');
  return {
    sourceId,
    file,
    databaseId: resolveNotionDatabaseId(databaseUrl, databaseId, createBatchError),
    write,
  };
}

export async function runNotionBatch(
  argv = process.argv.slice(2),
  dependencies: NotionBatchCommandDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  let options: NotionBatchCliOptions;
  let selectedUrls: ParsedSelectedUrls;
  try {
    options = parseNotionBatchArgs(argv);
    selectedUrls = await (
      dependencies.readSelectedUrls ?? readSelectedUrlFile
    )(options.file);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  let sourceContext: Awaited<ReturnType<typeof resolveRegistrationSourceContext>>;
  try {
    sourceContext = await resolveRegistrationSourceContext(options.sourceId, dependencies);
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(error));
    return 1;
  }

  let runtime: NotionRegistrationRuntime;
  try {
    runtime = await prepareNotionRegistrationRuntime(
      sourceContext,
      options.databaseId,
      dependencies,
    );
  } catch (error) {
    stderr(safeNotionRegistrationErrorMessage(unwrapNotionRegistrationRuntimeError(error)));
    return 1;
  }
  const batchReport = await processSelectedUrls(
    selectedUrls,
    options.write,
    (officialUrl) => runtime.register(officialUrl, options.write),
    (result, index, total) => {
      for (const warning of result.warnings) {
        stderr(formatWarningLine(warning, `[${index}/${total}] `));
      }
      stdout(formatNotionBatchItem(result, index, total));
    },
  );
  stdout(formatNotionBatchSummary(batchReport));
  return batchReport.results.some((result) => result.status === 'failed') ? 1 : 0;
}

function createBatchError(message: string): NotionBatchConfigurationError {
  return new NotionBatchConfigurationError(message);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNotionBatch().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
