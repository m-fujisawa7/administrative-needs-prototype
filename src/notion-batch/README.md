# 選定URLのNotion一括処理

人が選んだ大阪市公式ページを、既存の1件登録処理で1件ずつ直列にプレビューまたは登録する手動コマンドです。情報源から候補を自動取得せず、指定したテキストファイルだけを処理します。

## 入力ファイル

UTF-8テキストへ1行1URLで記載します。空行と、前後の空白を除いた先頭が`#`の行は無視します。URLは`http`または`https`だけを許可し、最大20行です。

同一文字列のURLが複数ある場合、最初の行だけを処理します。2回目以降はNotion APIを呼ばず、入力内重複として正常にスキップします。URL正規化、リダイレクト後URLとの統合、末尾スラッシュの統合は行いません。

```text
# 登録済み確認
https://www.city.osaka.lg.jp/example/registered.html

# 新規候補
https://www.city.osaka.lg.jp/example/candidate.html
```

## 実行

プレビューでは未登録URLのHTML・PDF取得、実Claude解析、Zod検証、Notionスキーマ・選択肢確認まで行い、ページは作成しません。

```bash
AI_PROVIDER=claude_cli npm run notion:batch -- \
  --source osaka-digital-rss \
  --file "./data/selected-urls.txt" \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

プレビュー確認後、明示的に`--write`を付けた場合だけ、未登録URLを1ページずつ作成します。

```bash
AI_PROVIDER=claude_cli npm run notion:batch -- \
  --source osaka-digital-rss \
  --file "./data/selected-urls.txt" \
  --database-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
  --write
```

Codex実行環境で実Claude CLIが応答しない場合は、結合確認を無理に待機せず、外部アクセスを行わないMockテストまでで停止します。実Claude・実Notionのプレビューと登録コマンドを提示し、ユーザーがローカルターミナルから実行します。

## 処理と安全策

入力ファイル全体を検証してからNotionへ接続します。各URLは、既存の`registerOneAdministrativeNeed`を次の順で直列実行します。

1. 入力URLでNotionを事前重複検索
2. 重複時はHTML・PDF・Claude・登録をスキップ
3. 未登録時はHTMLとPDFを取得
4. Claude解析とZod・固定カテゴリ検証
5. Notionプロパティ変換、スキーマ・選択肢確認
6. 登録直前の2回目の重複検索
7. プレビュー、または`--write`時だけページ作成

1件が失敗しても後続URLを処理し、最後に件数と失敗ステージを表示します。失敗が1件以上あれば終了コード1、プレビュー・作成・重複スキップだけなら0です。

Notionのスキーマや選択肢を自動変更せず、既存ページも更新・削除しません。実行履歴、AI結果、HTML・PDF本文をファイルへ保存しません。トークンやAuthorizationヘッダーも出力しません。

## Claude CLIの利用上限

Claude CLIが利用上限に達した場合だけは、`ai_analysis`の通常の失敗として後続URLを試し続けず、そのURLで処理を打ち切ります。利用上限はClaude全体の状態であり、残りのURLも同じ失敗になるためです。

```text
[ERROR] Claude CLI usage limit reached.
You've hit your limit · resets 10pm (Asia/Tokyo)

AI processing has been stopped for the rest of this run.
```

残りのURLへはClaudeを呼びません。打ち切りまでに完了したプレビュー・作成・重複スキップの結果はそのまま保持し、サマリの末尾に停止理由を追加して終了コード1になります。`collect:run` / `collect:batch` と同じ`ClaudeUsageLimitError`で判定します。未処理URLは、リセット後に同じ入力ファイルで再実行すれば登録済みURLが重複としてスキップされるため、そのまま消化できます。

すでに作成済みのNotionページはロールバックしません。自動再実行、リセット時刻までの待機、他Providerへのfallbackは行いません。
