import {
  fetchAndExtractDocument,
  type FetchAndExtractDocumentInput,
} from '../content-check/index.ts';
import type { ExtractedDocument, PdfLink } from '../content-check/types.ts';
import {
  fetchAndExtractPdf,
  type FetchAndExtractPdfInput,
} from '../pdf-check/index.ts';
import type { ExtractedPdf } from '../pdf-check/types.ts';
import type { Organization, Source } from '../source-registry/schema.ts';
import { describePdfLink, selectPdfsByPriority } from './pdf-priority.ts';
import {
  DEFAULT_AI_INPUT_LIMITS,
  prepareAnalysisInput,
  validateEvidenceQuotes,
  type AiInputLimits,
} from './input.ts';
import type {
  AdministrativeNeedAnalyzer,
  AiCheckResult,
  AiCheckWarning,
  AnalysisPdfDocument,
  CompanyFitCriteria,
} from './types.ts';

export type AiCheckInput = {
  source: Source;
  organization: Organization;
  url: string;
  noPdf: boolean;
  analyzer: AdministrativeNeedAnalyzer;
  companyFitCriteria: CompanyFitCriteria;
  limits?: AiInputLimits;
  /**
   * 添付PDFの取得時にだけ追加で許可するドメイン（親組織の公式ドメインなど）。
   * 記事HTML取得と候補抽出には使わないので、収集対象は広がらない。
   */
  trustedPdfDomains?: readonly string[];
};

export type ContentExtractor = (
  input: FetchAndExtractDocumentInput,
) => Promise<ExtractedDocument>;
export type PdfExtractor = (input: FetchAndExtractPdfInput) => Promise<ExtractedPdf>;

export type AiCheckDependencies = {
  extractContent?: ContentExtractor;
  extractPdf?: PdfExtractor;
};

export async function checkAdministrativeNeed(
  input: AiCheckInput,
  dependencies: AiCheckDependencies = {},
): Promise<AiCheckResult> {
  const extractContent = dependencies.extractContent ?? fetchAndExtractDocument;
  const extractPdf = dependencies.extractPdf ?? fetchAndExtractPdf;
  const limits = input.limits ?? DEFAULT_AI_INPUT_LIMITS;
  const document = await extractContent({
    source: input.source,
    organization: input.organization,
    url: input.url,
  });
  const warnings: AiCheckWarning[] = document.warnings.map((message) => ({
    code: 'content_warning',
    message,
  }));

  const pdfLinks = deduplicatePdfLinks(document.pdfLinks);
  const selectedPdfLinks = input.noPdf ? [] : selectPdfsByPriority(pdfLinks, limits.maxPdfs);
  if (!input.noPdf && pdfLinks.length > selectedPdfLinks.length) {
    const selectedLabels = selectedPdfLinks.map((link) => describePdfLink(link)).join(' / ');
    warnings.push({
      code: 'pdf_limit',
      message: `検出したPDF ${pdfLinks.length}件から、優先度に基づき${selectedPdfLinks.length}件を解析します: ${selectedLabels}`,
    });
  }

  // 選ばなかったPDFを記録する。優先度で外したものと件数上限で外したものの両方が入る。
  const selectedUrls = new Set(selectedPdfLinks.map((link) => link.url));
  const pdfSkipped = pdfLinks
    .filter((link) => !selectedUrls.has(link.url))
    .map((link) => ({ label: describePdfLink(link), url: link.url }));

  const pdfDocuments: AnalysisPdfDocument[] = [];
  // pdfDocuments と同じ並びを保つため、取得に成功したものだけ同時に push する。
  const pdfLabels: string[] = [];
  for (const link of selectedPdfLinks) {
    const { url } = link;
    try {
      const pdf = await extractPdf({
        source: input.source,
        organization: input.organization,
        url,
        trustedPdfDomains: input.trustedPdfDomains ?? [],
      });
      pdfDocuments.push({ url: pdf.url, text: pdf.text });
      pdfLabels.push(describePdfLink(link));
      for (const warning of pdf.warnings) {
        warnings.push({
          code: 'pdf_warning',
          message: `${pdf.url}: ${warning.message}`,
          // 内訳コードを残し、文字間空白（NOTICE）と抽出欠落（WARNING）を区別できるようにする。
          detail: warning.code,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push({
        code: 'pdf_failed',
        message: `PDF本文を取得できないためHTMLだけで続行します: ${url}: ${detail}`,
      });
    }
  }

  const prepared = prepareAnalysisInput({
    title: document.title,
    officialUrl: document.url,
    organizationName: input.organization.name,
    sourceName: input.source.name,
    htmlText: document.bodyText,
    pdfDocuments,
    pdfDiscovered: pdfLinks.length,
    pdfAttempted: selectedPdfLinks.length,
    companyFitCriteria: input.companyFitCriteria,
    limits,
    pdfLabels,
    pdfSkipped,
  });
  warnings.push(...prepared.warnings);
  const analysis = await input.analyzer.analyze(prepared.input);
  const analyzerRunInfo = input.analyzer.getLastRunInfo?.();
  if ((analyzerRunInfo?.jsonParseRetryCount ?? 0) > 0) {
    warnings.push({
      code: 'ai_json_parse_retry',
      message: '初回の行政ニーズJSONを解析できなかったため、Claude CLIを1回再試行して成功しました。',
    });
  }
  const evidence = validateEvidenceQuotes(analysis, prepared.input);
  warnings.push(...evidence.warnings);

  return {
    sourceId: input.source.id,
    sourceName: input.source.name,
    organizationName: input.organization.name,
    title: document.title,
    requestedUrl: input.url,
    officialUrl: document.url,
    provider: input.analyzer.provider,
    model: input.analyzer.model,
    analysis,
    inputSummary: prepared.summary,
    // Providerがusageを返さない場合は undefined のままにする（表示側で省略する）。
    ...(analyzerRunInfo?.inputTokens === undefined
      ? {}
      : { inputTokens: analyzerRunInfo.inputTokens }),
    evidenceMatched: evidence.matched,
    warnings,
  };
}

/** アンカーの違いを無視して同一PDFを1件に畳む。最初に現れたリンクテキストを残す。 */
function deduplicatePdfLinks(links: readonly PdfLink[]): PdfLink[] {
  const seen = new Set<string>();
  const result: PdfLink[] = [];
  for (const link of links) {
    const url = new URL(link.url);
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    result.push({ url: url.href, text: link.text });
  }
  return result;
}
