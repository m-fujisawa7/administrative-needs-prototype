import { describe, expect, it, vi } from 'vitest';
import {
  parseCollectionBatchArgs,
  runCollectionBatchCommand,
  selectBatchSourceIds,
} from '../src/commands/collection-batch.ts';
import { runCollectionBatch } from '../src/collection-run/batch.ts';
import { formatCollectionBatchSummary } from '../src/collection-run/format.ts';
import type { ExecuteSourceCollectionOutcome } from '../src/collection-run/execute.ts';
import type { CollectionRunReport } from '../src/collection-run/types.ts';
import type { CollectionState } from '../src/collection-run/state.ts';
import { getSourcesByMunicipality } from '../src/source-registry/load.ts';
import type { Organization, Source, SourceRegistry } from '../src/source-registry/schema.ts';

const DATABASE_URL = 'https://app.notion.com/p/1234567890abcdef1234567890abcdef?v=1';
// extractNotionDatabaseId はハイフン付きUUIDへ正規化する（既存挙動）。
const DATABASE_ID = '12345678-90ab-cdef-1234-567890abcdef';

function organization(id: string, name: string, over: Partial<Organization> = {}): Organization {
  return {
    id,
    name,
    organization_type: 'designated_city',
    official_domain: `${id}.example.lg.jp`,
    enabled: true,
    ...over,
  };
}

function source(id: string, organizationId: string, enabled = true): Source {
  return {
    id,
    organization_id: organizationId,
    name: id,
    url: `https://${organizationId}.example.lg.jp/${id}`,
    collector_type: 'list_page',
    source_category: 'procurement',
    priority: 'high',
    enabled,
  };
}

const REGISTRY: SourceRegistry = {
  version: 1,
  organizations: [
    organization('nagoya-city', '名古屋市'),
    organization('nagoya-hatch', '名古屋市', {
      organization_type: 'external_organization',
      parent_organization_id: 'nagoya-city',
    }),
    organization('osaka-city', '大阪市'),
    organization('disabled-city', '無効市', { enabled: false }),
  ],
  sources: [
    source('nagoya-rfi-rfc', 'nagoya-city'),
    source('nagoya-hatch-tech-solution', 'nagoya-hatch'),
    source('nagoya-disabled', 'nagoya-city', false),
    source('osaka-digital-rss', 'osaka-city'),
    source('disabled-org-source', 'disabled-city'),
  ],
};

function report(over: Partial<CollectionRunReport> = {}): CollectionRunReport {
  return {
    write: true,
    sourceId: 's',
    effectiveSince: '2026-08-01T00:00:00.000Z',
    runStartedAt: '2026-08-08T00:00:00.000Z',
    candidatesCollected: 0,
    uniqueCandidates: 0,
    candidatesInPeriod: 0,
    newCandidatesFound: 0,
    processedNewCandidates: 0,
    remainingNewCandidates: 0,
    results: [],
    collectionState: { status: 'advanced', newLastSuccessfulCheck: '2026-08-08T00:00:00.000Z' },
    ...over,
  };
}

const BASE_ARGS = ['--database-url', DATABASE_URL];

describe('parseCollectionBatchArgs: 選択方法', () => {
  it('--municipality を受け取る', () => {
    const options = parseCollectionBatchArgs([...BASE_ARGS, '--municipality', '名古屋市']);
    expect(options.selection).toEqual({ kind: 'municipality', municipality: '名古屋市' });
  });

  it('--all を受け取る', () => {
    expect(parseCollectionBatchArgs([...BASE_ARGS, '--all']).selection).toEqual({ kind: 'all' });
  });

  it('--sources をカンマ区切りで受け取る', () => {
    const options = parseCollectionBatchArgs([...BASE_ARGS, '--sources', 'a, b ,c']);
    expect(options.selection).toEqual({ kind: 'sources', sourceIds: ['a', 'b', 'c'] });
  });

  it('3種類を同時指定するとエラー', () => {
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--all', '--municipality', '名古屋市']))
      .toThrow('may not be combined');
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--all', '--sources', 'a']))
      .toThrow('may not be combined');
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--municipality', '名古屋市', '--sources', 'a']))
      .toThrow('may not be combined');
  });

  it('どれも指定しない場合はエラー', () => {
    expect(() => parseCollectionBatchArgs(BASE_ARGS)).toThrow('is required');
  });

  it('--sources が空ならエラー', () => {
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--sources', ' , ']))
      .toThrow('at least one source ID');
  });

  it('--sources の重複はエラー', () => {
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--sources', 'a,b,a']))
      .toThrow('duplicate source IDs');
  });
});

describe('parseCollectionBatchArgs: collect:run と揃えた挙動', () => {
  it('既定はPreviewで、--write のときだけWrite', () => {
    expect(parseCollectionBatchArgs([...BASE_ARGS, '--all']).write).toBe(false);
    expect(parseCollectionBatchArgs([...BASE_ARGS, '--all', '--write']).write).toBe(true);
  });

  it('--limit の既定値と上限を collect:run と揃える', () => {
    expect(parseCollectionBatchArgs([...BASE_ARGS, '--all']).limit).toBe(5);
    expect(parseCollectionBatchArgs([...BASE_ARGS, '--all', '--limit', '2']).limit).toBe(2);
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--all', '--limit', '21']))
      .toThrow('1 to 20');
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--all', '--limit', '0']))
      .toThrow('1 to 20');
  });

  it('--since を受け取る', () => {
    expect(parseCollectionBatchArgs([...BASE_ARGS, '--all', '--since', '2026-08-01']).since)
      .toBe('2026-08-01');
  });

  it('--database-url からDB IDを解決する', () => {
    expect(parseCollectionBatchArgs([...BASE_ARGS, '--all']).databaseId).toBe(DATABASE_ID);
  });

  it('未知のオプションはエラー', () => {
    expect(() => parseCollectionBatchArgs([...BASE_ARGS, '--all', '--parallel']))
      .toThrow('Unknown option');
  });
});

describe('selectBatchSourceIds', () => {
  it('--municipality で該当自治体のSourceだけ選ぶ（親組織経由も含む）', () => {
    expect(selectBatchSourceIds(REGISTRY, { kind: 'municipality', municipality: '名古屋市' }))
      .toEqual(['nagoya-rfi-rfc', 'nagoya-hatch-tech-solution']);
  });

  it('--municipality は無効Sourceを含めない', () => {
    expect(selectBatchSourceIds(REGISTRY, { kind: 'municipality', municipality: '名古屋市' }))
      .not.toContain('nagoya-disabled');
  });

  it('--all で有効なSourceをすべて選ぶ', () => {
    expect(selectBatchSourceIds(REGISTRY, { kind: 'all' }))
      .toEqual(['nagoya-rfi-rfc', 'nagoya-hatch-tech-solution', 'osaka-digital-rss']);
  });

  it('--all は無効Sourceと無効組織のSourceを含めない', () => {
    const selected = selectBatchSourceIds(REGISTRY, { kind: 'all' });
    expect(selected).not.toContain('nagoya-disabled');
    expect(selected).not.toContain('disabled-org-source');
  });

  it('--sources は指定順を維持して選ぶ', () => {
    expect(selectBatchSourceIds(REGISTRY, {
      kind: 'sources',
      sourceIds: ['osaka-digital-rss', 'nagoya-rfi-rfc'],
    })).toEqual(['osaka-digital-rss', 'nagoya-rfi-rfc']);
  });

  it('不明なSource IDは開始前にエラー', () => {
    expect(() => selectBatchSourceIds(REGISTRY, {
      kind: 'sources',
      sourceIds: ['nagoya-rfi-rfc', 'does-not-exist'],
    })).toThrow('Source not found: does-not-exist');
  });

  it('該当自治体がなければ候補付きでエラー', () => {
    expect(() => selectBatchSourceIds(REGISTRY, { kind: 'municipality', municipality: '札幌市' }))
      .toThrow('名古屋市');
  });
});

describe('getSourcesByMunicipality', () => {
  it('親組織の name でも子組織のSourceを選ぶ', () => {
    expect(getSourcesByMunicipality(REGISTRY, '名古屋市').map((entry) => entry.id))
      .toContain('nagoya-hatch-tech-solution');
  });

  it('別の自治体のSourceは選ばない', () => {
    expect(getSourcesByMunicipality(REGISTRY, '大阪市').map((entry) => entry.id))
      .toEqual(['osaka-digital-rss']);
  });

  it('循環参照があっても無限ループしない', () => {
    const cyclic: SourceRegistry = {
      version: 1,
      organizations: [
        organization('a', 'A市', { parent_organization_id: 'b' }),
        organization('b', 'B市', { parent_organization_id: 'a' }),
      ],
      sources: [source('a-source', 'a')],
    };
    expect(getSourcesByMunicipality(cyclic, 'B市').map((entry) => entry.id)).toEqual(['a-source']);
  });
});

describe('runCollectionBatch: 逐次実行', () => {
  function outcome(over: Partial<ExecuteSourceCollectionOutcome> = {}): ExecuteSourceCollectionOutcome {
    return { report: report(), state: {}, exitCode: 0, ...over };
  }

  it('選択したSourceを順番に実行する', async () => {
    const seen: string[] = [];
    const executeSource = vi.fn(async (input) => {
      seen.push(input.options.sourceId);
      return outcome();
    });
    await runCollectionBatch({
      sourceIds: ['a', 'b', 'c'],
      limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date('2026-08-08T00:00:00.000Z'), state: {},
    }, { executeSource, stdout: () => {} });
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('--limit を各Sourceへ同じ値で渡す', async () => {
    const limits: number[] = [];
    const executeSource = vi.fn(async (input) => {
      limits.push(input.options.limit);
      return outcome();
    });
    await runCollectionBatch({
      sourceIds: ['a', 'b'],
      limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date(), state: {},
    }, { executeSource, stdout: () => {} });
    expect(limits).toEqual([2, 2]);
  });

  it('--since を全Sourceへ同じ値で渡す', async () => {
    const sinces: Array<string | undefined> = [];
    const executeSource = vi.fn(async (input) => {
      sinces.push(input.options.since);
      return outcome();
    });
    await runCollectionBatch({
      sourceIds: ['a', 'b'],
      limit: 2, databaseId: DATABASE_ID, write: true, since: '2026-08-01',
      runStartedAt: new Date(), state: {},
    }, { executeSource, stdout: () => {} });
    expect(sinces).toEqual(['2026-08-01', '2026-08-01']);
  });

  it('--since 未指定なら options に含めない', async () => {
    let captured: Record<string, unknown> = {};
    const executeSource = vi.fn(async (input) => {
      captured = input.options as unknown as Record<string, unknown>;
      return outcome();
    });
    await runCollectionBatch({
      sourceIds: ['a'], limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date(), state: {},
    }, { executeSource, stdout: () => {} });
    expect('since' in captured).toBe(false);
  });

  it('1Source失敗しても次Sourceへ進む', async () => {
    const seen: string[] = [];
    const executeSource = vi.fn(async (input) => {
      seen.push(input.options.sourceId);
      if (input.options.sourceId === 'b') {
        return outcome({ report: null, exitCode: 1, failure: 'Source-level failure' });
      }
      return outcome();
    });
    const { report: batch, exitCode } = await runCollectionBatch({
      sourceIds: ['a', 'b', 'c'],
      limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date(), state: {},
    }, { executeSource, stdout: () => {} });

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(exitCode).toBe(1);
    expect(batch.outcomes[1]).toMatchObject({ state: 'Failed', reason: 'Source-level failure' });
    expect(batch.outcomes[2]?.state).toBe('Advanced');
  });

  it('前のSourceが進めた収集状態を次Sourceへ引き継ぐ', async () => {
    const seenStates: CollectionState[] = [];
    const executeSource = vi.fn(async (input) => {
      seenStates.push(input.state);
      return outcome({
        state: { ...input.state, [input.options.sourceId]: { last_successful_check_at: 'x' } },
      });
    });
    await runCollectionBatch({
      sourceIds: ['a', 'b'],
      limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date(), state: {},
    }, { executeSource, stdout: () => {} });

    expect(seenStates[0]).toEqual({});
    expect(seenStates[1]).toEqual({ a: { last_successful_check_at: 'x' } });
  });

  it('Sourceごとのstate結果をそのまま集計する', async () => {
    const executeSource = vi.fn(async (input) => (input.options.sourceId === 'a'
      ? outcome()
      : outcome({
        report: report({
          collectionState: { status: 'not_advanced', reason: 'Preview mode.' },
        }),
      })));
    const { report: batch } = await runCollectionBatch({
      sourceIds: ['a', 'b'],
      limit: 2, databaseId: DATABASE_ID, write: false,
      runStartedAt: new Date(), state: {},
    }, { executeSource, stdout: () => {} });

    expect(batch.outcomes[0]?.state).toBe('Advanced');
    expect(batch.outcomes[1]).toMatchObject({ state: 'Not advanced', reason: 'Preview mode.' });
  });

  it('Source区切りを表示する', async () => {
    const lines: string[] = [];
    await runCollectionBatch({
      sourceIds: ['a', 'b'],
      limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date(), state: {},
    }, { executeSource: vi.fn(async () => outcome()), stdout: (m) => lines.push(m) });

    expect(lines.join('\n')).toContain('===== [1/2] a =====');
    expect(lines.join('\n')).toContain('===== [2/2] b =====');
  });

  it('Source数が0でも例外にしない', async () => {
    const { report: batch, exitCode } = await runCollectionBatch({
      sourceIds: [], limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date(), state: {},
    }, { executeSource: vi.fn(), stdout: () => {} });
    expect(batch.sourcesSelected).toBe(0);
    expect(exitCode).toBe(0);
  });
});

describe('formatCollectionBatchSummary', () => {
  it('Sourceごとの結果と合計を表で出す', async () => {
    const executeSource = vi.fn(async (input) => {
      if (input.options.sourceId === 'src-a') {
        return {
          report: report({ results: duplicates(16), remainingNewCandidates: 0 }),
          state: {}, exitCode: 0 as const,
        };
      }
      return {
        report: report({
          results: [...created(2), ...duplicates(7)],
          remainingNewCandidates: 2,
          collectionState: { status: 'not_advanced' as const, reason: 'Unprocessed candidates remain because of --limit.' },
        }),
        state: {}, exitCode: 0 as const,
      };
    });
    const { report: batch } = await runCollectionBatch({
      sourceIds: ['src-a', 'src-b'],
      limit: 2, databaseId: DATABASE_ID, write: true,
      runStartedAt: new Date(), state: {},
    }, { executeSource, stdout: () => {} });

    const text = formatCollectionBatchSummary(batch);
    expect(text).toContain('Batch collection completed.');
    expect(text).toContain('Write');
    expect(text).toContain('Sources selected:');
    expect(text).toContain('Source');
    expect(text).toContain('src-a');
    expect(text).toContain('src-b');
    expect(text).toContain('Advanced');
    expect(text).toContain('Not advanced');
    expect(text).toContain('Created: 2');
    expect(text).toContain('Duplicates skipped: 23');
    expect(text).toContain('Failed: 0');
    expect(text).toContain('Remaining new candidates: 2');
  });

  it('Previewモードを表示する', () => {
    expect(formatCollectionBatchSummary({
      write: false, sourcesSelected: 1, outcomes: [],
      totals: { created: 0, previewed: 0, duplicates: 0, failed: 0, remaining: 0 },
    })).toContain('Preview');
  });
});

describe('runCollectionBatchCommand', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    loadRegistry: async () => REGISTRY,
    readState: async () => ({}),
    now: () => new Date('2026-08-08T00:00:00.000Z'),
    stdout: () => {},
    stderr: () => {},
    ...over,
  });

  it('選択されたSourceを実行しサマリーを出す', async () => {
    const lines: string[] = [];
    const executeSource = vi.fn(async () => ({
      report: report(), state: {}, exitCode: 0 as const,
    }));
    const exitCode = await runCollectionBatchCommand(
      ['--municipality', '名古屋市', '--database-url', DATABASE_URL, '--limit', '2'],
      deps({ executeSource, stdout: (m: string) => lines.push(m) }),
    );
    expect(exitCode).toBe(0);
    expect(executeSource).toHaveBeenCalledTimes(2);
    expect(lines.join('\n')).toContain('Batch collection completed.');
  });

  it('不明なSource IDは1件も実行せず終了する', async () => {
    const executeSource = vi.fn();
    const errors: string[] = [];
    const exitCode = await runCollectionBatchCommand(
      ['--sources', 'nope', '--database-url', DATABASE_URL],
      deps({ executeSource, stderr: (m: string) => errors.push(m) }),
    );
    expect(exitCode).toBe(1);
    expect(executeSource).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Source not found: nope');
  });

  it('CLI引数が不正なら1件も実行しない', async () => {
    const executeSource = vi.fn();
    const exitCode = await runCollectionBatchCommand(
      ['--database-url', DATABASE_URL],
      deps({ executeSource }),
    );
    expect(exitCode).toBe(1);
    expect(executeSource).not.toHaveBeenCalled();
  });

  it('database URLが不正なら1件も実行しない', async () => {
    const executeSource = vi.fn();
    const exitCode = await runCollectionBatchCommand(
      ['--all', '--database-url', 'https://example.com/not-a-notion-url'],
      deps({ executeSource }),
    );
    expect(exitCode).toBe(1);
    expect(executeSource).not.toHaveBeenCalled();
  });

  it('registryを読めなければ1件も実行しない', async () => {
    const executeSource = vi.fn();
    const exitCode = await runCollectionBatchCommand(
      ['--all', '--database-url', DATABASE_URL],
      deps({
        executeSource,
        loadRegistry: async () => { throw new Error('registry unreadable'); },
      }),
    );
    expect(exitCode).toBe(1);
    expect(executeSource).not.toHaveBeenCalled();
  });

  it('Previewでは write=false を各Sourceへ渡す', async () => {
    const writes: boolean[] = [];
    const executeSource = vi.fn(async (input) => {
      writes.push(input.options.write);
      return { report: report(), state: {}, exitCode: 0 as const };
    });
    await runCollectionBatchCommand(
      ['--all', '--database-url', DATABASE_URL],
      deps({ executeSource }),
    );
    expect(writes.every((value) => value === false)).toBe(true);
  });

  it('--write を各Sourceへ渡す', async () => {
    const writes: boolean[] = [];
    const executeSource = vi.fn(async (input) => {
      writes.push(input.options.write);
      return { report: report(), state: {}, exitCode: 0 as const };
    });
    await runCollectionBatchCommand(
      ['--all', '--database-url', DATABASE_URL, '--write'],
      deps({ executeSource }),
    );
    expect(writes.every((value) => value === true)).toBe(true);
  });

  it('全Sourceで同じ実行開始時刻を使う', async () => {
    const times: number[] = [];
    const executeSource = vi.fn(async (input) => {
      times.push(input.runStartedAt.getTime());
      return { report: report(), state: {}, exitCode: 0 as const };
    });
    await runCollectionBatchCommand(
      ['--all', '--database-url', DATABASE_URL],
      deps({ executeSource }),
    );
    expect(new Set(times).size).toBe(1);
  });
});

/** 集計は result.status しか見ないため、status だけを持つ最小のフィクスチャにする。 */
function resultsWithStatus(
  status: 'created' | 'duplicate',
  count: number,
): CollectionRunReport['results'] {
  return Array.from({ length: count }, (_value, index) => ({
    candidate: { url: `https://a.jp/${status}${index}`, title: 't', publishedAt: null },
    result: { status, officialUrl: `https://a.jp/${status}${index}`, warnings: [] },
  })) as unknown as CollectionRunReport['results'];
}

const created = (count: number): CollectionRunReport['results'] =>
  resultsWithStatus('created', count);
const duplicates = (count: number): CollectionRunReport['results'] =>
  resultsWithStatus('duplicate', count);
