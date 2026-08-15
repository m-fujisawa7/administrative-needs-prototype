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
  collectSourceCandidates,
  selectSources,
  type SourceFetcher,
} from '../src/source-check/index.ts';
import { analyzeListPage } from '../src/source-check/list-page-checker.ts';
import { analyzeRss } from '../src/source-check/rss-checker.ts';
import { parseDateCandidate } from '../src/source-check/utils.ts';
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
  it('共通Collectorが既存RSS解析を使って全候補を返す', async () => {
    const source = makeSource({ collector_type: 'rss' });
    const candidates = await collectSourceCandidates(
      source,
      makeRegistry([source]).organizations[0]!,
      {
        fetchSource: async ({ url }) => fetched(
          '<rss version="2.0"><channel>'
          + '<item><title>案件1</title><link>https://www.city.osaka.lg.jp/page/1</link></item>'
          + '<item><title>案件2</title><link>https://www.city.osaka.lg.jp/page/2</link></item>'
          + '</channel></rss>',
          url,
          'application/rss+xml',
        ),
      },
    );
    expect(candidates.map(({ title }) => title)).toEqual(['案件1', '案件2']);
  });

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

describe('公開日候補の解析', () => {
  it.each([
    ['R8.8.5', '2026-08-05'],
    ['R8.9.4 PM3時', '2026-09-04'],
    ['R8.8.5 正午', '2026-08-05'],
    ['R8.12.31', '2026-12-31'],
    ['R10.1.9', '2028-01-09'],
  ])('和暦略記 %s を解析する', (value, expected) => {
    expect(parseDateCandidate(value)).toBe(expected);
  });

  it('行全体からは先に現れる公告日を採用する', () => {
    const row = '117 令和8年度県産広葉樹プロモーション業務 林業振興課 R8.8.5 R8.9.4 PM3時';
    expect(parseDateCandidate(row)).toBe('2026-08-05');
  });

  it('既存の西暦・令和フル表記の解析を変えない', () => {
    expect(parseDateCandidate('2026年8月5日')).toBe('2026-08-05');
    expect(parseDateCandidate('2026-08-05')).toBe('2026-08-05');
    expect(parseDateCandidate('令和8年8月5日')).toBe('2026-08-05');
    expect(parseDateCandidate('2026年8月5日 R8.9.4')).toBe('2026-08-05');
  });

  it.each(['R8', 'AR8.1.2', 'R2.0.1', 'R8.13.1', 'バージョンR1.2.3の資料'])(
    '和暦として妥当でない %s は解析しない',
    (value) => {
      expect(parseDateCandidate(value)).toBeNull();
    },
  );
});

describe('一覧ページのtitle_excludes', () => {
  const HTML = [
    '<main id="main">',
    '<a href="/1">【公募型プロポーザル】AI窓口業務</a>',
    '<a href="/2">よくある質問</a>',
    '<a href="/3">サービスの使い方</a>',
    '<a href="/4">セキュリティポリシー</a>',
    '<a href="/5">ＦＡＱ</a>',
    '</main>',
  ].join('');
  const EXCLUDES = ['よくある質問', 'FAQ', 'サービスの使い方', 'セキュリティポリシー'];

  it('一致した候補を除外し、除外理由と件数を残す', () => {
    const result = analyzeListPage(
      HTML,
      makeSource({ title_excludes: EXCLUDES }),
      OFFICIAL_DOMAIN,
      10,
    );

    expect(result.rawItemCount).toBe(5);
    expect(result.usableItemCount).toBe(1);
    expect(result.samples.map(({ title }) => title)).toEqual(['【公募型プロポーザル】AI窓口業務']);
    expect(result.exclusions).toContainEqual({ reason: 'title_excludesで除外', count: 4 });
  });

  it('全角のＦＡＱもRSSと同じ正規化で一致させる', () => {
    const result = analyzeListPage(
      '<main id="main"><a href="/1">ＦＡＱ</a><a href="/2">案件</a></main>',
      makeSource({ title_excludes: ['FAQ'] }),
      OFFICIAL_DOMAIN,
      10,
    );

    expect(result.samples.map(({ title }) => title)).toEqual(['案件']);
  });

  it('title_excludes未指定なら従来どおり全件を残す', () => {
    const result = analyzeListPage(HTML, makeSource(), OFFICIAL_DOMAIN, 10);

    expect(result.usableItemCount).toBe(5);
    expect(result.exclusions.some(({ reason }) => reason === 'title_excludesで除外')).toBe(false);
  });

  it('日付が取れない候補は一致しなければ落とさない', () => {
    const result = analyzeListPage(
      HTML,
      makeSource({ title_excludes: EXCLUDES }),
      OFFICIAL_DOMAIN,
      10,
    );

    expect(result.samples[0]?.publishedAt).toBeNull();
  });

  it('適用後に候補が0件ならErrorにする', () => {
    expect(() => analyzeListPage(
      '<main id="main"><a href="/1">よくある質問</a></main>',
      makeSource({ title_excludes: ['よくある質問'] }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('title_excludes');
  });

  it('共通Collector経由でも除外後の候補だけを返す', async () => {
    const source = makeSource({ title_excludes: EXCLUDES });
    const candidates = await collectSourceCandidates(
      source,
      makeRegistry([source]).organizations[0]!,
      { fetchSource: async ({ url }) => fetched(HTML, url, 'text/html') },
    );

    expect(candidates.map(({ title }) => title)).toEqual(['【公募型プロポーザル】AI窓口業務']);
  });
});

describe('title_includes', () => {
  const HTML = [
    '<main id="main">',
    '<a href="/1">新潟県ＬＡＮシステム用サーバ機器等一式の借上げ</a>',
    '<a href="/2">トリプル四重極液体クロマトグラフ質量分析計の賃貸借</a>',
    '<a href="/3">比較器の購入</a>',
    '<a href="/4">入札結果「ソフトウェア保守業務」</a>',
    '<a href="/5">自治体DXの取組に資する情報提供のお願い（RFI実施について）</a>',
    '</main>',
  ].join('');
  const INCLUDES = ['システム', 'ソフトウェア', 'RFI'];

  const rss = (titles: readonly string[]): string =>
    '<rss version="2.0"><channel>'
    + titles.map((title, index) =>
      `<item><title>${title}</title><link>https://www.city.osaka.lg.jp/page/${index}</link></item>`).join('')
    + '</channel></rss>';

  it('未設定なら従来どおり全件を残す', () => {
    const result = analyzeListPage(HTML, makeSource(), OFFICIAL_DOMAIN, 10);
    expect(result.usableItemCount).toBe(5);
    expect(result.exclusions.some(({ reason }) => reason === 'title_includesで除外')).toBe(false);
  });

  it('空配列でも従来どおり全件を残す', () => {
    const result = analyzeListPage(
      HTML,
      makeSource({ title_includes: [] }),
      OFFICIAL_DOMAIN,
      10,
    );
    expect(result.usableItemCount).toBe(5);
    expect(result.exclusions.some(({ reason }) => reason === 'title_includesで除外')).toBe(false);
  });

  it('1語でも一致すれば残し、どれにも一致しない候補を落とす', () => {
    const result = analyzeListPage(
      HTML,
      makeSource({ title_includes: INCLUDES }),
      OFFICIAL_DOMAIN,
      10,
    );
    // 質量分析計の賃貸借と比較器の購入は、どのinclude語にも一致しない。
    expect(result.samples.map(({ title }) => title)).toEqual([
      '新潟県ＬＡＮシステム用サーバ機器等一式の借上げ',
      '入札結果「ソフトウェア保守業務」',
      '自治体DXの取組に資する情報提供のお願い（RFI実施について）',
    ]);
    expect(result.exclusions).toContainEqual({ reason: 'title_includesで除外', count: 2 });
  });

  it('title_excludesが優先され、両方に一致した候補は除外される', () => {
    const result = analyzeListPage(
      HTML,
      makeSource({ title_includes: INCLUDES, title_excludes: ['入札結果'] }),
      OFFICIAL_DOMAIN,
      10,
    );
    expect(result.samples.map(({ title }) => title)).toEqual([
      '新潟県ＬＡＮシステム用サーバ機器等一式の借上げ',
      '自治体DXの取組に資する情報提供のお願い（RFI実施について）',
    ]);
    expect(result.exclusions).toContainEqual({ reason: 'title_excludesで除外', count: 1 });
    expect(result.exclusions).toContainEqual({ reason: 'title_includesで除外', count: 2 });
  });

  it('title_excludesと同じ正規化で全角・半角を吸収する', () => {
    const result = analyzeListPage(
      '<main id="main"><a href="/1">ＲＦＩの実施</a><a href="/2">比較器の購入</a></main>',
      makeSource({ title_includes: ['RFI'] }),
      OFFICIAL_DOMAIN,
      10,
    );
    expect(result.samples.map(({ title }) => title)).toEqual(['ＲＦＩの実施']);
  });

  it('RSSでも同じように機能する', () => {
    const result = analyzeRss(
      rss(['ＬＡＮシステム用サーバの賃貸借', '比較器の購入', '生成AI活用支援業務']),
      makeSource({ collector_type: 'rss', title_includes: ['システム', 'AI'] }),
      OFFICIAL_DOMAIN,
      10,
    );
    expect(result.samples.map(({ title }) => title))
      .toEqual(['ＬＡＮシステム用サーバの賃貸借', '生成AI活用支援業務']);
    expect(result.exclusions).toContainEqual({ reason: 'title_includesで除外', count: 1 });
  });

  it('RSSでもtitle_excludesが優先される', () => {
    const result = analyzeRss(
      rss(['システム構築業務', '入札結果「システム構築業務」']),
      makeSource({
        collector_type: 'rss',
        title_includes: ['システム'],
        title_excludes: ['入札結果'],
      }),
      OFFICIAL_DOMAIN,
      10,
    );
    expect(result.samples.map(({ title }) => title)).toEqual(['システム構築業務']);
  });

  it('適用後に候補が0件ならErrorにする', () => {
    expect(() => analyzeListPage(
      '<main id="main"><a href="/1">比較器の購入</a></main>',
      makeSource({ title_includes: ['システム'] }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('title_includes');
    expect(() => analyzeRss(
      rss(['比較器の購入']),
      makeSource({ collector_type: 'rss', title_includes: ['システム'] }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('title_includes');
  });

  it('共通Collector経由でも通過した候補だけを返す', async () => {
    const source = makeSource({ title_includes: INCLUDES });
    const candidates = await collectSourceCandidates(
      source,
      makeRegistry([source]).organizations[0]!,
      { fetchSource: async ({ url }) => fetched(HTML, url, 'text/html') },
    );
    expect(candidates.map(({ title }) => title)).toEqual([
      '新潟県ＬＡＮシステム用サーバ機器等一式の借上げ',
      '入札結果「ソフトウェア保守業務」',
      '自治体DXの取組に資する情報提供のお願い（RFI実施について）',
    ]);
  });
});

describe('RSS 1.0（RDF）チェック', () => {
  it('実取得fixtureをRSS 1.0として解析し、title・link・公開日を正規化する', async () => {
    const result = analyzeRss(
      await fixture('rss10-rdf.xml'),
      makeSource({ collector_type: 'rss', url: 'https://www.pref.miyagi.jp/shinchaku/shinchaku.xml' }),
      'pref.miyagi.jp',
      100,
    );

    expect(result.rawItemCount).toBe(10);
    expect(result.usableItemCount).toBe(10);
    expect(result.samples[0]?.title)
      .toContain('仙台湾沿岸海岸保全基本計画の改定に関する計画本文（素案）対する御意見の募集について');
    expect(result.samples[0]?.url)
      .toBe('https://www.pref.miyagi.jp/soshiki/kasen/sendaiwannenganpabukome.html');
    expect(result.samples[0]?.publishedAt).toBe('2026-08-10');
    expect(result.latestPublishedAt).toBe('2026-08-10');
  });

  it('dc:subjectをcategoryへ正規化し、category_includesで絞れる', async () => {
    const result = analyzeRss(
      await fixture('rss10-rdf.xml'),
      makeSource({
        collector_type: 'rss',
        url: 'https://www.pref.miyagi.jp/shinchaku/shinchaku.xml',
        category_includes: ['防災・安全'],
      }),
      'pref.miyagi.jp',
      100,
    );

    expect(result.usableItemCount).toBe(2);
    expect(result.exclusions)
      .toContainEqual({ reason: 'category_includesで除外', count: 8 });
    expect(result.samples[0]?.categories).toEqual(['宮城県', '防災・安全']);
  });

  it('title_excludesもRSS 2.0と同じように効く', async () => {
    const result = analyzeRss(
      await fixture('rss10-rdf.xml'),
      makeSource({
        collector_type: 'rss',
        url: 'https://www.pref.miyagi.jp/shinchaku/shinchaku.xml',
        title_excludes: ['御意見の募集'],
      }),
      'pref.miyagi.jp',
      100,
    );

    expect(result.usableItemCount).toBe(8);
    expect(result.exclusions).toContainEqual({ reason: 'title_excludesで除外', count: 2 });
  });

  it('dc:subjectが単一値のRSS 1.0も1件のcategoryとして扱う', () => {
    const xml = [
      '<?xml version="1.0" encoding="utf-8" ?>',
      '<rdf:RDF xmlns="http://purl.org/rss/1.0/"',
      ' xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"',
      ' xmlns:dc="http://purl.org/dc/elements/1.1/">',
      '<channel rdf:about="https://www.city.osaka.lg.jp/"><title>t</title></channel>',
      '<item rdf:about="https://www.city.osaka.lg.jp/page/1">',
      '<title>公募型プロポーザル</title>',
      '<link>https://www.city.osaka.lg.jp/page/1</link>',
      '<dc:subject>県政情報</dc:subject>',
      '<dc:date>2026-08-07T09:00:00+09:00</dc:date>',
      '</item>',
      '</rdf:RDF>',
    ].join('');

    const result = analyzeRss(xml, makeSource({ collector_type: 'rss' }), OFFICIAL_DOMAIN, 3);

    expect(result.usableItemCount).toBe(1);
    expect(result.samples[0]?.categories).toEqual(['県政情報']);
    expect(result.samples[0]?.publishedAt).toBe('2026-08-07');
  });

  it('itemが0件のrdf:RDFは従来と同じErrorにする', () => {
    const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
      + '<channel rdf:about="https://www.city.osaka.lg.jp/" /></rdf:RDF>';

    expect(() => analyzeRss(xml, makeSource({ collector_type: 'rss' }), OFFICIAL_DOMAIN, 3))
      .toThrow('itemが0件');
  });

  it('RSSでもRDFでもないXMLは従来どおり拒否する', () => {
    expect(() => analyzeRss(
      '<not-rss></not-rss>',
      makeSource({ collector_type: 'rss' }),
      OFFICIAL_DOMAIN,
      3,
    )).toThrow('RSS 2.0');
  });
});

describe('allow_empty_candidates', () => {
  const EMPTY_HTML = '<main id="main"></main>';

  it('未設定なら0件は従来どおりErrorにする', () => {
    expect(() => analyzeListPage(EMPTY_HTML, makeSource(), OFFICIAL_DOMAIN, 10))
      .toThrow('0件');
  });

  it('falseを明示した場合も従来どおりErrorにする', () => {
    expect(() => analyzeListPage(
      EMPTY_HTML,
      makeSource({ allow_empty_candidates: false }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('0件');
  });

  it('trueなら0件を正常終了として扱い、件数0と空のサンプルを返す', () => {
    const result = analyzeListPage(
      EMPTY_HTML,
      makeSource({ allow_empty_candidates: true }),
      OFFICIAL_DOMAIN,
      10,
    );
    expect(result.rawItemCount).toBe(0);
    expect(result.structurallyValidItemCount).toBe(0);
    expect(result.usableItemCount).toBe(0);
    expect(result.samples).toEqual([]);
    expect(result.latestPublishedAt).toBeNull();
    expect(result.linkSelectorStatus).toBe('ok');
    expect(result.contentSelectorStatus).toBe('not_checked');
  });

  it('0件だった事実をWARNINGとして残し、除外は1件も計上しない', () => {
    const result = analyzeListPage(
      EMPTY_HTML,
      makeSource({ allow_empty_candidates: true }),
      OFFICIAL_DOMAIN,
      10,
    );
    expect(result.warnings.join('\n')).toContain('allow_empty_candidates');
    expect(result.warnings.join('\n')).toContain('#main a');
    expect(result.exclusions).toEqual([]);
  });

  it('候補があるときの挙動は変わらない', () => {
    const html = '<main id="main"><a href="/proposal/1">システム構築業務</a></main>';
    const withFlag = analyzeListPage(
      html,
      makeSource({ allow_empty_candidates: true }),
      OFFICIAL_DOMAIN,
      10,
    );
    const withoutFlag = analyzeListPage(html, makeSource(), OFFICIAL_DOMAIN, 10);
    expect(withFlag).toEqual(withoutFlag);
    expect(withFlag.usableItemCount).toBe(1);
    expect(withFlag.warnings).toEqual([]);
  });

  it('link_selector未設定はtrueでもErrorのままにする', () => {
    expect(() => analyzeListPage(
      '<main id="main"><a href="/1">案件</a></main>',
      makeSource({ allow_empty_candidates: true, link_selector: undefined }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('link_selector');
  });

  it('不正なセレクターはtrueでもErrorのままにする', () => {
    expect(() => analyzeListPage(
      '<main id="main"><a href="/1">案件</a></main>',
      makeSource({ allow_empty_candidates: true, link_selector: '#main a[' }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('link_selector が正しくありません');
  });

  it('タイトルと公式ドメイン内URLを持つ候補が0件ならtrueでもErrorにする', () => {
    // セレクターが案件以外を掴んでいるシグナルなので、0件許容の対象にしない。
    expect(() => analyzeListPage(
      '<main id="main"><a href="https://example.com/1">外部サイト</a></main>',
      makeSource({ allow_empty_candidates: true }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('候補リンクがありません');
  });

  it('title_excludes適用後に0件ならtrueでもErrorにする', () => {
    expect(() => analyzeListPage(
      '<main id="main"><a href="/1">入札結果の公表</a></main>',
      makeSource({ allow_empty_candidates: true, title_excludes: ['入札結果'] }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('title_excludes');
  });

  it('title_includes適用後に0件ならtrueでもErrorにする', () => {
    expect(() => analyzeListPage(
      '<main id="main"><a href="/1">比較器の購入</a></main>',
      makeSource({ allow_empty_candidates: true, title_includes: ['システム'] }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('title_includes');
  });

  it('RSSのitem0件はtrueでも従来どおりErrorにする', () => {
    expect(() => analyzeRss(
      '<rss version="2.0"><channel></channel></rss>',
      makeSource({ collector_type: 'rss', allow_empty_candidates: true }),
      OFFICIAL_DOMAIN,
      10,
    )).toThrow('itemが0件');
  });

  it('共通Collector経由では空配列を返し、例外にならない', async () => {
    const source = makeSource({ allow_empty_candidates: true });
    const candidates = await collectSourceCandidates(
      source,
      makeRegistry([source]).organizations[0]!,
      { fetchSource: async ({ url }) => fetched(EMPTY_HTML, url, 'text/html') },
    );
    expect(candidates).toEqual([]);
  });

  it('checkSourceRegistryではErrorではなくWarningになる', async () => {
    const source = makeSource({ allow_empty_candidates: true });
    const results = await checkSourceRegistry(
      makeRegistry([source]),
      { selection: { mode: 'source', sourceId: source.id }, limit: 10 },
      { fetchSource: async ({ url }) => fetched(EMPTY_HTML, url, 'text/html') },
    );
    expect(results[0]?.status).toBe('warning');
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.usableItemCount).toBe(0);
    expect(sourceCheckExitCode(results, { mode: 'source', sourceId: source.id })).toBe(0);
  });
});
