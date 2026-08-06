import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSourceCheckReport,
  parseSourceCheckArgs,
  sourceCheckExitCode,
  writeSourceCheckReport,
} from '../src/commands/sources-check.ts';
import {
  assertSafeUrl,
  isBlockedAddress,
  isHostnameAllowed,
  safeFetchBytes,
  safeFetchText,
} from '../src/source-check/fetch.ts';
import {
  checkSourceRegistry,
  selectSources,
  type SourceFetcher,
} from '../src/source-check/index.ts';
import { analyzeListPage } from '../src/source-check/list-page-checker.ts';
import { analyzeRss } from '../src/source-check/rss-checker.ts';
import type {
  FetchedText,
  SourceCheckResult,
} from '../src/source-check/types.ts';
import type {
  Organization,
  Source,
  SourceRegistry,
} from '../src/source-registry/schema.ts';

const OFFICIAL_DOMAIN = 'city.osaka.lg.jp';
const PUBLIC_RESOLVER = async () => [{ address: '8.8.8.8', family: 4 as const }];

describe('RSSチェック', () => {
  it('実取得fixtureを解析し、台帳フィルター適用前後の件数とサンプルを返す', async () => {
    const xml = await fixture('ict-rss.xml');
    const result = analyzeRss(xml, makeSource({
      collector_type: 'rss',
      category_includes: ['入札契約情報', 'DX・デジタル化・スマートシティ'],
      title_excludes: ['入札結果', '選定結果', '再委託状況', '要綱・要領等'],
    }), OFFICIAL_DOMAIN, 100);

    expect(result.rawItemCount).toBe(100);
    expect(result.structurallyValidItemCount).toBeGreaterThan(0);
    expect(result.usableItemCount).toBeGreaterThan(0);
    expect(result.usableItemCount).toBeLessThan(result.rawItemCount);
    expect(result.exclusions).toContainEqual({ reason: 'category_includesで除外', count: expect.any(Number) });
    expect(result.exclusions).toContainEqual({ reason: 'title_excludesで除外', count: expect.any(Number) });
    expect(result.samples.some((sample) => sample.title.includes('CXサービスデザイン'))).toBe(true);
  });

  it('複数categoryと公開日を取得できる', async () => {
    const result = analyzeRss(
      await fixture('ict-rss.xml'),
      makeSource({ collector_type: 'rss' }),
      OFFICIAL_DOMAIN,
      100,
    );
    const sample = result.samples.find((candidate) => candidate.title.includes('再委託状況'));
    expect(sample?.categories).toHaveLength(2);
    expect(sample?.publishedAt).toBe('2026-07-28');
  });

  it('itemが0件ならErrorにする', () => {
    expect(() => analyzeRss(
      '<rss version="2.0"><channel></channel></rss>',
      makeSource({ collector_type: 'rss' }),
      OFFICIAL_DOMAIN,
      3,
    )).toThrow('itemが0件');
  });

  it('不正なXMLとDOCTYPEを拒否する', () => {
    expect(() => analyzeRss(
      '<not-rss></not-rss>',
      makeSource({ collector_type: 'rss' }),
      OFFICIAL_DOMAIN,
      3,
    ))
      .toThrow('RSS 2.0');
    expect(() => analyzeRss(
      '<rss version="2.0"><channel><item></channel></rss>',
      makeSource({ collector_type: 'rss' }),
      OFFICIAL_DOMAIN,
      3,
    )).toThrow('整形式XML');
    expect(() => analyzeRss(
      '<!DOCTYPE rss><rss version="2.0"><channel /></rss>',
      makeSource({ collector_type: 'rss' }),
      OFFICIAL_DOMAIN,
      3,
    )).toThrow('DOCTYPE');
  });

  it('公開日欠損はWarningにし、候補は返す', () => {
    const xml = '<rss version="2.0"><channel><item><title>公募</title><link>https://www.city.osaka.lg.jp/page/1</link></item></channel></rss>';
    const result = analyzeRss(xml, makeSource({ collector_type: 'rss' }), OFFICIAL_DOMAIN, 3);
    expect(result.usableItemCount).toBe(1);
    expect(result.warnings.join('\n')).toContain('公開日');
  });
});

describe('一覧ページチェック', () => {
  it('実取得fixtureから自己リンクを除外し、候補と和暦の公開日を取得する', async () => {
    const source = makeSource({
      collector_type: 'list_page',
      url: 'https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/0-Curr.html',
      link_selector: "#koji_wrap .sec_01 h2 a[href*='/templates/proposal_hattyuuannkenn/']",
    });
    const result = analyzeListPage(
      await fixture('proposal-list.html'),
      source,
      OFFICIAL_DOMAIN,
      3,
    );

    expect(result.rawItemCount).toBe(result.usableItemCount);
    expect(result.usableItemCount).toBeGreaterThan(50);
    expect(result.samples[0]?.publishedAt).toBe('2026-07-29');
    expect(result.linkSelectorStatus).toBe('ok');
    expect(result.contentSelectorStatus).toBe('not_checked');
  });

  it('報道発表の実取得fixtureから記事リンクだけを抽出する', async () => {
    const source = makeSource({
      collector_type: 'list_page',
      url: 'https://www.city.osaka.lg.jp/hodoshiryo/98-Curr.html',
      link_selector: "#hdo_wrap .hdo_sub_lower a[href*='/hodoshiryo/ictsenryakushitsu/']",
    });
    const result = analyzeListPage(
      await fixture('digital-press.html'),
      source,
      OFFICIAL_DOMAIN,
      3,
    );

    expect(result.rawItemCount).toBe(11);
    expect(result.usableItemCount).toBe(11);
    expect(result.samples[0]?.title).toContain('大阪市行政オンラインシステム');
    expect(result.samples[0]?.url).toBe(
      'https://www.city.osaka.lg.jp/hodoshiryo/ictsenryakushitsu/0000684270.html',
    );
  });

  it('相対URLを絶対URLへ変換する', () => {
    const result = analyzeListPage(
      '<main id="main"><a href="/proposal/1">案件1</a></main>',
      makeSource({ collector_type: 'list_page', link_selector: '#main a' }),
      OFFICIAL_DOMAIN,
      3,
    );
    expect(result.samples[0]?.url).toBe('https://www.city.osaka.lg.jp/proposal/1');
  });

  it('セレクター一致0件と未設定をErrorにする', () => {
    expect(() => analyzeListPage(
      '<main></main>',
      makeSource({ collector_type: 'list_page', link_selector: '#main a' }),
      OFFICIAL_DOMAIN,
      3,
    )).toThrow('0件');
    expect(() => analyzeListPage(
      '<main><a href="/1">1</a></main>',
      makeSource({ collector_type: 'list_page', link_selector: undefined }),
      OFFICIAL_DOMAIN,
      3,
    )).toThrow('link_selector');
  });

  it('重複URL・外部ドメイン・タイトル欠損をWarningにする', () => {
    const html = [
      '<main id="main">',
      '<a href="/proposal/1">案件1</a>',
      '<a href="/proposal/1">案件1の重複</a>',
      '<a href="https://example.com/2">外部</a>',
      '<a href="/proposal/3"></a>',
      '</main>',
    ].join('');
    const result = analyzeListPage(
      html,
      makeSource({ collector_type: 'list_page', link_selector: '#main a' }),
      OFFICIAL_DOMAIN,
      3,
    );
    expect(result.usableItemCount).toBe(1);
    expect(result.warnings.join('\n')).toContain('重複URL');
    expect(result.warnings.join('\n')).toContain('外部ドメイン');
    expect(result.warnings.join('\n')).toContain('タイトル欠損');
  });
});

describe('安全なHTTP取得', () => {
  it('公式ドメインとそのサブドメインだけを許可する', () => {
    expect(isHostnameAllowed('www.city.osaka.lg.jp', OFFICIAL_DOMAIN)).toBe(true);
    expect(isHostnameAllowed('city.osaka.lg.jp', OFFICIAL_DOMAIN)).toBe(true);
    expect(isHostnameAllowed('city.osaka.lg.jp.example.com', OFFICIAL_DOMAIN)).toBe(false);
  });

  it('内部・予約済みIPを拒否する', () => {
    expect(isBlockedAddress('127.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('169.254.169.254', 4)).toBe(true);
    expect(isBlockedAddress('10.0.0.1', 4)).toBe(true);
    expect(isBlockedAddress('8.8.8.8', 4)).toBe(false);
  });

  it('DNS解決結果が内部IPなら拒否する', async () => {
    await expect(assertSafeUrl(
      new URL('https://www.city.osaka.lg.jp/example'),
      OFFICIAL_DOMAIN,
      async () => [{ address: '127.0.0.1', family: 4 }],
    )).rejects.toThrow('内部・予約済み');
  });

  it('リダイレクト先のドメインを再検証する', async () => {
    await expect(safeFetchText('https://example.com/start', {
      officialDomain: 'example.com',
      accept: 'text/html',
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/secret' },
      }),
    })).rejects.toThrow('公式ドメイン');
  });

  it('実際に読み込んだ応答サイズが上限を超えたら中止する', async () => {
    await expect(safeFetchText('https://example.com/data', {
      officialDomain: 'example.com',
      accept: 'text/plain',
      maxBytes: 3,
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: async () => new Response('123456', { status: 200 }),
    })).rejects.toThrow('応答サイズ');
  });

  it('バイナリ応答を文字コード変換せずに取得する', async () => {
    const expected = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
    const result = await safeFetchBytes('https://example.com/file.pdf', {
      officialDomain: 'example.com',
      accept: 'application/pdf',
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: async () => new Response(expected, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    });

    expect(result.bytes).toEqual(expected);
    expect(result.responseBytes).toBe(expected.byteLength);
  });
});

describe('チェック対象とコマンド', () => {
  it('--source、--enabled、--all と表示件数を解釈する', () => {
    expect(parseSourceCheckArgs(['--source', 'osaka-source', '--limit', '5']))
      .toEqual({ selection: { mode: 'source', sourceId: 'osaka-source' }, limit: 5 });
    expect(parseSourceCheckArgs(['--enabled'])).toEqual({ selection: { mode: 'enabled' }, limit: 3 });
    expect(parseSourceCheckArgs(['--all', '--limit=2'])).toEqual({ selection: { mode: 'all' }, limit: 2 });
    expect(parseSourceCheckArgs([
      '--source=osaka-source',
      '--output=data/logs/source-check/result.json',
    ])).toEqual({
      selection: { mode: 'source', sourceId: 'osaka-source' },
      limit: 3,
      outputPath: 'data/logs/source-check/result.json',
    });
    expect(parseSourceCheckArgs(['--source', 'osaka-source', '--output'])).toEqual({
      selection: { mode: 'source', sourceId: 'osaka-source' },
      limit: 3,
      outputPath: 'data/logs/source-check/osaka-source.json',
    });
    expect(parseSourceCheckArgs(['--enabled', '--output', '--limit', '2'])).toEqual({
      selection: { mode: 'enabled' },
      limit: 2,
      outputPath: 'data/logs/source-check/enabled.json',
    });
  });

  it('対象指定の重複・欠落と不正なlimitを拒否する', () => {
    expect(() => parseSourceCheckArgs([])).toThrow('いずれか1つ');
    expect(() => parseSourceCheckArgs(['--all', '--enabled'])).toThrow('いずれか1つ');
    expect(() => parseSourceCheckArgs(['--all', '--limit', '0'])).toThrow('--limit');
    expect(() => parseSourceCheckArgs(['--all', '--limit', '21'])).toThrow('--limit');
    expect(() => parseSourceCheckArgs([
      '--all',
      '--output',
      'first.json',
      '--output=second.json',
    ])).toThrow('--output は1回');
  });

  it('同じ保存先へ機械可読なJSON結果を上書きできる', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'source-check-report-'));
    const outputPath = join(temporaryDirectory, 'nested', 'result.json');

    try {
      const report = createSourceCheckReport(
        [result('warning', true)],
        {
          selection: { mode: 'source', sourceId: 'source' },
          limit: 3,
          outputPath,
        },
        new Date('2026-08-05T01:02:03.000Z'),
      );
      const savedPath = await writeSourceCheckReport(outputPath, report);
      const saved = JSON.parse(await readFile(savedPath, 'utf8')) as Record<string, unknown>;

      expect(savedPath).toBe(outputPath);
      expect(saved).toMatchObject({
        schemaVersion: 1,
        generatedAt: '2026-08-05T01:02:03.000Z',
        selection: { mode: 'source', sourceId: 'source' },
        sampleLimit: 3,
        summary: {
          total: 1,
          ok: 0,
          warning: 1,
          error: 0,
          unsupported: 0,
          exitCode: 0,
        },
      });
      expect(saved.results).toHaveLength(1);

      const replacement = createSourceCheckReport(
        [result('ok', true)],
        {
          selection: { mode: 'source', sourceId: 'source' },
          limit: 3,
          outputPath,
        },
        new Date('2026-08-06T01:02:03.000Z'),
      );
      await writeSourceCheckReport(outputPath, replacement);
      const replaced = JSON.parse(await readFile(outputPath, 'utf8')) as Record<string, unknown>;
      expect(replaced).toMatchObject({
        generatedAt: '2026-08-06T01:02:03.000Z',
        summary: { ok: 1, warning: 0 },
      });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('存在しない情報源IDを拒否する', () => {
    expect(() => selectSources(makeRegistry([makeSource()]), { mode: 'source', sourceId: 'missing' }))
      .toThrow('登録されていません');
  });

  it('未対応形式をUnsupportedとして返す', async () => {
    const results = await checkSourceRegistry(
      makeRegistry([makeSource({ collector_type: 'manual' })]),
      { selection: { mode: 'all' }, limit: 3, intervalMs: 0 },
    );
    expect(results[0]?.status).toBe('unsupported');
  });

  it('1件失敗しても残りのチェックを継続する', async () => {
    const sources = [
      makeSource({ id: 'first-source', url: 'https://www.city.osaka.lg.jp/first' }),
      makeSource({ id: 'second-source', url: 'https://www.city.osaka.lg.jp/second' }),
    ];
    const fetchSource: SourceFetcher = async ({ url }) => {
      if (url.endsWith('/first')) throw new Error('fixture fetch failure');
      return fetched('<main id="main"><a href="/proposal/1">案件1</a></main>', url, 'text/html');
    };
    const results = await checkSourceRegistry(
      makeRegistry(sources),
      { selection: { mode: 'all' }, limit: 3, intervalMs: 0 },
      { fetchSource },
    );
    expect(results.map((result) => result.status)).toEqual(['error', 'ok']);
  });

  it('Errorと有効なUnsupportedは終了コード1にする', () => {
    expect(sourceCheckExitCode([result('error', true)], { mode: 'all' })).toBe(1);
    expect(sourceCheckExitCode([result('unsupported', true)], { mode: 'enabled' })).toBe(1);
    expect(sourceCheckExitCode([result('unsupported', false)], { mode: 'all' })).toBe(0);
    expect(sourceCheckExitCode([result('warning', true)], { mode: 'enabled' })).toBe(0);
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'osaka-source',
    organization_id: 'osaka-city',
    name: '大阪市の情報源',
    url: 'https://www.city.osaka.lg.jp/source',
    collector_type: 'list_page',
    source_category: 'procurement',
    priority: 'high',
    enabled: true,
    link_selector: '#main a',
    ...overrides,
  };
}

function makeRegistry(sources: Source[]): SourceRegistry {
  const organization: Organization = {
    id: 'osaka-city',
    name: '大阪市',
    organization_type: 'designated_city',
    official_domain: OFFICIAL_DOMAIN,
    enabled: true,
  };
  return { version: 1, organizations: [organization], sources };
}

function fetched(text: string, url: string, contentType: string): FetchedText {
  return {
    originalUrl: url,
    finalUrl: url,
    httpStatus: 200,
    contentType,
    text,
    responseBytes: new TextEncoder().encode(text).byteLength,
    durationMs: 1,
    redirectCount: 0,
  };
}

function result(status: SourceCheckResult['status'], sourceEnabled: boolean): SourceCheckResult {
  return {
    sourceId: 'source',
    sourceName: 'Source',
    sourceEnabled,
    organizationName: 'Org',
    collectorType: status === 'unsupported' ? 'manual' : 'rss',
    sourceUrl: 'https://example.com',
    status,
    samples: [],
    exclusions: [],
    warnings: [],
    checkedAt: '2026-08-05T00:00:00.000Z',
  };
}
