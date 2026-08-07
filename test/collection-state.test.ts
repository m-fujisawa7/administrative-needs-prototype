import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readCollectionState,
  resolveCollectionPeriod,
  writeCollectionStateAtomic,
} from '../src/collection-run/state.ts';

describe('収集期間', () => {
  const runStartedAt = new Date('2026-08-07T03:00:00.000Z');

  it('stateなしでは2026-07-01から開始する', () => {
    expect(resolveCollectionPeriod(runStartedAt, null)).toMatchObject({
      effectiveSince: '2026-07-01',
      runStartedAt: '2026-08-07T12:00:00+09:00',
      previousSuccessfulCheck: null,
      usedManualSince: false,
    });
  });

  it('stateありではlast_successful_check_atの3日前から開始する', () => {
    expect(resolveCollectionPeriod(
      runStartedAt,
      '2026-08-05T09:00:00+09:00',
    ).effectiveSince).toBe('2026-08-02T09:00:00+09:00');
  });

  it('3日前が初回開始日より前なら2026-07-01へ丸める', () => {
    expect(resolveCollectionPeriod(
      runStartedAt,
      '2026-07-02T09:00:00+09:00',
    ).effectiveSince).toBe('2026-07-01T00:00:00+09:00');
  });

  it('--sinceがstateより優先される', () => {
    expect(resolveCollectionPeriod(
      runStartedAt,
      '2026-08-05T09:00:00+09:00',
      '2026-07-15',
    )).toMatchObject({
      effectiveSince: '2026-07-15',
      usedManualSince: true,
    });
  });
});

describe('収集stateファイル', () => {
  let directory: string;
  let statePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'collection-state-test-'));
    statePath = join(directory, 'nested', 'collection-state.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('ファイルが存在しない場合は空stateを返し、作成しない', async () => {
    await expect(readCollectionState(statePath)).resolves.toEqual({});
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it('JSON破損時は明確なエラーにして上書きしない', async () => {
    await writeCollectionStateAtomic({}, statePath);
    await writeFile(statePath, '{ broken json', 'utf8');
    await expect(readCollectionState(statePath)).rejects.toThrow([
      'Failed to read collection state.',
      '',
      'File:',
      statePath,
      '',
      'The state file contains invalid JSON.',
    ].join('\n'));
    await expect(readFile(statePath, 'utf8')).resolves.toBe('{ broken json');
  });

  it('不正なstate構造を拒否する', async () => {
    await writeCollectionStateAtomic({}, statePath);
    await writeFile(statePath, JSON.stringify({ source: { wrong: true } }), 'utf8');
    await expect(readCollectionState(statePath)).rejects.toThrow(
      'The state file has an invalid structure.',
    );
  });

  it('一時ファイルからrenameして既存stateを置き換える', async () => {
    await writeCollectionStateAtomic({
      old: { last_successful_check_at: '2026-08-01T09:00:00+09:00' },
    }, statePath);
    await writeCollectionStateAtomic({
      current: { last_successful_check_at: '2026-08-07T12:00:00+09:00' },
    }, statePath);

    await expect(readCollectionState(statePath)).resolves.toEqual({
      current: { last_successful_check_at: '2026-08-07T12:00:00+09:00' },
    });
    await expect(readdir(join(directory, 'nested'))).resolves.toEqual([
      'collection-state.json',
    ]);
  });
});
