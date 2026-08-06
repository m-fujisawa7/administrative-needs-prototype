import {
  fetchAndExtractDocument,
  type FetchAndExtractDocumentInput,
} from '../content-check/index.ts';
import type { ExtractedDocument } from '../content-check/types.ts';
import {
  fetchAndExtractPdf,
  type FetchAndExtractPdfInput,
} from '../pdf-check/index.ts';
import type { ExtractedPdf } from '../pdf-check/types.ts';
import type { Organization, Source } from '../source-registry/schema.ts';
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

  const pdfUrls = deduplicatePdfUrls(document.pdfUrls);
  const selectedPdfUrls = input.noPdf ? [] : pdfUrls.slice(0, limits.maxPdfs);
  if (!input.noPdf && pdfUrls.length > selectedPdfUrls.length) {
    warnings.push({
      code: 'pdf_limit',
      message: `検出したPDF ${pdfUrls.length}件のうち、先頭${selectedPdfUrls.length}件だけを解析します。`,
    });
  }

  const pdfDocuments: AnalysisPdfDocument[] = [];
  for (const url of selectedPdfUrls) {
    try {
      const pdf = await extractPdf({
        source: input.source,
        organization: input.organization,
        url,
      });
      pdfDocuments.push({ url: pdf.url, text: pdf.text });
      for (const warning of pdf.warnings) {
        warnings.push({
          code: 'pdf_warning',
          message: `${pdf.url}: ${warning.message}`,
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
    pdfDiscovered: pdfUrls.length,
    pdfAttempted: selectedPdfUrls.length,
    companyFitCriteria: input.companyFitCriteria,
    limits,
  });
  warnings.push(...prepared.warnings);
  const analysis = await input.analyzer.analyze(prepared.input);
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
    evidenceMatched: evidence.matched,
    warnings,
  };
}

function deduplicatePdfUrls(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const url = new URL(value);
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    result.push(url.href);
  }
  return result;
}
