import { describe, expect, it, vi } from 'vitest';
import { ClaudeCliAnalyzer } from '../src/ai/claude-cli.ts';
import { AiAnalyzerError, ClaudeUsageLimitError } from '../src/ai/errors.ts';
import { detectClaudeUsageLimit } from '../src/ai/usage-limit.ts';
import type { AdministrativeNeedAnalysisInput } from '../src/ai/types.ts';
import { runCollectionBatch } from '../src/collection-run/batch.ts';
import { processCollectedCandidates } from '../src/collection-run/run.ts';
import type { CollectionRunReport } from '../src/collection-run/types.ts';
import {
  runCollection,
  type CollectionRunCommandDependencies,
} from '../src/commands/collection-run.ts';
import { registerOneAdministrativeNeed } from '../src/notion-register/register-one.ts';
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

const LIMIT_LINE = "You've hit your limit · resets 10pm (Asia/Tokyo)";
const CURLY_LIMIT_LINE = 'You’ve hit your limit · resets 10pm (Asia/Tokyo)';
const DATABASE_ID = '01234567-89ab-cdef-0123-456789abcdef';
const DATA_SOURCE_ID = 'fedcba98-7654-3210-fedc-ba9876543210';
const URL_A = 'https://www.city.osaka.lg.jp/example/a.html';
const URL_B = 'https://www.city.osaka.lg.jp/example/b.html';
const URL_C = 'https://www.city.osaka.lg.jp/example/c.html';

describe('Claude CLI利用上限の検知', () => {
  it('raw stdoutに利用上限メッセージが含まれる場合に検知する', () => {
    expect(detectClaudeUsageLimit(LIMIT_LINE, '')).toBe(LIMIT_LINE);
  });

  it('JSON形式のstdout内に含まれる場合も検知する', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: LIMIT_LINE,
    });
    expect(detectClaudeUsageLimit(stdout, '')).toBe(LIMIT_LINE);
  });

  it('stderrに含まれる場合も検知する', () => {
    expect(detectClaudeUsageLimit('', `warning\n${LIMIT_LINE}\n`)).toBe(LIMIT_LINE);
  });

  it('カーリーアポストロフィでも検知する', () => {
    expect(detectClaudeUsageLimit(CURLY_LIMIT_LINE, '')).toBe(CURLY_LIMIT_LINE);
  });

  it('リセット時刻が無くても検知し、その行だけを返す', () => {
    expect(detectClaudeUsageLimit("You've hit your limit", '')).toBe("You've hit your limit");
  });

  it('limit単独や無関係なエラーでは検知しない', () => {
    expect(detectClaudeUsageLimit('rate limit exceeded', '')).toBeNull();
    expect(detectClaudeUsageLimit('limit', 'limit')).toBeNull();
    expect(detectClaudeUsageLimit('Error: connection refused', 'ENOENT')).toBeNull();
    expect(detectClaudeUsageLimit('', '')).toBeNull();
  });
});

describe('ClaudeCliAnalyzerの利用上限エラー', () => {
  it('exit=1かつ利用上限メッセージのときClaudeUsageLimitErrorを投げる', async () => {
    const analyzer = new ClaudeCliAnalyzer({
      executable: 'claude',
      timeoutMs: 1000,
      systemPrompt: 'system',
      runner: async () => ({
        stdout: LIMIT_LINE,
        stderr: '',
        exitCode: 1,
        signal: null,
      }),
    });

    const error = await analyzer.analyze(analysisInput()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeUsageLimitError);
    expect((error as ClaudeUsageLimitError).limitMessage).toBe(LIMIT_LINE);
  });

  it('利用上限でない通常のexit=1は従来どおり汎用エラーにする', async () => {
    const analyzer = new ClaudeCliAnalyzer({
      executable: 'claude',
      timeoutMs: 1000,
      systemPrompt: 'system',
      runner: async () => ({
        stdout: '',
        stderr: 'boom',
        exitCode: 1,
        signal: null,
      }),
    });

    const error = await analyzer.analyze(analysisInput()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiAnalyzerError);
    expect(error).not.toBeInstanceOf(ClaudeUsageLimitError);
    expect((error as Error).message).toContain('Claude CLI execution failed');
  });

  it('利用上限を検知した場合はJSON再試行のためのClaude再呼び出しをしない', async () => {
    let calls = 0;
    const analyzer = new ClaudeCliAnalyzer({
      executable: 'claude',
      timeoutMs: 1000,
      systemPrompt: 'system',
      runner: async () => {
        calls += 1;
        return { stdout: LIMIT_LINE, stderr: '', exitCode: 1, signal: null };
      },
    });

    await analyzer.analyze(analysisInput()).catch(() => undefined);

    expect(calls).toBe(1);
  });
});

describe('利用上限の伝播と後続停止', () => {
  it('register-oneは利用上限を失敗結果へ変換せず再throwする', async () => {
    const error = await registerOneAdministrativeNeed(
      {
        source: registry().sources[0]!,
        organization: registry().organizations[0]!,
        officialUrl: URL_A,
        write: false,
        client: notionClient(),
        report: notionReport(),
        limits: { htmlCharacters: 1000, pdfCharacters: 1000, maxPdfs: 3 },
      },
      {
        loadAnalysisContext: async () => {
          throw new ClaudeUsageLimitError(LIMIT_LINE);
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeUsageLimitError);
  });

  it('候補ループは利用上限で打ち切り、後続候補をClaudeへ渡さない', async () => {
    const processed: string[] = [];
    const report = await processCollectedCandidates({
      sourceId: 'osaka-digital-rss',
      candidates: [candidate(URL_A), candidate(URL_B), candidate(URL_C)],
      candidatesCollected: 3,
      uniqueCandidates: 3,
      effectiveSince: '2026-07-01',
      runStartedAt: '2026-08-07T12:00:00+09:00',
      limit: 5,
      write: false,
      checkDuplicate: async () => null,
      processor: async ({ url }) => {
        processed.push(url);
        if (url === URL_B) throw new ClaudeUsageLimitError(LIMIT_LINE);
        return previewed(url);
      },
    });

    expect(processed).toEqual([URL_A, URL_B]);
    expect(report.usageLimit?.message).toBe(LIMIT_LINE);
    expect(report.results.map(({ result }) => result.status)).toEqual(['previewed', 'failed']);
  });

  it('collect:runは利用上限で停止し、collection stateを進めない', async () => {
    const writeState = vi.fn();
    const registerOne = vi.fn(async (input: { officialUrl: string }) => {
      if (input.officialUrl === URL_B) throw new ClaudeUsageLimitError(LIMIT_LINE);
      return created(input.officialUrl);
    });

    const exitCode = await runCollection(
      ['--source', 'osaka-digital-rss', '--database-id', DATABASE_ID, '--write'],
      runDependencies({ registerOne, writeState }),
    );

    expect(exitCode).toBe(1);
    expect(registerOne).toHaveBeenCalledTimes(2);
    expect(writeState).not.toHaveBeenCalled();
  });

  it('collect:batchは利用上限を検知したSourceで打ち切り、後続Sourceを実行しない', async () => {
    const executed: string[] = [];
    const { report, exitCode } = await runCollectionBatch(
      {
        sourceIds: ['source-a', 'source-b', 'source-c'],
        limit: 5,
        databaseId: DATABASE_ID,
        write: false,
        runStartedAt: new Date('2026-08-07T03:00:00.000Z'),
        state: {},
      },
      {
        stdout: () => undefined,
        executeSource: async ({ options, state }) => {
          executed.push(options.sourceId);
          const stopped = options.sourceId === 'source-b';
          return {
            report: emptyReport(options.sourceId),
            state,
            exitCode: stopped ? 1 : 0,
            ...(stopped ? { usageLimit: { message: LIMIT_LINE } } : {}),
          };
        },
      },
    );

    expect(executed).toEqual(['source-a', 'source-b']);
    expect(report.stopped?.message).toBe(LIMIT_LINE);
    expect(exitCode).toBe(1);
  });
});

function runDependencies(options: {
  registerOne: NonNullable<CollectionRunCommandDependencies['registerOne']>;
  writeState: NonNullable<CollectionRunCommandDependencies['writeState']>;
}): CollectionRunCommandDependencies {
  return {
    env: { NOTION_TOKEN: 'test-token' },
    loadEnvironment: () => undefined,
    loadRegistry: async () => registry(),
    now: () => new Date('2026-08-07T03:00:00.000Z'),
    readState: async () => ({}),
    writeState: options.writeState,
    collectCandidates: async () => [candidate(URL_A), candidate(URL_B), candidate(URL_C)],
    createClient: () => notionClient(),
    checkConnection: async () => notionReport(),
    registerOne: options.registerOne,
    stdout: () => undefined,
    stderr: () => undefined,
  };
}

function emptyReport(sourceId: string): CollectionRunReport {
  return {
    write: false,
    sourceId,
    effectiveSince: '2026-07-01',
    runStartedAt: '2026-08-07T12:00:00+09:00',
    candidatesCollected: 0,
    uniqueCandidates: 0,
    candidatesInPeriod: 0,
    newCandidatesFound: 0,
    processedNewCandidates: 0,
    remainingNewCandidates: 0,
    results: [],
    collectionState: { status: 'not_advanced', reason: 'Preview mode.' },
  };
}

function candidate(url: string): SourceCheckSample {
  return { url, title: `Candidate ${url.slice(-6)}`, publishedAt: '2026-08-06' };
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
    notionPageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    notionPageUrl: 'https://www.notion.so/example-page',
    preview: preview(url),
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
      desiredState: '理想',
      requestToPrivateSector: '依頼',
      categories: ['行政DX'],
      companyRelevance: 'A',
      contactRecommendation: '高',
      reason: '理由',
      evidence: '根拠',
      confirmationStatus: '未確認',
    },
    missingOptions: [],
  } as unknown as NotionRegistrationPreview;
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
    createPage: async () => ({
      object: 'page',
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      url: 'https://www.notion.so/example-page',
    }),
  };
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

function analysisInput(): AdministrativeNeedAnalysisInput {
  return {
    title: 'テスト案件',
    officialUrl: 'https://www.city.osaka.lg.jp/example/a.html',
    organizationName: '大阪市',
    sourceName: 'デジタル統括室 RSS',
    htmlText: '本文',
    pdfDocuments: [],
    companyFitCriteria: {
      version: 1,
      name: 'テスト基準',
      directFit: [],
      partnerFit: [],
      strategicInterest: [],
      outOfScope: [],
    },
  };
}
