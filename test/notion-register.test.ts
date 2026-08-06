import { describe, expect, it } from 'vitest';
import type { AdministrativeNeedAnalyzer, AiCheckResult } from '../src/ai/types.ts';
import {
  parseNotionRegisterArgs,
  runNotionRegister,
} from '../src/commands/notion-register.ts';
import {
  buildNotionPageProperties,
  mapAnalysisToNotionValues,
} from '../src/notion-register/mapping.ts';
import {
  createNotionRegistrationPage,
  findExistingNotionPage,
  prepareNotionRegistration,
} from '../src/notion-register/registration.ts';
import {
  EXPECTED_NOTION_PROPERTIES,
  findMissingNotionOptions,
  selectRegistrationDataSource,
  validateRegistrationSchema,
} from '../src/notion-register/schema.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../src/notion-check/types.ts';
import { validateSourceRegistry } from '../src/source-registry/schema.ts';

const DATABASE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const DATA_SOURCE_ID = '11111111-2222-3333-4444-555555555555';
const PAGE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OFFICIAL_URL = 'https://www.city.osaka.lg.jp/example.html';
const NOTION_PAGE_URL = 'https://www.notion.so/example-page';

describe('Notionプロパティ変換', () => {
  it('対象判定、文書種別、自社関連度、推奨度、確認状態を変換する', () => {
    const values = mapAnalysisToNotionValues(result());
    expect(values.target).toBe('対象');
    expect(values.documentType).toBe('RFI');
    expect(values.companyRelevance).toBe('B');
    expect(values.contactRecommendation).toBe('高');
    expect(values.confirmationStatus).toBe('未確認');
  });

  it('対象外判定と対象外確認状態を変換する', () => {
    const analysisResult = result();
    analysisResult.analysis.is_target = false;
    analysisResult.analysis.company_relevance = 'out_of_scope';
    analysisResult.analysis.contact_recommendation = 'none';
    const values = mapAnalysisToNotionValues(analysisResult);
    expect(values.target).toBe('対象外');
    expect(values.companyRelevance).toBe('対象外');
    expect(values.contactRecommendation).toBe('不要');
    expect(values.confirmationStatus).toBe('対象外');
  });

  it('カテゴリを日本語multi_select名へ変換し、根拠引用を連結する', () => {
    const values = mapAnalysisToNotionValues(result());
    expect(values.categories).toEqual(['行政DX', 'UI・UX']);
    expect(values.evidence).toBe('・引用1\n・引用2');
    expect(buildNotionPageProperties(values).分野).toEqual({
      multi_select: [{ name: '行政DX' }, { name: 'UI・UX' }],
    });
  });

  it('未定義の文書種別をその他へ丸めず拒否する', () => {
    const analysisResult = result();
    analysisResult.analysis.document_type = 'unknown' as unknown as 'rfi';
    expect(() => mapAnalysisToNotionValues(analysisResult)).toThrow(
      'Unsupported document_type',
    );
  });

  it('created_timeへ値を送らず、長いrich_textを分割する', () => {
    const values = mapAnalysisToNotionValues(result());
    values.reason = 'あ'.repeat(2_001);
    const properties = buildNotionPageProperties(values);
    expect(properties).not.toHaveProperty('登録日時');
    expect(properties.判断理由).toMatchObject({
      rich_text: [
        { text: { content: 'あ'.repeat(2_000) } },
        { text: { content: 'あ' } },
      ],
    });
  });
});

describe('Notion登録スキーマ検証', () => {
  it('正しいスキーマを受理する', () => {
    expect(() => validateRegistrationSchema(report().dataSources[0]!)).not.toThrow();
  });

  it('必須プロパティ不足と型違いを具体的に検出する', () => {
    const dataSource = report().dataSources[0]!;
    dataSource.properties = dataSource.properties.filter((property) => property.name !== '案件名');
    dataSource.properties.find((property) => property.name === '公式URL')!.type = 'rich_text';
    expect(() => validateRegistrationSchema(dataSource)).toThrow('案件名: expected title, actual missing');
    expect(() => validateRegistrationSchema(dataSource)).toThrow(
      '公式URL: expected url, actual rich_text',
    );
  });

  it('複数データソースを拒否する', () => {
    const connectionReport = report();
    connectionReport.dataSources.push({
      ...connectionReport.dataSources[0]!,
      id: '22222222-3333-4444-5555-666666666666',
      name: '別データソース',
    });
    expect(() => selectRegistrationDataSource(connectionReport)).toThrow(
      'Multiple data sources were found.',
    );
  });

  it('既存にないselect・multi_select選択肢を検出する', () => {
    const dataSource = report().dataSources[0]!;
    const category = dataSource.properties.find((property) => property.name === '分野')!;
    category.options = [];
    expect(findMissingNotionOptions(dataSource, mapAnalysisToNotionValues(result())))
      .toEqual([
        { propertyName: '分野', optionName: '行政DX' },
        { propertyName: '分野', optionName: 'UI・UX' },
      ]);
  });
});

describe('重複確認と作成', () => {
  it('同一公式URLがなければ登録可能', async () => {
    expect(await findExistingNotionPage(client(), DATA_SOURCE_ID, OFFICIAL_URL)).toBeNull();
  });

  it('同一公式URLがあればページIDとURLを返す', async () => {
    expect(await findExistingNotionPage(
      client({ duplicate: true }),
      DATA_SOURCE_ID,
      OFFICIAL_URL,
    )).toEqual({ id: PAGE_ID, url: NOTION_PAGE_URL });
  });

  it('重複時にページ作成を呼ばない', async () => {
    let createCalls = 0;
    const notionClient = client({
      duplicate: true,
      onCreate: () => { createCalls += 1; },
    });
    const preview = await prepareNotionRegistration(
      notionClient,
      report(),
      result(),
      true,
    );
    await expect(createNotionRegistrationPage(notionClient, preview)).rejects.toThrow(
      'same official URL',
    );
    expect(createCalls).toBe(0);
  });
});

describe('notion:registerコマンド', () => {
  it('引数を解析し、URLとIDの同時指定を拒否する', () => {
    expect(parseNotionRegisterArgs(args())).toMatchObject({
      sourceId: 'osaka-digital-rss',
      databaseId: DATABASE_ID,
      write: false,
    });
    expect(() => parseNotionRegisterArgs([
      ...args().slice(0, -2),
      '--database-url', `https://notion.so/${DATABASE_ID.replaceAll('-', '')}`,
      '--database-id', DATABASE_ID,
    ])).toThrow('not both');
  });

  it('デフォルトではページ作成を呼ばない', async () => {
    let createCalls = 0;
    const stdout: string[] = [];
    const exitCode = await runNotionRegister(args(), dependencies({
      stdout,
      onCreate: () => { createCalls += 1; },
    }));
    expect(exitCode).toBe(0);
    expect(createCalls).toBe(0);
    expect(stdout.join('\n')).toContain('Write mode:\nDisabled');
    expect(stdout.join('\n')).toContain('No data was written.');
  });

  it('--write指定時だけ1件作成し、ページIDとURLを表示する', async () => {
    let createCalls = 0;
    const stdout: string[] = [];
    const exitCode = await runNotionRegister([...args(), '--write'], dependencies({
      stdout,
      onCreate: () => { createCalls += 1; },
    }));
    expect(exitCode).toBe(0);
    expect(createCalls).toBe(1);
    expect(stdout.join('\n')).toContain(`Notion page ID:\n${PAGE_ID}`);
    expect(stdout.join('\n')).toContain(`Notion page URL:\n${NOTION_PAGE_URL}`);
  });

  it('Mock解析の--writeを拒否する', async () => {
    const stderr: string[] = [];
    const exitCode = await runNotionRegister([...args(), '--write'], {
      ...dependencies({ stderr }),
      analyzerFactory: () => ({
        provider: 'mock',
        model: 'mock-v1',
        analyze: async () => result().analysis,
      }),
    });
    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toContain('Mock analysis cannot be registered.');
  });

  it('不足選択肢がある場合は--writeでも作成しない', async () => {
    let createCalls = 0;
    const stderr: string[] = [];
    const unsafeReport = report();
    unsafeReport.dataSources[0]!.properties
      .find((property) => property.name === '分野')!.options = [];
    const exitCode = await runNotionRegister([...args(), '--write'], {
      ...dependencies({
        stderr,
        onCreate: () => { createCalls += 1; },
      }),
      checkConnection: async () => unsafeReport,
    });
    expect(exitCode).toBe(1);
    expect(createCalls).toBe(0);
    expect(stderr.join('\n')).toContain('would change the data source schema');
  });

  it('予期しないエラー出力へトークンを含めない', async () => {
    const token = 'secret-test-token-value';
    const stderr: string[] = [];
    const exitCode = await runNotionRegister(args(), {
      ...dependencies({ stderr, token }),
      createClient: () => {
        throw new Error(`unsafe ${token}`);
      },
    });
    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).not.toContain(token);
  });
});

function result(): AiCheckResult {
  return {
    sourceId: 'osaka-digital-rss',
    sourceName: 'デジタル統括室 RSS',
    organizationName: '大阪市',
    title: 'テストRFI',
    requestedUrl: OFFICIAL_URL,
    officialUrl: OFFICIAL_URL,
    provider: 'claude_cli',
    model: null,
    analysis: {
      is_target: true,
      document_type: 'rfi',
      problem_summary: '行政課題',
      desired_state: '実現したい状態',
      request_to_private_sector: '民間への依頼',
      categories: ['administrative_dx', 'ui_ux'],
      company_relevance: 'B',
      contact_recommendation: 'high',
      reason: '判断理由',
      evidence_quotes: [
        { source_type: 'html', source_url: OFFICIAL_URL, quote: '引用1' },
        { source_type: 'html', source_url: OFFICIAL_URL, quote: '引用2' },
      ],
    },
    inputSummary: {
      htmlOriginalCharacters: 100,
      htmlSentCharacters: 100,
      pdfDiscovered: 0,
      pdfAttempted: 0,
      pdfIncluded: 0,
      pdfOriginalCharacters: 0,
      pdfSentCharacters: 0,
    },
    evidenceMatched: 2,
    warnings: [],
  };
}

function report(): NotionConnectionReport {
  const selectOptions: Record<string, string[]> = {
    対象判定: ['対象', '対象外'],
    文書種別: ['RFI'],
    分野: ['行政DX', 'UI・UX'],
    自社関連度: ['A', 'B', 'C', '対象外'],
    コンタクト推奨度: ['高', '中', '低', '不要'],
    確認状態: ['未確認', '確認済み', '対象外'],
  };
  return {
    databaseName: '行政ニーズ',
    databaseId: DATABASE_ID,
    dataSources: [{
      name: '行政ニーズ ',
      id: DATA_SOURCE_ID,
      properties: Object.entries(EXPECTED_NOTION_PROPERTIES).map(([name, type], index) => ({
        name,
        id: index === 0 ? 'title' : `property-${index}`,
        type,
        options: selectOptions[name] ?? [],
      })),
    }],
  };
}

function client(options: {
  duplicate?: boolean;
  onCreate?: () => void;
} = {}): NotionRegistrationClient {
  return {
    retrieveDatabase: async () => ({}),
    retrieveDataSource: async () => ({}),
    queryDataSourceByUrl: async () => ({
      object: 'list',
      results: options.duplicate
        ? [{ object: 'page', id: PAGE_ID, url: NOTION_PAGE_URL }]
        : [],
    }),
    createPage: async () => {
      options.onCreate?.();
      return { object: 'page', id: PAGE_ID, url: NOTION_PAGE_URL };
    },
  };
}

function args(): string[] {
  return [
    '--source', 'osaka-digital-rss',
    '--url', OFFICIAL_URL,
    '--database-id', DATABASE_ID,
  ];
}

function dependencies(options: {
  stdout?: string[];
  stderr?: string[];
  onCreate?: () => void;
  token?: string;
}) {
  const analyzer: AdministrativeNeedAnalyzer = {
    provider: 'claude_cli',
    model: null,
    analyze: async () => result().analysis,
  };
  return {
    env: { NOTION_TOKEN: options.token ?? 'test-token' },
    loadEnvironment: () => undefined,
    loadRegistry: async () => validateSourceRegistry({
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
    }),
    loadFitCriteria: async () => ({
      version: 1 as const,
      name: '自社',
      directFit: ['Web'],
      partnerFit: ['SI'],
      strategicInterest: ['計画'],
      outOfScope: ['物品'],
    }),
    loadPrompt: async () => 'prompt',
    analyzerFactory: () => analyzer,
    checkNeed: async () => result(),
    createClient: () => client({ onCreate: options.onCreate }),
    checkConnection: async () => report(),
    stdout: (message: string) => options.stdout?.push(message),
    stderr: (message: string) => options.stderr?.push(message),
  };
}
