/**
 * 個別ページのHTMLから本文を抽出できなかった場合のエラー。
 *
 * 取得（SourceCheckFetchError）とAI判定（AiAnalyzerError）のどちらでもないため、
 * 型で区別できないと失敗ステージがai_analysisへ、メッセージがNotion登録用の
 * 汎用文へ落ちてしまう。実際の原因を表示するために専用の型にしている。
 */
export class ContentExtractionError extends Error {
  override name = 'ContentExtractionError';
}
