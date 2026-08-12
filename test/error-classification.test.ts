import { describe, expect, it } from 'vitest';
import { AiAnalyzerError, ClaudeUsageLimitError } from '../src/ai/errors.ts';
import { ContentExtractionError } from '../src/content-check/errors.ts';
import { extractDocumentFromHtml } from '../src/content-check/extract.ts';
import { safeNotionRegistrationErrorMessage } from '../src/notion-register/error-format.ts';
import { registerOneAdministrativeNeed } from '../src/notion-register/register-one.ts';
import { SourceCheckFetchError } from '../src/source-check/fetch.ts';
import type {
  NotionConnectionReport,
  NotionRegistrationClient,
} from '../src/notion-check/types.ts';
import { validateSourceRegistry } from '../src/source-registry/schema.ts';

const OFFICIAL_URL = 'https://www.pref.akita.lg.jp/pages/archive/98664';
const DATABASE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const DATA_SOURCE_ID = 'fedcba98-7654-3210-fedc-ba9876543210';
const SHORT_BODY_MESSAGE = '設定された content_selector「article.page-contents」の本文が 149 文字しかありません。'
  + ' フォールバックでも本文を 200 文字以上抽出できませんでした。';

describe('本文抽出失敗のエラー分類', () => {
  it('本文が下限に届かない場合はContentExtractionErrorを投げる', () => {
    const html = '<html><body><h1>庁内ネットーワークの不具合について(復旧)</h1>'
      + '<article class="page-contents">短い本文</article></body></html>';

    expect(() => extractDocumentFromHtml({
      html,
      url: OFFICIAL_URL,
      contentSelector: 'article.page-contents',
    })).toThrow(ContentExtractionError);
  });

  it('ページタイトルが取れない場合もContentExtractionErrorを投げる', () => {
    expect(() => extractDocumentFromHtml({
      html: '<html><body><article class="page-contents">本文</article></body></html>',
      url: OFFICIAL_URL,
      contentSelector: 'article.page-contents',
    })).toThrow(ContentExtractionError);
  });

  it('本文抽出失敗をNotion登録の汎用文にせず実際の理由を返す', () => {
    const message = safeNotionRegistrationErrorMessage(
      new ContentExtractionError(SHORT_BODY_MESSAGE),
    );

    expect(message).toContain('200 文字以上抽出できませんでした');
    expect(message).not.toContain('Notion registration failed');
  });

  it('未知の例外は従来どおり安全な汎用文にする', () => {
    expect(safeNotionRegistrationErrorMessage(new Error('想定外')))
      .toBe('Notion registration failed before a safe error response was available.');
  });

  it.each([
    ['AiAnalyzerError', new AiAnalyzerError('Claude CLI execution failed (exit=1)')],
    ['ClaudeUsageLimitError', new ClaudeUsageLimitError("You've hit your limit")],
    ['SourceCheckFetchError', new SourceCheckFetchError('HTTP 500')],
  ])('%s の既存メッセージ整形を変えない', (_label, error) => {
    const message = safeNotionRegistrationErrorMessage(error);

    expect(message).not.toContain('Notion registration failed');
  });
});

describe('register-oneのstage分類', () => {
  it('本文抽出失敗をai_analysisではなくcontent_extractにする', async () => {
    const result = await registerOneAdministrativeNeed(
      registerInput({ write: false }),
      {
        loadAnalysisContext: async () => analysisContext(),
        checkNeed: async () => {
          throw new ContentExtractionError(SHORT_BODY_MESSAGE);
        },
      },
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.stage).toBe('content_extract');
    expect(result.message).toContain('200 文字以上抽出できませんでした');
    expect(result.message).not.toContain('Notion registration failed');
    expect(result.configurationError).toBe(false);
  });

  it('Previewでも同じ分類になる', async () => {
    const previewResult = await registerOneAdministrativeNeed(
      registerInput({ write: false }),
      {
        loadAnalysisContext: async () => analysisContext(),
        checkNeed: async () => {
          throw new ContentExtractionError(SHORT_BODY_MESSAGE);
        },
      },
    );
    const writeResult = await registerOneAdministrativeNeed(
      registerInput({ write: true }),
      {
        loadAnalysisContext: async () => analysisContext(),
        checkNeed: async () => {
          throw new ContentExtractionError(SHORT_BODY_MESSAGE);
        },
      },
    );

    expect(previewResult.status === 'failed' && previewResult.stage).toBe('content_extract');
    expect(writeResult.status === 'failed' && writeResult.stage).toBe('content_extract');
  });

  it('Claude側の失敗は従来どおりai_analysisのままにする', async () => {
    const result = await registerOneAdministrativeNeed(
      registerInput({ write: false }),
      {
        loadAnalysisContext: async () => analysisContext(),
        checkNeed: async () => {
          throw new AiAnalyzerError('Claude CLI execution failed (exit=1, signal=none)');
        },
      },
    );

    expect(result.status === 'failed' && result.stage).toBe('ai_analysis');
  });

  it('利用上限は失敗結果に変換せず再throwする', async () => {
    const error = await registerOneAdministrativeNeed(
      registerInput({ write: false }),
      {
        loadAnalysisContext: async () => analysisContext(),
        checkNeed: async () => {
          throw new ClaudeUsageLimitError("You've hit your limit · resets 8:20pm (Asia/Tokyo)");
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeUsageLimitError);
  });
});

function registerInput(options: { write: boolean }) {
  const registry = validateSourceRegistry({
    version: 1,
    organizations: [{
      id: 'akita-prefecture',
      name: '秋田県',
      organization_type: 'prefecture',
      official_domain: 'pref.akita.lg.jp',
      enabled: true,
    }],
    sources: [{
      id: 'akita-digital-policy',
      organization_id: 'akita-prefecture',
      name: 'デジタル政策推進課',
      url: 'https://www.pref.akita.lg.jp/pages/genre/system',
      collector_type: 'list_page',
      source_category: 'digital_news',
      priority: 'medium',
      enabled: true,
    }],
  });
  return {
    source: registry.sources[0]!,
    organization: registry.organizations[0]!,
    officialUrl: OFFICIAL_URL,
    write: options.write,
    client: notionClient(),
    report: notionReport(),
    limits: { htmlCharacters: 1000, pdfCharacters: 1000, maxPdfs: 3 },
  };
}

function analysisContext() {
  return {
    analyzer: {
      provider: 'claude_cli' as const,
      model: null,
      analyze: async () => {
        throw new Error('呼ばれない');
      },
    },
    companyFitCriteria: {
      version: 1 as const,
      name: 'テスト基準',
      directFit: [],
      partnerFit: [],
      strategicInterest: [],
      outOfScope: [],
    },
  };
}

function notionReport(): NotionConnectionReport {
  return {
    databaseName: '行政ニーズ',
    databaseId: DATABASE_ID,
    dataSources: [{ name: '行政ニーズ', id: DATA_SOURCE_ID, properties: [] }],
  };
}

function notionClient(): NotionRegistrationClient {
  return {
    retrieveDatabase: async () => ({}),
    retrieveDataSource: async () => ({}),
    queryDataSourceByUrl: async () => ({ object: 'list', results: [] }),
    createPage: async () => {
      throw new Error('Previewでは呼ばれない');
    },
  };
}
