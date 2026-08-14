/**
 * `Math.sumPrecise` のpolyfill。
 *
 * ## なぜ必要か
 *
 * unpdf が同梱する PDF.js は `Math.sumPrecise` を使う（フォント再構築時のグリフ
 * サイズ合計、XFAのテーブル列幅、テキスト幅の算出）。この関数はTC39提案で、
 * V8 は 14.6（Node 26.7.0）でもまだ実装していない。そのため該当コードパスへ
 * 入るPDFだけが `Math.sumPrecise is not a function` で解析に失敗していた。
 *
 * Node更新では解決せず（Node 25.2.1 / V8 14.1 と Node 26.7.0 / V8 14.6 の両方で
 * undefined）、unpdf 1.6.2〜1.8.1 のいずれも同じ呼び出しを含むため、依存の
 * バージョン変更でも回避できない。よってこのpolyfillを入れている。
 *
 * **V8がこの関数を実装したら削除できる。** `installMathSumPrecise` は既に存在
 * する場合は上書きしないため、実装後は自動的にランタイム側が使われる。
 *
 * ## 実装
 *
 * Shewchuk の非重複展開（exact expansion）で丸め誤差を出さずに合計し、最後に
 * 1回だけ丸める。素朴な加算やKahan法と違い、`[1e100, 1, -1e100]` のような
 * 桁落ちするケースでも結果が正しくなる。
 */

declare global {
  interface Math {
    /**
     * TC39提案。V8が未実装のため任意プロパティとして宣言し、
     * `installMathSumPrecise` で補う。実装後はランタイム側が使われる。
     */
    sumPrecise?: (items: Iterable<number>) => number;
  }
}

/** 合計結果を返す。仕様どおり空のiterableでは -0 を返す。 */
export function sumPrecise(items: Iterable<number>): number {
  if (items === null || items === undefined || typeof (items as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    throw new TypeError('Math.sumPrecise requires an iterable of numbers.');
  }

  let hasNaN = false;
  let hasPositiveInfinity = false;
  let hasNegativeInfinity = false;
  // 非重複展開。各要素は互いに桁が重ならないため、合計しても情報が落ちない。
  const partials: number[] = [];

  for (const item of items) {
    if (typeof item !== 'number') {
      throw new TypeError('Math.sumPrecise requires an iterable of numbers.');
    }
    if (Number.isNaN(item)) {
      hasNaN = true;
      continue;
    }
    if (item === Number.POSITIVE_INFINITY) {
      hasPositiveInfinity = true;
      continue;
    }
    if (item === Number.NEGATIVE_INFINITY) {
      hasNegativeInfinity = true;
      continue;
    }
    addToExpansion(partials, item);
  }

  if (hasNaN) return Number.NaN;
  // 両方向の無限大が混ざる場合は NaN、片方だけならその無限大。
  if (hasPositiveInfinity && hasNegativeInfinity) return Number.NaN;
  if (hasPositiveInfinity) return Number.POSITIVE_INFINITY;
  if (hasNegativeInfinity) return Number.NEGATIVE_INFINITY;
  if (partials.length === 0) return -0;

  // 小さい桁から足すことで、最後の1回だけ丸めが起きる。
  let total = 0;
  for (let index = partials.length - 1; index >= 0; index -= 1) {
    total += partials[index]!;
  }
  return total;
}

/**
 * 展開へ1要素を加える。two-sum で誤差項を取り出し、既存要素と重ならない形へ整える。
 */
function addToExpansion(partials: number[], value: number): void {
  let current = value;
  let writeIndex = 0;
  for (const partial of partials) {
    let large = current;
    let small = partial;
    if (Math.abs(large) < Math.abs(small)) {
      large = partial;
      small = current;
    }
    const sum = large + small;
    // 丸めで落ちた分。sum と error の和は large + small と数学的に等しい。
    const error = small - (sum - large);
    if (error !== 0) {
      partials[writeIndex] = error;
      writeIndex += 1;
    }
    current = sum;
  }
  partials.length = writeIndex;
  if (current !== 0 || partials.length === 0) {
    partials.push(current);
  }
}

/**
 * ランタイムに `sumPrecise` が無ければ追加する。既にあれば触らない。
 * 戻り値はテストと診断のためだけに使う。
 */
export function installMathSumPrecise(
  target: { sumPrecise?: unknown } = Math,
): 'installed' | 'already-available' {
  if (typeof target.sumPrecise === 'function') return 'already-available';
  Object.defineProperty(target, 'sumPrecise', {
    value: sumPrecise,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return 'installed';
}
