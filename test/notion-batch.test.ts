import { describe, expect, it, vi } from 'vitest';
import {
  parseNotionBatchArgs,
  runNotionBatch,
  type NotionBatchCommandDependencies,
} from '../src/commands/notion-batch.ts';
import { processSelectedUrls } from '../src/notion-batch/batch.ts';
import { NotionBatchConfigurationError } from '../src/notion-batch/errors.ts';
import {
  parseSelectedUrls,
  readSelectedUrlFile,
} from '../src/notion-batch/input.ts';
import type {
  ParsedSelectedUrls,
} from '../src/notion-batch/types.ts';
import { registerOneAdministrativeNeed } from '../src/notion-register/register-one.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../src/notion-check/types.ts';
import type {
  NotionRegistrationPreview,
  RegisterOneResult,
} from '../src/notion-register/types.ts';
import { validateSourceRegistry } from '../src/source-registry/schema.ts';

const DATABASE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const URL_A = 'https://www.city.osaka.lg.jp/example/a.html';
const URL_B = 'http://www.city.osaka.lg.jp/example/b.html';
const PAGE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PAGE_URL = 'https://www.notion.so/example-page';

describe('選定URLファイル解析', () => {
  it('1行1URLを読み、空行・コメントを無視して前後空白を除去する', () => {
    const parsed = parseSelectedUrls([
      '# comment',
      `  ${URL_A}  `,
      '',
      `\t${URL_B}\t`,
    ].join('\n'));
    expect(parsed).toEqual({
      entries: [
        { officialUrl: URL_A, inputDuplicate: false },
        { officialUrl: URL_B, inputDuplicate: false },
      ],
      uniqueUrlCount: 2,
    });
  });

  it('同じURLの2回目以降を入力内重複として保持する', () => {
    expect(parseSelectedUrls(`${URL_A}\n${URL_A}`)).toEqual({
      entries: [
        { officialUrl: URL_A, inputDuplicate: false },
        { officialUrl: URL_A, inputDuplicate: true },
      ],
      uniqueUrlCount: 1,
    });
  });

  it.each(['not-a-url', 'file:///tmp/example.html'])(
    '不正またはHTTP以外のURL「%s」を拒否する',
    (url) => {
      expect(() => parseSelectedUrls(url)).toThrow('HTTP or HTTPS');
    },
  );

  it('URLが0件または20件超なら処理前に拒否する', () => {
    expect(() => parseSelectedUrls('\n# comment\n')).toThrow('any URLs');
    const tooMany = Array.from(
      { length: 21 },
      (_, index) => `https://example.com/${index}`,
    ).join('\n');
    expect(() => parseSelectedUrls(tooMany)).toThrow('at most 20');
  });

  it('ファイルが存在しない場合は安全な設定エラーにする', async () => {
    await expect(readSelectedUrlFile('/missing/selected-urls.txt', async () => {
      throw new Error('ENOENT fixture detail');
    })).rejects.toThrow(NotionBatchConfigurationError);
  });
});

describe('直列バッチ処理', () => {
  it('1件目の完了後に2件目を開始し、並列実行しない', async () => {
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    await processSelectedUrls(parsed(), false, async (url) => {
      events.push(`start:${url}`);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      events.push(`end:${url}`);
      return previewed(url);
    });
    expect(maximumActive).toBe(1);
    expect(events).toEqual([
      `start:${URL_A}`,
      `end:${URL_A}`,
      `start:${URL_B}`,
      `end:${URL_B}`,
    ]);
  });

  it('1件目が失敗しても2件目を処理し、失敗ステージを保持する', async () => {
    const processed: string[] = [];
    const report = await processSelectedUrls(parsed(), false, async (url) => {
      processed.push(url);
      return url === URL_A ? failed(url, 'ai_validation') : previewed(url);
    });
    expect(processed).toEqual([URL_A, URL_B]);
    expect(report.results.map((result) => result.status)).toEqual(['failed', 'previewed']);
    expect(report.results[0]).toMatchObject({ stage: 'ai_validation' });
  });

  it('入力内重複ではProcessorを呼ばない', async () => {
    const processor = vi.fn(async (url: string) => previewed(url));
    const report = await processSelectedUrls(
      parseSelectedUrls(`${URL_A}\n${URL_A}`),
      false,
      processor,
    );
    expect(processor).toHaveBeenCalledTimes(1);
    expect(report.results[1]?.status).toBe('input_duplicate');
  });
});

describe('共通1件処理の重複スキップ', () => {
  it('Notion重複時は分析Context・HTML/PDF/Claude・ページ作成を呼ばない', async () => {
    const loadAnalysisContext = vi.fn();
    const checkNeed = vi.fn();
    const createPage = vi.fn();
    const result = await registerOneAdministrativeNeed({
      source: registry().sources[0]!,
      organization: registry().organizations[0]!,
      officialUrl: URL_A,
      write: true,
      client: client({ duplicate: true, createPage }),
      report: notionReport(),
      limits: { htmlCharacters: 1_000, pdfCharacters: 1_000, maxPdfs: 3 },
    }, {
      loadAnalysisContext,
      checkNeed,
    });
    expect(result.status).toBe('duplicate');
    expect(loadAnalysisContext).not.toHaveBeenCalled();
    expect(checkNeed).not.toHaveBeenCalled();
    expect(createPage).not.toHaveBeenCalled();
  });
});

describe('notion:batchコマンド', () => {
  it('必須引数とdatabase指定を検証する', () => {
    expect(parseNotionBatchArgs(args())).toMatchObject({
      sourceId: 'osaka-digital-rss',
      file: './data/selected-urls.txt',
      databaseId: DATABASE_ID,
      write: false,
    });
    expect(() => parseNotionBatchArgs([
      ...args(),
      '--database-url', `https://notion.so/${DATABASE_ID.replaceAll('-', '')}`,
    ])).toThrow('not both');
  });

  it.each([false, true])(
    'write=%sを共通1件処理へ渡し、previewed/createdを集計する',
    async (write) => {
      const create = vi.fn();
      const stdout: string[] = [];
      const exitCode = await runNotionBatch(
        write ? [...args(), '--write'] : args(),
        commandDependencies({
          stdout,
          registerOne: async (input) => {
            create(input.write);
            return input.write ? created(input.officialUrl) : previewed(input.officialUrl);
          },
        }),
      );
      expect(exitCode).toBe(0);
      expect(create).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledWith(write);
      expect(stdout.join('\n')).toContain(write ? 'Created:\n2' : 'Previewed:\n2');
    },
  );

  it('失敗後も継続し、サマリと終了コード1へ反映する', async () => {
    const stdout: string[] = [];
    const exitCode = await runNotionBatch(args(), commandDependencies({
      stdout,
      registerOne: async (input) => input.officialUrl === URL_A
        ? failed(input.officialUrl, 'notion_schema')
        : previewed(input.officialUrl),
    }));
    expect(exitCode).toBe(1);
    expect(stdout.join('\n')).toContain('Failed:\n1');
    expect(stdout.join('\n')).toContain('Stage: notion_schema');
    expect(stdout.join('\n')).toContain('[2/2] Preview completed');
  });

  it('item ごとにClaudeへ渡した入力量を表示する', async () => {
    const stdout: string[] = [];
    await runNotionBatch(args(), commandDependencies({
      stdout,
      registerOne: async (input) => ({
        ...previewed(input.officialUrl),
        inputSummary: {
          htmlOriginalCharacters: 900,
          htmlSentCharacters: 900,
          pdfDiscovered: 2,
          pdfAttempted: 1,
          pdfIncluded: 1,
          pdfOriginalCharacters: 3_100,
          pdfSentCharacters: 3_100,
          totalSourceCharacters: 4_000,
          pdfInputs: [{ label: '公募要領', url: 'https://example.lg.jp/a.pdf', characters: 3_100, extractedCharacters: 3_100, strategy: 'full' as const, chunkCount: 1 }],
          pdfSkipped: [{ label: '様式1 参加申込書', url: 'https://example.lg.jp/b.pdf' }],
        },
      }),
    }));
    const output = stdout.join('\n');
    expect(output).toContain('AI input:');
    expect(output).toContain('Total source characters: 4000');
    expect(output).toContain('- 公募要領: 3100 chars');
    expect(output).toContain('- 様式1 参加申込書');
  });

  it('入力ファイルエラー時はNotionやAnalyzerへ進まない', async () => {
    const createClient = vi.fn();
    const analyzerFactory = vi.fn();
    const exitCode = await runNotionBatch(args(), {
      readSelectedUrls: async () => {
        throw new NotionBatchConfigurationError('fixture input error');
      },
      createClient,
      analyzerFactory,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(exitCode).toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(analyzerFactory).not.toHaveBeenCalled();
  });

  it('トークンやClaude入力相当の予期しないエラー内容を出力しない', async () => {
    const secret = 'secret-NOTION_TOKEN-and-full-Claude-input';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runNotionBatch(args(), commandDependencies({
      stdout,
      stderr,
      registerOne: async () => {
        throw new Error(secret);
      },
    }));
    expect(exitCode).toBe(1);
    expect(stdout.join('\n')).not.toContain(secret);
    expect(stderr.join('\n')).not.toContain(secret);
  });
});

function parsed(): ParsedSelectedUrls {
  return parseSelectedUrls(`${URL_A}\n${URL_B}`);
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

function client(options: {
  duplicate?: boolean;
  createPage?: () => void;
} = {}): NotionRegistrationClient {
  return {
    retrieveDatabase: async () => ({}),
    retrieveDataSource: async () => ({}),
    queryDataSourceByUrl: async () => ({
      object: 'list',
      results: options.duplicate
        ? [{ object: 'page', id: PAGE_ID, url: PAGE_URL }]
        : [],
    }),
    createPage: async () => {
      options.createPage?.();
      return { object: 'page', id: PAGE_ID, url: PAGE_URL };
    },
  };
}

function args(): string[] {
  return [
    '--source', 'osaka-digital-rss',
    '--file', './data/selected-urls.txt',
    '--database-id', DATABASE_ID,
  ];
}

function commandDependencies(options: {
  stdout?: string[];
  stderr?: string[];
  registerOne: NonNullable<NotionBatchCommandDependencies['registerOne']>;
}) {
  return {
    env: { NOTION_TOKEN: 'test-token' },
    readSelectedUrls: async () => parsed(),
    loadEnvironment: () => undefined,
    loadRegistry: async () => registry(),
    createClient: () => client(),
    checkConnection: async () => notionReport(),
    registerOne: options.registerOne,
    stdout: (message: string) => options.stdout?.push(message),
    stderr: (message: string) => options.stderr?.push(message),
  };
}
