import { load } from 'cheerio';
import { normalizeWhitespace, parseDateCandidate } from '../source-check/utils.ts';
import { ContentExtractionError } from './errors.ts';
import type {
  ContentExtractionResult,
  PdfLink,
  PublishedAtSource,
} from './types.ts';

const MINIMUM_BODY_LENGTH = 200;
const EXCLUDED_ELEMENTS = [
  'script',
  'style',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'noscript',
  'iframe',
  'svg',
  '[hidden]',
  '[aria-hidden="true"]',
].join(', ');
const FALLBACK_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '#mol_contents',
  '#main',
  '#contents',
  '#content',
  '.content',
  'body',
] as const;

export type ExtractDocumentHtmlInput = {
  html: string;
  url: string;
  contentSelector?: string;
};

export function extractDocumentFromHtml(
  input: ExtractDocumentHtmlInput,
): ContentExtractionResult {
  const $ = load(input.html);
  const warnings: string[] = [];
  const title = firstNonEmpty(
    normalizeWhitespace($('h1').first().text()),
    normalizeWhitespace($('title').first().text()),
  );
  if (title === null) {
    throw new ContentExtractionError('ページタイトルを h1 または title から取得できませんでした。');
  }

  const configuredSelector = input.contentSelector?.trim() || null;
  const selectors = uniqueSelectors(configuredSelector);
  let selectedElements: ReturnType<typeof $> | undefined;
  let selectedText: string | undefined;
  let selectedSelector: string | undefined;
  let configuredIssue: string | undefined;

  for (const selector of selectors) {
    let elements: ReturnType<typeof $>;
    try {
      elements = $(selector);
    } catch (error) {
      if (selector === configuredSelector) {
        const detail = error instanceof Error ? error.message : String(error);
        configuredIssue = `設定された content_selector が不正です: ${detail}`;
        continue;
      }
      throw error;
    }

    if (elements.length === 0) {
      if (selector === configuredSelector) {
        configuredIssue = `設定された content_selector「${selector}」に一致する要素がありません。`;
      }
      continue;
    }

    const bodyText = extractVisibleText(elements);
    if (bodyText.length < MINIMUM_BODY_LENGTH) {
      if (selector === configuredSelector) {
        configuredIssue = `設定された content_selector「${selector}」の本文が ${bodyText.length} 文字しかありません。`;
      }
      continue;
    }

    selectedElements = elements;
    selectedText = bodyText;
    selectedSelector = selector;
    break;
  }

  if (
    selectedElements === undefined
    || selectedText === undefined
    || selectedSelector === undefined
  ) {
    const prefix = configuredIssue === undefined ? '' : `${configuredIssue} `;
    throw new ContentExtractionError(
      `${prefix}フォールバックでも本文を ${MINIMUM_BODY_LENGTH} 文字以上抽出できませんでした。`,
    );
  }

  const usedFallback = configuredSelector === null || selectedSelector !== configuredSelector;
  if (configuredIssue !== undefined && selectedSelector !== configuredSelector) {
    warnings.push(`${configuredIssue} フォールバック「${selectedSelector}」を使用しました。`);
  }
  if (selectedSelector === 'body') {
    warnings.push('body全体を本文として使用したため、共通メニュー等が含まれていないか確認してください。');
  }

  const publishedAt = findPublishedAtCandidate($);
  if (publishedAt.value === null) warnings.push('公開日候補を取得できませんでした。');
  const effectiveBaseUrl = findEffectiveBaseUrl($, input.url, warnings);
  const pdfLinks = extractPdfLinks($, selectedElements, effectiveBaseUrl);

  return {
    title,
    bodyText: selectedText,
    bodyLength: selectedText.length,
    publishedAtCandidate: publishedAt.value,
    publishedAtSource: publishedAt.source,
    pdfUrls: pdfLinks.map((entry) => entry.url),
    pdfLinks,
    contentSelectorConfigured: configuredSelector,
    contentSelectorUsed: selectedSelector,
    usedFallback,
    warnings,
  };
}

function extractVisibleText(elements: ReturnType<ReturnType<typeof load>>): string {
  const clone = elements.clone();
  clone.find(EXCLUDED_ELEMENTS).remove();
  clone.filter(EXCLUDED_ELEMENTS).remove();
  return normalizeWhitespace(clone.text());
}

function extractPdfLinks(
  $: ReturnType<typeof load>,
  elements: ReturnType<ReturnType<typeof load>>,
  baseUrl: string,
): PdfLink[] {
  const clone = elements.clone();
  clone.find(EXCLUDED_ELEMENTS).remove();
  const links: PdfLink[] = [];
  const seen = new Set<string>();

  clone.find('a[href]').addBack('a[href]').each((_index, element) => {
    const href = $(element).attr('href')?.trim();
    if (href === undefined || href === '') return;

    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (!url.pathname.toLocaleLowerCase('en').endsWith('.pdf')) return;
    if (seen.has(url.href)) return;
    seen.add(url.href);
    links.push({ url: url.href, text: normalizeWhitespace($(element).text()) });
  });
  return links;
}

function findEffectiveBaseUrl(
  $: ReturnType<typeof load>,
  finalUrl: string,
  warnings: string[],
): string {
  const baseHref = $('base[href]').first().attr('href')?.trim();
  if (baseHref === undefined || baseHref === '') return finalUrl;

  try {
    const baseUrl = new URL(baseHref, finalUrl);
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      warnings.push('base要素がHTTP(S)ではないため、最終URLをリンク解決の基準にしました。');
      return finalUrl;
    }
    return baseUrl.href;
  } catch {
    warnings.push('base要素のURLが不正なため、最終URLをリンク解決の基準にしました。');
    return finalUrl;
  }
}

function findPublishedAtCandidate(
  $: ReturnType<typeof load>,
): { value: string | null; source: PublishedAtSource | null } {
  for (const element of $('time').toArray()) {
    const time = $(element);
    const value = parseDateCandidate(time.attr('datetime') ?? time.text());
    if (value !== null) return { value, source: 'time' };
  }

  for (const element of $('meta').toArray()) {
    const meta = $(element);
    const key = [meta.attr('property'), meta.attr('name'), meta.attr('itemprop')]
      .filter((value): value is string => value !== undefined)
      .join(' ')
      .toLocaleLowerCase('en');
    if (!/(?:published_time|datepublished|pubdate|publishdate)/u.test(key)) continue;
    const value = parseDateCandidate(meta.attr('content') ?? '');
    if (value !== null) return { value, source: 'meta' };
  }

  const pageTextSelectors = [
    '.page_day01',
    '.published',
    '.publish-date',
    '.date',
    '#main',
    'main',
    'article',
    'body',
  ];
  for (const selector of pageTextSelectors) {
    const text = normalizeWhitespace($(selector).first().text()).slice(0, 5_000);
    const value = parseDateCandidate(text);
    if (value !== null) return { value, source: 'page_text' };
  }
  return { value: null, source: null };
}

function uniqueSelectors(configuredSelector: string | null): string[] {
  const selectors = configuredSelector === null
    ? [...FALLBACK_SELECTORS]
    : [configuredSelector, ...FALLBACK_SELECTORS];
  return [...new Set(selectors)];
}

function firstNonEmpty(...values: string[]): string | null {
  return values.find((value) => value !== '') ?? null;
}
