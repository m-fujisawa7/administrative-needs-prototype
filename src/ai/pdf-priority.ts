import type { PdfLink } from '../content-check/types.ts';
import { normalizeForMatch } from '../source-check/utils.ts';

export type PdfPriority = 'high' | 'medium' | 'other' | 'low';

/**
 * 行政ニーズ・要求内容・事業条件を直接記載している可能性が高い文書。
 * normalizeForMatch で小文字化するため、キーワードも小文字で持つ。
 */
const HIGH_KEYWORDS = [
  '情報提供依頼', 'rfi', 'rfc', '仕様書', '要求仕様', '実施要領',
  '募集要項', '公募要領', '提案募集', '業務内容', '事業概要', '実証要領',
] as const;

/** 案件理解に役立つ可能性がある文書。 */
const MEDIUM_KEYWORDS = [
  '概要', '説明資料', '参考資料', '計画', 'ガイドライン',
] as const;

/** 行政ニーズ分析への寄与が比較的小さい可能性が高い文書。完全には除外しない。 */
const LOW_KEYWORDS = [
  '申込書', '応募様式', '様式', 'チラシ', 'フライヤー',
  'アクセスマップ', '地図', '料金表',
] as const;

/** 選択順。高 → 中 → その他 → 低。 */
const PRIORITY_ORDER: Record<PdfPriority, number> = {
  high: 0,
  medium: 1,
  other: 2,
  low: 3,
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 判定材料。リンクテキスト・ファイル名・URLパスをそれぞれ正規化して返す。
 *
 * 連結せず個別に持つのは、フィールドの境界をまたいだ偶然の一致を避けるため。
 * リンクテキストが最も情報量が多い（大阪市はファイル名が `01_youryou5.pdf` の
 * ようなローマ字だが、リンクテキストは `01_実施要領(PDF形式, 877.40KB)`）。
 */
function matchTargets(link: PdfLink): string[] {
  const targets = [normalizeForMatch(link.text)];
  try {
    const url = new URL(link.url);
    const pathname = safeDecode(url.pathname);
    targets.push(normalizeForMatch(pathname.split('/').pop() ?? ''));
    targets.push(normalizeForMatch(pathname));
  } catch {
    targets.push(normalizeForMatch(link.url));
  }
  return targets.filter((target) => target !== '');
}

/**
 * PDFリンクの優先度を決定論的に判定する。AIは使わない。
 * 高優先キーワードは低優先キーワードより強い（例: 「募集要項及び応募様式」は高優先）。
 */
export function classifyPdfPriority(link: PdfLink): PdfPriority {
  const targets = matchTargets(link);
  const includesAny = (keywords: readonly string[]): boolean =>
    keywords.some((keyword) => targets.some((target) => target.includes(keyword)));

  if (includesAny(HIGH_KEYWORDS)) return 'high';
  if (includesAny(MEDIUM_KEYWORDS)) return 'medium';
  if (includesAny(LOW_KEYWORDS)) return 'low';
  return 'other';
}

/**
 * 優先度順に最大 max 件を選ぶ（設計上の上限は呼び出し側の maxPdfs）。
 * 同じ優先度では元の掲載順を維持するため、同じ入力なら毎回同じ結果になる。
 *
 * max 件以下なら並べ替えず、掲載順のまま全件返す。切り捨てが起きないため
 * 優先度を判定する必要がなく、従来の挙動をそのまま保てる。
 */
export function selectPdfsByPriority(links: readonly PdfLink[], max: number): PdfLink[] {
  if (max <= 0) return [];
  if (links.length <= max) return [...links];
  return links
    .map((link, index) => ({ link, index, order: PRIORITY_ORDER[classifyPdfPriority(link)] }))
    .sort((a, b) => (a.order - b.order) || (a.index - b.index))
    .slice(0, max)
    .map((entry) => entry.link);
}

/** 診断表示用の短いラベル。リンクテキストがなければファイル名を使う。 */
export function describePdfLink(link: PdfLink, maxLength = 30): string {
  const fallback = (): string => {
    try {
      return safeDecode(new URL(link.url).pathname).split('/').pop() ?? link.url;
    } catch {
      return link.url;
    }
  };
  const label = link.text.trim() === '' ? fallback() : link.text.trim();
  return label.length <= maxLength ? label : `${label.slice(0, maxLength)}…`;
}
