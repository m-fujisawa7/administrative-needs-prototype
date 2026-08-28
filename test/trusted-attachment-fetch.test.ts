import { describe, expect, it } from 'vitest';
import { fetchAndExtractDocument } from '../src/content-check/index.ts';
import { fetchAndExtractPdf, type PdfFetcher } from '../src/pdf-check/index.ts';
import { getTrustedAttachmentDomains } from '../src/source-registry/domains.ts';
import type { Organization, Source } from '../src/source-registry/schema.ts';
import { safeFetchBytes, safeFetchText } from '../src/source-check/fetch.ts';
import { analyzeListPage } from '../src/source-check/list-page-checker.ts';
import { analyzeRss } from '../src/source-check/rss-checker.ts';

const HATCH_DOMAIN = 'hatch-tech-nagoya.jp';
const PARENT_DOMAIN = 'city.nagoya.jp';
const WATERWORKS_DOMAIN = 'kumamoto-waterworks.jp';
const WATERWORKS_PDF_HOST = '99ev2jtm.user.webaccel.jp';

const NAGOYA_CITY: Organization = {
  id: 'nagoya-city',
  name: '名古屋市',
  organization_type: 'designated_city',
  official_domain: PARENT_DOMAIN,
  enabled: true,
};

const HATCH: Organization = {
  id: 'nagoya-city-hatch-tech',
  name: '名古屋市',
  organization_type: 'external_organization',
  official_domain: HATCH_DOMAIN,
  enabled: true,
  parent_organization_id: 'nagoya-city',
};

const OSAKA_CITY: Organization = {
  id: 'osaka-city',
  name: '大阪市',
  organization_type: 'designated_city',
  official_domain: 'city.osaka.lg.jp',
  enabled: true,
};

const KUMAMOTO_WATERWORKS: Organization = {
  id: 'kumamoto-city-waterworks',
  name: '熊本市',
  organization_type: 'external_organization',
  official_domain: WATERWORKS_DOMAIN,
  enabled: true,
};

const REGISTRY = { organizations: [NAGOYA_CITY, HATCH, OSAKA_CITY] };

const HATCH_SOURCE: Source = {
  id: 'nagoya-hatch-tech-solution',
  organization_id: 'nagoya-city-hatch-tech',
  name: 'Hatch Technology NAGOYA 課題提示型',
  url: 'https://www.hatch-tech-nagoya.jp/solution/',
  collector_type: 'list_page',
  source_category: 'public_private_partnership',
  priority: 'high',
  enabled: true,
};

const OSAKA_SOURCE: Source = {
  id: 'osaka-source',
  organization_id: 'osaka-city',
  name: '大阪市の情報源',
  url: 'https://www.city.osaka.lg.jp/example',
  collector_type: 'list_page',
  source_category: 'procurement',
  priority: 'high',
  enabled: true,
};

const WATERWORKS_SOURCE: Source = {
  id: 'kumamoto-waterworks-procurement-rss',
  organization_id: 'kumamoto-city-waterworks',
  name: '熊本市上下水道局 事業者向け新着RSS',
  url: `https://www.${WATERWORKS_DOMAIN}/article_cat/organizer/feed/`,
  collector_type: 'rss',
  source_category: 'procurement',
  priority: 'medium',
  enabled: true,
  trusted_pdf_domains: [WATERWORKS_PDF_HOST],
};

const PUBLIC_RESOLVER = async () => [{ address: '8.8.8.8', family: 4 as const }];
const PRIVATE_RESOLVER = async () => [{ address: '10.0.0.5', family: 4 as const }];
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 dummy');

const pdfResponse = async () => new Response(PDF_BYTES, {
  status: 200,
  headers: { 'content-type': 'application/pdf' },
});

/** 実際の取得経路（pdf-check → safeFetchBytes）でドメイン判定を通す。 */
async function fetchPdfThroughRealPath(
  url: string,
  organization: Organization,
  source: Source,
  resolveHost = PUBLIC_RESOLVER,
): Promise<void> {
  const trustedPdfDomains = getTrustedAttachmentDomains(REGISTRY, organization);
  const fetchPdf: PdfFetcher = async (request) => safeFetchBytes(request.url, {
    officialDomain: [request.officialDomain, ...request.trustedPdfDomains],
    exactHostnames: request.trustedPdfHostnames,
    accept: 'application/pdf',
    resolveHost,
    fetchImpl: pdfResponse,
  });

  await fetchAndExtractPdf({ source, organization, url, trustedPdfDomains }, {
    fetchPdf,
    extractPdf: async () => ({
      parser: 'unpdf',
      pageCount: 1,
      pagesWithText: 1,
      emptyPageCount: 0,
      characterCount: 2,
      text: '本文',
      pageTexts: ['本文'],
      warnings: [],
    }),
  });
}

describe('添付PDF取得: 親組織ドメインの許可', () => {
  it('情報源本体と同じドメインのPDFを取得できる', async () => {
    await expect(fetchPdfThroughRealPath(
      `https://www.${HATCH_DOMAIN}/assets/summary.pdf`,
      HATCH,
      HATCH_SOURCE,
    )).resolves.toBeUndefined();
  });

  it('親組織 city.nagoya.jp のPDFを取得できる', async () => {
    await expect(fetchPdfThroughRealPath(
      `https://${PARENT_DOMAIN}/file/1.pdf`,
      HATCH,
      HATCH_SOURCE,
    )).resolves.toBeUndefined();
  });

  it('www.city.nagoya.jp のPDFを取得できる', async () => {
    await expect(fetchPdfThroughRealPath(
      'https://www.city.nagoya.jp/_res/projects/default_project/_page_/001/013/400/gaiyouban.pdf',
      HATCH,
      HATCH_SOURCE,
    )).resolves.toBeUndefined();
  });

  it('www.water.city.nagoya.jp のPDFを取得できる', async () => {
    await expect(fetchPdfThroughRealPath(
      'https://www.water.city.nagoya.jp/file/54908.pdf',
      HATCH,
      HATCH_SOURCE,
    )).resolves.toBeUndefined();
  });

  it('親組織と無関係な外部ドメインのPDFを拒否する', async () => {
    await expect(fetchPdfThroughRealPath(
      'https://example.com/file.pdf',
      HATCH,
      HATCH_SOURCE,
    )).rejects.toThrow('公式ドメイン');
  });

  it('接尾辞が一致するだけの evil-city.nagoya.jp を拒否する', async () => {
    await expect(fetchPdfThroughRealPath(
      'https://evil-city.nagoya.jp/file.pdf',
      HATCH,
      HATCH_SOURCE,
    )).rejects.toThrow('公式ドメイン');
  });

  it('拒否メッセージに許可ドメインを両方並べる', async () => {
    await expect(fetchPdfThroughRealPath(
      'https://example.com/file.pdf',
      HATCH,
      HATCH_SOURCE,
    )).rejects.toThrow(`${HATCH_DOMAIN} / ${PARENT_DOMAIN}`);
  });

  it('親組織を持たない組織は従来どおり自組織のドメインだけを許可する', async () => {
    await expect(fetchPdfThroughRealPath(
      'https://www.city.osaka.lg.jp/file.pdf',
      OSAKA_CITY,
      OSAKA_SOURCE,
    )).resolves.toBeUndefined();

    await expect(fetchPdfThroughRealPath(
      `https://${PARENT_DOMAIN}/file.pdf`,
      OSAKA_CITY,
      OSAKA_SOURCE,
    )).rejects.toThrow('公式ドメイン');
  });
});

describe('添付PDF取得: Source固有hostの完全一致許可', () => {
  it('trusted_pdf_domainsに完全一致するhostのPDFを取得できる', async () => {
    await expect(fetchPdfThroughRealPath(
      `https://${WATERWORKS_PDF_HOST}/document.pdf`,
      KUMAMOTO_WATERWORKS,
      WATERWORKS_SOURCE,
    )).resolves.toBeUndefined();
  });

  it('trusted_pdf_domainsのサブドメインと別hostは引き続き拒否する', async () => {
    await expect(fetchPdfThroughRealPath(
      `https://sub.${WATERWORKS_PDF_HOST}/document.pdf`,
      KUMAMOTO_WATERWORKS,
      WATERWORKS_SOURCE,
    )).rejects.toThrow('公式ドメイン');

    await expect(fetchPdfThroughRealPath(
      'https://other-cdn.example.jp/document.pdf',
      KUMAMOTO_WATERWORKS,
      WATERWORKS_SOURCE,
    )).rejects.toThrow('公式ドメイン');
  });

  it('trusted_pdf_domainsを設定しても同hostの記事HTML取得は許可しない', async () => {
    await expect(fetchAndExtractDocument({
      source: WATERWORKS_SOURCE,
      organization: KUMAMOTO_WATERWORKS,
      url: `https://${WATERWORKS_PDF_HOST}/article.html`,
    }, {
      fetchDocument: async (request) => safeFetchText(request.url, {
        officialDomain: request.officialDomain,
        accept: 'text/html',
        resolveHost: PUBLIC_RESOLVER,
        fetchImpl: async () => new Response(`<main>${'あ'.repeat(300)}</main>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      }),
    })).rejects.toThrow('公式ドメイン');
  });
});

describe('添付PDF取得: SSRF対策の維持', () => {
  it('信頼済みドメインでも内部IPへ解決されたら拒否する', async () => {
    await expect(fetchPdfThroughRealPath(
      `https://www.${PARENT_DOMAIN}/file.pdf`,
      HATCH,
      HATCH_SOURCE,
      PRIVATE_RESOLVER,
    )).rejects.toThrow('内部・予約済みIPアドレス');
  });

  it('IPアドレス直指定は許可ドメインに一致しないため拒否する', async () => {
    // 許可ドメインはホスト名なので、IPリテラルはドメイン判定の時点で落ちる。
    await expect(fetchPdfThroughRealPath(
      'https://203.0.113.10/file.pdf',
      HATCH,
      HATCH_SOURCE,
    )).rejects.toThrow('公式ドメイン');
  });

  it('リダイレクト先が未許可ドメインなら拒否する', async () => {
    const trustedPdfDomains = getTrustedAttachmentDomains(REGISTRY, HATCH);
    const fetchPdf: PdfFetcher = async (request) => safeFetchBytes(request.url, {
      officialDomain: [request.officialDomain, ...request.trustedPdfDomains],
      exactHostnames: request.trustedPdfHostnames,
      accept: 'application/pdf',
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/leak.pdf' },
      }),
    });

    await expect(fetchAndExtractPdf({
      source: HATCH_SOURCE,
      organization: HATCH,
      url: `https://www.${PARENT_DOMAIN}/file.pdf`,
      trustedPdfDomains,
    }, { fetchPdf })).rejects.toThrow('公式ドメイン');
  });

  it('リダイレクト先が内部IPなら拒否する', async () => {
    const trustedPdfDomains = getTrustedAttachmentDomains(REGISTRY, HATCH);
    const fetchPdf: PdfFetcher = async (request) => safeFetchBytes(request.url, {
      officialDomain: [request.officialDomain, ...request.trustedPdfDomains],
      exactHostnames: request.trustedPdfHostnames,
      accept: 'application/pdf',
      resolveHost: PUBLIC_RESOLVER,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/secret.pdf' },
      }),
    });

    await expect(fetchAndExtractPdf({
      source: HATCH_SOURCE,
      organization: HATCH,
      url: `https://www.${PARENT_DOMAIN}/file.pdf`,
      trustedPdfDomains,
    }, { fetchPdf })).rejects.toThrow('公式ドメイン');
  });
});

describe('収集対象は広がらない', () => {
  it('記事HTML取得は親組織のドメインを許可しない', async () => {
    let requestedDomain: string | readonly string[] | undefined;
    await fetchAndExtractDocument({
      source: HATCH_SOURCE,
      organization: HATCH,
      url: `https://www.${HATCH_DOMAIN}/solution/1/`,
    }, {
      fetchDocument: async (request) => {
        requestedDomain = request.officialDomain;
        return {
          text: `<html><head><title>課題提示型の案件</title></head>`
            + `<body><main>${'あ'.repeat(300)}</main></body></html>`,
          originalUrl: request.url,
          finalUrl: request.url,
          httpStatus: 200,
          contentType: 'text/html; charset=utf-8',
          responseBytes: 100,
          durationMs: 1,
          redirectCount: 0,
        };
      },
    });

    expect(requestedDomain).toBe(HATCH_DOMAIN);
    expect(requestedDomain).not.toContain(PARENT_DOMAIN);
  });

  it('一覧ページの候補抽出は親組織のドメインを候補にしない', () => {
    const html = `<html><body><article>
      <a href="https://www.${HATCH_DOMAIN}/solution/1/">自組織の案件</a>
      <a href="https://www.${PARENT_DOMAIN}/jigyou/1.html">親組織の案件</a>
    </article></body></html>`;
    const report = analyzeListPage(
      html,
      { ...HATCH_SOURCE, link_selector: 'article a' },
      HATCH.official_domain,
      10,
    );
    const urls = report.samples.map((sample) => sample.url);

    expect(urls).toContain(`https://www.${HATCH_DOMAIN}/solution/1/`);
    expect(urls).not.toContain(`https://www.${PARENT_DOMAIN}/jigyou/1.html`);
  });

  it('RSSの候補抽出は親組織のドメインを候補にしない', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
      <item><title>自組織の案件</title>
        <link>https://www.${HATCH_DOMAIN}/solution/1/</link></item>
      <item><title>親組織の案件</title>
        <link>https://www.${PARENT_DOMAIN}/jigyou/1.html</link></item>
    </channel></rss>`;
    const report = analyzeRss(
      xml,
      { ...HATCH_SOURCE, collector_type: 'rss' },
      HATCH.official_domain,
      10,
    );
    const urls = report.samples.map((sample) => sample.url);

    expect(urls).toContain(`https://www.${HATCH_DOMAIN}/solution/1/`);
    expect(urls).not.toContain(`https://www.${PARENT_DOMAIN}/jigyou/1.html`);
  });
});
