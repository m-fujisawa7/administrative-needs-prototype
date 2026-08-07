# 新規Source確認コマンド

`source:verify`は、情報源台帳へ追加したSourceがNotion登録の直前まで処理できるかを、1コマンドで確認するための手動CLIです。

```bash
AI_PROVIDER=claude_cli npm run source:verify -- \
  --source ishikawa-digital-office-news \
  --limit 3
```

`--source`は必須です。`--limit`は省略時3件、指定可能な範囲は1〜5件です。

## 処理内容

次の既存処理を直接、候補ごとに直列実行します。

1. `config/sources.yaml`からSourceと所属組織を取得
2. 既存CollectorでSourceの疎通と候補URLを確認
3. 先頭から`--limit`件を選択
4. 既存の個別ページ抽出でHTML本文とPDF URLを取得
5. 既存のPDF抽出で最大3件のPDF本文を取得
6. 既存の`AdministrativeNeedAnalyzer`でAI判定

Claude CLIを使う場合は、`src/ai/`と同じプロンプト、入力上限、出力スキーマ、Zod検証を再利用します。新しい収集・解析処理や別の認証方法は使用しません。

取得した候補は全件一覧表示し、その先頭から`--limit`件だけを本文・AI確認の対象にします。候補が0件の場合は正常終了し、本文取得とAI解析を行いません。個別候補の本文取得またはAI解析が失敗した場合は、その候補を失敗として表示して残りを続行します。`is_target=false`はAI解析の成功として扱います。

## 出力と終了コード

各候補について、HTML本文文字数、PDF検出・抽出件数、PDF本文文字数、AI判定、根拠引用、警告を表示します。最後に成功・失敗件数と次の判定を表示します。

Claude CLIの初回回答がJSON構文エラーとなり、1回の再試行で成功した場合は、標準エラーへ`[WARNING] [ai_json_parse_retry]`を表示します。このWarningは解析成功として扱います。再試行後も失敗した場合は、その候補をAI解析失敗として表示します。

- 全サンプルの本文取得とAI解析が成功: `Ready for collection: YES`
- 1件でも失敗、または候補0件: `Ready for collection: CHECK REQUIRED`

Source不存在、Collector失敗、AIの準備失敗、または個別候補の失敗がある場合は終了コード1です。候補0件を含め、検証処理自体が正常に完了した場合は終了コード0です。

## 書き込みを行わない範囲

このコマンドは次を呼び出しません。

- Notion API、重複確認、ページ作成
- `data/collection-state.json`の読み取り・更新
- `last_successful_check_at`の更新
- AI結果や本文のファイル保存

登録済みURLもSourceの取得品質を確認するサンプルとして処理します。

## Mockによる確認

外部AIを使わずコマンドの流れだけを確認する場合は、既存Mockを指定します。WebページとPDFへのアクセスは発生します。

```bash
AI_PROVIDER=mock npm run source:verify -- \
  --source ishikawa-digital-office-news \
  --limit 1
```

Mock結果を実Claudeの判定結果として扱わないでください。Codex実行環境でClaude CLIが安定しない場合は繰り返し実行せず、通常のMacターミナルから冒頭のコマンドを実行してください。

## 制約

- 候補はCollectorが返した順の先頭から選びます。ランダム抽出はしません。
- 1 Sourceずつ、最大5候補を直列処理します。
- PDFの件数・本文上限は既存`ai:check`と同じです。
- OCR、リトライ、並列処理、URL正規化は行いません。
