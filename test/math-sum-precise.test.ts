import { describe, expect, it } from 'vitest';
import { installMathSumPrecise, sumPrecise } from '../src/pdf-check/math-sum-precise.ts';

describe('sumPrecise', () => {
  it('空のiterableは-0を返す', () => {
    expect(Object.is(sumPrecise([]), -0)).toBe(true);
  });

  it('整数列を正確に合計する（pdf.jsが実際に使う用途）', () => {
    expect(sumPrecise([1, 2, 3])).toBe(6);
    expect(sumPrecise([12, 40, 8, 4])).toBe(64);
    expect(sumPrecise([])).toBe(-0);
  });

  it('素朴な加算では誤差が出る組み合わせを丸め誤差なしで合計する', () => {
    // 0.1 + 0.2 は素朴な加算だと 0.30000000000000004 になる。
    expect(sumPrecise([0.1, 0.2])).toBe(0.30000000000000004);
    // 大きな値で小さな値が消える古典的なケース。
    expect(sumPrecise([1e100, 1, -1e100])).toBe(1);
    expect(sumPrecise([1e16, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toBe(10000000000000010);
  });

  it('順序を入れ替えても同じ結果になる', () => {
    const values = [1e100, 1, -1e100, 2, 3];
    expect(sumPrecise(values)).toBe(sumPrecise([...values].reverse()));
  });

  it('NaNが含まれればNaNを返す', () => {
    expect(sumPrecise([1, Number.NaN, 2])).toBeNaN();
    expect(sumPrecise([Number.POSITIVE_INFINITY, Number.NaN])).toBeNaN();
  });

  it('無限大の扱いを仕様どおりにする', () => {
    expect(sumPrecise([1, Number.POSITIVE_INFINITY])).toBe(Number.POSITIVE_INFINITY);
    expect(sumPrecise([1, Number.NEGATIVE_INFINITY])).toBe(Number.NEGATIVE_INFINITY);
    // 両方の無限大が混ざる場合はNaN。
    expect(sumPrecise([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toBeNaN();
  });

  it('iterableでない引数と数値でない要素をTypeErrorにする', () => {
    expect(() => sumPrecise(1 as unknown as number[])).toThrow(TypeError);
    expect(() => sumPrecise(['1'] as unknown as number[])).toThrow(TypeError);
    expect(() => sumPrecise([1, null] as unknown as number[])).toThrow(TypeError);
  });

  it('Set などのiterableも受け取る', () => {
    expect(sumPrecise(new Set([1, 2, 3]))).toBe(6);
  });
});

describe('installMathSumPrecise', () => {
  it('未実装のランタイムにだけ追加する', () => {
    const target: { sumPrecise?: unknown } = {};
    expect(installMathSumPrecise(target)).toBe('installed');
    expect(typeof target.sumPrecise).toBe('function');
    expect((target.sumPrecise as (v: number[]) => number)([1, 2])).toBe(3);
  });

  it('既にランタイムが持っている場合は上書きしない', () => {
    const native = (): number => 42;
    const target: { sumPrecise?: unknown } = { sumPrecise: native };
    expect(installMathSumPrecise(target)).toBe('already-available');
    expect(target.sumPrecise).toBe(native);
  });

  it('PDF抽出モジュールを読み込むとMath.sumPreciseが使える状態になる', async () => {
    // PDF.jsの遅延importより先に補われている必要がある。
    await import('../src/pdf-check/extract.ts');
    expect(typeof Math.sumPrecise).toBe('function');
    expect(Math.sumPrecise!([1, 2, 3])).toBe(6);
  });
});
