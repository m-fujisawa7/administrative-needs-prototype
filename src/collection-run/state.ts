import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const COLLECTION_STATE_PATH = 'data/collection-state.json';
export const INITIAL_COLLECTION_SINCE = '2026-07-01';
export const COLLECTION_LOOKBACK_DAYS = 3;

const stateEntrySchema = z.strictObject({
  last_successful_check_at: z.string().refine(
    (value) => hasExplicitTimezone(value) && Number.isFinite(Date.parse(value)),
    'last_successful_check_at must be an ISO 8601 timestamp with a timezone.',
  ),
});

const collectionStateSchema = z.record(z.string().min(1), stateEntrySchema);

export type CollectionState = z.infer<typeof collectionStateSchema>;

export type CollectionPeriod = {
  effectiveSince: string;
  runStartedAt: string;
  previousSuccessfulCheck: string | null;
  usedManualSince: boolean;
};

export class CollectionStateError extends Error {
  override name = 'CollectionStateError';
}

export async function readCollectionState(
  filePath = COLLECTION_STATE_PATH,
): Promise<CollectionState> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) return {};
    throw stateReadError(filePath, 'The state file could not be read.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw stateReadError(filePath, 'The state file contains invalid JSON.');
  }
  const state = collectionStateSchema.safeParse(parsed);
  if (!state.success) {
    throw stateReadError(filePath, 'The state file has an invalid structure.');
  }
  return state.data;
}

export async function writeCollectionStateAtomic(
  state: CollectionState,
  filePath = COLLECTION_STATE_PATH,
): Promise<void> {
  const validated = collectionStateSchema.parse(state);
  const targetPath = resolve(filePath);
  const directory = dirname(targetPath);
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function resolveCollectionPeriod(
  runStartedAt: Date,
  previousSuccessfulCheck: string | null,
  manualSince?: string,
): CollectionPeriod {
  const formattedRunStartedAt = formatJapanTimestamp(runStartedAt);
  if (manualSince !== undefined) {
    return {
      effectiveSince: parseSinceDate(manualSince),
      runStartedAt: formattedRunStartedAt,
      previousSuccessfulCheck,
      usedManualSince: true,
    };
  }
  if (previousSuccessfulCheck === null) {
    return {
      effectiveSince: INITIAL_COLLECTION_SINCE,
      runStartedAt: formattedRunStartedAt,
      previousSuccessfulCheck: null,
      usedManualSince: false,
    };
  }

  const lookback = new Date(Date.parse(previousSuccessfulCheck));
  lookback.setUTCDate(lookback.getUTCDate() - COLLECTION_LOOKBACK_DAYS);
  const initial = new Date(`${INITIAL_COLLECTION_SINCE}T00:00:00+09:00`);
  return {
    effectiveSince: formatJapanTimestamp(lookback < initial ? initial : lookback),
    runStartedAt: formattedRunStartedAt,
    previousSuccessfulCheck,
    usedManualSince: false,
  };
}

export function parseSinceDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CollectionStateError('--since must use YYYY-MM-DD format.');
  }
  const date = new Date(`${value}T00:00:00+09:00`);
  if (!Number.isFinite(date.getTime()) || formatJapanDate(date) !== value) {
    throw new CollectionStateError('--since must be a valid date in YYYY-MM-DD format.');
  }
  return value;
}

export function formatJapanTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

function formatJapanDate(date: Date): string {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function hasExplicitTimezone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}

function stateReadError(filePath: string, detail: string): CollectionStateError {
  return new CollectionStateError([
    'Failed to read collection state.',
    '',
    'File:',
    filePath,
    '',
    detail,
  ].join('\n'));
}
