export type PdfExtractionWarningCode =
  | 'empty_pages'
  | 'japanese_character_spacing'
  | 'source_disabled'
  | 'organization_disabled';

export type PdfExtractionWarning = {
  code: PdfExtractionWarningCode;
  message: string;
};

export type PdfExtractionResult = {
  parser: 'unpdf';
  pageCount: number;
  pageTexts: string[];
  text: string;
  characterCount: number;
  pagesWithText: number;
  emptyPageCount: number;
  warnings: PdfExtractionWarning[];
};

export type ExtractedPdf = PdfExtractionResult & {
  sourceId: string;
  sourceEnabled: boolean;
  requestedUrl: string;
  url: string;
  httpStatus: number;
  contentType: string;
  responseBytes: number;
  durationMs: number;
  redirectCount: number;
};

export type PdfCheckCliOptions = {
  sourceId: string;
  url: string;
  full: boolean;
  outputPath?: string;
};

export type PdfCheckSavedResult = Omit<ExtractedPdf, 'text' | 'pageTexts'> & {
  textPreview: string;
  pageCharacterCounts: number[];
};

export type PdfCheckReport = {
  schemaVersion: 1;
  generatedAt: string;
  status: 'ok' | 'warning' | 'error';
  exitCode: 0 | 1;
  sourceId: string;
  requestedUrl: string;
  result?: PdfCheckSavedResult;
  error?: string;
};

export type PdfCheckErrorCode =
  | 'invalid_pdf'
  | 'too_many_pages'
  | 'parse_timeout'
  | 'parse_failed'
  /**
   * パスワード保護PDF。本文を1文字も取得できないため、
   * 呼び出し側はAI入力枠を消費させず次候補へ回せる。
   * 解除・推測は行わない。
   */
  | 'password_protected'
  | 'no_text';

export class PdfCheckError extends Error {
  override name = 'PdfCheckError';
  readonly code: PdfCheckErrorCode;

  constructor(
    code: PdfCheckErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/**
 * パスワード保護で本文を取得できなかったか。
 * AI入力枠を消費させず次候補へ回す判定に使う。
 */
export function isPasswordProtectedPdfError(error: unknown): boolean {
  return error instanceof PdfCheckError && error.code === 'password_protected';
}
