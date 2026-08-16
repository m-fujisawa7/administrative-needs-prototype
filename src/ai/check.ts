import {
  fetchAndExtractDocument,
  type FetchAndExtractDocumentInput,
} from '../content-check/index.ts';
import type { ExtractedDocument, PdfLink } from '../content-check/types.ts';
import {
  fetchAndExtractPdf,
  type FetchAndExtractPdfInput,
} from '../pdf-check/index.ts';
import { isPasswordProtectedPdfError } from '../pdf-check/index.ts';
import type { ExtractedPdf } from '../pdf-check/types.ts';
import type { Organization, Source } from '../source-registry/schema.ts';
import { pdfContentFingerprint } from './pdf-duplicates.ts';
import { describePdfLink, orderPdfCandidates } from './pdf-priority.ts';
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
  const candidates = input.noPdf ? [] : orderPdfCandidates(pdfLinks);

  const pdfDocuments: AnalysisPdfDocument[] = [];
  // pdfDocuments と同じ並びを保つため、本文が取れたものだけ同時に push する。
  const pdfLabels: string[] = [];
  // 長大PDFのRelevant Chunk選択でページ境界として使う。
  const pdfPageTexts: string[][] = [];
  const usedUrls = new Set<string>();
  // 採用済みPDF本文のfingerprintと、そのPDFの表示ラベル。内容重複の判定に使う。
  const acceptedFingerprints = new Map<string, string>();
  // AI入力枠の消費数。成功と取得失敗は枠を使い、本文0文字と内容重複は使わない。
  let slotsUsed = 0;
  let attempted = 0;

  for (const link of candidates) {
    if (slotsUsed >= limits.maxPdfs) break;
    const { url } = link;
    attempted += 1;
    try {
      const pdf = await extractPdf({
        source: input.source,
        organization: input.organization,
        url,
        trustedPdfDomains: input.trustedPdfDomains ?? [],
      });
      for (const warning of pdf.warnings) {
        warnings.push({
          code: 'pdf_warning',
          message: `${pdf.url}: ${warning.message}`,
          // 内訳コードを残し、文字間空白（NOTICE）と抽出欠落（WARNING）を区別できるようにする。
          detail: warning.code,
        });
      }
      // 画像PDFなどAIへ渡せる本文が無いものは枠を消費させず次候補へ回す。
      // 抽出できなかった事実は既存の pdf_warning（empty_pages）が示す。
      if (pdf.text.trim() === '') {
        warnings.push({
          code: 'pdf_empty_text',
          message: `PDF本文が0文字のためAI入力に含めず次の候補を試します: ${pdf.url}`,
        });
        continue;
      }
      // 同じ本文を2枠に入れないよう、切り詰めやChunk選択より前の抽出原文で判定する。
      // 取得は成功しているので失敗系とは意味が違い、枠を消費させず次候補へ回す。
      const fingerprint = pdfContentFingerprint(pdf.text);
      const duplicatedLabel = acceptedFingerprints.get(fingerprint);
      if (duplicatedLabel !== undefined) {
        warnings.push({
          code: 'pdf_duplicate',
          message: `PDF本文が「${duplicatedLabel}」と同一のためAI入力に含めず次の候補を試します: ${pdf.url}`,
        });
        continue;
      }
      acceptedFingerprints.set(fingerprint, describePdfLink(link));
      pdfDocuments.push({ url: pdf.url, text: pdf.text });
      pdfLabels.push(describePdfLink(link));
      pdfPageTexts.push([...pdf.pageTexts]);
      usedUrls.add(url);
      slotsUsed += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // パスワード保護PDFは本文を1文字も渡せないので、0文字PDFと同じく枠を消費しない。
      // 解除・推測は行わず、保護されていた事実はWARNINGとして残す。
      if (isPasswordProtectedPdfError(error)) {
        warnings.push({
          code: 'pdf_failed',
          message: `PDFがパスワード保護されているためAI入力に含めず次の候補を試します: ${url}`,
          detail: 'password_protected',
        });
        continue;
      }
      warnings.push({
        code: 'pdf_failed',
        message: `PDF本文を取得できないためHTMLだけで続行します: ${url}: ${detail}`,
      });
      // パスワード保護以外の取得失敗は従来どおり枠を消費する。
      slotsUsed += 1;
    }
  }

  if (!input.noPdf && pdfLinks.length > pdfDocuments.length) {
    const includedLabels = pdfLabels.join(' / ');
    warnings.push({
      code: 'pdf_limit',
      message: `検出したPDF ${pdfLinks.length}件から、優先度に基づき${pdfDocuments.length}件を解析します: ${includedLabels}`,
    });
  }

  // AI入力へ渡さなかったPDF。優先度で外したもの、件数上限、本文0文字がここに入る。
  const pdfSkipped = pdfLinks
    .filter((link) => !usedUrls.has(link.url))
    .map((link) => ({ label: describePdfLink(link), url: link.url }));

  const prepared = prepareAnalysisInput({
    title: document.title,
    officialUrl: document.url,
    organizationName: input.organization.name,
    sourceName: input.source.name,
    htmlText: document.bodyText,
    pdfDocuments,
    pdfDiscovered: pdfLinks.length,
    pdfAttempted: attempted,
    companyFitCriteria: input.companyFitCriteria,
    limits,
    pdfLabels,
    pdfSkipped,
    pdfPageTexts,
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
