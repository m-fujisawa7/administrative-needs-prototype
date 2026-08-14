import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  createPdfCheckReport,
  formatPdfCheckResult,
  parsePdfCheckArgs,
} from '../src/commands/pdf-check.ts';
import {
  extractPdfFromBytes,
  hasPdfHeader,
  type PdfDocumentLike,
  type PdfParserDependencies,
} from '../src/pdf-check/extract.ts';
import {
  fetchAndExtractPdf,
  type PdfFetcher,
} from '../src/pdf-check/index.ts';
import type {
  ExtractedPdf,
  PdfExtractionResult,
} from '../src/pdf-check/types.ts';
import type { FetchedBytes } from '../src/source-check/types.ts';
import type { Organization, Source } from '../src/source-registry/schema.ts';

const PDF_URL = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000684/684546/01_youryou5.pdf';
const OFFICIAL_DOMAIN = 'city.osaka.lg.jp';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nfixture');

describe('PDFテキスト抽出', () => {
  it('実取得fixtureからページ別テキストと件数を取得する', async () => {
    const bytes = new Uint8Array(await readFile(new URL('fixtures/youryou.pdf', import.meta.url)));
    const result = await extractPdfFromBytes(bytes);

    expect(result.pageCount).toBe(4);
    expect(result.pageTexts).toHaveLength(4);
    expect(result.pagesWithText).toBe(4);
    expect(result.emptyPageCount).toBe(0);
    expect(result.characterCount).toBeGreaterThan(4_000);
    expect(result.text).toContain('大阪市');
  });

  it('Content-TypeだけではなくPDFヘッダーを必須にする', async () => {
    expect(hasPdfHeader(new TextEncoder().encode('prefix %PDF-1.7'))).toBe(true);
    expect(hasPdfHeader(new TextEncoder().encode('<html>not pdf</html>'))).toBe(false);
    await expect(extractPdfFromBytes(new TextEncoder().encode('<html>not pdf</html>')))
      .rejects.toThrow('PDFヘッダー');
  });

  it('ページ単位の空白を正規化し、空ページをWarningにする', async () => {
    const result = await extractPdfFromBytes(PDF_BYTES, {
      parser: parserFor(['  1ページ目  \r\n\r\n\r\n本文  ', '   ']),
    });

    expect(result.pageTexts).toEqual(['1ページ目\n\n本文', '']);
    expect(result.pagesWithText).toBe(1);
    expect(result.emptyPageCount).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toContain('empty_pages');
  });

  it('日本語の文字間空白が多い場合はWarningにする', async () => {
    const spacedJapanese = '大 阪 市 行 政 情 報 提 供 依 頼 事 業 詳 細';
    const result = await extractPdfFromBytes(PDF_BYTES, {
      parser: parserFor([spacedJapanese]),
    });

    expect(result.warnings.map((warning) => warning.code))
      .toContain('japanese_character_spacing');
  });

  it('全ページが空、ページ上限超過、解析タイムアウトを分類して拒否する', async () => {
    await expect(extractPdfFromBytes(PDF_BYTES, {
      parser: parserFor(['', '']),
    })).rejects.toMatchObject({ code: 'no_text' });

    await expect(extractPdfFromBytes(PDF_BYTES, {
      maxPages: 1,
      parser: parserFor(['ページ1', 'ページ2']),
    })).rejects.toMatchObject({ code: 'too_many_pages' });

    const neverOpens: PdfParserDependencies = {
      openDocument: async () => new Promise<PdfDocumentLike>(() => undefined),
      extractPageTexts: async () => [],
    };
    await expect(extractPdfFromBytes(PDF_BYTES, {
      timeoutMs: 5,
      parser: neverOpens,
    })).rejects.toMatchObject({ code: 'parse_timeout' });
  });

  it('パスワード保護PDFを専用コードと原因の分かる文言で拒否する', async () => {
    // PDF.jsは name=PasswordException / code=1(NEED_PASSWORD) で投げる。
    const passwordException = Object.assign(new Error('No password given'), {
      name: 'PasswordException',
      code: 1,
    });
    const locked: PdfParserDependencies = {
      openDocument: async () => {
        throw passwordException;
      },
      extractPageTexts: async () => [],
    };

    const error = await extractPdfFromBytes(PDF_BYTES, { parser: locked })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'password_protected' });
    expect((error as Error).message).toContain('パスワード');
    // 解除や推測は行わないので、元の例外は cause として残すだけにする。
    expect((error as Error).cause).toBe(passwordException);
  });

  it('パスワード保護の判定はメッセージ表記に依存しない', async () => {
    for (const message of ['No password given', 'Incorrect Password']) {
      const locked: PdfParserDependencies = {
        openDocument: async () => {
          throw Object.assign(new Error(message), { name: 'PasswordException' });
        },
        extractPageTexts: async () => [],
      };
      await expect(extractPdfFromBytes(PDF_BYTES, { parser: locked }))
        .rejects.toMatchObject({ code: 'password_protected' });
    }
  });

  it('パスワード保護以外の解析失敗は従来どおりparse_failedにする', async () => {
    const broken: PdfParserDependencies = {
      openDocument: async () => {
        throw new Error('unexpected parser failure');
      },
      extractPageTexts: async () => [],
    };
    await expect(extractPdfFromBytes(PDF_BYTES, { parser: broken }))
      .rejects.toMatchObject({ code: 'parse_failed' });
  });
});

describe('PDF取得', () => {
  it('台帳の公式ドメインを使い、無効情報源をWarningにする', async () => {
    let requestDomain: string | undefined;
    const fetchPdf: PdfFetcher = async ({ url, officialDomain }) => {
      requestDomain = officialDomain;
      return fetchedPdf(url, 'application/pdf; charset=binary');
    };
    const result = await fetchAndExtractPdf({
      source: makeSource({ enabled: false }),
      organization: makeOrganization(),
      url: `${PDF_URL}#page=2`,
    }, {
      fetchPdf,
      extractPdf: async () => extraction(['本文']),
    });

    expect(requestDomain).toBe(OFFICIAL_DOMAIN);
    expect(result.requestedUrl).toBe(`${PDF_URL}#page=2`);
    expect(result.url).toBe(PDF_URL);
    expect(result.warnings.map((warning) => warning.code)).toContain('source_disabled');
  });

  it('PDF以外のContent-Typeとsource・organization不一致を拒否する', async () => {
    const fetchPdf: PdfFetcher = async ({ url }) => fetchedPdf(url, 'text/html');
    await expect(fetchAndExtractPdf({
      source: makeSource(),
      organization: makeOrganization(),
      url: PDF_URL,
    }, { fetchPdf })).rejects.toThrow('PDFではないContent-Type');

    await expect(fetchAndExtractPdf({
      source: makeSource({ organization_id: 'other-city' }),
      organization: makeOrganization(),
      url: PDF_URL,
    })).rejects.toThrow('属していません');
  });
});

describe('pdf:checkコマンド', () => {
  it('必須引数、full、outputを解釈する', () => {
    expect(parsePdfCheckArgs([
      '--source=osaka-digital-rss',
      `--url=${PDF_URL}`,
      '--full',
      '--output=data/logs/pdf-check/result.json',
    ])).toEqual({
      sourceId: 'osaka-digital-rss',
      url: PDF_URL,
      full: true,
      outputPath: 'data/logs/pdf-check/result.json',
    });
    expect(parsePdfCheckArgs([
      '--source=osaka-digital-rss',
      `--url=${PDF_URL}`,
      '--output',
    ])).toEqual({
      sourceId: 'osaka-digital-rss',
      url: PDF_URL,
      full: false,
      outputPath: 'data/logs/pdf-check/osaka-digital-rss.json',
    });
  });

  it('必須引数の欠落、重複、不正URLを拒否する', () => {
    expect(() => parsePdfCheckArgs([])).toThrow('--source');
    expect(() => parsePdfCheckArgs(['--source', 'source'])).toThrow('--url');
    expect(() => parsePdfCheckArgs([
      '--source',
      'source',
      '--url',
      PDF_URL,
      '--url=https://example.com/other.pdf',
    ])).toThrow('--url は1回');
    expect(() => parsePdfCheckArgs([
      '--source',
      'source',
      '--url',
      'file:///tmp/example.pdf',
    ])).toThrow('http または https');
  });

  it('保存レポートにPDF本文・ページ本文を含めない', () => {
    const pdf = makeExtractedPdf();
    const report = createPdfCheckReport(
      { sourceId: 'source', url: PDF_URL, full: true },
      pdf,
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
    expect(report.result?.textPreview.endsWith('…')).toBe(true);
    expect(report.result?.pageCharacterCounts).toEqual(pdf.pageTexts.map((text) => text.length));
    expect(report.result).not.toHaveProperty('text');
    expect(report.result).not.toHaveProperty('pageTexts');
  });

  it('--full指定時だけ本文全文を表示する', () => {
    const pdf = makeExtractedPdf();
    expect(formatPdfCheckResult(pdf, false)).not.toContain(pdf.text);
    expect(formatPdfCheckResult(pdf, true)).toContain(pdf.text);
  });
});

function parserFor(pageTexts: string[]): PdfParserDependencies {
  return {
    openDocument: async () => ({
      numPages: pageTexts.length,
      cleanup: async () => undefined,
    }),
    extractPageTexts: async () => pageTexts,
  };
}

function extraction(pageTexts: string[]): PdfExtractionResult {
  const text = pageTexts.join('\n\n');
  return {
    parser: 'unpdf',
    pageCount: pageTexts.length,
    pageTexts,
    text,
    characterCount: text.length,
    pagesWithText: pageTexts.filter((pageText) => pageText !== '').length,
    emptyPageCount: pageTexts.filter((pageText) => pageText === '').length,
    warnings: [],
  };
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

function fetchedPdf(url: string, contentType: string): FetchedBytes {
  return {
    originalUrl: url,
    finalUrl: url,
    httpStatus: 200,
    contentType,
    bytes: PDF_BYTES,
    responseBytes: PDF_BYTES.byteLength,
    durationMs: 1,
    redirectCount: 0,
  };
}

function makeExtractedPdf(): ExtractedPdf {
  const pageTexts = ['保存しないPDF本文です。'.repeat(80), '2ページ目'];
  return {
    ...extraction(pageTexts),
    sourceId: 'source',
    sourceEnabled: true,
    requestedUrl: PDF_URL,
    url: PDF_URL,
    httpStatus: 200,
    contentType: 'application/pdf',
    responseBytes: 1_000,
    durationMs: 1,
    redirectCount: 0,
  };
}
