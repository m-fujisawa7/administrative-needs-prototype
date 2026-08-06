export type PublishedAtSource = 'time' | 'meta' | 'page_text';

export type ContentExtractionResult = {
  title: string;
  bodyText: string;
  bodyLength: number;
  publishedAtCandidate: string | null;
  publishedAtSource: PublishedAtSource | null;
  pdfUrls: string[];
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
