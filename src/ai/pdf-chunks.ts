import { OMITTED_MARKER, truncateHeadTail } from './input.ts';

/**
 * 長大PDFからAI入力へ渡す原文を選ぶ。
 *
 * 目的は「20,000文字へ機械的に切る」を「行政ニーズ判断に重要そうな原文を
 * budget以内で選ぶ」へ置き換えること。AIは使わず決定論的なルールだけで決める。
 * 選んだ本文は抽出原文そのままで、要約・言い換え・並べ替えはしない。
 *
 * 確信が持てないPDFでは既存の先頭70%＋末尾30%へfallbackする。断片だけを
 * 送って情報を失うより、従来方式のほうが安全なため。
 */

/** 見出し・本文の両方で数える、曖昧さの少ないセクション語。 */
const SECTION_KEYWORDS = [
  '目的', '背景', '趣旨', '現状', '課題', '事業概要', '業務概要', '業務内容',
  '委託内容', '実施内容', '要求仕様', '機能要件', '非機能要件', '提案内容',
  '提案事項', '企画提案', '成果物', '期待する効果', '官民連携', 'オンライン手続',
] as const;

/**
 * 見出しの中でだけ数える語。
 *
 * 「仕様」「システム」「AI」などは契約条項や事務連絡の本文にも散らばるため、
 * 本文出現で加点すると定型条項が高得点になってしまう。見出しに現れた場合だけ
 * セクションの主題を表すと見なす。
 */
const HEADING_ONLY_KEYWORDS = [
  '仕様', '要件', '成果', '実証', '構築', '開発', '運用', '保守', '改善',
  'bpr', 'dx', 'ai', 'データ', 'システム', 'web', 'cms',
] as const;

/** 行政ニーズ抽出への寄与が小さいことが多いセクション。除外はせず順位を下げる。 */
const LOW_PRIORITY_KEYWORDS = [
  '参加資格', '応募資格', '提出方法', '提出書類', 'スケジュール', '質問方法',
  '契約手続', '支払', '著作権', '個人情報', '様式', '審査方法', '評価基準',
  '採点', '問い合わせ先', '問合せ先',
] as const;

/**
 * 「1.」「（1）」「第3条」「一、」「1 」などの見出し番号。
 * 実データでは「２ 業務内容」のように番号と見出し語が空白区切りの形も多い。
 */
const NUMBER_PREFIX = /^(?:[0-9０-９]{1,2}[.．、)）]|[（(][0-9０-９]{1,2}[）)]|第[0-9０-９一二三四五六七八九十]{1,3}[章条項節]|[一二三四五六七八九十]{1,3}[.．、]|[0-9０-９]{1,2}[ 　]+|[一二三四五六七八九十]{1,3}[ 　]+)\s*/u;

/** 見出しラベルの最大長。これより長い行は番号付きでも本文と見なす。 */
const MAX_HEADING_LABEL_LENGTH = 20;
/** 冒頭に保険として残す文字数。案件名・目的が冒頭にあることが多い。 */
const LEAD_RESERVE_CHARACTERS = 1_500;
/** この点数以上のUnitだけを主選択の対象にする。 */
const RELEVANT_SCORE_THRESHOLD = 1.5;
/** 断片化しすぎたと見なす連続ブロック数。 */
const MAX_CONTIGUOUS_RUNS = 10;
/** 選択量がbudgetのこの割合を下回ったら判定が弱いと見なす。 */
const MIN_BUDGET_RATIO = 0.25;

export type PdfSelectionStrategy = 'full' | 'relevant_chunks' | 'fallback_truncate';

export type PdfSelectionResult = {
  text: string;
  strategy: PdfSelectionStrategy;
  /** 連続ブロック数。full は 1、fallback_truncate は 2（先頭と末尾）。 */
  chunkCount: number;
};

export type SelectPdfTextInput = {
  text: string;
  /** PDF抽出のページ本文。text と一致する場合だけページ単位で使う。 */
  pageTexts?: readonly string[];
  /** このPDFへ割り当てられた最終的なAI入力budget。 */
  budget: number;
};

export function selectPdfTextForBudget(input: SelectPdfTextInput): PdfSelectionResult {
  const { text, budget } = input;
  if (budget < 1) return { text: '', strategy: 'full', chunkCount: 0 };
  // 短いPDFは従来どおり全文。Chunk選択のロジック自体を通さない。
  if (text.length <= budget) return { text, strategy: 'full', chunkCount: 1 };

  const units = splitIntoUnits(text, input.pageTexts, budget);
  const fallback = (): PdfSelectionResult => ({
    text: truncateHeadTail(text, budget).text,
    strategy: 'fallback_truncate',
    chunkCount: 2,
  });
  if (units.length < 2) return fallback();

  const scored = units.map((unit, index) => ({ index, unit, ...scoreUnit(unit) }));
  // 見出しが1つも取れないPDFは構造を利用できないので従来方式へ。
  if (scored.every((entry) => entry.headingCount === 0)) return fallback();
  if (scored.every((entry) => entry.score < RELEVANT_SCORE_THRESHOLD)) return fallback();

  const selected = selectUnits(scored, budget);
  const fitted = fitWithinBudget(selected, scored, units, budget);
  if (fitted === null) return fallback();
  const runs = toContiguousRuns(fitted.indexes);
  const total = fitted.indexes.reduce((sum, index) => sum + units[index]!.length, 0);
  // 断片が多すぎる、または選べた量が少なすぎる場合は判定が弱いと見なす。
  if (runs.length > MAX_CONTIGUOUS_RUNS) return fallback();
  if (total < budget * MIN_BUDGET_RATIO) return fallback();

  return { text: fitted.text, strategy: 'relevant_chunks', chunkCount: runs.length };
}

/** 選択したUnitを連結する。連続していない箇所には省略マーカーを入れる。 */
function buildText(indexes: readonly number[], units: readonly string[]): string {
  return toContiguousRuns(indexes)
    .map((run) => run.map((index) => units[index]!).join(UNIT_SEPARATOR))
    .join(OMITTED_MARKER);
}

/**
 * 連結後の長さがbudgetに収まるまで、最も点数の低いUnitを外す。
 *
 * 区切り文字の分でわずかに超えることがあるため、ここで調整する。先頭70%＋末尾30%へ
 * 再切り詰めしないのは、選んだ重要箇所が後段で落ちるのを避けるため。
 */
function fitWithinBudget(
  selected: ReadonlySet<number>,
  scored: readonly { index: number; score: number }[],
  units: readonly string[],
  budget: number,
): { indexes: number[]; text: string } | null {
  let indexes = [...selected].sort((a, b) => a - b);
  for (let guard = 0; guard <= selected.size; guard += 1) {
    const text = buildText(indexes, units);
    if (text.length <= budget) return { indexes, text };
    if (indexes.length <= 1) return null;
    const lowest = indexes.reduce((min, index) =>
      (scored[index]!.score < scored[min]!.score ? index : min), indexes[0]!);
    indexes = indexes.filter((index) => index !== lowest);
  }
  return null;
}

/** ページ本文を text へ戻すときの区切り。pdf-check の join と同じにする。 */
const UNIT_SEPARATOR = '\n\n';

/**
 * Unitへ分割する。ページ境界が本文と一致する場合だけページを使い、
 * 使えない場合は空行区切りの段落へ落とす。PDF抽出側は変更しない。
 */
function splitIntoUnits(
  text: string,
  pageTexts: readonly string[] | undefined,
  budget: number,
): string[] {
  if (pageTexts !== undefined && pageTexts.length >= 2) {
    const rebuilt = pageTexts.join(UNIT_SEPARATOR).trim();
    const usable = rebuilt === text
      && pageTexts.every((page) => page.length <= budget);
    if (usable) return [...pageTexts];
  }
  const paragraphs = text.split(/\n{2,}/u).map((part) => part.trim()).filter((part) => part !== '');
  if (paragraphs.length >= 2 && paragraphs.every((part) => part.length <= budget)) {
    return paragraphs;
  }
  return [];
}

/**
 * 3段構えで選ぶ。
 *
 * 1. 冒頭の保険。案件名や目的が冒頭にあることが多いため少量だけ確保する
 * 2. 得点順。閾値以上のUnitと、その直後のUnit（見出しと本文の分断を避ける）
 * 3. 隣接展開。残り予算を既に選んだ範囲の隣へ使い、断片化を減らす
 */
function selectUnits(
  scored: readonly { index: number; unit: string; score: number }[],
  budget: number,
): Set<number> {
  const selected = new Set<number>();
  let total = 0;
  const add = (index: number): boolean => {
    const length = scored[index]?.unit.length;
    if (length === undefined || selected.has(index) || total + length > budget) return false;
    selected.add(index);
    total += length;
    return true;
  };

  for (const entry of scored) {
    if (total + entry.unit.length > LEAD_RESERVE_CHARACTERS) break;
    if (!add(entry.index)) break;
  }

  const byScore = [...scored].sort((a, b) => (b.score - a.score) || (a.index - b.index));
  for (const entry of byScore) {
    if (entry.score < RELEVANT_SCORE_THRESHOLD) break;
    add(entry.index);
    // 見出しだけ残って本文が切れる状態を避けるため、直後のUnitも文脈として入れる。
    add(entry.index + 1);
  }

  for (;;) {
    const adjacent = scored.filter((entry) =>
      !selected.has(entry.index)
      && (selected.has(entry.index - 1) || selected.has(entry.index + 1))
      && total + entry.unit.length <= budget);
    if (adjacent.length === 0) break;
    adjacent.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    add(adjacent[0]!.index);
  }
  return selected;
}

function toContiguousRuns(indexes: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const index of indexes) {
    const last = runs.at(-1);
    if (last !== undefined && last.at(-1) === index - 1) last.push(index);
    else runs.push([index]);
  }
  return runs;
}

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase();

/**
 * 見出しらしい行の「ラベル部分」を返す。見出しでなければ null。
 *
 * 番号付きの本文（「(4) 前各号に掲げる場合のほか、…」）を見出しと誤認しないよう、
 * 番号を外した先頭語だけを見る。日本語の見出しは語中に空白を持たないため、
 * 最初の空白までをラベルとして扱える。
 */
function headingLabel(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const numbered = NUMBER_PREFIX.test(trimmed);
  const label = trimmed.replace(NUMBER_PREFIX, '').split(/[ 　\t]/u)[0] ?? '';
  if (label === '' || label.length > MAX_HEADING_LABEL_LENGTH) return null;
  if (/[。、]/u.test(label)) return null;
  // 番号が無い場合は、短く句点で終わらない行だけを見出しとして扱う。
  if (!numbered && (trimmed.length > MAX_HEADING_LABEL_LENGTH || /[。、]$/u.test(trimmed))) {
    return null;
  }
  return label;
}

function countMatches(haystack: string, words: readonly string[]): number {
  const normalized = normalize(haystack);
  return words.filter((word) => normalized.includes(normalize(word))).length;
}

/** Unit1件の得点と見出し数。乱数も時刻も使わないため同じ入力なら同じ結果になる。 */
function scoreUnit(unit: string): { score: number; headingCount: number } {
  const labels = unit
    .split('\n')
    .map(headingLabel)
    .filter((label): label is string => label !== null)
    .map(normalize);
  const relevantHeadings = labels.filter((label) =>
    SECTION_KEYWORDS.some((word) => label.includes(normalize(word)))
    || HEADING_ONLY_KEYWORDS.some((word) => label.includes(normalize(word)))).length;
  const lowHeadings = labels.filter((label) =>
    LOW_PRIORITY_KEYWORDS.some((word) => label.includes(normalize(word)))).length;
  const bodySections = Math.min(countMatches(unit, SECTION_KEYWORDS), 5);
  const bodyLow = Math.min(countMatches(unit, LOW_PRIORITY_KEYWORDS), 5);
  const score = 4 * Math.min(relevantHeadings, 4)
    + bodySections
    - 3 * Math.min(lowHeadings, 4)
    - 0.5 * bodyLow;
  return { score, headingCount: labels.length };
}
