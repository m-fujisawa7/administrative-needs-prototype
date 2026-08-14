import { describe, expect, it } from 'vitest';
import { OMITTED_MARKER, truncateHeadTail } from '../src/ai/input.ts';
import { selectPdfTextForBudget } from '../src/ai/pdf-chunks.ts';

/** 見出し＋本文のページを作る。 */
function page(heading: string, body: string, length = 900): string {
  const filler = body.repeat(Math.max(1, Math.ceil(length / body.length)));
  return `${heading}\n${filler.slice(0, length - heading.length - 1)}`;
}

const SPEC_PAGES = [
  page('1 目的', 'この委託の目的は行政サービスの改善である。'),
  page('2 業務内容', '受注者は次の業務を行う。窓口対応と入力処理を含む。'),
  page('(1) 機能要件', 'システムは申請の受付と進捗管理を行うこと。'),
  page('(2) 成果物', '設計書と運用マニュアルを納品すること。'),
];
const BOILERPLATE_PAGES = [
  page('第1条 総則', '発注者と受注者は信義に従い誠実にこれを履行する。'),
  page('(1) 参加資格', '提出書類は様式第1号による。審査方法は別に定める。'),
  page('(2) 提出方法', '評価基準は採点表による。問い合わせ先は下記のとおり。'),
  page('第2条 支払', '著作権は発注者に帰属する。個人情報の取扱いは別紙による。'),
];

describe('selectPdfTextForBudget', () => {
  it('budget以内のPDFは全文をそのまま使う', () => {
    const text = SPEC_PAGES.join('\n\n');
    const result = selectPdfTextForBudget({ text, pageTexts: SPEC_PAGES, budget: 20_000 });
    expect(result.strategy).toBe('full');
    expect(result.text).toBe(text);
    expect(result.chunkCount).toBe(1);
  });

  it('budgetを超える場合だけRelevant Chunk選択に入る', () => {
    const pages = [...SPEC_PAGES, ...BOILERPLATE_PAGES];
    const text = pages.join('\n\n');
    const result = selectPdfTextForBudget({ text, pageTexts: pages, budget: 3_000 });
    expect(result.strategy).toBe('relevant_chunks');
    expect(result.text.length).toBeLessThanOrEqual(3_000);
  });

  it('重要セクションを定型条項より優先する', () => {
    // 定型条項を先頭に置き、重要セクションを後ろへ置いても選ばれることを見る。
    const pages = [...BOILERPLATE_PAGES, ...SPEC_PAGES];
    const result = selectPdfTextForBudget({
      text: pages.join('\n\n'),
      pageTexts: pages,
      budget: 4_600,
    });
    expect(result.strategy).toBe('relevant_chunks');
    for (const heading of ['目的', '業務内容', '機能要件', '成果物']) {
      expect(result.text, heading).toContain(heading);
    }
    // 参加資格・提出方法・支払の定型条項は入らない（冒頭保険の第1条だけは残る）。
    expect(result.text.includes('提出書類は様式第1号による')).toBe(false);
    expect(result.text.includes('評価基準は採点表による')).toBe(false);
    expect(result.text.includes('著作権は発注者に帰属する')).toBe(false);
  });

  it('選んだChunkの本文が元原文と一致し、元の順序を保つ', () => {
    const pages = [...SPEC_PAGES, ...BOILERPLATE_PAGES];
    const result = selectPdfTextForBudget({
      text: pages.join('\n\n'),
      pageTexts: pages,
      budget: 3_000,
    });
    // 省略マーカーで区切られた各断片が、元のページ本文の連結として存在する。
    const segments = result.text.split(OMITTED_MARKER);
    let searchFrom = 0;
    for (const segment of segments) {
      const found = pages.join('\n\n').indexOf(segment, searchFrom);
      expect(found, segment.slice(0, 20)).toBeGreaterThanOrEqual(0);
      searchFrom = found + segment.length;
    }
  });

  it('選んだページを二重に入れない', () => {
    const pages = [...SPEC_PAGES, ...BOILERPLATE_PAGES];
    const result = selectPdfTextForBudget({
      text: pages.join('\n\n'),
      pageTexts: pages,
      budget: 3_000,
    });
    // 各ページ本文は最大1回しか現れない（冒頭保険と得点選択の二重追加を防ぐ）。
    for (const unit of pages) {
      expect(result.text.split(unit).length - 1, unit.slice(0, 12)).toBeLessThanOrEqual(1);
    }
  });

  it('見出しの直後のページを文脈として残す', () => {
    const heading = page('1 業務内容', 'あ', 60);
    const body = page('詳細', 'この業務では窓口対応と入力処理を行う。', 900);
    const pages = [heading, body, ...BOILERPLATE_PAGES];
    const result = selectPdfTextForBudget({
      text: pages.join('\n\n'),
      pageTexts: pages,
      budget: 1_500,
    });
    expect(result.text).toContain('業務内容');
    expect(result.text).toContain('窓口対応と入力処理');
  });

  it('Relevantだけで足りる場合はbudgetまで埋めない', () => {
    const pages = [SPEC_PAGES[0]!, ...BOILERPLATE_PAGES, ...BOILERPLATE_PAGES];
    const result = selectPdfTextForBudget({
      text: pages.join('\n\n'),
      pageTexts: pages,
      budget: 9_000,
    });
    if (result.strategy === 'relevant_chunks') {
      expect(result.text.length).toBeLessThan(9_000);
    }
  });

  it('見出しが取れない長大PDFは既存の70/30へfallbackする', () => {
    const pages = Array.from({ length: 8 }, () => 'あ'.repeat(900));
    const text = pages.join('\n\n');
    const result = selectPdfTextForBudget({ text, pageTexts: pages, budget: 3_000 });
    expect(result.strategy).toBe('fallback_truncate');
    expect(result.text).toBe(truncateHeadTail(text, 3_000).text);
  });

  it('Relevant候補が全く無い長大PDFもfallbackする', () => {
    const pages = [...BOILERPLATE_PAGES, ...BOILERPLATE_PAGES];
    const text = pages.join('\n\n');
    const result = selectPdfTextForBudget({ text, pageTexts: pages, budget: 3_000 });
    expect(result.strategy).toBe('fallback_truncate');
    expect(result.text).toBe(truncateHeadTail(text, 3_000).text);
  });

  it('ページ境界が本文と一致しない場合は段落で分割する', () => {
    const pages = [...SPEC_PAGES, ...BOILERPLATE_PAGES];
    const text = pages.join('\n\n');
    // 意図的に不整合なpageTextsを渡す。
    const result = selectPdfTextForBudget({
      text,
      pageTexts: ['まったく別の内容'],
      budget: 3_000,
    });
    expect(result.text.length).toBeLessThanOrEqual(3_000);
    expect(['relevant_chunks', 'fallback_truncate']).toContain(result.strategy);
  });

  it('pageTextsが無くても段落構造で選択できる', () => {
    const pages = [...SPEC_PAGES, ...BOILERPLATE_PAGES];
    const text = pages.join('\n\n');
    const result = selectPdfTextForBudget({ text, budget: 3_000 });
    expect(result.text.length).toBeLessThanOrEqual(3_000);
  });

  it('結果は必ずbudget以内で、同じ入力なら毎回同じになる', () => {
    const pages = [...SPEC_PAGES, ...BOILERPLATE_PAGES];
    const input = { text: pages.join('\n\n'), pageTexts: pages, budget: 2_500 };
    const first = selectPdfTextForBudget(input);
    expect(first.text.length).toBeLessThanOrEqual(2_500);
    for (let i = 0; i < 4; i += 1) {
      expect(selectPdfTextForBudget(input).text).toBe(first.text);
    }
  });
});
