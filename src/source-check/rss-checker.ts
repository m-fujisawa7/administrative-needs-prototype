import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Source } from '../source-registry/schema.ts';
import { isHostnameAllowed } from './fetch.ts';
import { createTitleExcludeMatcher } from './title-excludes.ts';
import type {
  SourceCheckExclusion,
  SourceCheckSample,
  SourceContentAnalysis,
} from './types.ts';
import {
  canonicalUrlWithoutHash,
  normalizeForMatch,
  normalizeWhitespace,
  parseDateCandidate,
} from './utils.ts';

type RssCandidate = SourceCheckSample & {
  canonicalUrl: string;
};

export function analyzeRss(
  xml: string,
  source: Source,
  officialDomain: string,
  limit: number,
): SourceContentAnalysis {
  if (/<!DOCTYPE/iu.test(xml)) {
    throw new Error('DOCTYPEを含むXMLは安全のため解析しません。');
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`RSSが整形式XMLではありません: ${validation.err.msg}`);
  }

  let document: unknown;
  try {
    document = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      trimValues: true,
    }).parse(xml);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`RSSをXMLとして解析できませんでした: ${detail}`);
  }

  const rawItems = selectFeedItems(asRecord(document));
  if (rawItems.length === 0) throw new Error('RSSのitemが0件です。');

  const warnings: string[] = [];
  const exclusions = new Map<string, number>();
  const validCandidates: RssCandidate[] = [];
  let missingTitleCount = 0;
  let missingUrlCount = 0;
  let missingPublishedAtCount = 0;
  let externalDomainCount = 0;

  for (const rawItem of rawItems) {
    const item = asRecord(rawItem);
    const title = normalizeWhitespace(toText(item?.title));
    const link = normalizeWhitespace(toText(item?.link));
    const publishedAt = parseDateCandidate(toText(item?.pubDate));
    const categories = toArray(item?.category)
      .map((category) => normalizeWhitespace(toText(category)))
      .filter((category) => category !== '');

    if (title === '') missingTitleCount += 1;
    if (link === '') missingUrlCount += 1;
    if (publishedAt === null) missingPublishedAtCount += 1;
    if (title === '' || link === '') {
      increment(exclusions, '必須項目不足');
      continue;
    }

    let candidateUrl: URL;
    try {
      candidateUrl = new URL(link, source.url);
    } catch {
      increment(exclusions, '不正なURL');
      continue;
    }
    if (
      (candidateUrl.protocol !== 'http:' && candidateUrl.protocol !== 'https:')
      || !isHostnameAllowed(candidateUrl.hostname, officialDomain)
    ) {
      externalDomainCount += 1;
      increment(exclusions, '外部ドメインまたは非HTTP URL');
      continue;
    }

    validCandidates.push({
      title,
      url: candidateUrl.href,
      canonicalUrl: canonicalUrlWithoutHash(candidateUrl.href),
      publishedAt,
      categories,
    });
  }

  if (validCandidates.length === 0) {
    throw new Error('タイトルと公式ドメイン内URLを持つitemがありません。');
  }

  const uniqueCandidates: RssCandidate[] = [];
  const seenUrls = new Set<string>();
  for (const candidate of validCandidates) {
    if (seenUrls.has(candidate.canonicalUrl)) {
      increment(exclusions, '重複URL');
      continue;
    }
    seenUrls.add(candidate.canonicalUrl);
    uniqueCandidates.push(candidate);
  }

  const categoryIncludes = (source.category_includes ?? []).map(normalizeForMatch);
  const isTitleExcluded = createTitleExcludeMatcher(source.title_excludes);
  const usableCandidates: RssCandidate[] = [];

  for (const candidate of uniqueCandidates) {
    const normalizedCategories = (candidate.categories ?? []).map(normalizeForMatch);
    if (
      categoryIncludes.length > 0
      && !categoryIncludes.some((pattern) =>
        normalizedCategories.some((category) => category.includes(pattern)))
    ) {
      increment(exclusions, 'category_includesで除外');
      continue;
    }
    if (isTitleExcluded(candidate.title)) {
      increment(exclusions, 'title_excludesで除外');
      continue;
    }
    usableCandidates.push(candidate);
  }

  if (missingTitleCount > 0 || missingUrlCount > 0) {
    warnings.push(`タイトル欠損 ${missingTitleCount} 件、URL欠損 ${missingUrlCount} 件があります。`);
  }
  if (missingPublishedAtCount > rawItems.length / 2) {
    warnings.push(`公開日が半数を超える ${missingPublishedAtCount} 件で取得できません。`);
  }
  if (externalDomainCount > 0) {
    warnings.push(`外部ドメインまたは非HTTPのリンクを ${externalDomainCount} 件除外しました。`);
  }
  const duplicateCount = exclusions.get('重複URL') ?? 0;
  if (duplicateCount > 0) warnings.push(`重複URLを ${duplicateCount} 件除外しました。`);

  if (usableCandidates.length === 0) {
    throw new Error('台帳の category_includes / title_excludes 適用後に候補が0件です。');
  }

  return {
    rawItemCount: rawItems.length,
    structurallyValidItemCount: validCandidates.length,
    usableItemCount: usableCandidates.length,
    samples: usableCandidates.slice(0, limit).map(toSample),
    warnings,
    exclusions: toExclusions(exclusions),
    latestPublishedAt: latestDate(usableCandidates),
  };
}

/**
 * RSS 2.0 と RSS 1.0（RDF）のどちらからも item の並びを取り出す。
 *
 * RSS 2.0 は channel の下に item が並ぶ。RSS 1.0 は rdf:RDF の直下に channel と
 * item が並び、公開日が dc:date、カテゴリが dc:subject になる。後続の判定を
 * 1つに保つため、RSS 1.0 の item だけ RSS 2.0 と同じキーへ寄せる。
 */
function selectFeedItems(root: Record<string, unknown> | null): unknown[] {
  const rss = asRecord(root?.rss);
  if (rss !== null && Object.hasOwn(rss, 'channel')) {
    return toArray((asRecord(rss.channel) ?? {}).item);
  }

  const rdf = asRecord(root?.['rdf:RDF']) ?? asRecord(root?.RDF);
  if (rdf !== null) {
    return toArray(rdf.item).map(toRss20ShapedItem);
  }

  throw new Error('RSS 2.0 の channel 要素、または RSS 1.0 の rdf:RDF 要素が見つかりません。');
}

/** RSS 1.0 の item を RSS 2.0 と同じキー（title / link / pubDate / category）へ寄せる。 */
function toRss20ShapedItem(rawItem: unknown): unknown {
  const item = asRecord(rawItem);
  if (item === null) return rawItem;
  return {
    ...item,
    pubDate: item.pubDate ?? item['dc:date'],
    category: item.category ?? toDublinCoreSubjects(item['dc:subject']),
  };
}

/**
 * dc:subject を category の並びへ正規化する。
 *
 * 要素が繰り返される場合と、1要素へ区切り文字でまとめられる場合の両方がある。
 */
function toDublinCoreSubjects(value: unknown): string[] {
  return toArray(value)
    .flatMap((subject) => toText(subject).split(/[,、]/u))
    .map((subject) => subject.trim())
    .filter((subject) => subject !== '');
}

function toSample(candidate: RssCandidate): SourceCheckSample {
  return {
    title: candidate.title,
    url: candidate.url,
    publishedAt: candidate.publishedAt,
    categories: candidate.categories,
  };
}

function latestDate(candidates: RssCandidate[]): string | null {
  const dates = candidates
    .map((candidate) => candidate.publishedAt)
    .filter((date): date is string => date !== null)
    .sort();
  return dates.at(-1) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function toText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const record = asRecord(value);
  return record === null ? '' : toText(record['#text']);
}

function increment(counts: Map<string, number>, reason: string): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function toExclusions(counts: Map<string, number>): SourceCheckExclusion[] {
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}
