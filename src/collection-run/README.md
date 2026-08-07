# 情報源候補からNotionまでの手動一括実行

台帳へ登録済みの情報源から候補URLを取得し、既存の1件登録処理へ最大20件まで直列に渡す手動コマンドです。URL一覧ファイルは作成・保存しません。

## 実行

デフォルトはプレビューです。候補取得とNotion事前重複確認を行い、未登録URLだけHTML・PDF取得、実Claude解析、Zod・固定カテゴリ検証、Notionスキーマ・選択肢確認まで進めます。Notionページは作成しません。

```bash
AI_PROVIDER=claude_cli npm run collect:run -- \
  --source osaka-digital-rss \
  --limit 10 \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

プレビュー確認後、`--write`を明示した場合だけ未登録URLを1ページずつ作成します。

```bash
AI_PROVIDER=claude_cli npm run collect:run -- \
  --source osaka-digital-rss \
  --limit 10 \
  --database-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
  --write
```

`--source`と、`--database-url`または`--database-id`の一方が必須です。`--limit`の既定値は5、指定範囲は1から20です。URLとIDを同時には指定できません。

## 処理順

1. 引数と台帳を検証
2. `collector_type`に応じて、情報源チェックと同じRSS／一覧ページCollectorで全候補を取得
3. 同一URL文字列の2件目以降を除き、先頭から`--limit`件を選択
4. Notionデータベースとデータソースを読み取り確認
5. 既存の`registerOneAdministrativeNeed`へ候補を1件ずつ直列に渡す
6. 各結果と最終件数を表示

Notionに同じ`公式URL`がある場合、1件処理の事前重複確認でHTML・PDF・Claude・ページ作成をすべてスキップします。未登録の場合だけ取得と解析へ進み、登録直前にも既存仕様の2回目の重複確認を行います。

1件が失敗しても後続候補を処理します。失敗が1件以上、情報源取得失敗、Notion接続失敗、引数不正の場合は終了コード1です。プレビュー・作成・重複スキップだけ、または候補0件の場合は0です。

## 安全策と制約

- `--write`がない限りNotionへ書き込まない
- Mock解析結果を登録しない
- Notionのスキーマや選択肢を自動変更しない
- 既存ページを更新・削除しない
- トークン、Authorizationヘッダー、Claude入力、HTML・PDF本文を表示・保存しない
- 実行履歴、候補、AI結果のJSON・CSV・データベース保存を行わない
- 並列処理、自動リトライ、定期実行を行わない

実Claudeと実Notionを使うため、公開文書と対象件数を確認してから手動実行してください。実行後は表示されたAI判定とNotion登録内容を人が確認します。

Codex実行環境で実Claude CLIが応答しない場合は、結合確認を無理に待機せず、外部アクセスを行わないMockテストまでで停止します。このREADMEのプレビューと`--write`コマンドを提示し、ユーザーがローカルターミナルから実行します。Mock成功を実Claude・実Notionの結合確認成功として扱いません。
