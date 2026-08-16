import { createHash } from 'node:crypto';

/**
 * PDF本文の内容重複を判定するためのfingerprintを作る。
 *
 * 正規化は trim と連続空白の圧縮だけで、NFKCや空白の全削除は行わない。
 * 福岡市DX戦略の本編（16,881文字）と印刷用（16,887文字）を実測したところ、
 * 差は空白だけで、この正規化のみで16,851文字の完全一致になった。
 * これより強い正規化を使う根拠が実データに無く、弱いほど誤検知しにくい。
 *
 * 完全一致だけを見る。類似度の計算は行わない。実測した4情報源29ペアのうち
 * 一致したのは福岡の1ペアだけで、残りは別文書として区別できていた。
 *
 * 切り詰めやRelevant Chunk選択より前の抽出原文へ適用すること。
 */
export function pdfContentFingerprint(text: string): string {
  const normalized = text.trim().replaceAll(/\s+/gu, ' ');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
