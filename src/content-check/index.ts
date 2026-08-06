import type {
  Organization,
  Source,
} from '../source-registry/schema.ts';
import { safeFetchText } from '../source-check/fetch.ts';
import type { FetchedText } from '../source-check/types.ts';
import { extractDocumentFromHtml } from './extract.ts';
import type { ExtractedDocument } from './types.ts';

export { extractDocumentFromHtml } from './extract.ts';
export type {
  ContentCheckReport,
  ContentExtractionResult,
  ExtractedDocument,
} from './types.ts';

export type FetchAndExtractDocumentInput = {
  source: Source;
  organization: Organization;
  url: string;
};

export type DocumentFetchRequest = {
  url: string;
  officialDomain: string;
};

export type DocumentFetcher = (request: DocumentFetchRequest) => Promise<FetchedText>;

export type ContentCheckDependencies = {
  fetchDocument?: DocumentFetcher;
};

export async function fetchAndExtractDocument(
  input: FetchAndExtractDocumentInput,
  dependencies: ContentCheckDependencies = {},
): Promise<ExtractedDocument> {
  if (input.source.organization_id !== input.organization.id) {
    throw new Error(
      `情報源「${input.source.id}」は組織「${input.organization.id}」に属していません。`,
    );
  }

  const fetchDocument = dependencies.fetchDocument ?? defaultFetchDocument;
  const fetched = await fetchDocument({
    url: input.url,
    officialDomain: input.organization.official_domain,
  });
  const contentType = requireHtmlContentType(fetched.contentType);
  const extraction = extractDocumentFromHtml({
    html: fetched.text,
    url: fetched.finalUrl,
    contentSelector: input.source.content_selector,
  });
  const warnings = [...extraction.warnings];
  if (!input.source.enabled) {
    warnings.unshift('情報源が enabled: false のため、参考情報源として確認しています。');
  }
  if (!input.organization.enabled) {
    warnings.unshift('組織が enabled: false のため、参考組織として確認しています。');
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

async function defaultFetchDocument(request: DocumentFetchRequest): Promise<FetchedText> {
  return safeFetchText(request.url, {
    officialDomain: request.officialDomain,
    accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1',
    userAgent: process.env.CONTENT_CHECK_USER_AGENT
      ?? process.env.SOURCE_CHECK_USER_AGENT
      ?? 'administrative-needs-prototype/0.1 content-check',
  });
}

function requireHtmlContentType(contentType: string | null): string {
  if (contentType === null) throw new Error('Content-TypeヘッダーがないためHTMLと確認できません。');
  const normalized = contentType.toLocaleLowerCase('en');
  if (
    !normalized.includes('text/html')
    && !normalized.includes('application/xhtml+xml')
  ) {
    throw new Error(`HTMLではないContent-Typeです: ${contentType}`);
  }
  return contentType;
}
