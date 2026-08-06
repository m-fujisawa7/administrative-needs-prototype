import type { Source } from '../source-registry/schema.ts';

export const SOURCE_CHECK_STATUSES = ['ok', 'warning', 'error', 'unsupported'] as const;
export type SourceCheckStatus = (typeof SOURCE_CHECK_STATUSES)[number];

export type SourceCheckSample = {
  title: string;
  url: string;
  publishedAt: string | null;
  categories?: string[];
};

export type SourceCheckExclusion = {
  reason: string;
  count: number;
};

export type SelectorCheckStatus = 'ok' | 'not_configured' | 'not_checked';

export type SourceContentAnalysis = {
  rawItemCount: number;
  structurallyValidItemCount: number;
  usableItemCount: number;
  samples: SourceCheckSample[];
  warnings: string[];
  exclusions: SourceCheckExclusion[];
  latestPublishedAt: string | null;
  linkSelectorStatus?: SelectorCheckStatus;
  contentSelectorStatus?: SelectorCheckStatus;
};

export type SourceCheckResult = {
  sourceId: string;
  sourceName: string;
  sourceEnabled: boolean;
  organizationName: string;
  collectorType: Source['collector_type'];
  sourceUrl: string;
  finalUrl?: string;
  status: SourceCheckStatus;
  httpStatus?: number;
  contentType?: string | null;
  responseBytes?: number;
  durationMs?: number;
  redirectCount?: number;
  rawItemCount?: number;
  structurallyValidItemCount?: number;
  usableItemCount?: number;
  latestPublishedAt?: string | null;
  linkSelectorStatus?: SelectorCheckStatus;
  contentSelectorStatus?: SelectorCheckStatus;
  samples: SourceCheckSample[];
  exclusions: SourceCheckExclusion[];
  warnings: string[];
  error?: string;
  checkedAt: string;
};

export type SourceCheckSelection =
  | { mode: 'source'; sourceId: string }
  | { mode: 'enabled' }
  | { mode: 'all' };

export type SourceCheckRunOptions = {
  selection: SourceCheckSelection;
  limit: number;
  intervalMs?: number;
  outputPath?: string;
};

export type SourceCheckReport = {
  schemaVersion: 1;
  generatedAt: string;
  selection: SourceCheckSelection;
  sampleLimit: number;
  summary: {
    total: number;
    ok: number;
    warning: number;
    error: number;
    unsupported: number;
    exitCode: number;
  };
  results: SourceCheckResult[];
};

export type FetchedBytes = {
  originalUrl: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string | null;
  bytes: Uint8Array;
  responseBytes: number;
  durationMs: number;
  redirectCount: number;
};

export type FetchedText = Omit<FetchedBytes, 'bytes'> & {
  text: string;
};
