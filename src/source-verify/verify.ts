import {
  checkAdministrativeNeed,
  type ContentExtractor,
  type PdfExtractor,
} from '../ai/check.ts';
import type { AiInputLimits } from '../ai/input.ts';
import type {
  AdministrativeNeedAnalyzer,
  CompanyFitCriteria,
} from '../ai/types.ts';
import { fetchAndExtractDocument } from '../content-check/index.ts';
import type { ExtractedDocument } from '../content-check/types.ts';
import { fetchAndExtractPdf } from '../pdf-check/index.ts';
import type { ExtractedPdf } from '../pdf-check/types.ts';
import type { SourceCheckSample } from '../source-check/types.ts';
import type { Organization, Source } from '../source-registry/schema.ts';
import type {
  ContentVerificationSnapshot,
  SourceVerifyItemResult,
  SourceVerifyReport,
} from './types.ts';

export type SourceVerificationDependencies = {
  checkNeed?: typeof checkAdministrativeNeed;
  extractContent?: ContentExtractor;
  extractPdf?: PdfExtractor;
};

export type SourceVerificationResultHandler = (
  result: SourceVerifyItemResult,
  index: number,
  total: number,
) => void;

export type VerifySourceCandidatesInput = {
  source: Source;
  organization: Organization;
  candidatesFound: number;
  candidates: SourceCheckSample[];
  analyzer: AdministrativeNeedAnalyzer;
  companyFitCriteria: CompanyFitCriteria;
  limits?: AiInputLimits;
};

export async function verifySourceCandidates(
  input: VerifySourceCandidatesInput,
  dependencies: SourceVerificationDependencies = {},
  onResult: SourceVerificationResultHandler = () => undefined,
): Promise<SourceVerifyReport> {
  const checkNeed = dependencies.checkNeed ?? checkAdministrativeNeed;
  const extractContent = dependencies.extractContent ?? fetchAndExtractDocument;
  const extractPdf = dependencies.extractPdf ?? fetchAndExtractPdf;
  const results: SourceVerifyItemResult[] = [];

  for (const [index, candidate] of input.candidates.entries()) {
    let document: ExtractedDocument | undefined;
    const extractedPdfs: ExtractedPdf[] = [];
    let item: SourceVerifyItemResult;
    try {
      const result = await checkNeed({
        source: input.source,
        organization: input.organization,
        url: candidate.url,
        noPdf: false,
        analyzer: input.analyzer,
        companyFitCriteria: input.companyFitCriteria,
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      }, {
        extractContent: async (request) => {
          document = await extractContent(request);
          return document;
        },
        extractPdf: async (request) => {
          const pdf = await extractPdf(request);
          extractedPdfs.push(pdf);
          return pdf;
        },
      });
      item = { status: 'succeeded', candidate, result };
    } catch (error) {
      item = {
        status: 'failed',
        candidate,
        stage: document === undefined ? 'content' : 'ai',
        message: verificationErrorMessage(error),
        ...(document === undefined
          ? {}
          : { content: contentSnapshot(document, extractedPdfs) }),
      };
    }
    results.push(item);
    onResult(item, index + 1, input.candidates.length);
  }

  return {
    sourceId: input.source.id,
    candidatesFound: input.candidatesFound,
    samplesSelected: input.candidates.length,
    results,
  };
}

function contentSnapshot(
  document: ExtractedDocument,
  pdfs: ExtractedPdf[],
): ContentVerificationSnapshot {
  return {
    htmlCharacters: document.bodyLength,
    pdfDiscovered: new Set(document.pdfUrls.map(withoutHash)).size,
    pdfExtracted: pdfs.length,
    pdfCharacters: pdfs.reduce((total, pdf) => total + pdf.characterCount, 0),
  };
}

function withoutHash(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function verificationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
