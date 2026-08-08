import type { AiCheckWarning } from './types.ts';

/**
 * ログ上の重要度。処理ロジックや成功判定には一切影響しない。
 *
 * - notice : 処理は想定どおり継続しており、基本的にユーザー対応が不要
 * - warning: 情報欠落や品質低下の可能性があり、ユーザーが確認した方がよい
 */
export type WarningSeverity = 'notice' | 'warning';

/** code だけで NOTICE と判断できるもの。 */
const NOTICE_CODES = new Set(['pdf_limit', 'pdf_truncated', 'ai_json_parse_retry']);

/**
 * pdf_warning の内訳のうち NOTICE 扱いにするもの。
 * empty_pages（ページのテキスト抽出欠落）は情報欠落なので WARNING のまま。
 */
const NOTICE_PDF_DETAILS = new Set(['japanese_character_spacing']);

/** content_warning のうち NOTICE 扱いにする文言。 */
const NOTICE_CONTENT_MESSAGES = ['公開日候補を取得できませんでした'];

/**
 * 警告のログ重要度を判定する。
 * source:verify と collect:run を含む全CLIがこの1関数を使う。
 */
export function warningSeverity(warning: AiCheckWarning): WarningSeverity {
  if (NOTICE_CODES.has(warning.code)) return 'notice';

  if (warning.code === 'pdf_warning') {
    // 内訳コードがない場合は安全側に倒して WARNING のままにする。
    return warning.detail !== undefined && NOTICE_PDF_DETAILS.has(warning.detail)
      ? 'notice'
      : 'warning';
  }

  if (warning.code === 'content_warning') {
    return NOTICE_CONTENT_MESSAGES.some((message) => warning.message.includes(message))
      ? 'notice'
      : 'warning';
  }

  return 'warning';
}

/** ログ1行を組み立てる。prefix は `[1/5] ` のような進捗表示に使う。 */
export function formatWarningLine(warning: AiCheckWarning, prefix = ''): string {
  const label = warningSeverity(warning) === 'notice' ? 'NOTICE' : 'WARNING';
  return `${prefix}[${label}] [${warning.code}] ${warning.message}`;
}

/** サマリー用の件数。NOTICE は warnings に含めない。 */
export function countWarningsBySeverity(
  warnings: readonly AiCheckWarning[],
): { notices: number; warnings: number } {
  let notices = 0;
  let warningCount = 0;
  for (const warning of warnings) {
    if (warningSeverity(warning) === 'notice') notices += 1;
    else warningCount += 1;
  }
  return { notices, warnings: warningCount };
}
