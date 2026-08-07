import type { Organization, Source } from '../source-registry/schema.ts';
import { safeFetchBytes } from '../source-check/fetch.ts';
import type { FetchedBytes } from '../source-check/types.ts';
import { extractPdfFromBytes } from './extract.ts';
import type {
  ExtractedPdf,
  PdfExtractionWarning,
} from './types.ts';

export { extractPdfFromBytes, hasPdfHeader, normalizePdfPageText } from './extract.ts';
export type {
  ExtractedPdf,
  PdfCheckReport,
  PdfExtractionResult,
} from './types.ts';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const PDF_FETCH_TIMEOUT_MS = 30_000;

export type FetchAndExtractPdfInput = {
  source: Source;
  organization: Organization;
  url: string;
  /**
   * 親組織など、添付PDFの取得時にだけ追加で許可するドメイン。
   * `getTrustedAttachmentDomains` の結果を渡す。省略時は組織自身のドメインのみ許可する。
   */
  trustedPdfDomains?: readonly string[];
};

export type PdfFetchRequest = {
  url: string;
  officialDomain: string;
  /** officialDomain に加えて許可するドメイン。 */
  trustedPdfDomains: readonly string[];
};

export type PdfFetcher = (request: PdfFetchRequest) => Promise<FetchedBytes>;

export type PdfCheckDependencies = {
  fetchPdf?: PdfFetcher;
  extractPdf?: typeof extractPdfFromBytes;
};

export async function fetchAndExtractPdf(
  input: FetchAndExtractPdfInput,
  dependencies: PdfCheckDependencies = {},
): Promise<ExtractedPdf> {
  if (input.source.organization_id !== input.organization.id) {
    throw new Error(
      `情報源「${input.source.id}」は組織「${input.organization.id}」に属していません。`,
    );
  }

  const fetchPdf = dependencies.fetchPdf ?? defaultFetchPdf;
  const extractPdf = dependencies.extractPdf ?? extractPdfFromBytes;
  const fetched = await fetchPdf({
    url: removeFragment(input.url),
    officialDomain: input.organization.official_domain,
    trustedPdfDomains: input.trustedPdfDomains ?? [],
  });
  const contentType = requirePdfContentType(fetched.contentType);
  const extraction = await extractPdf(fetched.bytes);
  const warnings: PdfExtractionWarning[] = [...extraction.warnings];
  if (!input.source.enabled) {
    warnings.unshift({
      code: 'source_disabled',
      message: '情報源が enabled: false のため、参考情報源として確認しています。',
    });
  }
  if (!input.organization.enabled) {
    warnings.unshift({
      code: 'organization_disabled',
      message: '組織が enabled: false のため、参考組織として確認しています。',
    });
  }

  return {
    ...extraction,
    warnings,
    sourceId: input.source.id,
    sourceEnabled: input.source.enabled,
    requestedUrl: input.url,
    url: fetched.finalUrl,
    httpStatus: fetched.httpStatus,
    contentType,
    responseBytes: fetched.responseBytes,
    durationMs: fetched.durationMs,
    redirectCount: fetched.redirectCount,
  };
}

async function defaultFetchPdf(request: PdfFetchRequest): Promise<FetchedBytes> {
  return safeFetchBytes(request.url, {
    // 添付PDFの取得だけ、組織自身に加えて親組織のドメインを許可する。
    // SSRF検査とリダイレクト各ホップの再検査は safeFetchBytes 側でそのまま行う。
    officialDomain: [request.officialDomain, ...request.trustedPdfDomains],
    accept: 'application/pdf',
    timeoutMs: PDF_FETCH_TIMEOUT_MS,
    maxBytes: MAX_PDF_BYTES,
    userAgent: process.env.PDF_CHECK_USER_AGENT
      ?? process.env.SOURCE_CHECK_USER_AGENT
      ?? 'administrative-needs-prototype/0.1 pdf-check',
  });
}

function requirePdfContentType(contentType: string | null): string {
  if (contentType === null) throw new Error('Content-TypeヘッダーがないためPDFと確認できません。');
  const mediaType = contentType.split(';', 1)[0]?.trim().toLocaleLowerCase('en');
  if (mediaType !== 'application/pdf') {
    throw new Error(`PDFではないContent-Typeです: ${contentType}`);
  }
  return contentType;
}

function removeFragment(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}
