import type {
  AdministrativeNeedAnalysis,
  AdministrativeNeedAnalysisInput,
  AiCheckWarning,
  AiInputSummary,
  AnalysisPdfDocument,
  CompanyFitCriteria,
} from './types.ts';
import { AiConfigurationError } from './errors.ts';

export const DEFAULT_AI_INPUT_LIMITS = {
  htmlCharacters: 30_000,
  pdfCharacters: 50_000,
  maxPdfs: 3,
} as const;

export type AiInputLimits = {
  htmlCharacters: number;
  pdfCharacters: number;
  maxPdfs: number;
};

export function aiInputLimitsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AiInputLimits {
  return {
    htmlCharacters: parseLimit(
      env.AI_MAX_HTML_CHARACTERS,
      DEFAULT_AI_INPUT_LIMITS.htmlCharacters,
      'AI_MAX_HTML_CHARACTERS',
      1_000,
      200_000,
    ),
    pdfCharacters: parseLimit(
      env.AI_MAX_PDF_CHARACTERS,
      DEFAULT_AI_INPUT_LIMITS.pdfCharacters,
      'AI_MAX_PDF_CHARACTERS',
      1_000,
      500_000,
    ),
    maxPdfs: parseLimit(
      env.AI_MAX_PDFS,
      DEFAULT_AI_INPUT_LIMITS.maxPdfs,
      'AI_MAX_PDFS',
      1,
      10,
    ),
  };
}

export type PrepareAnalysisInputOptions = {
  title: string;
  officialUrl: string;
  organizationName: string;
  sourceName: string;
  htmlText: string;
  pdfDocuments: AnalysisPdfDocument[];
  pdfDiscovered: number;
  pdfAttempted: number;
  companyFitCriteria: CompanyFitCriteria;
  limits?: AiInputLimits;
};

export function prepareAnalysisInput(options: PrepareAnalysisInputOptions): {
  input: AdministrativeNeedAnalysisInput;
  summary: AiInputSummary;
  warnings: AiCheckWarning[];
} {
  const limits = options.limits ?? DEFAULT_AI_INPUT_LIMITS;
  const warnings: AiCheckWarning[] = [];
  const html = truncateHeadTail(options.htmlText, limits.htmlCharacters);
  if (html.truncated) {
    warnings.push({
      code: 'html_truncated',
      message: `HTML本文を ${options.htmlText.length} 文字から ${html.text.length} 文字へ切り詰めました。`,
    });
  }

  const pdfOriginalCharacters = options.pdfDocuments.reduce(
    (total, document) => total + document.text.length,
    0,
  );
  const documentLimits = allocateCharacterLimits(
    options.pdfDocuments.map((document) => document.text.length),
    limits.pdfCharacters,
  );
  const pdfDocuments: AnalysisPdfDocument[] = [];
  let pdfWasTruncated = false;
  for (const [index, document] of options.pdfDocuments.entries()) {
    const documentLimit = documentLimits[index] ?? 0;
    const truncated = truncateHeadTail(document.text, documentLimit);
    pdfDocuments.push({ url: document.url, text: truncated.text });
    pdfWasTruncated ||= truncated.truncated;
  }
  const pdfSentCharacters = pdfDocuments.reduce(
    (total, document) => total + document.text.length,
    0,
  );
  if (pdfWasTruncated) {
    warnings.push({
      code: 'pdf_truncated',
      message: `PDF本文合計を ${pdfOriginalCharacters} 文字から ${pdfSentCharacters} 文字へ切り詰めました。`,
    });
  }

  return {
    input: {
      title: options.title,
      officialUrl: options.officialUrl,
      organizationName: options.organizationName,
      sourceName: options.sourceName,
      htmlText: html.text,
      pdfDocuments,
      companyFitCriteria: options.companyFitCriteria,
    },
    summary: {
      htmlOriginalCharacters: options.htmlText.length,
      htmlSentCharacters: html.text.length,
      pdfDiscovered: options.pdfDiscovered,
      pdfAttempted: options.pdfAttempted,
      pdfIncluded: pdfDocuments.length,
      pdfOriginalCharacters,
      pdfSentCharacters,
    },
    warnings,
  };
}

export function truncateHeadTail(value: string, maxCharacters: number): {
  text: string;
  truncated: boolean;
} {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error('文字数上限は1以上の整数にしてください。');
  }
  if (value.length <= maxCharacters) return { text: value, truncated: false };

  const marker = '\n\n[...中間部分を省略...]\n\n';
  if (marker.length >= maxCharacters) {
    return { text: value.slice(0, maxCharacters), truncated: true };
  }
  const available = maxCharacters - marker.length;
  const headLength = Math.ceil(available * 0.7);
  const tailLength = available - headLength;
  return {
    text: `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`,
    truncated: true,
  };
}

export function validateEvidenceQuotes(
  analysis: AdministrativeNeedAnalysis,
  input: AdministrativeNeedAnalysisInput,
): { matched: number; warnings: AiCheckWarning[] } {
  const sources = new Map<string, string>();
  sources.set(`html\0${input.officialUrl}`, normalizeForEvidence(input.htmlText));
  for (const pdf of input.pdfDocuments) {
    sources.set(`pdf\0${pdf.url}`, normalizeForEvidence(pdf.text));
  }

  let matched = 0;
  const warnings: AiCheckWarning[] = [];
  for (const evidence of analysis.evidence_quotes) {
    const source = sources.get(`${evidence.source_type}\0${evidence.source_url}`);
    const quote = normalizeForEvidence(evidence.quote);
    if (source !== undefined && quote !== '' && source.includes(quote)) {
      matched += 1;
      continue;
    }
    warnings.push({
      code: 'evidence_not_found',
      message: `根拠引用を入力原文で確認できませんでした: ${evidence.source_url}`,
    });
  }
  return { matched, warnings };
}

function normalizeForEvidence(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function allocateCharacterLimits(lengths: number[], totalLimit: number): number[] {
  if (lengths.length === 0) return [];
  if (lengths.reduce((total, length) => total + length, 0) <= totalLimit) {
    return [...lengths];
  }

  const limits = Array.from({ length: lengths.length }, () => 0);
  const remainingIndexes = new Set(lengths.map((_length, index) => index));
  let remainingLimit = totalLimit;
  while (remainingIndexes.size > 0) {
    const share = Math.floor(remainingLimit / remainingIndexes.size);
    const fitting = [...remainingIndexes].filter((index) => lengths[index]! <= share);
    if (fitting.length === 0) {
      for (const index of remainingIndexes) {
        limits[index] = share;
      }
      let remainder = remainingLimit - share * remainingIndexes.size;
      for (const index of remainingIndexes) {
        if (remainder === 0) break;
        limits[index]! += 1;
        remainder -= 1;
      }
      break;
    }
    for (const index of fitting) {
      limits[index] = lengths[index]!;
      remainingLimit -= lengths[index]!;
      remainingIndexes.delete(index);
    }
  }
  return limits;
}

function parseLimit(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AiConfigurationError(
      `${name} は ${minimum} から ${maximum} の整数で指定してください。`,
    );
  }
  return parsed;
}
