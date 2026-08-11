import { describe, expect, it, vi } from 'vitest';
import {
  parseCollectionRunArgs,
  runCollection,
  type CollectionRunCommandDependencies,
} from '../src/commands/collection-run.ts';
import {
  filterCandidatesByPeriod,
  processCollectedCandidates,
} from '../src/collection-run/run.ts';
import { CollectionStateError } from '../src/collection-run/state.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../src/notion-check/types.ts';
import type {
  NotionRegistrationPreview,
  RegisterOneResult,
} from '../src/notion-register/types.ts';
import type { SourceCheckSample } from '../src/source-check/types.ts';
import { validateSourceRegistry } from '../src/source-registry/schema.ts';

const DATABASE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const URL_A = 'https://www.city.osaka.lg.jp/example/a.html';
const URL_B = 'https://www.city.osaka.lg.jp/example/b.html';
const URL_C = 'https://www.city.osaka.lg.jp/example/c.html';
const PAGE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PAGE_URL = 'https://www.notion.so/example-page';

describe('collect:run引数', () => {
  it('--sourceを受け取り、limitの初期値を5にする', () => {
    expect(parseCollectionRunArgs(args())).toEqual({
      sourceId: 'osaka-digital-rss',
      limit: 5,
      databaseId: DATABASE_ID,
      write: false,
    });
  });

  it.each(['1', '20'])('--limit %sを受理する', (limit) => {
    expect(parseCollectionRunArgs([...args(), '--limit', limit]).limit).toBe(Number(limit));
  });

  it.each(['0', '-1', '21', 'abc'])('--limit %sを拒否する', (limit) => {
    expect(() => parseCollectionRunArgs([...args(), '--limit', limit])).toThrow('--limit');
  });

  it('--sinceの有効な日付を受理し、不正形式と実在しない日付を拒否する', () => {
    expect(parseCollectionRunArgs([...args(), '--since', '2026-07-15']).since)
      .toBe('2026-07-15');
    expect(() => parseCollectionRunArgs([...args(), '--since', '2026/07/15']))
      .toThrow('--since');
    expect(() => parseCollectionRunArgs([...args(), '--since', '2026-02-30']))
      .toThrow('--since');
  });

  it('database URLとIDの同時指定を拒否する', () => {
    expect(() => parseCollectionRunArgs([
      ...args(),
      '--database-url', `https://notion.so/${DATABASE_ID.replaceAll('-', '')}`,
    ])).toThrow('not both');
  });
});

describe('候補の直列処理', () => {
  it('順番を保ち、新規候補だけへlimitを適用して直列処理する', async () => {
    const processed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const report = await processCollectedCandidates(
      {
        sourceId: 'osaka-digital-rss',
        candidates: [candidate(URL_A), candidate(URL_B), candidate(URL_C)],
        candidatesCollected: 4,
        uniqueCandidates: 3,
        effectiveSince: '2026-07-01',
        runStartedAt: '2026-08-07T12:00:00+09:00',
        limit: 2,
        write: false,
        checkDuplicate: async () => null,
        processor: async ({ url }) => {
        processed.push(url);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return previewed(url);
        },
      },
    );
    expect(processed).toEqual([URL_A, URL_B]);
    expect(maximumActive).toBe(1);
    expect(report.candidatesCollected).toBe(4);
    expect(report.uniqueCandidates).toBe(3);
    expect(report.processedNewCandidates).toBe(2);
    expect(report.remainingNewCandidates).toBe(1);
  });

  it('1件目の失敗後も2件目を処理し、失敗ステージを保持する', async () => {
    const processed: string[] = [];
    const report = await processCollectedCandidates(
      {
        sourceId: 'osaka-digital-rss',
        candidates: [candidate(URL_A), candidate(URL_B)],
        candidatesCollected: 2,
        uniqueCandidates: 2,
        effectiveSince: '2026-07-01',
        runStartedAt: '2026-08-07T12:00:00+09:00',
        limit: 5,
        write: false,
        checkDuplicate: async () => null,
        processor: async ({ url }) => {
        processed.push(url);
        return url === URL_A ? failed(url, 'ai_validation') : previewed(url);
        },
      },
    );
    expect(processed).toEqual([URL_A, URL_B]);
    expect(report.results.map(({ result }) => result.status)).toEqual(['failed', 'previewed']);
    expect(report.results[0]?.result).toMatchObject({ stage: 'ai_validation' });
  });
});

describe('collect:runコマンド', () => {
  it('既存Collectorを呼び、取得した候補を共通1件処理へ渡す', async () => {
    const collectCandidates = vi.fn(async () => [candidate(URL_A), candidate(URL_B)]);
    const registerOne = vi.fn(async (input) => previewed(input.officialUrl));
    const exitCode = await runCollection(args(), dependencies({
      collectCandidates,
      registerOne,
    }));
    expect(exitCode).toBe(0);
    expect(collectCandidates).toHaveBeenCalledTimes(1);
    expect(collectCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'osaka-digital-rss' }),
      expect.objectContaining({ id: 'osaka-city' }),
    );
    expect(registerOne.mock.calls.map(([input]) => input.officialUrl)).toEqual([URL_A, URL_B]);
  });

  it('候補0件を正常終了し、Notion接続と登録処理を開始しない', async () => {
    const createClient = vi.fn();
    const registerOne = vi.fn();
    const stdout: string[] = [];
    const exitCode = await runCollection(args(), dependencies({
      stdout,
      collectCandidates: async () => [],
      createClient,
      registerOne,
    }));
    expect(exitCode).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(registerOne).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('Candidates collected:\n0');
  });

  it('stateなしのPreviewは2026-07-01から開始し、stateを書かない', async () => {
    const stdout: string[] = [];
    const writeState = vi.fn();
    const exitCode = await runCollection(args(), dependencies({
      stdout,
      writeState,
      registerOne: async (input) => previewed(input.officialUrl),
    }));
    const output = stdout.join('\n');
    expect(exitCode).toBe(0);
    expect(output).toContain('Previous successful check:\nNone');
    expect(output).toContain('Initial collection since:\n2026-07-01');
    expect(output).toContain('Effective since:\n2026-07-01');
    expect(output).toContain('Collection state:\nNot advanced');
    expect(output).toContain('Reason:\nPreview mode.');
    expect(writeState).not.toHaveBeenCalled();
  });

  it('stateありでは3日前から開始する', async () => {
    const stdout: string[] = [];
    await runCollection(args(), dependencies({
      stdout,
      readState: async () => ({
        'osaka-digital-rss': {
          last_successful_check_at: '2026-08-05T09:00:00+09:00',
        },
      }),
      registerOne: async (input) => previewed(input.officialUrl),
    }));
    expect(stdout.join('\n')).toContain('Effective since:\n2026-08-02T09:00:00+09:00');
  });

  it('--sinceをstateより優先し、Writeでもstateを進めない', async () => {
    const stdout: string[] = [];
    const writeState = vi.fn();
    const exitCode = await runCollection(
      [...args(), '--since', '2026-07-15', '--write'],
      dependencies({
        stdout,
        readState: async () => ({
          'osaka-digital-rss': {
            last_successful_check_at: '2026-08-05T09:00:00+09:00',
          },
        }),
        writeState,
        registerOne: async (input) => created(input.officialUrl),
      }),
    );
    const output = stdout.join('\n');
    expect(exitCode).toBe(0);
    expect(output).toContain('Effective since:\n2026-07-15');
    expect(output).toContain('Reason:\nManual --since override was used.');
    expect(writeState).not.toHaveBeenCalled();
  });

  it('Collector失敗時はNotion接続と登録処理を開始しない', async () => {
    const createClient = vi.fn();
    const registerOne = vi.fn();
    const writeState = vi.fn();
    const exitCode = await runCollection(args(), dependencies({
      collectCandidates: async () => {
        throw new Error('fixture collector failure');
      },
      createClient,
      writeState,
      registerOne,
    }));
    expect(exitCode).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(registerOne).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('state読み取り失敗時はCollectorへ進まず明確なエラーを表示する', async () => {
    const collectCandidates = vi.fn();
    const stderr: string[] = [];
    const exitCode = await runCollection(args(), dependencies({
      stderr,
      collectCandidates,
      readState: async () => {
        throw new CollectionStateError('Failed to read collection state.\ninvalid JSON');
      },
      registerOne: vi.fn(),
    }));
    expect(exitCode).toBe(1);
    expect(collectCandidates).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('Failed to read collection state.');
    expect(stderr.join('\n')).toContain('invalid JSON');
  });

  it('Write成功時はrunStartedAtをstateへ保存する', async () => {
    const writeState = vi.fn(async () => undefined);
    const exitCode = await runCollection([...args(), '--write'], dependencies({
      writeState,
      registerOne: async (input) => created(input.officialUrl),
    }));
    expect(exitCode).toBe(0);
    expect(writeState).toHaveBeenCalledWith({
      'osaka-digital-rss': {
        last_successful_check_at: '2026-08-07T12:00:00+09:00',
      },
    });
  });

  it.each(['ai_analysis', 'notion_create'] as const)(
    '%s失敗時は後続を処理してstateを進めない',
    async (stage) => {
      const writeState = vi.fn();
      const registerOne = vi.fn(async (input) => input.officialUrl === URL_A
        ? failed(input.officialUrl, stage)
        : created(input.officialUrl));
      const exitCode = await runCollection([...args(), '--write'], dependencies({
        writeState,
        registerOne,
      }));
      expect(exitCode).toBe(1);
      expect(registerOne).toHaveBeenCalledTimes(2);
      expect(writeState).not.toHaveBeenCalled();
    },
  );

  it('Notion接続失敗時は候補処理とstate更新へ進まない', async () => {
    const registerOne = vi.fn();
    const writeState = vi.fn();
    const exitCode = await runCollection([...args(), '--write'], {
      ...dependencies({ registerOne, writeState }),
      checkConnection: async () => {
        throw new Error('fixture Notion connection failure');
      },
    });
    expect(exitCode).toBe(1);
    expect(registerOne).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });

  it('limit超過の未登録候補を数え、stateを進めない', async () => {
    const stdout: string[] = [];
    const writeState = vi.fn();
    const registerOne = vi.fn(async (input) => created(input.officialUrl));
    const exitCode = await runCollection(
      [...args(), '--limit', '2', '--write'],
      dependencies({
        stdout,
        writeState,
        collectCandidates: async () => [candidate(URL_A), candidate(URL_B), candidate(URL_C)],
        registerOne,
      }),
    );
    const output = stdout.join('\n');
    expect(exitCode).toBe(0);
    expect(registerOne).toHaveBeenCalledTimes(2);
    expect(output).toContain('New candidates found:\n3');
    expect(output).toContain('Processed new candidates:\n2');
    expect(output).toContain('Remaining new candidates:\n1');
    expect(output).toContain('Reason:\nUnprocessed candidates remain because of --limit.');
    expect(writeState).not.toHaveBeenCalled();
  });

  it('登録済み候補はlimitを消費せず、後続の未登録候補を処理する', async () => {
    const writeState = vi.fn(async () => undefined);
    const registerOne = vi.fn(async (input) => created(input.officialUrl));
    const exitCode = await runCollection(
      [...args(), '--limit', '2', '--write'],
      dependencies({
        createClient: () => client(new Set([URL_A])),
        writeState,
        collectCandidates: async () => [candidate(URL_A), candidate(URL_B), candidate(URL_C)],
        registerOne,
      }),
    );
    expect(exitCode).toBe(0);
    expect(registerOne.mock.calls.map(([input]) => input.officialUrl)).toEqual([URL_B, URL_C]);
    expect(writeState).toHaveBeenCalledTimes(1);
  });

  it('全件重複のWriteはHTML・PDF・Claude側の1件処理を呼ばずstateを進める', async () => {
    const registerOne = vi.fn();
    const writeState = vi.fn(async () => undefined);
    const exitCode = await runCollection([...args(), '--write'], dependencies({
      createClient: () => client(new Set([URL_A, URL_B])),
      registerOne,
      writeState,
    }));
    expect(exitCode).toBe(0);
    expect(registerOne).not.toHaveBeenCalled();
    expect(writeState).toHaveBeenCalledTimes(1);
  });

  it('候補0件のWriteはNotionへ接続せずstateを進める', async () => {
    const createClient = vi.fn();
    const writeState = vi.fn(async () => undefined);
    const exitCode = await runCollection([...args(), '--write'], dependencies({
      collectCandidates: async () => [],
      createClient,
      writeState,
      registerOne: vi.fn(),
    }));
    expect(exitCode).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(writeState).toHaveBeenCalledTimes(1);
  });

  it('日付不明候補を除外せず、警告して処理する', async () => {
    const stderr: string[] = [];
    const registerOne = vi.fn(async (input) => previewed(input.officialUrl));
    const exitCode = await runCollection(args(), dependencies({
      stderr,
      collectCandidates: async () => [{ ...candidate(URL_A), publishedAt: null }],
      registerOne,
    }));
    expect(exitCode).toBe(0);
    expect(registerOne).toHaveBeenCalledTimes(1);
    expect(stderr.join('\n')).toContain('Candidate publication date is unavailable.');
    expect(stderr.join('\n')).toContain(URL_A);
  });

  it('期間外の既知日付候補を除外する', async () => {
    const registerOne = vi.fn(async (input) => previewed(input.officialUrl));
    await runCollection(args(), dependencies({
      collectCandidates: async () => [
        { ...candidate(URL_A), publishedAt: '2026-06-30' },
        candidate(URL_B),
      ],
      registerOne,
    }));
    expect(registerOne.mock.calls.map(([input]) => input.officialUrl)).toEqual([URL_B]);
  });

  it.each([false, true])(
    'write=%sを共通1件処理へ渡し、previewed/createdを集計する',
    async (write) => {
      const stdout: string[] = [];
      const registerOne = vi.fn(async (input) => input.write
        ? created(input.officialUrl)
        : previewed(input.officialUrl));
      const exitCode = await runCollection(
        write ? [...args(), '--write'] : args(),
        dependencies({ stdout, registerOne }),
      );
      expect(exitCode).toBe(0);
      expect(registerOne).toHaveBeenCalledTimes(2);
      expect(registerOne.mock.calls.every(([input]) => input.write === write)).toBe(true);
      expect(stdout.join('\n')).toContain(write ? 'Created:\n2' : 'Previewed:\n2');
      expect(stdout.join('\n')).toContain(write ? 'Previewed:\n0' : 'Created:\n0');
    },
  );

  it('重複を正常スキップとして数え、候補タイトルと全スキップ表示を出す', async () => {
    const stdout: string[] = [];
    const exitCode = await runCollection(args(), dependencies({
      stdout,
      registerOne: async (input) => duplicate(input.officialUrl),
    }));
    const output = stdout.join('\n');
    expect(exitCode).toBe(0);
    expect(output).toContain('Title:\nCandidate A');
    expect(output).toContain('Content fetch:\nSkipped');
    expect(output).toContain('PDF extraction:\nSkipped');
    expect(output).toContain('Claude analysis:\nSkipped');
    expect(output).toContain('Registration:\nSkipped');
    expect(output).toContain('Duplicates skipped:\n2');
  });

  it('失敗後も継続し、ステージ、件数、終了コード1へ反映する', async () => {
    const stdout: string[] = [];
    const registerOne = vi.fn(async (input) => input.officialUrl === URL_A
      ? failed(input.officialUrl, 'notion_schema')
      : previewed(input.officialUrl));
    const exitCode = await runCollection(args(), dependencies({ stdout, registerOne }));
    const output = stdout.join('\n');
    expect(exitCode).toBe(1);
    expect(registerOne).toHaveBeenCalledTimes(2);
    expect(output).toContain('[2/2] Preview completed');
    expect(output).toContain('Failed:\n1');
    expect(output).toContain('Stage: notion_schema');
  });

  it('トークン、Claude入力、HTML・PDF本文を出力しない', async () => {
    const secrets = [
      'secret-NOTION_TOKEN',
      'full-Claude-input',
      'full-HTML-body',
      'full-PDF-body',
    ];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCollection(args(), dependencies({
      stdout,
      stderr,
      registerOne: async () => {
        throw new Error(secrets.join(' '));
      },
    }));
    expect(exitCode).toBe(1);
    const output = [...stdout, ...stderr].join('\n');
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

function candidate(url: string): SourceCheckSample {
  return {
    url,
    title: url === URL_A ? 'Candidate A' : url === URL_B ? 'Candidate B' : 'Candidate C',
    publishedAt: '2026-08-06',
  };
}

function previewed(url: string): RegisterOneResult {
  return {
    status: 'previewed',
    officialUrl: url,
    title: 'テスト案件',
    preview: preview(url),
    warnings: [],
  };
}

function created(url: string): RegisterOneResult {
  return {
    status: 'created',
    officialUrl: url,
    title: 'テスト案件',
    notionPageId: PAGE_ID,
    notionPageUrl: PAGE_URL,
    preview: preview(url),
    warnings: [],
  };
}

function duplicate(url: string): RegisterOneResult {
  return {
    status: 'duplicate',
    officialUrl: url,
    existingPageId: PAGE_ID,
    existingPageUrl: PAGE_URL,
    phase: 'preflight',
    warnings: [],
  };
}

function failed(
  url: string,
  stage: 'ai_analysis' | 'ai_validation' | 'notion_schema' | 'notion_create',
): RegisterOneResult {
  return {
    status: 'failed',
    officialUrl: url,
    stage,
    message: 'safe fixture failure',
    configurationError: false,
    warnings: [],
  };
}

function preview(url: string): NotionRegistrationPreview {
  return {
    values: {
      title: 'テスト案件',
      officialUrl: url,
      organizationName: '大阪市',
      sourceName: 'デジタル統括室 RSS',
      target: '対象',
      documentType: 'RFI',
      problem: '課題',
      desiredState: '状態',
      requestToPrivateSector: '依頼',
      categories: ['行政DX'],
      companyRelevance: 'B',
      contactRecommendation: '高',
      reason: '理由',
      evidence: '根拠',
      confirmationStatus: '未確認',
    },
    missingOptions: [],
  } as unknown as NotionRegistrationPreview;
}

function registry() {
  return validateSourceRegistry({
    version: 1,
    organizations: [{
      id: 'osaka-city',
      name: '大阪市',
      organization_type: 'designated_city',
      official_domain: 'city.osaka.lg.jp',
      enabled: true,
    }],
    sources: [{
      id: 'osaka-digital-rss',
      organization_id: 'osaka-city',
      name: 'デジタル統括室 RSS',
      url: 'https://www.city.osaka.lg.jp/rss.xml',
      collector_type: 'rss',
      source_category: 'digital_news',
      priority: 'high',
      enabled: true,
    }],
  });
}

function notionReport(): NotionConnectionReport {
  return {
    databaseName: '行政ニーズ',
    databaseId: DATABASE_ID,
    dataSources: [{ name: '行政ニーズ', id: 'data-source', properties: [] }],
  };
}

function client(duplicateUrls = new Set<string>()): NotionRegistrationClient {
  return {
    retrieveDatabase: async () => ({}),
    retrieveDataSource: async () => ({}),
    queryDataSourceByUrl: async (_dataSourceId, _propertyName, url) => ({
      object: 'list',
      results: duplicateUrls.has(url)
        ? [{ object: 'page', id: PAGE_ID, url: PAGE_URL }]
        : [],
    }),
    createPage: async () => ({ object: 'page', id: PAGE_ID, url: PAGE_URL }),
  };
}

function args(): string[] {
  return [
    '--source', 'osaka-digital-rss',
    '--database-id', DATABASE_ID,
  ];
}

function dependencies(options: {
  stdout?: string[];
  stderr?: string[];
  collectCandidates?: NonNullable<CollectionRunCommandDependencies['collectCandidates']>;
  createClient?: NonNullable<CollectionRunCommandDependencies['createClient']>;
  readState?: NonNullable<CollectionRunCommandDependencies['readState']>;
  writeState?: NonNullable<CollectionRunCommandDependencies['writeState']>;
  registerOne: NonNullable<CollectionRunCommandDependencies['registerOne']>;
}): CollectionRunCommandDependencies {
  return {
    env: { NOTION_TOKEN: 'test-token' },
    loadEnvironment: () => undefined,
    loadRegistry: async () => registry(),
    now: () => new Date('2026-08-07T03:00:00.000Z'),
    readState: options.readState ?? (async () => ({})),
    writeState: options.writeState ?? (async () => undefined),
    collectCandidates: options.collectCandidates
      ?? (async () => [candidate(URL_A), candidate(URL_B)]),
    createClient: options.createClient ?? (() => client()),
    checkConnection: async () => notionReport(),
    registerOne: options.registerOne,
    stdout: (message: string) => options.stdout?.push(message),
    stderr: (message: string) => options.stderr?.push(message),
  };
}

describe('Sourceごとのinitial_since', () => {
  it('stateなしのWriteでinitial_sinceを初回開始日に使い、完全成功ならstateを進める', async () => {
    const stdout: string[] = [];
    const writeState = vi.fn(async () => undefined);
    const exitCode = await runCollection([...args(), '--write'], {
      ...dependencies({
        stdout,
        writeState,
        registerOne: async (input) => created(input.officialUrl),
      }),
      loadRegistry: async () => registryWithInitialSince('2026-08-01'),
    });

    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('Initial collection since:\n2026-08-01');
    expect(stdout.join('\n')).toContain('Effective since:\n2026-08-01');
    expect(writeState).toHaveBeenCalledWith({
      'osaka-digital-rss': { last_successful_check_at: '2026-08-07T12:00:00+09:00' },
    });
  });

  it('initial_since未指定の既存Sourceは初回開始日を2026-07-01のままにする', async () => {
    const stdout: string[] = [];
    await runCollection(args(), dependencies({
      stdout,
      registerOne: async (input) => previewed(input.officialUrl),
    }));

    expect(stdout.join('\n')).toContain('Initial collection since:\n2026-07-01');
    expect(stdout.join('\n')).toContain('Effective since:\n2026-07-01');
  });

  it('3日前がinitial_sinceより後ならその3日前から開始する', async () => {
    const stdout: string[] = [];
    await runCollection(args(), {
      ...dependencies({
        stdout,
        registerOne: async (input) => previewed(input.officialUrl),
      }),
      loadRegistry: async () => registryWithInitialSince('2026-08-01'),
      readState: async () => ({
        'osaka-digital-rss': { last_successful_check_at: '2026-08-05T09:00:00+09:00' },
      }),
    });

    expect(stdout.join('\n')).not.toContain('Initial collection since:');
    expect(stdout.join('\n')).toContain('Effective since:\n2026-08-02T09:00:00+09:00');
  });

  it('3日前がinitial_sinceより前ならinitial_sinceを自動収集の下限として使う', async () => {
    const stdout: string[] = [];
    await runCollection(args(), {
      ...dependencies({
        stdout,
        registerOne: async (input) => previewed(input.officialUrl),
      }),
      loadRegistry: async () => registryWithInitialSince('2026-08-01'),
      readState: async () => ({
        'osaka-digital-rss': { last_successful_check_at: '2026-08-02T09:00:00+09:00' },
      }),
    });

    expect(stdout.join('\n')).toContain('Effective since:\n2026-08-01T00:00:00+09:00');
  });

  it('--sinceはinitial_sinceより優先され、stateを進めない', async () => {
    const stdout: string[] = [];
    const writeState = vi.fn();
    await runCollection([...args(), '--since', '2026-07-15', '--write'], {
      ...dependencies({
        stdout,
        writeState,
        registerOne: async (input) => created(input.officialUrl),
      }),
      loadRegistry: async () => registryWithInitialSince('2026-08-01'),
    });

    expect(stdout.join('\n')).toContain('Effective since:\n2026-07-15');
    expect(writeState).not.toHaveBeenCalled();
  });
});

function registryWithInitialSince(initialSince: string) {
  return validateSourceRegistry({
    version: 1,
    organizations: [{
      id: 'osaka-city',
      name: '大阪市',
      organization_type: 'designated_city',
      official_domain: 'city.osaka.lg.jp',
      enabled: true,
    }],
    sources: [{
      id: 'osaka-digital-rss',
      organization_id: 'osaka-city',
      name: 'デジタル統括室 RSS',
      url: 'https://www.city.osaka.lg.jp/rss.xml',
      collector_type: 'rss',
      source_category: 'digital_news',
      priority: 'high',
      enabled: true,
      initial_since: initialSince,
    }],
  });
}

describe('公開日が未来の候補', () => {
  const RUN_STARTED_AT = '2026-08-07T12:00:00+09:00';
  const SINCE = '2026-07-01';

  it('実行開始時刻より後の日付は除外せず掲載日不明として処理へ回す', () => {
    const selection = filterCandidatesByPeriod(
      [{ url: URL_A, title: '【令和8年8月21日申込締切】公募型プロポーザル', publishedAt: '2026-08-21' }],
      SINCE,
      RUN_STARTED_AT,
    );

    expect(selection.candidates.map(({ url }) => url)).toEqual([URL_A]);
    expect(selection.unknownDateCandidates.map(({ url }) => url)).toEqual([URL_A]);
  });

  it('タイムスタンプ形式の未来日も掲載日不明として扱う', () => {
    const selection = filterCandidatesByPeriod(
      [{ url: URL_A, title: 'A', publishedAt: '2026-09-01T09:00:00+09:00' }],
      SINCE,
      RUN_STARTED_AT,
    );

    expect(selection.candidates.map(({ url }) => url)).toEqual([URL_A]);
    expect(selection.unknownDateCandidates.map(({ url }) => url)).toEqual([URL_A]);
  });

  it('期間より前の過去日は従来どおり除外する', () => {
    const selection = filterCandidatesByPeriod(
      [{ url: URL_A, title: 'A', publishedAt: '2026-06-30' }],
      SINCE,
      RUN_STARTED_AT,
    );

    expect(selection.candidates).toEqual([]);
    expect(selection.unknownDateCandidates).toEqual([]);
  });

  it('期間内の候補は掲載日不明にせず従来どおり通す', () => {
    const selection = filterCandidatesByPeriod(
      [{ url: URL_A, title: 'A', publishedAt: '2026-08-06' }],
      SINCE,
      RUN_STARTED_AT,
    );

    expect(selection.candidates.map(({ url }) => url)).toEqual([URL_A]);
    expect(selection.unknownDateCandidates).toEqual([]);
  });
});
