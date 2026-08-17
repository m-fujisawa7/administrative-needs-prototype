# Notionへの1件登録チェック

大阪市公式ページ1件を既存のHTML・PDF取得処理とClaude CLIで解析し、接続確認済みのNotionデータベースへ1件登録できるか手動確認するコマンドです。

重複確認からプレビュー・作成までの1件処理は`registerOneAdministrativeNeed`へ集約し、選定URLバッチからも同じ実装を直接利用します。バッチがこのコマンドを子プロセスとして起動することはありません。

デフォルトはプレビューです。`--write`を付けた場合だけ、公式URLによる重複確認後に1ページを作成します。既存ページの更新・削除、データベースやデータソースの作成、プロパティ定義の変更は行いません。

## 実行

プレビュー:

```bash
npm run notion:register -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html" \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

1件登録:

```bash
npm run notion:register -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html" \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..." \
  --write
```

`--database-id`も使用できます。`--database-url`との同時指定はエラーです。`--write`時は実Claude CLIだけを許可し、`AI_PROVIDER=mock`の解析結果は登録しません。

Codex実行環境で実Claude CLIが応答しない場合は、結合確認を無理に待機せず、外部アクセスを行わないMockテストまでで停止します。実Claude・実Notionのプレビューと登録コマンドを提示し、ユーザーがローカルターミナルから実行します。

## 処理

1. 引数、`.env`、情報源台帳を読み込む
2. Notionデータベースと全データソースを取得する
3. 入力された`公式URL`を完全一致で検索する
4. 重複時はHTML・PDF取得とClaude解析を行わず、正常な登録スキップとして終了する
5. 非重複時だけ自社適合度基準とプロンプトを読み込む
6. 既存の個別ページ・PDF抽出処理で公開文書を取得する
7. 既存のClaude CLI AnalyzerとZodスキーマで1件を解析する
8. データソースが1件であることと必須16プロパティの名称・種類を確認する
9. AI内部値をNotion表示値へ変換する
10. 登録直前の重複防止として`公式URL`をもう一度検索する
11. 予定内容をプレビューする
12. `--write`時だけ`data_source_id`を親として1ページ作成する

PDF単体の失敗はWarningとしてHTML本文だけで続行します。AI結果はローカルファイルへ保存しません。

失敗した場合は原因に応じたStageを表示します。取得の失敗は`html_fetch`、本文抽出の失敗は`content_extract`、Claude呼び出しの失敗は`ai_analysis`、Zod検証の失敗は`ai_validation`です。本文が200文字に届かないページや、h1とtitleからタイトルを取得できないページはClaudeへ渡す前に`content_extract`で失敗します。この判定は`ContentExtractionError`の型で行うため、Claude側の失敗と混ざりません。

## スキーマ変更の防止

Notionは、存在しない`select`または`multi_select`名をページ作成時に送ると、権限によっては新しい選択肢をデータソースへ追加します。このコマンドは登録予定の選択肢を現在のデータソース定義と照合し、不足している場合は`--write`があってもページを作成しません。

`分野`にはAIの12種類の固定カテゴリ名を変換せず、そのまま送ります。固定候補外のカテゴリは拒否し、Notion側に選択肢が不足している場合も従来どおり登録を停止します。

プレビューの`Select option safety`が`Blocked`の場合は、表示された選択肢を人がNotion画面で確認・追加してから再実行してください。このコマンド自身は選択肢を追加しません。

## 重複と書き込み範囲

重複確認は`notion.dataSources.query`を使用し、入力された`公式URL`が完全一致するページをHTML取得前に1件検索します。既存ページがあればHTML・PDF取得とClaude解析を行わず、正常な登録スキップとして終了し、更新しません。

完全一致で見つからず、入力URLが`http://`の場合だけ、schemeを`https://`へ替えたURLでもう1度だけ照合します（`findExistingNotionPageWithHttpsFallback`）。置き換えるのはschemeだけで、ホスト・ポート・パス・クエリ・フラグメントは変更しません。`https://`から`http://`への逆方向、末尾スラッシュの統合、クエリの並べ替え、www有無の統一、リダイレクト先の事前解決は行いません。実測できたscheme差だけを吸収します。

作成時に送るのは15プロパティです。`登録日時`は`created_time`のため送信せず、Notionの自動値を使用します。ページ本文ブロックや添付ファイルも作成しません。

非重複時は、解析後にも登録予定URLでもう一度検索します。重複検索とページ作成は別API呼び出しのため、複数プロセスを同時実行した場合の競合を完全には防げません。手動で1件ずつ実行してください。

## Claude CLIの利用上限

Claude CLIが利用上限に達した場合は、`ClaudeUsageLimitError`として判定し、`collect:run` / `collect:batch` と同じ停止表示を標準エラーへ出して終了コード1で終わります。stack traceは通常の出力に出しません。

```text
[ERROR] Claude CLI usage limit reached.
You've hit your limit · resets 10pm (Asia/Tokyo)

AI processing has been stopped for the rest of this run.
```

利用上限以外の未知の例外は握りつぶさず、そのまま呼び出し側へ渡します。自動再実行、リセット時刻までの待機、他Providerへのfallbackは行いません。

## トークン

`.env`の`NOTION_TOKEN`を使用します。トークン、Authorizationヘッダー、入力本文全体を出力・保存しません。SDKログと自動リトライも無効です。

## テスト

```bash
npm run lint
npm run typecheck
npm test
```

単体テストはNotionクライアント、Claude解析結果、取得処理をモックし、実Notion APIと実Claude CLIを呼びません。
