import { describe, expect, it } from 'vitest';
import {
  countWarningsBySeverity,
  formatWarningLine,
  warningSeverity,
} from '../src/ai/warning-severity.ts';
import type { AiCheckWarning } from '../src/ai/types.ts';

const warning = (
  code: AiCheckWarning['code'],
  message = 'メッセージ',
  detail?: string,
): AiCheckWarning => ({
  code,
  message,
  ...(detail === undefined ? {} : { detail }),
});

describe('warningSeverity: NOTICE', () => {
  it('pdf_limit はNOTICE', () => {
    expect(warningSeverity(warning(
      'pdf_limit',
      '検出したPDF 8件から、優先度に基づき3件を解析します: 実施要領 / 仕様書 / 参考資料',
    ))).toBe('notice');
  });

  it('pdf_truncated はNOTICE', () => {
    expect(warningSeverity(warning(
      'pdf_truncated',
      'PDF本文合計を 64979 文字から 50000 文字へ切り詰めました（a.pdf 30000→17500）。',
    ))).toBe('notice');
  });

  it('PDFの日本語文字間空白はNOTICE', () => {
    expect(warningSeverity(warning(
      'pdf_warning',
      'https://a.jp/x.pdf: 日本語の文字間に空白が多く、読みやすさに影響する可能性があります。',
      'japanese_character_spacing',
    ))).toBe('notice');
  });

  it('公開日候補を取得できない場合はNOTICE', () => {
    expect(warningSeverity(warning(
      'content_warning',
      '公開日候補を取得できませんでした。',
    ))).toBe('notice');
  });

  it('再試行して成功した ai_json_parse_retry はNOTICE', () => {
    expect(warningSeverity(warning(
      'ai_json_parse_retry',
      '初回の行政ニーズJSONを解析できなかったため、Claude CLIを1回再試行して成功しました。',
    ))).toBe('notice');
  });
});

describe('warningSeverity: WARNING', () => {
  it('pdf_failed はWARNING', () => {
    expect(warningSeverity(warning(
      'pdf_failed',
      'PDF本文を取得できないためHTMLだけで続行します: https://a.jp/x.pdf',
    ))).toBe('warning');
  });

  it('PDFの大部分でテキスト抽出できない場合はWARNING', () => {
    expect(warningSeverity(warning(
      'pdf_warning',
      'https://a.jp/x.pdf: 12ページ中10ページでテキストを抽出できませんでした。',
      'empty_pages',
    ))).toBe('warning');
  });

  it('evidence_not_found はWARNING', () => {
    expect(warningSeverity(warning(
      'evidence_not_found',
      '根拠引用を入力原文で確認できませんでした: https://a.jp/x',
    ))).toBe('warning');
  });

  it('html_truncated はWARNING（本文の情報欠落）', () => {
    expect(warningSeverity(warning('html_truncated'))).toBe('warning');
  });

  it('公開日以外の content_warning はWARNING', () => {
    expect(warningSeverity(warning(
      'content_warning',
      'body全体を本文として使用したため、共通メニュー等が含まれていないか確認してください。',
    ))).toBe('warning');
  });

  it('内訳コードのない pdf_warning は安全側でWARNING', () => {
    expect(warningSeverity(warning('pdf_warning', '未知のPDF警告'))).toBe('warning');
  });

  it('未知の内訳コードの pdf_warning もWARNING', () => {
    expect(warningSeverity(warning('pdf_warning', '未知', 'unknown_detail'))).toBe('warning');
  });
});

describe('formatWarningLine', () => {
  it('NOTICEとWARNINGをラベルで区別する', () => {
    expect(formatWarningLine(warning('pdf_limit', '3件を解析します')))
      .toBe('[NOTICE] [pdf_limit] 3件を解析します');
    expect(formatWarningLine(warning('pdf_failed', '取得できません')))
      .toBe('[WARNING] [pdf_failed] 取得できません');
  });

  it('進捗プレフィックスを先頭に付ける', () => {
    expect(formatWarningLine(warning('pdf_limit', '3件'), '[2/5] '))
      .toBe('[2/5] [NOTICE] [pdf_limit] 3件');
  });
});

describe('countWarningsBySeverity', () => {
  it('NOTICEをWarning件数に含めない', () => {
    const counts = countWarningsBySeverity([
      warning('pdf_limit'),
      warning('pdf_truncated'),
      warning('pdf_warning', '空白', 'japanese_character_spacing'),
      warning('content_warning', '公開日候補を取得できませんでした。'),
      warning('evidence_not_found'),
    ]);
    expect(counts).toEqual({ notices: 4, warnings: 1 });
  });

  it('警告が0件なら両方0', () => {
    expect(countWarningsBySeverity([])).toEqual({ notices: 0, warnings: 0 });
  });

  it('すべてWARNINGならnoticesは0', () => {
    expect(countWarningsBySeverity([warning('pdf_failed'), warning('evidence_not_found')]))
      .toEqual({ notices: 0, warnings: 2 });
  });
});

describe('動作へ影響しないこと', () => {
  it('AI解析失敗はwarningではなく例外・失敗ステータスのままで、この分類の対象外', () => {
    // AI解析そのものの失敗は AiCheckWarning を経由せず、
    // source-verify では status: 'failed'、各コマンドでは終了コード1として扱われる。
    // warningSeverity が扱うのは「処理継続できた事象」だけであることを固定する。
    const codes: AiCheckWarning['code'][] = [
      'content_warning', 'pdf_limit', 'pdf_failed', 'pdf_warning',
      'html_truncated', 'pdf_truncated', 'ai_json_parse_retry', 'evidence_not_found',
    ];
    for (const code of codes) {
      expect(['notice', 'warning']).toContain(warningSeverity(warning(code)));
    }
  });

  it('重要度判定は入力の警告オブジェクトを変更しない', () => {
    const original = warning('pdf_limit', '3件を解析します');
    const snapshot = { ...original };
    warningSeverity(original);
    formatWarningLine(original);
    countWarningsBySeverity([original]);
    expect(original).toEqual(snapshot);
  });

  it('同じ警告なら毎回同じ重要度になる', () => {
    const target = warning('pdf_warning', '空白', 'japanese_character_spacing');
    const first = warningSeverity(target);
    for (let i = 0; i < 5; i += 1) expect(warningSeverity(target)).toBe(first);
  });
});
