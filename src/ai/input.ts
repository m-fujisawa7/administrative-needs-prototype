import type { PdfSelectionResult } from './pdf-chunks.ts';
import type {
  AdministrativeNeedAnalysis,
  AdministrativeNeedAnalysisInput,
  AiCheckWarning,
  AiInputPdfDetail,
  AiInputSkippedPdf,
  AiInputSummary,
  AnalysisPdfDocument,
  CompanyFitCriteria,
} from './types.ts';
import { AiConfigurationError } from './errors.ts';
import { selectPdfTextForBudget } from './pdf-chunks.ts';

export const DEFAULT_AI_INPUT_LIMITS = {
  htmlCharacters: 30_000,
  pdfCharacters: 50_000,
  maxPdfs: 3,
  /**
   * 1PDFあたりの上限。合計上限(50,000)の40%に当たる。
   *
   * 実測した高優先PDFは最大12,307文字で、20,000でも余裕がある。一方で1件が
   * 49,846文字を占める例があり、合計上限だけでは1ファイルが予算をほぼ独占して
   * 他の資料が入らなくなる。20,000なら3件が上限に張り付いても均等配分が働く。
   * Relevant Chunk化までの暫定措置。
   */
  charactersPerPdf: 20_000,
} as const;

export type AiInputLimits = {
  htmlCharacters: number;
  pdfCharacters: number;
  maxPdfs: number;
  /** 省略時は DEFAULT_AI_INPUT_LIMITS.charactersPerPdf を使う。 */
  charactersPerPdf?: number;
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
    charactersPerPdf: parseLimit(
      env.AI_MAX_CHARACTERS_PER_PDF,
      DEFAULT_AI_INPUT_LIMITS.charactersPerPdf,
      'AI_MAX_CHARACTERS_PER_PDF',
      1_000,
      500_000,
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
  /** pdfDocuments と同じ並びの表示ラベル。省略した要素はファイル名を使う。 */
  pdfLabels?: readonly string[];
  /** 優先度判定または件数上限でClaude入力から外したPDF。 */
  pdfSkipped?: readonly AiInputSkippedPdf[];
  /**
   * pdfDocuments と同じ並びのページ本文。長大PDFのRelevant Chunk選択で
   * ページ境界として使う。省略時は段落構造へ落とす。
   */
  pdfPageTexts?: readonly (readonly string[])[];
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
    limits.charactersPerPdf ?? DEFAULT_AI_INPUT_LIMITS.charactersPerPdf,
  );
  const pdfDocuments: AnalysisPdfDocument[] = [];
  const selections: PdfSelectionResult[] = [];
  let pdfWasTruncated = false;
  for (const [index, document] of options.pdfDocuments.entries()) {
    // budgetを決めてからその範囲内でRelevant Chunkを選ぶ。選択後に再度
    // 切り詰めないため、重要箇所が後段で落ちることはない。
    const documentLimit = documentLimits[index] ?? 0;
    const selection = selectPdfTextForBudget({
      text: document.text,
      budget: documentLimit,
      ...(options.pdfPageTexts?.[index] === undefined
        ? {}
        : { pageTexts: options.pdfPageTexts[index] }),
    });
    pdfDocuments.push({ url: document.url, text: selection.text });
    selections.push(selection);
    pdfWasTruncated ||= selection.strategy !== 'full';
  }
  const pdfSentCharacters = pdfDocuments.reduce(
    (total, document) => total + document.text.length,
    0,
  );
  if (pdfWasTruncated) {
    // どのPDFがどれだけ入力に残ったかを確認できるようにする。
    // 配分は allocateCharacterLimits が行うため、ここでは結果を表示するだけ。
    const perDocument = options.pdfDocuments
      .map((document, index) => {
        const sent = pdfDocuments[index]?.text.length ?? 0;
        return `${pdfLabel(document.url)} ${document.text.length}→${sent}`;
      })
      .join(', ');
    warnings.push({
      code: 'pdf_truncated',
      message: `PDF本文合計を ${pdfOriginalCharacters} 文字から ${pdfSentCharacters} 文字へ切り詰めました（${perDocument}）。`,
    });
  }

  // 取得全文ではなく、Claudeへ渡した原文の内訳を残す。
  const pdfInputs: AiInputPdfDetail[] = pdfDocuments.map((document, index) => ({
    label: options.pdfLabels?.[index] ?? pdfLabel(document.url),
    url: document.url,
    characters: document.text.length,
    extractedCharacters: options.pdfDocuments[index]?.text.length ?? document.text.length,
    strategy: selections[index]?.strategy ?? 'full',
    chunkCount: selections[index]?.chunkCount ?? 1,
  }));

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
      totalSourceCharacters: html.text.length + pdfSentCharacters,
      pdfInputs,
      pdfSkipped: [...(options.pdfSkipped ?? [])],
    },
    warnings,
  };
}

/**
 * Claudeへ実際に渡した入力の可視化ブロックを組み立てる。
 *
 * 取得全文ではなく送信量を出す。ai:check、source:verify、collect:run、
 * notion:batch、notion:register が同じ表示を共有するため、ここに1つだけ置く。
 * 行配列で返すので、呼び出し側は既存の空行区切りブロックへそのまま差し込める。
 */
export function formatAiInputBlock(
  summary: AiInputSummary,
  inputTokens?: number,
): string[] {
  // 切り詰めが起きた候補だけ抽出全文を併記する。行数は増やさない。
  const pdfCharacters = summary.pdfSentCharacters < summary.pdfOriginalCharacters
    ? `${summary.pdfSentCharacters} (extracted ${summary.pdfOriginalCharacters})`
    : String(summary.pdfSentCharacters);
  const lines = [
    'AI input:',
    `HTML characters: ${summary.htmlSentCharacters}`,
    `PDF documents included: ${summary.pdfIncluded}`,
    `PDF characters: ${pdfCharacters}`,
    `Total source characters: ${summary.totalSourceCharacters}`,
  ];
  if (inputTokens !== undefined) {
    lines.push(`Claude input tokens: ${inputTokens}`);
  }
  if (summary.pdfInputs.length > 0) {
    lines.push('', 'PDF input:');
    for (const pdf of summary.pdfInputs) {
      // 全文を渡したPDFは従来どおり1行。選択・切り詰めが起きた場合だけ内訳を足す。
      const detail = pdf.strategy === 'full'
        ? ''
        : ` (extracted ${pdf.extractedCharacters}, ${pdf.strategy}, ${pdf.chunkCount} chunks)`;
      lines.push(`- ${pdf.label}: ${pdf.characters} chars${detail}`);
    }
  }
  if (summary.pdfSkipped.length > 0) {
    lines.push('', 'PDF skipped from AI input:');
    for (const pdf of summary.pdfSkipped) {
      lines.push(`- ${pdf.label}`);
    }
  }
  return lines;
}

/**
 * Claude解析まで到達した結果にだけ、空行区切りの可視化ブロックを付ける。
 * 重複スキップや取得失敗では inputSummary が無いので何も足さない。
 */
export function aiInputSection(
  result: { inputSummary?: AiInputSummary; inputTokens?: number },
): string[] {
  if (result.inputSummary === undefined) return [];
  return ['', ...formatAiInputBlock(result.inputSummary, result.inputTokens)];
}

/** 中間を落としたことを示す区切り。切り詰めとChunk選択で同じ文字列を使う。 */
export const OMITTED_MARKER = '\n\n[...中間部分を省略...]\n\n';

export function truncateHeadTail(value: string, maxCharacters: number): {
  text: string;
  truncated: boolean;
} {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error('文字数上限は1以上の整数にしてください。');
  }
  if (value.length <= maxCharacters) return { text: value, truncated: false };

  const marker = OMITTED_MARKER;
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

/** 意味を変えない引用符の表記差だけを寄せる。曲がり引用符と直線引用符を同一視する。 */
const QUOTE_VARIANTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[“”„‟〝〞〟]/gu, '"'],
  [/[‘’‚‛]/gu, "'"],
];

/** 空白を挟んだ左右が両方ともラテン文字・数字か。欧文の語境界はここだけ。 */
const LATIN_OR_DIGIT = /[0-9A-Za-z]/u;

/**
 * 根拠照合のための正規化。原文と引用の両方に同じ処理を当ててから部分一致を見る。
 *
 * 吸収するのは意味を変えない表記差だけに限る。
 * - 改行・タブ・連続空白（NFKC と \s+ の畳み込み）
 * - 曲がり引用符と直線引用符の差（Claude が引用符を打ち直すことがある）
 * - PDF抽出で日本語文字間に混入した空白（`行 政 課 題` → `行政課題`）
 *
 * 空白を無条件に全除去すると `open data` と `opendata` が一致してしまうため、
 * 左右が両方ともラテン文字・数字の空白だけは残す。
 */
function normalizeForEvidence(value: string): string {
  let normalized = value.normalize('NFKC');
  for (const [pattern, replacement] of QUOTE_VARIANTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/\s+/gu, ' ')
    .replace(/ /gu, (_match, offset: number, whole: string) => {
      const before = whole[offset - 1];
      const after = whole[offset + 1];
      if (before === undefined || after === undefined) return '';
      return LATIN_OR_DIGIT.test(before) && LATIN_OR_DIGIT.test(after) ? ' ' : '';
    })
    .trim();
}

/** 診断表示用にPDFのファイル名だけを取り出す。取れない場合はURLをそのまま使う。 */
function pdfLabel(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).split('/').pop() || url;
  } catch {
    return url;
  }
}

/**
 * PDF本文の上限を各PDFへ配分する。上限は2段階ある。
 *
 * まず1PDFあたりの上限で各PDFを切り、長大な1件が合計予算を独占するのを防ぐ。
 * そのうえで合計が上限以内ならそのまま使う。超える場合は残り予算を残り件数で
 * 均等割りし、その枠より短いPDFは確定させて余りを他へ再配分する。どのPDFも枠に
 * 収まらなくなった時点で均等配分し、端数を先頭から1文字ずつ配る。
 * 乱数も時刻も使わないため、同じ入力なら毎回同じ配分になる。
 *
 * 切り取り方（先頭70%＋末尾30%）は truncateHeadTail のまま変えていない。
 */
function allocateCharacterLimits(
  lengths: number[],
  totalLimit: number,
  perPdfLimit: number,
): number[] {
  if (lengths.length === 0) return [];
  // 1件上限を先に当てる。短いPDFは従来どおり全文が残る。
  const capped = lengths.map((length) => Math.min(length, perPdfLimit));
  if (capped.reduce((total, length) => total + length, 0) <= totalLimit) {
    return capped;
  }

  const limits = Array.from({ length: capped.length }, () => 0);
  const remainingIndexes = new Set(capped.map((_length, index) => index));
  let remainingLimit = totalLimit;
  while (remainingIndexes.size > 0) {
    const share = Math.floor(remainingLimit / remainingIndexes.size);
    const fitting = [...remainingIndexes].filter((index) => capped[index]! <= share);
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
      limits[index] = capped[index]!;
      remainingLimit -= capped[index]!;
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
