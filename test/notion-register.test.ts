import { describe, expect, it, vi } from 'vitest';
import type { AiCheckInput } from '../src/ai/check.ts';
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
import { NotionCheckError } from '../src/notion-check/errors.ts';
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

  it('固定カテゴリを同じmulti_select名で送り、根拠引用を連結する', () => {
    const values = mapAnalysisToNotionValues(result());
    expect(values.categories).toEqual(['行政DX', 'UI・UX']);
    expect(values.evidence).toBe('・引用1\n・引用2');
    expect(buildNotionPageProperties(values).分野).toEqual({
      multi_select: [{ name: '行政DX' }, { name: 'UI・UX' }],
    });
  });

  it('固定候補外のカテゴリをNotionへ送らない', () => {
    const analysisResult = result();
    analysisResult.analysis.categories = ['Webサイト'] as unknown as AiCheckResult[
      'analysis'
    ]['categories'];
    expect(() => mapAnalysisToNotionValues(analysisResult)).toThrow(
      'Unsupported category value for Notion: Webサイト',
    );
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

  it.each([false, true])(
    '重複時はwrite=%sでも取得・解析・作成をすべてスキップする',
    async (write) => {
      const contentFetch = vi.fn();
      const pdfExtraction = vi.fn();
      const analyzerFactory = vi.fn();
      const analyze = vi.fn();
      const create = vi.fn();
      const query = vi.fn();
      const stdout: string[] = [];
      const exitCode = await runNotionRegister(
        write ? [...args(), '--write'] : args(),
        dependencies({
          stdout,
          duplicate: true,
          onContentFetch: contentFetch,
          onPdfExtraction: pdfExtraction,
          onAnalyzerFactory: analyzerFactory,
          onAnalyze: analyze,
          onCreate: create,
          onQuery: query,
        }),
      );
      const output = stdout.join('\n');
      expect(exitCode).toBe(0);
      expect(query).toHaveBeenCalledTimes(1);
      expect(contentFetch).not.toHaveBeenCalled();
      expect(pdfExtraction).not.toHaveBeenCalled();
      expect(analyzerFactory).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(output).toContain('Duplicate page found.');
      expect(output).toContain(`Existing page ID:\n${PAGE_ID}`);
      expect(output).toContain(`Existing page URL:\n${NOTION_PAGE_URL}`);
      expect(output).toContain('Content fetch:\nSkipped');
      expect(output).toContain('PDF extraction:\nSkipped');
      expect(output).toContain('Claude analysis:\nSkipped');
      expect(output).toContain('Registration:\nSkipped');
    },
  );

  it('非重複のプレビューではHTML・PDF取得とClaude解析へ進み、作成しない', async () => {
    const contentFetch = vi.fn();
    const pdfExtraction = vi.fn();
    const analyze = vi.fn();
    const create = vi.fn();
    const stdout: string[] = [];
    const exitCode = await runNotionRegister(args(), dependencies({
      stdout,
      onContentFetch: contentFetch,
      onPdfExtraction: pdfExtraction,
      onAnalyze: analyze,
      onCreate: create,
    }));
    expect(exitCode).toBe(0);
    expect(contentFetch).toHaveBeenCalledTimes(1);
    expect(pdfExtraction).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('Write mode:\nDisabled');
    expect(stdout.join('\n')).toContain('No data was written.');
  });

  it('非重複の--writeでは取得・解析後に1件作成し、ページIDとURLを表示する', async () => {
    const contentFetch = vi.fn();
    const pdfExtraction = vi.fn();
    const analyze = vi.fn();
    const create = vi.fn();
    const stdout: string[] = [];
    const exitCode = await runNotionRegister([...args(), '--write'], dependencies({
      stdout,
      onContentFetch: contentFetch,
      onPdfExtraction: pdfExtraction,
      onAnalyze: analyze,
      onCreate: create,
    }));
    expect(exitCode).toBe(0);
    expect(contentFetch).toHaveBeenCalledTimes(1);
    expect(pdfExtraction).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(stdout.join('\n')).toContain(`Notion page ID:\n${PAGE_ID}`);
    expect(stdout.join('\n')).toContain(`Notion page URL:\n${NOTION_PAGE_URL}`);
  });

  it('Notion接続失敗時はHTML・PDF取得とClaude解析へ進まない', async () => {
    const contentFetch = vi.fn();
    const pdfExtraction = vi.fn();
    const analyzerFactory = vi.fn();
    const analyze = vi.fn();
    const stderr: string[] = [];
    const exitCode = await runNotionRegister(args(), {
      ...dependencies({
        stderr,
        onContentFetch: contentFetch,
        onPdfExtraction: pdfExtraction,
        onAnalyzerFactory: analyzerFactory,
        onAnalyze: analyze,
      }),
      checkConnection: async () => {
        throw new NotionCheckError('Notion connection failed safely.');
      },
    });
    expect(exitCode).toBe(1);
    expect(contentFetch).not.toHaveBeenCalled();
    expect(pdfExtraction).not.toHaveBeenCalled();
    expect(analyzerFactory).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(stderr).toEqual(['Notion connection failed safely.']);
  });

  it('重複検索失敗時は後続へ進まず、トークンを出力しない', async () => {
    const token = 'secret-query-token-value';
    const contentFetch = vi.fn();
    const analyzerFactory = vi.fn();
    const analyze = vi.fn();
    const stderr: string[] = [];
    const exitCode = await runNotionRegister(args(), dependencies({
      token,
      stderr,
      queryError: {
        status: 500,
        code: 'internal_server_error',
        message: `unsafe ${token}`,
      },
      onContentFetch: contentFetch,
      onAnalyzerFactory: analyzerFactory,
      onAnalyze: analyze,
    }));
    expect(exitCode).toBe(1);
    expect(contentFetch).not.toHaveBeenCalled();
    expect(analyzerFactory).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(stderr.join('\n')).toContain('HTTP status: 500');
    expect(stderr.join('\n')).not.toContain(token);
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
      categories: ['行政DX', 'UI・UX'],
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
  onQuery?: () => void;
  queryError?: unknown;
} = {}): NotionRegistrationClient {
  return {
    retrieveDatabase: async () => ({}),
    retrieveDataSource: async () => ({}),
    queryDataSourceByUrl: async () => {
      options.onQuery?.();
      if (options.queryError !== undefined) throw options.queryError;
      return {
        object: 'list',
        results: options.duplicate
          ? [{ object: 'page', id: PAGE_ID, url: NOTION_PAGE_URL }]
          : [],
      };
    },
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
  onQuery?: () => void;
  onContentFetch?: () => void;
  onPdfExtraction?: () => void;
  onAnalyzerFactory?: () => void;
  onAnalyze?: () => void;
  duplicate?: boolean;
  queryError?: unknown;
  token?: string;
}) {
  const analyzer: AdministrativeNeedAnalyzer = {
    provider: 'claude_cli',
    model: null,
    analyze: async () => {
      options.onAnalyze?.();
      return result().analysis;
    },
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
    analyzerFactory: () => {
      options.onAnalyzerFactory?.();
      return analyzer;
    },
    checkNeed: async (input: AiCheckInput) => {
      options.onContentFetch?.();
      options.onPdfExtraction?.();
      const analysis = await input.analyzer.analyze({
        title: result().title,
        officialUrl: OFFICIAL_URL,
        organizationName: result().organizationName,
        sourceName: result().sourceName,
        htmlText: 'HTML fixture text',
        pdfDocuments: [{ url: `${OFFICIAL_URL}.pdf`, text: 'PDF fixture text' }],
        companyFitCriteria: input.companyFitCriteria,
      });
      return { ...result(), analysis };
    },
    createClient: () => client({
      duplicate: options.duplicate,
      queryError: options.queryError,
      onCreate: options.onCreate,
      onQuery: options.onQuery,
    }),
    checkConnection: async () => report(),
    stdout: (message: string) => options.stdout?.push(message),
    stderr: (message: string) => options.stderr?.push(message),
  };
}
