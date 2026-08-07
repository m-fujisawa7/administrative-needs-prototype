import { describe, expect, it, vi } from 'vitest';
import {
  parseCollectionRunArgs,
  runCollection,
  type CollectionRunCommandDependencies,
} from '../src/commands/collection-run.ts';
import { processCollectedCandidates } from '../src/collection-run/run.ts';
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

  it('database URLとIDの同時指定を拒否する', () => {
    expect(() => parseCollectionRunArgs([
      ...args(),
      '--database-url', `https://notion.so/${DATABASE_ID.replaceAll('-', '')}`,
    ])).toThrow('not both');
  });
});

describe('候補の直列処理', () => {
  it('順番を保ち、同じURLを除外してからlimitを適用する', async () => {
    const processed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const report = await processCollectedCandidates(
      'osaka-digital-rss',
      [candidate(URL_A), candidate(URL_A), candidate(URL_B), candidate(URL_C)],
      2,
      false,
      async ({ url }) => {
        processed.push(url);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return previewed(url);
      },
    );
    expect(processed).toEqual([URL_A, URL_B]);
    expect(maximumActive).toBe(1);
    expect(report.candidatesCollected).toBe(4);
    expect(report.uniqueCandidates).toBe(2);
  });

  it('1件目の失敗後も2件目を処理し、失敗ステージを保持する', async () => {
    const processed: string[] = [];
    const report = await processCollectedCandidates(
      'osaka-digital-rss',
      [candidate(URL_A), candidate(URL_B)],
      5,
      false,
      async ({ url }) => {
        processed.push(url);
        return url === URL_A ? failed(url, 'ai_validation') : previewed(url);
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
      5,
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

  it('Collector失敗時はNotion接続と登録処理を開始しない', async () => {
    const createClient = vi.fn();
    const registerOne = vi.fn();
    const exitCode = await runCollection(args(), dependencies({
      collectCandidates: async () => {
        throw new Error('fixture collector failure');
      },
      createClient,
      registerOne,
    }));
    expect(exitCode).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(registerOne).not.toHaveBeenCalled();
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
  stage: 'ai_validation' | 'notion_schema',
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

function client(): NotionRegistrationClient {
  return {
    retrieveDatabase: async () => ({}),
    retrieveDataSource: async () => ({}),
    queryDataSourceByUrl: async () => ({ object: 'list', results: [] }),
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
  registerOne: NonNullable<CollectionRunCommandDependencies['registerOne']>;
}): CollectionRunCommandDependencies {
  return {
    env: { NOTION_TOKEN: 'test-token' },
    loadEnvironment: () => undefined,
    loadRegistry: async () => registry(),
    collectCandidates: options.collectCandidates
      ?? (async () => [candidate(URL_A), candidate(URL_B)]),
    createClient: options.createClient ?? (() => client()),
    checkConnection: async () => notionReport(),
    registerOne: options.registerOne,
    stdout: (message: string) => options.stdout?.push(message),
    stderr: (message: string) => options.stderr?.push(message),
  };
}
