# 行政ニーズ収集プロトタイプ

自治体の行政ニーズを収集する前段として、**どの自治体の、どの公式ページを監視候補にするか**を管理する最小実装です。

現段階では定期収集、Notionの既存ページ更新、定期実行は行いません。`config/sources.yaml` の編集・検証・一覧表示に加え、登録したRSS・一覧ページの技術的な疎通、候補抽出、個別ページとPDFの本文抽出、取得本文のAI判定、新規Sourceの候補からAI判定までの一括確認、Notionデータベース構成の読み取り確認、選定済み1件のNotion登録、選定URLファイルまたは情報源候補から最大20件を直列処理する手動コマンド、複数情報源をまとめて逐次収集する手動コマンドを実行できます。

## セットアップ

Node.js 25以上を使用します。

```bash
npm install
cp .env.example .env
```

台帳の検証とMockテストだけなら認証情報は不要です。実AI判定には認証済みのClaude CLI、Notion接続・登録には`.env`の`NOTION_TOKEN`が必要です。`.env`はGit管理対象外です。

Codex実行環境で実Claude CLIが応答しない場合は長時間待機せず、外部アクセスを行わないMockテストまで実施します。実Claude・実Notionの結合確認は表示されたコマンドをローカルターミナルから実行してください。

## ディレクトリ構成

```text
config/             情報源台帳と自社適合度判定基準
prompts/            AI判定プロンプト
src/commands/       手動実行するCLIエントリーポイント
src/source-registry 台帳の読み込み・検証
src/source-check/   情報源の疎通・候補抽出
src/source-verify/  新規Sourceの取得・AI判定をまとめた読み取り確認
src/content-check/  個別HTMLページの本文抽出
src/pdf-check/      PDF本文抽出
src/ai/             Claude CLI／Mockによる判定・構造化
src/notion-check/   Notion接続とスキーマの読み取り確認
src/notion-register Notionへの1件登録プレビュー・重複防止
src/notion-batch    選定URLファイルの直列プレビュー・登録
src/collection-run  期間・情報源別状態を使う候補の直列プレビュー・登録と複数情報源の一括実行
test/               外部アクセスを行わない単体テストとfixture
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

新しく追加したSourceについて、候補取得から本文・PDF取得、AI判定までを1コマンドで確認します。

```bash
AI_PROVIDER=claude_cli npm run source:verify -- \
  --source ishikawa-digital-office-news \
  --limit 3
```

`--limit`は省略時3件、最大5件です。候補ごとの失敗後も残りを直列処理します。このコマンドはNotion APIを呼ばず、AI結果を保存せず、`data/collection-state.json`も読み書きしません。詳細は `src/source-verify/README.md` を参照してください。

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

登録済み情報源から候補を直接取得し、1件ずつ直列に処理します。

```bash
AI_PROVIDER=claude_cli npm run collect:run -- \
  --source osaka-digital-rss \
  --limit 10 \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

デフォルトはプレビューです。候補URLの文字列重複を除き、Notion登録済みURLは後続取得とClaude解析の前にスキップします。未登録候補だけを最大20件まで処理し、`--write`を明示した場合だけNotionページを作成します。詳細は `src/collection-run/README.md` を参照してください。

初回は2026-07-01から、2回目以降は情報源ごとの前回成功日時の3日前から実行開始時刻までを対象にします。`--limit`は未登録候補だけが消費する安全上限です。条件を満たすWrite成功時だけ、実行開始時刻をGit管理外の`data/collection-state.json`へ保存します。`--since YYYY-MM-DD`による手動バックフィルも可能ですが、この場合は状態を進めません。

複数の情報源を1コマンドで順番に収集します。

```bash
AI_PROVIDER=claude_cli npm run collect:batch -- \
  --municipality 名古屋市 \
  --limit 2 \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

情報源の選び方は3通りで、いずれか1つを必ず指定します。同時指定はエラーです。

| オプション | 選ばれる情報源 |
| --- | --- |
| `--municipality 名古屋市` | その自治体に属する有効な情報源すべて。外郭団体を別組織として登録している場合も`parent_organization_id`をたどって含めます |
| `--all` | 有効な情報源すべて（組織が`enabled: false`のものは除く） |
| `--sources a,b,c` | 指定した情報源だけ。存在しないIDがあれば1件も実行せず終了します |

`collect:run` と同じ処理を情報源ごとに逐次実行するだけで、並列実行や定期実行は行いません。デフォルトはプレビューで、`--write`を明示した場合だけNotionページを作成します。

`--limit`は情報源ごとの上限です。`--limit 2`なら各情報源で未登録候補を最大2件ずつ処理します（バッチ全体で2件ではありません）。`--since`を指定すると全情報源へ同じ日付を適用します。

1つの情報源が失敗しても残りは続行します。収集状態は情報源ごとに判定し、バッチ全体の成否では進めません。実行後に情報源ごとの結果を表で表示します。

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

登録済みの組織・情報源・有効状態は `config/sources.yaml` を正本とします。READMEには件数や個別一覧を重複して記載しません。最新の登録状況は、台帳から生成される次の一覧で確認してください。

```bash
npm run sources:list
npm run sources:list -- --enabled
```

情報源固有の取得上の注意や無効化理由は、各情報源の `notes` に記録します。

`enabled: false` は削除ではありません。監視候補として記録を残しつつ、後続処理の対象外にできます。

## 情報源を追加する

通常、情報源の追加時に更新するのは `config/sources.yaml` だけです。READMEは、台帳の構造、追加手順、利用コマンドなどの運用ルールが変わった場合に更新します。登録件数や自治体別一覧の手作業での追記は不要です。

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

後続の収集処理は `collector_type` を見て取得方式を選べます。現段階の取得とAI判定は、入口ページ、指定した個別ページ、そのページのPDF、1案件のAI解析、および人が指定した最大20件を手動で直列実行する範囲です。手動一括実行の対象期間と情報源ごとの前回成功日時だけをローカルJSONで管理します。Notionは接続・構成確認と、明示的な`--write`による新規登録だけです。候補・AI結果の保存、既存Notionページの更新・削除、定期実行は実装していません。
