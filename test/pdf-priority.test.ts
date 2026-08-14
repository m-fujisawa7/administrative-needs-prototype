import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractDocumentFromHtml } from '../src/content-check/extract.ts';
import type { PdfLink } from '../src/content-check/types.ts';
import { classifyPdfPriority, selectPdfsByPriority } from '../src/ai/pdf-priority.ts';

const BASE = 'https://www.city.example.lg.jp/page/';

function link(text: string, filename = 'doc.pdf'): PdfLink {
  return { url: `${BASE}${filename}`, text };
}

const names = (links: readonly PdfLink[]): string[] => links.map((entry) => entry.text);

describe('classifyPdfPriority', () => {
  it('行政ニーズを直接記載する文書を高優先にする', () => {
    for (const text of [
      '情報提供依頼書', 'RFI実施要領', 'RFCのお知らせ', '仕様書', '要求仕様書',
      '実施要領', '募集要項', '公募要領', '提案募集の手引き', '業務内容説明書',
      '事業概要', '実証要領',
    ]) {
      expect(classifyPdfPriority(link(text)), text).toBe('high');
    }
  });

  it('案件理解に役立つ文書を中優先にする', () => {
    for (const text of ['概要', '説明資料', '参考資料', '実施計画', 'ガイドライン']) {
      expect(classifyPdfPriority(link(text)), text).toBe('medium');
    }
  });

  it('分析への寄与が小さい文書を低優先にする', () => {
    for (const text of [
      '申込書', '応募様式', '様式集', 'チラシ', 'フライヤー',
      'アクセスマップ', '会場地図', '料金表',
    ]) {
      expect(classifyPdfPriority(link(text)), text).toBe('low');
    }
  });

  it('要求事項を読み取れる仕様書・要領・概要を高優先にする', () => {
    for (const text of [
      '基本仕様書', '業務仕様書', '要求仕様書', '調達仕様書',
      '募集要領', '公募要領', '実施要領', '業務概要', '事業概要',
    ]) {
      expect(classifyPdfPriority(link(text)), text).toBe('high');
    }
  });

  it('評価・様式・契約手続きの資料を低優先にする', () => {
    for (const text of [
      '評価基準', '審査基準', '採点表', '評価項目',
      '申請書', '参加申込書', '質問書', '質問票',
      '契約書案', '契約約款', '入札書', '委任状',
    ]) {
      expect(classifyPdfPriority(link(text)), text).toBe('low');
    }
  });

  it('括弧付きの契約書と質問回答の言い回しの違いを吸収して低優先にする', () => {
    for (const text of [
      '契約書案', '契約書（案）', '契約書(案)', '業務委託契約書',
      '質問書', '質問票', '質問及び回答（8月5日回答）', '質問と回答', '質問への回答',
    ]) {
      expect(classifyPdfPriority(link(text)), text).toBe('low');
    }
  });

  it('実測で3枠目に入っていた添付資料を低優先にする', () => {
    for (const text of [
      '別記個人情報取扱特記事項（PDF：153KB）',
      '委託業務特記事項',
      '（別添）CMS業者への再委託見積額（PDF：286KB）',
      '見積書',
      '４ 配置図 (PDF 821KB)',
      '・企画提案書作成要領 (PDF 125KB)',
    ]) {
      expect(classifyPdfPriority(link(text)), text).toBe('low');
    }
  });

  it('特記事項や見積を含んでも仕様書・要領なら高優先を維持する', () => {
    for (const text of [
      '業務仕様書（特記事項含む）',
      '実施要領（見積書の書き方を含む）',
      '公募要領及び配置図',
    ]) {
      expect(classifyPdfPriority(link(text)), text).toBe('high');
    }
  });

  it('有用PDFがあるとき特記事項・見積額はAI入力へ送らない', () => {
    const links = [
      link('公募型プロポーザル実施要領', 'a.pdf'),
      link('業務委託仕様書', 'b.pdf'),
      link('別記個人情報取扱特記事項', 'c.pdf'),
      link('（別添）再委託見積額', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3)))
      .toEqual(['公募型プロポーザル実施要領', '業務委託仕様書']);
  });

  it('キーワードに該当しない文書はその他にする', () => {
    expect(classifyPdfPriority(link('議事録'))).toBe('other');
    expect(classifyPdfPriority(link(''))).toBe('other');
  });

  it('高優先キーワードが低優先キーワードより強い', () => {
    expect(classifyPdfPriority(link('募集要項及び応募様式'))).toBe('high');
    expect(classifyPdfPriority(link('仕様書（様式集付き）'))).toBe('high');
  });

  it('事業概要は高優先、単なる概要は中優先', () => {
    expect(classifyPdfPriority(link('事業概要'))).toBe('high');
    expect(classifyPdfPriority(link('概要'))).toBe('medium');
  });

  it('リンクテキストが空でもファイル名で判定する', () => {
    expect(classifyPdfPriority(link('', '実施要領.pdf'))).toBe('high');
    expect(classifyPdfPriority(link('', '応募様式.pdf'))).toBe('low');
  });

  it('パーセントエンコードされた日本語ファイル名を判定できる', () => {
    expect(classifyPdfPriority({
      url: `${BASE}${encodeURIComponent('募集要項')}.pdf`,
      text: '',
    })).toBe('high');
  });

  it('URLパスのキーワードでも判定する', () => {
    expect(classifyPdfPriority({ url: `${BASE}rfi/a.pdf`, text: '' })).toBe('high');
  });

  it('全角・半角と大文字小文字の差を吸収する（既存のnormalizeForMatchを再利用）', () => {
    expect(classifyPdfPriority(link('ｒｆｉ実施要領'))).toBe('high');
    expect(classifyPdfPriority(link('rfi'))).toBe('high');
    expect(classifyPdfPriority(link('RFI'))).toBe('high');
    expect(classifyPdfPriority(link('実 施 要 領'))).toBe('high');
  });

  it('壊れたパーセントエンコードでも例外にしない', () => {
    expect(() => classifyPdfPriority({ url: `${BASE}%E0%A4%A.pdf`, text: '仕様書' })).not.toThrow();
    expect(classifyPdfPriority({ url: `${BASE}%E0%A4%A.pdf`, text: '仕様書' })).toBe('high');
  });
});

describe('selectPdfsByPriority', () => {
  it('上限以下でも、高価値PDFがあれば低優先PDFをAI入力へ送らない', () => {
    const links = [link('チラシ', 'a.pdf'), link('仕様書', 'b.pdf')];
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['仕様書']);
  });

  it('ちょうど上限件数でも、枠を埋めるために低優先PDFを送らない', () => {
    const links = [link('チラシ', 'a.pdf'), link('地図', 'b.pdf'), link('仕様書', 'c.pdf')];
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['仕様書']);
  });

  it('仕様書・募集要領・評価基準の3件では評価基準を送らない', () => {
    const links = [
      link('基本仕様書', 'a.pdf'),
      link('公募実施要領', 'b.pdf'),
      link('評価基準', 'c.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['基本仕様書', '公募実施要領']);
  });

  it('低優先しか無い場合はPDFを捨てず全件を候補にする', () => {
    const links = [
      link('評価基準', 'a.pdf'),
      link('様式1 参加申込書', 'b.pdf'),
      link('委任状', 'c.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3)))
      .toEqual(['評価基準', '様式1 参加申込書', '委任状']);
  });

  it('低優先PDFが1件だけの場合もそのまま送る', () => {
    expect(names(selectPdfsByPriority([link('評価基準', 'a.pdf')], 3))).toEqual(['評価基準']);
  });

  it('低優先しか無く上限を超える場合は上限まで掲載順で送る', () => {
    const links = [
      link('様式1', 'a.pdf'), link('様式2', 'b.pdf'),
      link('様式3', 'c.pdf'), link('様式4', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['様式1', '様式2', '様式3']);
  });

  it('4件以上でも最大3件に絞る', () => {
    const links = Array.from({ length: 14 }, (_v, i) => link(`資料${i}`, `${i}.pdf`));
    expect(selectPdfsByPriority(links, 3)).toHaveLength(3);
  });

  it('後ろにある仕様書を先頭の低優先PDFより優先する', () => {
    const links = [
      link('チラシ', 'a.pdf'),
      link('アクセスマップ', 'b.pdf'),
      link('応募様式', 'c.pdf'),
      link('仕様書', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3))[0]).toBe('仕様書');
  });

  it('情報提供依頼書とRFIを優先する', () => {
    const links = [
      link('会場地図', 'a.pdf'),
      link('申込書', 'b.pdf'),
      link('情報提供依頼書', 'c.pdf'),
      link('RFI回答様式の説明', 'd.pdf'),
    ];
    const selected = names(selectPdfsByPriority(links, 3));
    expect(selected[0]).toBe('情報提供依頼書');
    expect(selected[1]).toBe('RFI回答様式の説明');
  });

  it('募集要項と実施要領を優先する', () => {
    const links = [
      link('チラシ', 'a.pdf'),
      link('募集要項', 'b.pdf'),
      link('参考資料', 'c.pdf'),
      link('実施要領', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3)).slice(0, 2)).toEqual(['募集要項', '実施要領']);
  });

  it('申込様式・チラシ・地図は最後尾に回る', () => {
    const links = [
      link('申込書', 'a.pdf'),
      link('チラシ', 'b.pdf'),
      link('会場地図', 'c.pdf'),
      link('議事録', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3))[0]).toBe('議事録');
  });

  it('高優先が3件未満なら中優先・その他で残り枠を埋める', () => {
    const links = [
      link('チラシ', 'a.pdf'),
      link('仕様書', 'b.pdf'),
      link('議事録', 'c.pdf'),
      link('参考資料', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['仕様書', '参考資料', '議事録']);
  });

  it('高優先が1件でも、残り枠を低優先で埋めない', () => {
    const links = [
      link('仕様書', 'a.pdf'),
      link('チラシ', 'b.pdf'),
      link('申込書', 'c.pdf'),
      link('会場地図', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['仕様書']);
  });

  it('同じ優先度では元の掲載順を維持する', () => {
    const links = [
      link('仕様書A', 'a.pdf'),
      link('実施要領B', 'b.pdf'),
      link('募集要項C', 'c.pdf'),
      link('公募要領D', 'd.pdf'),
    ];
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['仕様書A', '実施要領B', '募集要項C']);
  });

  it('キーワードに該当しないPDFだけでも従来どおり先頭3件を選ぶ', () => {
    const links = Array.from({ length: 7 }, (_v, i) => link(`資料${i}`, `${i}.pdf`));
    expect(names(selectPdfsByPriority(links, 3))).toEqual(['資料0', '資料1', '資料2']);
  });

  it('PDFが0件なら空配列を返す', () => {
    expect(selectPdfsByPriority([], 3)).toEqual([]);
  });

  it('上限0なら空配列を返す', () => {
    expect(selectPdfsByPriority([link('仕様書')], 0)).toEqual([]);
  });

  it('同じ入力なら毎回同じ結果になる', () => {
    const links = [
      link('チラシ', 'a.pdf'), link('仕様書', 'b.pdf'), link('概要', 'c.pdf'),
      link('議事録', 'd.pdf'), link('募集要項', 'e.pdf'),
    ];
    const first = names(selectPdfsByPriority(links, 3));
    for (let i = 0; i < 5; i += 1) {
      expect(names(selectPdfsByPriority(links, 3))).toEqual(first);
    }
  });
});

describe('実データ: 大阪市CXサービスデザインRFI', () => {
  const document = extractDocumentFromHtml({
    html: readFileSync('test/fixtures/rfi.html', 'utf8'),
    url: 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html',
    contentSelector: '#mol_contents',
  });

  it('PDFリンクのテキストを保持する', () => {
    expect(document.pdfLinks.length).toBeGreaterThan(0);
    const youryou = document.pdfLinks.find((entry) => entry.url.includes('01_youryou5.pdf'));
    expect(youryou?.text).toContain('実施要領');
  });

  it('pdfUrls は pdfLinks と同じ並びを保つ', () => {
    expect(document.pdfUrls).toEqual(document.pdfLinks.map((entry) => entry.url));
  });

  it('ローマ字ファイル名でもリンクテキストから高優先と判定できる', () => {
    const youryou = document.pdfLinks.find((entry) => entry.url.includes('01_youryou5.pdf'));
    expect(youryou).toBeDefined();
    // ファイル名は 01_youryou5.pdf でキーワードに当たらないが、
    // リンクテキストの「01_実施要領(PDF形式, 877.40KB)」で高優先になる。
    expect(classifyPdfPriority(youryou as PdfLink)).toBe('high');
  });
});
