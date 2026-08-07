# AI判定・構造化チェック機能

指定した個別ページのHTML本文と添付PDF本文を既存機能で取得し、1回のAI問い合わせで対象判定と行政ニーズを構造化できるか確認するコマンドです。

初期ProviderはClaude CLIで、テスト用Mockも利用できます。AI結果のファイル保存、SQLite、Notion登録、一括処理、定期実行、他Provider対応は行いません。

## 実行前の確認

AIへ送るのは自治体・公共機関の公式サイトで公開されている文書だけにしてください。秘密情報、社外秘、認証後ページ、手元の非公開資料、追加の個人情報を入力しないでください。

自社関連度は `config/company-fit-criteria.yaml` を使用します。初期値は実装指示書の想定であり、実運用前に自社の提供領域、将来注力領域、パートナー方針に合わせて確認してください。この判定基準もAIへ送信されます。

Claude CLIの存在と認証状態を確認します。

```bash
claude --version
claude --help
```

認証確認だけでなく、`claude -p` の非対話実行が成功することを確認してください。出力0バイトの場合は認証と決めつけず、CLI引数、終了コード、標準出力長、標準エラー、解析段階を確認します。

## コマンド

Claude CLIで実AI確認:

```bash
npm run ai:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

Codex実行環境でClaude CLIが応答しない場合は、結合確認のために長時間待機や繰り返し実行をしません。fixture・Mock・疑似子プロセスを使う自動テストまで完了し、上記の実行コマンドをユーザーへ提示して、ローカルターミナルで実Claudeの結果を確認してもらいます。Mock成功を実Claude成功として扱いません。

Mockで取得・入力組み立て・表示だけを確認:

```bash
AI_PROVIDER=mock npm run ai:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

解析JSONだけを標準出力:

```bash
npm run --silent ai:check -- --source osaka-digital-rss --url "https://..." --json
```

機械処理へパイプする場合は、npm自身の実行バナーを混ぜないため `npm run --silent` を使用してください。`ai-check.ts` は解析JSONだけを標準出力し、Warningは標準エラーへ分離します。

PDFを取得・送信せずHTML本文だけで解析:

```bash
npm run ai:check -- --source osaka-digital-rss --url "https://..." --no-pdf
```

`--json`でもWarningは標準エラーへ表示します。AI結果をファイルへ保存するオプションはありません。

## 処理の流れ

1. 台帳から情報源と組織を取得
2. 既存の `content-check` でHTML本文、タイトル、PDF URLを取得
3. PDF URLを重複除外し、先頭3件まで既存の `pdf-check` で抽出
4. PDF失敗はWarningにしてHTML本文だけで続行
5. HTML最大30,000文字、PDF合計最大50,000文字へ先頭・末尾を残して切り詰め
6. 外部プロンプトと自社適合度判定基準を使いAIへ1回送信
7. 標準入力に含めたJSON Schemaで出力を指示し、アプリ側Zodで構造を検証
8. 根拠引用の出典URLと、空白正規化後の原文包含を確認
9. 人間向け表示または `--json` で標準出力

根拠照合に失敗しても解析自体は表示しますが、Warningになります。AIの判定は人が根拠原文と照合してください。

## AnalyzerとClaude CLI

共通の `AdministrativeNeedAnalyzer` を `ClaudeCliAnalyzer` と `MockAnalyzer` が実装します。Claude固有の子プロセス処理は `claude-cli.ts` と `process.ts` に閉じています。プロンプトは `prompts/ai-check.md`、自社適合度判定基準は `config/company-fit-criteria.yaml` です。

Claude CLIはシェルを経由せず引数配列で起動し、システム指示、出力JSON Schema、行政文書を標準入力で渡します。互換性確認済みの最小引数だけを使用します。

```text
-p
--output-format json
--max-turns 1
```

標準出力はClaude CLIの外側JSONとして解析し、`type=result`、`subtype=success`、`is_error=false`、文字列型の`result`を順番に確認します。`result`のMarkdown JSONコードブロックを除去してJSON解析し、最後にZodで検証します。

子プロセスは一時ディレクトリで起動し、タイムアウト時はプロセスグループを終了します。標準出力は2MB、標準エラーは64KBを上限とします。失敗時は認証と決めつけず、終了コード、シグナル、標準出力文字数、標準エラー、失敗した解析段階を表示します。入力本文そのものはエラーへ表示しません。

## 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `AI_PROVIDER` | `claude_cli` | `claude_cli` または `mock` |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI実行ファイル |
| `AI_TIMEOUT_MS` | `180000` | AI実行タイムアウト。1,000〜600,000ms |
| `AI_MAX_PDFS` | `3` | 取得するPDF数。1〜10 |
| `AI_MAX_HTML_CHARACTERS` | `30000` | AIへ送るHTML文字数上限 |
| `AI_MAX_PDF_CHARACTERS` | `50000` | AIへ送るPDF本文合計文字数上限 |
| `AI_CHECK_PROMPT_PATH` | `prompts/ai-check.md` | プロンプトファイル |
| `AI_COMPANY_FIT_CRITERIA_PATH` | `config/company-fit-criteria.yaml` | 自社適合度判定基準 |

最小引数構成ではモデルを指定せず、Claude CLI側の既定モデルを使用します。アプリの表示上はモデルが `not applicable` になります。

## 出力スキーマ

内部値は比較しやすい固定IDです。主な項目:

- `is_target`
- `document_type`: `rfi`、`sounding`、`proposal`、`bid`など
- `problem_summary`、`desired_state`、`request_to_private_sector`
- `categories`: 12種類の固定された日本語カテゴリ名から1〜3件（対象外は空配列）
- `company_relevance`: `A`、`B`、`C`、`out_of_scope`
- `contact_recommendation`: `high`、`medium`、`low`、`none`
- `reason`
- `evidence_quotes`: `source_type`、`source_url`、`quote`を持つ配列

対象外の場合は `company_relevance=out_of_scope`、`contact_recommendation=none` を必須とします。未知キー、未知の列挙値、空の根拠引用はZodで拒否します。

カテゴリ候補は `src/ai/categories.ts` の共通定義だけで管理します。プロンプト読み込み時に `{{CATEGORY_OPTIONS}}` を候補名と判断基準へ置換し、固定候補外、4件以上、重複、「その他」と他カテゴリの併用をZodで拒否します。AIのカテゴリ名は変換せず、そのままNotionの`multi_select`名として使用します。

## 終了コード

- `0`: AI解析成功。PDF失敗や根拠不一致などのWarningを含む場合も0
- `1`: HTML取得、AI実行、JSON解析、Zod検証に失敗
- `2`: 引数、情報源ID、自社適合度判定基準、プロンプト、環境設定、Claude CLIパスが不正

## テストと制約

`npm test`はネットワークとClaude CLIを使用せず、fixture、Mock、疑似子プロセスで検証します。Mock成功を実AI成功として報告しないでください。GitHub Actionsでも実AIは呼びません。

現在の制約:

- AI判定は確率的で、同じ入力でも表現や判定が変わる可能性がある
- 見た目、図、画像PDF、OCR対象は解析しない
- PDFはページ内の出現順で最大3件まで。添付の重要度判定はしない
- 文字数上限は厳密なトークン計算ではない
- 根拠照合は空白正規化後の包含確認で、意味的一致は判定しない
- AI結果だけで自治体へ連絡したり、営業・入札判断を確定しない
- AI結果の保存、履歴管理、複数案件統合、一括実行は行わない
