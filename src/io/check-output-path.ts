import { join } from 'node:path';

export type CheckOutputKind = 'source-check' | 'content-check' | 'pdf-check';

const SAFE_OUTPUT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function defaultCheckOutputPath(kind: CheckOutputKind, key: string): string {
  if (!SAFE_OUTPUT_KEY.test(key)) {
    throw new Error('自動保存先の識別子は小文字英数字とハイフンで指定してください。');
  }
  return join('data', 'logs', kind, `${key}.json`);
}
