import type {
  Organization,
  Source,
  SourceRegistry,
} from '../source-registry/schema.ts';
import { safeFetchText } from './fetch.ts';
import { analyzeListPage } from './list-page-checker.ts';
import { analyzeRss } from './rss-checker.ts';
import { analyzeSinglePage } from './single-page-checker.ts';
import type {
  FetchedText,
  SourceCheckSample,
  SourceContentAnalysis,
  SourceCheckResult,
  SourceCheckRunOptions,
  SourceCheckSelection,
} from './types.ts';

const DEFAULT_INTERVAL_MS = 1_000;

export type SourceFetchRequest = {
  url: string;
  officialDomain: string;
  accept: string;
};
export type SourceFetcher = (request: SourceFetchRequest) => Promise<FetchedText>;

export type SourceCheckDependencies = {
  fetchSource?: SourceFetcher;
  now?: () => Date;
  nowMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type SelectedSource = {
  source: Source;
  organization: Organization;
};

type CollectedSourceContent = {
  fetched: FetchedText;
  analysis: SourceContentAnalysis;
};

export async function collectSourceCandidates(
  source: Source,
  organization: Organization,
  dependencies: SourceCheckDependencies = {},
  limit = Number.MAX_SAFE_INTEGER,
): Promise<SourceCheckSample[]> {
  if (!isFetchableCollectorType(source.collector_type)) {
    throw new Error(`collector_type「${source.collector_type}」は現在未対応です。`);
  }
  const { analysis } = await fetchAndAnalyzeSource(
    source,
    organization,
    limit,
    dependencies,
  );
  return analysis.samples;
}

export async function checkSourceRegistry(
  registry: SourceRegistry,
  options: SourceCheckRunOptions,
  dependencies: SourceCheckDependencies = {},
): Promise<SourceCheckResult[]> {
  const selected = selectSources(registry, options.selection);
  if (selected.length === 0) throw new Error('条件に一致する情報源がありません。');

  const intervalMs = options.intervalMs ?? readIntervalFromEnvironment();
  const nowMs = dependencies.nowMs ?? Date.now;
  const sleep = dependencies.sleep ?? wait;
  const lastAccessByHost = new Map<string, number>();
  const results: SourceCheckResult[] = [];

  for (const entry of selected) {
    // 実際にHTTPアクセスする形式だけ、同一ホストへの連続アクセス間隔を空ける。
    if (isFetchableCollectorType(entry.source.collector_type)) {
      const hostname = new URL(entry.source.url).hostname;
      const lastAccess = lastAccessByHost.get(hostname);
      if (lastAccess !== undefined) {
        const remaining = intervalMs - (nowMs() - lastAccess);
        if (remaining > 0) await sleep(remaining);
      }
      lastAccessByHost.set(hostname, nowMs());
    }
    results.push(await checkOneSource(entry, options.limit, dependencies));
  }
  return results;
}

export function selectSources(
  registry: SourceRegistry,
  selection: SourceCheckSelection,
): SelectedSource[] {
  let sources: Source[];
  if (selection.mode === 'source') {
    const source = registry.sources.find((candidate) => candidate.id === selection.sourceId);
    if (source === undefined) throw new Error(`情報源ID「${selection.sourceId}」は登録されていません。`);
    sources = [source];
  } else if (selection.mode === 'enabled') {
    const enabledOrganizations = new Set(
      registry.organizations
        .filter((organization) => organization.enabled)
        .map((organization) => organization.id),
    );
    sources = registry.sources.filter(
      (source) => source.enabled && enabledOrganizations.has(source.organization_id),
    );
  } else {
    sources = registry.sources;
  }

  const organizations = new Map(
    registry.organizations.map((organization) => [organization.id, organization]),
  );
  return sources.map((source) => {
    const organization = organizations.get(source.organization_id);
    if (organization === undefined) {
      throw new Error(`情報源「${source.id}」の組織「${source.organization_id}」が見つかりません。`);
    }
    return { source, organization };
  });
}

async function checkOneSource(
  entry: SelectedSource,
  limit: number,
  dependencies: SourceCheckDependencies,
): Promise<SourceCheckResult> {
  const { source, organization } = entry;
  const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const base: SourceCheckResult = {
    sourceId: source.id,
    sourceName: source.name,
    sourceEnabled: source.enabled,
    organizationName: organization.name,
    collectorType: source.collector_type,
    sourceUrl: source.url,
    status: 'error',
    samples: [],
    exclusions: [],
    warnings: [],
    checkedAt,
  };

  if (!isFetchableCollectorType(source.collector_type)) {
    return {
      ...base,
      status: 'unsupported',
      warnings: [`collector_type「${source.collector_type}」は現在未対応です。`],
    };
  }

  let fetched: FetchedText | undefined;
  try {
    const collected = await fetchAndAnalyzeSource(source, organization, limit, dependencies);
    fetched = collected.fetched;
    const { analysis } = collected;
    const contentTypeWarnings = contentTypeWarningsFor(source, fetched.contentType);
    const warnings = [...analysis.warnings, ...contentTypeWarnings];

    return {
      ...base,
      status: warnings.length === 0 ? 'ok' : 'warning',
      finalUrl: fetched.finalUrl,
      httpStatus: fetched.httpStatus,
      contentType: fetched.contentType,
      responseBytes: fetched.responseBytes,
      durationMs: fetched.durationMs,
      redirectCount: fetched.redirectCount,
      rawItemCount: analysis.rawItemCount,
      structurallyValidItemCount: analysis.structurallyValidItemCount,
      usableItemCount: analysis.usableItemCount,
      latestPublishedAt: analysis.latestPublishedAt,
      linkSelectorStatus: analysis.linkSelectorStatus,
      contentSelectorStatus: analysis.contentSelectorStatus,
      samples: analysis.samples,
      exclusions: analysis.exclusions,
      warnings,
    };
  } catch (error) {
    return {
      ...base,
      finalUrl: fetched?.finalUrl,
      httpStatus: fetched?.httpStatus,
      contentType: fetched?.contentType,
      responseBytes: fetched?.responseBytes,
      durationMs: fetched?.durationMs,
      redirectCount: fetched?.redirectCount,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchAndAnalyzeSource(
  source: Source,
  organization: Organization,
  limit: number,
  dependencies: SourceCheckDependencies,
): Promise<CollectedSourceContent> {
  const fetchSource = dependencies.fetchSource ?? defaultFetchSource;
  const fetched = await fetchSource({
    url: source.url,
    officialDomain: organization.official_domain,
    accept: source.collector_type === 'rss'
      ? 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1'
      : 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1',
  });
  const analysis = analyzeFetchedSource(source, organization, limit, fetched);
  return { fetched, analysis };
}

/** 入口URLを取得して候補を出せる形式。manual と custom は取得処理を持たない。 */
function isFetchableCollectorType(
  collectorType: Source['collector_type'],
): collectorType is 'rss' | 'list_page' | 'single_page' {
  return collectorType === 'rss'
    || collectorType === 'list_page'
    || collectorType === 'single_page';
}

function analyzeFetchedSource(
  source: Source,
  organization: Organization,
  limit: number,
  fetched: FetchedText,
): SourceContentAnalysis {
  if (source.collector_type === 'rss') {
    return analyzeRss(fetched.text, source, organization.official_domain, limit);
  }
  // single_page はページ自体が候補なので、取得したHTMLからリンクを抽出しない。
  // 取得は疎通確認とURLの生存確認のために行い、本文抽出はAI判定側が担う。
  if (source.collector_type === 'single_page') return analyzeSinglePage(source);
  return analyzeListPage(
    fetched.text,
    source,
    organization.official_domain,
    limit,
    fetched.finalUrl,
  );
}

async function defaultFetchSource(request: SourceFetchRequest): Promise<FetchedText> {
  return safeFetchText(request.url, {
    officialDomain: request.officialDomain,
    accept: request.accept,
  });
}

function contentTypeWarningsFor(source: Source, contentType: string | null): string[] {
  if (contentType === null) return ['Content-Typeヘッダーがありません。'];
  const normalized = contentType.toLocaleLowerCase('en');
  if (source.collector_type === 'rss' && !normalized.includes('xml') && !normalized.includes('rss')) {
    return [`Content-TypeがXML系ではありません: ${contentType}`];
  }
  if (
    (source.collector_type === 'list_page' || source.collector_type === 'single_page')
    && !normalized.includes('text/html')
    && !normalized.includes('application/xhtml+xml')
  ) {
    return [`Content-TypeがHTML系ではありません: ${contentType}`];
  }
  return [];
}

function readIntervalFromEnvironment(): number {
  const raw = process.env.SOURCE_CHECK_INTERVAL_MS;
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 60_000) {
    throw new Error('SOURCE_CHECK_INTERVAL_MS は0から60000の整数で指定してください。');
  }
  return parsed;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
