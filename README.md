# 行政ニーズ収集プロトタイプ

自治体の行政ニーズを収集する前段として、**どの自治体の、どの公式ページを監視候補にするか**を管理する最小実装です。

現段階では通常の収集処理、Notionの既存ページ更新、定期実行は行いません。`config/sources.yaml` の編集・検証・一覧表示に加え、登録したRSS・一覧ページの技術的な疎通、候補抽出、個別ページとPDFの本文抽出、取得本文1件のAI判定、Notionデータベース構成の読み取り確認、選定済み1件のNotion登録、選定URLファイル最大20件の直列バッチを手動実行できます。

## セットアップ

Node.js 25以上を使用します。

```bash
npm install
cp .env.example .env
```

台帳の検証とMockテストだけなら認証情報は不要です。実AI判定には認証済みのClaude CLI、Notion接続・登録には`.env`の`NOTION_TOKEN`が必要です。`.env`はGit管理対象外です。

## ディレクトリ構成

```text
config/             情報源台帳と自社適合度判定基準
prompts/            AI判定プロンプト
src/commands/       手動実行するCLIエントリーポイント
src/source-registry 台帳の読み込み・検証
src/source-check/   情報源の疎通・候補抽出
src/content-check/  個別HTMLページの本文抽出
src/pdf-check/      PDF本文抽出
src/ai/             Claude CLI／Mockによる判定・構造化
src/notion-check/   Notion接続とスキーマの読み取り確認
src/notion-register Notionへの1件登録プレビュー・重複防止
src/notion-batch    選定URLファイルの直列プレビュー・登録
test/               外部アクセスを行わない単体テストとfixture
docs/               初期設計・将来構想の資料
```

AI経由で情報源を追加する場合は、最初に`AGENTS.md`と`config/README.md`を読ませてください。Pull Requestでは`.github/pull_request_template.md`の確認項目を使用します。

## 基本操作

台帳の整合性を検証します。

```bash
npm run sources:validate
```

登録内容を一覧表示します。

```bash
npm run sources:list
npm run sources:list -- --enabled
npm run sources:list -- --organization osaka-city
npm run sources:list -- --priority high
```

登録した情報源を実際に確認します。

```bash
npm run sources:check -- --source osaka-digital-rss
npm run sources:check -- --enabled
npm run sources:check -- --all --limit 3
npm run sources:check -- --source osaka-digital-rss --output
```

このコマンドは外部サイトへアクセスします。`--output` は任意で、保存先を省略すると `data/logs/source-check/osaka-digital-rss.json` のような固定パスへ保存し、再確認時は上書きします。安全対策、保存運用、結果の見方、制約は `src/source-check/README.md` を参照してください。

候補となった個別ページから本文を抽出できるか確認します。

```bash
npm run content:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

このコマンドも外部サイトへアクセスします。`--full` で本文全文を表示し、`--output` でプレビューと確認結果だけを情報源ごとの固定パスへ任意保存できます。詳細は `src/content-check/README.md` を参照してください。

個別ページで見つけたPDFからテキストを抽出できるか確認します。

```bash
npm run pdf:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000684/684546/01_youryou5.pdf"
```

`--full` で抽出全文を表示し、`--output` でメタデータ・警告・500文字のプレビューだけを情報源ごとの固定パスへ任意保存できます。PDFファイルと抽出全文は保存しません。詳細は `src/pdf-check/README.md` を参照してください。

保存JSONは実行履歴ではなく最新状態です。同じ情報源・同じチェック種別は、URLが異なる場合も同じファイルを上書きします。したがって実行回数や日数では増えず、標準保存先を使う限りファイル数は台帳の情報源数に比例します。全国規模で継続履歴が必要になった段階では、JSONを増やさずデータベースなどへ移行します。

取得したHTMLと添付PDFを1回のAI問い合わせで判定・構造化します。

```bash
npm run ai:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

初期ProviderはClaude CLIです。テスト用Mockは `AI_PROVIDER=mock`、JSONだけを標準出力する場合は `--json`、PDFを送信しない場合は `--no-pdf` を指定します。AI結果は保存しません。実行前に公開文書であることと `config/company-fit-criteria.yaml` を確認してください。詳細は `src/ai/README.md` を参照してください。

Notionデータベースと配下のデータソース構成を読み取り確認します。

```bash
npm run notion:check -- \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

`--database-id`でも指定できます。`.env`の`NOTION_TOKEN`を使用し、データベース名、全データソース、プロパティ名・ID・種類を表示します。ページやスキーマの作成・更新・削除は行いません。詳細は `src/notion-check/README.md` を参照してください。

選定済みの公式ページ1件を実Claudeで解析し、Notion登録内容をプレビューします。

```bash
npm run notion:register -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html" \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

デフォルトでは書き込みません。`--write`を明示した場合だけ、スキーマ、既存のselect選択肢、公式URL重複を確認して1ページを作成します。詳細は `src/notion-register/README.md` を参照してください。

人が選定したURLファイルを1件ずつ直列に処理します。

```bash
AI_PROVIDER=claude_cli npm run notion:batch -- \
  --source osaka-digital-rss \
  --file "./data/selected-urls.txt" \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

デフォルトは全件プレビューです。プレビュー確認後に`--write`を明示した場合だけ未登録URLを作成し、重複URLはHTML・PDF取得とClaude解析の前にスキップします。詳細は `src/notion-batch/README.md` を参照してください。

品質チェックは以下で実行できます。

```bash
npm run lint
npm run typecheck
npm test
```

## 台帳の構造

`config/sources.yaml` は、組織と情報源を分けて管理します。1つの組織に複数の情報源を紐付けられます。

```yaml
version: 1
organizations:
  - id: osaka-city
    name: 大阪市
    organization_type: designated_city
    official_domain: city.osaka.lg.jp
    enabled: true

sources:
  - id: osaka-proposal-list
    organization_id: osaka-city
    name: プロポーザル方式等発注案件
    url: https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/0-Curr.html
    collector_type: list_page
    source_category: procurement
    priority: high
    enabled: true
```

現在は大阪市のみを対象とし、次の4情報源を登録しています。

- デジタル統括室 RSS（有効）
- プロポーザル方式等発注案件（有効）
- デジタル統括室 報道発表資料（有効）
- 指定管理者 募集・選定状況（参考・無効）

`enabled: false` は削除ではありません。監視候補として記録を残しつつ、後続処理の対象外にできます。

## 情報源を追加する

既存自治体に情報源を追加する場合:

1. `sources` に新しい項目を追加する。
2. 重複しない `id` と、既存の `organization_id` を指定する。
3. 公式URL、取得方式候補、分類、優先度、有効・無効を設定する。
4. `npm run sources:validate` を実行する。
5. `npm run sources:list` で表示を確認する。

新しい自治体を追加する場合:

1. `organizations` に組織を追加する。
2. 重複しない `id`、組織種別、公式ドメインを設定する。
3. `sources` に1つ以上の情報源を追加し、新しい組織IDを参照させる。
4. 検証と一覧表示を実行する。

URLは推測で登録せず、人が公式サイトで確認したものだけを記録してください。確認日を `last_verified_at`、状態を `verification_status`（`verified` / `unverified` / `needs_review`）に残せます。この台帳の検証コマンドはURLへアクセスせず、形式と参照関係だけを検証します。

## 後続処理から読み込む

```ts
import {
  getEnabledSources,
  getSourcesByOrganization,
  loadSourceRegistry,
} from './src/source-registry/index.ts';

const registry = await loadSourceRegistry();
const enabledSources = getEnabledSources(registry);
const osakaSources = getSourcesByOrganization(registry, 'osaka-city');
```

後続の収集処理は `collector_type` を見て取得方式を選べます。現段階の取得とAI判定は、入口ページ、指定した個別ページ、そのページのPDF、1案件のAI解析を手動確認する範囲だけです。Notionは接続・構成確認と、明示的な`--write`による選定済み1件の新規登録だけです。候補の継続収集、一括AI処理、結果保存、既存Notionページの更新・削除は実装していません。
