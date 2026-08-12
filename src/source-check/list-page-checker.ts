import { load } from 'cheerio';
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
  normalizeWhitespace,
  parseDateCandidate,
} from './utils.ts';

type ListCandidate = SourceCheckSample & {
  canonicalUrl: string;
};

export function analyzeListPage(
  html: string,
  source: Source,
  officialDomain: string,
  limit: number,
  baseUrl = source.url,
): SourceContentAnalysis {
  if (source.link_selector === undefined) {
    throw new Error('list_page には link_selector の設定が必要です。');
  }

  const $ = load(html);
  let elements: ReturnType<typeof $>;
  try {
    elements = $(source.link_selector);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`link_selector が正しくありません: ${detail}`);
  }

  const rawItemCount = elements.length;
  if (rawItemCount === 0) {
    throw new Error(`link_selector に一致するリンクが0件です: ${source.link_selector}`);
  }

  const warnings: string[] = [];
  const exclusions = new Map<string, number>();
  const validCandidates: ListCandidate[] = [];
  const sourceCanonicalUrl = canonicalUrlWithoutHash(source.url);
  let missingTitleCount = 0;
  let missingUrlCount = 0;
  let externalDomainCount = 0;
  let selfLinkCount = 0;

  elements.each((_index, element) => {
    const anchor = $(element);
    const title = normalizeWhitespace(anchor.text());
    const href = anchor.attr('href')?.trim() ?? '';
    if (title === '') missingTitleCount += 1;
    if (href === '') missingUrlCount += 1;
    if (title === '' || href === '') {
      increment(exclusions, '必須項目不足');
      return;
    }

    let resolvedUrl: URL;
    try {
      resolvedUrl = new URL(href, baseUrl);
    } catch {
      increment(exclusions, '不正なURL');
      return;
    }
    if (
      (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:')
      || !isHostnameAllowed(resolvedUrl.hostname, officialDomain)
    ) {
      externalDomainCount += 1;
      increment(exclusions, '外部ドメインまたは非HTTP URL');
      return;
    }

    const canonicalUrl = canonicalUrlWithoutHash(resolvedUrl.href);
    if (canonicalUrl === sourceCanonicalUrl) {
      selfLinkCount += 1;
      increment(exclusions, '情報源ページ自身へのリンク');
      return;
    }

    const context = anchor.closest('.sec_01, li, article, section, tr, div').first().text();
    validCandidates.push({
      title,
      url: resolvedUrl.href,
      canonicalUrl,
      publishedAt: parseDateCandidate(context),
    });
  });

  if (validCandidates.length === 0) {
    throw new Error('タイトルと公式ドメイン内URLを持つ候補リンクがありません。');
  }

  const isTitleExcluded = createTitleExcludeMatcher(source.title_excludes);
  const usableCandidates: ListCandidate[] = [];
  const seenUrls = new Set<string>();
  for (const candidate of validCandidates) {
    if (seenUrls.has(candidate.canonicalUrl)) {
      increment(exclusions, '重複URL');
      continue;
    }
    seenUrls.add(candidate.canonicalUrl);
    // 一覧ページのタイトルはリンクテキストそのものなので、RSSと同じ判定で除外する。
    // ここで落とした候補はHTML・PDF取得、Claude解析、Notion重複確認へ進まない。
    if (isTitleExcluded(candidate.title)) {
      increment(exclusions, 'title_excludesで除外');
      continue;
    }
    usableCandidates.push(candidate);
  }

  if (missingTitleCount > 0 || missingUrlCount > 0) {
    warnings.push(`タイトル欠損 ${missingTitleCount} 件、URL欠損 ${missingUrlCount} 件があります。`);
  }
  if (externalDomainCount > 0) {
    warnings.push(`外部ドメインまたは非HTTPのリンクを ${externalDomainCount} 件除外しました。`);
  }
  if (selfLinkCount > 0) {
    warnings.push(`情報源ページ自身へのリンクを ${selfLinkCount} 件除外しました。`);
  }
  const duplicateCount = exclusions.get('重複URL') ?? 0;
  if (duplicateCount > 0) warnings.push(`重複URLを ${duplicateCount} 件除外しました。`);

  if (usableCandidates.length === 0) {
    throw new Error(
      (exclusions.get('title_excludesで除外') ?? 0) > 0
        ? '台帳の title_excludes 適用後に候補が0件です。'
        : '重複・外部ドメイン・自己リンクを除外した後の候補が0件です。',
    );
  }

  return {
    rawItemCount,
    structurallyValidItemCount: validCandidates.length,
    usableItemCount: usableCandidates.length,
    samples: usableCandidates.slice(0, limit).map(toSample),
    warnings,
    exclusions: toExclusions(exclusions),
    latestPublishedAt: latestDate(usableCandidates),
    linkSelectorStatus: 'ok',
    contentSelectorStatus: 'not_checked',
  };
}

function toSample(candidate: ListCandidate): SourceCheckSample {
  return {
    title: candidate.title,
    url: candidate.url,
    publishedAt: candidate.publishedAt,
  };
}

function latestDate(candidates: ListCandidate[]): string | null {
  const dates = candidates
    .map((candidate) => candidate.publishedAt)
    .filter((date): date is string => date !== null)
    .sort();
  return dates.at(-1) ?? null;
}

function increment(counts: Map<string, number>, reason: string): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function toExclusions(counts: Map<string, number>): SourceCheckExclusion[] {
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}
