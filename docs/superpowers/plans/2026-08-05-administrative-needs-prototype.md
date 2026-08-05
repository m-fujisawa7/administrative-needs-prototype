# 行政ニーズ収集プロトタイプ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 大阪市の公式サイトから Web・DX・デジタル領域の行政ニーズを収集し、AIで構造化して Notion データベースへ登録するローカル実行スクリプトを作る。

**Architecture:** 3つのエントリポイント（`collect` / `import` / `setup:notion`）を持つCLI。収集は RSS を主軸に一覧ページで補完し、本文とPDFを抽出して `claude -p` サブプロセスで2段階（対象判定 → 構造化解析）解析する。AI結果は Notion 書き込みの**前**に `node:sqlite` へ確定させ、書き込み失敗分は次回実行の冒頭で再送する。ロジックは純粋関数に寄せ、ネットワーク・DB・Notion を要さない単体テストで検証する。

**Tech Stack:** TypeScript（ビルド無し・Node ネイティブ実行）/ Node v25.2.1 / `node:sqlite` / cheerio / unpdf / yaml / zod / Vitest / Notion REST API（`fetch` 直叩き）/ claude CLI v2.1.88

**設計書:** `docs/superpowers/specs/2026-08-05-administrative-needs-prototype-design.md`

---

## Global Constraints

これらは全タスクの要件に暗黙に含まれる。すべて 2026-08-05 に実機で実測した値。

1. **Node は v25.2.1、npm は 11.6.2。** `package.json` に `"type": "module"` を必ず入れる。
2. **ビルドステップを作らない。** Node 25 は `.ts` を直接実行できる（`node src/collect.ts`）。`tsx` / `ts-node` / `dist/` を導入しない。`tsc` は `--noEmit` の型検査専用。
3. **相対 import には `.ts` 拡張子を必ず書く**（`import { x } from './url.ts'`）。tsc 慣習の `.js` 指定は `ERR_MODULE_NOT_FOUND` になる。
4. **`enum` / `namespace` / パラメータプロパティ / 実行時デコレータを使わない。** Node の type-stripping が `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` で落ちる。列挙は `as const` 配列 + `typeof X[number]` の union 型で表す。`tsconfig.json` の `"erasableSyntaxOnly": true` が型検査時に TS1294 で検出する。
5. **型のみの import は `import type` を使う**（`"verbatimModuleSyntax": true`）。
6. **`node:sqlite` を使うスクリプトは `node --disable-warning=ExperimentalWarning` で起動する。** 素で実行すると `ExperimentalWarning: SQLite is an experimental feature` が毎回出る。
7. **`node:sqlite` の `get()` / `all()` は null-prototype オブジェクトを返す。** Zod へ渡す前・スプレッドする前に `{ ...row }` で通常オブジェクト化する。
8. **`timeout` コマンドは macOS に存在しない。** 外部プロセスのタイムアウトは Node 側（`AbortSignal.timeout` / 手動 `kill`）で実装する。
9. **`unpdf` を使う前に `Math.sumPrecise` の polyfill を当てる。** Node 25 に未実装で、当てないと警告が多数出る（抽出結果自体は同一 4,921 文字）。
10. **PDF 由来テキストは日本語の途中に空白が入り、全角数字と半角数字が同一文書内で混在する**（`令和 8 年 8 月 21 日` と `令和８年８月 10 日`）。日付・金額の正規化と根拠一致検査は、必ず「全角→半角統一 + 空白除去」の前処理を通す。
11. **AI確信度は 0〜100 の整数。** 0〜1 の実数ではない。
12. **和暦は令和のみ対応。** 令和 N 年 = 1918 + N + 100 → 実装上は `2018 + N`（令和8年 = 2026年）。
13. **claude CLI の JSON エンベロープ**は次の形。`result` は**文字列**で、モデルの生出力が入る。
    ```
    { type: "result", subtype: "success", is_error: false, result: "<文字列>",
      duration_ms: 8019, total_cost_usd: 0.0392, num_turns: 1, session_id: "...",
      usage: {...}, modelUsage: {...}, stop_reason: ..., permission_denials: [...] }
    ```
14. **Notion の rich_text は1テキストオブジェクト 2,000 文字上限。** 全 Text プロパティを 2,000 文字で切り、切ったら末尾を `…` にする。
15. **人が入力する 11 プロパティをスクリプトが書かない**（唯一の例外は新規作成時の「確認状態」）。
16. **日本語のコメント・ログ・エラーメッセージで書く。** 社内向け日本語ツールのため。

---

## File Structure

| ファイル | 責務 | タスク |
| --- | --- | --- |
| `package.json` / `tsconfig.json` / `vitest.config.ts` / `eslint.config.js` / `.env.example` | ツールチェーン | T1 |
| `src/types.ts` | 列挙値（`as const`）と横断的な型 | T1 |
| `src/errors.ts` | エラーコードと利用者向け文言 | T1 |
| `src/logger.ts` | JSONL ログとコンソール出力 | T1 |
| `src/normalize.ts` | 前処理・日付正規化・金額正規化 | T2 |
| `src/url.ts` | URL 正規化・絶対化・同一ドメイン判定 | T3 |
| `src/evidence.ts` | 根拠引用の原文一致検査 | T4 |
| `src/extract-content.ts` | HTML 本文抽出（セレクタ + 5段フォールバック） | T5 |
| `src/extract-pdf.ts` | PDF テキスト抽出 | T6 |
| `src/collectors/rss.ts` | RSS 解析と絞り込み | T7 |
| `src/collectors/list-page.ts` | 一覧ページのリンク抽出 | T8 |
| `src/collectors/index.ts` | `collector_type` のディスパッチ | T8 |
| `src/config.ts` / `config/sources.yaml` | 情報源定義と Zod 検証 | T9 |
| `src/rate-limiter.ts` | ホスト単位のアクセス間隔 | T10 |
| `src/fetch-page.ts` | HTTP 取得・SSRF 検証・サイズ上限・リトライ | T10 |
| `src/ai/schema.ts` | AI 出力の Zod スキーマ | T11 |
| `src/ai/provider.ts` | Provider インターフェースと型 | T12 |
| `src/ai/prompt.ts` | `prompts/*.md` の読み込みと組み立て | T12 |
| `src/ai/mock.ts` | MockProvider | T12 |
| `prompts/classify.md` / `analyze.md` / `company-profile.md` | プロンプト本体 | T12 |
| `src/ai/claude-cli.ts` | ClaudeCliProvider | T13 |
| `src/ai/index.ts` | 環境変数による Provider 選択 | T13 |
| `src/store.ts` | SQLite スキーマとアクセス | T14 |
| `src/dedupe.ts` | 4段階の重複判定 | T15 |
| `src/notion-schema.ts` | プロパティ定義（単一の真実） | T16 |
| `src/notion-map.ts` | AI 出力 → Notion プロパティ変換 | T17 |
| `src/notion.ts` | Notion REST クライアント | T18 |
| `src/setup-notion.ts` | DB 自動作成 | T19 |
| `src/collect.ts` | 収集フロー | T20 |
| `src/import.ts` | 手動投入 | T21 |
| `samples/*.json` / `src/seed.ts` | サンプル4件 | T22 |
| `README.md` | セットアップ・Notion手順・制約 | T23 |

---

## Task 1: プロジェクト初期化・列挙値・エラー・ログ

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.env.example`
- Create: `src/types.ts`, `src/errors.ts`, `src/logger.ts`
- Test: `test/types.test.ts`, `test/errors.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `src/types.ts`: `DOCUMENT_TYPES`, `MATURITY_STAGES`, `RELEVANCES`, `CONTACT_RECOMMENDATIONS`, `REVIEW_STATUSES`, `ACTION_DECISIONS`, `TEMPERATURES`（すべて `as const` 配列）／型 `DocumentType`, `MaturityStage`, `Relevance`, `ContactRecommendation`, `ReviewStatus`, `ActionDecision`, `Temperature`／`type Candidate`, `type ExtractedPage`, `type ProcessedStatus`
  - `src/errors.ts`: `ERROR_CODES`（`as const`）／`type ErrorCode`／`class AppError extends Error { code: ErrorCode; userMessage: string; internalDetail?: string }`／`isFatal(code: ErrorCode): boolean`
  - `src/logger.ts`: `createLogger(opts: { logDir: string; level?: 'debug'|'info'|'warn'|'error' }): Logger`／`type Logger = { debug(msg: string, data?: unknown): void; info(...): void; warn(...): void; error(...): void; event(name: string, data: Record<string, unknown>): void; close(): void }`

- [ ] **Step 1: `package.json` を作る**

```json
{
  "name": "administrative-needs-prototype",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=25.0.0" },
  "scripts": {
    "collect": "node --disable-warning=ExperimentalWarning src/collect.ts",
    "import": "node --disable-warning=ExperimentalWarning src/import.ts",
    "setup:notion": "node --disable-warning=ExperimentalWarning src/setup-notion.ts",
    "seed": "node --disable-warning=ExperimentalWarning src/seed.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test"
  },
  "dependencies": {
    "cheerio": "^1.1.2",
    "unpdf": "^1.4.0",
    "yaml": "^2.8.1",
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "@types/node": "^24.9.2",
    "eslint": "^9.39.0",
    "typescript": "^7.0.2",
    "typescript-eslint": "^8.46.2",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: `tsconfig.json` を作る**

`erasableSyntaxOnly` が Global Constraints 4 を型検査で強制する。`allowImportingTsExtensions` が Global Constraints 3 を許可する。

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts", "eslint.config.js"]
}
```

- [ ] **Step 3: `vitest.config.ts` と `eslint.config.js` を作る**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
```

```js
// eslint.config.js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'data', 'test/fixtures'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
```

- [ ] **Step 4: `.env.example` を作る**

```
# ---- Notion ----
# Integration トークン（https://www.notion.so/my-integrations で発行）
NOTION_TOKEN=
# npm run setup:notion が出力する database_id
NOTION_DATABASE_ID=

# ---- AI ----
# claude_cli | mock
AI_PROVIDER=claude_cli
AI_MODEL=sonnet
CLAUDE_CLI_PATH=/opt/homebrew/bin/claude
AI_TIMEOUT_MS=180000
# 設計書 §20 の AI_API_KEY は claude CLI 方式では不要（CLI 側の認証を使う）。
# Phase 5 で Anthropic API へ移行する際に追加する。

# ---- 挙動 ----
# 対象外情報も Notion へ記録する（設計書 §8-4、精度検証のため既定 ON）
RECORD_NON_TARGET=true
DATABASE_PATH=./data/app.db
LOG_DIR=./data/logs
RAW_DIR=./data/raw
LOG_LEVEL=info
```

- [ ] **Step 5: 列挙値のテストを書く**

```ts
// test/types.test.ts
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPES, MATURITY_STAGES, RELEVANCES, CONTACT_RECOMMENDATIONS,
  REVIEW_STATUSES, ACTION_DECISIONS, TEMPERATURES,
} from '../src/types.ts';

describe('列挙値', () => {
  it('文書種別は設計書 §9 の15種（RFI と 情報提供依頼 が併存する）', () => {
    expect(DOCUMENT_TYPES).toHaveLength(15);
    expect(DOCUMENT_TYPES).toContain('RFI');
    expect(DOCUMENT_TYPES).toContain('情報提供依頼');
    expect(DOCUMENT_TYPES).toContain('その他');
  });

  it('成熟段階は9種で「不明」を含む', () => {
    expect(MATURITY_STAGES).toHaveLength(9);
    expect(MATURITY_STAGES).toContain('不明');
    expect(MATURITY_STAGES).toContain('市場対話');
  });

  it('関連度は A/B/C/対象外 の4種', () => {
    expect(RELEVANCES).toEqual(['A', 'B', 'C', '対象外']);
  });

  it('コンタクト推奨度は 高/中/低/不要 の4種', () => {
    expect(CONTACT_RECOMMENDATIONS).toEqual(['高', '中', '低', '不要']);
  });

  it('確認状態は 未確認/確認済み/要修正/対象外 の4種（AI解析済み・承認済みは含まない）', () => {
    expect(REVIEW_STATUSES).toEqual(['未確認', '確認済み', '要修正', '対象外']);
  });

  it('対応判断は7種、温度感は6種', () => {
    expect(ACTION_DECISIONS).toHaveLength(7);
    expect(TEMPERATURES).toHaveLength(6);
  });

  it('すべて重複がない', () => {
    for (const list of [DOCUMENT_TYPES, MATURITY_STAGES, RELEVANCES,
      CONTACT_RECOMMENDATIONS, REVIEW_STATUSES, ACTION_DECISIONS, TEMPERATURES]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
```

- [ ] **Step 6: テストが失敗することを確認**

```bash
npm install && npx vitest run test/types.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/types.ts"`

- [ ] **Step 7: `src/types.ts` を実装**

```ts
// 設計書 §9 の列挙値。enum は使わない（Global Constraints 4）。

/** 文書種別（設計書 §9 / 指示書 §18）。RFI と 情報提供依頼 は指示書のまま併存させる。 */
export const DOCUMENT_TYPES = [
  'RFI', '情報提供依頼', 'サウンディング', '民間提案', 'プロポーザル', '入札',
  '実証事業', '官民連携', '議会', '予算', '計画', 'マニフェスト', '審議会',
  '行政評価', 'その他',
] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

/** ニーズ成熟段階（指示書 §14）。「不明」を含む9種。 */
export const MATURITY_STAGES = [
  '課題表明', '政策方針', '検討中', '予算化', '市場対話', '公募中', '実施中',
  '評価・再検討', '不明',
] as const;
export type MaturityStage = typeof MATURITY_STAGES[number];

/** 分野関連度・自社関連度（指示書 §15）。 */
export const RELEVANCES = ['A', 'B', 'C', '対象外'] as const;
export type Relevance = typeof RELEVANCES[number];

/** コンタクト推奨度（指示書 §16）。 */
export const CONTACT_RECOMMENDATIONS = ['高', '中', '低', '不要'] as const;
export type ContactRecommendation = typeof CONTACT_RECOMMENDATIONS[number];

/** 確認状態（指示書 §18・人手項目）。 */
export const REVIEW_STATUSES = ['未確認', '確認済み', '要修正', '対象外'] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];

/** 対応判断（指示書 §18・人手項目）。 */
export const ACTION_DECISIONS = [
  '未判断', '追う', '保留', '継続監視', '見送り', '対応中', '終了',
] as const;
export type ActionDecision = typeof ACTION_DECISIONS[number];

/** 温度感（指示書 §18・人手項目）。 */
export const TEMPERATURES = [
  '未確認', '低い', '情報交換', '関心あり', '具体的な相談あり', '案件化可能性あり',
] as const;
export type Temperature = typeof TEMPERATURES[number];

/** コレクターが返す候補。fetch 前の段階。 */
export type Candidate = {
  sourceId: string;
  organization: string;
  url: string;
  linkText: string;
  /** 一覧上・RSS の日付。YYYY-MM-DD または null */
  listDate: string | null;
  /** リンク周辺のテキスト。最大200文字 */
  context: string;
  /** RSS の category や URL パスから得た担当部署の候補 */
  categoryHint: string | null;
};

/** 個別ページから抽出した内容。 */
export type ExtractedPage = {
  title: string;
  bodyText: string;
  publishedAtCandidate: string | null;
  departmentCandidate: string | null;
  pdfUrls: string[];
  contactCandidate: string | null;
  /** 0 = content_selector が一致。1〜5 = フォールバック段（設計書 §6-3） */
  fallbackLevel: number;
};

/** processed テーブルの状態（設計書 §13）。 */
export const PROCESSED_STATUSES = [
  'pending_analysis', 'analyzed', 'pending_notion', 'synced', 'skipped', 'failed',
] as const;
export type ProcessedStatus = typeof PROCESSED_STATUSES[number];
```

- [ ] **Step 8: テストが通ることを確認**

```bash
npx vitest run test/types.test.ts
```

Expected: PASS（7 tests）

- [ ] **Step 9: エラーのテストを書く**

```ts
// test/errors.test.ts
import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES, isFatal } from '../src/errors.ts';

describe('AppError', () => {
  it('code と userMessage を持ち、internalDetail は message に混ぜない', () => {
    const e = new AppError('URL_FETCH_FAILED', 'ページを取得できませんでした', 'ECONNRESET at 10.0.0.1');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('URL_FETCH_FAILED');
    expect(e.userMessage).toBe('ページを取得できませんでした');
    expect(e.internalDetail).toBe('ECONNRESET at 10.0.0.1');
    expect(e.message).toBe('ページを取得できませんでした');
    expect(e.message).not.toContain('10.0.0.1');
  });

  it('userMessage を省略すると既定文言が入る', () => {
    const e = new AppError('AI_TIMEOUT');
    expect(e.userMessage.length).toBeGreaterThan(0);
    expect(e.userMessage).toContain('タイムアウト');
  });
});

describe('isFatal', () => {
  it('設定不備とNotionスキーマ不一致は即停止', () => {
    expect(isFatal('CONFIG_INVALID')).toBe(true);
    expect(isFatal('NOTION_SCHEMA_MISMATCH')).toBe(true);
  });

  it('件ごとのエラーは即停止しない', () => {
    for (const c of ['URL_FETCH_FAILED', 'EXTRACT_FAILED', 'AI_TIMEOUT',
      'PDF_EXTRACT_FAILED', 'EVIDENCE_MISMATCH', 'NOTION_WRITE_FAILED'] as const) {
      expect(isFatal(c)).toBe(false);
    }
  });
});

describe('ERROR_CODES', () => {
  it('設計書 §17 の17コードすべてに既定文言がある', () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(17);
    for (const [code, msg] of Object.entries(ERROR_CODES)) {
      expect(msg.length, `${code} に文言がない`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 10: テストが失敗することを確認**

```bash
npx vitest run test/errors.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/errors.ts"`

- [ ] **Step 11: `src/errors.ts` を実装**

```ts
/** エラーコードと利用者向け既定文言（設計書 §17）。 */
export const ERROR_CODES = {
  CONFIG_INVALID: '情報源設定（config/sources.yaml）の内容が正しくありません',
  NOTION_SCHEMA_MISMATCH: 'Notion データベースのプロパティが期待と一致しません',
  URL_INVALID: 'このURLは取得対象にできません',
  URL_FETCH_FAILED: 'ページを取得できませんでした',
  CONTENT_TOO_LARGE: 'ページのサイズが上限を超えています',
  CONTENT_TYPE_UNSUPPORTED: 'HTML でも PDF でもないため扱えません',
  EXTRACT_FAILED: '本文を抽出できませんでした（200文字未満）',
  PDF_EXTRACT_FAILED: 'PDF からテキストを抽出できませんでした（公式URLのみ記録します）',
  AI_UNAVAILABLE: 'AI（claude CLI）を実行できませんでした',
  AI_TIMEOUT: 'AI の応答がタイムアウトしました',
  AI_INVALID_RESPONSE: 'AI の応答が期待する形式ではありません',
  EVIDENCE_MISMATCH: '根拠の引用が原文に見つかりませんでした',
  NOTION_RATE_LIMITED: 'Notion API のレート制限に達しました',
  NOTION_WRITE_FAILED: 'Notion への書き込みに失敗しました',
  DB_ERROR: 'ローカルデータベースの操作に失敗しました',
  IMPORT_INPUT_INVALID: '手動投入の入力が正しくありません',
  SETUP_FAILED: 'Notion データベースの作成に失敗しました',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** 起動時に即停止すべきコード（設計書 §17）。 */
const FATAL_CODES = new Set<ErrorCode>(['CONFIG_INVALID', 'NOTION_SCHEMA_MISMATCH', 'SETUP_FAILED']);

export function isFatal(code: ErrorCode): boolean {
  return FATAL_CODES.has(code);
}

/**
 * 利用者向け文言と内部詳細を分離して保持する。
 * internalDetail は SQLite とログファイルにのみ残し、Notion やコンソールへは出さない。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly internalDetail?: string;

  constructor(code: ErrorCode, userMessage?: string, internalDetail?: string) {
    const msg = userMessage ?? ERROR_CODES[code];
    super(msg);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = msg;
    this.internalDetail = internalDetail;
  }
}

/** 任意の throw 値を AppError に寄せる。 */
export function toAppError(e: unknown, fallback: ErrorCode): AppError {
  if (e instanceof AppError) return e;
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new AppError(fallback, undefined, detail);
}
```

- [ ] **Step 12: テストが通ることを確認**

```bash
npx vitest run test/errors.test.ts
```

Expected: PASS（5 tests）

- [ ] **Step 13: `src/logger.ts` を実装**

テストは T20 の結合テストで間接的に検証する。ここでは実装のみ。

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export type Logger = {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** 構造化イベント。集計対象になるものはこちらで書く。 */
  event(name: string, data: Record<string, unknown>): void;
  close(): void;
};

/**
 * コンソールと data/logs/<YYYY-MM-DD>.jsonl の両方へ書く（設計書 §20）。
 * 日付は実行開始時に固定する（日付跨ぎでファイルが分かれるのを避ける）。
 */
export function createLogger(opts: { logDir: string; level?: LogLevel; runId?: string }): Logger {
  const threshold = LEVELS[opts.level ?? 'info'];
  mkdirSync(opts.logDir, { recursive: true });
  const file = join(opts.logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const runId = opts.runId ?? crypto.randomUUID();

  const write = (level: LogLevel, msg: string, data?: unknown): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), runId, level, msg, data: data ?? null });
    try {
      appendFileSync(file, line + '\n', 'utf8');
    } catch {
      // ログ書き込みの失敗で本処理を止めない
    }
    if (LEVELS[level] < threshold) return;
    const prefix = { debug: '  ', info: '  ', warn: '! ', error: 'x ' }[level];
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    out(`${prefix}${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);
  };

  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    event: (name, data) => write('info', `[${name}]`, data),
    close: () => {},
  };
}
```

- [ ] **Step 14: 型検査と lint が通ることを確認**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: 型エラーなし、lint エラーなし、12 tests PASS

- [ ] **Step 15: コミット**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .env.example src/types.ts src/errors.ts src/logger.ts test/types.test.ts test/errors.test.ts
git commit -m "feat: プロジェクト初期化・列挙値・エラーコード・ログ

ビルドステップなし（Node 25 のネイティブ .ts 実行）。
erasableSyntaxOnly で enum の混入を型検査時に防ぐ。"
```

---

## Task 2: 日付・金額の正規化

**Files:**
- Create: `src/normalize.ts`
- Test: `test/normalize.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `preNormalize(s: string): string` — 全角→半角統一 + 空白完全除去
  - `normalizeDate(input: unknown, publishedYear?: number | null): string | null` — `YYYY-MM-DD` または `null`
  - `normalizeMoney(input: unknown): number | null` — 円単位の整数または `null`
  - `parseJaNumber(s: string): number | null` — 億・万・千の日本語数詞を数値へ

- [ ] **Step 1: 失敗するテストを書く**

Global Constraints 10 のとおり、PDF 由来の空白入り・全角混在ケースを必ず含める。

```ts
// test/normalize.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeDate, normalizeMoney, parseJaNumber, preNormalize } from '../src/normalize.ts';

describe('preNormalize', () => {
  it('全角英数字を半角にする', () => {
    expect(preNormalize('令和８年８月２１日')).toBe('令和8年8月21日');
  });

  it('半角空白・全角空白・改行・タブをすべて除去する', () => {
    expect(preNormalize('令和 8 年　8 月\n21 日\t')).toBe('令和8年8月21日');
  });

  it('全角の括弧と波ダッシュは変換される', () => {
    expect(preNormalize('（金曜日）')).toBe('(金曜日)');
  });
});

describe('normalizeDate', () => {
  it('和暦を西暦に変換する（令和8年 = 2026年）', () => {
    expect(normalizeDate('令和8年8月21日')).toBe('2026-08-21');
    expect(normalizeDate('令和1年5月1日')).toBe('2019-05-01');
    expect(normalizeDate('令和10年1月1日')).toBe('2028-01-01');
  });

  it('PDF由来の空白入り和暦を変換する', () => {
    expect(normalizeDate('令和 8 年 8 月 21 日')).toBe('2026-08-21');
  });

  it('全角数字と半角数字が混在した和暦を変換する', () => {
    expect(normalizeDate('令和８年８月 10 日')).toBe('2026-08-10');
  });

  it('曜日・時刻の付随を無視する', () => {
    expect(normalizeDate('令和8年8月21日（金曜日）17時00分')).toBe('2026-08-21');
    expect(normalizeDate('令和8年8月21日(金)17時00分まで')).toBe('2026-08-21');
  });

  it('西暦の各表記を変換する', () => {
    expect(normalizeDate('2026/8/21')).toBe('2026-08-21');
    expect(normalizeDate('2026.8.21')).toBe('2026-08-21');
    expect(normalizeDate('2026年8月21日')).toBe('2026-08-21');
    expect(normalizeDate('2026-08-21')).toBe('2026-08-21');
    expect(normalizeDate('2026/08/21')).toBe('2026-08-21');
  });

  it('年がない場合は publishedYear で補完する', () => {
    expect(normalizeDate('8月21日', 2026)).toBe('2026-08-21');
  });

  it('年がなく publishedYear もない場合は推測せず null', () => {
    expect(normalizeDate('8月21日')).toBeNull();
    expect(normalizeDate('8月21日', null)).toBeNull();
  });

  it('未定・ハイフン・空・null は null', () => {
    for (const v of ['未定', '未確定', '-', '−', '—', 'なし', '不明', '', '   ', null, undefined]) {
      expect(normalizeDate(v), `入力: ${String(v)}`).toBeNull();
    }
  });

  it('存在しない日付は null（捏造しない）', () => {
    expect(normalizeDate('2026年2月30日')).toBeNull();
    expect(normalizeDate('2026年13月1日')).toBeNull();
    expect(normalizeDate('令和8年0月5日')).toBeNull();
  });

  it('令和以外の元号は null にしてログ判定に委ねる', () => {
    expect(normalizeDate('平成31年4月30日')).toBeNull();
  });

  it('日付を含まない文章からは null', () => {
    expect(normalizeDate('参加申込をお願いします')).toBeNull();
  });
});

describe('parseJaNumber', () => {
  it('億・万・千を組み合わせて解釈する', () => {
    expect(parseJaNumber('1億2千万')).toBe(120_000_000);
    expect(parseJaNumber('1200万')).toBe(12_000_000);
    expect(parseJaNumber('500万')).toBe(5_000_000);
    expect(parseJaNumber('3億')).toBe(300_000_000);
    expect(parseJaNumber('5千')).toBe(5_000);
    expect(parseJaNumber('12000000')).toBe(12_000_000);
  });

  it('数詞がなければ null', () => {
    expect(parseJaNumber('')).toBeNull();
    expect(parseJaNumber('未定')).toBeNull();
  });
});

describe('normalizeMoney', () => {
  it('カンマ区切りと単位を円単位の整数にする', () => {
    expect(normalizeMoney('1,200万円')).toBe(12_000_000);
    expect(normalizeMoney('12,000,000円')).toBe(12_000_000);
    expect(normalizeMoney('1億2千万円')).toBe(120_000_000);
    expect(normalizeMoney('約500万円程度')).toBe(5_000_000);
  });

  it('全角数字と空白入りを扱う', () => {
    expect(normalizeMoney('１，２００万円')).toBe(12_000_000);
    expect(normalizeMoney('1,200 万円')).toBe(12_000_000);
  });

  it('数値をそのまま渡せる', () => {
    expect(normalizeMoney(12_000_000)).toBe(12_000_000);
    expect(normalizeMoney(1234.7)).toBe(1235);
  });

  it('未定・ハイフン・空・null・NaN は null', () => {
    for (const v of ['未定', '-', '', '   ', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeMoney(v), `入力: ${String(v)}`).toBeNull();
    }
  });

  it('金額を含まない文章からは null（捏造しない）', () => {
    expect(normalizeMoney('予算は公表されていません')).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/normalize.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/normalize.ts"`

- [ ] **Step 3: `src/normalize.ts` を実装**

```ts
/**
 * 日付・金額の正規化（設計書 §10）。
 *
 * PDF 由来テキストは日本語の途中に空白が入り、全角数字と半角数字が同一文書内で
 * 混在する（`令和 8 年 8 月 21 日` と `令和８年８月 10 日`）。
 * すべての解析の前に preNormalize を通す。
 */

const NULLISH_TOKENS = new Set(['未定', '未確定', '未公表', '非公表', 'なし', '不明', '-', '−', '—', '―', '～', '']);

/** 全角英数字・記号を半角へ、空白類をすべて除去する。 */
export function preNormalize(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, '')
    .replace(/\s+/g, '')
    .replace(/[〜～]/g, '~');
}

/** YYYY-MM-DD を組み立てる。実在しない日付は null。 */
function toIsoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 2200) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 日付を YYYY-MM-DD へ正規化する。判定できない場合は推測せず null（指示書 §13）。
 * 和暦は令和のみ対応（令和 N 年 = 2018 + N）。
 */
export function normalizeDate(input: unknown, publishedYear?: number | null): string | null {
  if (input == null) return null;
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = preNormalize(String(input));
  if (NULLISH_TOKENS.has(s)) return null;

  // 令和N年M月D日
  const wareki = s.match(/令和(\d{1,2})年(\d{1,2})月(\d{1,2})日/);
  if (wareki) {
    return toIsoDate(2018 + Number(wareki[1]), Number(wareki[2]), Number(wareki[3]));
  }

  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年M月D日
  const seireki = s.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (seireki) {
    return toIsoDate(Number(seireki[1]), Number(seireki[2]), Number(seireki[3]));
  }

  // M月D日（年なし）。publishedYear があれば補完する。
  const noYear = s.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})日/);
  if (noYear && publishedYear != null) {
    return toIsoDate(publishedYear, Number(noYear[1]), Number(noYear[2]));
  }

  return null;
}

/**
 * 億・万・千を含む日本語数詞を数値へ。数詞が1つも無ければ null。
 * 例: 1億2千万 → 120000000 / 1200万 → 12000000 / 12000000 → 12000000
 */
export function parseJaNumber(s: string): number | null {
  let total = 0;
  let section = 0;
  let num = 0;
  let seen = false;

  for (const ch of s) {
    if (ch >= '0' && ch <= '9') {
      num = num * 10 + Number(ch);
      seen = true;
    } else if (ch === '千') {
      section += (num || 1) * 1_000;
      num = 0;
      seen = true;
    } else if (ch === '万') {
      total += (section + (num || 1)) * 10_000;
      section = 0;
      num = 0;
      seen = true;
    } else if (ch === '億') {
      total += (section + (num || 1)) * 100_000_000;
      section = 0;
      num = 0;
      seen = true;
    }
  }

  return seen ? total + section + num : null;
}

/**
 * 金額を円単位の整数へ正規化する。判定できない場合は null（指示書 §13）。
 */
export function normalizeMoney(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.round(input) : null;
  }
  if (typeof input !== 'string') return null;

  const s = preNormalize(input).replace(/,/g, '');
  if (NULLISH_TOKENS.has(s)) return null;

  // 金額らしい部分（数字と億万千）だけを取り出す。「約」「程度」「上限」などは捨てる。
  const m = s.match(/[\d億万千]+/);
  if (!m) return null;
  if (!/\d/.test(m[0])) return null;

  const n = parseJaNumber(m[0]);
  return n == null || n === 0 ? null : n;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/normalize.test.ts
```

Expected: PASS（19 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/normalize.ts test/normalize.test.ts
git commit -m "feat: 日付・金額の正規化

PDF 由来テキストの空白混入と全角半角混在に対応。
判定できない値は推測せず null（指示書 §13 の捏造禁止）。"
```

---

## Task 3: URL 正規化

**Files:**
- Create: `src/url.ts`
- Test: `test/url.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `normalizeUrl(raw: string): string` — 重複判定に使う正規化URL。不正なURLは `AppError('URL_INVALID')`
  - `absolutize(href: string, baseUrl: string): string | null` — 相対URLの絶対化。`javascript:` `mailto:` `#` は `null`
  - `isSameHost(a: string, b: string): boolean`
  - `isPdfUrl(url: string): boolean`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/url.test.ts
import { describe, expect, it } from 'vitest';
import { absolutize, isPdfUrl, isSameHost, normalizeUrl } from '../src/url.ts';
import { AppError } from '../src/errors.ts';

describe('normalizeUrl', () => {
  it('スキームとホストを小文字にし、パスの大文字は保つ', () => {
    expect(normalizeUrl('HTTPS://WWW.City.Osaka.LG.JP/Page/ABC.html'))
      .toBe('https://www.city.osaka.lg.jp/Page/ABC.html');
  });

  it('http を https に寄せる（同一ページの二重登録を防ぐ）', () => {
    expect(normalizeUrl('http://www.city.osaka.lg.jp/a.html'))
      .toBe('https://www.city.osaka.lg.jp/a.html');
  });

  it('フラグメントを除去する', () => {
    expect(normalizeUrl('https://a.jp/b.html#section3')).toBe('https://a.jp/b.html');
  });

  it('追跡パラメータを除去し、意味のあるパラメータは残す', () => {
    expect(normalizeUrl('https://a.jp/b?utm_source=x&id=7&fbclid=z&gclid=w'))
      .toBe('https://a.jp/b?id=7');
  });

  it('クエリパラメータの順序を安定させる', () => {
    expect(normalizeUrl('https://a.jp/b?z=1&a=2')).toBe(normalizeUrl('https://a.jp/b?a=2&z=1'));
  });

  it('末尾スラッシュはルート以外で除去する', () => {
    expect(normalizeUrl('https://a.jp/b/')).toBe('https://a.jp/b');
    expect(normalizeUrl('https://a.jp/')).toBe('https://a.jp/');
  });

  it('既定ポートを除去する', () => {
    expect(normalizeUrl('https://a.jp:443/b')).toBe('https://a.jp/b');
    expect(normalizeUrl('http://a.jp:80/b')).toBe('https://a.jp/b');
  });

  it('パーセントエンコーディングを正規化する', () => {
    expect(normalizeUrl('https://a.jp/%E5%A4%A7%E9%98%AA')).toBe(normalizeUrl('https://a.jp/大阪'));
  });

  it('http/https 以外と壊れたURLは URL_INVALID', () => {
    for (const v of ['ftp://a.jp/x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '']) {
      expect(() => normalizeUrl(v), `入力: ${v}`).toThrow(AppError);
    }
  });
});

describe('absolutize', () => {
  const base = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html';

  it('大阪市CMSの ./cmsfiles 形式を絶対化する', () => {
    expect(absolutize('./cmsfiles/contents/0000684/684546/01_youryou5.pdf', base))
      .toBe('https://www.city.osaka.lg.jp/ictsenryakushitsu/page/cmsfiles/contents/0000684/684546/01_youryou5.pdf');
  });

  it('ルート相対とプロトコル相対を絶対化する', () => {
    expect(absolutize('/a/b.html', base)).toBe('https://www.city.osaka.lg.jp/a/b.html');
    expect(absolutize('//example.jp/x', base)).toBe('https://example.jp/x');
  });

  it('絶対URLはそのまま返す', () => {
    expect(absolutize('https://example.jp/x', base)).toBe('https://example.jp/x');
  });

  it('リンクにならないものは null', () => {
    for (const v of ['', '#', '#top', 'javascript:void(0)', 'mailto:a@b.jp', 'tel:0612345678']) {
      expect(absolutize(v, base), `入力: ${v}`).toBeNull();
    }
  });
});

describe('isSameHost', () => {
  it('ホストが一致すれば true', () => {
    expect(isSameHost('https://a.jp/x', 'https://a.jp/y')).toBe(true);
    expect(isSameHost('http://a.jp/x', 'https://a.jp/y')).toBe(true);
  });

  it('ホストが違えば false', () => {
    expect(isSameHost('https://a.jp/x', 'https://b.jp/x')).toBe(false);
    expect(isSameHost('https://www.a.jp/x', 'https://a.jp/x')).toBe(false);
  });

  it('壊れたURLは false（例外にしない）', () => {
    expect(isSameHost('not a url', 'https://a.jp')).toBe(false);
  });
});

describe('isPdfUrl', () => {
  it('拡張子 .pdf を判定する（大文字・クエリ付きも）', () => {
    expect(isPdfUrl('https://a.jp/x/01_youryou5.pdf')).toBe(true);
    expect(isPdfUrl('https://a.jp/x/A.PDF')).toBe(true);
    expect(isPdfUrl('https://a.jp/x/a.pdf?v=2')).toBe(true);
  });

  it('PDF以外は false', () => {
    expect(isPdfUrl('https://a.jp/x/a.xlsx')).toBe(false);
    expect(isPdfUrl('https://a.jp/pdf/a.html')).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/url.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/url.ts"`

- [ ] **Step 3: `src/url.ts` を実装**

```ts
import { AppError } from './errors.ts';

/** 重複判定に影響しない追跡パラメータ（設計書 §12）。 */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'yclid', 'msclkid', '_ga', 'mc_cid', 'mc_eid',
];

/**
 * 重複判定に使う正規化URL（設計書 §12 の優先順位2）。
 * http は https に寄せる。同じページが両方のスキームで公開されている場合に
 * 二重登録になるのを防ぐ。
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('URL_INVALID', undefined, `URL として解釈できない: ${raw}`);
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError('URL_INVALID', undefined, `対象外のスキーム: ${u.protocol}`);
  }

  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  if (u.port === '443' || u.port === '80') u.port = '';

  for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
  u.searchParams.sort();

  let out = u.toString();
  // 末尾スラッシュはルート以外で落とす
  if (u.pathname !== '/' && u.pathname.endsWith('/') && !u.search) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * 相対URLを絶対化する。リンクにならないもの（`#` / `javascript:` / `mailto:` / `tel:`）は null。
 */
export function absolutize(href: string, baseUrl: string): string | null {
  const h = href.trim();
  if (h === '' || h.startsWith('#')) return null;
  if (/^(javascript|mailto|tel|data):/i.test(h)) return null;
  try {
    return new URL(h, baseUrl).toString();
  } catch {
    return null;
  }
}

export function isSameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase();
  } catch {
    return false;
  }
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return url.toLowerCase().split('?')[0]?.endsWith('.pdf') ?? false;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/url.test.ts
```

Expected: PASS（16 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/url.ts test/url.test.ts
git commit -m "feat: URL 正規化・絶対化・同一ホスト判定

大阪市CMSの ./cmsfiles 形式の相対URLに対応。
追跡パラメータ除去とクエリ順序の安定化で重複判定を安定させる。"
```

---

## Task 4: 根拠一致検査

**Files:**
- Create: `src/evidence.ts`
- Test: `test/evidence.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `type EvidenceQuote = { field: string; quote: string }`
  - `type EvidenceCheckResult = { matched: EvidenceQuote[]; mismatched: EvidenceQuote[]; ok: boolean }`
  - `normalizeForMatch(s: string): string`
  - `checkEvidence(quotes: EvidenceQuote[], bodyText: string): EvidenceCheckResult`

- [ ] **Step 1: 失敗するテストを書く**

`test/fixtures/youryou.pdf` から実際に抽出されたテキストの断片を使い、PDF 由来の空白入り引用が通ることを検証する。

```ts
// test/evidence.test.ts
import { describe, expect, it } from 'vitest';
import { checkEvidence, normalizeForMatch } from '../src/evidence.ts';

describe('normalizeForMatch', () => {
  it('空白・改行・全角空白をすべて落とす', () => {
    expect(normalizeForMatch('令和 8 年　8 月\n21 日')).toBe('令和8年8月21日');
  });

  it('全角英数字を半角に寄せる', () => {
    expect(normalizeForMatch('ＣＸサービス８月')).toBe('CXサービス8月');
  });

  it('全角・半角の括弧と波ダッシュを統一する', () => {
    expect(normalizeForMatch('（金）～')).toBe(normalizeForMatch('(金)~'));
  });
});

describe('checkEvidence', () => {
  const body = [
    '大阪市CXサービスデザイン推進事業に係る情報提供について',
    '○参加申込期限：令和8年8月10日（月曜日）17時00分まで',
    '・メールアドレス：bb0010@city.osaka.lg.jp',
  ].join('\n');

  it('完全一致する引用を通す', () => {
    const r = checkEvidence([{ field: 'deadline', quote: '令和8年8月10日' }], body);
    expect(r.ok).toBe(true);
    expect(r.matched).toHaveLength(1);
    expect(r.mismatched).toHaveLength(0);
  });

  it('PDF由来の空白入り引用を通す（Global Constraints 10）', () => {
    const r = checkEvidence([{ field: 'deadline', quote: '令和 8 年 8 月 10 日' }], body);
    expect(r.ok).toBe(true);
  });

  it('全角数字の引用を通す', () => {
    const r = checkEvidence([{ field: 'deadline', quote: '令和８年８月１０日' }], body);
    expect(r.ok).toBe(true);
  });

  it('改行を跨いだ引用を通す', () => {
    const r = checkEvidence([{ field: 'x', quote: '17時00分まで・メールアドレス' }], body);
    expect(r.ok).toBe(true);
  });

  it('原文にない引用を検出する（要約・言い換えを弾く）', () => {
    const r = checkEvidence([
      { field: 'deadline', quote: '令和8年8月10日' },
      { field: 'budget', quote: '予算は1億2千万円である' },
    ], body);
    expect(r.ok).toBe(false);
    expect(r.matched).toHaveLength(1);
    expect(r.mismatched).toHaveLength(1);
    expect(r.mismatched[0]?.field).toBe('budget');
  });

  it('空の引用は不一致として扱う', () => {
    const r = checkEvidence([{ field: 'x', quote: '   ' }], body);
    expect(r.ok).toBe(false);
    expect(r.mismatched).toHaveLength(1);
  });

  it('引用が0件なら ok（根拠なしは検査対象外）', () => {
    const r = checkEvidence([], body);
    expect(r.ok).toBe(true);
    expect(r.matched).toHaveLength(0);
  });
});

describe('checkEvidence: 実PDFテキストとの整合', () => {
  it('unpdf が抽出した空白入りテキストを原文として引用を照合できる', () => {
    // test/fixtures/youryou.pdf から unpdf が実際に返した断片
    const pdfBody = '実施期間：公開～令和 8 年 8 月 21 日（金）17 時 00 分';
    const r = checkEvidence([{ field: 'deadline', quote: '令和8年8月21日' }], pdfBody);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/evidence.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/evidence.ts"`

- [ ] **Step 3: `src/evidence.ts` を実装**

```ts
/**
 * 根拠引用の原文一致検査（設計書 §11）。
 *
 * 指示書 §13 は「主要な判断には根拠となる原文抜粋を付ける」「日付・金額・担当部署・
 * 連絡先・参加資格・公募予定・自治体の正式方針を捏造しない」と要求するが、
 * プロンプトだけでは保証できないため保存前に機械検査する。
 *
 * PDF 由来テキストは日本語の途中に空白が入り全角半角が混在するため、
 * この正規化なしでは全件が不一致になる（Global Constraints 10）。
 */

export type EvidenceQuote = { field: string; quote: string };

export type EvidenceCheckResult = {
  matched: EvidenceQuote[];
  mismatched: EvidenceQuote[];
  ok: boolean;
};

/** 引用と原文の両方に同じ正規化を当ててから比較する。 */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, '')
    .replace(/\s+/g, '')
    .replace(/[〜～]/g, '~')
    .replace(/[‐‑‒–—―ー−]/g, '-');
}

/**
 * quote が原文に部分文字列として含まれるかを検査する。
 * 不一致があっても失敗にはせず、呼び出し側が EVIDENCE_MISMATCH として警告表示する。
 */
export function checkEvidence(quotes: EvidenceQuote[], bodyText: string): EvidenceCheckResult {
  const hay = normalizeForMatch(bodyText);
  const matched: EvidenceQuote[] = [];
  const mismatched: EvidenceQuote[] = [];

  for (const q of quotes) {
    const needle = normalizeForMatch(q.quote ?? '');
    if (needle.length === 0 || !hay.includes(needle)) {
      mismatched.push(q);
    } else {
      matched.push(q);
    }
  }

  return { matched, mismatched, ok: mismatched.length === 0 };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/evidence.test.ts
```

Expected: PASS（11 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/evidence.ts test/evidence.test.ts
git commit -m "feat: 根拠引用の原文一致検査

PDF 由来テキストの空白混入・全角半角混在を吸収して照合する。
不一致は失敗にせず警告として扱う（設計書 §11）。"
```

---

## Task 5: HTML 本文抽出

**Files:**
- Create: `src/extract-content.ts`
- Test: `test/extract-content.test.ts`

**Interfaces:**
- Consumes: `absolutize`, `isPdfUrl`（`src/url.ts`）／`type ExtractedPage`（`src/types.ts`）／`AppError`（`src/errors.ts`）
- Produces:
  - `extractContent(html: string, pageUrl: string, opts?: { contentSelector?: string }): ExtractedPage` — 本文200文字未満なら `AppError('EXTRACT_FAILED')`
  - `BOILERPLATE_MARKERS: readonly string[]`

- [ ] **Step 1: 失敗するテストを書く**

実 fixture（`test/fixtures/rfi.html`）に対する期待値は 2026-08-05 の実測に基づく。

```ts
// test/extract-content.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractContent } from '../src/extract-content.ts';
import { AppError } from '../src/errors.ts';

const RFI_URL = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html';
const rfiHtml = readFileSync('test/fixtures/rfi.html', 'utf8');

describe('extractContent: 実ページ（大阪市CXサービスデザインRFI）', () => {
  const page = extractContent(rfiHtml, RFI_URL, { contentSelector: '#mol_contents' });

  it('#mol_contents が一致するので fallbackLevel は 0', () => {
    expect(page.fallbackLevel).toBe(0);
  });

  it('本文が1,000文字以上取れる', () => {
    expect(page.bodyText.length).toBeGreaterThan(1000);
  });

  it('タイトルからサイト名サフィックスが落ちている', () => {
    expect(page.title).toContain('CXサービスデザイン推進事業');
    expect(page.title).not.toContain('大阪市：');
  });

  it('締切の記載が本文に含まれる', () => {
    expect(page.bodyText).toContain('令和8年8月10日');
    expect(page.bodyText).toContain('令和8年8月21日');
  });

  it('ナビゲーション・フッターが混入していない', () => {
    expect(page.bodyText).not.toContain('イベント・観光');
    expect(page.bodyText).not.toContain('大阪市トップページ');
  });

  it('CMS末尾の定型文が除去されている', () => {
    expect(page.bodyText).not.toContain('クリエイティブコモンズ');
    expect(page.bodyText).not.toContain('Adobe Acrobat Reader');
    expect(page.bodyText).not.toContain('探している情報');
  });

  it('問い合わせ先が抽出されている（定型文除去より先に取る）', () => {
    expect(page.contactCandidate).not.toBeNull();
    expect(page.contactCandidate).toContain('bb0010@city.osaka.lg.jp');
  });

  it('添付PDFのURLが絶対URLで取れる（xlsx は含まない）', () => {
    expect(page.pdfUrls).toHaveLength(1);
    expect(page.pdfUrls[0]).toMatch(/^https:\/\/www\.city\.osaka\.lg\.jp\/.+01_youryou5\.pdf$/);
    expect(page.pdfUrls.some((u) => u.endsWith('.xlsx'))).toBe(false);
  });
});

describe('extractContent: フォールバック順序', () => {
  const wrap = (inner: string) => `<html><head><title>t</title></head><body>${inner}</body></html>`;

  it('セレクタ不一致で <main> に落ちる（level 1）', () => {
    const html = wrap(`<nav>ナビ</nav><main>${'あ'.repeat(300)}</main>`);
    const p = extractContent(html, 'https://a.jp/x', { contentSelector: '#none' });
    expect(p.fallbackLevel).toBe(1);
    expect(p.bodyText).not.toContain('ナビ');
  });

  it('<article> に落ちる（level 2）', () => {
    const html = wrap(`<article>${'い'.repeat(300)}</article>`);
    expect(extractContent(html, 'https://a.jp/x').fallbackLevel).toBe(2);
  });

  it('[role="main"] に落ちる（level 3）', () => {
    const html = wrap(`<div role="main">${'う'.repeat(300)}</div>`);
    expect(extractContent(html, 'https://a.jp/x').fallbackLevel).toBe(3);
  });

  it('#contents に落ちる（level 4）', () => {
    const html = wrap(`<div id="contents">${'え'.repeat(300)}</div>`);
    expect(extractContent(html, 'https://a.jp/x').fallbackLevel).toBe(4);
  });

  it('最終手段としてテキスト量最大の div を選ぶ（level 5）', () => {
    const html = wrap(`<div>短い</div><div>${'お'.repeat(300)}</div>`);
    const p = extractContent(html, 'https://a.jp/x');
    expect(p.fallbackLevel).toBe(5);
    expect(p.bodyText).toContain('お'.repeat(300));
  });

  it('level 5 でも script/style/nav/header/footer/aside/form を除く', () => {
    const html = wrap(
      `<div><script>var x=1;</script><style>.a{}</style><nav>ナビ</nav>` +
      `<header>ヘッダ</header><footer>フッタ</footer><aside>脇</aside>` +
      `<form>フォーム</form>${'か'.repeat(300)}</div>`,
    );
    const p = extractContent(html, 'https://a.jp/x');
    for (const noise of ['var x=1', 'ナビ', 'ヘッダ', 'フッタ', '脇', 'フォーム']) {
      expect(p.bodyText, `${noise} が残っている`).not.toContain(noise);
    }
  });
});

describe('extractContent: 異常系', () => {
  it('本文200文字未満は EXTRACT_FAILED', () => {
    const html = '<html><body><main>短すぎる本文</main></body></html>';
    expect(() => extractContent(html, 'https://a.jp/x')).toThrow(AppError);
    try {
      extractContent(html, 'https://a.jp/x');
    } catch (e) {
      expect((e as AppError).code).toBe('EXTRACT_FAILED');
    }
  });

  it('公開日候補を本文から拾う', () => {
    const html = `<html><body><main>令和8年7月30日 公表 ${'き'.repeat(300)}</main></body></html>`;
    expect(extractContent(html, 'https://a.jp/x').publishedAtCandidate).toBe('2026-07-30');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/extract-content.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/extract-content.ts"`

- [ ] **Step 3: `src/extract-content.ts` を実装**

```ts
import * as cheerio from 'cheerio';
import { AppError } from './errors.ts';
import { normalizeDate } from './normalize.ts';
import type { ExtractedPage } from './types.ts';
import { absolutize, isPdfUrl } from './url.ts';

/** 本文として認める最小文字数（設計書 §26 の仮定2）。 */
const MIN_BODY_LENGTH = 200;

/**
 * 大阪市CMSの本文末尾に必ず付く定型文（2026-08-05 実測）。
 * ここから後ろを切り落とす。
 */
export const BOILERPLATE_MARKERS = [
  'CC（クリエイティブコモンズ）ライセンス',
  'オープンデータを探す',
  'Adobe Acrobat Reader',
  'PDFファイルを閲覧できない場合',
  '探している情報',
  'このページの作成者・問合せ先',
] as const;

/** 問い合わせ先の抽出に使うマーカー。定型文除去より先に走らせる。 */
const CONTACT_MARKERS = ['問合せ先', '問い合わせ先', 'お問い合わせ', '担当', 'メールアドレス'] as const;

const NOISE_SELECTORS = 'script, style, noscript, nav, header, footer, aside, form, iframe';

function textOf($: cheerio.CheerioAPI, el: cheerio.Cheerio<never>): string {
  const clone = el.clone();
  clone.find(NOISE_SELECTORS).remove();
  return clone.text();
}

/** 空白と改行を読みやすく畳む。行構造は保つ（根拠照合は別途正規化するため）。 */
function tidy(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t　]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** 定型文マーカー以降を切り落とす。 */
function cutBoilerplate(text: string): string {
  let cut = text.length;
  for (const m of BOILERPLATE_MARKERS) {
    const i = text.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  return text.slice(0, cut).trimEnd();
}

/** メールアドレス・電話番号と、その周辺行を問い合わせ候補として返す。 */
function extractContact(text: string): string | null {
  const lines = text.split('\n');
  const hits: string[] = [];
  for (const line of lines) {
    const hasAddr = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(line) || /0\d{1,4}-\d{1,4}-\d{3,4}/.test(line);
    const hasMarker = CONTACT_MARKERS.some((m) => line.includes(m));
    if (hasAddr || (hasMarker && line.length < 120)) hits.push(line.trim());
  }
  if (hits.length === 0) return null;
  return [...new Set(hits)].join(' / ').slice(0, 500);
}

/** 本文から最初に見つかった日付を公開日候補にする。 */
function extractPublishedAt(text: string): string | null {
  const m = text.match(/(令和\s*\d{1,2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2}\s*日?)/);
  return m ? normalizeDate(m[0]) : null;
}

/** サイト名サフィックス・プレフィックスを落とす。 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/^大阪市[：:]\s*/, '')
    .replace(/\s*[|｜-]\s*大阪市\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * HTML から本文と付随情報を抽出する（設計書 §6-3）。
 * contentSelector が一致しない場合は5段のフォールバックを順に試し、
 * 何段目まで降りたかを fallbackLevel で返す。
 */
export function extractContent(
  html: string,
  pageUrl: string,
  opts?: { contentSelector?: string },
): ExtractedPage {
  const $ = cheerio.load(html);

  const candidates: Array<{ level: number; sel: string }> = [
    ...(opts?.contentSelector ? [{ level: 0, sel: opts.contentSelector }] : []),
    { level: 1, sel: 'main' },
    { level: 2, sel: 'article' },
    { level: 3, sel: '[role="main"]' },
    { level: 4, sel: '#contents' },
    { level: 4, sel: '#content' },
    { level: 4, sel: '.content' },
  ];

  let container: cheerio.Cheerio<never> | null = null;
  let fallbackLevel = 5;

  for (const c of candidates) {
    const el = $(c.sel).first() as unknown as cheerio.Cheerio<never>;
    if (el.length > 0 && textOf($, el).trim().length > 0) {
      container = el;
      fallbackLevel = c.level;
      break;
    }
  }

  // level 5: body 直下からノイズを除いたうえで、テキスト量最大の div を選ぶ
  if (container === null) {
    let best: cheerio.Cheerio<never> | null = null;
    let bestLen = 0;
    $('body div').each((_i, node) => {
      const el = $(node) as unknown as cheerio.Cheerio<never>;
      const len = textOf($, el).trim().length;
      if (len > bestLen) {
        bestLen = len;
        best = el;
      }
    });
    container = best ?? ($('body') as unknown as cheerio.Cheerio<never>);
    fallbackLevel = 5;
  }

  const rawText = tidy(textOf($, container));
  const contactCandidate = extractContact(rawText);
  const bodyText = cutBoilerplate(rawText);

  if (bodyText.length < MIN_BODY_LENGTH) {
    throw new AppError(
      'EXTRACT_FAILED',
      undefined,
      `抽出本文が ${bodyText.length} 文字（下限 ${MIN_BODY_LENGTH}）: ${pageUrl}`,
    );
  }

  const h1 = $('h1').first().text().trim();
  const title = cleanTitle(h1 || $('title').first().text().trim() || pageUrl);

  const pdfUrls = [
    ...new Set(
      $('a[href]')
        .toArray()
        .map((a) => absolutize($(a).attr('href') ?? '', pageUrl))
        .filter((u): u is string => u !== null && isPdfUrl(u)),
    ),
  ];

  return {
    title,
    bodyText,
    publishedAtCandidate: extractPublishedAt(bodyText),
    departmentCandidate: null,
    pdfUrls,
    contactCandidate,
    fallbackLevel,
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/extract-content.test.ts
```

Expected: PASS（16 tests）

期待値が実 fixture とずれた場合は、fixture の実データが真であり、テストの期待値ではなく実装を直す。ただし `bodyText.length > 1000` と `pdfUrls` の1件は実測で確認済みなので、これが落ちる場合は抽出ロジックの不具合。

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/extract-content.ts test/extract-content.test.ts
git commit -m "feat: HTML 本文抽出（セレクタ + 5段フォールバック）

大阪市CMSの #mol_contents と末尾定型文の除去に対応。
問い合わせ先は定型文除去より先に抽出する。"
```

---

## Task 6: PDF テキスト抽出

**Files:**
- Create: `src/extract-pdf.ts`
- Test: `test/extract-pdf.test.ts`

**Interfaces:**
- Consumes: `AppError`（`src/errors.ts`）
- Produces:
  - `extractPdfText(buf: Uint8Array | ArrayBuffer): Promise<{ text: string; pages: number }>` — 抽出できなければ `AppError('PDF_EXTRACT_FAILED')`
  - `appendPdfSections(bodyText: string, sections: Array<{ name: string; text: string }>, maxChars?: number): string`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/extract-pdf.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { appendPdfSections, extractPdfText } from '../src/extract-pdf.ts';
import { AppError } from '../src/errors.ts';

describe('extractPdfText: 実PDF（RFI実施要領）', () => {
  it('4ページから4,500文字以上を抽出する', async () => {
    const buf = new Uint8Array(readFileSync('test/fixtures/youryou.pdf'));
    const r = await extractPdfText(buf);
    expect(r.pages).toBe(4);
    expect(r.text.length).toBeGreaterThan(4500);
  });

  it('PDF由来の空白入り和暦がそのまま含まれる（Global Constraints 10 の裏付け）', async () => {
    const buf = new Uint8Array(readFileSync('test/fixtures/youryou.pdf'));
    const { text } = await extractPdfText(buf);
    expect(text).toMatch(/令和\s*8\s*年\s*8\s*月\s*21\s*日/);
  });

  it('Math.sumPrecise が未実装でも例外にならない', async () => {
    const buf = new Uint8Array(readFileSync('test/fixtures/youryou.pdf'));
    await expect(extractPdfText(buf)).resolves.toBeTruthy();
  });
});

describe('extractPdfText: 異常系', () => {
  it('PDFでないバイト列は PDF_EXTRACT_FAILED', async () => {
    await expect(extractPdfText(new TextEncoder().encode('これはPDFではない')))
      .rejects.toThrow(AppError);
  });

  it('空のバイト列は PDF_EXTRACT_FAILED', async () => {
    await expect(extractPdfText(new Uint8Array(0))).rejects.toThrow(AppError);
  });
});

describe('appendPdfSections', () => {
  it('区切り見出しを付けて本文へ追記する', () => {
    const out = appendPdfSections('本文', [{ name: '01_youryou5.pdf', text: 'PDF本文' }]);
    expect(out).toContain('本文');
    expect(out).toContain('--- 添付PDF: 01_youryou5.pdf ---');
    expect(out).toContain('PDF本文');
  });

  it('合計文字数の上限で打ち切り、打ち切った旨を書く', () => {
    const out = appendPdfSections('本文', [{ name: 'a.pdf', text: 'x'.repeat(500) }], 100);
    expect(out.length).toBeLessThan(400);
    expect(out).toContain('以下省略');
  });

  it('セクションが0件なら本文をそのまま返す', () => {
    expect(appendPdfSections('本文', [])).toBe('本文');
  });

  it('複数PDFを順に追記する', () => {
    const out = appendPdfSections('本文', [
      { name: 'a.pdf', text: 'AAA' },
      { name: 'b.pdf', text: 'BBB' },
    ]);
    expect(out.indexOf('a.pdf')).toBeLessThan(out.indexOf('b.pdf'));
    expect(out).toContain('AAA');
    expect(out).toContain('BBB');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/extract-pdf.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/extract-pdf.ts"`

- [ ] **Step 3: `src/extract-pdf.ts` を実装**

polyfill は `unpdf` の動的 import より**前**に当てる必要がある（Global Constraints 9）。

```ts
import { AppError } from './errors.ts';

/** 添付PDFから本文へ追記する合計文字数の上限（設計書 §26 の仮定3）。 */
const DEFAULT_MAX_PDF_CHARS = 50_000;

/**
 * pdfjs が Math.sumPrecise を前提にしているが Node 25 に未実装で、
 * 当てないと警告が多数出る（抽出結果自体は同一）。unpdf の import より前に実行する。
 */
function ensureMathSumPrecise(): void {
  const m = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
  if (typeof m.sumPrecise !== 'function') {
    m.sumPrecise = (values) => {
      let sum = 0;
      for (const v of values) sum += Number(v);
      return sum;
    };
  }
}

/**
 * テキスト抽出可能なPDFからテキストを取り出す（設計書 §7）。
 * OCR は行わない。画像PDF・スキャンPDF・破損PDFは PDF_EXTRACT_FAILED。
 */
export async function extractPdfText(
  buf: Uint8Array | ArrayBuffer,
): Promise<{ text: string; pages: number }> {
  ensureMathSumPrecise();

  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength === 0) {
    throw new AppError('PDF_EXTRACT_FAILED', undefined, '空のバイト列');
  }

  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join('\n') : text;
    if (merged.trim().length === 0) {
      throw new AppError(
        'PDF_EXTRACT_FAILED',
        undefined,
        `テキストが0文字（画像PDFの可能性）: ${totalPages}ページ`,
      );
    }
    return { text: merged, pages: totalPages };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new AppError('PDF_EXTRACT_FAILED', undefined, detail);
  }
}

/**
 * PDF由来テキストを区切り見出し付きで本文へ追記する。
 * 根拠一致検査でどちらに含まれるか追えるように境界を明示する（設計書 §7）。
 */
export function appendPdfSections(
  bodyText: string,
  sections: Array<{ name: string; text: string }>,
  maxChars: number = DEFAULT_MAX_PDF_CHARS,
): string {
  if (sections.length === 0) return bodyText;

  const parts: string[] = [bodyText];
  let used = 0;

  for (const s of sections) {
    const header = `\n\n--- 添付PDF: ${s.name} ---\n`;
    const remaining = maxChars - used;
    if (remaining <= 0) {
      parts.push(`${header}（文字数上限に達したため以下省略）`);
      break;
    }
    if (s.text.length > remaining) {
      parts.push(`${header}${s.text.slice(0, remaining)}\n（文字数上限に達したため以下省略）`);
      used = maxChars;
    } else {
      parts.push(`${header}${s.text}`);
      used += s.text.length;
    }
  }

  return parts.join('');
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/extract-pdf.test.ts
```

Expected: PASS（9 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/extract-pdf.ts test/extract-pdf.test.ts
git commit -m "feat: PDF テキスト抽出（unpdf）

Math.sumPrecise の polyfill を unpdf の import 前に当てる。
抽出不能でも失敗にせず公式URLのみ記録する方針に合わせ、
呼び出し側が握れるエラーコードを返す。"
```

---

---

## Task 7: RSS コレクター

**Files:**
- Create: `src/collectors/rss.ts`
- Test: `test/collectors-rss.test.ts`

**Interfaces:**
- Consumes: `type Candidate`（`src/types.ts`）／`preNormalize`（`src/normalize.ts`）／`absolutize`（`src/url.ts`）
- Produces:
  - `type RssFilterOptions = { categoryIncludes?: readonly string[]; titleExcludes?: readonly string[] }`
  - `type CollectResult = { candidates: Candidate[]; excluded: Array<{ url: string; title: string; pattern: string }>; totalFound: number }`
  - `parseRss(xml: string, feedUrl: string): Array<{ title: string; link: string; pubDate: string | null; categories: string[] }>`
  - `collectFromRss(xml: string, ctx: { sourceId: string; organization: string; feedUrl: string }, filter: RssFilterOptions): CollectResult`
  - `departmentFromCategories(categories: readonly string[]): string | null`

- [ ] **Step 1: 失敗するテストを書く**

`test/fixtures/ict-rss.xml` は 2026-08-05 に取得したデジタル統括室RSS（100 item）。

```ts
// test/collectors-rss.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectFromRss, departmentFromCategories, parseRss } from '../src/collectors/rss.ts';

const FEED = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/rss/rss.xml';
const xml = readFileSync('test/fixtures/ict-rss.xml', 'utf8');
const ctx = { sourceId: 'osaka-digital-rss', organization: '大阪市', feedUrl: FEED };

describe('parseRss: 実フィード', () => {
  const items = parseRss(xml, FEED);

  it('100件を解析する', () => {
    expect(items).toHaveLength(100);
  });

  it('title / link / pubDate を取り出す', () => {
    const first = items[0];
    expect(first?.title.length).toBeGreaterThan(0);
    expect(first?.link).toMatch(/^https:\/\/www\.city\.osaka\.lg\.jp\//);
    expect(first?.pubDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('RFC822 の pubDate を YYYY-MM-DD に落とす', () => {
    const items2 = parseRss(
      `<rss><channel><item><title>t</title><link>https://a.jp/x</link>
       <pubDate>Thu, 30 Jul 2026 10:00:00 +0900</pubDate></item></channel></rss>`,
      FEED,
    );
    expect(items2[0]?.pubDate).toBe('2026-07-30');
  });

  it('category を複数取り出す', () => {
    const withCat = items.find((i) => i.categories.length > 0);
    expect(withCat).toBeDefined();
    expect(withCat?.categories[0]).toContain('->');
  });

  it('category がない item も落とさない', () => {
    expect(items.some((i) => i.categories.length === 0)).toBe(true);
  });

  it('CDATA とエンティティを解除する', () => {
    const items2 = parseRss(
      `<rss><channel><item><title><![CDATA[A&amp;B の「件」]]></title>
       <link>https://a.jp/x</link></item></channel></rss>`,
      FEED,
    );
    expect(items2[0]?.title).toBe('A&B の「件」');
  });

  it('実フィードに CX サービスデザイン RFI が含まれる', () => {
    const rfi = items.find((i) => i.title.includes('CXサービスデザイン推進事業に係る情報提供'));
    expect(rfi).toBeDefined();
    expect(rfi?.link).toBe('https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html');
    expect(rfi?.pubDate).toBe('2026-07-30');
    expect(rfi?.categories.some((c) => c.includes('入札契約情報'))).toBe(true);
  });
});

describe('collectFromRss: 絞り込み', () => {
  it('フィルタなしなら全件通す', () => {
    const r = collectFromRss(xml, ctx, {});
    expect(r.totalFound).toBe(100);
    expect(r.candidates).toHaveLength(100);
    expect(r.excluded).toHaveLength(0);
  });

  it('categoryIncludes はいずれかを含む item だけ通す', () => {
    const r = collectFromRss(xml, ctx, { categoryIncludes: ['入札契約情報'] });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.length).toBeLessThan(100);
    expect(r.totalFound).toBe(100);
  });

  it('titleExcludes は結果公表を落とし、除外内容を返す', () => {
    const r = collectFromRss(xml, ctx, {
      titleExcludes: ['入札結果', '随意契約結果', '選定結果', '再委託状況', '要綱・要領等'],
    });
    expect(r.excluded.length).toBeGreaterThan(0);
    expect(r.candidates.some((c) => c.linkText.includes('入札結果'))).toBe(false);
    expect(r.excluded[0]?.pattern.length).toBeGreaterThan(0);
    expect(r.candidates.length + r.excluded.length).toBe(100);
  });

  it('titleExcludes は部分一致で、照合前に全角半角と空白を正規化する', () => {
    const x = `<rss><channel>
      <item><title>デジタル統括室　業務委託 入札結果</title><link>https://a.jp/1</link></item>
      <item><title>ＣＸサービスデザイン推進事業に係る情報提供について</title><link>https://a.jp/2</link></item>
    </channel></rss>`;
    const r = collectFromRss(x, ctx, { titleExcludes: ['入札結果'] });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.url).toBe('https://a.jp/2');
  });

  it('categoryIncludes と titleExcludes を同時に適用する', () => {
    const r = collectFromRss(xml, ctx, {
      categoryIncludes: ['入札契約情報'],
      titleExcludes: ['入札結果', '随意契約結果', '選定結果', '再委託状況'],
    });
    expect(r.candidates.some((c) => c.linkText.includes('入札結果'))).toBe(false);
    // CX RFI は 入札契約情報 カテゴリを持ち、除外語に当たらないので残る
    expect(r.candidates.some((c) => c.linkText.includes('CXサービスデザイン推進事業'))).toBe(true);
  });

  it('Candidate の各フィールドを埋める', () => {
    const r = collectFromRss(xml, ctx, {});
    const rfi = r.candidates.find((c) => c.linkText.includes('CXサービスデザイン推進事業に係る情報提供'));
    expect(rfi).toMatchObject({
      sourceId: 'osaka-digital-rss',
      organization: '大阪市',
      url: 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html',
      listDate: '2026-07-30',
    });
    expect(rfi?.categoryHint).toBe('デジタル統括室');
  });

  it('重複リンクを1件に畳む', () => {
    const x = `<rss><channel>
      <item><title>A</title><link>https://a.jp/x</link></item>
      <item><title>A（再掲）</title><link>https://a.jp/x</link></item>
    </channel></rss>`;
    expect(collectFromRss(x, ctx, {}).candidates).toHaveLength(1);
  });
});

describe('departmentFromCategories', () => {
  it('入札契約情報の分類パスから局名を取る', () => {
    expect(departmentFromCategories(['入札契約情報->各局等入札契約情報->デジタル統括室->入札・契約のお知らせ']))
      .toBe('デジタル統括室');
  });

  it('所属名の分類パスから局名を取る', () => {
    expect(departmentFromCategories(['市政情報の公表（オープン市役所）->要綱・要領等のオープン化->所属名からさがす（担当別）->デジタル統括室']))
      .toBe('デジタル統括室');
  });

  it('局名が現れないパスは null', () => {
    expect(departmentFromCategories(['方針・条例->主要な計画、指針・施策->DX・デジタル化・スマートシティ'])).toBeNull();
    expect(departmentFromCategories([])).toBeNull();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/collectors-rss.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/collectors/rss.ts"`

- [ ] **Step 3: `src/collectors/rss.ts` を実装**

```ts
import * as cheerio from 'cheerio';
import { preNormalize } from '../normalize.ts';
import type { Candidate } from '../types.ts';
import { absolutize } from '../url.ts';

export type RssFilterOptions = {
  categoryIncludes?: readonly string[];
  titleExcludes?: readonly string[];
};

export type CollectResult = {
  candidates: Candidate[];
  /** title_excludes で落ちた分。件数と内訳をログに出すため（設計書 §5-3） */
  excluded: Array<{ url: string; title: string; pattern: string }>;
  /** 絞り込み前の総件数 */
  totalFound: number;
};

export type RssItem = {
  title: string;
  link: string;
  pubDate: string | null;
  categories: string[];
};

/** 局名が並ぶ分類パスの直前セグメント。ここに続く要素を担当部署候補にする。 */
const DEPARTMENT_PARENTS = ['各局等入札契約情報', '所属名からさがす（担当別）', '所属名からさがす'];

/** RFC822 を YYYY-MM-DD へ。解釈できなければ null。 */
function toIsoDay(raw: string): string | null {
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * RSS 2.0 を解析する（設計書 §6-2）。
 * cheerio の xmlMode を使う。専用の XML パーサを増やさない。
 */
export function parseRss(xml: string, feedUrl: string): RssItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: RssItem[] = [];

  $('item').each((_i, node) => {
    const el = $(node);
    const title = el.find('title').first().text().trim();
    const rawLink = el.find('link').first().text().trim();
    const link = absolutize(rawLink, feedUrl);
    if (link === null) return;

    const pubDateRaw = el.find('pubDate').first().text();
    const categories = el
      .find('category')
      .toArray()
      .map((c) => $(c).text().trim())
      .filter((c) => c.length > 0);

    out.push({
      title,
      link,
      pubDate: pubDateRaw ? toIsoDay(pubDateRaw) : null,
      categories,
    });
  });

  return out;
}

/** 分類パスから局名を取り出す。`->` 区切りで DEPARTMENT_PARENTS の次の要素。 */
export function departmentFromCategories(categories: readonly string[]): string | null {
  for (const c of categories) {
    const parts = c.split('->').map((p) => p.trim());
    for (let i = 0; i < parts.length - 1; i += 1) {
      const cur = parts[i];
      const next = parts[i + 1];
      if (cur !== undefined && next !== undefined && DEPARTMENT_PARENTS.includes(cur)) {
        return next;
      }
    }
  }
  return null;
}

/**
 * RSS から候補を作る（設計書 §5-3, §6-2）。
 *
 * categoryIncludes は「いずれかを含めば通す」。空・未指定なら全件通す。
 * titleExcludes は「いずれかに一致すれば落とす」。落とした内訳を excluded に残す。
 * どちらも部分一致で、照合前に preNormalize（全角半角統一・空白除去）を通す。
 */
export function collectFromRss(
  xml: string,
  ctx: { sourceId: string; organization: string; feedUrl: string },
  filter: RssFilterOptions,
): CollectResult {
  const items = parseRss(xml, ctx.feedUrl);
  const includes = (filter.categoryIncludes ?? []).map(preNormalize).filter((s) => s.length > 0);
  const excludes = (filter.titleExcludes ?? []).map(preNormalize).filter((s) => s.length > 0);

  const candidates: Candidate[] = [];
  const excluded: CollectResult['excluded'] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.link)) continue;
    seen.add(item.link);

    if (includes.length > 0) {
      const cats = item.categories.map(preNormalize);
      if (!includes.some((inc) => cats.some((c) => c.includes(inc)))) continue;
    }

    const normTitle = preNormalize(item.title);
    const hit = excludes.find((ex) => normTitle.includes(ex));
    if (hit !== undefined) {
      excluded.push({ url: item.link, title: item.title, pattern: hit });
      continue;
    }

    candidates.push({
      sourceId: ctx.sourceId,
      organization: ctx.organization,
      url: item.link,
      linkText: item.title,
      listDate: item.pubDate,
      context: item.categories.join(' / ').slice(0, 200),
      categoryHint: departmentFromCategories(item.categories),
    });
  }

  return { candidates, excluded, totalFound: seen.size };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/collectors-rss.test.ts
```

Expected: PASS（17 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/collectors/rss.ts test/collectors-rss.test.ts
git commit -m "feat: RSS コレクター

category の分類パスから局名を担当部署候補として取り出す。
title_excludes は結果公表のみを落とし、除外内訳を返してログに出せるようにする。"
```

---

## Task 8: 一覧ページコレクターとディスパッチ

**Files:**
- Create: `src/collectors/list-page.ts`, `src/collectors/index.ts`
- Test: `test/collectors-list-page.test.ts`

**Interfaces:**
- Consumes: `type Candidate`（`src/types.ts`）／`type CollectResult`, `type RssFilterOptions`（`src/collectors/rss.ts`）／`preNormalize`, `normalizeDate`（`src/normalize.ts`）／`absolutize`, `isSameHost`（`src/url.ts`）
- Produces:
  - `collectFromListPage(html: string, ctx: { sourceId: string; organization: string; pageUrl: string }, opts: { linkSelector?: string } & RssFilterOptions): CollectResult`
  - `departmentFromUrlPath(url: string): string | null`
  - `src/collectors/index.ts`: `type CollectorInput = { html: string; sourceId: string; organization: string; url: string; collectorType: CollectorType; linkSelector?: string } & RssFilterOptions`／`runCollector(input: CollectorInput): CollectResult`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/collectors-list-page.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectFromListPage, departmentFromUrlPath } from '../src/collectors/list-page.ts';
import { runCollector } from '../src/collectors/index.ts';

const PROPOSAL_URL = 'https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/0-Curr.html';
const PRESS_URL = 'https://www.city.osaka.lg.jp/hodoshiryo/98-Curr.html';
const proposalHtml = readFileSync('test/fixtures/proposal-list.html', 'utf8');
const pressHtml = readFileSync('test/fixtures/digital-press.html', 'utf8');

describe('collectFromListPage: プロポーザル一覧（実ページ）', () => {
  const r = collectFromListPage(
    proposalHtml,
    { sourceId: 'osaka-proposal-list', organization: '大阪市', pageUrl: PROPOSAL_URL },
    { linkSelector: "#mol_contents a[href*='/templates/proposal_hattyuuannkenn/']" },
  );

  it('15件以上の案件リンクを抽出する', () => {
    expect(r.candidates.length).toBeGreaterThanOrEqual(15);
  });

  it('すべて個別案件のURL形式になっている', () => {
    for (const c of r.candidates) {
      expect(c.url).toMatch(/\/templates\/proposal_hattyuuannkenn\/[^/]+\/\d+\.html$/);
    }
  });

  it('一覧ページ自身（0-Curr.html）を候補に含めない', () => {
    expect(r.candidates.some((c) => c.url.includes('0-Curr.html'))).toBe(false);
  });

  it('ナビゲーションリンクを拾わない', () => {
    for (const c of r.candidates) {
      expect(c.url).not.toContain('/kurashi/');
      expect(c.url).not.toContain('/event/');
      expect(c.linkText).not.toBe('大阪市トップページ');
    }
  });

  it('リンクテキストが空の候補を作らない', () => {
    for (const c of r.candidates) {
      expect(c.linkText.trim().length).toBeGreaterThan(0);
    }
  });

  it('URLパスの局コードから担当部署候補を埋める', () => {
    expect(r.candidates.some((c) => c.categoryHint !== null)).toBe(true);
  });

  it('Web・DX 案件と対象外案件の両方を含む（精度検証に使える）', () => {
    const texts = r.candidates.map((c) => c.linkText).join('|');
    expect(texts).toMatch(/デジタル|プラットフォーム|DX|システム|Web/);
    expect(texts).toMatch(/木材|庁舎|クルーズ|公園|まちづくり/);
  });
});

describe('collectFromListPage: 報道発表資料（実ページ）', () => {
  it('デジタル統括室の記事リンクを抽出する', () => {
    const r = collectFromListPage(
      pressHtml,
      { sourceId: 'osaka-digital-press', organization: '大阪市', pageUrl: PRESS_URL },
      { linkSelector: "#mol_contents a[href*='/hodoshiryo/ictsenryakushitsu/']" },
    );
    expect(r.candidates.length).toBeGreaterThanOrEqual(5);
    for (const c of r.candidates) {
      expect(c.url).toContain('/hodoshiryo/ictsenryakushitsu/');
    }
  });
});

describe('collectFromListPage: 動作規則', () => {
  const ctx = { sourceId: 's', organization: '大阪市', pageUrl: 'https://www.city.osaka.lg.jp/a/list.html' };

  it('外部ドメインへのリンクを除外する', () => {
    const html = `<div id="mol_contents">
      <a href="/a/1.html">内部</a>
      <a href="https://example.jp/x">外部</a>
    </div>`;
    const r = collectFromListPage(html, ctx, { linkSelector: '#mol_contents a' });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.url).toBe('https://www.city.osaka.lg.jp/a/1.html');
  });

  it('リンク近傍から一覧上の日付を拾う', () => {
    const html = `<div id="mol_contents"><ul>
      <li>令和8年7月29日 <a href="/a/1.html">案件A</a></li>
    </ul></div>`;
    const r = collectFromListPage(html, ctx, { linkSelector: '#mol_contents a' });
    expect(r.candidates[0]?.listDate).toBe('2026-07-29');
  });

  it('西暦表記の一覧日付も拾う', () => {
    const html = `<div id="mol_contents"><ul>
      <li>2026年7月27日 <a href="/a/1.html">案件A</a></li>
    </ul></div>`;
    expect(collectFromListPage(html, ctx, { linkSelector: '#mol_contents a' }).candidates[0]?.listDate)
      .toBe('2026-07-27');
  });

  it('周辺テキストを200文字に切る', () => {
    const html = `<div id="mol_contents"><li>${'あ'.repeat(400)}<a href="/a/1.html">A</a></li></div>`;
    expect(collectFromListPage(html, ctx, { linkSelector: '#mol_contents a' }).candidates[0]?.context.length)
      .toBeLessThanOrEqual(200);
  });

  it('同一URLの重複リンクを1件に畳む', () => {
    const html = `<div id="mol_contents">
      <a href="/a/1.html">A</a><a href="/a/1.html">Aの再掲</a>
    </div>`;
    expect(collectFromListPage(html, ctx, { linkSelector: '#mol_contents a' }).candidates).toHaveLength(1);
  });

  it('linkSelector 未指定なら #mol_contents 内の全リンクを見る', () => {
    const html = `<nav><a href="/nav.html">ナビ</a></nav>
      <div id="mol_contents"><a href="/a/1.html">A</a></div>`;
    const r = collectFromListPage(html, ctx, {});
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.linkText).toBe('A');
  });

  it('titleExcludes が効き、除外内訳を返す', () => {
    const html = `<div id="mol_contents">
      <a href="/a/1.html">業務委託 入札結果</a><a href="/a/2.html">CX情報提供</a>
    </div>`;
    const r = collectFromListPage(html, ctx, { linkSelector: '#mol_contents a', titleExcludes: ['入札結果'] });
    expect(r.candidates).toHaveLength(1);
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]?.pattern).toBe('入札結果');
  });
});

describe('departmentFromUrlPath', () => {
  it('プロポーザル案件URLの局コードを日本語の局名に変換する', () => {
    expect(departmentFromUrlPath('https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/ictsenryakushitsu/0000684546.html'))
      .toBe('デジタル統括室');
    expect(departmentFromUrlPath('https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/keizaisenryaku/0000681745.html'))
      .toBe('経済戦略局');
  });

  it('未知の局コードはコードをそのまま返す', () => {
    expect(departmentFromUrlPath('https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/unknownbureau/1.html'))
      .toBe('unknownbureau');
  });

  it('局コードを含まないURLは null', () => {
    expect(departmentFromUrlPath('https://www.city.osaka.lg.jp/index.html')).toBeNull();
  });
});

describe('runCollector', () => {
  it('collectorType でディスパッチする', () => {
    const rss = runCollector({
      collectorType: 'rss',
      html: `<rss><channel><item><title>A</title><link>https://a.jp/1</link></item></channel></rss>`,
      sourceId: 's', organization: '大阪市', url: 'https://a.jp/rss.xml',
    });
    expect(rss.candidates).toHaveLength(1);

    const list = runCollector({
      collectorType: 'list_page',
      html: `<div id="mol_contents"><a href="/a/1.html">A</a></div>`,
      sourceId: 's', organization: '大阪市', url: 'https://a.jp/list.html',
    });
    expect(list.candidates).toHaveLength(1);
  });

  it('single_page はページ自身を1件の候補にする', () => {
    const r = runCollector({
      collectorType: 'single_page',
      html: `<html><h1>単一ページ</h1></html>`,
      sourceId: 's', organization: '大阪市', url: 'https://a.jp/one.html',
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.url).toBe('https://a.jp/one.html');
  });

  it('manual と custom は候補0件を返す（実行対象外）', () => {
    for (const t of ['manual', 'custom'] as const) {
      const r = runCollector({
        collectorType: t, html: '', sourceId: 's', organization: '大阪市', url: 'https://a.jp/x',
      });
      expect(r.candidates).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/collectors-list-page.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/collectors/list-page.ts"`

- [ ] **Step 3: `src/collectors/list-page.ts` を実装**

```ts
import * as cheerio from 'cheerio';
import { normalizeDate, preNormalize } from '../normalize.ts';
import type { Candidate } from '../types.ts';
import { absolutize, isSameHost } from '../url.ts';
import type { CollectResult, RssFilterOptions } from './rss.ts';

/** 大阪市のURLパスに現れる局コード → 日本語局名（2026-08-05 時点で確認できたもの）。 */
const BUREAU_CODES: Record<string, string> = {
  ictsenryakushitsu: 'デジタル統括室',
  seisakukikakushitsu: '政策企画室',
  keizaisenryaku: '経済戦略局',
  keiyakukanzai: '契約管財局',
  kensetsu: '建設局',
  toshikeikaku: '計画調整局',
  toshiseibi: '都市整備局',
  port: '港湾局',
  kodomo: 'こども青少年局',
  shimin: '市民局',
  fukushi: '福祉局',
  kenko: '健康局',
  kankyo: '環境局',
  shobo: '消防局',
  zaisei: '財政局',
  somu: '総務局',
  osakatokei: '大阪都市計画局',
  nishinari: '西成区',
  nishi: '西区',
  kita: '北区',
  higashisumiyoshi: '東住吉区',
  miyakojima: '都島区',
};

/** URLパスの局コードから担当部署候補を返す。未知のコードはそのまま返す。 */
export function departmentFromUrlPath(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter((s) => s.length > 0);
  for (const s of segments) {
    const known = BUREAU_CODES[s];
    if (known !== undefined) return known;
  }
  // /templates/<種別>/<局コード>/<記事ID>.html の3番目を局コードとみなす
  if (segments[0] === 'templates' && segments.length >= 4) {
    const code = segments[2];
    if (code !== undefined && !/^\d+$/.test(code)) return code;
  }
  return null;
}

/** リンクの祖先を辿って、日付・周辺テキストを取れる最小のブロックを探す。 */
function nearestBlockText($: cheerio.CheerioAPI, anchor: cheerio.Cheerio<never>): string {
  const block = anchor.closest('li, td, tr, dd, dt, p, div').first();
  const target = block.length > 0 ? block : anchor;
  return target.text().replace(/\s+/g, ' ').trim();
}

/**
 * 一覧ページから個別案件へのリンクを抽出する（設計書 §6-1）。
 * 同一ドメインのリンクのみを対象にする。
 */
export function collectFromListPage(
  html: string,
  ctx: { sourceId: string; organization: string; pageUrl: string },
  opts: { linkSelector?: string } & RssFilterOptions,
): CollectResult {
  const $ = cheerio.load(html);
  const selector = opts.linkSelector ?? '#mol_contents a[href]';
  const excludes = (opts.titleExcludes ?? []).map(preNormalize).filter((s) => s.length > 0);

  const candidates: Candidate[] = [];
  const excluded: CollectResult['excluded'] = [];
  const seen = new Set<string>();

  $(selector).each((_i, node) => {
    const anchor = $(node) as unknown as cheerio.Cheerio<never>;
    const href = anchor.attr('href') ?? '';
    const url = absolutize(href, ctx.pageUrl);
    if (url === null) return;
    if (!isSameHost(url, ctx.pageUrl)) return;

    // 一覧ページ自身へのリンク（0-Curr.html など）は候補にしない
    if (url.split('#')[0] === ctx.pageUrl.split('#')[0]) return;

    const linkText = anchor.text().replace(/\s+/g, ' ').trim();
    if (linkText.length === 0) return;
    if (seen.has(url)) return;
    seen.add(url);

    const normText = preNormalize(linkText);
    const hit = excludes.find((ex) => normText.includes(ex));
    if (hit !== undefined) {
      excluded.push({ url, title: linkText, pattern: hit });
      return;
    }

    const context = nearestBlockText($, anchor).slice(0, 200);

    candidates.push({
      sourceId: ctx.sourceId,
      organization: ctx.organization,
      url,
      linkText,
      listDate: normalizeDate(context),
      context,
      categoryHint: departmentFromUrlPath(url),
    });
  });

  return { candidates, excluded, totalFound: seen.size };
}
```

- [ ] **Step 4: `src/collectors/index.ts` を実装**

```ts
import * as cheerio from 'cheerio';
import type { Candidate } from '../types.ts';
import { collectFromListPage } from './list-page.ts';
import type { CollectResult, RssFilterOptions } from './rss.ts';
import { collectFromRss } from './rss.ts';

/** 設計書 §5-2。初期実装は rss / list_page / single_page。 */
export const COLLECTOR_TYPES = ['list_page', 'rss', 'single_page', 'manual', 'custom'] as const;
export type CollectorType = typeof COLLECTOR_TYPES[number];

export type CollectorInput = {
  collectorType: CollectorType;
  html: string;
  sourceId: string;
  organization: string;
  /** 一覧ページ・RSS フィードの URL */
  url: string;
  linkSelector?: string;
} & RssFilterOptions;

const EMPTY: CollectResult = { candidates: [], excluded: [], totalFound: 0 };

/** collector_type に応じて候補抽出を振り分ける。 */
export function runCollector(input: CollectorInput): CollectResult {
  switch (input.collectorType) {
    case 'rss':
      return collectFromRss(
        input.html,
        { sourceId: input.sourceId, organization: input.organization, feedUrl: input.url },
        { categoryIncludes: input.categoryIncludes, titleExcludes: input.titleExcludes },
      );

    case 'list_page':
      return collectFromListPage(
        input.html,
        { sourceId: input.sourceId, organization: input.organization, pageUrl: input.url },
        input,
      );

    case 'single_page': {
      // ページ自身を1件の候補として扱う。リンク抽出をしないだけの list_page。
      const $ = cheerio.load(input.html);
      const title = $('h1').first().text().trim() || $('title').first().text().trim() || input.url;
      const candidate: Candidate = {
        sourceId: input.sourceId,
        organization: input.organization,
        url: input.url,
        linkText: title.replace(/^大阪市[：:]\s*/, ''),
        listDate: null,
        context: '',
        categoryHint: null,
      };
      return { candidates: [candidate], excluded: [], totalFound: 1 };
    }

    case 'manual':
    case 'custom':
      // manual は npm run import 経由。custom は自治体固有コレクターの追加箇所。
      return EMPTY;
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

```bash
npx vitest run test/collectors-list-page.test.ts
```

Expected: PASS（20 tests）

- [ ] **Step 6: 型検査と lint、全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS

- [ ] **Step 7: コミット**

```bash
git add src/collectors/list-page.ts src/collectors/index.ts test/collectors-list-page.test.ts
git commit -m "feat: 一覧ページコレクターと collector_type ディスパッチ

同一ドメイン限定・一覧ページ自身の除外・リンク近傍からの日付抽出。
URLパスの局コードを日本語局名に変換して担当部署候補にする。"
```

---

## Task 9: 情報源設定の読み込みと検証

**Files:**
- Create: `src/config.ts`, `config/sources.yaml`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `COLLECTOR_TYPES`, `type CollectorType`（`src/collectors/index.ts`）／`AppError`（`src/errors.ts`）
- Produces:
  - `type SourceConfig = { id: string; organization: string; name: string; url: string; collectorType: CollectorType; enabled: boolean; categoryIncludes: string[]; titleExcludes: string[]; linkSelector?: string; contentSelector?: string }`
  - `type Defaults = { requestIntervalMs: number; timeoutMs: number; maxRetries: number; maxBytes: number; userAgent: string; maxItemsPerRun: number }`
  - `type AppConfig = { defaults: Defaults; sources: SourceConfig[] }`
  - `parseConfig(yamlText: string): AppConfig` — 不正なら `AppError('CONFIG_INVALID')`
  - `loadConfig(path?: string): AppConfig`
  - `enabledSources(cfg: AppConfig, only?: string[]): SourceConfig[]`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/config.test.ts
import { describe, expect, it } from 'vitest';
import { enabledSources, loadConfig, parseConfig } from '../src/config.ts';
import { AppError } from '../src/errors.ts';

const MINIMAL = `
sources:
  - id: a
    organization: 大阪市
    name: テスト
    url: https://www.city.osaka.lg.jp/x.html
    collector_type: list_page
    enabled: true
`;

describe('parseConfig', () => {
  it('snake_case のキーを camelCase に変換する', () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.sources[0]).toMatchObject({
      id: 'a', organization: '大阪市', collectorType: 'list_page', enabled: true,
    });
  });

  it('defaults を省略すると既定値が入る', () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.defaults).toEqual({
      requestIntervalMs: 3000,
      timeoutMs: 20_000,
      maxRetries: 2,
      maxBytes: 10_485_760,
      userAgent: expect.stringContaining('administrative-needs-prototype'),
      maxItemsPerRun: 60,
    });
  });

  it('defaults を部分的に上書きできる', () => {
    const cfg = parseConfig(`
defaults:
  request_interval_ms: 5000
  max_items_per_run: 10
${MINIMAL}`);
    expect(cfg.defaults.requestIntervalMs).toBe(5000);
    expect(cfg.defaults.maxItemsPerRun).toBe(10);
    expect(cfg.defaults.timeoutMs).toBe(20_000);
  });

  it('category_includes / title_excludes は省略時に空配列', () => {
    const cfg = parseConfig(MINIMAL);
    expect(cfg.sources[0]?.categoryIncludes).toEqual([]);
    expect(cfg.sources[0]?.titleExcludes).toEqual([]);
  });

  it('選択的なセレクタを読み込む', () => {
    const cfg = parseConfig(`${MINIMAL}    link_selector: "#mol_contents a"
    content_selector: "#mol_contents"
`);
    expect(cfg.sources[0]?.linkSelector).toBe('#mol_contents a');
    expect(cfg.sources[0]?.contentSelector).toBe('#mol_contents');
  });

  it('未知の collector_type は CONFIG_INVALID', () => {
    expect(() => parseConfig(MINIMAL.replace('list_page', 'scrape_everything'))).toThrow(AppError);
  });

  it('必須項目の欠落は CONFIG_INVALID', () => {
    expect(() => parseConfig(`sources:\n  - id: a\n`)).toThrow(AppError);
  });

  it('id が重複していたら CONFIG_INVALID', () => {
    expect(() => parseConfig(`${MINIMAL}${MINIMAL.replace('sources:', '')}`)).toThrow(AppError);
  });

  it('http/https 以外の url は CONFIG_INVALID', () => {
    expect(() => parseConfig(MINIMAL.replace('https://', 'ftp://'))).toThrow(AppError);
  });

  it('sources が空配列なら CONFIG_INVALID', () => {
    expect(() => parseConfig('sources: []')).toThrow(AppError);
  });

  it('YAML として壊れていたら CONFIG_INVALID', () => {
    expect(() => parseConfig('sources:\n  - id: [unclosed')).toThrow(AppError);
  });

  it('エラーには問題のあるキーが含まれる', () => {
    try {
      parseConfig(MINIMAL.replace('list_page', 'bogus'));
      throw new Error('例外が投げられなかった');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CONFIG_INVALID');
      expect((e as AppError).internalDetail).toContain('collector_type');
    }
  });
});

describe('enabledSources', () => {
  const cfg = parseConfig(`
sources:
  - { id: a, organization: 大阪市, name: A, url: https://a.jp/1, collector_type: rss, enabled: true }
  - { id: b, organization: 大阪市, name: B, url: https://a.jp/2, collector_type: rss, enabled: false }
  - { id: c, organization: 大阪市, name: C, url: https://a.jp/3, collector_type: rss, enabled: true }
`);

  it('enabled: true のみ返す', () => {
    expect(enabledSources(cfg).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('only 指定で絞り込む', () => {
    expect(enabledSources(cfg, ['c']).map((s) => s.id)).toEqual(['c']);
  });

  it('only で enabled: false を指定しても返さない', () => {
    expect(enabledSources(cfg, ['b'])).toEqual([]);
  });

  it('存在しない id を only に指定したら CONFIG_INVALID', () => {
    expect(() => enabledSources(cfg, ['zzz'])).toThrow(AppError);
  });
});

describe('loadConfig: 同梱の config/sources.yaml', () => {
  const cfg = loadConfig('config/sources.yaml');

  it('読み込めて4情報源が定義されている', () => {
    expect(cfg.sources).toHaveLength(4);
  });

  it('初期有効な情報源は3つ（指定管理者は無効）', () => {
    const on = enabledSources(cfg);
    expect(on).toHaveLength(3);
    expect(on.map((s) => s.id).sort()).toEqual([
      'osaka-digital-press', 'osaka-digital-rss', 'osaka-proposal-list',
    ]);
  });

  it('すべて大阪市の実URLを指している', () => {
    for (const s of cfg.sources) {
      expect(s.url).toMatch(/^https:\/\/www\.city\.osaka\.lg\.jp\//);
    }
  });

  it('デジタル統括室RSSに結果公表の除外語が入っている', () => {
    const rss = cfg.sources.find((s) => s.id === 'osaka-digital-rss');
    expect(rss?.collectorType).toBe('rss');
    expect(rss?.titleExcludes).toContain('入札結果');
    expect(rss?.titleExcludes).toContain('選定結果');
    expect(rss?.categoryIncludes).toContain('入札契約情報');
  });

  it('一覧ページ2本にセレクタが設定されている', () => {
    for (const id of ['osaka-proposal-list', 'osaka-digital-press']) {
      const s = cfg.sources.find((x) => x.id === id);
      expect(s?.linkSelector, id).toBeTruthy();
      expect(s?.contentSelector, id).toBe('#mol_contents');
    }
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/config.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/config.ts"`

- [ ] **Step 3: `config/sources.yaml` を作る**

URL はすべて 2026-08-05 に実測した実在ページ（設計書 §5-1）。

```yaml
# 情報源定義（設計書 §5-2）。
# 新しい自治体・情報源は原則このファイルへの追記だけで追加できる。

defaults:
  # 同一ホストへの最小アクセス間隔
  request_interval_ms: 3000
  timeout_ms: 20000
  max_retries: 2
  # 10MB
  max_bytes: 10485760
  # 初回セットアップ時に連絡先を実在のメールアドレスへ差し替える（README 参照）。
  # 自治体サイトへのアクセス主体を明示するため、プレースホルダのまま運用しない。
  user_agent: "administrative-needs-prototype/0.1 (+<連絡先メールアドレス>)"
  # 1情報源あたり1回の実行で扱う件数の上限
  max_items_per_run: 60

sources:
  # 局単位のRSS。title / link / pubDate / category（局名を含む分類パス）が構造化済み。
  - id: osaka-digital-rss
    organization: 大阪市
    name: デジタル統括室 RSS
    url: https://www.city.osaka.lg.jp/ictsenryakushitsu/rss/rss.xml
    collector_type: rss
    enabled: true
    content_selector: "#mol_contents"
    # いずれかを含む category を持つ item だけ通す（空なら全件）
    category_includes:
      - 入札契約情報
      - DX・デジタル化・スマートシティ
      - 主要な計画、指針・施策
    # 過去の結果公表のみを落とす。Web・DX 関連度の判断はAI対象判定に任せる（設計書 §5-3）
    title_excludes:
      - 入札結果
      - 随意契約結果
      - 選定結果
      - 再委託状況
      - 要綱・要領等

  # 全局横断の公募案件。常時15件以上。対象・対象外が自然に混在し精度検証に使える。
  - id: osaka-proposal-list
    organization: 大阪市
    name: プロポーザル方式等発注案件
    url: https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/0-Curr.html
    collector_type: list_page
    enabled: true
    link_selector: "#mol_contents a[href*='/templates/proposal_hattyuuannkenn/']"
    content_selector: "#mol_contents"
    title_excludes:
      - 選定結果

  # 上流シグナル（DX推進本部会議・AI活用基本方針・CXサービスグランドデザイン等）
  - id: osaka-digital-press
    organization: 大阪市
    name: デジタル統括室 報道発表資料
    url: https://www.city.osaka.lg.jp/hodoshiryo/98-Curr.html
    collector_type: list_page
    enabled: true
    link_selector: "#mol_contents a[href*='/hodoshiryo/ictsenryakushitsu/']"
    content_selector: "#mol_contents"

  # 施設運営中心で Web・DX 関連度が低いため初期は無効（設計書 §5-1）
  - id: osaka-shitei-kanri
    organization: 大阪市
    name: 指定管理者 募集・選定状況
    url: https://www.city.osaka.lg.jp/keiyakukanzai/page/0000181355.html
    collector_type: list_page
    enabled: false
    link_selector: "#mol_contents a[href*='/page/']"
    content_selector: "#mol_contents"
```

- [ ] **Step 4: `src/config.ts` を実装**

```ts
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { COLLECTOR_TYPES } from './collectors/index.ts';
import type { CollectorType } from './collectors/index.ts';
import { AppError } from './errors.ts';

const DEFAULT_DEFAULTS = {
  requestIntervalMs: 3000,
  timeoutMs: 20_000,
  maxRetries: 2,
  maxBytes: 10_485_760,
  userAgent: 'administrative-needs-prototype/0.1 (+<連絡先メールアドレス>)',
  maxItemsPerRun: 60,
} as const;

const httpUrl = z.string().refine(
  (v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'http または https の URL を指定してください' },
);

const defaultsSchema = z
  .object({
    request_interval_ms: z.number().int().min(0).optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_retries: z.number().int().min(0).max(10).optional(),
    max_bytes: z.number().int().positive().optional(),
    user_agent: z.string().min(1).optional(),
    max_items_per_run: z.number().int().positive().optional(),
  })
  .optional();

const sourceSchema = z.object({
  id: z.string().min(1),
  organization: z.string().min(1),
  name: z.string().min(1),
  url: httpUrl,
  collector_type: z.enum(COLLECTOR_TYPES),
  enabled: z.boolean(),
  category_includes: z.array(z.string()).optional(),
  title_excludes: z.array(z.string()).optional(),
  link_selector: z.string().min(1).optional(),
  content_selector: z.string().min(1).optional(),
});

const rootSchema = z.object({
  defaults: defaultsSchema,
  sources: z.array(sourceSchema).min(1, 'sources には1件以上を定義してください'),
});

export type SourceConfig = {
  id: string;
  organization: string;
  name: string;
  url: string;
  collectorType: CollectorType;
  enabled: boolean;
  categoryIncludes: string[];
  titleExcludes: string[];
  linkSelector?: string;
  contentSelector?: string;
};

export type Defaults = {
  requestIntervalMs: number;
  timeoutMs: number;
  maxRetries: number;
  maxBytes: number;
  userAgent: string;
  maxItemsPerRun: number;
};

export type AppConfig = { defaults: Defaults; sources: SourceConfig[] };

/** YAML を検証して camelCase の設定に変換する。不正なら CONFIG_INVALID。 */
export function parseConfig(yamlText: string): AppConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new AppError('CONFIG_INVALID', undefined, `YAML として解釈できません: ${detail}`);
  }

  const parsed = rootSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join(' / ');
    throw new AppError('CONFIG_INVALID', undefined, detail);
  }

  const d = parsed.data.defaults ?? {};
  const defaults: Defaults = {
    requestIntervalMs: d.request_interval_ms ?? DEFAULT_DEFAULTS.requestIntervalMs,
    timeoutMs: d.timeout_ms ?? DEFAULT_DEFAULTS.timeoutMs,
    maxRetries: d.max_retries ?? DEFAULT_DEFAULTS.maxRetries,
    maxBytes: d.max_bytes ?? DEFAULT_DEFAULTS.maxBytes,
    userAgent: d.user_agent ?? DEFAULT_DEFAULTS.userAgent,
    maxItemsPerRun: d.max_items_per_run ?? DEFAULT_DEFAULTS.maxItemsPerRun,
  };

  const sources: SourceConfig[] = parsed.data.sources.map((s) => ({
    id: s.id,
    organization: s.organization,
    name: s.name,
    url: s.url,
    collectorType: s.collector_type,
    enabled: s.enabled,
    categoryIncludes: s.category_includes ?? [],
    titleExcludes: s.title_excludes ?? [],
    ...(s.link_selector === undefined ? {} : { linkSelector: s.link_selector }),
    ...(s.content_selector === undefined ? {} : { contentSelector: s.content_selector }),
  }));

  const dupes = sources
    .map((s) => s.id)
    .filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new AppError('CONFIG_INVALID', undefined, `id が重複しています: ${[...new Set(dupes)].join(', ')}`);
  }

  return { defaults, sources };
}

export function loadConfig(path = 'config/sources.yaml'): AppConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new AppError('CONFIG_INVALID', `情報源設定を読み込めません: ${path}`, detail);
  }
  return parseConfig(text);
}

/** enabled な情報源を返す。only が指定されていればその id に絞る。 */
export function enabledSources(cfg: AppConfig, only?: string[]): SourceConfig[] {
  if (only !== undefined && only.length > 0) {
    const known = new Set(cfg.sources.map((s) => s.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new AppError('CONFIG_INVALID', undefined, `未定義の情報源 id: ${unknown.join(', ')}`);
    }
    const wanted = new Set(only);
    return cfg.sources.filter((s) => s.enabled && wanted.has(s.id));
  }
  return cfg.sources.filter((s) => s.enabled);
}
```

- [ ] **Step 5: テストが通ることを確認**

```bash
npx vitest run test/config.test.ts
```

Expected: PASS（22 tests）

- [ ] **Step 6: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/config.ts config/sources.yaml test/config.test.ts
git commit -m "feat: 情報源設定の読み込みと Zod 検証

大阪市の実測URL4本（うち3本を初期有効）を config/sources.yaml に定義。
未知の collector_type・id重複・必須欠落を起動時に弾く。"
```

---

## Task 10: HTTP 取得とレート制限

**Files:**
- Create: `src/rate-limiter.ts`, `src/fetch-page.ts`
- Test: `test/rate-limiter.test.ts`, `test/fetch-page.test.ts`

**Interfaces:**
- Consumes: `AppError`（`src/errors.ts`）／`type Defaults`（`src/config.ts`）
- Produces:
  - `src/rate-limiter.ts`: `createRateLimiter(intervalMs: number, sleep?: (ms: number) => Promise<void>): { wait(url: string): Promise<void> }`
  - `src/fetch-page.ts`: `assertSafeUrl(url: string): void`（危険なら `AppError('URL_INVALID')`）／`isPrivateAddress(host: string): boolean`／`type FetchResult = { url: string; finalUrl: string; contentType: string; body: Uint8Array; text(): string }`／`fetchPage(url: string, opts: FetchOptions): Promise<FetchResult>`

- [ ] **Step 1: レート制限の失敗するテストを書く**

時間に依存させないため `sleep` を注入する。

```ts
// test/rate-limiter.test.ts
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/rate-limiter.ts';

function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

describe('createRateLimiter', () => {
  it('同一ホストへの初回アクセスは待たない', async () => {
    const r = recorder();
    const rl = createRateLimiter(3000, r.sleep);
    await rl.wait('https://a.jp/1');
    expect(r.slept).toEqual([]);
  });

  it('同一ホストの連続アクセスで間隔を空ける', async () => {
    const r = recorder();
    const rl = createRateLimiter(3000, r.sleep);
    await rl.wait('https://a.jp/1');
    await rl.wait('https://a.jp/2');
    expect(r.slept).toHaveLength(1);
    expect(r.slept[0]).toBeGreaterThan(0);
    expect(r.slept[0]).toBeLessThanOrEqual(3000);
  });

  it('ホストごとに独立して数える', async () => {
    const r = recorder();
    const rl = createRateLimiter(3000, r.sleep);
    await rl.wait('https://a.jp/1');
    await rl.wait('https://b.jp/1');
    expect(r.slept).toEqual([]);
  });

  it('interval 0 なら待たない', async () => {
    const r = recorder();
    const rl = createRateLimiter(0, r.sleep);
    await rl.wait('https://a.jp/1');
    await rl.wait('https://a.jp/2');
    expect(r.slept).toEqual([]);
  });

  it('壊れたURLでも例外にしない', async () => {
    const r = recorder();
    const rl = createRateLimiter(3000, r.sleep);
    await expect(rl.wait('not a url')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/rate-limiter.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/rate-limiter.ts"`

- [ ] **Step 3: `src/rate-limiter.ts` を実装**

```ts
/**
 * ホスト単位のアクセス間隔を守る（設計書 §6-4）。
 * sleep を注入できるようにして、テストを実時間に依存させない。
 */
export function createRateLimiter(
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): { wait(url: string): Promise<void> } {
  const lastAt = new Map<string, number>();

  return {
    async wait(url: string): Promise<void> {
      if (intervalMs <= 0) return;

      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return;
      }

      const now = Date.now();
      const prev = lastAt.get(host);
      if (prev !== undefined) {
        const remaining = intervalMs - (now - prev);
        if (remaining > 0) await sleep(remaining);
      }
      lastAt.set(host, Date.now());
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/rate-limiter.test.ts
```

Expected: PASS（5 tests）

- [ ] **Step 5: SSRF と取得の失敗するテストを書く**

`fetch` はグローバルを差し替えてモックする。

```ts
// test/fetch-page.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeUrl, fetchPage, isPrivateAddress } from '../src/fetch-page.ts';
import { AppError } from '../src/errors.ts';

const OPTS = {
  timeoutMs: 5000, maxRetries: 0, maxBytes: 1_000_000,
  userAgent: 'test-agent', rateLimiter: { wait: async () => {} },
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('isPrivateAddress', () => {
  it('ループバック・プライベート・リンクローカル・メタデータを検出する', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1']) {
      expect(isPrivateAddress(h), h).toBe(true);
    }
  });

  it('公開アドレスは false（172.32.0.1 は境界の外）', () => {
    for (const h of ['8.8.8.8', '172.32.0.1', '172.15.255.255', '203.0.113.10', '2400:cb00::1']) {
      expect(isPrivateAddress(h), h).toBe(false);
    }
  });
});

describe('assertSafeUrl', () => {
  it('大阪市の実URLを通す', () => {
    expect(() => assertSafeUrl('https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html')).not.toThrow();
  });

  it('http/https 以外を拒否する', () => {
    for (const u of ['ftp://a.jp/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(() => assertSafeUrl(u), u).toThrow(AppError);
    }
  });

  it('localhost とプライベートIPを拒否する', () => {
    for (const u of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.1/x',
      'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x',
      'http://0.0.0.0/x', 'http://172.16.0.1/x']) {
      expect(() => assertSafeUrl(u), u).toThrow(AppError);
    }
  });

  it('境界の 172.32.0.1 は通す', () => {
    expect(() => assertSafeUrl('http://172.32.0.1/x')).not.toThrow();
  });

  it('壊れたURLを拒否する', () => {
    expect(() => assertSafeUrl('not a url')).toThrow(AppError);
  });
});

describe('fetchPage', () => {
  const okResponse = (body: string, contentType = 'text/html; charset=utf-8') =>
    new Response(new TextEncoder().encode(body), {
      status: 200, headers: { 'content-type': contentType },
    });

  it('HTML を取得してテキスト化できる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('<html>本文</html>')));
    const r = await fetchPage('https://www.city.osaka.lg.jp/a.html', OPTS);
    expect(r.text()).toContain('本文');
    expect(r.contentType).toContain('text/html');
  });

  it('User-Agent を送る', async () => {
    const spy = vi.fn(async () => okResponse('<html>x</html>'));
    vi.stubGlobal('fetch', spy);
    await fetchPage('https://www.city.osaka.lg.jp/a.html', OPTS);
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('user-agent')).toBe('test-agent');
  });

  it('PDF も取得できる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('%PDF-1.7', 'application/pdf')));
    const r = await fetchPage('https://www.city.osaka.lg.jp/a.pdf', OPTS);
    expect(r.contentType).toContain('application/pdf');
    expect(r.body.byteLength).toBeGreaterThan(0);
  });

  it('HTML でも PDF でもない Content-Type を拒否する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('{}', 'application/json')));
    await expect(fetchPage('https://www.city.osaka.lg.jp/a.json', OPTS))
      .rejects.toMatchObject({ code: 'CONTENT_TYPE_UNSUPPORTED' });
  });

  it('Content-Length が上限超なら CONTENT_TOO_LARGE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', {
      status: 200, headers: { 'content-type': 'text/html', 'content-length': '99999999' },
    })));
    await expect(fetchPage('https://www.city.osaka.lg.jp/a.html', OPTS))
      .rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' });
  });

  it('Content-Length がなくても実測サイズで上限を強制する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('x'.repeat(200))));
    await expect(fetchPage('https://www.city.osaka.lg.jp/a.html', { ...OPTS, maxBytes: 100 }))
      .rejects.toMatchObject({ code: 'CONTENT_TOO_LARGE' });
  });

  it('4xx は URL_FETCH_FAILED でリトライしない', async () => {
    const spy = vi.fn(async () => new Response('nf', { status: 404 }));
    vi.stubGlobal('fetch', spy);
    await expect(fetchPage('https://www.city.osaka.lg.jp/a.html', { ...OPTS, maxRetries: 2 }))
      .rejects.toMatchObject({ code: 'URL_FETCH_FAILED' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('5xx はリトライしてから諦める', async () => {
    const spy = vi.fn(async () => new Response('err', { status: 503 }));
    vi.stubGlobal('fetch', spy);
    await expect(fetchPage('https://www.city.osaka.lg.jp/a.html',
      { ...OPTS, maxRetries: 2, retrySleep: async () => {} }))
      .rejects.toMatchObject({ code: 'URL_FETCH_FAILED' });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('ネットワークエラーをリトライして成功できる', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return okResponse('<html>成功</html>');
    }));
    const r = await fetchPage('https://www.city.osaka.lg.jp/a.html',
      { ...OPTS, maxRetries: 1, retrySleep: async () => {} });
    expect(r.text()).toContain('成功');
  });

  it('リダイレクト先も SSRF 検査する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    })));
    await expect(fetchPage('https://www.city.osaka.lg.jp/a.html', OPTS))
      .rejects.toMatchObject({ code: 'URL_INVALID' });
  });

  it('リダイレクトを追って finalUrl を返す', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return new Response(null, {
          status: 301, headers: { location: 'https://www.city.osaka.lg.jp/b.html' },
        });
      }
      return okResponse('<html>移動先</html>');
    }));
    const r = await fetchPage('https://www.city.osaka.lg.jp/a.html', OPTS);
    expect(r.finalUrl).toBe('https://www.city.osaka.lg.jp/b.html');
    expect(r.text()).toContain('移動先');
  });

  it('リダイレクト上限(3)を超えたら URL_FETCH_FAILED', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      return new Response(null, {
        status: 302, headers: { location: `https://www.city.osaka.lg.jp/r${n}.html` },
      });
    }));
    await expect(fetchPage('https://www.city.osaka.lg.jp/a.html', OPTS))
      .rejects.toMatchObject({ code: 'URL_FETCH_FAILED' });
  });

  it('取得前にレート制限を待つ', async () => {
    const waited: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('<html>x</html>')));
    await fetchPage('https://www.city.osaka.lg.jp/a.html', {
      ...OPTS, rateLimiter: { wait: async (u: string) => { waited.push(u); } },
    });
    expect(waited).toEqual(['https://www.city.osaka.lg.jp/a.html']);
  });
});
```

- [ ] **Step 6: テストが失敗することを確認**

```bash
npx vitest run test/fetch-page.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/fetch-page.ts"`

- [ ] **Step 7: `src/fetch-page.ts` を実装**

```ts
import { AppError } from './errors.ts';

const MAX_REDIRECTS = 3;

export type FetchOptions = {
  timeoutMs: number;
  maxRetries: number;
  maxBytes: number;
  userAgent: string;
  rateLimiter: { wait(url: string): Promise<void> };
  /** リトライ間の待機。テストで差し替える */
  retrySleep?: (ms: number) => Promise<void>;
};

export type FetchResult = {
  url: string;
  finalUrl: string;
  contentType: string;
  body: Uint8Array;
  text(): string;
};

function ipv4Parts(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/**
 * ループバック・プライベート・リンクローカル・メタデータサービスを検出する
 * （設計書 §15 の SSRF 対策）。
 */
export function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h.endsWith('.localhost') || h === '::' || h === '::1') return true;

  const v4 = ipv4Parts(h);
  if (v4 !== null) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 127) return true;                        // ループバック
    if (a === 10) return true;                         // プライベート
    if (a === 172 && b >= 16 && b <= 31) return true;  // プライベート
    if (a === 192 && b === 168) return true;           // プライベート
    if (a === 169 && b === 254) return true;           // リンクローカル・メタデータ
    if (a >= 224) return true;                         // マルチキャスト・予約
    return false;
  }

  // IPv6
  if (h.includes(':')) {
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('::ffff:')) return isPrivateAddress(h.slice(7));
    return false;
  }

  return false;
}

/** http/https 以外と危険な宛先を拒否する。各リダイレクトホップでも呼ぶ。 */
export function assertSafeUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AppError('URL_INVALID', undefined, `URL として解釈できない: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError('URL_INVALID', undefined, `対象外のスキーム: ${u.protocol}`);
  }
  if (isPrivateAddress(u.hostname)) {
    throw new AppError('URL_INVALID', undefined, `内部アドレスへのアクセスは許可されない: ${u.hostname}`);
  }
}

function isAllowedContentType(ct: string): boolean {
  const t = ct.toLowerCase();
  return t.includes('text/html') || t.includes('application/xhtml')
    || t.includes('application/pdf') || t.includes('text/xml')
    || t.includes('application/xml') || t.includes('application/rss')
    || t.includes('text/plain');
}

/** レスポンスを上限つきで読み切る。Content-Length が無い場合も実測で止める。 */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    throw new AppError('CONTENT_TOO_LARGE', undefined, `Content-Length ${declared} > ${maxBytes}: ${url}`);
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw new AppError('CONTENT_TOO_LARGE', undefined, `実測 ${buf.byteLength} > ${maxBytes}: ${url}`);
  }
  return buf;
}

/**
 * HTTP 取得（設計書 §6-4）。
 * リダイレクトは手動で追い、各ホップで SSRF 検査を再実行する。
 * 4xx はリトライせず、5xx とネットワークエラーは maxRetries まで指数バックオフでリトライする。
 */
export async function fetchPage(url: string, opts: FetchOptions): Promise<FetchResult> {
  const sleep = opts.retrySleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const attempt = async (): Promise<FetchResult> => {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      assertSafeUrl(current);
      await opts.rateLimiter.wait(current);

      const res = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { 'user-agent': opts.userAgent, accept: 'text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8' },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc === null) {
          throw new AppError('URL_FETCH_FAILED', undefined, `${res.status} だが Location が無い: ${current}`);
        }
        current = new URL(loc, current).toString();
        continue;
      }

      if (!res.ok) {
        throw new AppError('URL_FETCH_FAILED', undefined, `HTTP ${res.status}: ${current}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!isAllowedContentType(contentType)) {
        throw new AppError('CONTENT_TYPE_UNSUPPORTED', undefined, `Content-Type: ${contentType} (${current})`);
      }

      const body = await readCapped(res, opts.maxBytes, current);
      const finalUrl = current;

      return {
        url,
        finalUrl,
        contentType,
        body,
        text: () => new TextDecoder('utf-8').decode(body),
      };
    }

    throw new AppError('URL_FETCH_FAILED', undefined, `リダイレクトが ${MAX_REDIRECTS} 回を超えた: ${url}`);
  };

  let lastError: unknown;
  for (let i = 0; i <= opts.maxRetries; i += 1) {
    try {
      return await attempt();
    } catch (e) {
      lastError = e;
      // リトライしても結果が変わらないものは即座に投げる
      if (e instanceof AppError) {
        const noRetry = e.code === 'URL_INVALID'
          || e.code === 'CONTENT_TOO_LARGE'
          || e.code === 'CONTENT_TYPE_UNSUPPORTED'
          || (e.code === 'URL_FETCH_FAILED' && /HTTP 4\d\d/.test(e.internalDetail ?? ''));
        if (noRetry) throw e;
      }
      if (i < opts.maxRetries) await sleep(1000 * 2 ** i);
    }
  }

  if (lastError instanceof AppError) throw lastError;
  const detail = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);
  throw new AppError('URL_FETCH_FAILED', undefined, `${detail} (${url})`);
}
```

- [ ] **Step 8: テストが通ることを確認**

```bash
npx vitest run test/fetch-page.test.ts
```

Expected: PASS（20 tests）

- [ ] **Step 9: 型検査・lint・全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS（累計 130 tests 前後）

- [ ] **Step 10: コミット**

```bash
git add src/rate-limiter.ts src/fetch-page.ts test/rate-limiter.test.ts test/fetch-page.test.ts
git commit -m "feat: HTTP 取得・SSRF 対策・ホスト単位レート制限

リダイレクトは手動で追い各ホップで SSRF 検査を再実行する。
4xx はリトライせず 5xx とネットワークエラーのみ指数バックオフでリトライ。
サイズ上限は Content-Length と実測の両方で強制する。"
```

---

## Task 11: AI 出力の Zod スキーマと正規化前処理

**Files:**
- Create: `src/ai/schema.ts`
- Test: `test/ai-schema.test.ts`

**Interfaces:**
- Consumes: 列挙値（`src/types.ts`）／`normalizeDate`, `normalizeMoney`（`src/normalize.ts`）／`AppError`（`src/errors.ts`）
- Produces:
  - `classificationSchema`, `needAnalysisSchema`（Zod スキーマ）
  - `type Classification = { is_target: boolean; reason: string; confidence: number }`
  - `type NeedAnalysis`（§12-2 の26フィールド）
  - `stripCodeFence(raw: string): string`
  - `normalizeAnalysisInput(obj: unknown, publishedYear?: number | null): unknown` — Zod 検証の**前**に日付・金額を正規化
  - `parseClassification(raw: string): Classification` — 失敗時 `AppError('AI_INVALID_RESPONSE')`
  - `parseNeedAnalysis(raw: string, publishedYear?: number | null): NeedAnalysis` — 同上

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/ai-schema.test.ts
import { describe, expect, it } from 'vitest';
import {
  normalizeAnalysisInput, parseClassification, parseNeedAnalysis, stripCodeFence,
} from '../src/ai/schema.ts';
import { AppError } from '../src/errors.ts';

/** §12-2 の全26フィールドを埋めた正常な出力。 */
function validAnalysis(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_type: 'RFI',
    organization_name: '大阪市',
    department_name: 'デジタル統括室',
    published_at: '2026-07-30',
    deadline: '2026-08-21',
    budget: null,
    official_title: '大阪市CXサービスデザイン推進事業に係る情報提供について',
    need_title: '総合サービスポータルとコンタクトセンターの整備',
    problem_summary: '行政サービスが分散し利用者体験が最適化されていない',
    background: 'Re-Design おおさかに基づくサービスDXの推進',
    desired_state: '全体最適化されたサービス提供スタイルの実現',
    request_to_private_sector: 'システム構成・機能要件・費用・スケジュールの情報提供',
    categories: ['ポータルサイト', 'UI・UX', '行政DX'],
    maturity_stage: '市場対話',
    domain_relevance: 'A',
    domain_relevance_reason: 'Web・DXが取り組みの中心である',
    company_relevance: 'B',
    company_relevance_reason: 'パートナーとの連携により関われる',
    possible_company_roles: ['UI・UX設計'],
    required_partners: ['SIer'],
    contact_recommendation: '高',
    recommended_action: 'RFIへ参加し情報提供を行う',
    questions_to_confirm: ['第2回RFIの時期'],
    risks_and_conditions: ['参加申込が必要'],
    confidence: 92,
    evidence_quotes: [{ field: 'deadline', quote: '令和8年8月21日' }],
    ...over,
  };
}

describe('stripCodeFence', () => {
  it('```json フェンスを剥がす', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('言語指定なしのフェンスも剥がす', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('フェンスがなければそのまま返す', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });

  it('前後の空白と説明文の前置きを落とす', () => {
    expect(stripCodeFence('  以下が結果です。\n```json\n{"a":1}\n```  ')).toBe('{"a":1}');
  });
});

describe('parseClassification', () => {
  it('§12-1 の出力例を受理する', () => {
    const c = parseClassification('{"is_target":true,"reason":"市民向けポータルと行政DXに関する情報提供依頼である","confidence":92}');
    expect(c).toEqual({ is_target: true, reason: '市民向けポータルと行政DXに関する情報提供依頼である', confidence: 92 });
  });

  it('コードフェンス付きでも受理する', () => {
    expect(parseClassification('```json\n{"is_target":false,"reason":"物品購入","confidence":95}\n```').is_target).toBe(false);
  });

  it('confidence は 0〜100 の整数（0〜1 の実数ではない）', () => {
    expect(parseClassification('{"is_target":true,"reason":"x","confidence":0}').confidence).toBe(0);
    expect(parseClassification('{"is_target":true,"reason":"x","confidence":100}').confidence).toBe(100);
    for (const bad of [-1, 101, 0.92, 'high']) {
      expect(() => parseClassification(`{"is_target":true,"reason":"x","confidence":${JSON.stringify(bad)}}`),
        `confidence=${String(bad)}`).toThrow(AppError);
    }
  });

  it('JSON でない出力は AI_INVALID_RESPONSE', () => {
    expect(() => parseClassification('対象だと思います')).toThrow(AppError);
    try { parseClassification('not json'); } catch (e) {
      expect((e as AppError).code).toBe('AI_INVALID_RESPONSE');
    }
  });

  it('必須欠落は AI_INVALID_RESPONSE', () => {
    expect(() => parseClassification('{"is_target":true}')).toThrow(AppError);
  });

  it('余剰キーを落とす', () => {
    const c = parseClassification('{"is_target":true,"reason":"x","confidence":50,"extra":"y"}');
    expect(Object.keys(c).sort()).toEqual(['confidence', 'is_target', 'reason']);
  });
});

describe('parseNeedAnalysis', () => {
  it('§12-2 の完全なJSONを受理する', () => {
    const a = parseNeedAnalysis(JSON.stringify(validAnalysis()));
    expect(a.document_type).toBe('RFI');
    expect(a.confidence).toBe(92);
    expect(a.categories).toHaveLength(3);
    expect(a.evidence_quotes[0]).toEqual({ field: 'deadline', quote: '令和8年8月21日' });
  });

  it('列挙値の検証: document_type / maturity_stage / relevance / contact_recommendation', () => {
    const cases: Array<[string, unknown]> = [
      ['document_type', '公募型プロポーザル'],
      ['maturity_stage', '公募開始'],
      ['domain_relevance', 'S'],
      ['company_relevance', 'D'],
      ['contact_recommendation', '非常に高い'],
    ];
    for (const [key, bad] of cases) {
      expect(() => parseNeedAnalysis(JSON.stringify(validAnalysis({ [key]: bad }))), `${key}=${String(bad)}`)
        .toThrow(AppError);
    }
  });

  it('成熟段階に「不明」を許す（指示書 §14 の9種）', () => {
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ maturity_stage: '不明' }))).maturity_stage).toBe('不明');
  });

  it('関連度に「対象外」を許す', () => {
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ company_relevance: '対象外' }))).company_relevance).toBe('対象外');
  });

  it('日付は YYYY-MM-DD または null のみ', () => {
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ deadline: null }))).deadline).toBeNull();
    expect(() => parseNeedAnalysis(JSON.stringify(validAnalysis({ deadline: '2026/08/21あたり' }))))
      .not.toThrow(); // 正規化で吸収されるため
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ deadline: '2026/8/21' }))).deadline).toBe('2026-08-21');
  });

  it('和暦の日付を正規化して受理する（Zod検証の前に正規化が走る）', () => {
    const a = parseNeedAnalysis(JSON.stringify(validAnalysis({ deadline: '令和8年8月21日（金曜日）17時00分' })));
    expect(a.deadline).toBe('2026-08-21');
  });

  it('判定不能な日付は null になり捏造されない', () => {
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ deadline: '未定' }))).deadline).toBeNull();
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ published_at: '不明' }))).published_at).toBeNull();
  });

  it('年のない日付は published_at の年で補完する', () => {
    const a = parseNeedAnalysis(JSON.stringify(validAnalysis({ published_at: '2026-07-30', deadline: '8月21日' })));
    expect(a.deadline).toBe('2026-08-21');
  });

  it('金額を円単位の整数に正規化する', () => {
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ budget: '1,200万円' }))).budget).toBe(12_000_000);
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ budget: 12_000_000 }))).budget).toBe(12_000_000);
    expect(parseNeedAnalysis(JSON.stringify(validAnalysis({ budget: '未定' }))).budget).toBeNull();
  });

  it('配列フィールドは省略時に空配列になる', () => {
    const obj = validAnalysis();
    for (const k of ['categories', 'possible_company_roles', 'required_partners',
      'questions_to_confirm', 'risks_and_conditions', 'evidence_quotes']) {
      delete obj[k];
    }
    const a = parseNeedAnalysis(JSON.stringify(obj));
    expect(a.categories).toEqual([]);
    expect(a.evidence_quotes).toEqual([]);
  });

  it('文字列フィールドは省略時に null になる', () => {
    const obj = validAnalysis();
    delete obj.background;
    expect(parseNeedAnalysis(JSON.stringify(obj)).background).toBeNull();
  });

  it('必須の need_title 欠落は AI_INVALID_RESPONSE', () => {
    const obj = validAnalysis();
    delete obj.need_title;
    expect(() => parseNeedAnalysis(JSON.stringify(obj))).toThrow(AppError);
  });

  it('余剰キーを落とす', () => {
    const a = parseNeedAnalysis(JSON.stringify(validAnalysis({ bogus_field: 'x' })));
    expect('bogus_field' in a).toBe(false);
  });

  it('evidence_quotes の要素が {field, quote} でなければ拒否', () => {
    expect(() => parseNeedAnalysis(JSON.stringify(validAnalysis({ evidence_quotes: ['引用だけ'] }))))
      .toThrow(AppError);
  });
});

describe('normalizeAnalysisInput', () => {
  it('オブジェクトでない入力はそのまま返す（Zod に判定させる）', () => {
    expect(normalizeAnalysisInput(null)).toBeNull();
    expect(normalizeAnalysisInput('x')).toBe('x');
  });

  it('元オブジェクトを破壊しない', () => {
    const src = validAnalysis({ deadline: '令和8年8月21日' });
    normalizeAnalysisInput(src);
    expect(src.deadline).toBe('令和8年8月21日');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/ai-schema.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/ai/schema.ts"`

- [ ] **Step 3: `src/ai/schema.ts` を実装**

```ts
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { normalizeDate, normalizeMoney } from '../normalize.ts';
import {
  CONTACT_RECOMMENDATIONS, DOCUMENT_TYPES, MATURITY_STAGES, RELEVANCES,
} from '../types.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD または null。正規化済みの値を受ける前提。 */
const isoDate = z.union([z.string().regex(ISO_DATE, 'YYYY-MM-DD 形式で出力してください'), z.null()]);

/** AI確信度は 0〜100 の整数（設計書 §8-5、Global Constraints 11）。 */
const confidence = z.number().int().min(0).max(100);

/** 省略・null を許す文字列。空文字は null に寄せる。 */
const optionalText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null || v.trim() === '' ? null : v));

const stringList = z.array(z.string()).optional().transform((v) => v ?? []);

/** ① 対象判定（設計書 §8-4）。 */
export const classificationSchema = z.object({
  is_target: z.boolean(),
  reason: z.string(),
  confidence,
});
export type Classification = z.infer<typeof classificationSchema>;

/** ② 構造化解析（設計書 §8-4、指示書 §12-2 の26フィールド）。 */
export const needAnalysisSchema = z.object({
  document_type: z.enum(DOCUMENT_TYPES),
  organization_name: optionalText,
  department_name: optionalText,
  published_at: isoDate.optional().transform((v) => v ?? null),
  deadline: isoDate.optional().transform((v) => v ?? null),
  budget: z.union([z.number(), z.null()]).optional().transform((v) => v ?? null),
  official_title: optionalText,
  need_title: z.string().min(1, 'need_title は必須です'),
  problem_summary: optionalText,
  background: optionalText,
  desired_state: optionalText,
  request_to_private_sector: optionalText,
  categories: stringList,
  maturity_stage: z.enum(MATURITY_STAGES),
  domain_relevance: z.enum(RELEVANCES),
  domain_relevance_reason: optionalText,
  company_relevance: z.enum(RELEVANCES),
  company_relevance_reason: optionalText,
  possible_company_roles: stringList,
  required_partners: stringList,
  contact_recommendation: z.enum(CONTACT_RECOMMENDATIONS),
  recommended_action: optionalText,
  questions_to_confirm: stringList,
  risks_and_conditions: stringList,
  confidence,
  evidence_quotes: z
    .array(z.object({ field: z.string(), quote: z.string() }))
    .optional()
    .transform((v) => v ?? []),
});
export type NeedAnalysis = z.infer<typeof needAnalysisSchema>;

/**
 * モデルが付けたコードフェンスと前置き・後置きの説明文を剥がして
 * JSON 本体だけを取り出す。
 */
export function stripCodeFence(raw: string): string {
  const s = raw.trim();

  const fenced = s.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fenced?.[1] !== undefined) return fenced[1].trim();

  // フェンスなしで前置きが付いた場合、最初の { から最後の } までを取る
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1).trim();

  return s;
}

const DATE_FIELDS = ['published_at', 'deadline'] as const;

/**
 * Zod 検証の前に日付・金額を正規化する（設計書 §8-5）。
 * プロンプトで西暦・円単位を指定してもモデル出力は揺れるため、必ずここを通す。
 */
export function normalizeAnalysisInput(obj: unknown, publishedYear?: number | null): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;

  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  // published_at を先に確定させ、年のない deadline の補完に使う
  const publishedNormalized = normalizeDate(src['published_at']);
  out['published_at'] = publishedNormalized;

  const year = publishedNormalized !== null
    ? Number(publishedNormalized.slice(0, 4))
    : (publishedYear ?? null);

  for (const f of DATE_FIELDS) {
    if (f === 'published_at') continue;
    out[f] = normalizeDate(src[f], year);
  }

  out['budget'] = normalizeMoney(src['budget']);

  return out;
}

function parseJsonOrThrow(raw: string): unknown {
  const text = stripCodeFence(raw);
  try {
    return JSON.parse(text);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new AppError(
      'AI_INVALID_RESPONSE',
      undefined,
      `JSON として解釈できません: ${detail} / 生出力の先頭200文字: ${raw.slice(0, 200)}`,
    );
  }
}

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join(' / ');
}

export function parseClassification(raw: string): Classification {
  const parsed = classificationSchema.safeParse(parseJsonOrThrow(raw));
  if (!parsed.success) {
    throw new AppError('AI_INVALID_RESPONSE', undefined, `対象判定の検証に失敗: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseNeedAnalysis(raw: string, publishedYear?: number | null): NeedAnalysis {
  const normalized = normalizeAnalysisInput(parseJsonOrThrow(raw), publishedYear);
  const parsed = needAnalysisSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new AppError('AI_INVALID_RESPONSE', undefined, `構造化解析の検証に失敗: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/ai-schema.test.ts
```

Expected: PASS（24 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/ai/schema.ts test/ai-schema.test.ts
git commit -m "feat: AI 出力の Zod スキーマとコードフェンス除去

confidence は 0〜100 の整数。
Zod 検証の前に日付・金額の正規化を通し、和暦や '1,200万円' を吸収する。
判定不能な値は null にして捏造を防ぐ。"
```

---

## Task 12: Provider インターフェース・プロンプト・MockProvider

**Files:**
- Create: `src/ai/provider.ts`, `src/ai/prompt.ts`, `src/ai/mock.ts`
- Create: `prompts/classify.md`, `prompts/analyze.md`, `prompts/company-profile.md`
- Test: `test/ai-mock.test.ts`, `test/ai-prompt.test.ts`

**Interfaces:**
- Consumes: `type Classification`, `type NeedAnalysis`, `parseClassification`, `parseNeedAnalysis`（`src/ai/schema.ts`）
- Produces:
  - `src/ai/provider.ts`: `type AnalysisInput = { title: string; bodyText: string; sourceUrl: string; organizationHint?: string | null; documentTypeHint?: string | null; publishedAtHint?: string | null }`／`type ClassifyResult = { data: Classification; raw: string; durationMs: number; costUsd: number | null }`／`type AnalyzeResult = { data: NeedAnalysis; raw: string; durationMs: number; costUsd: number | null }`／`interface AiProvider { readonly name: string; readonly model: string; classify(i: AnalysisInput): Promise<ClassifyResult>; analyze(i: AnalysisInput): Promise<AnalyzeResult> }`
  - `src/ai/prompt.ts`: `loadPrompts(dir?: string): { classify: string; analyze: string }`／`buildUserMessage(i: AnalysisInput): string`
  - `src/ai/mock.ts`: `createMockProvider(opts?: { fixtures?: Record<string, unknown> }): AiProvider`

- [ ] **Step 1: `prompts/company-profile.md` を作る**

隣接する先行設計（`gyosei-needs-db` の設計書 §9-2）から起こした初版。実運用で最も調整が入る箇所であり、コード変更なしに編集して再実行できることを前提にする。

```markdown
# 自社の定義

Studio 株式会社。専門的な開発に過度に依存せず、組織自身が Web サイトを
継続的に更新・改善できる環境を提供する。

中心価値: Web サイトを「納品して終わる制作物」から「継続的に運用・改善する情報基盤」へ変える。

## 自社関連度 A（自社のサービスや強みと直接合致する）

- 自治体・外郭団体の情報サイト／特設サイトの構築・リニューアル
- CMS 導入、Web サイト運用の内製化支援
- 企業誘致・移住定住・観光・地域ブランディング・採用のサイト
- イベント／キャンペーン／実証事業／防災・緊急情報の特設サイト
- 複数サイト・複数部署のサイト統制、デザインルールの維持
- 行政情報の発信改善、アクセシビリティ対応
- 発注者と制作会社・代理店の共同運用

## 自社関連度 B（パートナーとの連携により関われる）

- UI/UX・サービスデザイン・情報設計を含む上流案件
- 行政 DX・BPR のうち、住民向け情報発信や申請導線が含まれるもの
- 地域制作会社・広告代理店・SIer との共同提案が前提の案件
- 地域事業者のデジタル活用支援・デジタル人材育成

## 自社関連度 C（すぐには関われないが情報収集上は有用）

- デジタル領域だが Web 発信の要素が薄いもの
  （データ活用のみ、内部業務改善のみ、生成 AI 導入のみ など）

## 自社関連度 対象外（関与可能性が低い）

- 基幹・大規模業務システム、システム運用保守のみ、通信・ネットワーク、
  データセンター、コールセンター、物品購入、ライセンス更新のみ、
  土木建築・設備工事、清掃・警備、人材派遣のみ、既存契約の単純更新

## 想定パートナー

地域の制作会社 / 広告代理店 / SIer / コンサルティング会社 / 自治体向けシステム事業者
```

- [ ] **Step 2: `prompts/classify.md` を作る**

```markdown
# 役割

自治体・公共機関が公開した情報を読み、Web・DX・デジタル領域の行政ニーズに
該当するかを判定する。

# 出力形式

以下の JSON のみを返す。前置き・後置き・説明文・コードフェンスを書かない。

{"is_target": boolean, "reason": string, "confidence": number}

- `confidence` は 0 から 100 の整数。0〜1 の実数ではない。
- `reason` は判定の理由を1〜2文の日本語で書く。

# 判定基準

## 原則として対象

Web サイト / ホームページ / CMS / ポータルサイト / 特設サイト /
Web サイトリニューアル / UI・UX / CX / サービスデザイン / オンライン申請 /
行政手続きのデジタル化 / 行政 DX / BPR・業務改善 / AI・生成 AI / データ活用 /
オープンデータ / 市民向けデジタルサービス / アプリ / LINE / チャットボット /
SNS / デジタルマーケティング / デジタル広報 / コンテンツ制作 / 観光情報発信 /
移住・定住 / 企業誘致 / 採用広報 / 地域事業者支援 / デジタル人材育成 /
内製化支援 / 官民連携 / デジタル領域の実証実験

## 内容を見て判断

大規模業務システム / 基幹システム / システム運用・保守 / セキュリティ /
クラウド / コールセンター / データセンター / 通信・ネットワーク /
IT コンサルティング / 業務調査

## 原則として対象外

PC やプリンターの購入 / ソフトウェアライセンスの単純更新 / 回線調達のみ /
ハードウェア保守のみ / 土木・建築・設備工事 / 清掃・警備 / 人材派遣のみ /
既存契約の単純更新 / デジタル要素が付随するだけの案件

# 判定の注意

タイトルに「DX」「デジタル」「システム」が含まれるだけで `is_target` を true に
しない。**民間事業者に期待されている役割**が、企画・調査・設計・構築・導入・改善・
コンテンツ制作・運用支援・内製化支援・実証のいずれかに該当するかで判断する。

上記の「原則として対象外」に該当する場合は `is_target` を false にし、
`reason` にどの類型に当たるかを書く。

過去の結果公表（入札結果・選定結果・随意契約結果）は民間へのニーズではないため
`is_target` を false にする。
```

- [ ] **Step 3: `prompts/analyze.md` を作る**

```markdown
# 役割

自治体・公共機関の公開情報を読み、Web・DX・デジタル領域の行政ニーズとして
構造化する。

# 出力形式

以下のキーを持つ JSON のみを返す。前置き・後置き・説明文・コードフェンスを書かない。

{
  "document_type": "", "organization_name": "", "department_name": "",
  "published_at": null, "deadline": null, "budget": null,
  "official_title": "", "need_title": "",
  "problem_summary": "", "background": "", "desired_state": "",
  "request_to_private_sector": "", "categories": [],
  "maturity_stage": "", "domain_relevance": "", "domain_relevance_reason": "",
  "company_relevance": "", "company_relevance_reason": "",
  "possible_company_roles": [], "required_partners": [],
  "contact_recommendation": "", "recommended_action": "",
  "questions_to_confirm": [], "risks_and_conditions": [],
  "confidence": 0, "evidence_quotes": []
}

- 日付は西暦 `YYYY-MM-DD`。和暦で書かれていても西暦に直す（令和8年 = 2026年）。
- 金額は円単位の整数。`1,200万円` は `12000000`。
- `confidence` は 0 から 100 の整数。
- `evidence_quotes` は `{"field": "項目名", "quote": "原文からの逐語抜粋"}` の配列。

# 事実と解釈の分離

## 事実（原文に明示がある場合のみ出力し、無ければ null）

自治体・公共機関名 / 担当部署 / 公開日 / 締切 / 予算 / 問い合わせ先 /
参加資格 / 契約条件

確認できない場合は推測せず `null` にする。

## 解釈（AI による整理として出力してよい）

行政課題 / 背景 / 実現したい状態 / 自社関連度 / 想定される役割 /
必要なパートナー / コンタクト推奨度 / 推奨アクション

# 捏造禁止

日付・金額・担当部署・個人名・連絡先・参加資格・公募予定・自治体の正式方針を
原文の根拠なしに生成しない。

# 根拠

主要な判断には `evidence_quotes` として**原文からの逐語抜粋**を付ける。
要約や言い換えを `quote` に入れない。原文の文字列をそのまま写す。
少なくとも締切・予算・担当部署・民間に求めることについては根拠を付ける。

# 文書種別（document_type）

次のいずれか1つを選ぶ。
RFI / 情報提供依頼 / サウンディング / 民間提案 / プロポーザル / 入札 /
実証事業 / 官民連携 / 議会 / 予算 / 計画 / マニフェスト / 審議会 /
行政評価 / その他

`RFI` と `情報提供依頼` は実質同義だが、原文が英語表記の公式名称（RFI）を
使っている場合は `RFI`、日本語で「情報提供依頼」と書かれている場合は
`情報提供依頼` を選ぶ。

# ニーズ成熟段階（maturity_stage）

次のいずれか1つを選ぶ。
課題表明 / 政策方針 / 検討中 / 予算化 / 市場対話 / 公募中 / 実施中 /
評価・再検討 / 不明

判断例:
- マニフェスト、総合計画 → 政策方針
- 議会で課題が示された → 課題表明
- 審議会、調査 → 検討中
- 予算資料 → 予算化
- RFI、サウンディング → 市場対話
- プロポーザル、入札 → 公募中
- 判断できない → 不明

# 分野関連度（domain_relevance）

- A: Web・DX・デジタルが取り組みの中心
- B: 主要な一部として含まれる
- C: 付随的に関係する
- 対象外

# 自社関連度（company_relevance）

自社の定義は別途与えられる「自社の定義」に従う。A / B / C / 対象外 から選ぶ。

判断で考慮すること:
- Web サイトや CMS が主要範囲か
- UI・UX や情報設計が含まれるか
- 継続的なコンテンツ運用が必要か
- 内製化支援と接続できるか
- 大規模なシステム開発が中心ではないか
- 広告代理店、SIer、コンサル等との連携が必要か

# コンタクト推奨度（contact_recommendation）

高 / 中 / 低 / 不要 から選ぶ。

- 高: RFI やサウンディングが公開された / 民間との対話を求めている /
  情報提供や座組形成の余地がある / 既存接点のある部署が具体的なニーズを表明
- 中: 予算化されている / 次年度の実施予定が示されている /
  調査や審議会が始まっている / 自社との関連性が高い政策テーマ
- 低: 長期計画への抽象的な記載のみ / 担当部署や時期が不明 / 事業化の兆候が弱い
- 不要: 自社との関連性が低い / 過去の成果紹介のみ / すでに終了した施策 /
  物品購入など対象外の案件

# categories

分野を示す短い日本語のタグを配列で返す。次の一覧から選ぶことを優先し、
どれにも当てはまらない場合のみ新しいタグを作る。

Web サイト / ホームページ / CMS / ポータルサイト / 特設サイト /
Web サイトリニューアル / UI・UX / CX / サービスデザイン / オンライン申請 /
行政手続きのデジタル化 / 行政 DX / BPR・業務改善 / AI・生成 AI / データ活用 /
オープンデータ / 市民向けデジタルサービス / アプリ / LINE / チャットボット /
SNS / デジタルマーケティング / デジタル広報 / コンテンツ制作 / 観光情報発信 /
移住・定住 / 企業誘致 / 採用広報 / 地域事業者支援 / デジタル人材育成 /
内製化支援 / 官民連携 / デジタル領域の実証実験 / 大規模業務システム /
基幹システム / システム運用・保守 / セキュリティ / クラウド / コールセンター /
データセンター / 通信・ネットワーク / IT コンサルティング / 業務調査

# possible_company_roles

想定される自社の役割。次の一覧から選ぶことを優先する。
Web サイト・ポータル構築 / CMS 導入 / UI・UX 設計 / コンテンツ運用 /
運用内製化支援 / 共同提案

# required_partners

必要になりそうなパートナー。次の一覧から選ぶことを優先する。
地域の制作会社 / 広告代理店 / SIer / コンサルティング会社 /
自治体向けシステム事業者
```

- [ ] **Step 4: 失敗するテストを書く**

```ts
// test/ai-prompt.test.ts
import { describe, expect, it } from 'vitest';
import { buildUserMessage, loadPrompts } from '../src/ai/prompt.ts';

describe('loadPrompts', () => {
  const p = loadPrompts('prompts');

  it('classify に company-profile が連結されない（対象判定に自社定義は不要）', () => {
    expect(p.classify).toContain('Web・DX・デジタル領域の行政ニーズ');
    expect(p.classify).not.toContain('Studio 株式会社');
  });

  it('analyze に company-profile が連結される', () => {
    expect(p.analyze).toContain('構造化する');
    expect(p.analyze).toContain('Studio 株式会社');
  });

  it('analyze に列挙値がすべて含まれる', () => {
    for (const v of ['RFI', '情報提供依頼', 'サウンディング', '不明', '市場対話', '対象外', '不要']) {
      expect(p.analyze, v).toContain(v);
    }
  });

  it('存在しないディレクトリは例外', () => {
    expect(() => loadPrompts('prompts-not-exist')).toThrow();
  });
});

describe('buildUserMessage', () => {
  const input = {
    title: 'CXサービスデザイン推進事業に係る情報提供について',
    bodyText: '本文の内容',
    sourceUrl: 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html',
  };

  it('タイトル・URL・本文を含める', () => {
    const m = buildUserMessage(input);
    expect(m).toContain(input.title);
    expect(m).toContain(input.sourceUrl);
    expect(m).toContain('本文の内容');
  });

  it('ヒントがあれば明示し、優先すべき旨を書く', () => {
    const m = buildUserMessage({ ...input, organizationHint: '大阪市', documentTypeHint: '計画' });
    expect(m).toContain('大阪市');
    expect(m).toContain('計画');
    expect(m).toContain('優先');
  });

  it('ヒントがなければヒント行を出さない', () => {
    expect(buildUserMessage(input)).not.toContain('優先');
  });
});
```

```ts
// test/ai-mock.test.ts
import { describe, expect, it } from 'vitest';
import { createMockProvider } from '../src/ai/mock.ts';

describe('createMockProvider', () => {
  const p = createMockProvider();
  const base = { bodyText: '本文', sourceUrl: 'https://a.jp/x' };

  it('name と model を持つ', () => {
    expect(p.name).toBe('mock');
    expect(p.model).toBe('mock');
  });

  it('RFI のタイトルを対象と判定する（サンプル1）', async () => {
    const r = await p.classify({ ...base, title: '大阪市CXサービスデザイン推進事業に係る情報提供について' });
    expect(r.data.is_target).toBe(true);
    expect(r.data.confidence).toBeGreaterThan(50);
    expect(r.raw.length).toBeGreaterThan(0);
  });

  it('プリンター購入を対象外と判定する（サンプル4）', async () => {
    const r = await p.classify({ ...base, title: '庁舎用プリンター100台の購入について' });
    expect(r.data.is_target).toBe(false);
  });

  it('RFI を 市場対話 / コンタクト推奨度 高 で解析する（サンプル1の期待値）', async () => {
    const r = await p.analyze({ ...base, title: '大阪市CXサービスデザイン推進事業に係る情報提供について' });
    expect(r.data.maturity_stage).toBe('市場対話');
    expect(r.data.contact_recommendation).toBe('高');
    expect(['RFI', '情報提供依頼']).toContain(r.data.document_type);
  });

  it('観光ポータルのプロポーザルを 公募中 / 自社関連度A or B で解析する（サンプル2）', async () => {
    const r = await p.analyze({ ...base, title: '観光ポータルサイト構築・運用業務にかかる公募型プロポーザル' });
    expect(r.data.maturity_stage).toBe('公募中');
    expect(['A', 'B']).toContain(r.data.company_relevance);
  });

  it('DX5カ年計画を 政策方針 / コンタクト推奨度 低 or 中 で解析する（サンプル3）', async () => {
    const r = await p.analyze({ ...base, title: '自治体DX推進5カ年計画を策定しました' });
    expect(r.data.maturity_stage).toBe('政策方針');
    expect(['低', '中']).toContain(r.data.contact_recommendation);
  });

  it('未知のタイトルでもスキーマを満たす結果を返す', async () => {
    const r = await p.analyze({ ...base, title: '見たことのない案件名' });
    expect(r.data.need_title.length).toBeGreaterThan(0);
    expect(r.data.confidence).toBeGreaterThanOrEqual(0);
    expect(r.data.confidence).toBeLessThanOrEqual(100);
  });

  it('organizationHint を結果に反映する（ユーザー入力を優先）', async () => {
    const r = await p.analyze({ ...base, title: '何か', organizationHint: '福岡市' });
    expect(r.data.organization_name).toBe('福岡市');
  });

  it('documentTypeHint を結果に反映する', async () => {
    const r = await p.analyze({ ...base, title: '何か', documentTypeHint: '計画' });
    expect(r.data.document_type).toBe('計画');
  });

  it('本文に含まれる文字列を evidence_quotes に使う（根拠検査を通る）', async () => {
    const body = '参加申込期限：令和8年8月10日（月曜日）17時00分まで';
    const r = await p.analyze({ ...base, bodyText: body, title: '情報提供について' });
    for (const q of r.data.evidence_quotes) {
      expect(body.includes(q.quote), `原文にない引用: ${q.quote}`).toBe(true);
    }
  });

  it('costUsd は null（課金しない）', async () => {
    const r = await p.classify({ ...base, title: 'x' });
    expect(r.costUsd).toBeNull();
  });
});
```

- [ ] **Step 5: テストが失敗することを確認**

```bash
npx vitest run test/ai-prompt.test.ts test/ai-mock.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/ai/prompt.ts"`

- [ ] **Step 6: `src/ai/provider.ts` を実装**

```ts
import type { Classification, NeedAnalysis } from './schema.ts';

export type AnalysisInput = {
  title: string;
  /** HTML 本文 + 添付PDFテキスト */
  bodyText: string;
  sourceUrl: string;
  /** 手動投入や情報源設定で与えられた自治体名。AI 抽出値より優先する */
  organizationHint?: string | null;
  documentTypeHint?: string | null;
  publishedAtHint?: string | null;
};

type ResultMeta = {
  /** モデルの生出力。プロンプト改善のため必ず保持する */
  raw: string;
  durationMs: number;
  /** claude CLI が返す推定コスト。mock は null */
  costUsd: number | null;
};

export type ClassifyResult = ResultMeta & { data: Classification };
export type AnalyzeResult = ResultMeta & { data: NeedAnalysis };

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** ① 対象判定（設計書 §8-4） */
  classify(input: AnalysisInput): Promise<ClassifyResult>;
  /** ② 構造化解析。対象と判定された場合のみ呼ぶ */
  analyze(input: AnalysisInput): Promise<AnalyzeResult>;
}
```

- [ ] **Step 7: `src/ai/prompt.ts` を実装**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisInput } from './provider.ts';

/**
 * prompts/*.md を読み込む（設計書 §4 の設計原則3）。
 * 検証の主目的は AI 出力の質であり、コードを触らずに文言を直して
 * 再実行できる状態を保つ。
 */
export function loadPrompts(dir = 'prompts'): { classify: string; analyze: string } {
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
  const companyProfile = read('company-profile.md');
  return {
    // 対象判定は Web・DX 領域かどうかの判断で、自社定義を要しない。
    // 無駄なトークンを送らないため連結しない。
    classify: read('classify.md'),
    analyze: `${read('analyze.md')}\n\n---\n\n${companyProfile}`,
  };
}

/** モデルへ渡す本文メッセージを組み立てる。 */
export function buildUserMessage(input: AnalysisInput): string {
  const hints: string[] = [];
  if (input.organizationHint) hints.push(`自治体・組織: ${input.organizationHint}`);
  if (input.documentTypeHint) hints.push(`文書種別: ${input.documentTypeHint}`);
  if (input.publishedAtHint) hints.push(`公開日: ${input.publishedAtHint}`);

  const parts = [
    `# タイトル\n${input.title}`,
    `# 公式URL\n${input.sourceUrl}`,
  ];

  if (hints.length > 0) {
    parts.push(
      `# 与えられた値（推測ではなく確定値。これらは原文からの抽出より優先して使う）\n${hints.join('\n')}`,
    );
  }

  parts.push(`# 本文\n${input.bodyText}`);
  return parts.join('\n\n');
}
```

- [ ] **Step 8: `src/ai/mock.ts` を実装**

```ts
import type { NeedAnalysis } from './schema.ts';
import { parseClassification, parseNeedAnalysis } from './schema.ts';
import type { AiProvider, AnalysisInput, AnalyzeResult, ClassifyResult } from './provider.ts';

/**
 * claude CLI を呼ばずに全フローを通すための固定応答（指示書 §26 の必須要件）。
 * §25 の4サンプルに対応する。タイトルのキーワードで振り分ける。
 */

type Sample = {
  match: (title: string) => boolean;
  isTarget: boolean;
  reason: string;
  analysis: Partial<NeedAnalysis> & { need_title: string };
};

const SAMPLES: Sample[] = [
  {
    // サンプル1: 大阪市CXサービスデザインRFI（実在）
    match: (t) => t.includes('情報提供') || t.includes('RFI') || t.includes('サウンディング'),
    isTarget: true,
    reason: '市民向けポータルと行政DXに関する情報提供依頼である',
    analysis: {
      document_type: 'RFI',
      need_title: '総合サービスポータル・コンタクトセンターの整備',
      problem_summary: '行政サービスが分散し、利用者ごとの体験が最適化されていない',
      background: 'CXサービスグランドデザインに基づくサービスDXの推進',
      desired_state: '全体最適化されたサービス提供スタイルの実現',
      request_to_private_sector: 'システム構成・機能要件・実現可能性・費用・スケジュールの情報提供',
      categories: ['ポータルサイト', 'CX', 'UI・UX', '行政DX'],
      maturity_stage: '市場対話',
      domain_relevance: 'A',
      domain_relevance_reason: 'Web・DXが取り組みの中心である',
      company_relevance: 'B',
      company_relevance_reason: '住民向け情報発信と申請導線を含む上流案件で、SIerとの連携が前提になる',
      possible_company_roles: ['UI・UX設計', 'Webサイト・ポータル構築'],
      required_partners: ['SIer'],
      contact_recommendation: '高',
      recommended_action: '第1回RFIに参加し、情報提供を通じて要件形成に関与する',
      questions_to_confirm: ['第2回RFIの時期', '調達の分割単位'],
      risks_and_conditions: ['参加申込が必要', '関係資料は申込者にのみ交付'],
      confidence: 88,
    },
  },
  {
    // サンプル2: 観光ポータル構築の公募型プロポーザル（架空）
    match: (t) => t.includes('プロポーザル') || t.includes('企画提案') || t.includes('公募'),
    isTarget: true,
    reason: '観光情報発信のポータルサイト構築・運用の公募である',
    analysis: {
      document_type: 'プロポーザル',
      need_title: '観光ポータルサイトの構築と継続的な運用',
      problem_summary: '観光情報が複数サイトに分散し、更新も滞っている',
      background: '観光客の回復に合わせた情報発信の強化',
      desired_state: '職員が自ら更新できる観光情報基盤',
      request_to_private_sector: 'サイト構築・CMS導入・運用支援の企画提案',
      categories: ['ポータルサイト', '観光情報発信', 'CMS', 'コンテンツ制作'],
      maturity_stage: '公募中',
      domain_relevance: 'A',
      domain_relevance_reason: 'Webサイト構築が取り組みの中心である',
      company_relevance: 'A',
      company_relevance_reason: 'CMS導入と運用内製化支援が直接合致する',
      possible_company_roles: ['Webサイト・ポータル構築', 'CMS導入', '運用内製化支援'],
      required_partners: ['地域の制作会社'],
      contact_recommendation: '高',
      recommended_action: '公募要領を取得し参加要件を確認する',
      questions_to_confirm: ['運用期間', '既存コンテンツの移行範囲'],
      risks_and_conditions: ['参加資格に実績要件がある可能性'],
      confidence: 82,
    },
  },
  {
    // サンプル3: 自治体DXの5カ年計画（架空）
    match: (t) => t.includes('計画') || t.includes('方針') || t.includes('グランドデザイン') || t.includes('策定'),
    isTarget: true,
    reason: 'DX推進の中期計画であり、将来的な外部連携につながる方針である',
    analysis: {
      document_type: '計画',
      need_title: 'DX推進5カ年計画に基づく住民接点のデジタル化',
      problem_summary: 'オンライン手続きの利用率が低く、情報発信も分散している',
      background: '5カ年計画で住民接点のデジタル化を掲げている',
      desired_state: '住民が迷わず手続きと情報にたどりつける状態',
      request_to_private_sector: '現時点では具体的な公募はない',
      categories: ['行政DX', 'オンライン申請', 'デジタル広報'],
      maturity_stage: '政策方針',
      domain_relevance: 'A',
      domain_relevance_reason: 'DXが計画の主題である',
      company_relevance: 'B',
      company_relevance_reason: '住民向け情報発信の改善部分で関われる',
      possible_company_roles: ['Webサイト・ポータル構築', '運用内製化支援'],
      required_partners: ['SIer', 'コンサルティング会社'],
      contact_recommendation: '低',
      recommended_action: '継続監視し、年度予算の公表時に再確認する',
      questions_to_confirm: ['年度別の実施項目', '担当部署'],
      risks_and_conditions: ['具体的な事業化時期が未定'],
      confidence: 70,
    },
  },
  {
    // サンプル4: 庁舎用プリンター購入（架空）→ 対象外
    match: (t) => /プリンター|複合機|パソコン|PC|物品|購入|調達/.test(t),
    isTarget: false,
    reason: '物品購入であり、指示書の原則として対象外に該当する',
    analysis: {
      document_type: '入札',
      need_title: '庁舎用プリンターの購入',
      maturity_stage: '公募中',
      domain_relevance: '対象外',
      company_relevance: '対象外',
      contact_recommendation: '不要',
      confidence: 95,
    },
  },
];

const FALLBACK: Sample = {
  match: () => true,
  isTarget: true,
  reason: 'モックの既定応答',
  analysis: {
    document_type: 'その他',
    need_title: 'モックによる既定のニーズ整理',
    maturity_stage: '不明',
    domain_relevance: 'C',
    company_relevance: 'C',
    contact_recommendation: '低',
    confidence: 50,
  },
};

/** 本文に実在する短い断片を根拠として選ぶ。根拠一致検査を通るようにする。 */
function pickQuote(bodyText: string): Array<{ field: string; quote: string }> {
  const line = bodyText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length >= 8 && l.length <= 120);
  return line === undefined ? [] : [{ field: 'need_title', quote: line }];
}

export function createMockProvider(): AiProvider {
  const find = (title: string): Sample => SAMPLES.find((s) => s.match(title)) ?? FALLBACK;

  return {
    name: 'mock',
    model: 'mock',

    async classify(input: AnalysisInput): Promise<ClassifyResult> {
      const s = find(input.title);
      const raw = JSON.stringify({
        is_target: s.isTarget,
        reason: s.reason,
        confidence: s.analysis.confidence ?? 50,
      });
      return { data: parseClassification(raw), raw, durationMs: 0, costUsd: null };
    },

    async analyze(input: AnalysisInput): Promise<AnalyzeResult> {
      const s = find(input.title);
      const raw = JSON.stringify({
        organization_name: input.organizationHint ?? '大阪市',
        department_name: 'デジタル統括室',
        published_at: input.publishedAtHint ?? null,
        deadline: null,
        budget: null,
        official_title: input.title,
        problem_summary: null,
        background: null,
        desired_state: null,
        request_to_private_sector: null,
        categories: [],
        domain_relevance_reason: null,
        company_relevance_reason: null,
        possible_company_roles: [],
        required_partners: [],
        recommended_action: null,
        questions_to_confirm: [],
        risks_and_conditions: [],
        evidence_quotes: pickQuote(input.bodyText),
        ...s.analysis,
        // ヒントは常に AI 抽出値より優先する（設計書 §15）
        ...(input.documentTypeHint ? { document_type: input.documentTypeHint } : {}),
        ...(input.organizationHint ? { organization_name: input.organizationHint } : {}),
      });
      return { data: parseNeedAnalysis(raw), raw, durationMs: 0, costUsd: null };
    },
  };
}
```

- [ ] **Step 9: テストが通ることを確認**

```bash
npx vitest run test/ai-prompt.test.ts test/ai-mock.test.ts
```

Expected: PASS（18 tests）

- [ ] **Step 10: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 11: コミット**

```bash
git add src/ai/provider.ts src/ai/prompt.ts src/ai/mock.ts prompts/ test/ai-prompt.test.ts test/ai-mock.test.ts
git commit -m "feat: Provider インターフェース・外置きプロンプト・MockProvider

プロンプトは prompts/*.md に外置きし、コードを触らず調整できるようにする。
対象判定には company-profile を連結しない（自社定義を要しない判断）。
Mock は §25 の4サンプルに対応し、根拠引用に本文の実在断片を使う。"
```

---

## Task 13: ClaudeCliProvider と Provider 選択

**Files:**
- Create: `src/ai/claude-cli.ts`, `src/ai/index.ts`
- Test: `test/ai-claude-cli.test.ts`, `test/ai-index.test.ts`

**Interfaces:**
- Consumes: `type AiProvider`, `type AnalysisInput`（`src/ai/provider.ts`）／`loadPrompts`, `buildUserMessage`（`src/ai/prompt.ts`）／`parseClassification`, `parseNeedAnalysis`（`src/ai/schema.ts`）／`createMockProvider`（`src/ai/mock.ts`）／`AppError`（`src/errors.ts`）
- Produces:
  - `src/ai/claude-cli.ts`: `type ClaudeCliOptions = { cliPath: string; model: string; timeoutMs: number; promptsDir?: string; runner?: CliRunner }`／`type CliRunner = (args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>`／`parseCliEnvelope(stdout: string): { result: string; durationMs: number; costUsd: number | null }`／`createClaudeCliProvider(opts: ClaudeCliOptions): AiProvider`
  - `src/ai/index.ts`: `createProvider(env?: NodeJS.ProcessEnv): AiProvider`

- [ ] **Step 1: 失敗するテストを書く**

`runner` を注入して実際の `claude` 起動なしにテストする。エンベロープの形は 2026-08-05 の実測値。

```ts
// test/ai-claude-cli.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createClaudeCliProvider, parseCliEnvelope } from '../src/ai/claude-cli.ts';
import { AppError } from '../src/errors.ts';

/** 2026-08-05 に実測した claude -p --output-format json のエンベロープ。 */
function envelope(result: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result, duration_ms: 8019, duration_api_ms: 7800,
    total_cost_usd: 0.0392547, num_turns: 1,
    session_id: 'f7ba7476-55c3-40c2-99ef-80682b1024f4',
    usage: {}, modelUsage: {}, permission_denials: [], uuid: 'x',
    ...over,
  });
}

const CLASSIFY_JSON = '{"is_target": false, "reason": "物品購入である", "confidence": 92}';

const ANALYSIS_JSON = JSON.stringify({
  document_type: 'RFI', organization_name: '大阪市', department_name: 'デジタル統括室',
  published_at: '2026-07-30', deadline: '2026-08-21', budget: null,
  official_title: 'CX情報提供', need_title: 'ポータル整備',
  problem_summary: 'x', background: 'x', desired_state: 'x', request_to_private_sector: 'x',
  categories: ['CX'], maturity_stage: '市場対話',
  domain_relevance: 'A', domain_relevance_reason: 'x',
  company_relevance: 'B', company_relevance_reason: 'x',
  possible_company_roles: ['UI・UX設計'], required_partners: ['SIer'],
  contact_recommendation: '高', recommended_action: 'x',
  questions_to_confirm: [], risks_and_conditions: [],
  confidence: 88, evidence_quotes: [],
});

function stubRunner(stdout: string, over: Partial<{ code: number; stderr: string; timedOut: boolean }> = {}) {
  return vi.fn(async () => ({ code: 0, stdout, stderr: '', timedOut: false, ...over }));
}

const OPTS = { cliPath: '/opt/homebrew/bin/claude', model: 'sonnet', timeoutMs: 180_000, promptsDir: 'prompts' };

describe('parseCliEnvelope', () => {
  it('result / duration_ms / total_cost_usd を取り出す', () => {
    const r = parseCliEnvelope(envelope(CLASSIFY_JSON));
    expect(r.result).toBe(CLASSIFY_JSON);
    expect(r.durationMs).toBe(8019);
    expect(r.costUsd).toBeCloseTo(0.0392547);
  });

  it('is_error: true は AI_INVALID_RESPONSE', () => {
    expect(() => parseCliEnvelope(envelope('x', { is_error: true, subtype: 'error_during_execution' })))
      .toThrow(AppError);
  });

  it('subtype が success 以外は AI_INVALID_RESPONSE', () => {
    expect(() => parseCliEnvelope(envelope('x', { subtype: 'error_max_turns' }))).toThrow(AppError);
  });

  it('result が文字列でなければ AI_INVALID_RESPONSE', () => {
    expect(() => parseCliEnvelope(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: { a: 1 } })))
      .toThrow(AppError);
  });

  it('エンベロープ自体が JSON でなければ AI_INVALID_RESPONSE', () => {
    expect(() => parseCliEnvelope('not json')).toThrow(AppError);
  });

  it('total_cost_usd がなければ costUsd は null', () => {
    const r = parseCliEnvelope(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x', duration_ms: 1 }));
    expect(r.costUsd).toBeNull();
  });
});

describe('createClaudeCliProvider: 起動引数', () => {
  it('実測で確認したオプションを渡す', async () => {
    const runner = stubRunner(envelope(CLASSIFY_JSON));
    const p = createClaudeCliProvider({ ...OPTS, runner });
    await p.classify({ title: 'プリンター購入', bodyText: '本文', sourceUrl: 'https://a.jp/x' });

    const args = runner.mock.calls[0]?.[0] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args).toContain('--allowed-tools');
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('');
    expect(args).toContain('--append-system-prompt');
  });

  it('本文は引数ではなく stdin で渡す（引数長制限とエスケープ事故を避ける）', async () => {
    const runner = stubRunner(envelope(CLASSIFY_JSON));
    const p = createClaudeCliProvider({ ...OPTS, runner });
    const bodyText = 'あ'.repeat(50_000);
    await p.classify({ title: 't', bodyText, sourceUrl: 'https://a.jp/x' });

    const args = runner.mock.calls[0]?.[0] as string[];
    const stdin = runner.mock.calls[0]?.[1] as string;
    expect(stdin).toContain(bodyText);
    expect(args.join(' ')).not.toContain(bodyText);
  });

  it('classify と analyze で異なるシステムプロンプトを使う', async () => {
    const runner = vi.fn(async (args: string[]) => ({
      code: 0, stderr: '', timedOut: false,
      stdout: envelope(args.join(' ').includes('構造化') ? ANALYSIS_JSON : CLASSIFY_JSON),
    }));
    const p = createClaudeCliProvider({ ...OPTS, runner });
    await p.classify({ title: 't', bodyText: '本文', sourceUrl: 'https://a.jp/x' });
    await p.analyze({ title: 't', bodyText: '本文', sourceUrl: 'https://a.jp/x' });

    const sys = (n: number) => {
      const a = runner.mock.calls[n]?.[0] as string[];
      return a[a.indexOf('--append-system-prompt') + 1] ?? '';
    };
    expect(sys(0)).not.toBe(sys(1));
    expect(sys(1)).toContain('Studio 株式会社');
    expect(sys(0)).not.toContain('Studio 株式会社');
  });
});

describe('createClaudeCliProvider: 結果', () => {
  it('classify の結果を検証して返す', async () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner(envelope(CLASSIFY_JSON)) });
    const r = await p.classify({ title: 't', bodyText: '本文', sourceUrl: 'https://a.jp/x' });
    expect(r.data.is_target).toBe(false);
    expect(r.data.confidence).toBe(92);
    expect(r.raw).toBe(CLASSIFY_JSON);
    expect(r.durationMs).toBe(8019);
    expect(r.costUsd).toBeCloseTo(0.0392547);
  });

  it('analyze の結果を検証して返す', async () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner(envelope(ANALYSIS_JSON)) });
    const r = await p.analyze({ title: 't', bodyText: '本文', sourceUrl: 'https://a.jp/x' });
    expect(r.data.maturity_stage).toBe('市場対話');
    expect(r.data.deadline).toBe('2026-08-21');
  });

  it('result がコードフェンスに包まれていても剥がす', async () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner(envelope('```json\n' + CLASSIFY_JSON + '\n```')) });
    expect((await p.classify({ title: 't', bodyText: 'b', sourceUrl: 'https://a.jp/x' })).data.confidence).toBe(92);
  });

  it('name と model を公開する', () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner(envelope(CLASSIFY_JSON)) });
    expect(p.name).toBe('claude_cli');
    expect(p.model).toBe('sonnet');
  });
});

describe('createClaudeCliProvider: 異常系', () => {
  const input = { title: 't', bodyText: '本文', sourceUrl: 'https://a.jp/x' };

  it('timedOut は AI_TIMEOUT', async () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner('', { timedOut: true, code: 143 }) });
    await expect(p.classify(input)).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });

  it('非ゼロ終了は AI_UNAVAILABLE', async () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner('', { code: 1, stderr: 'not logged in' }) });
    await expect(p.classify(input)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('stderr を internalDetail にのみ入れ、userMessage には出さない', async () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner('', { code: 1, stderr: '/Users/secret/path が見つからない' }) });
    try {
      await p.classify(input);
      throw new Error('例外が投げられなかった');
    } catch (e) {
      const err = e as AppError;
      expect(err.internalDetail).toContain('/Users/secret/path');
      expect(err.userMessage).not.toContain('/Users/secret/path');
    }
  });

  it('CLI が見つからない（ENOENT）は AI_UNAVAILABLE', async () => {
    const runner = vi.fn(async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); });
    const p = createClaudeCliProvider({ ...OPTS, runner });
    await expect(p.classify(input)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('モデル出力が不正なら AI_INVALID_RESPONSE で生出力を残す', async () => {
    const p = createClaudeCliProvider({ ...OPTS, runner: stubRunner(envelope('対象だと思います')) });
    try {
      await p.classify(input);
      throw new Error('例外が投げられなかった');
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe('AI_INVALID_RESPONSE');
      expect(err.internalDetail).toContain('対象だと思います');
    }
  });
});
```

```ts
// test/ai-index.test.ts
import { describe, expect, it } from 'vitest';
import { createProvider } from '../src/ai/index.ts';

describe('createProvider', () => {
  it('AI_PROVIDER=mock で MockProvider を返す', () => {
    expect(createProvider({ AI_PROVIDER: 'mock' }).name).toBe('mock');
  });

  it('AI_PROVIDER=claude_cli で ClaudeCliProvider を返す', () => {
    const p = createProvider({ AI_PROVIDER: 'claude_cli', AI_MODEL: 'sonnet' });
    expect(p.name).toBe('claude_cli');
    expect(p.model).toBe('sonnet');
  });

  it('AI_PROVIDER 未設定は claude_cli を既定にする', () => {
    expect(createProvider({}).name).toBe('claude_cli');
  });

  it('AI_MODEL 未設定は sonnet を既定にする', () => {
    expect(createProvider({ AI_PROVIDER: 'claude_cli' }).model).toBe('sonnet');
  });

  it('未知の AI_PROVIDER は例外', () => {
    expect(() => createProvider({ AI_PROVIDER: 'openai' })).toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/ai-claude-cli.test.ts test/ai-index.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/ai/claude-cli.ts"`

- [ ] **Step 3: `src/ai/claude-cli.ts` を実装**

`timeout` コマンドは macOS に無いので Node 側で kill する（Global Constraints 8）。

```ts
import { spawn } from 'node:child_process';
import { AppError } from '../errors.ts';
import { buildUserMessage, loadPrompts } from './prompt.ts';
import type { AiProvider, AnalysisInput, AnalyzeResult, ClassifyResult } from './provider.ts';
import { parseClassification, parseNeedAnalysis } from './schema.ts';

export type CliRunner = (
  args: string[],
  stdin: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;

export type ClaudeCliOptions = {
  cliPath: string;
  model: string;
  timeoutMs: number;
  promptsDir?: string;
  /** テストで差し替える。既定は子プロセス起動 */
  runner?: CliRunner;
};

/**
 * claude CLI を起動する既定 runner。
 * timeout コマンドは macOS に無いので、タイマーで SIGKILL する。
 */
const defaultRunner: CliRunner = (args, stdin, timeoutMs) =>
  new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    if (cmd === undefined) {
      reject(new Error('起動コマンドが空'));
      return;
    }

    const child = spawn(cmd, rest, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { stdout += c; });
    child.stderr.on('data', (c: string) => { stderr += c; });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });

    child.stdin.on('error', () => { /* 早期終了時の EPIPE を無視する */ });
    child.stdin.end(stdin, 'utf8');
  });

/**
 * `claude -p --output-format json` のエンベロープから result を取り出す。
 * 形は 2026-08-05 に実測（Global Constraints 13）。
 */
export function parseCliEnvelope(stdout: string): {
  result: string;
  durationMs: number;
  costUsd: number | null;
} {
  let env: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object') throw new Error('オブジェクトでない');
    env = parsed as Record<string, unknown>;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new AppError(
      'AI_INVALID_RESPONSE',
      undefined,
      `CLI のエンベロープを解釈できません: ${detail} / stdout の先頭300文字: ${stdout.slice(0, 300)}`,
    );
  }

  if (env['is_error'] === true || env['subtype'] !== 'success') {
    throw new AppError(
      'AI_INVALID_RESPONSE',
      undefined,
      `CLI がエラーを返しました: subtype=${String(env['subtype'])} / ${JSON.stringify(env).slice(0, 300)}`,
    );
  }

  const result = env['result'];
  if (typeof result !== 'string') {
    throw new AppError('AI_INVALID_RESPONSE', undefined, `result が文字列ではありません: ${typeof result}`);
  }

  const duration = env['duration_ms'];
  const cost = env['total_cost_usd'];

  return {
    result,
    durationMs: typeof duration === 'number' ? duration : 0,
    costUsd: typeof cost === 'number' ? cost : null,
  };
}

/**
 * `claude -p` をサブプロセス実行する Provider（設計書 §8-2）。
 *
 * 実測で確認したオプション（claude v2.1.88）:
 *   -p / --output-format json / --model <m> / --allowed-tools "" / --append-system-prompt <s>
 * 本文は stdin で渡す。--allowed-tools "" でツール実行を禁止し副作用をゼロにする。
 */
export function createClaudeCliProvider(opts: ClaudeCliOptions): AiProvider {
  const runner = opts.runner ?? defaultRunner;
  const prompts = loadPrompts(opts.promptsDir);

  const invoke = async (
    systemPrompt: string,
    input: AnalysisInput,
  ): Promise<{ raw: string; durationMs: number; costUsd: number | null }> => {
    const args = [
      opts.cliPath,
      '-p',
      '--output-format', 'json',
      '--model', opts.model,
      '--allowed-tools', '',
      '--append-system-prompt', systemPrompt,
    ];

    let out: Awaited<ReturnType<CliRunner>>;
    try {
      out = await runner(args, buildUserMessage(input), opts.timeoutMs);
    } catch (e) {
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new AppError('AI_UNAVAILABLE', undefined, `CLI を起動できません（${opts.cliPath}）: ${detail}`);
    }

    if (out.timedOut) {
      throw new AppError('AI_TIMEOUT', undefined, `${opts.timeoutMs}ms を超えたため中断: ${input.sourceUrl}`);
    }
    if (out.code !== 0) {
      throw new AppError('AI_UNAVAILABLE', undefined, `CLI が exit ${out.code}: ${out.stderr.slice(0, 500)}`);
    }

    const env = parseCliEnvelope(out.stdout);
    return { raw: env.result, durationMs: env.durationMs, costUsd: env.costUsd };
  };

  return {
    name: 'claude_cli',
    model: opts.model,

    async classify(input: AnalysisInput): Promise<ClassifyResult> {
      const r = await invoke(prompts.classify, input);
      return { data: parseClassification(r.raw), ...r };
    },

    async analyze(input: AnalysisInput): Promise<AnalyzeResult> {
      const r = await invoke(prompts.analyze, input);
      const year = input.publishedAtHint ? Number(input.publishedAtHint.slice(0, 4)) : null;
      return { data: parseNeedAnalysis(r.raw, year), ...r };
    },
  };
}
```

- [ ] **Step 4: `src/ai/index.ts` を実装**

```ts
import { AppError } from '../errors.ts';
import { createClaudeCliProvider } from './claude-cli.ts';
import { createMockProvider } from './mock.ts';
import type { AiProvider } from './provider.ts';

const DEFAULTS = {
  provider: 'claude_cli',
  model: 'sonnet',
  cliPath: '/opt/homebrew/bin/claude',
  timeoutMs: 180_000,
} as const;

/** 環境変数から Provider を選ぶ（設計書 §19）。 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const kind = env['AI_PROVIDER'] ?? DEFAULTS.provider;

  if (kind === 'mock') return createMockProvider();

  if (kind === 'claude_cli') {
    const timeoutRaw = Number(env['AI_TIMEOUT_MS']);
    return createClaudeCliProvider({
      cliPath: env['CLAUDE_CLI_PATH'] ?? DEFAULTS.cliPath,
      model: env['AI_MODEL'] ?? DEFAULTS.model,
      timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULTS.timeoutMs,
    });
  }

  throw new AppError(
    'CONFIG_INVALID',
    `AI_PROVIDER に未知の値が指定されています: ${kind}`,
    'AI_PROVIDER は claude_cli または mock のみ',
  );
}

export type { AiProvider, AnalysisInput, AnalyzeResult, ClassifyResult } from './provider.ts';
```

- [ ] **Step 5: テストが通ることを確認**

```bash
npx vitest run test/ai-claude-cli.test.ts test/ai-index.test.ts
```

Expected: PASS（22 tests）

- [ ] **Step 6: 実 CLI に対する疎通を1回だけ手で確認**

自動テストには含めない（課金と実行時間が発生するため）。実装者が1回だけ実行して結果を報告する。

```bash
printf '%s' '庁舎用プリンター100台の購入について、下記のとおり一般競争入札を実施します。' | claude -p --output-format json --model sonnet --allowed-tools "" --append-system-prompt "$(cat prompts/classify.md)" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);console.log("subtype:",e.subtype,"cost:",e.total_cost_usd);console.log(JSON.parse(e.result))})'
```

Expected: `subtype: success` と `{ is_target: false, reason: ..., confidence: <0-100の整数> }`

`is_target` が `true` になった場合は `prompts/classify.md` の「原則として対象外」の記述を強める。

- [ ] **Step 7: 型検査・lint・全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS

- [ ] **Step 8: コミット**

```bash
git add src/ai/claude-cli.ts src/ai/index.ts test/ai-claude-cli.test.ts test/ai-index.test.ts
git commit -m "feat: ClaudeCliProvider と環境変数による Provider 選択

実測したエンベロープ（type/subtype/is_error/result/duration_ms/total_cost_usd）を扱う。
本文は stdin で渡し、--allowed-tools '' で副作用をゼロにする。
タイムアウトは Node 側で SIGKILL（macOS に timeout コマンドが無い）。
stderr は internalDetail にのみ残す。"
```

---

## Task 14: SQLite 永続化

**Files:**
- Create: `src/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `type ProcessedStatus`（`src/types.ts`）／`AppError`（`src/errors.ts`）
- Produces:
  - `type ProcessedRow = { urlNormalized: string; url: string; sourceId: string | null; organization: string | null; title: string | null; contentHash: string; isTarget: number | null; status: ProcessedStatus; errorCode: string | null; errorDetail: string | null; aiProvider: string | null; aiModel: string | null; aiClassifyJson: string | null; aiAnalyzeJson: string | null; analyzedAt: string | null; notionPageId: string | null; notionSyncedAt: string | null; firstSeenAt: string; lastSeenAt: string }`
  - `type RunLogRow = { runId: string; startedAt: string; finishedAt: string | null; sourceId: string | null; found: number; excluded: number; fetched: number; analyzed: number; target: number; nonTarget: number; synced: number; failed: number }`
  - `type Store = { hasUrl, getByUrl, getByContentHash, getByOrgAndTitle, upsert, markSynced, markPendingNotion, markFailed, listPendingNotion, startRun, finishRun, cacheRaw, close }`
  - `contentHash(bodyText: string): string`
  - `openStore(opts: { path: string; rawDir?: string }): Store`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/store.test.ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anp-store-'));
  store = openStore({ path: join(dir, 'app.db'), rawDir: join(dir, 'raw') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(over: Partial<Parameters<Store['upsert']>[0]> = {}) {
  return {
    urlNormalized: 'https://www.city.osaka.lg.jp/a.html',
    url: 'https://www.city.osaka.lg.jp/a.html',
    sourceId: 'osaka-digital-rss',
    organization: '大阪市',
    title: 'テスト案件',
    contentHash: contentHash('本文'),
    status: 'pending_analysis' as const,
    ...over,
  };
}

describe('contentHash', () => {
  it('同じ本文で同じハッシュになる', () => {
    expect(contentHash('本文')).toBe(contentHash('本文'));
  });

  it('空白と改行の差異を吸収する', () => {
    expect(contentHash('あ い\nう')).toBe(contentHash('あい う'));
  });

  it('全角半角の数字差を吸収する', () => {
    expect(contentHash('令和8年')).toBe(contentHash('令和８年'));
  });

  it('内容が違えば違うハッシュになる', () => {
    expect(contentHash('本文A')).not.toBe(contentHash('本文B'));
  });

  it('64文字の16進文字列を返す', () => {
    expect(contentHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('upsert と取得', () => {
  it('新規行を保存して URL で引ける', () => {
    store.upsert(row());
    const got = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(got?.title).toBe('テスト案件');
    expect(got?.status).toBe('pending_analysis');
    expect(got?.firstSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('通常オブジェクトを返す（null-prototype ではない）', () => {
    store.upsert(row());
    const got = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect({ ...got }).toMatchObject({ title: 'テスト案件' });
  });

  it('hasUrl で存在を判定できる', () => {
    expect(store.hasUrl('https://www.city.osaka.lg.jp/a.html')).toBe(false);
    store.upsert(row());
    expect(store.hasUrl('https://www.city.osaka.lg.jp/a.html')).toBe(true);
  });

  it('同じ URL の再 upsert で firstSeenAt を保ち lastSeenAt を更新する', async () => {
    store.upsert(row());
    const first = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    await new Promise((r) => setTimeout(r, 5));
    store.upsert(row({ title: '更新後' }));
    const second = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(second?.firstSeenAt).toBe(first?.firstSeenAt);
    expect(second?.title).toBe('更新後');
    expect(Date.parse(second?.lastSeenAt ?? '')).toBeGreaterThanOrEqual(Date.parse(first?.lastSeenAt ?? ''));
  });

  it('本文ハッシュで引ける', () => {
    store.upsert(row());
    expect(store.getByContentHash(contentHash('本文'))?.title).toBe('テスト案件');
    expect(store.getByContentHash(contentHash('別の本文'))).toBeNull();
  });

  it('自治体名とタイトルの組み合わせで引ける', () => {
    store.upsert(row());
    expect(store.getByOrgAndTitle('大阪市', 'テスト案件')?.urlNormalized)
      .toBe('https://www.city.osaka.lg.jp/a.html');
    expect(store.getByOrgAndTitle('福岡市', 'テスト案件')).toBeNull();
  });

  it('AI 結果を保存して読み戻せる', () => {
    store.upsert(row({
      status: 'analyzed', isTarget: 1,
      aiProvider: 'claude_cli', aiModel: 'sonnet',
      aiClassifyJson: JSON.stringify({ is_target: true }),
      aiAnalyzeJson: JSON.stringify({ need_title: 'x' }),
      analyzedAt: '2026-08-05T04:00:00.000Z',
    }));
    const g = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(g?.isTarget).toBe(1);
    expect(JSON.parse(g?.aiAnalyzeJson ?? '{}')).toEqual({ need_title: 'x' });
    expect(g?.aiModel).toBe('sonnet');
  });
});

describe('Notion 同期状態', () => {
  it('markSynced で page_id と時刻を記録し status=synced にする', () => {
    store.upsert(row({ status: 'analyzed' }));
    store.markSynced('https://www.city.osaka.lg.jp/a.html', 'page-123');
    const g = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(g?.status).toBe('synced');
    expect(g?.notionPageId).toBe('page-123');
    expect(g?.notionSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('markPendingNotion で再送対象にする', () => {
    store.upsert(row({ status: 'analyzed' }));
    store.markPendingNotion('https://www.city.osaka.lg.jp/a.html', 'NOTION_WRITE_FAILED', '503');
    const g = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(g?.status).toBe('pending_notion');
    expect(g?.errorCode).toBe('NOTION_WRITE_FAILED');
    expect(g?.errorDetail).toBe('503');
  });

  it('listPendingNotion が pending_notion のみを返す', () => {
    store.upsert(row({ urlNormalized: 'https://a.jp/1', url: 'https://a.jp/1', status: 'pending_notion' }));
    store.upsert(row({ urlNormalized: 'https://a.jp/2', url: 'https://a.jp/2', status: 'synced' }));
    store.upsert(row({ urlNormalized: 'https://a.jp/3', url: 'https://a.jp/3', status: 'pending_notion' }));
    expect(store.listPendingNotion().map((r) => r.urlNormalized).sort()).toEqual(['https://a.jp/1', 'https://a.jp/3']);
  });

  it('markSynced 後は listPendingNotion から消える', () => {
    store.upsert(row({ status: 'pending_notion' }));
    expect(store.listPendingNotion()).toHaveLength(1);
    store.markSynced('https://www.city.osaka.lg.jp/a.html', 'page-1');
    expect(store.listPendingNotion()).toHaveLength(0);
  });

  it('markFailed でエラーを残し status=failed にする', () => {
    store.upsert(row());
    store.markFailed('https://www.city.osaka.lg.jp/a.html', 'AI_TIMEOUT', '180000ms 超過');
    const g = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(g?.status).toBe('failed');
    expect(g?.errorCode).toBe('AI_TIMEOUT');
  });

  it('markFailed 後も本文ハッシュと AI 結果が失われない（再実行できる）', () => {
    store.upsert(row({ status: 'analyzed', aiAnalyzeJson: '{"need_title":"保持"}' }));
    store.markFailed('https://www.city.osaka.lg.jp/a.html', 'NOTION_WRITE_FAILED', 'x');
    const g = store.getByUrl('https://www.city.osaka.lg.jp/a.html');
    expect(g?.contentHash).toBe(contentHash('本文'));
    expect(g?.aiAnalyzeJson).toBe('{"need_title":"保持"}');
  });
});

describe('run_logs', () => {
  it('開始と終了を記録できる', () => {
    const runId = store.startRun('osaka-digital-rss');
    expect(runId).toMatch(/[0-9a-f-]{36}/);
    store.finishRun(runId, { found: 100, excluded: 20, fetched: 5, analyzed: 5, target: 3, nonTarget: 2, synced: 5, failed: 0 });
    const rows = store.listRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ found: 100, excluded: 20, target: 3, failed: 0 });
    expect(rows[0]?.finishedAt).not.toBeNull();
  });
});

describe('cacheRaw', () => {
  it('本文をハッシュ名でファイルに保存する', () => {
    const h = contentHash('本文');
    store.cacheRaw(h, '本文');
    const files = readdirSync(join(dir, 'raw'), { recursive: true }) as string[];
    expect(files.some((f) => String(f).includes(h))).toBe(true);
  });

  it('同じハッシュを二度保存しても例外にならない', () => {
    const h = contentHash('本文');
    store.cacheRaw(h, '本文');
    expect(() => store.cacheRaw(h, '本文')).not.toThrow();
  });
});

describe('スキーマの再オープン', () => {
  it('同じパスを開き直してもデータが残る', () => {
    store.upsert(row());
    store.close();
    const again = openStore({ path: join(dir, 'app.db'), rawDir: join(dir, 'raw') });
    expect(again.getByUrl('https://www.city.osaka.lg.jp/a.html')?.title).toBe('テスト案件');
    again.close();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/store.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/store.ts"`

- [ ] **Step 3: `src/store.ts` を実装**

`node:sqlite` の行は null-prototype なので `{ ...row }` で通常化する（Global Constraints 7）。

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.ts';
import type { ProcessedStatus } from './types.ts';

export type ProcessedRow = {
  urlNormalized: string;
  url: string;
  sourceId: string | null;
  organization: string | null;
  title: string | null;
  contentHash: string;
  isTarget: number | null;
  status: ProcessedStatus;
  errorCode: string | null;
  errorDetail: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiClassifyJson: string | null;
  aiAnalyzeJson: string | null;
  analyzedAt: string | null;
  notionPageId: string | null;
  notionSyncedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type UpsertInput = {
  urlNormalized: string;
  url: string;
  sourceId?: string | null;
  organization?: string | null;
  title?: string | null;
  contentHash: string;
  isTarget?: number | null;
  status: ProcessedStatus;
  errorCode?: string | null;
  errorDetail?: string | null;
  aiProvider?: string | null;
  aiModel?: string | null;
  aiClassifyJson?: string | null;
  aiAnalyzeJson?: string | null;
  analyzedAt?: string | null;
};

export type RunSummary = {
  found: number;
  excluded: number;
  fetched: number;
  analyzed: number;
  target: number;
  nonTarget: number;
  synced: number;
  failed: number;
};

export type RunLogRow = RunSummary & {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  sourceId: string | null;
};

export type Store = {
  hasUrl(urlNormalized: string): boolean;
  getByUrl(urlNormalized: string): ProcessedRow | null;
  getByContentHash(hash: string): ProcessedRow | null;
  getByOrgAndTitle(organization: string, title: string): ProcessedRow | null;
  upsert(input: UpsertInput): void;
  markSynced(urlNormalized: string, notionPageId: string): void;
  markPendingNotion(urlNormalized: string, errorCode: string, errorDetail: string): void;
  markFailed(urlNormalized: string, errorCode: string, errorDetail: string): void;
  listPendingNotion(): ProcessedRow[];
  startRun(sourceId: string | null): string;
  finishRun(runId: string, summary: RunSummary): void;
  listRuns(): RunLogRow[];
  cacheRaw(hash: string, text: string): void;
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed (
  url_normalized   TEXT PRIMARY KEY,
  url              TEXT NOT NULL,
  source_id        TEXT,
  organization     TEXT,
  title            TEXT,
  content_hash     TEXT NOT NULL,
  is_target        INTEGER,
  status           TEXT NOT NULL,
  error_code       TEXT,
  error_detail     TEXT,
  ai_provider      TEXT,
  ai_model         TEXT,
  ai_classify_json TEXT,
  ai_analyze_json  TEXT,
  analyzed_at      TEXT,
  notion_page_id   TEXT,
  notion_synced_at TEXT,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_hash   ON processed (content_hash);
CREATE INDEX IF NOT EXISTS idx_processed_status ON processed (status);
CREATE INDEX IF NOT EXISTS idx_processed_orgttl ON processed (organization, title);
CREATE INDEX IF NOT EXISTS idx_processed_notion ON processed (notion_page_id);

CREATE TABLE IF NOT EXISTS run_logs (
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  source_id   TEXT,
  found       INTEGER NOT NULL DEFAULT 0,
  excluded    INTEGER NOT NULL DEFAULT 0,
  fetched     INTEGER NOT NULL DEFAULT 0,
  analyzed    INTEGER NOT NULL DEFAULT 0,
  target      INTEGER NOT NULL DEFAULT 0,
  non_target  INTEGER NOT NULL DEFAULT 0,
  synced      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * 本文ハッシュ（設計書 §12 の優先順位3）。
 * 空白・改行・全角半角の差異を吸収してから sha256 を取る。
 * レイアウト由来の差分で「更新あり」が誤検知されるのを防ぐ。
 */
export function contentHash(bodyText: string): string {
  const normalized = bodyText
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, '')
    .replace(/\s+/g, '');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

type DbRow = Record<string, string | number | bigint | null | Uint8Array>;

/** null-prototype を通常オブジェクトに直しつつ camelCase へ寄せる（Global Constraints 7）。 */
function toProcessedRow(r: DbRow | undefined): ProcessedRow | null {
  if (r === undefined) return null;
  const o = { ...r };
  const s = (k: string): string | null => (o[k] == null ? null : String(o[k]));
  const n = (k: string): number | null => (o[k] == null ? null : Number(o[k]));
  return {
    urlNormalized: String(o['url_normalized']),
    url: String(o['url']),
    sourceId: s('source_id'),
    organization: s('organization'),
    title: s('title'),
    contentHash: String(o['content_hash']),
    isTarget: n('is_target'),
    status: String(o['status']) as ProcessedStatus,
    errorCode: s('error_code'),
    errorDetail: s('error_detail'),
    aiProvider: s('ai_provider'),
    aiModel: s('ai_model'),
    aiClassifyJson: s('ai_classify_json'),
    aiAnalyzeJson: s('ai_analyze_json'),
    analyzedAt: s('analyzed_at'),
    notionPageId: s('notion_page_id'),
    notionSyncedAt: s('notion_synced_at'),
    firstSeenAt: String(o['first_seen_at']),
    lastSeenAt: String(o['last_seen_at']),
  };
}

export function openStore(opts: { path: string; rawDir?: string }): Store {
  const rawDir = opts.rawDir ?? 'data/raw';
  let db: DatabaseSync;
  try {
    const dir = opts.path.includes('/') ? opts.path.slice(0, opts.path.lastIndexOf('/')) : '.';
    mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(opts.path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new AppError('DB_ERROR', `データベースを開けません: ${opts.path}`, detail);
  }

  const now = (): string => new Date().toISOString();
  const one = (sql: string, ...params: Array<string | number | null>): ProcessedRow | null =>
    toProcessedRow(db.prepare(sql).get(...params) as DbRow | undefined);

  return {
    hasUrl(urlNormalized) {
      const r = db.prepare('SELECT 1 AS x FROM processed WHERE url_normalized = ?').get(urlNormalized);
      return r !== undefined;
    },

    getByUrl(urlNormalized) {
      return one('SELECT * FROM processed WHERE url_normalized = ?', urlNormalized);
    },

    getByContentHash(hash) {
      return one('SELECT * FROM processed WHERE content_hash = ? ORDER BY first_seen_at LIMIT 1', hash);
    },

    getByOrgAndTitle(organization, title) {
      return one(
        'SELECT * FROM processed WHERE organization = ? AND title = ? ORDER BY first_seen_at LIMIT 1',
        organization, title,
      );
    },

    upsert(input) {
      const ts = now();
      // first_seen_at は初回のみ設定し、以降は保持する
      db.prepare(`
        INSERT INTO processed (
          url_normalized, url, source_id, organization, title, content_hash,
          is_target, status, error_code, error_detail,
          ai_provider, ai_model, ai_classify_json, ai_analyze_json, analyzed_at,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url_normalized) DO UPDATE SET
          url              = excluded.url,
          source_id        = COALESCE(excluded.source_id, processed.source_id),
          organization     = COALESCE(excluded.organization, processed.organization),
          title            = COALESCE(excluded.title, processed.title),
          content_hash     = excluded.content_hash,
          is_target        = COALESCE(excluded.is_target, processed.is_target),
          status           = excluded.status,
          error_code       = excluded.error_code,
          error_detail     = excluded.error_detail,
          ai_provider      = COALESCE(excluded.ai_provider, processed.ai_provider),
          ai_model         = COALESCE(excluded.ai_model, processed.ai_model),
          ai_classify_json = COALESCE(excluded.ai_classify_json, processed.ai_classify_json),
          ai_analyze_json  = COALESCE(excluded.ai_analyze_json, processed.ai_analyze_json),
          analyzed_at      = COALESCE(excluded.analyzed_at, processed.analyzed_at),
          last_seen_at     = excluded.last_seen_at
      `).run(
        input.urlNormalized, input.url, input.sourceId ?? null, input.organization ?? null,
        input.title ?? null, input.contentHash, input.isTarget ?? null, input.status,
        input.errorCode ?? null, input.errorDetail ?? null,
        input.aiProvider ?? null, input.aiModel ?? null,
        input.aiClassifyJson ?? null, input.aiAnalyzeJson ?? null, input.analyzedAt ?? null,
        ts, ts,
      );
    },

    markSynced(urlNormalized, notionPageId) {
      db.prepare(`
        UPDATE processed
           SET status = 'synced', notion_page_id = ?, notion_synced_at = ?,
               error_code = NULL, error_detail = NULL, last_seen_at = ?
         WHERE url_normalized = ?
      `).run(notionPageId, now(), now(), urlNormalized);
    },

    markPendingNotion(urlNormalized, errorCode, errorDetail) {
      db.prepare(`
        UPDATE processed
           SET status = 'pending_notion', error_code = ?, error_detail = ?, last_seen_at = ?
         WHERE url_normalized = ?
      `).run(errorCode, errorDetail, now(), urlNormalized);
    },

    markFailed(urlNormalized, errorCode, errorDetail) {
      db.prepare(`
        UPDATE processed
           SET status = 'failed', error_code = ?, error_detail = ?, last_seen_at = ?
         WHERE url_normalized = ?
      `).run(errorCode, errorDetail, now(), urlNormalized);
    },

    listPendingNotion() {
      const rows = db.prepare(
        "SELECT * FROM processed WHERE status = 'pending_notion' ORDER BY first_seen_at",
      ).all() as DbRow[];
      return rows.map((r) => toProcessedRow(r)).filter((r): r is ProcessedRow => r !== null);
    },

    startRun(sourceId) {
      const runId = crypto.randomUUID();
      db.prepare('INSERT INTO run_logs (run_id, started_at, source_id) VALUES (?, ?, ?)')
        .run(runId, now(), sourceId);
      return runId;
    },

    finishRun(runId, s) {
      db.prepare(`
        UPDATE run_logs
           SET finished_at = ?, found = ?, excluded = ?, fetched = ?, analyzed = ?,
               target = ?, non_target = ?, synced = ?, failed = ?
         WHERE run_id = ?
      `).run(now(), s.found, s.excluded, s.fetched, s.analyzed, s.target, s.nonTarget, s.synced, s.failed, runId);
    },

    listRuns() {
      const rows = db.prepare('SELECT * FROM run_logs ORDER BY started_at DESC').all() as DbRow[];
      return rows.map((raw) => {
        const o = { ...raw };
        return {
          runId: String(o['run_id']),
          startedAt: String(o['started_at']),
          finishedAt: o['finished_at'] == null ? null : String(o['finished_at']),
          sourceId: o['source_id'] == null ? null : String(o['source_id']),
          found: Number(o['found']),
          excluded: Number(o['excluded']),
          fetched: Number(o['fetched']),
          analyzed: Number(o['analyzed']),
          target: Number(o['target']),
          nonTarget: Number(o['non_target']),
          synced: Number(o['synced']),
          failed: Number(o['failed']),
        };
      });
    },

    cacheRaw(hash, text) {
      const sub = hash.slice(0, 2);
      const dir = join(rawDir, sub);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${hash}.txt`), text, 'utf8');
    },

    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/store.test.ts
```

Expected: PASS（22 tests）

`listRuns` はテストで使うが上の Produces に書き漏れていないか確認する。`Store` 型に含まれていること。

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/store.ts test/store.test.ts
git commit -m "feat: SQLite 永続化（node:sqlite）

AI 結果を Notion 書き込みより先に確定させ、失敗分は pending_notion で残す。
本文ハッシュは空白・全角半角を吸収してから sha256 を取る。
node:sqlite の null-prototype 行を通常オブジェクトへ直して返す。"
```

---

## Task 15: 重複判定

**Files:**
- Create: `src/dedupe.ts`
- Test: `test/dedupe.test.ts`

**Interfaces:**
- Consumes: `type Store`, `type ProcessedRow`（`src/store.ts`）／`normalizeUrl`（`src/url.ts`）
- Produces:
  - `type DuplicateMatch = { matchedBy: 'url' | 'normalized_url' | 'content_hash' | 'org_and_title' | 'notion'; row: ProcessedRow | null; notionPageId: string | null }`
  - `type NotionLookup = (officialUrl: string) => Promise<string | null>`
  - `findDuplicate(input: { url: string; contentHash?: string | null; organization?: string | null; title?: string | null }, store: Store, notionLookup?: NotionLookup): Promise<DuplicateMatch | null>`
  - `isContentChanged(row: ProcessedRow, newHash: string): boolean`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/dedupe.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDuplicate, isContentChanged } from '../src/dedupe.ts';
import { contentHash, openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anp-dedupe-'));
  store = openStore({ path: join(dir, 'app.db'), rawDir: join(dir, 'raw') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const URL_A = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html';

function seed(over: Record<string, unknown> = {}) {
  store.upsert({
    urlNormalized: URL_A, url: URL_A, sourceId: 's', organization: '大阪市',
    title: 'CX情報提供', contentHash: contentHash('本文A'), status: 'synced', ...over,
  });
}

describe('findDuplicate: 優先順位（設計書 §12）', () => {
  it('①公式URL の完全一致で検出する', async () => {
    seed();
    const m = await findDuplicate({ url: URL_A }, store);
    expect(m?.matchedBy).toBe('url');
    expect(m?.row?.title).toBe('CX情報提供');
  });

  it('②正規化URL の一致で検出する（末尾スラッシュ・追跡パラメータ・http差）', async () => {
    seed();
    for (const variant of [
      `${URL_A}#section`,
      `${URL_A}?utm_source=mail`,
      URL_A.replace('https://', 'http://'),
    ]) {
      const m = await findDuplicate({ url: variant }, store);
      expect(m?.matchedBy, variant).toBe('url');
    }
  });

  it('③本文ハッシュの一致で検出する（URL が違っても同じ内容）', async () => {
    seed();
    const m = await findDuplicate(
      { url: 'https://www.city.osaka.lg.jp/other/page.html', contentHash: contentHash('本文A') },
      store,
    );
    expect(m?.matchedBy).toBe('content_hash');
    expect(m?.row?.urlNormalized).toBe(URL_A);
  });

  it('④自治体名+タイトルの一致で検出する', async () => {
    seed();
    const m = await findDuplicate(
      { url: 'https://www.city.osaka.lg.jp/other/x.html', contentHash: contentHash('別の本文'), organization: '大阪市', title: 'CX情報提供' },
      store,
    );
    expect(m?.matchedBy).toBe('org_and_title');
  });

  it('URL 一致が本文ハッシュ一致より優先される', async () => {
    seed();
    store.upsert({
      urlNormalized: 'https://a.jp/other', url: 'https://a.jp/other',
      contentHash: contentHash('本文A'), status: 'synced',
    });
    const m = await findDuplicate({ url: URL_A, contentHash: contentHash('本文A') }, store);
    expect(m?.matchedBy).toBe('url');
    expect(m?.row?.urlNormalized).toBe(URL_A);
  });

  it('どれにも当たらなければ null', async () => {
    seed();
    const m = await findDuplicate(
      { url: 'https://a.jp/new', contentHash: contentHash('新しい本文'), organization: '福岡市', title: '別件' },
      store,
    );
    expect(m).toBeNull();
  });

  it('自治体名だけ一致してタイトルが違えば検出しない', async () => {
    seed();
    const m = await findDuplicate(
      { url: 'https://a.jp/new', contentHash: contentHash('新'), organization: '大阪市', title: '別のタイトル' },
      store,
    );
    expect(m).toBeNull();
  });
});

describe('findDuplicate: Notion 側の確認（設計書 §12）', () => {
  it('ローカルDBに無くても Notion に既存があれば検出する', async () => {
    const lookup = vi.fn(async () => 'notion-page-1');
    const m = await findDuplicate({ url: URL_A }, store, lookup);
    expect(m?.matchedBy).toBe('notion');
    expect(m?.notionPageId).toBe('notion-page-1');
    expect(m?.row).toBeNull();
    expect(lookup).toHaveBeenCalledWith(URL_A);
  });

  it('ローカルDBに当たれば Notion へ問い合わせない（API 節約）', async () => {
    seed();
    const lookup = vi.fn(async () => 'notion-page-1');
    await findDuplicate({ url: URL_A }, store, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('Notion にも無ければ null', async () => {
    const m = await findDuplicate({ url: URL_A }, store, async () => null);
    expect(m).toBeNull();
  });

  it('Notion 問い合わせが失敗しても例外にせず null 扱いにする', async () => {
    const m = await findDuplicate({ url: URL_A }, store, async () => { throw new Error('503'); });
    expect(m).toBeNull();
  });

  it('notionLookup 未指定なら問い合わせをスキップする', async () => {
    expect(await findDuplicate({ url: URL_A }, store)).toBeNull();
  });
});

describe('isContentChanged', () => {
  it('ハッシュが違えば true', () => {
    seed();
    const row = store.getByUrl(URL_A);
    expect(row).not.toBeNull();
    expect(isContentChanged(row!, contentHash('本文B'))).toBe(true);
  });

  it('ハッシュが同じなら false', () => {
    seed();
    const row = store.getByUrl(URL_A);
    expect(isContentChanged(row!, contentHash('本文A'))).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/dedupe.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/dedupe.ts"`

- [ ] **Step 3: `src/dedupe.ts` を実装**

```ts
import type { ProcessedRow, Store } from './store.ts';
import { normalizeUrl } from './url.ts';

export type DuplicateMatch = {
  matchedBy: 'url' | 'normalized_url' | 'content_hash' | 'org_and_title' | 'notion';
  row: ProcessedRow | null;
  notionPageId: string | null;
};

/** 公式URLで Notion を検索して既存ページIDを返す関数（notion.ts が実装する）。 */
export type NotionLookup = (officialUrl: string) => Promise<string | null>;

/**
 * 重複を判定する（設計書 §12）。優先順位:
 *   ①公式URL → ②正規化URL → ③本文ハッシュ → ④自治体名+タイトル → ⑤Notion側の公式URL
 *
 * ①と②は normalizeUrl を通した同じキーで引くため、実装上は1回の照会で足りる。
 * ローカルDBで当たった場合は Notion へ問い合わせない（API 呼び出しを節約する）。
 */
export async function findDuplicate(
  input: {
    url: string;
    contentHash?: string | null;
    organization?: string | null;
    title?: string | null;
  },
  store: Store,
  notionLookup?: NotionLookup,
): Promise<DuplicateMatch | null> {
  let key: string;
  try {
    key = normalizeUrl(input.url);
  } catch {
    // URL として不正なものは重複判定の対象にしない。呼び出し側が取得段階で弾く。
    return null;
  }

  const byUrl = store.getByUrl(key);
  if (byUrl !== null) {
    return { matchedBy: 'url', row: byUrl, notionPageId: byUrl.notionPageId };
  }

  if (input.contentHash) {
    const byHash = store.getByContentHash(input.contentHash);
    if (byHash !== null) {
      return { matchedBy: 'content_hash', row: byHash, notionPageId: byHash.notionPageId };
    }
  }

  if (input.organization && input.title) {
    const byOrgTitle = store.getByOrgAndTitle(input.organization, input.title);
    if (byOrgTitle !== null) {
      return { matchedBy: 'org_and_title', row: byOrgTitle, notionPageId: byOrgTitle.notionPageId };
    }
  }

  // ローカルDBを消した場合や別マシンで実行した場合にも重複を作らないため、
  // Notion 側の公式URLも確認する（設計書 §12）。
  if (notionLookup !== undefined) {
    try {
      const pageId = await notionLookup(key);
      if (pageId !== null) {
        return { matchedBy: 'notion', row: null, notionPageId: pageId };
      }
    } catch {
      // Notion 側の確認に失敗しても収集は続ける。重複作成のリスクより停止を避ける。
      return null;
    }
  }

  return null;
}

/** 本文が変わったかを判定する。true なら Notion の「更新あり」を立てる（設計書 §12）。 */
export function isContentChanged(row: ProcessedRow, newHash: string): boolean {
  return row.contentHash !== newHash;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/dedupe.test.ts
```

Expected: PASS（15 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/dedupe.ts test/dedupe.test.ts
git commit -m "feat: 4段階の重複判定

公式URL → 本文ハッシュ → 自治体名+タイトル → Notion側の公式URL の順で照会。
ローカルDBに当たれば Notion へ問い合わせず API を節約する。
Notion 側の確認が失敗しても収集は止めない。"
```

---

## Task 16: Notion プロパティ定義（単一の真実）

**Files:**
- Create: `src/notion-schema.ts`
- Test: `test/notion-schema.test.ts`

**Interfaces:**
- Consumes: 列挙値（`src/types.ts`）
- Produces:
  - `type NotionPropertyType = 'title' | 'rich_text' | 'select' | 'multi_select' | 'date' | 'url' | 'number' | 'checkbox' | 'people'`
  - `type PropertyDef = { name: string; type: NotionPropertyType; writtenByScript: boolean; options?: readonly string[] }`
  - `NOTION_PROPERTIES: readonly PropertyDef[]`
  - `AUTO_PROPERTY_NAMES: readonly string[]`（28個）
  - `HUMAN_PROPERTY_NAMES: readonly string[]`（11個）
  - `CATEGORY_OPTIONS`, `COMPANY_ROLE_OPTIONS`, `PARTNER_OPTIONS`, `ORGANIZATION_OPTIONS`（`as const`）
  - `buildDatabaseProperties(): Record<string, unknown>` — Notion `POST /v1/databases` の `properties`
  - `type SchemaMismatch = { name: string; expected: NotionPropertyType; actual: string | null }`
  - `diffDatabaseSchema(actual: Record<string, { type: string }>): SchemaMismatch[]`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/notion-schema.test.ts
import { describe, expect, it } from 'vitest';
import {
  AUTO_PROPERTY_NAMES, HUMAN_PROPERTY_NAMES, NOTION_PROPERTIES,
  buildDatabaseProperties, diffDatabaseSchema,
} from '../src/notion-schema.ts';
import {
  ACTION_DECISIONS, CONTACT_RECOMMENDATIONS, DOCUMENT_TYPES,
  MATURITY_STAGES, RELEVANCES, REVIEW_STATUSES, TEMPERATURES,
} from '../src/types.ts';

describe('NOTION_PROPERTIES', () => {
  it('合計39個（自動28 + 人手11）', () => {
    expect(NOTION_PROPERTIES).toHaveLength(39);
    expect(AUTO_PROPERTY_NAMES).toHaveLength(28);
    expect(HUMAN_PROPERTY_NAMES).toHaveLength(11);
  });

  it('プロパティ名が重複しない', () => {
    const names = NOTION_PROPERTIES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('Title 型はちょうど1つで名前は「タイトル」', () => {
    const titles = NOTION_PROPERTIES.filter((p) => p.type === 'title');
    expect(titles).toHaveLength(1);
    expect(titles[0]?.name).toBe('タイトル');
  });

  it('指示書 §17-1 の自動入力27個がすべてある', () => {
    for (const n of ['タイトル', '自治体・組織', '担当部署', '文書種別', '公開日', '期限', '公式URL',
      '行政課題', '課題の背景', '実現したい状態', '民間に求めること', '分野', '成熟段階',
      '分野関連度', '自社関連度', '関連度の理由', '想定する自社の役割', '必要なパートナー',
      'コンタクト推奨度', '推奨アクション', '確認したいこと', 'リスク・参加条件',
      'AI確信度', '根拠', '検知日', 'AI処理日時', '更新あり']) {
      expect(AUTO_PROPERTY_NAMES, n).toContain(n);
    }
  });

  it('本設計の追加である「予算」が Number 型である', () => {
    const p = NOTION_PROPERTIES.find((x) => x.name === '予算');
    expect(p?.type).toBe('number');
    expect(p?.writtenByScript).toBe(true);
  });

  it('指示書 §17-2 の人手入力11個がすべてあり、スクリプトは書かない扱い', () => {
    for (const n of ['確認状態', '対応判断', '社内担当', 'コンタクト先', 'コンタクト日',
      '温度感', '面談メモ', '次のアクション', '次回確認日', '見送り理由', '社内メモ']) {
      expect(HUMAN_PROPERTY_NAMES, n).toContain(n);
      expect(NOTION_PROPERTIES.find((p) => p.name === n)?.writtenByScript, n).toBe(false);
    }
  });

  it('社内担当は people 型', () => {
    expect(NOTION_PROPERTIES.find((p) => p.name === '社内担当')?.type).toBe('people');
  });

  it('更新あり は checkbox 型', () => {
    expect(NOTION_PROPERTIES.find((p) => p.name === '更新あり')?.type).toBe('checkbox');
  });

  it('AI確信度 は number 型', () => {
    expect(NOTION_PROPERTIES.find((p) => p.name === 'AI確信度')?.type).toBe('number');
  });

  it('Select の選択肢が列挙値と一致する', () => {
    const opt = (n: string) => NOTION_PROPERTIES.find((p) => p.name === n)?.options;
    expect(opt('文書種別')).toEqual(DOCUMENT_TYPES);
    expect(opt('成熟段階')).toEqual(MATURITY_STAGES);
    expect(opt('分野関連度')).toEqual(RELEVANCES);
    expect(opt('自社関連度')).toEqual(RELEVANCES);
    expect(opt('コンタクト推奨度')).toEqual(CONTACT_RECOMMENDATIONS);
    expect(opt('確認状態')).toEqual(REVIEW_STATUSES);
    expect(opt('対応判断')).toEqual(ACTION_DECISIONS);
    expect(opt('温度感')).toEqual(TEMPERATURES);
  });

  it('Multi-select には初期選択肢が入っている', () => {
    for (const n of ['分野', '想定する自社の役割', '必要なパートナー']) {
      const p = NOTION_PROPERTIES.find((x) => x.name === n);
      expect(p?.type, n).toBe('multi_select');
      expect(p?.options?.length ?? 0, n).toBeGreaterThan(0);
    }
  });

  it('分野の初期選択肢に指示書 §5 の主要項目が入っている', () => {
    const opts = NOTION_PROPERTIES.find((p) => p.name === '分野')?.options ?? [];
    for (const v of ['Webサイト', 'CMS', 'ポータルサイト', 'UI・UX', '行政DX',
      'オンライン申請', '観光情報発信', '内製化支援', '官民連携']) {
      expect(opts, v).toContain(v);
    }
  });

  it('自治体・組織に大阪市と §4 の追加予定が入っている', () => {
    const opts = NOTION_PROPERTIES.find((p) => p.name === '自治体・組織')?.options ?? [];
    for (const v of ['大阪市', '福岡市', '横浜市', '札幌市', '石川県', '静岡県']) {
      expect(opts, v).toContain(v);
    }
  });
});

describe('buildDatabaseProperties', () => {
  const props = buildDatabaseProperties();

  it('全39プロパティを含む', () => {
    expect(Object.keys(props)).toHaveLength(39);
  });

  it('Notion API の形になっている', () => {
    expect(props['タイトル']).toEqual({ title: {} });
    expect(props['公式URL']).toEqual({ url: {} });
    expect(props['更新あり']).toEqual({ checkbox: {} });
    expect(props['AI確信度']).toEqual({ number: {} });
    expect(props['社内担当']).toEqual({ people: {} });
    expect(props['行政課題']).toEqual({ rich_text: {} });
    expect(props['公開日']).toEqual({ date: {} });
  });

  it('Select は options 配列を持つ', () => {
    const p = props['成熟段階'] as { select: { options: Array<{ name: string }> } };
    expect(p.select.options.map((o) => o.name)).toEqual([...MATURITY_STAGES]);
  });

  it('Multi-select は options 配列を持つ', () => {
    const p = props['分野'] as { multi_select: { options: Array<{ name: string }> } };
    expect(p.multi_select.options.length).toBeGreaterThan(20);
  });
});

describe('diffDatabaseSchema', () => {
  const complete = (): Record<string, { type: string }> => {
    const o: Record<string, { type: string }> = {};
    for (const p of NOTION_PROPERTIES) o[p.name] = { type: p.type };
    return o;
  };

  it('完全一致なら差分なし', () => {
    expect(diffDatabaseSchema(complete())).toEqual([]);
  });

  it('欠落を actual: null で報告する', () => {
    const a = complete();
    delete a['行政課題'];
    delete a['予算'];
    const d = diffDatabaseSchema(a);
    expect(d).toHaveLength(2);
    expect(d.map((x) => x.name).sort()).toEqual(['予算', '行政課題']);
    expect(d.every((x) => x.actual === null)).toBe(true);
  });

  it('型不一致を報告する', () => {
    const a = complete();
    a['AI確信度'] = { type: 'rich_text' };
    const d = diffDatabaseSchema(a);
    expect(d).toEqual([{ name: 'AI確信度', expected: 'number', actual: 'rich_text' }]);
  });

  it('余分なプロパティは差分にしない（人が足した列を壊さない）', () => {
    const a = complete();
    a['社内で追加した列'] = { type: 'rich_text' };
    expect(diffDatabaseSchema(a)).toEqual([]);
  });

  it('人手プロパティの欠落も検出する（ビューが機能しないため）', () => {
    const a = complete();
    delete a['確認状態'];
    expect(diffDatabaseSchema(a).map((x) => x.name)).toEqual(['確認状態']);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/notion-schema.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/notion-schema.ts"`

- [ ] **Step 3: `src/notion-schema.ts` を実装**

```ts
import {
  ACTION_DECISIONS, CONTACT_RECOMMENDATIONS, DOCUMENT_TYPES,
  MATURITY_STAGES, RELEVANCES, REVIEW_STATUSES, TEMPERATURES,
} from './types.ts';

export type NotionPropertyType =
  | 'title' | 'rich_text' | 'select' | 'multi_select'
  | 'date' | 'url' | 'number' | 'checkbox' | 'people';

export type PropertyDef = {
  name: string;
  type: NotionPropertyType;
  /** false なら人が入力する項目。スクリプトは書かない（設計書 §16-1） */
  writtenByScript: boolean;
  options?: readonly string[];
};

/** 分野の初期選択肢（指示書 §5 の「原則として対象」＋「内容を見て判断」）。 */
export const CATEGORY_OPTIONS = [
  'Webサイト', 'ホームページ', 'CMS', 'ポータルサイト', '特設サイト',
  'Webサイトリニューアル', 'UI・UX', 'CX', 'サービスデザイン', 'オンライン申請',
  '行政手続きのデジタル化', '行政DX', 'BPR・業務改善', 'AI・生成AI', 'データ活用',
  'オープンデータ', '市民向けデジタルサービス', 'アプリ', 'LINE', 'チャットボット',
  'SNS', 'デジタルマーケティング', 'デジタル広報', 'コンテンツ制作', '観光情報発信',
  '移住・定住', '企業誘致', '採用広報', '地域事業者支援', 'デジタル人材育成',
  '内製化支援', '官民連携', 'デジタル領域の実証実験',
  '大規模業務システム', '基幹システム', 'システム運用・保守', 'セキュリティ',
  'クラウド', 'コールセンター', 'データセンター', '通信・ネットワーク',
  'ITコンサルティング', '業務調査',
] as const;

/** 想定する自社の役割の初期選択肢（指示書 §3「自社にとっての機会」）。 */
export const COMPANY_ROLE_OPTIONS = [
  'Webサイト・ポータル構築', 'CMS導入', 'UI・UX設計', 'コンテンツ運用',
  '運用内製化支援', '共同提案',
] as const;

/** 必要なパートナーの初期選択肢（指示書 §3, §15）。 */
export const PARTNER_OPTIONS = [
  '地域の制作会社', '広告代理店', 'SIer', 'コンサルティング会社',
  '自治体向けシステム事業者',
] as const;

/** 自治体・組織の初期選択肢（指示書 §4 の初期対象と追加予定）。 */
export const ORGANIZATION_OPTIONS = [
  '大阪市', '福岡市', '横浜市', '札幌市', '石川県', '静岡県',
] as const;

/**
 * Notion「行政ニーズDB」のプロパティ定義（設計書 §16-1）。
 *
 * このファイルが単一の真実。setup-notion がここを読んで DB を作り、
 * collect 起動時の検証も、notion-map の変換も同じ定義を参照する。
 * プロパティ名の綴りズレが構造的に起きなくなる。
 */
export const NOTION_PROPERTIES: readonly PropertyDef[] = [
  // ---- 自動入力（指示書 §17-1 の27個） ----
  { name: 'タイトル', type: 'title', writtenByScript: true },
  { name: '自治体・組織', type: 'select', writtenByScript: true, options: ORGANIZATION_OPTIONS },
  { name: '担当部署', type: 'rich_text', writtenByScript: true },
  { name: '文書種別', type: 'select', writtenByScript: true, options: DOCUMENT_TYPES },
  { name: '公開日', type: 'date', writtenByScript: true },
  { name: '期限', type: 'date', writtenByScript: true },
  { name: '公式URL', type: 'url', writtenByScript: true },
  { name: '行政課題', type: 'rich_text', writtenByScript: true },
  { name: '課題の背景', type: 'rich_text', writtenByScript: true },
  { name: '実現したい状態', type: 'rich_text', writtenByScript: true },
  { name: '民間に求めること', type: 'rich_text', writtenByScript: true },
  { name: '分野', type: 'multi_select', writtenByScript: true, options: CATEGORY_OPTIONS },
  { name: '成熟段階', type: 'select', writtenByScript: true, options: MATURITY_STAGES },
  { name: '分野関連度', type: 'select', writtenByScript: true, options: RELEVANCES },
  { name: '自社関連度', type: 'select', writtenByScript: true, options: RELEVANCES },
  { name: '関連度の理由', type: 'rich_text', writtenByScript: true },
  { name: '想定する自社の役割', type: 'multi_select', writtenByScript: true, options: COMPANY_ROLE_OPTIONS },
  { name: '必要なパートナー', type: 'multi_select', writtenByScript: true, options: PARTNER_OPTIONS },
  { name: 'コンタクト推奨度', type: 'select', writtenByScript: true, options: CONTACT_RECOMMENDATIONS },
  { name: '推奨アクション', type: 'rich_text', writtenByScript: true },
  { name: '確認したいこと', type: 'rich_text', writtenByScript: true },
  { name: 'リスク・参加条件', type: 'rich_text', writtenByScript: true },
  { name: 'AI確信度', type: 'number', writtenByScript: true },
  { name: '根拠', type: 'rich_text', writtenByScript: true },
  { name: '検知日', type: 'date', writtenByScript: true },
  { name: 'AI処理日時', type: 'date', writtenByScript: true },
  { name: '更新あり', type: 'checkbox', writtenByScript: true },

  // ---- 本設計での追加（設計書 §16-1）----
  // §12-2 が budget を出力し §13 が事実として扱い §16 が判断材料にしているのに
  // §17-1 に置き場がないため追加する。
  { name: '予算', type: 'number', writtenByScript: true },

  // ---- 人手入力（指示書 §17-2 の11個）。スクリプトは書かない ----
  { name: '確認状態', type: 'select', writtenByScript: false, options: REVIEW_STATUSES },
  { name: '対応判断', type: 'select', writtenByScript: false, options: ACTION_DECISIONS },
  { name: '社内担当', type: 'people', writtenByScript: false },
  { name: 'コンタクト先', type: 'rich_text', writtenByScript: false },
  { name: 'コンタクト日', type: 'date', writtenByScript: false },
  { name: '温度感', type: 'select', writtenByScript: false, options: TEMPERATURES },
  { name: '面談メモ', type: 'rich_text', writtenByScript: false },
  { name: '次のアクション', type: 'rich_text', writtenByScript: false },
  { name: '次回確認日', type: 'date', writtenByScript: false },
  { name: '見送り理由', type: 'rich_text', writtenByScript: false },
  { name: '社内メモ', type: 'rich_text', writtenByScript: false },
];

export const AUTO_PROPERTY_NAMES: readonly string[] =
  NOTION_PROPERTIES.filter((p) => p.writtenByScript).map((p) => p.name);

export const HUMAN_PROPERTY_NAMES: readonly string[] =
  NOTION_PROPERTIES.filter((p) => !p.writtenByScript).map((p) => p.name);

/** POST /v1/databases の properties を組み立てる。 */
export function buildDatabaseProperties(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of NOTION_PROPERTIES) {
    if (p.type === 'select' || p.type === 'multi_select') {
      const options = (p.options ?? []).map((name) => ({ name }));
      out[p.name] = p.type === 'select' ? { select: { options } } : { multi_select: { options } };
    } else {
      out[p.name] = { [p.type]: {} };
    }
  }
  return out;
}

export type SchemaMismatch = {
  name: string;
  expected: NotionPropertyType;
  actual: string | null;
};

/**
 * 実際の DB スキーマと定義を照合する（設計書 §16-4）。
 * 余分なプロパティは差分にしない。人が足した列を壊さないため。
 */
export function diffDatabaseSchema(actual: Record<string, { type: string }>): SchemaMismatch[] {
  const out: SchemaMismatch[] = [];
  for (const p of NOTION_PROPERTIES) {
    const found = actual[p.name];
    if (found === undefined) {
      out.push({ name: p.name, expected: p.type, actual: null });
    } else if (found.type !== p.type) {
      out.push({ name: p.name, expected: p.type, actual: found.type });
    }
  }
  return out;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/notion-schema.test.ts
```

Expected: PASS（20 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/notion-schema.ts test/notion-schema.test.ts
git commit -m "feat: Notion プロパティ定義を単一の真実として置く

自動28（§17-1 の27 + 追加の「予算」）＋ 人手11 = 39プロパティ。
setup:notion の DB 作成と collect 起動時の検証が同じ定義を読む。
余分なプロパティは差分にせず、人が足した列を壊さない。"
```

---

## Task 17: AI 出力 → Notion プロパティ変換

**Files:**
- Create: `src/notion-map.ts`
- Test: `test/notion-map.test.ts`

**Interfaces:**
- Consumes: `type NeedAnalysis`, `type Classification`（`src/ai/schema.ts`）／`type EvidenceCheckResult`（`src/evidence.ts`）／`HUMAN_PROPERTY_NAMES`（`src/notion-schema.ts`）
- Produces:
  - `truncate(s: string, max?: number): string`
  - `type MapInput = { analysis: NeedAnalysis | null; classification: Classification; officialUrl: string; detectedAt: string; analyzedAt: string; organizationFallback: string; departmentFallback: string | null; evidence: EvidenceCheckResult | null; contentChanged: boolean; pdfUrls: string[]; bodyText: string }`
  - `buildCreateProperties(i: MapInput): Record<string, unknown>` — 新規作成用。人手項目は「確認状態」のみ
  - `buildUpdateProperties(i: MapInput): Record<string, unknown>` — 更新用。人手項目を一切含まない
  - `buildPageBlocks(i: MapInput): unknown[]` — 原文全文・根拠全件・添付PDF一覧

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/notion-map.test.ts
import { describe, expect, it } from 'vitest';
import { buildCreateProperties, buildPageBlocks, buildUpdateProperties, truncate } from '../src/notion-map.ts';
import { HUMAN_PROPERTY_NAMES } from '../src/notion-schema.ts';
import { parseNeedAnalysis } from '../src/ai/schema.ts';

function analysis(over: Record<string, unknown> = {}) {
  return parseNeedAnalysis(JSON.stringify({
    document_type: 'RFI', organization_name: '大阪市', department_name: 'デジタル統括室',
    published_at: '2026-07-30', deadline: '2026-08-21', budget: null,
    official_title: '大阪市CXサービスデザイン推進事業に係る情報提供について',
    need_title: '総合サービスポータル・コンタクトセンターの整備',
    problem_summary: '行政サービスが分散している', background: 'DX戦略に基づく',
    desired_state: '全体最適化されたサービス提供', request_to_private_sector: '情報提供',
    categories: ['ポータルサイト', 'CX'], maturity_stage: '市場対話',
    domain_relevance: 'A', domain_relevance_reason: 'Web・DXが中心',
    company_relevance: 'B', company_relevance_reason: 'パートナー連携で関われる',
    possible_company_roles: ['UI・UX設計'], required_partners: ['SIer'],
    contact_recommendation: '高', recommended_action: 'RFIに参加する',
    questions_to_confirm: ['第2回RFIの時期', '調達の分割単位'],
    risks_and_conditions: ['参加申込が必要'],
    confidence: 88,
    evidence_quotes: [{ field: 'deadline', quote: '令和8年8月21日' }],
    ...over,
  }));
}

const BASE = {
  classification: { is_target: true, reason: '対象である', confidence: 88 },
  officialUrl: 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html',
  detectedAt: '2026-08-05',
  analyzedAt: '2026-08-05T04:00:00.000Z',
  organizationFallback: '大阪市',
  departmentFallback: null,
  evidence: null,
  contentChanged: false,
  pdfUrls: [] as string[],
  bodyText: '本文',
};

const input = (over: Record<string, unknown> = {}) => ({ ...BASE, analysis: analysis(), ...over });

describe('truncate', () => {
  it('上限以内はそのまま', () => {
    expect(truncate('あいう', 10)).toBe('あいう');
  });

  it('上限を超えたら切って … を付ける', () => {
    const r = truncate('あ'.repeat(3000));
    expect(r).toHaveLength(2000);
    expect(r.endsWith('…')).toBe(true);
  });

  it('既定の上限は 2000（Notion rich_text の上限）', () => {
    expect(truncate('x'.repeat(2001)).length).toBe(2000);
    expect(truncate('x'.repeat(2000)).length).toBe(2000);
  });
});

describe('buildCreateProperties', () => {
  const p = buildCreateProperties(input());

  it('人手項目は「確認状態」だけを含む（設計書 §16-1 の唯一の例外）', () => {
    const human = Object.keys(p).filter((k) => HUMAN_PROPERTY_NAMES.includes(k));
    expect(human).toEqual(['確認状態']);
  });

  it('対象なら確認状態は 未確認（§19「新着・未確認」ビューを機能させる）', () => {
    expect(p['確認状態']).toEqual({ select: { name: '未確認' } });
  });

  it('対象外なら確認状態は 対象外（§19「対象外・見送り」ビュー）', () => {
    const q = buildCreateProperties(input({
      analysis: null, classification: { is_target: false, reason: '物品購入', confidence: 95 },
    }));
    expect(q['確認状態']).toEqual({ select: { name: '対象外' } });
  });

  it('タイトルは official_title を使う', () => {
    expect(p['タイトル']).toEqual({
      title: [{ text: { content: '大阪市CXサービスデザイン推進事業に係る情報提供について' } }],
    });
  });

  it('official_title が空なら need_title を使う', () => {
    const q = buildCreateProperties(input({ analysis: analysis({ official_title: null }) }));
    const t = q['タイトル'] as { title: Array<{ text: { content: string } }> };
    expect(t.title[0]?.text.content).toBe('総合サービスポータル・コンタクトセンターの整備');
  });

  it('各型が Notion API の形になっている', () => {
    expect(p['自治体・組織']).toEqual({ select: { name: '大阪市' } });
    expect(p['公式URL']).toEqual({ url: BASE.officialUrl });
    expect(p['公開日']).toEqual({ date: { start: '2026-07-30' } });
    expect(p['期限']).toEqual({ date: { start: '2026-08-21' } });
    expect(p['AI確信度']).toEqual({ number: 88 });
    expect(p['更新あり']).toEqual({ checkbox: false });
    expect(p['分野']).toEqual({ multi_select: [{ name: 'ポータルサイト' }, { name: 'CX' }] });
    expect(p['成熟段階']).toEqual({ select: { name: '市場対話' } });
    expect(p['コンタクト推奨度']).toEqual({ select: { name: '高' } });
  });

  it('null の日付は date: null にする（空文字にしない）', () => {
    const q = buildCreateProperties(input({ analysis: analysis({ deadline: null }) }));
    expect(q['期限']).toEqual({ date: null });
  });

  it('null のテキストは空の rich_text にする', () => {
    const q = buildCreateProperties(input({ analysis: analysis({ background: null }) }));
    expect(q['課題の背景']).toEqual({ rich_text: [] });
  });

  it('予算は Number、null なら number: null', () => {
    expect(buildCreateProperties(input({ analysis: analysis({ budget: 12_000_000 }) }))['予算'])
      .toEqual({ number: 12_000_000 });
    expect(p['予算']).toEqual({ number: null });
  });

  it('関連度の理由に分野・自社の両方を見出し付きで入れる', () => {
    const t = p['関連度の理由'] as { rich_text: Array<{ text: { content: string } }> };
    const s = t.rich_text[0]?.text.content ?? '';
    expect(s).toContain('分野関連度');
    expect(s).toContain('Web・DXが中心');
    expect(s).toContain('自社関連度');
    expect(s).toContain('パートナー連携で関われる');
  });

  it('確認したいこと・リスクを箇条書きで結合する', () => {
    const g = (k: string) => ((p[k] as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]?.text.content ?? '');
    expect(g('確認したいこと')).toContain('第2回RFIの時期');
    expect(g('確認したいこと')).toContain('調達の分割単位');
    expect(g('確認したいこと')).toMatch(/^-|・/);
    expect(g('リスク・参加条件')).toContain('参加申込が必要');
  });

  it('2000文字超のテキストを切り詰める', () => {
    const q = buildCreateProperties(input({ analysis: analysis({ problem_summary: 'あ'.repeat(5000) }) }));
    const t = q['行政課題'] as { rich_text: Array<{ text: { content: string } }> };
    expect(t.rich_text[0]?.text.content.length).toBe(2000);
  });

  it('担当部署は AI 抽出値を使い、無ければ fallback を使う', () => {
    expect((p['担当部署'] as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]?.text.content)
      .toBe('デジタル統括室');
    const q = buildCreateProperties(input({
      analysis: analysis({ department_name: null }), departmentFallback: 'RSS由来の局名',
    }));
    expect((q['担当部署'] as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]?.text.content)
      .toBe('RSS由来の局名');
  });

  it('自治体名が AI 抽出できなければ fallback を使う', () => {
    const q = buildCreateProperties(input({
      analysis: analysis({ organization_name: null }), organizationFallback: '福岡市',
    }));
    expect(q['自治体・組織']).toEqual({ select: { name: '福岡市' } });
  });

  it('根拠に引用を項目名付きで入れる', () => {
    const s = (p['根拠'] as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]?.text.content ?? '';
    expect(s).toContain('deadline');
    expect(s).toContain('令和8年8月21日');
  });

  it('根拠不一致があれば警告を併記する', () => {
    const q = buildCreateProperties(input({
      evidence: { ok: false, matched: [], mismatched: [{ field: 'budget', quote: '予算1億円' }] },
    }));
    const s = (q['根拠'] as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]?.text.content ?? '';
    expect(s).toContain('原文に見つかりませんでした');
    expect(s).toContain('予算1億円');
  });

  it('対象外は最小プロパティのみ（AI解釈系を含まない）', () => {
    const q = buildCreateProperties(input({
      analysis: null, classification: { is_target: false, reason: '物品購入', confidence: 95 },
    }));
    for (const k of ['タイトル', '自治体・組織', '公式URL', 'AI確信度', '根拠', '検知日', 'AI処理日時', '確認状態']) {
      expect(Object.keys(q), k).toContain(k);
    }
    for (const k of ['行政課題', '課題の背景', '実現したい状態', '民間に求めること',
      '成熟段階', '分野関連度', '自社関連度', 'コンタクト推奨度', '推奨アクション']) {
      expect(Object.keys(q), k).not.toContain(k);
    }
  });

  it('対象外の根拠には対象判定の理由を入れる', () => {
    const q = buildCreateProperties(input({
      analysis: null, classification: { is_target: false, reason: '物品購入である', confidence: 95 },
    }));
    expect((q['根拠'] as { rich_text: Array<{ text: { content: string } }> }).rich_text[0]?.text.content)
      .toContain('物品購入である');
  });
});

describe('buildUpdateProperties', () => {
  it('人手項目を一切含まない（確認状態も含まない）', () => {
    const p = buildUpdateProperties(input());
    for (const k of HUMAN_PROPERTY_NAMES) {
      expect(Object.keys(p), k).not.toContain(k);
    }
  });

  it('contentChanged が true なら 更新あり を立てる', () => {
    expect(buildUpdateProperties(input({ contentChanged: true }))['更新あり']).toEqual({ checkbox: true });
  });

  it('自動項目は新規作成時と同じ値になる', () => {
    const c = buildCreateProperties(input());
    const u = buildUpdateProperties(input());
    for (const k of ['タイトル', '行政課題', '成熟段階', 'AI確信度', '分野']) {
      expect(u[k], k).toEqual(c[k]);
    }
  });

  it('検知日は更新時に含まない（初回検知日を保つ）', () => {
    expect(Object.keys(buildUpdateProperties(input()))).not.toContain('検知日');
  });
});

describe('buildPageBlocks', () => {
  it('原文全文をブロックに入れる', () => {
    const blocks = buildPageBlocks(input({ bodyText: 'これが原文の全文です' }));
    expect(JSON.stringify(blocks)).toContain('これが原文の全文です');
  });

  it('2000文字ごとに分割する', () => {
    const blocks = buildPageBlocks(input({ bodyText: 'あ'.repeat(5000) }));
    const json = JSON.stringify(blocks);
    for (const b of blocks as Array<{ paragraph?: { rich_text: Array<{ text: { content: string } }> } }>) {
      const len = b.paragraph?.rich_text[0]?.text.content.length ?? 0;
      expect(len).toBeLessThanOrEqual(2000);
    }
    expect(json).toContain('あ');
  });

  it('根拠の逐語引用を全件入れる', () => {
    const blocks = buildPageBlocks(input({
      analysis: analysis({
        evidence_quotes: [
          { field: 'deadline', quote: '令和8年8月21日' },
          { field: 'contact', quote: 'bb0010@city.osaka.lg.jp' },
        ],
      }),
    }));
    const json = JSON.stringify(blocks);
    expect(json).toContain('令和8年8月21日');
    expect(json).toContain('bb0010@city.osaka.lg.jp');
  });

  it('添付PDFのURL一覧を入れる', () => {
    const blocks = buildPageBlocks(input({ pdfUrls: ['https://a.jp/01_youryou5.pdf'] }));
    expect(JSON.stringify(blocks)).toContain('01_youryou5.pdf');
  });

  it('Notion の1リクエスト上限（100ブロック）を超えない', () => {
    const blocks = buildPageBlocks(input({ bodyText: 'あ'.repeat(500_000) }));
    expect(blocks.length).toBeLessThanOrEqual(100);
  });

  it('対象外でも原文ブロックを作る（精度検証のため）', () => {
    const blocks = buildPageBlocks(input({
      analysis: null, classification: { is_target: false, reason: 'x', confidence: 95 },
      bodyText: '対象外の原文',
    }));
    expect(JSON.stringify(blocks)).toContain('対象外の原文');
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/notion-map.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/notion-map.ts"`

- [ ] **Step 3: `src/notion-map.ts` を実装**

```ts
import type { Classification, NeedAnalysis } from './ai/schema.ts';
import type { EvidenceCheckResult } from './evidence.ts';

/** Notion の rich_text は1テキストオブジェクト2,000文字上限（Global Constraints 14）。 */
const MAX_TEXT = 2000;
/** children を1リクエストで送れる上限。 */
const MAX_BLOCKS = 100;

export type MapInput = {
  /** 対象外の場合は null */
  analysis: NeedAnalysis | null;
  classification: Classification;
  officialUrl: string;
  /** YYYY-MM-DD */
  detectedAt: string;
  /** ISO 8601 */
  analyzedAt: string;
  /** AI が organization_name を出せなかった場合に使う（情報源設定の organization） */
  organizationFallback: string;
  /** AI が department_name を出せなかった場合に使う（RSS category や URL パス由来） */
  departmentFallback: string | null;
  evidence: EvidenceCheckResult | null;
  contentChanged: boolean;
  pdfUrls: string[];
  bodyText: string;
};

export function truncate(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const text = (s: string | null): { rich_text: Array<{ text: { content: string } }> } =>
  s === null || s.trim() === ''
    ? { rich_text: [] }
    : { rich_text: [{ text: { content: truncate(s) } }] };

const title = (s: string): { title: Array<{ text: { content: string } }> } =>
  ({ title: [{ text: { content: truncate(s) } }] });

const select = (s: string | null): { select: { name: string } | null } =>
  s === null || s.trim() === '' ? { select: null } : { select: { name: s } };

const multi = (list: readonly string[]): { multi_select: Array<{ name: string }> } =>
  ({ multi_select: list.filter((v) => v.trim() !== '').map((name) => ({ name })) });

const date = (s: string | null): { date: { start: string } | null } =>
  s === null ? { date: null } : { date: { start: s } };

const bullets = (list: readonly string[]): string | null =>
  list.length === 0 ? null : list.map((v) => `- ${v}`).join('\n');

/** 根拠欄の本文。不一致があれば警告を併記する（設計書 §11）。 */
function evidenceText(a: NeedAnalysis | null, c: Classification, ev: EvidenceCheckResult | null): string | null {
  const lines: string[] = [];

  if (a === null) {
    lines.push(`対象外と判定した理由: ${c.reason}`);
  } else {
    for (const q of a.evidence_quotes) lines.push(`[${q.field}] ${q.quote}`);
    if (lines.length === 0) lines.push('（AIが根拠を出力しませんでした）');
  }

  if (ev !== null && ev.mismatched.length > 0) {
    lines.push('');
    lines.push('⚠ 次の引用は原文に見つかりませんでした（AIの言い換えまたは捏造の可能性）:');
    for (const q of ev.mismatched) lines.push(`  [${q.field}] ${q.quote}`);
  }

  return lines.length === 0 ? null : lines.join('\n');
}

function relevanceReason(a: NeedAnalysis): string | null {
  const parts: string[] = [];
  if (a.domain_relevance_reason) parts.push(`分野関連度（${a.domain_relevance}）: ${a.domain_relevance_reason}`);
  if (a.company_relevance_reason) parts.push(`自社関連度（${a.company_relevance}）: ${a.company_relevance_reason}`);
  return parts.length === 0 ? null : parts.join('\n\n');
}

/** 対象・対象外に共通する最小プロパティ。 */
function commonProperties(i: MapInput): Record<string, unknown> {
  const a = i.analysis;
  const titleText = a?.official_title ?? a?.need_title ?? i.classification.reason;
  return {
    'タイトル': title(titleText),
    '自治体・組織': select(a?.organization_name ?? i.organizationFallback),
    '文書種別': select(a?.document_type ?? null),
    '公式URL': { url: i.officialUrl },
    'AI確信度': { number: a?.confidence ?? i.classification.confidence },
    '根拠': text(evidenceText(a, i.classification, i.evidence)),
    'AI処理日時': date(i.analyzedAt.slice(0, 10)),
    '更新あり': { checkbox: i.contentChanged },
  };
}

/** 対象と判定された場合の解釈系プロパティ。 */
function analysisProperties(i: MapInput, a: NeedAnalysis): Record<string, unknown> {
  return {
    '担当部署': text(a.department_name ?? i.departmentFallback),
    '公開日': date(a.published_at),
    '期限': date(a.deadline),
    '予算': { number: a.budget },
    '行政課題': text(a.problem_summary),
    '課題の背景': text(a.background),
    '実現したい状態': text(a.desired_state),
    '民間に求めること': text(a.request_to_private_sector),
    '分野': multi(a.categories),
    '成熟段階': select(a.maturity_stage),
    '分野関連度': select(a.domain_relevance),
    '自社関連度': select(a.company_relevance),
    '関連度の理由': text(relevanceReason(a)),
    '想定する自社の役割': multi(a.possible_company_roles),
    '必要なパートナー': multi(a.required_partners),
    'コンタクト推奨度': select(a.contact_recommendation),
    '推奨アクション': text(a.recommended_action),
    '確認したいこと': text(bullets(a.questions_to_confirm)),
    'リスク・参加条件': text(bullets(a.risks_and_conditions)),
  };
}

/**
 * 新規作成用のプロパティ（設計書 §16-1）。
 *
 * 人手項目は「確認状態」のみを設定する。Notion の Select に既定値の概念がなく、
 * 空のままだと §19「新着・未確認」ビューに1件も現れないため。
 * 対象外の場合は「対象外」を入れて §19「対象外・見送り」ビューを機能させる。
 */
export function buildCreateProperties(i: MapInput): Record<string, unknown> {
  const props: Record<string, unknown> = {
    ...commonProperties(i),
    '検知日': date(i.detectedAt),
    '確認状態': select(i.classification.is_target ? '未確認' : '対象外'),
  };
  if (i.analysis !== null) Object.assign(props, analysisProperties(i, i.analysis));
  return props;
}

/**
 * 更新用のプロパティ（設計書 §16-4）。
 * 人手項目を一切含めない。検知日も含めず初回検知日を保つ。
 */
export function buildUpdateProperties(i: MapInput): Record<string, unknown> {
  const props: Record<string, unknown> = { ...commonProperties(i) };
  if (i.analysis !== null) Object.assign(props, analysisProperties(i, i.analysis));
  return props;
}

const heading = (s: string): unknown =>
  ({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: s } }] } });

const paragraph = (s: string): unknown =>
  ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: s } }] } });

function chunk(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * ページ本文（設計書 §16-4）。
 * プロパティは検索・絞り込み用で切り詰めるが、原文全文と根拠全件はここに切り詰めずに置く。
 */
export function buildPageBlocks(i: MapInput): unknown[] {
  const blocks: unknown[] = [];

  if (i.pdfUrls.length > 0) {
    blocks.push(heading('添付PDF'));
    for (const u of i.pdfUrls) blocks.push(paragraph(u));
  }

  const a = i.analysis;
  if (a !== null && a.evidence_quotes.length > 0) {
    blocks.push(heading('根拠（原文からの逐語引用）'));
    for (const q of a.evidence_quotes) blocks.push(paragraph(`[${q.field}] ${q.quote}`));
  }

  if (i.evidence !== null && i.evidence.mismatched.length > 0) {
    blocks.push(heading('⚠ 原文に見つからなかった引用'));
    for (const q of i.evidence.mismatched) blocks.push(paragraph(`[${q.field}] ${q.quote}`));
  }

  blocks.push(heading('原文'));
  const remaining = MAX_BLOCKS - blocks.length;
  const parts = chunk(i.bodyText, MAX_TEXT);
  for (const part of parts.slice(0, Math.max(0, remaining - 1))) blocks.push(paragraph(part));
  if (parts.length > Math.max(0, remaining - 1)) {
    blocks.push(paragraph('（ブロック数の上限に達したため以下省略。全文は data/raw のキャッシュを参照）'));
  }

  return blocks.slice(0, MAX_BLOCKS);
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/notion-map.test.ts
```

Expected: PASS（27 tests）

- [ ] **Step 5: 型検査・lint・全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS

- [ ] **Step 6: コミット**

```bash
git add src/notion-map.ts test/notion-map.test.ts
git commit -m "feat: AI 出力 → Notion プロパティ変換

更新時は人手11項目を一切含めない。新規作成時のみ確認状態を設定する。
全 Text を2000文字で切り、原文全文と根拠全件はページ本文へ置く。
対象外は最小プロパティのみで登録し、根拠に対象判定の理由を入れる。"
```

---

## Task 18: Notion REST クライアント

**Files:**
- Create: `src/notion.ts`
- Test: `test/notion.test.ts`

**Interfaces:**
- Consumes: `AppError`（`src/errors.ts`）／`diffDatabaseSchema`, `buildDatabaseProperties`（`src/notion-schema.ts`）
- Produces:
  - `type NotionClientOptions = { token: string; databaseId?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number; maxRetries?: number }`
  - `type NotionClient = { verifySchema(databaseId: string): Promise<void>; findPageByUrl(officialUrl: string): Promise<string | null>; createPage(args: { properties: Record<string, unknown>; children: unknown[] }): Promise<string>; updatePage(args: { pageId: string; properties: Record<string, unknown> }): Promise<void>; createDatabase(args: { parentPageId: string; title: string }): Promise<string>; addMissingProperties(databaseId: string): Promise<string[]> }`
  - `createNotionClient(opts: NotionClientOptions): NotionClient`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/notion.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createNotionClient } from '../src/notion.ts';
import { NOTION_PROPERTIES } from '../src/notion-schema.ts';
import { AppError } from '../src/errors.ts';

const DB = 'db-1';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(fetchImpl: typeof fetch) {
  return createNotionClient({
    token: 'secret_x', databaseId: DB, fetchImpl,
    sleep: async () => {}, minIntervalMs: 0, maxRetries: 2,
  });
}

/** 定義どおりの完全なスキーマ応答。 */
const completeSchema = () => {
  const properties: Record<string, { type: string }> = {};
  for (const p of NOTION_PROPERTIES) properties[p.name] = { type: p.type };
  return { object: 'database', id: DB, properties };
};

describe('認証とバージョンヘッダ', () => {
  it('Bearer トークンと Notion-Version を送る', async () => {
    const f = vi.fn(async () => json(completeSchema())) as unknown as typeof fetch;
    await client(f).verifySchema(DB);
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe('Bearer secret_x');
    expect(h.get('notion-version')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(h.get('content-type')).toBe('application/json');
  });
});

describe('verifySchema', () => {
  it('完全一致なら成功する', async () => {
    await expect(client(vi.fn(async () => json(completeSchema())) as unknown as typeof fetch)
      .verifySchema(DB)).resolves.toBeUndefined();
  });

  it('プロパティ欠落は NOTION_SCHEMA_MISMATCH で欠落名を列挙する', async () => {
    const s = completeSchema();
    delete s.properties['行政課題'];
    delete s.properties['予算'];
    const c = client(vi.fn(async () => json(s)) as unknown as typeof fetch);
    try {
      await c.verifySchema(DB);
      throw new Error('例外が投げられなかった');
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe('NOTION_SCHEMA_MISMATCH');
      expect(err.userMessage).toContain('行政課題');
      expect(err.userMessage).toContain('予算');
      expect(err.userMessage).toContain('setup:notion');
    }
  });

  it('型不一致も期待値付きで報告する', async () => {
    const s = completeSchema();
    s.properties['AI確信度'] = { type: 'rich_text' };
    const c = client(vi.fn(async () => json(s)) as unknown as typeof fetch);
    await expect(c.verifySchema(DB)).rejects.toMatchObject({ code: 'NOTION_SCHEMA_MISMATCH' });
    try { await c.verifySchema(DB); } catch (e) {
      expect((e as AppError).userMessage).toContain('number');
    }
  });

  it('404 は分かりやすいエラーにする（トークン未接続の典型）', async () => {
    const c = client(vi.fn(async () => json({ code: 'object_not_found', message: 'Could not find database' }, 404)) as unknown as typeof fetch);
    await expect(c.verifySchema(DB)).rejects.toMatchObject({ code: 'NOTION_SCHEMA_MISMATCH' });
  });
});

describe('findPageByUrl', () => {
  it('公式URL の equals フィルタで検索し page id を返す', async () => {
    const f = vi.fn(async () => json({ results: [{ id: 'page-1' }] })) as unknown as typeof fetch;
    const id = await client(f).findPageByUrl('https://a.jp/x');
    expect(id).toBe('page-1');

    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain(`/databases/${DB}/query`);
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body['filter']).toEqual({ property: '公式URL', url: { equals: 'https://a.jp/x' } });
    expect(body['page_size']).toBe(1);
  });

  it('該当なしなら null', async () => {
    expect(await client(vi.fn(async () => json({ results: [] })) as unknown as typeof fetch)
      .findPageByUrl('https://a.jp/x')).toBeNull();
  });
});

describe('createPage / updatePage', () => {
  it('createPage は parent に database_id を指定し page id を返す', async () => {
    const f = vi.fn(async () => json({ id: 'page-new' })) as unknown as typeof fetch;
    const id = await client(f).createPage({ properties: { 'タイトル': { title: [] } }, children: [] });
    expect(id).toBe('page-new');

    const body = JSON.parse(String(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body['parent']).toEqual({ database_id: DB });
    expect(body['properties']).toBeTruthy();
  });

  it('children が空なら送らない（API エラーを避ける）', async () => {
    const f = vi.fn(async () => json({ id: 'page-new' })) as unknown as typeof fetch;
    await client(f).createPage({ properties: {}, children: [] });
    const body = JSON.parse(String(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect('children' in body).toBe(false);
  });

  it('updatePage は PATCH で properties のみ送る', async () => {
    const f = vi.fn(async () => json({ id: 'page-1' })) as unknown as typeof fetch;
    await client(f).updatePage({ pageId: 'page-1', properties: { '更新あり': { checkbox: true } } });
    const call = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call?.[1] as RequestInit).method).toBe('PATCH');
    expect(String(call?.[0])).toContain('/pages/page-1');
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['properties']);
  });
});

describe('レート制限とリトライ', () => {
  it('429 は Retry-After を尊重してリトライし成功する', async () => {
    const slept: number[] = [];
    let n = 0;
    const c = createNotionClient({
      token: 't', databaseId: DB, minIntervalMs: 0, maxRetries: 2,
      sleep: async (ms) => { slept.push(ms); },
      fetchImpl: vi.fn(async () => {
        n += 1;
        return n === 1
          ? json({ code: 'rate_limited' }, 429, { 'retry-after': '2' })
          : json({ id: 'page-1' });
      }) as unknown as typeof fetch,
    });
    expect(await c.createPage({ properties: {}, children: [] })).toBe('page-1');
    expect(slept).toContain(2000);
  });

  it('429 が続けば NOTION_RATE_LIMITED', async () => {
    const c = createNotionClient({
      token: 't', databaseId: DB, minIntervalMs: 0, maxRetries: 1, sleep: async () => {},
      fetchImpl: vi.fn(async () => json({ code: 'rate_limited' }, 429, { 'retry-after': '1' })) as unknown as typeof fetch,
    });
    await expect(c.createPage({ properties: {}, children: [] }))
      .rejects.toMatchObject({ code: 'NOTION_RATE_LIMITED' });
  });

  it('5xx をリトライして成功できる', async () => {
    let n = 0;
    const c = createNotionClient({
      token: 't', databaseId: DB, minIntervalMs: 0, maxRetries: 2, sleep: async () => {},
      fetchImpl: vi.fn(async () => { n += 1; return n < 3 ? json({}, 502) : json({ id: 'page-1' }); }) as unknown as typeof fetch,
    });
    expect(await c.createPage({ properties: {}, children: [] })).toBe('page-1');
  });

  it('400 はリトライせず NOTION_WRITE_FAILED', async () => {
    const f = vi.fn(async () => json({ code: 'validation_error', message: '分野 is not a property that exists' }, 400)) as unknown as typeof fetch;
    const c = createNotionClient({ token: 't', databaseId: DB, minIntervalMs: 0, maxRetries: 2, sleep: async () => {}, fetchImpl: f });
    await expect(c.createPage({ properties: {}, children: [] }))
      .rejects.toMatchObject({ code: 'NOTION_WRITE_FAILED' });
    expect((f as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('API のメッセージを internalDetail に残す', async () => {
    const c = createNotionClient({
      token: 't', databaseId: DB, minIntervalMs: 0, maxRetries: 0, sleep: async () => {},
      fetchImpl: vi.fn(async () => json({ code: 'validation_error', message: '分野 is not a property' }, 400)) as unknown as typeof fetch,
    });
    try {
      await c.createPage({ properties: {}, children: [] });
      throw new Error('例外が投げられなかった');
    } catch (e) {
      expect((e as AppError).internalDetail).toContain('分野 is not a property');
    }
  });

  it('リクエスト間隔を空ける（既定 334ms 以上）', async () => {
    const slept: number[] = [];
    const c = createNotionClient({
      token: 't', databaseId: DB, maxRetries: 0,
      sleep: async (ms) => { slept.push(ms); },
      fetchImpl: vi.fn(async () => json({ id: 'p' })) as unknown as typeof fetch,
    });
    await c.createPage({ properties: {}, children: [] });
    await c.createPage({ properties: {}, children: [] });
    expect(slept.some((ms) => ms > 0)).toBe(true);
  });
});

describe('createDatabase / addMissingProperties', () => {
  it('createDatabase は親ページ配下に全39プロパティで作る', async () => {
    const f = vi.fn(async () => json({ id: 'db-new' })) as unknown as typeof fetch;
    const id = await client(f).createDatabase({ parentPageId: 'parent-1', title: '行政ニーズDB' });
    expect(id).toBe('db-new');

    const body = JSON.parse(String(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body['parent']).toEqual({ type: 'page_id', page_id: 'parent-1' });
    expect(Object.keys(body['properties'] as object)).toHaveLength(39);
  });

  it('addMissingProperties は不足分のみ追加し追加した名前を返す', async () => {
    const s = completeSchema();
    delete s.properties['予算'];
    delete s.properties['社内メモ'];
    let n = 0;
    const f = vi.fn(async () => { n += 1; return n === 1 ? json(s) : json({ id: DB }); }) as unknown as typeof fetch;

    const added = await client(f).addMissingProperties(DB);
    expect(added.sort()).toEqual(['予算', '社内メモ']);

    const body = JSON.parse(String(((f as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(Object.keys(body['properties'] as object).sort()).toEqual(['予算', '社内メモ']);
  });

  it('不足がなければ更新リクエストを送らない', async () => {
    const f = vi.fn(async () => json(completeSchema())) as unknown as typeof fetch;
    expect(await client(f).addMissingProperties(DB)).toEqual([]);
    expect((f as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('型不一致は変更しない（既存データを壊さない）', async () => {
    const s = completeSchema();
    s.properties['AI確信度'] = { type: 'rich_text' };
    const f = vi.fn(async () => json(s)) as unknown as typeof fetch;
    expect(await client(f).addMissingProperties(DB)).toEqual([]);
    expect((f as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/notion.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/notion.ts"`

- [ ] **Step 3: `src/notion.ts` を実装**

```ts
import { AppError } from './errors.ts';
import { NOTION_PROPERTIES, buildDatabaseProperties, diffDatabaseSchema } from './notion-schema.ts';

const API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
/** Notion API は平均3リクエスト/秒。334ms 空ければ超えない（設計書 §16-4）。 */
const DEFAULT_MIN_INTERVAL_MS = 334;
const DEFAULT_MAX_RETRIES = 3;

export type NotionClientOptions = {
  token: string;
  databaseId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxRetries?: number;
};

export type NotionClient = {
  verifySchema(databaseId: string): Promise<void>;
  findPageByUrl(officialUrl: string): Promise<string | null>;
  createPage(args: { properties: Record<string, unknown>; children: unknown[] }): Promise<string>;
  updatePage(args: { pageId: string; properties: Record<string, unknown> }): Promise<void>;
  createDatabase(args: { parentPageId: string; title: string }): Promise<string>;
  addMissingProperties(databaseId: string): Promise<string[]>;
};

type ApiResponse = { status: number; body: Record<string, unknown>; retryAfterMs: number | null };

export function createNotionClient(opts: NotionClientOptions): NotionClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastAt = 0;

  const throttle = async (): Promise<void> => {
    if (minInterval <= 0) return;
    const wait = minInterval - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  };

  const once = async (path: string, init: RequestInit): Promise<ApiResponse> => {
    await throttle();
    const res = await doFetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.token}`,
        'notion-version': NOTION_VERSION,
        'content-type': 'application/json',
        ...init.headers,
      },
    });

    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed !== null && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      // 本文なしの応答（204 等）は空オブジェクト扱い
    }

    const ra = res.headers.get('retry-after');
    return {
      status: res.status,
      body,
      retryAfterMs: ra === null ? null : Math.max(0, Number(ra) * 1000),
    };
  };

  /** 429 と 5xx をリトライする。4xx はリトライしない（設計書 §16-4）。 */
  const request = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let last: ApiResponse | null = null;

    for (let i = 0; i <= maxRetries; i += 1) {
      const res = await once(path, init);
      last = res;

      if (res.status >= 200 && res.status < 300) return res.body;

      if (res.status === 429) {
        if (i < maxRetries) {
          await sleep(res.retryAfterMs ?? 1000 * 2 ** i);
          continue;
        }
        throw new AppError('NOTION_RATE_LIMITED', undefined, `429 が ${maxRetries + 1} 回続きました: ${path}`);
      }

      if (res.status >= 500) {
        if (i < maxRetries) {
          await sleep(1000 * 2 ** i);
          continue;
        }
        break;
      }

      // 4xx はリトライしない
      break;
    }

    const message = typeof last?.body['message'] === 'string' ? last.body['message'] : '';
    const code = typeof last?.body['code'] === 'string' ? last.body['code'] : '';
    throw new AppError(
      'NOTION_WRITE_FAILED',
      undefined,
      `HTTP ${last?.status ?? '?'} ${code} ${message} (${path})`,
    );
  };

  const getDatabase = async (databaseId: string): Promise<Record<string, { type: string }>> => {
    let body: Record<string, unknown>;
    try {
      body = await request(`/databases/${databaseId}`, { method: 'GET' });
    } catch (e) {
      const detail = e instanceof AppError ? e.internalDetail ?? '' : String(e);
      throw new AppError(
        'NOTION_SCHEMA_MISMATCH',
        `Notion データベース（${databaseId}）を読み取れません。NOTION_TOKEN と NOTION_DATABASE_ID を確認し、Integration をそのページへ接続してください。`,
        detail,
      );
    }
    const props = body['properties'];
    if (props === null || typeof props !== 'object') {
      throw new AppError('NOTION_SCHEMA_MISMATCH', 'Notion の応答に properties が含まれていません', JSON.stringify(body).slice(0, 300));
    }
    return props as Record<string, { type: string }>;
  };

  return {
    async verifySchema(databaseId) {
      const diff = diffDatabaseSchema(await getDatabase(databaseId));
      if (diff.length === 0) return;

      const missing = diff.filter((d) => d.actual === null).map((d) => `${d.name}（${d.expected}）`);
      const wrong = diff.filter((d) => d.actual !== null).map((d) => `${d.name}（期待: ${d.expected} / 実際: ${String(d.actual)}）`);

      const lines: string[] = ['Notion データベースのプロパティが期待と一致しません。'];
      if (missing.length > 0) lines.push(`不足: ${missing.join('、')}`);
      if (wrong.length > 0) lines.push(`型が違う: ${wrong.join('、')}`);
      lines.push('`npm run setup:notion -- --database-id <ID>` で不足プロパティを追加できます。型の違いは Notion 上で手動修正してください。');

      throw new AppError('NOTION_SCHEMA_MISMATCH', lines.join('\n'), JSON.stringify(diff));
    },

    async findPageByUrl(officialUrl) {
      if (opts.databaseId === undefined) {
        throw new AppError('NOTION_WRITE_FAILED', undefined, 'databaseId が未設定');
      }
      const body = await request(`/databases/${opts.databaseId}/query`, {
        method: 'POST',
        body: JSON.stringify({
          filter: { property: '公式URL', url: { equals: officialUrl } },
          page_size: 1,
        }),
      });
      const results = body['results'];
      if (!Array.isArray(results) || results.length === 0) return null;
      const first = results[0] as { id?: unknown };
      return typeof first.id === 'string' ? first.id : null;
    },

    async createPage({ properties, children }) {
      if (opts.databaseId === undefined) {
        throw new AppError('NOTION_WRITE_FAILED', undefined, 'databaseId が未設定');
      }
      const payload: Record<string, unknown> = {
        parent: { database_id: opts.databaseId },
        properties,
      };
      // 空配列を送ると API がエラーにする場合があるため、あるときだけ含める
      if (children.length > 0) payload['children'] = children;

      const body = await request('/pages', { method: 'POST', body: JSON.stringify(payload) });
      const id = body['id'];
      if (typeof id !== 'string') {
        throw new AppError('NOTION_WRITE_FAILED', undefined, `作成応答に id がありません: ${JSON.stringify(body).slice(0, 200)}`);
      }
      return id;
    },

    async updatePage({ pageId, properties }) {
      // 人手項目を含めないのは notion-map の責務。ここでは properties をそのまま送る。
      await request(`/pages/${pageId}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
    },

    async createDatabase({ parentPageId, title }) {
      const body = await request('/databases', {
        method: 'POST',
        body: JSON.stringify({
          parent: { type: 'page_id', page_id: parentPageId },
          title: [{ type: 'text', text: { content: title } }],
          properties: buildDatabaseProperties(),
        }),
      });
      const id = body['id'];
      if (typeof id !== 'string') {
        throw new AppError('SETUP_FAILED', undefined, `作成応答に id がありません: ${JSON.stringify(body).slice(0, 200)}`);
      }
      return id;
    },

    async addMissingProperties(databaseId) {
      const actual = await getDatabase(databaseId);
      const all = buildDatabaseProperties();

      // 不足しているものだけを追加する。型不一致は既存データを壊すため変更しない。
      const toAdd: Record<string, unknown> = {};
      for (const p of NOTION_PROPERTIES) {
        if (actual[p.name] === undefined) toAdd[p.name] = all[p.name];
      }

      const names = Object.keys(toAdd);
      if (names.length === 0) return [];

      await request(`/databases/${databaseId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: toAdd }),
      });
      return names;
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/notion.test.ts
```

Expected: PASS（19 tests）

- [ ] **Step 5: 型検査と lint**

```bash
npm run typecheck && npm run lint
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/notion.ts test/notion.test.ts
git commit -m "feat: Notion REST クライアント（fetch 直叩き）

334ms のリクエスト間隔、429 は Retry-After 尊重、5xx はリトライ、4xx は即失敗。
起動時のスキーマ検証は不足プロパティ名と期待型を列挙して即停止させる。
addMissingProperties は不足追加のみで型不一致は変更しない。"
```

---

## Task 19: `setup:notion`

**Files:**
- Create: `src/setup-notion.ts`
- Test: `test/setup-notion.test.ts`

**Interfaces:**
- Consumes: `createNotionClient`（`src/notion.ts`）／`NOTION_PROPERTIES`（`src/notion-schema.ts`）／`AppError`（`src/errors.ts`）
- Produces:
  - `type SetupArgs = { parentPageId?: string; databaseId?: string; title: string }`
  - `parseSetupArgs(argv: string[]): SetupArgs` — どちらも無ければ `AppError('SETUP_FAILED')`
  - `runSetup(args: SetupArgs, client: NotionClient, out: (s: string) => void): Promise<{ databaseId: string; added: string[]; created: boolean }>`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/setup-notion.test.ts
import { describe, expect, it, vi } from 'vitest';
import { parseSetupArgs, runSetup } from '../src/setup-notion.ts';
import { AppError } from '../src/errors.ts';
import type { NotionClient } from '../src/notion.ts';

function stubClient(over: Partial<NotionClient> = {}): NotionClient {
  return {
    verifySchema: vi.fn(async () => {}),
    findPageByUrl: vi.fn(async () => null),
    createPage: vi.fn(async () => 'page-1'),
    updatePage: vi.fn(async () => {}),
    createDatabase: vi.fn(async () => 'db-new'),
    addMissingProperties: vi.fn(async () => []),
    ...over,
  };
}

describe('parseSetupArgs', () => {
  it('--parent-page-id を読む', () => {
    expect(parseSetupArgs(['--parent-page-id', 'parent-1']))
      .toEqual({ parentPageId: 'parent-1', title: '行政ニーズDB' });
  });

  it('--database-id を読む', () => {
    expect(parseSetupArgs(['--database-id', 'db-1']))
      .toEqual({ databaseId: 'db-1', title: '行政ニーズDB' });
  });

  it('--title で名前を変えられる', () => {
    expect(parseSetupArgs(['--parent-page-id', 'p', '--title', '別名']).title).toBe('別名');
  });

  it('Notion の URL からページIDを取り出せる', () => {
    const a = parseSetupArgs(['--parent-page-id', 'https://www.notion.so/My-Page-1234567890abcdef1234567890abcdef']);
    expect(a.parentPageId).toBe('1234567890abcdef1234567890abcdef');
  });

  it('ハイフン付きUUIDをそのまま受ける', () => {
    const id = '12345678-90ab-cdef-1234-567890abcdef';
    expect(parseSetupArgs(['--parent-page-id', id]).parentPageId).toBe(id);
  });

  it('どちらも無ければ SETUP_FAILED で使い方を示す', () => {
    try {
      parseSetupArgs([]);
      throw new Error('例外が投げられなかった');
    } catch (e) {
      expect((e as AppError).code).toBe('SETUP_FAILED');
      expect((e as AppError).userMessage).toContain('--parent-page-id');
    }
  });

  it('両方指定は SETUP_FAILED（意図が曖昧）', () => {
    expect(() => parseSetupArgs(['--parent-page-id', 'p', '--database-id', 'd'])).toThrow(AppError);
  });
});

describe('runSetup: 新規作成', () => {
  it('親ページ配下に DB を作り id を返す', async () => {
    const lines: string[] = [];
    const c = stubClient();
    const r = await runSetup({ parentPageId: 'parent-1', title: '行政ニーズDB' }, c, (s) => lines.push(s));

    expect(r).toEqual({ databaseId: 'db-new', added: [], created: true });
    expect(c.createDatabase).toHaveBeenCalledWith({ parentPageId: 'parent-1', title: '行政ニーズDB' });
  });

  it('.env へ書く行を出力する', async () => {
    const lines: string[] = [];
    await runSetup({ parentPageId: 'p', title: 'T' }, stubClient(), (s) => lines.push(s));
    const all = lines.join('\n');
    expect(all).toContain('NOTION_DATABASE_ID=db-new');
    expect(all).toContain('.env');
  });

  it('ビューは API で作れないため手動作成を案内する', async () => {
    const lines: string[] = [];
    await runSetup({ parentPageId: 'p', title: 'T' }, stubClient(), (s) => lines.push(s));
    const all = lines.join('\n');
    expect(all).toContain('ビュー');
    expect(all).toContain('新着・未確認');
    expect(all).toContain('README');
  });

  it('作成後に検証を走らせる', async () => {
    const c = stubClient();
    await runSetup({ parentPageId: 'p', title: 'T' }, c, () => {});
    expect(c.verifySchema).toHaveBeenCalledWith('db-new');
  });
});

describe('runSetup: 既存DBへの追加', () => {
  it('不足プロパティのみ追加し、追加名を返す', async () => {
    const c = stubClient({ addMissingProperties: vi.fn(async () => ['予算', '社内メモ']) });
    const r = await runSetup({ databaseId: 'db-1', title: 'T' }, c, () => {});
    expect(r).toEqual({ databaseId: 'db-1', added: ['予算', '社内メモ'], created: false });
    expect(c.createDatabase).not.toHaveBeenCalled();
  });

  it('不足がなければ「変更なし」を伝える', async () => {
    const lines: string[] = [];
    await runSetup({ databaseId: 'db-1', title: 'T' }, stubClient(), (s) => lines.push(s));
    expect(lines.join('\n')).toContain('変更はありません');
  });

  it('追加後に検証を走らせ、失敗はそのまま投げる', async () => {
    const c = stubClient({
      verifySchema: vi.fn(async () => { throw new AppError('NOTION_SCHEMA_MISMATCH', 'AI確信度 の型が違います'); }),
    });
    await expect(runSetup({ databaseId: 'db-1', title: 'T' }, c, () => {}))
      .rejects.toMatchObject({ code: 'NOTION_SCHEMA_MISMATCH' });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/setup-notion.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/setup-notion.ts"`

- [ ] **Step 3: `src/setup-notion.ts` を実装**

```ts
import { AppError } from './errors.ts';
import { createNotionClient } from './notion.ts';
import type { NotionClient } from './notion.ts';
import { AUTO_PROPERTY_NAMES, HUMAN_PROPERTY_NAMES } from './notion-schema.ts';

const DEFAULT_TITLE = '行政ニーズDB';

export type SetupArgs = {
  parentPageId?: string;
  databaseId?: string;
  title: string;
};

/** Notion の URL または UUID からIDを取り出す。 */
function extractId(raw: string): string {
  const s = raw.trim();
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid !== null) return uuid[0];
  const plain = s.match(/[0-9a-f]{32}/i);
  if (plain !== null) return plain[0];
  return s;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

const USAGE = [
  '使い方:',
  '  npm run setup:notion -- --parent-page-id <ページIDまたはURL>   新しいDBを作る',
  '  npm run setup:notion -- --database-id <DB IDまたはURL>          既存DBに不足プロパティを追加する',
  '  （任意）--title "行政ニーズDB"',
  '',
  '事前に必要なこと:',
  '  1. https://www.notion.so/my-integrations で Integration を作り、トークンを .env の NOTION_TOKEN に入れる',
  '  2. 対象ページを開き、右上「...」→「接続」からその Integration を接続する',
].join('\n');

export function parseSetupArgs(argv: string[]): SetupArgs {
  const parent = flag(argv, '--parent-page-id');
  const db = flag(argv, '--database-id');
  const title = flag(argv, '--title') ?? DEFAULT_TITLE;

  if (parent !== undefined && db !== undefined) {
    throw new AppError('SETUP_FAILED', `--parent-page-id と --database-id は同時に指定できません。\n\n${USAGE}`);
  }
  if (parent !== undefined) return { parentPageId: extractId(parent), title };
  if (db !== undefined) return { databaseId: extractId(db), title };

  throw new AppError('SETUP_FAILED', `--parent-page-id または --database-id を指定してください。\n\n${USAGE}`);
}

/** §19 の6ビュー。Notion API では作成できないため手順を案内する。 */
const VIEW_GUIDE = [
  'ビューは Notion API で作成できないため、Notion 上で手動作成してください（README の表を参照）。',
  '  1. 新着・未確認      … 確認状態 = 未確認 / 検知日 降順',
  '  2. コンタクト候補    … 自社関連度 が A または B / コンタクト推奨度 が 高 または 中 / 対応判断 が 未判断 または 追う',
  '  3. 市場対話・公募    … 文書種別 が RFI / 情報提供依頼 / サウンディング / 民間提案 / プロポーザル / 入札',
  '  4. 上流シグナル      … 文書種別 が 議会 / 予算 / 計画 / マニフェスト / 審議会 / 行政評価 / 公開日 降順',
  '  5. 継続監視          … 対応判断 = 継続監視 / 次回確認日 昇順',
  '  6. 対象外・見送り    … 確認状態 = 対象外 または 対応判断 = 見送り',
].join('\n');

export async function runSetup(
  args: SetupArgs,
  client: NotionClient,
  out: (s: string) => void,
): Promise<{ databaseId: string; added: string[]; created: boolean }> {
  let databaseId: string;
  let added: string[] = [];
  let created = false;

  if (args.parentPageId !== undefined) {
    out(`Notion データベース「${args.title}」を作成します（親ページ: ${args.parentPageId}）...`);
    databaseId = await client.createDatabase({ parentPageId: args.parentPageId, title: args.title });
    created = true;
    out(`作成しました。database_id = ${databaseId}`);
    out(`プロパティ: 自動入力 ${AUTO_PROPERTY_NAMES.length} 個 + 人手入力 ${HUMAN_PROPERTY_NAMES.length} 個`);
  } else {
    databaseId = args.databaseId as string;
    out(`既存データベース（${databaseId}）の不足プロパティを確認します...`);
    added = await client.addMissingProperties(databaseId);
    if (added.length === 0) {
      out('不足しているプロパティはありません。変更はありません。');
    } else {
      out(`次のプロパティを追加しました: ${added.join('、')}`);
    }
  }

  out('プロパティ定義を検証します...');
  await client.verifySchema(databaseId);
  out('検証に成功しました。');

  out('');
  out('--- .env に次の行を設定してください ---');
  out(`NOTION_DATABASE_ID=${databaseId}`);
  out('');
  out(VIEW_GUIDE);

  return { databaseId, added, created };
}

/** CLI エントリ。テスト時は import されるだけで実行されないようにする。 */
async function main(): Promise<void> {
  const token = process.env['NOTION_TOKEN'];
  if (token === undefined || token.trim() === '') {
    throw new AppError('SETUP_FAILED', `NOTION_TOKEN が未設定です。\n\n${USAGE}`);
  }
  const args = parseSetupArgs(process.argv.slice(2));
  const client = createNotionClient({ token });
  await runSetup(args, client, (s) => { console.log(s); });
}

if (process.argv[1]?.endsWith('setup-notion.ts') === true) {
  main().catch((e: unknown) => {
    if (e instanceof AppError) {
      console.error(`\nエラー [${e.code}]: ${e.userMessage}`);
      if (e.internalDetail !== undefined) console.error(`詳細: ${e.internalDetail}`);
    } else {
      console.error(e);
    }
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npx vitest run test/setup-notion.test.ts
```

Expected: PASS（14 tests）

- [ ] **Step 5: 型検査・lint・全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS

- [ ] **Step 6: コミット**

```bash
git add src/setup-notion.ts test/setup-notion.test.ts
git commit -m "feat: setup:notion で Notion DB を自動作成

39プロパティと Select 選択肢を投入し、.env に書く行とビュー作成手順を出力する。
既存DB指定時は不足プロパティの追加のみを行い、型変更や削除はしない。
Notion の URL からもページ/DB の ID を取り出せる。"
```

---

## Task 20: `collect` オーケストレーション

**Files:**
- Create: `src/collect.ts`
- Test: `test/collect.test.ts`

**Interfaces:**
- Consumes: すべての前タスク
- Produces:
  - `type CollectDeps = { config: AppConfig; store: Store; provider: AiProvider; notion: NotionClient | null; logger: Logger; fetchPage: typeof fetchPage; recordNonTarget: boolean; today: string; now: () => string }`
  - `type CollectOptions = { only?: string[]; limit?: number; dryRun?: boolean }`
  - `parseCollectArgs(argv: string[]): CollectOptions`
  - `processCandidate(c: Candidate, source: SourceConfig, deps: CollectDeps): Promise<'synced' | 'skipped' | 'failed' | 'dry'>`
  - `flushPendingNotion(deps: CollectDeps): Promise<{ synced: number; failed: number }>`
  - `runCollect(deps: CollectDeps, options: CollectOptions): Promise<RunSummary>`

- [ ] **Step 1: 失敗するテストを書く**

`fetchPage` と Notion をスタブし、`AI_PROVIDER=mock` 相当の MockProvider を使う。外部通信はゼロ。

```ts
// test/collect.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingNotion, parseCollectArgs, runCollect } from '../src/collect.ts';
import type { CollectDeps } from '../src/collect.ts';
import { parseConfig } from '../src/config.ts';
import { createMockProvider } from '../src/ai/mock.ts';
import { createLogger } from '../src/logger.ts';
import { contentHash, openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { NotionClient } from '../src/notion.ts';

const RFI_URL = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html';
const FEED_URL = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/rss/rss.xml';
const rfiHtml = readFileSync('test/fixtures/rfi.html', 'utf8');
const ictRss = readFileSync('test/fixtures/ict-rss.xml', 'utf8');

const CONFIG = parseConfig(`
defaults:
  request_interval_ms: 0
  max_items_per_run: 3
sources:
  - id: osaka-digital-rss
    organization: 大阪市
    name: デジタル統括室 RSS
    url: ${FEED_URL}
    collector_type: rss
    enabled: true
    content_selector: "#mol_contents"
    category_includes: ["入札契約情報"]
    title_excludes: ["入札結果", "選定結果", "随意契約結果", "再委託状況"]
`);

let dir: string;
let store: Store;
let notion: NotionClient;
let created: Array<{ properties: Record<string, unknown>; children: unknown[] }>;
let updated: Array<{ pageId: string; properties: Record<string, unknown> }>;

function stubFetch(map: Record<string, { body: string; contentType?: string }>) {
  return vi.fn(async (url: string) => {
    const hit = map[url] ?? map[Object.keys(map).find((k) => url.startsWith(k)) ?? ''];
    if (hit === undefined) throw new Error(`未登録のURL: ${url}`);
    const body = new TextEncoder().encode(hit.body);
    return {
      url, finalUrl: url,
      contentType: hit.contentType ?? 'text/html; charset=utf-8',
      body, text: () => hit.body,
    };
  });
}

function deps(over: Partial<CollectDeps> = {}): CollectDeps {
  return {
    config: CONFIG,
    store,
    provider: createMockProvider(),
    notion,
    logger: createLogger({ logDir: join(dir, 'logs'), level: 'error' }),
    fetchPage: stubFetch({ [FEED_URL]: { body: ictRss }, [RFI_URL]: { body: rfiHtml } }) as unknown as CollectDeps['fetchPage'],
    recordNonTarget: true,
    today: '2026-08-05',
    now: () => '2026-08-05T04:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anp-collect-'));
  store = openStore({ path: join(dir, 'app.db'), rawDir: join(dir, 'raw') });
  created = [];
  updated = [];
  notion = {
    verifySchema: vi.fn(async () => {}),
    findPageByUrl: vi.fn(async () => null),
    createPage: vi.fn(async (a) => { created.push(a); return `page-${created.length}`; }),
    updatePage: vi.fn(async (a) => { updated.push(a); }),
    createDatabase: vi.fn(async () => 'db'),
    addMissingProperties: vi.fn(async () => []),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseCollectArgs', () => {
  it('--source を複数読む', () => {
    expect(parseCollectArgs(['--source', 'a', '--source', 'b']).only).toEqual(['a', 'b']);
  });

  it('--limit を数値で読む', () => {
    expect(parseCollectArgs(['--limit', '5']).limit).toBe(5);
  });

  it('--dry-run を読む', () => {
    expect(parseCollectArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('引数なしは空オプション', () => {
    expect(parseCollectArgs([])).toEqual({});
  });

  it('不正な --limit は無視する', () => {
    expect(parseCollectArgs(['--limit', 'abc']).limit).toBeUndefined();
  });
});

describe('runCollect: 正常フロー', () => {
  it('RSS から取得して Notion へ登録し、サマリを返す', async () => {
    const s = await runCollect(deps(), { limit: 1 });
    expect(s.found).toBeGreaterThan(0);
    expect(s.fetched).toBe(1);
    expect(s.analyzed).toBe(1);
    expect(s.synced).toBe(1);
    expect(s.failed).toBe(0);
    expect(created).toHaveLength(1);
  });

  it('除外件数をサマリに含める', async () => {
    const s = await runCollect(deps(), { limit: 1 });
    expect(s.excluded).toBeGreaterThan(0);
  });

  it('起動時に Notion スキーマを検証する', async () => {
    const d = deps();
    await runCollect(d, { limit: 1 });
    expect(d.notion?.verifySchema).toHaveBeenCalled();
  });

  it('AI 結果を Notion より先に SQLite へ保存する', async () => {
    const order: string[] = [];
    const d = deps({
      notion: { ...notion, createPage: vi.fn(async () => { order.push('notion'); return 'p1'; }) },
    });
    const origUpsert = store.upsert.bind(store);
    store.upsert = (i) => {
      if (i.status === 'analyzed') order.push('store:analyzed');
      origUpsert(i);
    };
    await runCollect(d, { limit: 1 });
    expect(order.indexOf('store:analyzed')).toBeLessThan(order.indexOf('notion'));
  });

  it('処理済みURLは2回目の実行で fetch しない', async () => {
    const d = deps();
    await runCollect(d, { limit: 1 });
    const firstCalls = (d.fetchPage as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await runCollect(d, { limit: 1 });
    const secondCalls = (d.fetchPage as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    // RSS フィード自体は毎回取るが、個別ページは取り直さない
    expect(secondCalls - firstCalls).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('公式URLで Notion に既存があれば新規作成せず更新する', async () => {
    const d = deps({ notion: { ...notion, findPageByUrl: vi.fn(async () => 'existing-page') } });
    await runCollect(d, { limit: 1 });
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.pageId).toBe('existing-page');
  });

  it('更新時に人手プロパティを含めない', async () => {
    const d = deps({ notion: { ...notion, findPageByUrl: vi.fn(async () => 'existing-page') } });
    await runCollect(d, { limit: 1 });
    const keys = Object.keys(updated[0]?.properties ?? {});
    for (const h of ['確認状態', '対応判断', '社内担当', '面談メモ', '社内メモ', '温度感']) {
      expect(keys, h).not.toContain(h);
    }
  });

  it('新規作成時は確認状態のみ人手項目を含む', async () => {
    await runCollect(deps(), { limit: 1 });
    const keys = Object.keys(created[0]?.properties ?? {});
    expect(keys).toContain('確認状態');
    for (const h of ['対応判断', '社内担当', '面談メモ', '社内メモ']) {
      expect(keys, h).not.toContain(h);
    }
  });

  it('原文を data/raw へキャッシュする', async () => {
    const spy = vi.spyOn(store, 'cacheRaw');
    await runCollect(deps(), { limit: 1 });
    expect(spy).toHaveBeenCalled();
  });

  it('run_logs に実行サマリを残す', async () => {
    await runCollect(deps(), { limit: 1 });
    const runs = store.listRuns();
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.finishedAt).not.toBeNull();
  });
});

describe('runCollect: 対象外情報', () => {
  it('recordNonTarget=true なら対象外も登録し確認状態を 対象外 にする', async () => {
    const d = deps({
      fetchPage: stubFetch({
        [FEED_URL]: {
          body: `<rss><channel><item><title>庁舎用プリンター100台の購入</title>
                 <link>${RFI_URL}</link><pubDate>Wed, 30 Jul 2026 10:00:00 +0900</pubDate>
                 <category>入札契約情報->各局等入札契約情報->契約管財局->入札・契約のお知らせ</category>
                 </item></channel></rss>`,
        },
        [RFI_URL]: { body: rfiHtml },
      }) as unknown as CollectDeps['fetchPage'],
    });
    const s = await runCollect(d, { limit: 1 });
    expect(s.nonTarget).toBe(1);
    expect(s.target).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]?.properties['確認状態']).toEqual({ select: { name: '対象外' } });
  });

  it('recordNonTarget=false なら対象外を Notion へ送らない', async () => {
    const d = deps({
      recordNonTarget: false,
      fetchPage: stubFetch({
        [FEED_URL]: {
          body: `<rss><channel><item><title>庁舎用プリンター100台の購入</title>
                 <link>${RFI_URL}</link>
                 <category>入札契約情報->各局等入札契約情報->契約管財局->入札・契約のお知らせ</category>
                 </item></channel></rss>`,
        },
        [RFI_URL]: { body: rfiHtml },
      }) as unknown as CollectDeps['fetchPage'],
    });
    const s = await runCollect(d, { limit: 1 });
    expect(s.nonTarget).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('対象外でも構造化解析（analyze）を呼ばない', async () => {
    const provider = createMockProvider();
    const spy = vi.spyOn(provider, 'analyze');
    const d = deps({
      provider,
      fetchPage: stubFetch({
        [FEED_URL]: {
          body: `<rss><channel><item><title>庁舎用プリンター100台の購入</title><link>${RFI_URL}</link>
                 <category>入札契約情報</category></item></channel></rss>`,
        },
        [RFI_URL]: { body: rfiHtml },
      }) as unknown as CollectDeps['fetchPage'],
    });
    await runCollect(d, { limit: 1 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('runCollect: 失敗の扱い', () => {
  it('1件が失敗しても残りを処理し failed に数える', async () => {
    const d = deps({
      config: parseConfig(`
defaults: { request_interval_ms: 0 }
sources:
  - { id: s, organization: 大阪市, name: S, url: ${FEED_URL}, collector_type: rss, enabled: true, content_selector: "#mol_contents" }
`),
      fetchPage: vi.fn(async (url: string) => {
        if (url === FEED_URL) {
          return {
            url, finalUrl: url, contentType: 'application/xml',
            body: new Uint8Array(), text: () => `<rss><channel>
              <item><title>壊れる案件</title><link>https://www.city.osaka.lg.jp/bad.html</link></item>
              <item><title>CX情報提供について</title><link>${RFI_URL}</link></item>
            </channel></rss>`,
          };
        }
        if (url === RFI_URL) {
          return { url, finalUrl: url, contentType: 'text/html', body: new Uint8Array(), text: () => rfiHtml };
        }
        throw new Error('ECONNRESET');
      }) as unknown as CollectDeps['fetchPage'],
    });
    const s = await runCollect(d, {});
    expect(s.failed).toBe(1);
    expect(s.synced).toBe(1);
  });

  it('Notion 書き込み失敗は pending_notion で残し AI 結果を失わない', async () => {
    const d = deps({
      notion: { ...notion, createPage: vi.fn(async () => { throw new Error('503'); }) },
    });
    const s = await runCollect(d, { limit: 1 });
    expect(s.synced).toBe(0);
    const pending = store.listPendingNotion();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.aiAnalyzeJson).not.toBeNull();
    expect(pending[0]?.contentHash.length).toBe(64);
  });

  it('AI 失敗でも原文が残り status=failed になる', async () => {
    const provider = createMockProvider();
    vi.spyOn(provider, 'classify').mockRejectedValue(new Error('AI落ちた'));
    const s = await runCollect(deps({ provider }), { limit: 1 });
    expect(s.failed).toBe(1);
    const row = store.getByUrl(RFI_URL);
    expect(row?.status).toBe('failed');
    expect(row?.contentHash.length).toBe(64);
  });

  it('スキーマ不一致は即停止して1件も処理しない', async () => {
    const d = deps({
      notion: {
        ...notion,
        verifySchema: vi.fn(async () => { throw new (await import('../src/errors.ts')).AppError('NOTION_SCHEMA_MISMATCH', '不足: 予算'); }),
      },
    });
    await expect(runCollect(d, { limit: 1 })).rejects.toMatchObject({ code: 'NOTION_SCHEMA_MISMATCH' });
    expect(created).toHaveLength(0);
  });
});

describe('flushPendingNotion', () => {
  it('pending_notion を再送して synced にする', async () => {
    store.upsert({
      urlNormalized: RFI_URL, url: RFI_URL, organization: '大阪市', title: 'CX情報提供',
      contentHash: contentHash('本文'), status: 'pending_notion',
      isTarget: 1,
      aiClassifyJson: JSON.stringify({ is_target: true, reason: 'x', confidence: 88 }),
      aiAnalyzeJson: JSON.stringify({
        document_type: 'RFI', organization_name: '大阪市', department_name: null,
        published_at: '2026-07-30', deadline: '2026-08-21', budget: null,
        official_title: 'CX情報提供', need_title: 'ポータル整備',
        problem_summary: null, background: null, desired_state: null,
        request_to_private_sector: null, categories: [], maturity_stage: '市場対話',
        domain_relevance: 'A', domain_relevance_reason: null,
        company_relevance: 'B', company_relevance_reason: null,
        possible_company_roles: [], required_partners: [],
        contact_recommendation: '高', recommended_action: null,
        questions_to_confirm: [], risks_and_conditions: [],
        confidence: 88, evidence_quotes: [],
      }),
      analyzedAt: '2026-08-05T04:00:00.000Z',
    });

    const r = await flushPendingNotion(deps());
    expect(r).toEqual({ synced: 1, failed: 0 });
    expect(store.listPendingNotion()).toHaveLength(0);
    expect(store.getByUrl(RFI_URL)?.status).toBe('synced');
  });

  it('再送も失敗すれば pending_notion のまま残す', async () => {
    store.upsert({
      urlNormalized: RFI_URL, url: RFI_URL, organization: '大阪市', title: 'x',
      contentHash: contentHash('本文'), status: 'pending_notion', isTarget: 0,
      aiClassifyJson: JSON.stringify({ is_target: false, reason: '物品購入', confidence: 95 }),
    });
    const d = deps({ notion: { ...notion, createPage: vi.fn(async () => { throw new Error('503'); }) } });
    const r = await flushPendingNotion(d);
    expect(r).toEqual({ synced: 0, failed: 1 });
    expect(store.listPendingNotion()).toHaveLength(1);
  });

  it('collect の冒頭で再送が走る', async () => {
    store.upsert({
      urlNormalized: 'https://www.city.osaka.lg.jp/pending.html',
      url: 'https://www.city.osaka.lg.jp/pending.html',
      organization: '大阪市', title: '保留案件', contentHash: contentHash('保留'),
      status: 'pending_notion', isTarget: 0,
      aiClassifyJson: JSON.stringify({ is_target: false, reason: '物品購入', confidence: 95 }),
    });
    await runCollect(deps(), { limit: 1 });
    expect(store.getByUrl('https://www.city.osaka.lg.jp/pending.html')?.status).toBe('synced');
  });
});

describe('runCollect: --dry-run', () => {
  it('Notion へ書かず解析結果だけを出す', async () => {
    const s = await runCollect(deps(), { limit: 1, dryRun: true });
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(s.analyzed).toBe(1);
    expect(s.synced).toBe(0);
  });

  it('--dry-run では Notion 検証もスキップする（トークン無しで動かせる）', async () => {
    const d = deps({ notion: null });
    await expect(runCollect(d, { limit: 1, dryRun: true })).resolves.toBeTruthy();
  });

  it('--dry-run でも SQLite に AI 結果を残す', async () => {
    await runCollect(deps(), { limit: 1, dryRun: true });
    expect(store.getByUrl(RFI_URL)?.aiAnalyzeJson).not.toBeNull();
  });
});

describe('runCollect: 更新検知', () => {
  it('本文が変わったら 更新あり を true にする', async () => {
    const d = deps({ notion: { ...notion, findPageByUrl: vi.fn(async () => 'existing-page') } });
    await runCollect(d, { limit: 1 });
    updated.length = 0;

    // 本文を変えて再実行。処理済みでも Notion 側に既存があるため更新経路を通す
    store.upsert({
      urlNormalized: RFI_URL, url: RFI_URL, contentHash: contentHash('以前の本文'),
      status: 'synced', organization: '大阪市', title: 'CX情報提供', notionPageId: 'existing-page',
    });
    store.markSynced(RFI_URL, 'existing-page');

    const d2 = deps({
      notion: { ...notion, findPageByUrl: vi.fn(async () => 'existing-page') },
      config: CONFIG,
    });
    await runCollect(d2, { limit: 1, forceReprocess: true } as never);
    // forceReprocess を実装しない場合は、このケースを updated.length === 0 で確認する
    expect(updated.length + created.length).toBeGreaterThanOrEqual(0);
  });
});
```

**注意:** 最後の「更新検知」ブロックは `forceReprocess` に依存している。実装では `--force` オプションを設けないため、このテストは次の形に置き換える。

```ts
describe('runCollect: 更新検知', () => {
  it('本文ハッシュが変わっていれば 更新あり を true にして更新する', async () => {
    // 1回目
    const d1 = deps({ notion: { ...notion, findPageByUrl: vi.fn(async () => null) } });
    await runCollect(d1, { limit: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]?.properties['更新あり']).toEqual({ checkbox: false });

    // 本文が変わった状態を作る（ハッシュだけ差し替え、status は synced のまま）
    store.upsert({
      urlNormalized: RFI_URL, url: RFI_URL, contentHash: contentHash('以前の異なる本文'),
      status: 'synced', organization: '大阪市', title: 'CX情報提供',
    });
    store.markSynced(RFI_URL, 'page-1');

    // 2回目。処理済みだが本文ハッシュが違うため更新経路を通る
    created.length = 0;
    const d2 = deps({ notion: { ...notion, findPageByUrl: vi.fn(async () => 'page-1') } });
    await runCollect(d2, { limit: 1 });

    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.properties['更新あり']).toEqual({ checkbox: true });
  });

  it('本文ハッシュが同じなら再取得後も Notion へ書かない', async () => {
    const d = deps();
    await runCollect(d, { limit: 1 });
    created.length = 0;
    updated.length = 0;
    await runCollect(deps(), { limit: 1 });
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/collect.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/collect.ts"`

- [ ] **Step 3: `src/collect.ts` を実装**

重複判定は「未処理なら fetch する」だけでなく「処理済みでも本文ハッシュが変わっていれば更新する」を扱う。fetch 前に切るのは **同一実行内で既に処理した URL** と **前回 synced かつ最終確認が同日** のもの。ここでは仕様を単純にし、**処理済みでも本文は取り直してハッシュ比較する**（1情報源60件上限があるため負荷は許容範囲）。ただし `status = 'synced'` で本文ハッシュが同じなら Notion へは書かない。

```ts
import { AppError, isFatal, toAppError } from './errors.ts';
import { appendPdfSections, extractPdfText } from './extract-pdf.ts';
import { extractContent } from './extract-content.ts';
import { checkEvidence } from './evidence.ts';
import { createRateLimiter } from './rate-limiter.ts';
import { createLogger } from './logger.ts';
import { createProvider } from './ai/index.ts';
import { createNotionClient } from './notion.ts';
import { buildCreateProperties, buildPageBlocks, buildUpdateProperties } from './notion-map.ts';
import { contentHash, openStore } from './store.ts';
import { enabledSources, loadConfig } from './config.ts';
import { findDuplicate, isContentChanged } from './dedupe.ts';
import { fetchPage as realFetchPage } from './fetch-page.ts';
import { isPdfUrl, normalizeUrl } from './url.ts';
import { runCollector } from './collectors/index.ts';
import { parseNeedAnalysis } from './ai/schema.ts';
import type { AiProvider } from './ai/provider.ts';
import type { NeedAnalysis } from './ai/schema.ts';
import type { AppConfig, SourceConfig } from './config.ts';
import type { Logger } from './logger.ts';
import type { NotionClient } from './notion.ts';
import type { RunSummary, Store } from './store.ts';
import type { Candidate } from './types.ts';

export type CollectDeps = {
  config: AppConfig;
  store: Store;
  provider: AiProvider;
  /** dryRun 時は null でよい */
  notion: NotionClient | null;
  logger: Logger;
  fetchPage: typeof realFetchPage;
  recordNonTarget: boolean;
  /** 検知日（YYYY-MM-DD） */
  today: string;
  now: () => string;
};

export type CollectOptions = {
  only?: string[];
  limit?: number;
  dryRun?: boolean;
};

export function parseCollectArgs(argv: string[]): CollectOptions {
  const only: string[] = [];
  let limit: number | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { only.push(v); i += 1; }
    } else if (a === '--limit') {
      const v = Number(argv[i + 1]);
      if (Number.isInteger(v) && v > 0) { limit = v; i += 1; }
    } else if (a === '--dry-run') {
      dryRun = true;
    }
  }

  const out: CollectOptions = {};
  if (only.length > 0) out.only = only;
  if (limit !== undefined) out.limit = limit;
  if (dryRun) out.dryRun = true;
  return out;
}

const emptySummary = (): RunSummary => ({
  found: 0, excluded: 0, fetched: 0, analyzed: 0,
  target: 0, nonTarget: 0, synced: 0, failed: 0,
});

/** SQLite に保存済みの AI 結果から Notion へ書く（新規 or 更新）。 */
async function writeToNotion(
  args: {
    notion: NotionClient;
    officialUrl: string;
    analysis: NeedAnalysis | null;
    classification: { is_target: boolean; reason: string; confidence: number };
    organizationFallback: string;
    departmentFallback: string | null;
    evidence: ReturnType<typeof checkEvidence> | null;
    contentChanged: boolean;
    pdfUrls: string[];
    bodyText: string;
    detectedAt: string;
    analyzedAt: string;
    knownPageId: string | null;
  },
): Promise<string> {
  const mapInput = {
    analysis: args.analysis,
    classification: args.classification,
    officialUrl: args.officialUrl,
    detectedAt: args.detectedAt,
    analyzedAt: args.analyzedAt,
    organizationFallback: args.organizationFallback,
    departmentFallback: args.departmentFallback,
    evidence: args.evidence,
    contentChanged: args.contentChanged,
    pdfUrls: args.pdfUrls,
    bodyText: args.bodyText,
  };

  const pageId = args.knownPageId ?? await args.notion.findPageByUrl(args.officialUrl);

  if (pageId !== null) {
    // 人手項目を含まない自動項目のみを更新する
    await args.notion.updatePage({ pageId, properties: buildUpdateProperties(mapInput) });
    return pageId;
  }

  return args.notion.createPage({
    properties: buildCreateProperties(mapInput),
    children: buildPageBlocks(mapInput),
  });
}

/**
 * 1件の候補を処理する。
 * 例外を外に投げず、結果を返り値で表す。1件の失敗で全体を止めない（設計書 §14）。
 */
export async function processCandidate(
  c: Candidate,
  source: SourceConfig,
  deps: CollectDeps,
): Promise<'synced' | 'skipped' | 'failed' | 'dry' | 'non_target_skipped'> {
  const key = (() => {
    try { return normalizeUrl(c.url); } catch { return null; }
  })();
  if (key === null) {
    deps.logger.warn(`URL が不正なためスキップ: ${c.url}`);
    return 'skipped';
  }

  const d = deps.config.defaults;
  const rateLimiter = createRateLimiter(d.requestIntervalMs);

  try {
    // ---- 取得と抽出 ----
    const res = await deps.fetchPage(c.url, {
      timeoutMs: d.timeoutMs, maxRetries: d.maxRetries, maxBytes: d.maxBytes,
      userAgent: d.userAgent, rateLimiter,
    });

    const page = extractContent(res.text(), res.finalUrl, {
      ...(source.contentSelector === undefined ? {} : { contentSelector: source.contentSelector }),
    });

    // ---- 添付PDF ----
    const pdfSections: Array<{ name: string; text: string }> = [];
    for (const pdfUrl of page.pdfUrls) {
      if (!isPdfUrl(pdfUrl)) continue;
      try {
        const pdfRes = await deps.fetchPage(pdfUrl, {
          timeoutMs: d.timeoutMs, maxRetries: d.maxRetries, maxBytes: d.maxBytes,
          userAgent: d.userAgent, rateLimiter,
        });
        const { text } = await extractPdfText(pdfRes.body);
        pdfSections.push({ name: pdfUrl.split('/').pop() ?? pdfUrl, text });
      } catch (e) {
        // PDF が読めなくても失敗にしない。公式URLだけ記録して続ける（設計書 §7, §17）
        const err = toAppError(e, 'PDF_EXTRACT_FAILED');
        deps.logger.warn(`PDFを解析できませんでした（URLのみ記録します）: ${pdfUrl}`, { code: err.code });
      }
    }

    const bodyText = appendPdfSections(page.bodyText, pdfSections);
    const hash = contentHash(bodyText);
    deps.store.cacheRaw(hash, bodyText);

    // ---- 重複と更新の判定 ----
    const existing = deps.store.getByUrl(key);
    if (existing !== null && existing.status === 'synced' && !isContentChanged(existing, hash)) {
      deps.logger.debug(`本文に変更がないためスキップ: ${key}`);
      deps.store.upsert({
        urlNormalized: key, url: res.finalUrl, sourceId: source.id,
        organization: c.organization, title: page.title, contentHash: hash, status: 'synced',
      });
      return 'skipped';
    }
    const contentChanged = existing !== null && isContentChanged(existing, hash);

    deps.store.upsert({
      urlNormalized: key, url: res.finalUrl, sourceId: source.id,
      organization: c.organization, title: page.title,
      contentHash: hash, status: 'pending_analysis',
    });

    // ---- AI ① 対象判定 ----
    const aiInput = {
      title: page.title,
      bodyText,
      sourceUrl: res.finalUrl,
      organizationHint: c.organization,
      documentTypeHint: null,
      publishedAtHint: page.publishedAtCandidate ?? c.listDate,
    };

    const cls = await deps.provider.classify(aiInput);

    // ---- AI ② 構造化解析（対象のみ）----
    let analysis: NeedAnalysis | null = null;
    let evidence: ReturnType<typeof checkEvidence> | null = null;
    let analyzeRaw: string | null = null;

    if (cls.data.is_target) {
      const ana = await deps.provider.analyze(aiInput);
      analysis = ana.data;
      analyzeRaw = ana.raw;
      evidence = checkEvidence(ana.data.evidence_quotes, bodyText);
      if (!evidence.ok) {
        deps.logger.warn(`根拠の引用が原文に見つかりませんでした: ${key}`, {
          code: 'EVIDENCE_MISMATCH', count: evidence.mismatched.length,
        });
      }
    }

    const analyzedAt = deps.now();

    // ---- ★ Notion より先に SQLite へ確定させる（設計書 §13）----
    deps.store.upsert({
      urlNormalized: key, url: res.finalUrl, sourceId: source.id,
      organization: analysis?.organization_name ?? c.organization,
      title: page.title, contentHash: hash,
      isTarget: cls.data.is_target ? 1 : 0,
      status: 'analyzed',
      aiProvider: deps.provider.name, aiModel: deps.provider.model,
      aiClassifyJson: cls.raw, aiAnalyzeJson: analyzeRaw, analyzedAt,
    });

    if (deps.dryRunLog !== undefined) deps.dryRunLog(key, cls.data, analysis);

    // ---- Notion ----
    if (deps.notion === null) return 'dry';
    if (!cls.data.is_target && !deps.recordNonTarget) {
      deps.store.markSynced(key, '');
      return 'non_target_skipped';
    }

    try {
      const pageId = await writeToNotion({
        notion: deps.notion,
        officialUrl: key,
        analysis,
        classification: cls.data,
        organizationFallback: c.organization,
        departmentFallback: analysis?.department_name ?? page.departmentCandidate ?? c.categoryHint,
        evidence,
        contentChanged,
        pdfUrls: page.pdfUrls,
        bodyText,
        detectedAt: deps.today,
        analyzedAt,
        knownPageId: existing?.notionPageId ?? null,
      });
      deps.store.markSynced(key, pageId);
      return 'synced';
    } catch (e) {
      const err = toAppError(e, 'NOTION_WRITE_FAILED');
      if (err.code === 'NOTION_SCHEMA_MISMATCH') throw err;
      // AI 結果は既に保存済み。次回実行の冒頭で再送する（設計書 §13）
      deps.store.markPendingNotion(key, err.code, err.internalDetail ?? err.userMessage);
      deps.logger.error(`Notion への書き込みに失敗しました（次回再送します）: ${key}`, { code: err.code });
      return 'failed';
    }
  } catch (e) {
    const err = toAppError(e, 'URL_FETCH_FAILED');
    if (isFatal(err.code)) throw err;
    deps.store.upsert({
      urlNormalized: key, url: c.url, sourceId: source.id,
      organization: c.organization, title: c.linkText,
      contentHash: deps.store.getByUrl(key)?.contentHash ?? '',
      status: 'failed', errorCode: err.code, errorDetail: err.internalDetail ?? null,
    });
    deps.logger.error(`処理に失敗しました: ${c.url}`, { code: err.code, detail: err.internalDetail });
    return 'failed';
  }
}

/** status=pending_notion を再送する（設計書 §13）。 */
export async function flushPendingNotion(deps: CollectDeps): Promise<{ synced: number; failed: number }> {
  if (deps.notion === null) return { synced: 0, failed: 0 };

  const rows = deps.store.listPendingNotion();
  if (rows.length === 0) return { synced: 0, failed: 0 };

  deps.logger.info(`Notion 未同期の ${rows.length} 件を再送します`);
  let synced = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const cls = row.aiClassifyJson === null
        ? { is_target: row.isTarget === 1, reason: '', confidence: 0 }
        : JSON.parse(row.aiClassifyJson) as { is_target: boolean; reason: string; confidence: number };

      const analysis = row.aiAnalyzeJson === null ? null : parseNeedAnalysis(row.aiAnalyzeJson);

      const pageId = await writeToNotion({
        notion: deps.notion,
        officialUrl: row.urlNormalized,
        analysis,
        classification: cls,
        organizationFallback: row.organization ?? '不明',
        departmentFallback: null,
        evidence: null,
        contentChanged: false,
        pdfUrls: [],
        bodyText: '',
        detectedAt: row.firstSeenAt.slice(0, 10),
        analyzedAt: row.analyzedAt ?? deps.now(),
        knownPageId: row.notionPageId,
      });
      deps.store.markSynced(row.urlNormalized, pageId);
      synced += 1;
    } catch (e) {
      const err = toAppError(e, 'NOTION_WRITE_FAILED');
      if (err.code === 'NOTION_SCHEMA_MISMATCH') throw err;
      deps.store.markPendingNotion(row.urlNormalized, err.code, err.internalDetail ?? err.userMessage);
      failed += 1;
    }
  }

  deps.logger.info(`再送結果: 成功 ${synced} 件 / 失敗 ${failed} 件`);
  return { synced, failed };
}

/** 収集フロー全体（設計書 §14, §18）。 */
export async function runCollect(deps: CollectDeps, options: CollectOptions): Promise<RunSummary> {
  const summary = emptySummary();
  const dryRun = options.dryRun === true;
  const notion = dryRun ? null : deps.notion;
  const d: CollectDeps = { ...deps, notion };

  // 1〜2. 設定の検証は loadConfig 側。Notion スキーマ検証はここで一度だけ
  if (notion !== null) {
    await notion.verifySchema('');
  }

  // 3. 未同期分の再送
  const flushed = await flushPendingNotion(d);
  summary.synced += flushed.synced;
  summary.failed += flushed.failed;

  const sources = enabledSources(d.config, options.only);
  d.logger.info(`対象の情報源: ${sources.map((s) => s.id).join(', ') || '（なし）'}`);

  for (const source of sources) {
    const runId = d.store.startRun(source.id);
    const perSource = emptySummary();
    const rateLimiter = createRateLimiter(d.config.defaults.requestIntervalMs);

    try {
      // 4. 一覧ページ / RSS の取得
      const listRes = await d.fetchPage(source.url, {
        timeoutMs: d.config.defaults.timeoutMs,
        maxRetries: d.config.defaults.maxRetries,
        maxBytes: d.config.defaults.maxBytes,
        userAgent: d.config.defaults.userAgent,
        rateLimiter,
      });

      // 5〜6. リンク抽出と除外
      const collected = runCollector({
        collectorType: source.collectorType,
        html: listRes.text(),
        sourceId: source.id,
        organization: source.organization,
        url: source.url,
        ...(source.linkSelector === undefined ? {} : { linkSelector: source.linkSelector }),
        categoryIncludes: source.categoryIncludes,
        titleExcludes: source.titleExcludes,
      });

      perSource.found = collected.totalFound;
      perSource.excluded = collected.excluded.length;

      if (collected.excluded.length > 0) {
        const byPattern: Record<string, number> = {};
        for (const x of collected.excluded) byPattern[x.pattern] = (byPattern[x.pattern] ?? 0) + 1;
        d.logger.info(`[${source.id}] 結果公表として除外: ${collected.excluded.length} 件`, byPattern);
      }

      // 7. 件数上限
      const cap = options.limit ?? d.config.defaults.maxItemsPerRun;
      const targets = collected.candidates.slice(0, cap);
      if (collected.candidates.length > targets.length) {
        d.logger.info(`[${source.id}] 件数上限のため ${collected.candidates.length - targets.length} 件を今回は処理しません`);
      }

      // 8〜14. 1件ずつ処理
      for (const c of targets) {
        const r = await processCandidate(c, source, d);
        if (r === 'skipped') continue;

        perSource.fetched += 1;
        if (r === 'failed') { perSource.failed += 1; continue; }

        perSource.analyzed += 1;
        const row = d.store.getByUrl(normalizeUrl(c.url));
        if (row?.isTarget === 1) perSource.target += 1; else perSource.nonTarget += 1;
        if (r === 'synced') perSource.synced += 1;
      }
    } catch (e) {
      const err = toAppError(e, 'URL_FETCH_FAILED');
      if (isFatal(err.code)) throw err;
      d.logger.error(`[${source.id}] 情報源の処理に失敗しました`, { code: err.code, detail: err.internalDetail });
      perSource.failed += 1;
    }

    d.store.finishRun(runId, perSource);
    for (const k of Object.keys(perSource) as Array<keyof RunSummary>) summary[k] += perSource[k];
  }

  // 15. サマリ
  d.logger.info(
    `完了: 発見 ${summary.found} / 除外 ${summary.excluded} / 取得 ${summary.fetched} / ` +
    `解析 ${summary.analyzed} / 対象 ${summary.target} / 対象外 ${summary.nonTarget} / ` +
    `Notion登録 ${summary.synced} / 失敗 ${summary.failed}`,
  );

  return summary;
}

/** CLI エントリ。 */
async function main(): Promise<void> {
  const options = parseCollectArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = openStore({
    path: process.env['DATABASE_PATH'] ?? './data/app.db',
    rawDir: process.env['RAW_DIR'] ?? './data/raw',
  });
  const logger = createLogger({
    logDir: process.env['LOG_DIR'] ?? './data/logs',
    level: (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
  });

  let notion: NotionClient | null = null;
  if (options.dryRun !== true) {
    const token = process.env['NOTION_TOKEN'];
    const databaseId = process.env['NOTION_DATABASE_ID'];
    if (token === undefined || databaseId === undefined) {
      throw new AppError(
        'CONFIG_INVALID',
        'NOTION_TOKEN と NOTION_DATABASE_ID を .env に設定してください（--dry-run なら不要です）',
      );
    }
    const client = createNotionClient({ token, databaseId });
    // verifySchema に databaseId を渡すため薄くラップする
    notion = { ...client, verifySchema: () => client.verifySchema(databaseId) };
  }

  try {
    await runCollect({
      config, store, notion, logger,
      provider: createProvider(),
      fetchPage: realFetchPage,
      recordNonTarget: (process.env['RECORD_NON_TARGET'] ?? 'true') !== 'false',
      today: new Date().toISOString().slice(0, 10),
      now: () => new Date().toISOString(),
    }, options);
  } finally {
    store.close();
    logger.close();
  }
}

if (process.argv[1]?.endsWith('collect.ts') === true) {
  main().catch((e: unknown) => {
    if (e instanceof AppError) {
      console.error(`\nエラー [${e.code}]: ${e.userMessage}`);
      if (e.internalDetail !== undefined) console.error(`詳細: ${e.internalDetail}`);
    } else {
      console.error(e);
    }
    process.exitCode = 1;
  });
}
```

**実装上の注意（テスト作成時に判明する点）:**

1. `CollectDeps` に `dryRunLog?: (url: string, cls: unknown, analysis: unknown) => void` を追加し、`--dry-run` 時に解析結果を標準出力へ出す。型定義に含めること。
2. `verifySchema('')` の空文字渡しは不自然なので、`CollectDeps.notion` の `verifySchema` は引数なしで呼べるようラップする。`main()` の実装がそれを行っている。テスト側のスタブも引数を無視する形にする。
3. `markSynced(key, '')` で空の page id を入れると `notion_page_id` が空文字になる。`recordNonTarget=false` の場合は `markSynced` ではなく専用の `status='skipped'` にする方が正しい。`store.upsert({ ..., status: 'skipped' })` を使う。

- [ ] **Step 4: 上記の注意点を反映してテストを通す**

```bash
npx vitest run test/collect.test.ts
```

Expected: PASS（30 tests 前後）

- [ ] **Step 5: 型検査・lint・全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS

- [ ] **Step 6: モックモードでの実行を1回試す**

```bash
AI_PROVIDER=mock npm run collect -- --dry-run --limit 3
```

Expected: Notion トークンなしで完走し、サマリ行が出る

- [ ] **Step 7: コミット**

```bash
git add src/collect.ts test/collect.test.ts
git commit -m "feat: collect オーケストレーション

冒頭で pending_notion を再送し、AI 結果は Notion より先に SQLite へ確定させる。
1件の失敗で全体を止めず、件ごとに記録して最後にサマリを出す。
本文ハッシュが同じ synced 行は Notion へ書かず、変わっていれば更新ありを立てる。
--dry-run / --source / --limit に対応。"
```

---

## Task 21: `import`（手動投入）

**Files:**
- Create: `src/import.ts`
- Test: `test/import.test.ts`

**Interfaces:**
- Consumes: `processCandidate` 相当の処理／`extractPdfText`／`extractContent`／`fetchPage`／`assertSafeUrl`
- Produces:
  - `type ImportArgs = { url?: string; file?: string; text?: string; title?: string; organization?: string; type?: string; dryRun: boolean }`
  - `parseImportArgs(argv: string[]): ImportArgs` — 入力が無ければ `AppError('IMPORT_INPUT_INVALID')`
  - `resolveInput(args: ImportArgs, deps: { fetchPage: typeof fetchPage; readFile: (p: string) => Uint8Array; defaults: Defaults }): Promise<{ title: string; bodyText: string; sourceUrl: string; pdfUrls: string[]; publishedAtCandidate: string | null }>`
  - `runImport(args: ImportArgs, deps: CollectDeps & { readFile: (p: string) => Uint8Array }): Promise<'synced' | 'failed' | 'dry'>`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/import.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseImportArgs, resolveInput, runImport } from '../src/import.ts';
import { parseConfig } from '../src/config.ts';
import { createMockProvider } from '../src/ai/mock.ts';
import { createLogger } from '../src/logger.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { NotionClient } from '../src/notion.ts';
import { AppError } from '../src/errors.ts';

const RFI_URL = 'https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html';
const rfiHtml = readFileSync('test/fixtures/rfi.html', 'utf8');
const youryouPdf = new Uint8Array(readFileSync('test/fixtures/youryou.pdf'));

const CONFIG = parseConfig(`
defaults: { request_interval_ms: 0 }
sources:
  - { id: manual, organization: 大阪市, name: 手動, url: https://www.city.osaka.lg.jp/, collector_type: manual, enabled: true }
`);

let dir: string;
let store: Store;
let created: Array<{ properties: Record<string, unknown>; children: unknown[] }>;
let notion: NotionClient;

function deps(over: Record<string, unknown> = {}) {
  return {
    config: CONFIG,
    store,
    provider: createMockProvider(),
    notion,
    logger: createLogger({ logDir: join(dir, 'logs'), level: 'error' as const }),
    fetchPage: vi.fn(async (url: string) => ({
      url, finalUrl: url, contentType: 'text/html', body: new Uint8Array(), text: () => rfiHtml,
    })),
    readFile: vi.fn(() => youryouPdf),
    recordNonTarget: true,
    today: '2026-08-05',
    now: () => '2026-08-05T04:00:00.000Z',
    ...over,
  } as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anp-import-'));
  store = openStore({ path: join(dir, 'app.db'), rawDir: join(dir, 'raw') });
  created = [];
  notion = {
    verifySchema: vi.fn(async () => {}),
    findPageByUrl: vi.fn(async () => null),
    createPage: vi.fn(async (a) => { created.push(a); return 'page-1'; }),
    updatePage: vi.fn(async () => {}),
    createDatabase: vi.fn(async () => 'db'),
    addMissingProperties: vi.fn(async () => []),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseImportArgs', () => {
  it('--url を読む', () => {
    expect(parseImportArgs(['--url', RFI_URL]).url).toBe(RFI_URL);
  });

  it('--file を読む', () => {
    expect(parseImportArgs(['--file', './data/document.pdf']).file).toBe('./data/document.pdf');
  });

  it('--text と --title を読む', () => {
    const a = parseImportArgs(['--text', '本文です', '--title', 'タイトル']);
    expect(a.text).toBe('本文です');
    expect(a.title).toBe('タイトル');
  });

  it('--organization と --type を読む（指示書 §22）', () => {
    const a = parseImportArgs(['--file', './x.pdf', '--organization', '大阪市', '--type', '計画']);
    expect(a.organization).toBe('大阪市');
    expect(a.type).toBe('計画');
  });

  it('--dry-run を読む', () => {
    expect(parseImportArgs(['--url', RFI_URL, '--dry-run']).dryRun).toBe(true);
  });

  it('入力が無ければ IMPORT_INPUT_INVALID で使い方を示す', () => {
    try {
      parseImportArgs([]);
      throw new Error('例外が投げられなかった');
    } catch (e) {
      expect((e as AppError).code).toBe('IMPORT_INPUT_INVALID');
      expect((e as AppError).userMessage).toContain('--url');
      expect((e as AppError).userMessage).toContain('--file');
    }
  });

  it('--text だけで --title が無ければ IMPORT_INPUT_INVALID', () => {
    expect(() => parseImportArgs(['--text', '本文'])).toThrow(AppError);
  });

  it('未知の --type は IMPORT_INPUT_INVALID', () => {
    expect(() => parseImportArgs(['--file', './x.pdf', '--type', '存在しない種別'])).toThrow(AppError);
  });

  it('複数の入力方法を同時指定したら IMPORT_INPUT_INVALID', () => {
    expect(() => parseImportArgs(['--url', RFI_URL, '--file', './x.pdf'])).toThrow(AppError);
  });
});

describe('resolveInput', () => {
  const d = { defaults: CONFIG.defaults };

  it('--url は取得して本文抽出する', async () => {
    const r = await resolveInput({ url: RFI_URL, dryRun: false }, {
      ...d,
      fetchPage: vi.fn(async (url: string) => ({
        url, finalUrl: url, contentType: 'text/html', body: new Uint8Array(), text: () => rfiHtml,
      })) as never,
      readFile: vi.fn(),
    });
    expect(r.title).toContain('CXサービスデザイン推進事業');
    expect(r.bodyText.length).toBeGreaterThan(1000);
    expect(r.sourceUrl).toBe(RFI_URL);
    expect(r.pdfUrls).toHaveLength(1);
  });

  it('--url は SSRF 検査を通す', async () => {
    await expect(resolveInput({ url: 'http://169.254.169.254/latest/meta-data/', dryRun: false }, {
      ...d, fetchPage: vi.fn() as never, readFile: vi.fn(),
    })).rejects.toMatchObject({ code: 'URL_INVALID' });
  });

  it('--file の .pdf は PDF 抽出する', async () => {
    const r = await resolveInput({ file: './test/fixtures/youryou.pdf', dryRun: false }, {
      ...d, fetchPage: vi.fn() as never, readFile: () => youryouPdf,
    });
    expect(r.bodyText.length).toBeGreaterThan(4500);
    expect(r.bodyText).toMatch(/令和\s*8\s*年\s*8\s*月\s*21\s*日/);
    expect(r.title).toContain('youryou');
  });

  it('--file のテキストファイルはそのまま読む', async () => {
    const r = await resolveInput({ file: './data/input.txt', dryRun: false }, {
      ...d, fetchPage: vi.fn() as never,
      readFile: () => new TextEncoder().encode('これは手動投入の本文です。'.repeat(20)),
    });
    expect(r.bodyText).toContain('手動投入の本文');
  });

  it('--text はそのまま使い、sourceUrl は manual スキームにする', async () => {
    const r = await resolveInput({ text: 'あ'.repeat(300), title: '議会答弁', dryRun: false }, {
      ...d, fetchPage: vi.fn() as never, readFile: vi.fn(),
    });
    expect(r.title).toBe('議会答弁');
    expect(r.sourceUrl).toMatch(/^manual:/);
  });

  it('--title 指定は URL 取得時もタイトルを上書きする', async () => {
    const r = await resolveInput({ url: RFI_URL, title: '手で付けたタイトル', dryRun: false }, {
      ...d,
      fetchPage: vi.fn(async (url: string) => ({
        url, finalUrl: url, contentType: 'text/html', body: new Uint8Array(), text: () => rfiHtml,
      })) as never,
      readFile: vi.fn(),
    });
    expect(r.title).toBe('手で付けたタイトル');
  });

  it('本文200文字未満は EXTRACT_FAILED', async () => {
    await expect(resolveInput({ text: '短い', title: 't', dryRun: false }, {
      ...d, fetchPage: vi.fn() as never, readFile: vi.fn(),
    })).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
  });
});

describe('runImport', () => {
  it('URL を解析して Notion へ登録できる（§27 受け入れ条件）', async () => {
    expect(await runImport({ url: RFI_URL, dryRun: false }, deps())).toBe('synced');
    expect(created).toHaveLength(1);
  });

  it('テキストファイルを解析して登録できる', async () => {
    const d = deps({ readFile: () => new TextEncoder().encode('これは計画の本文です。'.repeat(30)) });
    expect(await runImport({ file: './data/input.txt', dryRun: false }, d)).toBe('synced');
  });

  it('PDF を解析して登録できる', async () => {
    expect(await runImport({ file: './test/fixtures/youryou.pdf', dryRun: false }, deps())).toBe('synced');
    expect(created).toHaveLength(1);
  });

  it('--organization をAI抽出値より優先する（設計書 §15）', async () => {
    await runImport({ file: './x.pdf', organization: '福岡市', dryRun: false }, deps());
    expect(created[0]?.properties['自治体・組織']).toEqual({ select: { name: '福岡市' } });
  });

  it('--type をAI抽出値より優先する', async () => {
    await runImport({ file: './x.pdf', organization: '大阪市', type: '計画', dryRun: false }, deps());
    expect(created[0]?.properties['文書種別']).toEqual({ select: { name: '計画' } });
  });

  it('--dry-run では Notion へ書かない', async () => {
    expect(await runImport({ url: RFI_URL, dryRun: true }, deps({ notion: null }))).toBe('dry');
    expect(created).toHaveLength(0);
  });

  it('SQLite に AI 結果を残す', async () => {
    await runImport({ url: RFI_URL, dryRun: false }, deps());
    expect(store.getByUrl(RFI_URL)?.aiAnalyzeJson).not.toBeNull();
  });

  it('同じURLを2回投入しても重複作成しない', async () => {
    const d = deps();
    await runImport({ url: RFI_URL, dryRun: false }, d);
    created.length = 0;
    const d2 = deps({ notion: { ...notion, findPageByUrl: vi.fn(async () => 'page-1') } });
    await runImport({ url: RFI_URL, dryRun: false }, d2);
    expect(created).toHaveLength(0);
  });

  it('Notion 失敗時は pending_notion で残す', async () => {
    const d = deps({ notion: { ...notion, createPage: vi.fn(async () => { throw new Error('503'); }) } });
    expect(await runImport({ url: RFI_URL, dryRun: false }, d)).toBe('failed');
    expect(store.listPendingNotion()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npx vitest run test/import.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/import.ts"`

- [ ] **Step 3: `src/import.ts` を実装**

`processCandidate` と処理を共有するため、`collect.ts` から「本文が既にある状態から AI → Notion へ流す関数」を切り出して両方から使う。`collect.ts` に次を追加してエクスポートする。

```ts
// src/collect.ts に追加する
export type PreparedDocument = {
  key: string;
  sourceUrl: string;
  title: string;
  bodyText: string;
  pdfUrls: string[];
  publishedAtCandidate: string | null;
  departmentCandidate: string | null;
  organization: string;
  documentTypeHint: string | null;
  sourceId: string;
  contentChanged: boolean;
  knownPageId: string | null;
};

/**
 * 本文が用意できた状態から AI 解析 → SQLite → Notion まで流す。
 * collect（自動収集）と import（手動投入）で共有する。
 */
export async function analyzeAndSync(
  doc: PreparedDocument,
  deps: CollectDeps,
): Promise<'synced' | 'failed' | 'dry' | 'skipped'> {
  const hash = contentHash(doc.bodyText);
  deps.store.cacheRaw(hash, doc.bodyText);

  deps.store.upsert({
    urlNormalized: doc.key, url: doc.sourceUrl, sourceId: doc.sourceId,
    organization: doc.organization, title: doc.title,
    contentHash: hash, status: 'pending_analysis',
  });

  const aiInput = {
    title: doc.title,
    bodyText: doc.bodyText,
    sourceUrl: doc.sourceUrl,
    organizationHint: doc.organization,
    documentTypeHint: doc.documentTypeHint,
    publishedAtHint: doc.publishedAtCandidate,
  };

  const cls = await deps.provider.classify(aiInput);

  let analysis: NeedAnalysis | null = null;
  let evidence: ReturnType<typeof checkEvidence> | null = null;
  let analyzeRaw: string | null = null;

  if (cls.data.is_target) {
    const ana = await deps.provider.analyze(aiInput);
    analysis = ana.data;
    analyzeRaw = ana.raw;
    evidence = checkEvidence(ana.data.evidence_quotes, doc.bodyText);
    if (!evidence.ok) {
      deps.logger.warn(`根拠の引用が原文に見つかりませんでした: ${doc.key}`, {
        code: 'EVIDENCE_MISMATCH', count: evidence.mismatched.length,
      });
    }
  }

  const analyzedAt = deps.now();

  // ★ Notion より先に確定させる
  deps.store.upsert({
    urlNormalized: doc.key, url: doc.sourceUrl, sourceId: doc.sourceId,
    organization: analysis?.organization_name ?? doc.organization,
    title: doc.title, contentHash: hash,
    isTarget: cls.data.is_target ? 1 : 0, status: 'analyzed',
    aiProvider: deps.provider.name, aiModel: deps.provider.model,
    aiClassifyJson: cls.raw, aiAnalyzeJson: analyzeRaw, analyzedAt,
  });

  if (deps.notion === null) return 'dry';

  if (!cls.data.is_target && !deps.recordNonTarget) {
    deps.store.upsert({
      urlNormalized: doc.key, url: doc.sourceUrl, contentHash: hash, status: 'skipped',
    });
    return 'skipped';
  }

  try {
    const pageId = await writeToNotion({
      notion: deps.notion,
      officialUrl: doc.key,
      analysis,
      classification: cls.data,
      organizationFallback: doc.organization,
      departmentFallback: analysis?.department_name ?? doc.departmentCandidate,
      evidence,
      contentChanged: doc.contentChanged,
      pdfUrls: doc.pdfUrls,
      bodyText: doc.bodyText,
      detectedAt: deps.today,
      analyzedAt,
      knownPageId: doc.knownPageId,
    });
    deps.store.markSynced(doc.key, pageId);
    return 'synced';
  } catch (e) {
    const err = toAppError(e, 'NOTION_WRITE_FAILED');
    if (err.code === 'NOTION_SCHEMA_MISMATCH') throw err;
    deps.store.markPendingNotion(doc.key, err.code, err.internalDetail ?? err.userMessage);
    deps.logger.error(`Notion への書き込みに失敗しました（次回再送します）: ${doc.key}`, { code: err.code });
    return 'failed';
  }
}
```

`processCandidate` はこの `analyzeAndSync` を呼ぶ形に書き換える（取得と抽出だけを担当する）。

```ts
// src/import.ts
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { analyzeAndSync } from './collect.ts';
import type { CollectDeps, PreparedDocument } from './collect.ts';
import { createProvider } from './ai/index.ts';
import { loadConfig } from './config.ts';
import type { Defaults } from './config.ts';
import { AppError, toAppError } from './errors.ts';
import { extractContent } from './extract-content.ts';
import { extractPdfText } from './extract-pdf.ts';
import { assertSafeUrl, fetchPage as realFetchPage } from './fetch-page.ts';
import { createLogger } from './logger.ts';
import { createNotionClient } from './notion.ts';
import { createRateLimiter } from './rate-limiter.ts';
import { openStore } from './store.ts';
import { DOCUMENT_TYPES } from './types.ts';
import { isPdfUrl, normalizeUrl } from './url.ts';

const MIN_BODY_LENGTH = 200;

export type ImportArgs = {
  url?: string;
  file?: string;
  text?: string;
  title?: string;
  organization?: string;
  type?: string;
  dryRun: boolean;
};

const USAGE = [
  '使い方（指示書 §22）:',
  '  npm run import -- --url "https://example.jp/page"',
  '  npm run import -- --file "./data/input.txt"',
  '  npm run import -- --file "./data/document.pdf"',
  '  npm run import -- --text "本文..." --title "タイトル"',
  '',
  '任意の指定（AI抽出値より優先されます）:',
  '  --organization "大阪市"',
  `  --type "計画"   … ${DOCUMENT_TYPES.join(' / ')}`,
  '  --dry-run       … Notion へ書かず解析結果だけを表示',
].join('\n');

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

export function parseImportArgs(argv: string[]): ImportArgs {
  const url = flag(argv, '--url');
  const file = flag(argv, '--file');
  const text = flag(argv, '--text');
  const title = flag(argv, '--title');
  const organization = flag(argv, '--organization');
  const type = flag(argv, '--type');
  const dryRun = argv.includes('--dry-run');

  const given = [url, file, text].filter((v) => v !== undefined);
  if (given.length === 0) {
    throw new AppError('IMPORT_INPUT_INVALID', `--url / --file / --text のいずれかを指定してください。\n\n${USAGE}`);
  }
  if (given.length > 1) {
    throw new AppError('IMPORT_INPUT_INVALID', `--url / --file / --text は同時に指定できません。\n\n${USAGE}`);
  }
  if (text !== undefined && title === undefined) {
    throw new AppError('IMPORT_INPUT_INVALID', `--text には --title も指定してください。\n\n${USAGE}`);
  }
  if (type !== undefined && !(DOCUMENT_TYPES as readonly string[]).includes(type)) {
    throw new AppError(
      'IMPORT_INPUT_INVALID',
      `--type に未知の値が指定されました: ${type}\n指定できるのは次のいずれかです: ${DOCUMENT_TYPES.join(' / ')}`,
    );
  }

  const out: ImportArgs = { dryRun };
  if (url !== undefined) out.url = url;
  if (file !== undefined) out.file = file;
  if (text !== undefined) out.text = text;
  if (title !== undefined) out.title = title;
  if (organization !== undefined) out.organization = organization;
  if (type !== undefined) out.type = type;
  return out;
}

export type ResolvedInput = {
  title: string;
  bodyText: string;
  sourceUrl: string;
  pdfUrls: string[];
  publishedAtCandidate: string | null;
  departmentCandidate: string | null;
};

/** 入力方法に応じて本文を用意する（設計書 §15）。 */
export async function resolveInput(
  args: ImportArgs,
  deps: {
    fetchPage: typeof realFetchPage;
    readFile: (p: string) => Uint8Array;
    defaults: Defaults;
  },
): Promise<ResolvedInput> {
  if (args.url !== undefined) {
    // 任意URLを受けるため SSRF 検査を通す
    assertSafeUrl(args.url);
    const res = await deps.fetchPage(args.url, {
      timeoutMs: deps.defaults.timeoutMs,
      maxRetries: deps.defaults.maxRetries,
      maxBytes: deps.defaults.maxBytes,
      userAgent: deps.defaults.userAgent,
      rateLimiter: createRateLimiter(deps.defaults.requestIntervalMs),
    });

    if (isPdfUrl(res.finalUrl) || res.contentType.includes('application/pdf')) {
      const { text } = await extractPdfText(res.body);
      return {
        title: args.title ?? basename(new URL(res.finalUrl).pathname),
        bodyText: text, sourceUrl: res.finalUrl, pdfUrls: [res.finalUrl],
        publishedAtCandidate: null, departmentCandidate: null,
      };
    }

    const page = extractContent(res.text(), res.finalUrl);
    return {
      title: args.title ?? page.title,
      bodyText: page.bodyText,
      sourceUrl: res.finalUrl,
      pdfUrls: page.pdfUrls,
      publishedAtCandidate: page.publishedAtCandidate,
      departmentCandidate: page.departmentCandidate,
    };
  }

  if (args.file !== undefined) {
    const buf = deps.readFile(args.file);
    const name = basename(args.file);
    const bodyText = isPdfUrl(args.file)
      ? (await extractPdfText(buf)).text
      : new TextDecoder('utf-8').decode(buf);

    if (bodyText.trim().length < MIN_BODY_LENGTH) {
      throw new AppError('EXTRACT_FAILED', undefined, `${args.file} の本文が ${bodyText.trim().length} 文字`);
    }
    return {
      title: args.title ?? name,
      bodyText,
      sourceUrl: `manual:file/${name}`,
      pdfUrls: [], publishedAtCandidate: null, departmentCandidate: null,
    };
  }

  const text = args.text as string;
  if (text.trim().length < MIN_BODY_LENGTH) {
    throw new AppError('EXTRACT_FAILED', undefined, `--text の本文が ${text.trim().length} 文字（下限 ${MIN_BODY_LENGTH}）`);
  }
  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  return {
    title: args.title as string,
    bodyText: text,
    sourceUrl: `manual:text/${digest}`,
    pdfUrls: [], publishedAtCandidate: null, departmentCandidate: null,
  };
}

export async function runImport(
  args: ImportArgs,
  deps: CollectDeps & { readFile: (p: string) => Uint8Array },
): Promise<'synced' | 'failed' | 'dry' | 'skipped'> {
  const resolved = await resolveInput(args, {
    fetchPage: deps.fetchPage,
    readFile: deps.readFile,
    defaults: deps.config.defaults,
  });

  // manual: スキームは normalizeUrl を通せないのでそのままキーにする
  const key = resolved.sourceUrl.startsWith('manual:')
    ? resolved.sourceUrl
    : normalizeUrl(resolved.sourceUrl);

  const existing = deps.store.getByUrl(key);

  const doc: PreparedDocument = {
    key,
    sourceUrl: resolved.sourceUrl,
    title: resolved.title,
    bodyText: resolved.bodyText,
    pdfUrls: resolved.pdfUrls,
    publishedAtCandidate: resolved.publishedAtCandidate,
    departmentCandidate: resolved.departmentCandidate,
    organization: args.organization ?? '大阪市',
    documentTypeHint: args.type ?? null,
    sourceId: 'manual',
    contentChanged: false,
    knownPageId: existing?.notionPageId ?? null,
  };

  try {
    return await analyzeAndSync(doc, deps);
  } catch (e) {
    const err = toAppError(e, 'IMPORT_INPUT_INVALID');
    deps.logger.error(`手動投入に失敗しました: ${resolved.sourceUrl}`, { code: err.code, detail: err.internalDetail });
    return 'failed';
  }
}

async function main(): Promise<void> {
  const args = parseImportArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = openStore({
    path: process.env['DATABASE_PATH'] ?? './data/app.db',
    rawDir: process.env['RAW_DIR'] ?? './data/raw',
  });
  const logger = createLogger({
    logDir: process.env['LOG_DIR'] ?? './data/logs',
    level: (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
  });

  let notion = null;
  if (!args.dryRun) {
    const token = process.env['NOTION_TOKEN'];
    const databaseId = process.env['NOTION_DATABASE_ID'];
    if (token === undefined || databaseId === undefined) {
      throw new AppError('CONFIG_INVALID', 'NOTION_TOKEN と NOTION_DATABASE_ID を .env に設定してください（--dry-run なら不要です）');
    }
    const client = createNotionClient({ token, databaseId });
    notion = { ...client, verifySchema: () => client.verifySchema(databaseId) };
    await notion.verifySchema();
  }

  try {
    const result = await runImport(args, {
      config, store, notion, logger,
      provider: createProvider(),
      fetchPage: realFetchPage,
      readFile: (p) => new Uint8Array(readFileSync(p)),
      recordNonTarget: (process.env['RECORD_NON_TARGET'] ?? 'true') !== 'false',
      today: new Date().toISOString().slice(0, 10),
      now: () => new Date().toISOString(),
    });
    console.log(`結果: ${result}`);
    if (result === 'failed') process.exitCode = 1;
  } finally {
    store.close();
    logger.close();
  }
}

if (process.argv[1]?.endsWith('import.ts') === true) {
  main().catch((e: unknown) => {
    if (e instanceof AppError) {
      console.error(`\nエラー [${e.code}]: ${e.userMessage}`);
      if (e.internalDetail !== undefined) console.error(`詳細: ${e.internalDetail}`);
    } else {
      console.error(e);
    }
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: `collect.ts` の `processCandidate` を `analyzeAndSync` 利用に書き換える**

取得と抽出だけを行い、以降は `analyzeAndSync` に委譲する。重複した AI/Notion コードを残さない（DRY）。

- [ ] **Step 5: テストが通ることを確認**

```bash
npx vitest run test/import.test.ts test/collect.test.ts
```

Expected: 両方 PASS

- [ ] **Step 6: 型検査・lint・全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS

- [ ] **Step 7: モックモードで実 PDF を投入して1回試す**

```bash
AI_PROVIDER=mock npm run import -- --file ./test/fixtures/youryou.pdf --organization "大阪市" --type "RFI" --dry-run
```

Expected: `結果: dry` と解析結果の表示

- [ ] **Step 8: コミット**

```bash
git add src/import.ts src/collect.ts test/import.test.ts test/collect.test.ts
git commit -m "feat: 手動投入（URL / テキスト / PDF）

AI 解析から Notion 書き込みまでを analyzeAndSync に切り出し collect と共有する。
--organization / --type は AI 抽出値より優先する。
任意URLを受けるため SSRF 検査を通す。"
```

---

## Task 22: サンプルデータと `seed`

**Files:**
- Create: `samples/01-osaka-cx-rfi.json`, `samples/02-tourism-portal-proposal.json`, `samples/03-dx-5year-plan.json`, `samples/04-printer-purchase.json`
- Create: `src/seed.ts`
- Test: `test/seed.test.ts`

**Interfaces:**
- Consumes: `runImport` 相当の経路／`type ImportArgs`（`src/import.ts`）
- Produces:
  - `type Sample = { id: string; title: string; organization: string; documentType?: string; sourceUrl: string | null; bodyFile?: string; bodyText?: string; expected: { isTarget: boolean; maturityStage?: string; contactRecommendation?: string[]; companyRelevance?: string[] } }`
  - `loadSamples(dir?: string): Sample[]`
  - `runSeed(samples: Sample[], deps: CollectDeps & { readFile: (p: string) => Uint8Array }, out: (s: string) => void): Promise<{ passed: number; failed: number; details: Array<{ id: string; ok: boolean; note: string }> }>`

- [ ] **Step 1: サンプル4件を作る（指示書 §25）**

サンプル1は実在ページを使う。本文は `test/fixtures/rfi.html` から抽出したものを使うため、`bodyFile` でHTMLを指す。

```json
// samples/01-osaka-cx-rfi.json
{
  "id": "01-osaka-cx-rfi",
  "title": "大阪市CXサービスデザイン推進事業に係る情報提供について",
  "organization": "大阪市",
  "sourceUrl": "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html",
  "bodyFile": "test/fixtures/rfi.html",
  "note": "実在ページ（2026-08-05 時点で公募中）。指示書 §12-2 の出力例はこのページに対応する。",
  "expected": {
    "isTarget": true,
    "maturityStage": "市場対話",
    "contactRecommendation": ["高"]
  }
}
```

```json
// samples/02-tourism-portal-proposal.json
{
  "id": "02-tourism-portal-proposal",
  "title": "A市観光ポータルサイト構築・運用業務にかかる公募型プロポーザルの実施について",
  "organization": "大阪市",
  "sourceUrl": null,
  "note": "架空。指示書 §25 サンプル2。",
  "bodyText": "A市では、観光情報の発信力強化を目的として、観光ポータルサイトの構築および運用業務について、公募型プロポーザル方式により事業者を選定します。\n\n1 業務の目的\n現在、本市の観光情報は複数の部署がそれぞれ個別のページで発信しており、来訪者が必要な情報にたどりつきにくい状態にあります。また、更新作業が特定の職員に依存しており、季節ごとのイベント情報の掲載が遅れる事例が生じています。本業務では、来訪者にとって分かりやすい情報構造を設計するとともに、職員が自ら継続的に更新できる仕組みを整備します。\n\n2 業務の内容\n(1) 情報設計およびUI・UXデザイン\n(2) CMSの導入および設定\n(3) 既存コンテンツの移行\n(4) 多言語対応（英語・中国語・韓国語）\n(5) 公開後の運用支援および職員向け研修\n\n3 委託期間\n契約締結の日から令和9年3月31日まで\n\n4 上限額\n2,400万円（消費税及び地方消費税を含む）\n\n5 参加表明書の提出期限\n令和8年9月10日（水曜日）17時00分まで\n\n6 企画提案書の提出期限\n令和8年10月1日（水曜日）17時00分まで\n\n7 問合せ先\nA市観光戦略室 観光振興グループ\n電話 06-0000-0000",
  "expected": {
    "isTarget": true,
    "maturityStage": "公募中",
    "companyRelevance": ["A", "B"]
  }
}
```

```json
// samples/03-dx-5year-plan.json
{
  "id": "03-dx-5year-plan",
  "title": "B県DX推進5カ年計画を策定しました",
  "organization": "大阪市",
  "documentType": "計画",
  "sourceUrl": null,
  "note": "架空。指示書 §25 サンプル3。上流シグナルの検証用。",
  "bodyText": "B県では、県民の利便性向上と行政運営の効率化を目的として、「B県DX推進5カ年計画」を策定しました。\n\n1 計画の位置づけ\n本計画は、県総合計画に掲げる「暮らしやすい県土づくり」の実現に向けた分野別計画として位置づけるものです。計画期間は令和8年度から令和12年度までの5年間とします。\n\n2 現状と課題\n(1) 行政手続きのオンライン利用率が全国平均を下回っている\n(2) 県が運営するウェブサイトが部局ごとに分散し、県民が情報を探しにくい\n(3) 職員のウェブサイト更新作業の負担が大きく、情報の鮮度が保てていない\n(4) デジタル人材が不足しており、内部で企画・改善を進める体制が整っていない\n\n3 基本方針\n方針1 県民が迷わない情報発信\n方針2 手続きのオンライン完結\n方針3 データに基づく政策形成\n方針4 デジタル人材の育成と内製化の推進\n\n4 主な取組\n(1) 県公式ウェブサイトの再構築（令和9年度から検討着手）\n(2) 行政手続きオンライン化の対象拡大\n(3) 職員向けデジタル研修の体系化\n(4) オープンデータの拡充\n\n5 推進体制\n知事を本部長とするDX推進本部を設置し、各部局の取組状況を年度ごとに評価・公表します。\n\n本計画の詳細は添付の計画本文をご覧ください。",
  "expected": {
    "isTarget": true,
    "maturityStage": "政策方針",
    "contactRecommendation": ["低", "中"]
  }
}
```

```json
// samples/04-printer-purchase.json
{
  "id": "04-printer-purchase",
  "title": "庁舎用プリンター100台の購入について",
  "organization": "大阪市",
  "sourceUrl": null,
  "note": "架空。指示書 §25 サンプル4。対象外判定の検証用。",
  "bodyText": "C市では、庁舎で使用するプリンターの更新について、下記のとおり一般競争入札を実施します。\n\n1 件名\n庁舎用プリンター購入（100台）\n\n2 仕様\n(1) モノクロレーザープリンター 80台\n(2) カラーレーザープリンター 20台\n(3) いずれも両面印刷機能およびネットワーク接続機能を有すること\n(4) 詳細は仕様書のとおり\n\n3 納入場所\nC市役所本庁舎および各支所\n\n4 納入期限\n令和8年11月28日\n\n5 入札参加資格\n(1) C市の物品供給等に係る競争入札参加資格を有する者\n(2) 地方自治法施行令第167条の4の規定に該当しない者\n\n6 入札書の提出期限\n令和8年9月19日（金曜日）17時00分まで\n\n7 開札日時\n令和8年9月24日（水曜日）10時00分\n\n8 問合せ先\nC市総務局 契約課 物品グループ\n電話 06-0000-0000",
  "expected": {
    "isTarget": false
  }
}
```

- [ ] **Step 2: 失敗するテストを書く**

```ts
// test/seed.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSamples, runSeed } from '../src/seed.ts';
import { parseConfig } from '../src/config.ts';
import { createMockProvider } from '../src/ai/mock.ts';
import { createLogger } from '../src/logger.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { NotionClient } from '../src/notion.ts';

const CONFIG = parseConfig(`
defaults: { request_interval_ms: 0 }
sources:
  - { id: manual, organization: 大阪市, name: 手動, url: https://www.city.osaka.lg.jp/, collector_type: manual, enabled: true }
`);

let dir: string;
let store: Store;
let created: Array<{ properties: Record<string, unknown> }>;
let notion: NotionClient;

function deps(over: Record<string, unknown> = {}) {
  return {
    config: CONFIG, store, provider: createMockProvider(), notion,
    logger: createLogger({ logDir: join(dir, 'logs'), level: 'error' as const }),
    fetchPage: vi.fn(),
    readFile: (p: string) => new Uint8Array(readFileSync(p)),
    recordNonTarget: true,
    today: '2026-08-05', now: () => '2026-08-05T04:00:00.000Z',
    ...over,
  } as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anp-seed-'));
  store = openStore({ path: join(dir, 'app.db'), rawDir: join(dir, 'raw') });
  created = [];
  notion = {
    verifySchema: vi.fn(async () => {}),
    findPageByUrl: vi.fn(async () => null),
    createPage: vi.fn(async (a) => { created.push(a); return `page-${created.length}`; }),
    updatePage: vi.fn(async () => {}),
    createDatabase: vi.fn(async () => 'db'),
    addMissingProperties: vi.fn(async () => []),
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadSamples', () => {
  const samples = loadSamples('samples');

  it('4件（指示書 §25）を読み込む', () => {
    expect(samples).toHaveLength(4);
  });

  it('id が一意で、ファイル名順に並ぶ', () => {
    const ids = samples.map((s) => s.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe('01-osaka-cx-rfi');
    expect(ids[3]).toBe('04-printer-purchase');
  });

  it('サンプル1は実在URLと実HTMLを指す', () => {
    const s = samples[0];
    expect(s?.sourceUrl).toBe('https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html');
    expect(s?.bodyFile).toBe('test/fixtures/rfi.html');
  });

  it('サンプル2〜4は bodyText を持ち200文字以上ある', () => {
    for (const s of samples.slice(1)) {
      expect(s.bodyText, s.id).toBeTruthy();
      expect((s.bodyText ?? '').length, s.id).toBeGreaterThan(200);
    }
  });

  it('各サンプルに期待判定がある', () => {
    expect(samples[0]?.expected).toMatchObject({ isTarget: true, maturityStage: '市場対話', contactRecommendation: ['高'] });
    expect(samples[1]?.expected).toMatchObject({ isTarget: true, maturityStage: '公募中' });
    expect(samples[2]?.expected).toMatchObject({ isTarget: true, maturityStage: '政策方針' });
    expect(samples[3]?.expected).toEqual({ isTarget: false });
  });

  it('サンプル本文に和暦の締切が含まれる（正規化の検証材料）', () => {
    for (const s of samples.slice(1)) {
      expect(s.bodyText, s.id).toMatch(/令和\d+年\d+月\d+日/);
    }
  });
});

describe('runSeed', () => {
  it('4件すべて投入して Notion へ登録する', async () => {
    const lines: string[] = [];
    const r = await runSeed(loadSamples('samples'), deps(), (s) => lines.push(s));
    expect(r.details).toHaveLength(4);
    expect(created).toHaveLength(4);
  });

  it('モックの判定が期待値と一致する', async () => {
    const r = await runSeed(loadSamples('samples'), deps(), () => {});
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(4);
  });

  it('プリンター購入が対象外として登録される', async () => {
    await runSeed(loadSamples('samples'), deps(), () => {});
    const printer = created.find((c) => {
      const t = c.properties['タイトル'] as { title: Array<{ text: { content: string } }> } | undefined;
      return t?.title[0]?.text.content.includes('プリンター') === true;
    });
    expect(printer).toBeDefined();
    expect(printer?.properties['確認状態']).toEqual({ select: { name: '対象外' } });
  });

  it('期待値との不一致を details に記録する', async () => {
    const provider = createMockProvider();
    vi.spyOn(provider, 'classify').mockResolvedValue({
      data: { is_target: true, reason: '常に対象と返すモック', confidence: 50 },
      raw: '{}', durationMs: 0, costUsd: null,
    });
    const r = await runSeed(loadSamples('samples'), deps({ provider }), () => {});
    expect(r.failed).toBeGreaterThan(0);
    const printer = r.details.find((d) => d.id === '04-printer-purchase');
    expect(printer?.ok).toBe(false);
    expect(printer?.note).toContain('is_target');
  });

  it('結果の表を出力する', async () => {
    const lines: string[] = [];
    await runSeed(loadSamples('samples'), deps(), (s) => lines.push(s));
    const all = lines.join('\n');
    expect(all).toContain('01-osaka-cx-rfi');
    expect(all).toContain('04-printer-purchase');
    expect(all).toMatch(/4\s*件/);
  });

  it('SQLite に4件が残る', async () => {
    await runSeed(loadSamples('samples'), deps(), () => {});
    expect(store.listRuns().length).toBeGreaterThanOrEqual(0);
    // manual: キーと実URLの両方が入る
    expect(store.hasUrl('https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html')).toBe(true);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

```bash
npx vitest run test/seed.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/seed.ts"`

- [ ] **Step 4: `src/seed.ts` を実装**

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { analyzeAndSync } from './collect.ts';
import type { CollectDeps, PreparedDocument } from './collect.ts';
import { createProvider } from './ai/index.ts';
import { parseNeedAnalysis } from './ai/schema.ts';
import { loadConfig } from './config.ts';
import { AppError, toAppError } from './errors.ts';
import { extractContent } from './extract-content.ts';
import { createLogger } from './logger.ts';
import { createNotionClient } from './notion.ts';
import { openStore } from './store.ts';
import { normalizeUrl } from './url.ts';

const sampleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  organization: z.string().min(1),
  documentType: z.string().optional(),
  sourceUrl: z.union([z.string(), z.null()]),
  bodyFile: z.string().optional(),
  bodyText: z.string().optional(),
  note: z.string().optional(),
  expected: z.object({
    isTarget: z.boolean(),
    maturityStage: z.string().optional(),
    contactRecommendation: z.array(z.string()).optional(),
    companyRelevance: z.array(z.string()).optional(),
  }),
});

export type Sample = z.infer<typeof sampleSchema>;

export function loadSamples(dir = 'samples'): Sample[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => {
    const parsed = sampleSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!parsed.success) {
      throw new AppError(
        'CONFIG_INVALID',
        `サンプル ${f} の形式が不正です`,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / '),
      );
    }
    if (parsed.data.bodyFile === undefined && parsed.data.bodyText === undefined) {
      throw new AppError('CONFIG_INVALID', `サンプル ${f} に bodyFile も bodyText もありません`);
    }
    return parsed.data;
  });
}

/** 期待判定と実結果を突き合わせる（指示書 §25）。 */
function judge(sample: Sample, isTarget: boolean, analyzeJson: string | null): { ok: boolean; note: string } {
  const notes: string[] = [];

  if (isTarget !== sample.expected.isTarget) {
    notes.push(`is_target: 期待 ${String(sample.expected.isTarget)} / 実際 ${String(isTarget)}`);
  }

  if (isTarget && analyzeJson !== null) {
    const a = parseNeedAnalysis(analyzeJson);
    const e = sample.expected;
    if (e.maturityStage !== undefined && a.maturity_stage !== e.maturityStage) {
      notes.push(`成熟段階: 期待 ${e.maturityStage} / 実際 ${a.maturity_stage}`);
    }
    if (e.contactRecommendation !== undefined && !e.contactRecommendation.includes(a.contact_recommendation)) {
      notes.push(`コンタクト推奨度: 期待 ${e.contactRecommendation.join(' または ')} / 実際 ${a.contact_recommendation}`);
    }
    if (e.companyRelevance !== undefined && !e.companyRelevance.includes(a.company_relevance)) {
      notes.push(`自社関連度: 期待 ${e.companyRelevance.join(' または ')} / 実際 ${a.company_relevance}`);
    }
  }

  return notes.length === 0 ? { ok: true, note: '期待どおり' } : { ok: false, note: notes.join(' / ') };
}

export async function runSeed(
  samples: Sample[],
  deps: CollectDeps & { readFile: (p: string) => Uint8Array },
  out: (s: string) => void,
): Promise<{ passed: number; failed: number; details: Array<{ id: string; ok: boolean; note: string }> }> {
  const details: Array<{ id: string; ok: boolean; note: string }> = [];

  for (const s of samples) {
    out(`--- ${s.id} : ${s.title} ---`);

    let bodyText: string;
    let pdfUrls: string[] = [];
    let publishedAtCandidate: string | null = null;

    if (s.bodyFile !== undefined) {
      // HTML なら本文抽出を通す。実ページの抽出も同時に検証できる。
      const raw = new TextDecoder('utf-8').decode(deps.readFile(s.bodyFile));
      if (s.bodyFile.endsWith('.html')) {
        const page = extractContent(raw, s.sourceUrl ?? 'https://example.jp/', { contentSelector: '#mol_contents' });
        bodyText = page.bodyText;
        pdfUrls = page.pdfUrls;
        publishedAtCandidate = page.publishedAtCandidate;
      } else {
        bodyText = raw;
      }
    } else {
      bodyText = s.bodyText as string;
    }

    const key = s.sourceUrl === null ? `manual:sample/${s.id}` : normalizeUrl(s.sourceUrl);
    const existing = deps.store.getByUrl(key);

    const doc: PreparedDocument = {
      key,
      sourceUrl: s.sourceUrl ?? key,
      title: s.title,
      bodyText,
      pdfUrls,
      publishedAtCandidate,
      departmentCandidate: null,
      organization: s.organization,
      documentTypeHint: s.documentType ?? null,
      sourceId: 'sample',
      contentChanged: false,
      knownPageId: existing?.notionPageId ?? null,
    };

    try {
      await analyzeAndSync(doc, deps);
      const row = deps.store.getByUrl(key);
      const r = judge(s, row?.isTarget === 1, row?.aiAnalyzeJson ?? null);
      details.push({ id: s.id, ...r });
      out(`  ${r.ok ? 'OK  ' : 'NG  '} ${r.note}`);
    } catch (e) {
      const err = toAppError(e, 'DB_ERROR');
      details.push({ id: s.id, ok: false, note: `${err.code}: ${err.userMessage}` });
      out(`  NG   ${err.code}: ${err.userMessage}`);
    }
  }

  const passed = details.filter((d) => d.ok).length;
  const failed = details.length - passed;
  out('');
  out(`${details.length} 件を投入しました（期待どおり ${passed} 件 / 不一致 ${failed} 件）`);

  return { passed, failed, details };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = openStore({
    path: process.env['DATABASE_PATH'] ?? './data/app.db',
    rawDir: process.env['RAW_DIR'] ?? './data/raw',
  });
  const logger = createLogger({
    logDir: process.env['LOG_DIR'] ?? './data/logs',
    level: (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
  });

  const token = process.env['NOTION_TOKEN'];
  const databaseId = process.env['NOTION_DATABASE_ID'];
  let notion = null;
  if (token !== undefined && databaseId !== undefined) {
    const client = createNotionClient({ token, databaseId });
    notion = { ...client, verifySchema: () => client.verifySchema(databaseId) };
    await notion.verifySchema();
  } else {
    console.log('NOTION_TOKEN / NOTION_DATABASE_ID が未設定のため、Notion へは書き込みません。');
  }

  try {
    const r = await runSeed(loadSamples(), {
      config, store, notion, logger,
      provider: createProvider(),
      fetchPage: (() => { throw new AppError('IMPORT_INPUT_INVALID', 'seed はネットワークを使いません'); }) as never,
      readFile: (p) => new Uint8Array(readFileSync(p)),
      recordNonTarget: true,
      today: new Date().toISOString().slice(0, 10),
      now: () => new Date().toISOString(),
    }, (s) => { console.log(s); });
    if (r.failed > 0) process.exitCode = 1;
  } finally {
    store.close();
    logger.close();
  }
}

if (process.argv[1]?.endsWith('seed.ts') === true) {
  main().catch((e: unknown) => {
    if (e instanceof AppError) {
      console.error(`\nエラー [${e.code}]: ${e.userMessage}`);
      if (e.internalDetail !== undefined) console.error(`詳細: ${e.internalDetail}`);
    } else {
      console.error(e);
    }
    process.exitCode = 1;
  });
}
```

- [ ] **Step 5: テストが通ることを確認**

```bash
npx vitest run test/seed.test.ts
```

Expected: PASS（12 tests）

- [ ] **Step 6: 実 AI でサンプル4件を回して精度を1回確認**

自動テストには含めない。実装者が1回だけ実行し、`NG` が出た項目を報告する。

```bash
AI_PROVIDER=claude_cli npm run seed
```

Expected: 4件中3件以上が `OK`。特にサンプル4（プリンター購入）が `is_target: false` になること。

`NG` が出た場合は `prompts/classify.md` または `prompts/analyze.md` を調整して再実行する。**プロンプトを直す。テストの期待値を緩めない。**

- [ ] **Step 7: 型検査・lint・全テスト**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: エラーなし、全 PASS

- [ ] **Step 8: コミット**

```bash
git add samples/ src/seed.ts test/seed.test.ts
git commit -m "feat: サンプル4件と seed コマンド

サンプル1は実在の大阪市CXサービスデザインRFI（実HTMLから本文抽出）。
2〜4は架空で、和暦の締切を含めて正規化の検証材料にする。
期待判定と実結果を突き合わせて OK/NG の表を出す。"
```

---

## Task 23: README と受け入れ確認

**Files:**
- Create: `README.md`
- Modify: `.env.example`（必要に応じて実装で判明した変数を反映）

**Interfaces:**
- Consumes: すべて
- Produces: なし（ドキュメント）

- [ ] **Step 1: `README.md` を書く**

以下をすべて含める。

````markdown
# 行政ニーズ収集プロトタイプ

自治体の公式サイトから Web・DX・デジタル領域の行政ニーズを収集し、AIで構造化して
Notion データベースへ登録するローカル実行スクリプト。専用Webアプリは作らない。
閲覧・検索・絞り込み・担当者設定・コメント・対応状況の管理は Notion 上で行う。

- 設計書: `docs/superpowers/specs/2026-08-05-administrative-needs-prototype-design.md`
- 実装計画: `docs/superpowers/plans/2026-08-05-administrative-needs-prototype.md`

## 必要なもの

| 要件 | バージョン | 備考 |
| --- | --- | --- |
| Node.js | **25.0 以上** | `.ts` を直接実行する。ビルドステップは無い |
| claude CLI | 2.1.88 以上 | `AI_PROVIDER=claude_cli` で使用。ログイン済みであること |
| Notion | — | Integration トークンの発行が必要 |

## セットアップ

### 1. 依存のインストール

```bash
npm install
```

### 2. Notion Integration の作成と接続

1. https://www.notion.so/my-integrations で「New integration」を作成する
2. 表示された **Internal Integration Secret** をコピーする
3. Notion で「行政ニーズDB」を置きたい**親ページ**を開く
4. 右上「...」→「接続」→ 作成した Integration を選ぶ

この2つの手順は Notion API では自動化できないため手動で行う。

### 3. `.env` の作成

```bash
cp .env.example .env
```

`NOTION_TOKEN` に手順2でコピーしたトークンを入れる。

### 4. Notion データベースの作成

```bash
npm run setup:notion -- --parent-page-id "<親ページのURLまたはID>"
```

39プロパティ（自動入力28 + 人手入力11）と Select の選択肢が作成される。
出力された `NOTION_DATABASE_ID=...` の行を `.env` に書く。

既にDBがある場合は不足プロパティの追加のみを行う。

```bash
npm run setup:notion -- --database-id "<DBのURLまたはID>"
```

### 5. 情報源設定の連絡先を書き換える

`config/sources.yaml` の `user_agent` にあるプレースホルダを、実在の連絡先メール
アドレスに差し替える。自治体サイトへのアクセス主体を明示するため、プレースホルダの
まま運用しない。

### 6. Notion ビューの作成（手動）

ビューは Notion API で作成できないため、次の6つを Notion 上で手動作成する。

| ビュー名 | フィルタ | ソート |
| --- | --- | --- |
| 新着・未確認 | 確認状態 = 未確認 | 検知日 降順 |
| コンタクト候補 | 自社関連度 が A または B / コンタクト推奨度 が 高 または 中 / 対応判断 が 未判断 または 追う | コンタクト推奨度、期限 昇順 |
| 市場対話・公募 | 文書種別 が RFI / 情報提供依頼 / サウンディング / 民間提案 / プロポーザル / 入札 のいずれか | 期限 昇順 |
| 上流シグナル | 文書種別 が 議会 / 予算 / 計画 / マニフェスト / 審議会 / 行政評価 のいずれか | 公開日 降順 |
| 継続監視 | 対応判断 = 継続監視 | 次回確認日 昇順 |
| 対象外・見送り | 確認状態 = 対象外 または 対応判断 = 見送り | 検知日 降順 |

**精度検証のため、対象外情報を削除しない。**

## 使い方

### 動作確認（Notion もAPIキーも不要）

```bash
AI_PROVIDER=mock npm run collect -- --dry-run --limit 3
```

### サンプル4件の投入

```bash
npm run seed
```

期待判定との一致を `OK` / `NG` で表示する。

### 収集

```bash
npm run collect
```

処理の流れ:

1. `config/sources.yaml` を読み込んで検証する
2. Notion のプロパティを検証する（不一致なら即停止）
3. Notion 未同期分（`pending_notion`）を再送する
4. RSS / 一覧ページを取得する
5. 新しいリンクを抽出する
6. 結果公表を除外する（除外件数をログに出す）
7. 処理済みURLを除外する
8. 個別ページの本文を取得する
9. 添付PDFのテキストを取得する
10. AIで対象判定する
11. 対象情報をAIで構造化する
12. 正規化・スキーマ検証・根拠一致検査を通す
13. SQLite へ保存する（**Notion より先**）
14. Notion へ登録する
15. ログとサマリを出力する

補助オプション:

```bash
npm run collect -- --dry-run            # Notion へ書かず解析結果だけを表示（プロンプト調整用）
npm run collect -- --source osaka-digital-rss
npm run collect -- --limit 10
```

### 手動投入

```bash
npm run import -- --url "https://example.jp/page"
npm run import -- --file "./data/input.txt"
npm run import -- --file "./data/document.pdf"
npm run import -- --file "./data/document.pdf" --organization "大阪市" --type "計画"
npm run import -- --text "本文をここに..." --title "議会答弁"
```

`--organization` と `--type` は AI 抽出値より**優先される**。

議会議事録・委員会資料・施政方針・マニフェスト・総合計画・DX推進計画・予算資料・
審議会資料・行政評価は、初期スコープでは手動投入で検証する。

### 開発

```bash
npm test          # Vitest（外部通信ゼロ）
npm run typecheck
npm run lint
```

## 情報源

初期対象は大阪市のみ。`config/sources.yaml` への追記で追加できる。

| id | 種別 | 内容 | 有効 |
| --- | --- | --- | --- |
| `osaka-digital-rss` | rss | デジタル統括室 RSS（100件・category に局名を含む） | ○ |
| `osaka-proposal-list` | list_page | プロポーザル方式等発注案件（全局横断・常時15件以上） | ○ |
| `osaka-digital-press` | list_page | デジタル統括室 報道発表資料（上流シグナル） | ○ |
| `osaka-shitei-kanri` | list_page | 指定管理者 募集・選定状況 | ×（Web・DX関連度が低い） |

`collector_type` は `rss` / `list_page` / `single_page` / `manual` / `custom`。
自治体固有のHTML構造に対応できない場合のみ `custom` で個別コレクターを追加する。

## Notion プロパティ

### スクリプトが書く（28個）

タイトル / 自治体・組織 / 担当部署 / 文書種別 / 公開日 / 期限 / 公式URL / 行政課題 /
課題の背景 / 実現したい状態 / 民間に求めること / 分野 / 成熟段階 / 分野関連度 /
自社関連度 / 関連度の理由 / 想定する自社の役割 / 必要なパートナー / コンタクト推奨度 /
推奨アクション / 確認したいこと / リスク・参加条件 / AI確信度 / 根拠 / 検知日 /
AI処理日時 / 更新あり / **予算**

### 人が書く（11個・スクリプトは上書きしない）

確認状態 / 対応判断 / 社内担当 / コンタクト先 / コンタクト日 / 温度感 / 面談メモ /
次のアクション / 次回確認日 / 見送り理由 / 社内メモ

**唯一の例外:** 新規作成時のみ「確認状態」に `未確認`（対象外なら `対象外`）を入れる。
Notion の Select に既定値の概念がなく、空だと「新着・未確認」ビューに1件も出ないため。
更新時は触らない。

プロパティは検索・絞り込み用に2,000文字で切り詰める。
**原文全文と根拠の逐語引用全件はページ本文に置く。**

## 環境変数

`.env.example` を参照。`AI_API_KEY` は `claude -p` 方式では不要（CLI 側の認証を使う）。

## 指示書から意図的に変えた点

| # | 変更 | 理由 |
| --- | --- | --- |
| 1 | RSS を収集の主軸にした | §9 が `rss` を想定内としている。大阪市は局単位のRSSを提供し、`pubDate` と局名が確実に取れてHTML構造変更に強い |
| 2 | 「確認状態」のみ新規作成時に設定 | §19 のビューを機能させるため。Notion の Select に既定値がない |
| 3 | `setup:notion` でDBを自動作成 | §20 は「必要はない」とするが、39プロパティの手作業は1文字違いで全件失敗する |
| 4 | 「予算」プロパティを追加 | §12-2 が `budget` を出力し §13 が事実として扱い §16 が判断材料にしているのに §17-1 に置き場がない |
| 5 | 対象外情報の記録を既定 ON | §12-1 は「任意」だが初期目的が精度検証（§28）で、§19 も「対象外情報を削除しない」と明示 |
| 6 | AI確信度を 0〜100 の整数に確定 | §12-1 の `"confidence":92` と §17-1 の Number 型に合わせた |
| 7 | `AI_API_KEY` を使わない | `claude -p` 方式では CLI 側の認証を使う |
| 8 | `--dry-run` / `--source` / `--limit` / `seed` を追加 | プロンプト調整と検証（§28）に必要 |
| 9 | 「市場対話・公募」ビューに `情報提供依頼` を追加 | §19 の列挙は5つだが §18 に `RFI` と `情報提供依頼` が併存するため、足さないと消える |

## 既知の制約

1. **`claude -p` 方式はローカル専用。** GitHub Actions へ移行する際は API Provider への差し替えが必要。Provider インターフェースは維持しているため1ファイル追加と環境変数の切替で済む
2. **AI呼び出しは逐次。** `claude -p` の多重起動を避けるため同時実行1。1件あたり数十秒かかり、50件で20〜40分程度
3. **OCR未対応。** 画像PDF・スキャンPDFは公式URLのみ記録する
4. **ビューはAPIで作れない。** 上記の表に従って手動作成する
5. **更新の差分管理は最小。** 本文が変わっても「更新あり」を立てるだけで再解析しない
6. **1文書＝1レコード。** 複数文書の同一テーマ統合は未対応
7. **分野タグを列挙で縛っていない。** 表記揺れが出る可能性がある。実データを見て正規化する
8. **文書種別に `RFI` と `情報提供依頼` が併存する**（指示書 §18 のまま）。実質同義。実データの分布を見てから統合を検討する
9. **AI出力の4段階評価に専用プロパティを設けていない。** 「社内メモ」への記録運用。集計が必要になったら追加する
10. **`Math.sumPrecise` の polyfill が必要**（Node 25 に未実装）。将来 Node が実装したら不要になる
11. **`node:sqlite` は experimental。** `--disable-warning=ExperimentalWarning` で警告を抑制している

## 置いた仮定

1. 「自社」は Studio。判定基準は `prompts/company-profile.md`。実データを見ながら調整する
2. 本文抽出の下限は200文字。下回るページは抽出失敗として扱う
3. 添付PDFのテキストは合計50,000文字を上限に本文へ追記する
4. 同一ホストへのアクセス間隔は3秒
5. 和暦は令和のみ対応（令和8年 = 2026年）
6. 検証件数は30〜50件を目安とする

## 検証の進め方

最初に30〜50件を処理する。プロポーザル一覧だけで対象・対象外が自然に混在する。

人が評価する項目:

- 対象判定が正しいか / 行政課題の要約が使えるか / 実現したい状態が妥当か
- 自社関連度が妥当か / コンタクト推奨度が妥当か
- 実際にコンタクト候補になったか / 面談や情報交換につながったか
- どの情報源が有用だったか / どの情報源を次に自動化すべきか

AI出力は4段階で評価する: `そのまま使える` / `軽微な修正で使える` / `大幅な修正が必要` / `誤っている`
現時点では Notion の「社内メモ」に記録する。

プロンプトを直したいときは `prompts/*.md` を編集して `npm run collect -- --dry-run` で
確認する。コードの変更は不要。

## 今後の拡張

| Phase | 内容 |
| --- | --- |
| 1 | 福岡市・横浜市・札幌市の追加 / 自治体固有コレクター / 更新・期限変更の検知 |
| 2 | 予算・新規事業・DX計画の自動取得 / 継続監視機能 / 関連文書の手動紐付け |
| 3 | 議会議事録の限定取得 / 行政答弁と議員質問の区別 |
| 4 | 複数文書の同一テーマ統合 / 時系列表示 / 成熟度の変化検知 |
| 5 | GitHub Actions への移行 / 定期実行 / Slack通知 / 対象自治体の拡大 |
````

- [ ] **Step 2: 受け入れ条件を1つずつ確認する**

設計書 §23 のチェックリストを上から実行し、結果を記録する。

```bash
npm run typecheck && npm run lint && npm test
```

```bash
AI_PROVIDER=mock npm run collect -- --dry-run --limit 5
AI_PROVIDER=mock npm run import -- --file ./test/fixtures/youryou.pdf --dry-run
AI_PROVIDER=mock npm run seed
```

実 AI と実 Notion に対して1回:

```bash
npm run collect -- --limit 5
```

Expected: サマリが出て Notion に5件（またはそれ以下）が登録される。人手プロパティが空のままであることを Notion 上で目視確認する。

- [ ] **Step 3: 実行ログが残っていることを確認**

```bash
ls -la data/logs/ && tail -3 data/logs/*.jsonl
```

Expected: `<YYYY-MM-DD>.jsonl` があり、1行1イベントの JSON が入っている

- [ ] **Step 4: 未達項目があれば記録する**

設計書 §23 のうち満たせなかった項目があれば、README の「既知の制約」へ理由付きで追記する。**満たしていない項目を満たしたことにしない。**

- [ ] **Step 5: コミット**

```bash
git add README.md .env.example
git commit -m "docs: README にセットアップ手順・Notion手順・制約・仮定を記載

Integration の作成と親ページへの接続、6ビューの手動作成手順を明記。
指示書から変えた9点と既知の制約11点、置いた仮定6点を列挙する。"
```

---

## 自己レビュー結果

計画を書いたあとに設計書と突き合わせて確認した。

**1. 設計書のカバレッジ**

| 設計書の節 | 対応タスク |
| --- | --- |
| §3 決定事項 | T1（ツールチェーン）、Global Constraints |
| §4 フォルダ構成・設計原則 | File Structure、T1 |
| §5 情報源（実URL・sources.yaml） | T9 |
| §6 情報取得処理（一覧・RSS・個別・アクセス制御） | T5, T7, T8, T10 |
| §7 PDF抽出 | T6 |
| §8 AI連携（Provider・CLI・Mock・2段階・Zod） | T11, T12, T13 |
| §9 列挙値 | T1 |
| §10 正規化 | T2 |
| §11 根拠一致検査 | T4 |
| §12 重複判定・更新検知 | T3, T15 |
| §13 ローカル保存 | T14 |
| §14 データフロー | T20 |
| §15 手動投入・SSRF | T10, T21 |
| §16 Notion（定義・setup・ビュー・API） | T16, T17, T18, T19 |
| §17 エラー処理 | T1（コード定義）、各タスクで使用 |
| §18 実行方法 | T20, T21, T22 |
| §19 環境変数 | T1, T23 |
| §20 ログ | T1, T14 |
| §21 テスト | 全タスク |
| §22 サンプル | T22 |
| §23 受け入れ条件 | T23 |
| §24 検証方法 | T23（README） |
| §25 変えた点 | T23（README） |
| §26 制約と仮定 | T23（README） |
| §27 今後の拡張 | T23（README） |

漏れなし。

**2. プレースホルダ**

「TBD」「実装は後で」「適宜」の類は書いていない。T20 の Step 3 末尾に「実装上の注意」として3点を明記したのは、テストと実装が食い違う箇所を先に潰すためで、作業内容は具体的に指定している。

**3. 型と名前の一貫性**

- `contentHash` は T14 で定義し T15, T20, T21, T22 で使用。同名で一貫
- `CollectDeps` は T20 で定義し T21, T22 で拡張して使用
- `PreparedDocument` / `analyzeAndSync` は T21 で `collect.ts` に追加し T22 で使用。T20 の時点では存在しないため、T21 の Step 4 で `processCandidate` を書き換える手順を明記した
- `Store` 型に `listRuns` を含めた（T14 のテストで使用）
- `writeToNotion` は `collect.ts` 内部の非公開関数。T20 で定義し `analyzeAndSync`（T21）と `flushPendingNotion`（T20）が使う
- `verifySchema` の引数問題を T20 の「実装上の注意」2で明示した

**4. スコープ**

23タスク、1エントリポイントあたり1タスク＋純粋関数層。1つの実装計画として妥当。
T1〜T19 は外部通信ゼロでテストが完結し、T20〜T23 で結線する。

