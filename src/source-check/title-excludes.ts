import { normalizeForMatch } from './utils.ts';

/**
 * 台帳の `title_excludes` を候補タイトルへ適用する判定を作る。
 *
 * RSSと一覧ページで同じマッチング仕様を使うため、判定はここだけに置く。
 * パターンはNFKC正規化・小文字化・空白除去した後の部分一致で比較するので、
 * 全角の「ＦＡＱ」と半角の「FAQ」、途中に空白が入る表記も一致する。
 */
export function createTitleExcludeMatcher(
  patterns: readonly string[] | undefined,
): (title: string) => boolean {
  const normalizedPatterns = (patterns ?? [])
    .map(normalizeForMatch)
    .filter((pattern) => pattern !== '');
  if (normalizedPatterns.length === 0) return () => false;

  return (title) => {
    const normalizedTitle = normalizeForMatch(title);
    return normalizedPatterns.some((pattern) => normalizedTitle.includes(pattern));
  };
}
