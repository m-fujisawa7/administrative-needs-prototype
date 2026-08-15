import { normalizeForMatch } from './utils.ts';

/**
 * 台帳の `title_excludes` / `title_includes` を候補タイトルへ適用する判定を作る。
 *
 * RSSと一覧ページで同じマッチング仕様を使うため、判定はここだけに置く。
 * パターンはNFKC正規化・小文字化・空白除去した後の部分一致で比較するので、
 * 全角の「ＦＡＱ」と半角の「FAQ」、途中に空白が入る表記も一致する。
 */

function normalizePatterns(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? [])
    .map(normalizeForMatch)
    .filter((pattern) => pattern !== '');
}

function createMatcher(patterns: readonly string[]): (title: string) => boolean {
  return (title) => {
    const normalizedTitle = normalizeForMatch(title);
    return patterns.some((pattern) => normalizedTitle.includes(pattern));
  };
}

/** いずれかの語に一致したら除外する判定。未設定・空配列なら常に false。 */
export function createTitleExcludeMatcher(
  patterns: readonly string[] | undefined,
): (title: string) => boolean {
  const normalizedPatterns = normalizePatterns(patterns);
  if (normalizedPatterns.length === 0) return () => false;
  return createMatcher(normalizedPatterns);
}

/**
 * いずれかの語に一致した候補だけを残す判定（OR条件）。
 *
 * 未設定・空配列なら常に true を返し、従来どおり全候補を通す。除外語と違い
 * 「含む条件」なので、設定した情報源だけが絞り込まれる。
 */
export function createTitleIncludeMatcher(
  patterns: readonly string[] | undefined,
): (title: string) => boolean {
  const normalizedPatterns = normalizePatterns(patterns);
  if (normalizedPatterns.length === 0) return () => true;
  return createMatcher(normalizedPatterns);
}
