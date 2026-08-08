import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createContentCheckReport,
  parseContentCheckArgs,
} from '../src/commands/content-check.ts';
import { extractDocumentFromHtml } from '../src/content-check/extract.ts';
import {
  fetchAndExtractDocument,
  type DocumentFetcher,
} from '../src/content-check/index.ts';
import type { ExtractedDocument } from '../src/content-check/types.ts';
import type { FetchedText } from '../src/source-check/types.ts';
import type {
  Organization,
  Source,
} from '../src/source-registry/schema.ts';

const DOCUMENT_URL = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html';
const OFFICIAL_DOMAIN = 'city.osaka.lg.jp';

describe('個別ページHTML抽出', () => {
  it('実取得fixtureから本文・タイトル・公開日・PDFリンクを取得する', async () => {
    const result = extractDocumentFromHtml({
      html: await fixture('rfi.html'),
      url: DOCUMENT_URL,
      contentSelector: '#mol_contents',
    });

    expect(result.title).toBe('大阪市CXサービスデザイン推進事業に係る情報提供について');
    expect(result.bodyLength).toBe(1449);
    expect(result.bodyText).toContain('情報提供依頼（RFI）の目的');
    expect(result.bodyText).not.toContain('共通メニューなどをスキップ');
    expect(result.publishedAtCandidate).toBe('2026-07-30');
    expect(result.publishedAtSource).toBe('page_text');
    expect(result.contentSelectorUsed).toBe('#mol_contents');
    expect(result.usedFallback).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.pdfUrls).toEqual([
      'https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000675/675316/kihonhoushin2.pdf#page=28',
      'https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000684/684546/01_youryou5.pdf',
    ]);
  });

  it('titleへフォールバックし、不要要素を除外してPDF URLを解決する', () => {
    const mainText = '必要な行政情報です。'.repeat(30);
    const result = extractDocumentFromHtml({
      html: [
        '<html><head><title>フォールバックタイトル</title></head><body>',
        '<main>',
        `<nav>${'不要なメニュー'.repeat(50)}</nav>`,
        `<p>${mainText}</p>`,
        '<script>秘密のスクリプト文字列</script>',
        '<a href="/files/DOCUMENT.PDF?download=1#section">添付資料</a>',
        '</main>',
        '</body></html>',
      ].join(''),
      url: 'https://www.city.osaka.lg.jp/page/example.html',
      contentSelector: '#missing',
    });

    expect(result.title).toBe('フォールバックタイトル');
    expect(result.bodyText).toContain(mainText);
    expect(result.bodyText).not.toContain('不要なメニュー');
    expect(result.bodyText).not.toContain('秘密のスクリプト文字列');
    expect(result.contentSelectorUsed).toBe('main');
    expect(result.usedFallback).toBe(true);
    expect(result.warnings.join('\n')).toContain('一致する要素がありません');
    expect(result.pdfUrls).toEqual([
      'https://www.city.osaka.lg.jp/files/DOCUMENT.PDF?download=1#section',
    ]);
  });

  it('設定セレクターの本文が短い場合は次の候補へフォールバックする', () => {
    const result = extractDocumentFromHtml({
      html: [
        '<html><head><title>案件</title></head><body>',
        '<div id="configured">短い本文</div>',
        `<article>${'十分な本文です。'.repeat(40)}</article>`,
        '</body></html>',
      ].join(''),
      url: DOCUMENT_URL,
      contentSelector: '#configured',
    });

    expect(result.contentSelectorUsed).toBe('article');
    expect(result.warnings.join('\n')).toContain('本文が 4 文字');
  });

  it('bodyフォールバックはWarningにする', () => {
    const result = extractDocumentFromHtml({
      html: `<html><head><title>案件</title></head><body><div>${'本文です。'.repeat(50)}</div></body></html>`,
      url: DOCUMENT_URL,
    });

    expect(result.contentSelectorUsed).toBe('body');
    expect(result.warnings.join('\n')).toContain('body全体');
  });

  it('本文200文字未満とタイトル欠損をErrorにする', () => {
    expect(() => extractDocumentFromHtml({
      html: '<html><head><title>短文</title></head><body>短すぎます</body></html>',
      url: DOCUMENT_URL,
    })).toThrow('200 文字以上');
    expect(() => extractDocumentFromHtml({
      html: `<html><body><main>${'本文です。'.repeat(50)}</main></body></html>`,
      url: DOCUMENT_URL,
    })).toThrow('ページタイトル');
    expect(() => extractDocumentFromHtml({
      html: '<html><head><title>短文</title></head><body>短すぎます</body></html>',
      url: DOCUMENT_URL,
      contentSelector: '#missing',
    })).toThrow('content_selector「#missing」');
  });

  it('time要素の公開日候補を優先する', () => {
    const result = extractDocumentFromHtml({
      html: [
        '<html><head><title>案件</title></head><body>',
        '<time datetime="2026-08-01">公開日</time>',
        `<main>${'本文です。'.repeat(50)}</main>`,
        '</body></html>',
      ].join(''),
      url: DOCUMENT_URL,
    });

    expect(result.publishedAtCandidate).toBe('2026-08-01');
    expect(result.publishedAtSource).toBe('time');
  });
});

describe('個別ページ取得', () => {
  it('台帳のsourceとorganizationを利用し、無効情報源をWarningにする', async () => {
    const fetchDocument: DocumentFetcher = async ({ url }) => fetched(
      `<html><head><title>案件</title></head><body><main>${'本文です。'.repeat(50)}</main></body></html>`,
      url,
      'text/html; charset=utf-8',
    );
    const result = await fetchAndExtractDocument({
      source: makeSource({ enabled: false, content_selector: 'main' }),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
    }, { fetchDocument });

    expect(result.httpStatus).toBe(200);
    expect(result.contentSelectorUsed).toBe('main');
    expect(result.warnings.join('\n')).toContain('enabled: false');
  });

  it('HTML以外のContent-TypeをErrorにする', async () => {
    const fetchDocument: DocumentFetcher = async ({ url }) => fetched(
      '%PDF-1.7',
      url,
      'application/pdf',
    );

    await expect(fetchAndExtractDocument({
      source: makeSource(),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
    }, { fetchDocument })).rejects.toThrow('HTMLではない');
  });

  it('sourceとorganizationの不一致をErrorにする', async () => {
    await expect(fetchAndExtractDocument({
      source: makeSource({ organization_id: 'other-city' }),
      organization: makeOrganization(),
      url: DOCUMENT_URL,
    })).rejects.toThrow('属していません');
  });
});

describe('content:checkコマンド', () => {
  it('必須引数、full、outputを解釈する', () => {
    expect(parseContentCheckArgs([
      '--source=osaka-digital-rss',
      `--url=${DOCUMENT_URL}`,
      '--full',
      '--output=data/logs/content-check/result.json',
    ])).toEqual({
      sourceId: 'osaka-digital-rss',
      url: DOCUMENT_URL,
      full: true,
      outputPath: 'data/logs/content-check/result.json',
    });
    expect(parseContentCheckArgs([
      '--source=osaka-digital-rss',
      `--url=${DOCUMENT_URL}`,
      '--output',
    ])).toEqual({
      sourceId: 'osaka-digital-rss',
      url: DOCUMENT_URL,
      full: false,
      outputPath: 'data/logs/content-check/osaka-digital-rss.json',
    });
  });

  it('必須引数の欠落、重複、不正URLを拒否する', () => {
    expect(() => parseContentCheckArgs([])).toThrow('--source');
    expect(() => parseContentCheckArgs(['--source', 'source'])).toThrow('--url');
    expect(() => parseContentCheckArgs([
      '--source',
      'source',
      '--source=other',
      '--url',
      DOCUMENT_URL,
    ])).toThrow('--source は1回');
    expect(() => parseContentCheckArgs([
      '--source',
      'source',
      '--url',
      'file:///tmp/example.html',
    ])).toThrow('http または https');
  });

  it('保存レポートに本文全文を含めずプレビューだけを残す', () => {
    const document = makeExtractedDocument();
    const report = createContentCheckReport(
      { sourceId: 'source', url: DOCUMENT_URL, full: true },
      document,
      undefined,
      new Date('2026-08-05T01:02:03.000Z'),
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-08-05T01:02:03.000Z',
      status: 'ok',
      exitCode: 0,
      sourceId: 'source',
    });
    expect(report.result?.bodyPreview.endsWith('…')).toBe(true);
    expect(report.result).not.toHaveProperty('bodyText');
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source',
    organization_id: 'osaka-city',
    name: '大阪市の情報源',
    url: 'https://www.city.osaka.lg.jp/source',
    collector_type: 'rss',
    source_category: 'digital_news',
    priority: 'high',
    enabled: true,
    content_selector: 'main',
    ...overrides,
  };
}

function makeOrganization(): Organization {
  return {
    id: 'osaka-city',
    name: '大阪市',
    organization_type: 'designated_city',
    official_domain: OFFICIAL_DOMAIN,
    enabled: true,
  };
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

function makeExtractedDocument(): ExtractedDocument {
  const bodyText = '保存しない本文です。'.repeat(80);
  return {
    sourceId: 'source',
    sourceEnabled: true,
    requestedUrl: DOCUMENT_URL,
    url: DOCUMENT_URL,
    httpStatus: 200,
    contentType: 'text/html',
    responseBytes: 1000,
    durationMs: 1,
    redirectCount: 0,
    title: '案件',
    bodyText,
    bodyLength: bodyText.length,
    publishedAtCandidate: '2026-08-05',
    publishedAtSource: 'time',
    pdfUrls: [],
    pdfLinks: [],
    contentSelectorConfigured: 'main',
    contentSelectorUsed: 'main',
    usedFallback: false,
    warnings: [],
  };
}
