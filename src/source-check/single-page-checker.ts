import type { Source } from '../source-registry/schema.ts';
import type { SourceContentAnalysis } from './types.ts';

/**
 * 固定ページ自体を1件の候補として扱う。
 *
 * single_page は入口ページそのものが情報本体で、ページ内の項目に個別URLが無い。
 * ページ内を分割して複数候補にしても、Notionの重複判定は公式URL単位なので
 * 2件目以降がすべて重複になる。そのため常にSourceのURLだけを1件返し、
 * 本文とPDFの取得は後続のAI判定へ任せる。
 *
 * 掲載日は取得しない。ページ内の更新日を掲載日として使うと、初回収集開始日より前に
 * 更新されたページが期間フィルタで落ち、一度も解析されないまま静かに取りこぼす。
 * publishedAt を null にすると掲載日不明として必ず処理へ回る。
 *
 * 2回目以降に同じページをAIへ送らないための仕組みは追加していない。
 * 登録済みURLは公式URLの重複としてHTML取得・PDF抽出・Claude解析の前に除外されるため、
 * 既存の重複判定だけで「初回は解析し、以降は実行しない」が成立する。
 */
export function analyzeSinglePage(source: Source): SourceContentAnalysis {
  return {
    rawItemCount: 1,
    structurallyValidItemCount: 1,
    usableItemCount: 1,
    samples: [{ title: source.name, url: source.url, publishedAt: null }],
    warnings: [],
    exclusions: [],
    latestPublishedAt: null,
    linkSelectorStatus: 'not_configured',
    contentSelectorStatus: 'not_checked',
  };
}
