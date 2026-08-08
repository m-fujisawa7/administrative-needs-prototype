export type PublishedAtSource = 'time' | 'meta' | 'page_text';

/** 記事本文から見つけた添付PDFのリンク。優先選択の判定材料に使う。 */
export type PdfLink = {
  url: string;
  /** アンカーの表示文字列。取得できない場合は空文字。 */
  text: string;
};

export type ContentExtractionResult = {
  title: string;
  bodyText: string;
  bodyLength: number;
  publishedAtCandidate: string | null;
  publishedAtSource: PublishedAtSource | null;
  pdfUrls: string[];
  /** pdfUrls と同じ並び。リンクテキスト付き。 */
  pdfLinks: PdfLink[];
  contentSelectorConfigured: string | null;
  contentSelectorUsed: string;
  usedFallback: boolean;
  warnings: string[];
};

export type ExtractedDocument = ContentExtractionResult & {
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

export type ContentCheckCliOptions = {
  sourceId: string;
  url: string;
  full: boolean;
  outputPath?: string;
};

export type ContentCheckSavedResult = Omit<ExtractedDocument, 'bodyText'> & {
  bodyPreview: string;
};

export type ContentCheckReport = {
  schemaVersion: 1;
  generatedAt: string;
  status: 'ok' | 'warning' | 'error';
  exitCode: 0 | 1;
  sourceId: string;
  requestedUrl: string;
  result?: ContentCheckSavedResult;
  error?: string;
};
