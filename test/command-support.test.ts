import { describe, expect, it, vi } from 'vitest';
import type { CompanyFitCriteria } from '../src/ai/types.ts';
import {
  parseValueOption,
  resolveNotionDatabaseId,
  setOptionOnce,
} from '../src/commands/cli-options.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../src/notion-check/types.ts';
import {
  NotionRegistrationRuntimeError,
  prepareNotionRegistrationRuntime,
  resolveRegistrationSourceContext,
  unwrapNotionRegistrationRuntimeError,
  type NotionRegistrationRuntimeDependencies,
} from '../src/notion-register/runtime.ts';
import type { RegisterOneResult } from '../src/notion-register/types.ts';
import type { SourceRegistry } from '../src/source-registry/schema.ts';

const DATABASE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const URL = 'https://www.city.osaka.lg.jp/example.html';

describe('共通CLI引数解析', () => {
  it('分離形式とインライン形式の値を取得する', () => {
    expect(parseValueOption(
      ['--source', 'osaka-digital-rss'],
      0,
      '--source',
      ['--source'],
    )).toEqual({ name: '--source', value: 'osaka-digital-rss', consumedNext: true });
    expect(parseValueOption(
      ['--limit=5'],
      0,
      '--limit=5',
      ['--limit'],
    )).toEqual({ name: '--limit', value: '5', consumedNext: false });
  });

  it('値の欠落と同一オプションの重複を拒否する', () => {
    expect(() => parseValueOption(['--source'], 0, '--source', ['--source']))
      .toThrow('--source requires a value');
    expect(() => setOptionOnce('first', 'second', '--source'))
      .toThrow('--source may only be specified once');
  });

  it('Notion URLまたはIDの一方だけを正規化する', () => {
    expect(resolveNotionDatabaseId(undefined, DATABASE_ID)).toBe(DATABASE_ID);
    expect(resolveNotionDatabaseId(
      `https://notion.so/${DATABASE_ID.replaceAll('-', '')}`,
      undefined,
    )).toBe(DATABASE_ID);
    expect(() => resolveNotionDatabaseId('https://notion.so/example', DATABASE_ID))
      .toThrow('not both');
    expect(() => resolveNotionDatabaseId(undefined, undefined)).toThrow('either');
  });
});

describe('共通Notion登録ランタイム', () => {
  it('情報源と組織を台帳から解決し、不明な情報源を拒否する', async () => {
    await expect(resolveRegistrationSourceContext('osaka-digital-rss', {
      loadRegistry: async () => registry(),
    })).resolves.toMatchObject({
      source: { id: 'osaka-digital-rss' },
      organization: { id: 'osaka-city' },
    });
    await expect(resolveRegistrationSourceContext('missing', {
      loadRegistry: async () => registry(),
    })).rejects.toThrow('Source not found: missing');
  });

  it('Notion接続を準備し、AI Contextを初回登録時に1回だけ生成する', async () => {
    const createClient = vi.fn(() => client());
    const checkConnection = vi.fn(async () => notionReport());
    const loadFitCriteria = vi.fn(async () => fitCriteria());
    const loadPrompt = vi.fn(async () => 'system prompt');
    const analyzerFactory = vi.fn(() => ({
      provider: 'mock' as const,
      model: 'mock-v1',
      analyze: vi.fn(),
    }));
    const registerOne: NonNullable<NotionRegistrationRuntimeDependencies['registerOne']> =
      vi.fn(async (input, dependencies) => {
        await dependencies.loadAnalysisContext();
        return duplicate(input.officialUrl);
      });
    const sourceContext = await resolveRegistrationSourceContext('osaka-digital-rss', {
      loadRegistry: async () => registry(),
    });
    const runtime = await prepareNotionRegistrationRuntime(sourceContext, DATABASE_ID, {
      env: { NOTION_TOKEN: 'test-token' },
      loadEnvironment: () => undefined,
      createClient,
      checkConnection,
      loadFitCriteria,
      loadPrompt,
      analyzerFactory,
      registerOne,
    });

    expect(analyzerFactory).not.toHaveBeenCalled();
    await runtime.register(URL, false);
    await runtime.register(URL, true);

    expect(createClient).toHaveBeenCalledWith('test-token');
    expect(checkConnection).toHaveBeenCalledWith(expect.anything(), DATABASE_ID);
    expect(loadFitCriteria).toHaveBeenCalledTimes(1);
    expect(loadPrompt).toHaveBeenCalledTimes(1);
    expect(analyzerFactory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(registerOne).mock.calls.map(([input]) => input.write))
      .toEqual([false, true]);
  });

  it.each([
    ['setup', { createClient: () => { throw new Error('setup fixture'); } }],
    ['connection', { checkConnection: async () => { throw new Error('connection fixture'); } }],
  ] as const)('%s段階の失敗を安全に識別できる', async (phase, overrides) => {
    const sourceContext = await resolveRegistrationSourceContext('osaka-digital-rss', {
      loadRegistry: async () => registry(),
    });
    let thrown: unknown;
    try {
      await prepareNotionRegistrationRuntime(sourceContext, DATABASE_ID, {
        env: { NOTION_TOKEN: 'test-token' },
        loadEnvironment: () => undefined,
        createClient: () => client(),
        checkConnection: async () => notionReport(),
        ...overrides,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotionRegistrationRuntimeError);
    expect(thrown).toMatchObject({ phase });
    expect(unwrapNotionRegistrationRuntimeError(thrown)).toBeInstanceOf(Error);
  });
});

function registry(): SourceRegistry {
  return {
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
  };
}

function client(): NotionRegistrationClient {
  return {
    retrieveDatabase: async () => ({}),
    retrieveDataSource: async () => ({}),
    queryDataSourceByUrl: async () => ({ object: 'list', results: [] }),
    createPage: async () => ({ object: 'page', id: 'page-id', url: 'https://notion.so/page' }),
  };
}

function notionReport(): NotionConnectionReport {
  return {
    databaseName: '行政ニーズ',
    databaseId: DATABASE_ID,
    dataSources: [{ name: '行政ニーズ', id: 'data-source', properties: [] }],
  };
}

function fitCriteria(): CompanyFitCriteria {
  return {
    version: 1,
    name: '自社',
    directFit: ['direct'],
    partnerFit: ['partner'],
    strategicInterest: ['strategic'],
    outOfScope: ['out'],
  };
}

function duplicate(officialUrl: string): RegisterOneResult {
  return {
    status: 'duplicate',
    officialUrl,
    existingPageId: 'page-id',
    existingPageUrl: 'https://notion.so/page',
    phase: 'preflight',
    warnings: [],
  };
}
