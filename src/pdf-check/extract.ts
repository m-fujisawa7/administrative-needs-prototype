import { extractText, getDocumentProxy } from 'unpdf';
import { installMathSumPrecise } from './math-sum-precise.ts';
import {
  PdfCheckError,
  type PdfExtractionResult,
  type PdfExtractionWarning,
} from './types.ts';

// PDF.jsのフォント再構築などが Math.sumPrecise を使う。V8未実装のランタイムでは
// 一部PDFが解析できないため、pdfjsの遅延importより先にここで補う。
installMathSumPrecise();

export const DEFAULT_MAX_PDF_PAGES = 500;
export const DEFAULT_MAX_PDF_IMAGE_SIZE = 16_777_216;
export const DEFAULT_PDF_PARSE_TIMEOUT_MS = 30_000;

export type PdfDocumentLike = {
  numPages: number;
  cleanup: () => Promise<void> | void;
};

export type PdfParserDependencies = {
  openDocument: (
    bytes: Uint8Array,
    options: { maxImageSize: number },
  ) => Promise<PdfDocumentLike>;
  extractPageTexts: (document: PdfDocumentLike) => Promise<string[]>;
};

export type PdfExtractionOptions = {
  maxPages?: number;
  maxImageSize?: number;
  timeoutMs?: number;
  parser?: PdfParserDependencies;
};

export async function extractPdfFromBytes(
  bytes: Uint8Array,
  options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
  if (!hasPdfHeader(bytes)) {
    throw new PdfCheckError('invalid_pdf', 'PDFヘッダー（%PDF-）を確認できません。');
  }

  const parser = options.parser ?? DEFAULT_PARSER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PDF_PARSE_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PDF_PAGES;
  const maxImageSize = options.maxImageSize ?? DEFAULT_MAX_PDF_IMAGE_SIZE;
  let document: PdfDocumentLike | undefined;

  try {
    document = await withTimeout(
      parser.openDocument(bytes, { maxImageSize }),
      timeoutMs,
      'PDFの解析がタイムアウトしました。',
    );
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
      throw new PdfCheckError('invalid_pdf', 'PDFのページ数を正しく取得できません。');
    }
    if (document.numPages > maxPages) {
      throw new PdfCheckError(
        'too_many_pages',
        `PDFのページ数 ${document.numPages} は上限 ${maxPages} ページを超えています。`,
      );
    }

    const extractedPages = await withTimeout(
      parser.extractPageTexts(document),
      timeoutMs,
      'PDFのテキスト抽出がタイムアウトしました。',
    );
    if (extractedPages.length !== document.numPages) {
      throw new PdfCheckError(
        'parse_failed',
        `PDFのページ数 ${document.numPages} と抽出結果 ${extractedPages.length} ページが一致しません。`,
      );
    }

    const pageTexts = extractedPages.map(normalizePdfPageText);
    const text = pageTexts.join('\n\n').trim();
    if (text === '') {
      throw new PdfCheckError(
        'no_text',
        'PDFからテキストを抽出できませんでした。画像PDF・スキャンPDFの可能性があります。',
      );
    }

    const pagesWithText = pageTexts.filter((pageText) => pageText !== '').length;
    const emptyPageCount = pageTexts.length - pagesWithText;
    const warnings = buildWarnings(text, emptyPageCount, pageTexts.length);
    return {
      parser: 'unpdf',
      pageCount: document.numPages,
      pageTexts,
      text,
      characterCount: text.length,
      pagesWithText,
      emptyPageCount,
      warnings,
    };
  } catch (error) {
    if (error instanceof PdfCheckError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new PdfCheckError(
      'parse_failed',
      `PDFの解析またはテキスト抽出に失敗しました: ${detail}`,
      { cause: error },
    );
  } finally {
    if (document !== undefined) {
      await Promise.resolve(document.cleanup()).catch(() => undefined);
    }
  }
}

export function hasPdfHeader(bytes: Uint8Array): boolean {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const searchLength = Math.min(bytes.byteLength, 1024);
  for (let offset = 0; offset <= searchLength - signature.length; offset += 1) {
    if (signature.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}

export function normalizePdfPageText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/gu, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function buildWarnings(
  text: string,
  emptyPageCount: number,
  pageCount: number,
): PdfExtractionWarning[] {
  const warnings: PdfExtractionWarning[] = [];
  if (emptyPageCount > 0) {
    warnings.push({
      code: 'empty_pages',
      message: `${pageCount}ページ中${emptyPageCount}ページでテキストを抽出できませんでした。`,
    });
  }
  if (hasFrequentJapaneseCharacterSpacing(text)) {
    warnings.push({
      code: 'japanese_character_spacing',
      message: '日本語の文字間に空白が多く、読みやすさに影響する可能性があります。',
    });
  }
  return warnings;
}

function hasFrequentJapaneseCharacterSpacing(text: string): boolean {
  const matches = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][ \t]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
  );
  return (matches?.length ?? 0) >= 10;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new PdfCheckError('parse_timeout', message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type UnpdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

const DEFAULT_PARSER: PdfParserDependencies = {
  openDocument: async (bytes, options) => getDocumentProxy(bytes, {
    ...options,
    // PDF.jsのフォント代替などの診断は結果品質指標へ変換できないため、CLIには出さない。
    // 解析不能なPDFは引き続き例外として扱われる。
    verbosity: 0,
  }),
  extractPageTexts: async (document) => {
    const result = await extractText(document as unknown as UnpdfDocument, { mergePages: false });
    return result.text;
  },
};
