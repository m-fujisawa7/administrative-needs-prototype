# PDF抽出チェック機能

`content:check` で見つけたPDF URLを1件指定し、テキストを技術的に取得できるか人が確認するコマンドです。

この機能が確認するのは、**PDFとして安全に取得でき、埋め込まれた文字を抽出できたか**です。抽出内容が行政ニーズとして有用か、期待した文書か、記載内容が正しいかは自動判定しません。本文プレビューを人が確認してください。

HTML本文と抽出できたPDF本文をAIで判定する手動チェックは `npm run ai:check` で行います。詳細は `../ai/README.md` を参照してください。

## コマンド

```bash
npm run pdf:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000684/684546/01_youryou5.pdf"
```

抽出全文をターミナルへ表示:

```bash
npm run pdf:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000684/684546/01_youryou5.pdf" \
  --full
```

結果をJSONへ保存:

```bash
npm run pdf:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000684/684546/01_youryou5.pdf" \
  --output
```

`--source` と `--url` は必須で、それぞれ1回だけ指定します。`--source` は台帳の情報源を指定し、所属組織の `official_domain` をアクセス許可範囲として使います。外部ドメインのPDFは、台帳側で所属組織の公式ドメインとして明示的に管理されない限り取得しません。`--full` と `--output` は任意です。保存先を省略した `--output` は `data/logs/pdf-check/source-id.json` を使用します。独自の一時保存先が必要な場合だけ `--output path/to/result.json` と指定できます。

## 処理の範囲

実施する処理:

- 台帳から情報源と所属組織を取得
- 組織の公式ドメイン内に限定してPDFを1件取得
- `Content-Type: application/pdf` と先頭1KB以内の `%PDF-` ヘッダーを確認
- `unpdf` でページごとの埋め込みテキストを抽出
- ページ数、本文文字数、テキスト取得ページ数、空ページ数を表示
- 空ページや日本語文字間空白の兆候をWarning表示
- 通常は先頭500文字、`--full` 指定時は全文をターミナル表示

実施しない処理:

- OCR、スキャン画像や図表の画像解析
- パスワード解除、破損PDFの修復
- 行政ニーズとしての意味的な適否判定、要約
- PDFや抽出全文の保存
- 複数PDFの一括取得、通常収集、定期実行
- AI解析、Notion登録、データベース保存

## HTTP・解析の安全対策

- `http` / `https` 以外、認証情報を含むURL、IPアドレス直接指定を拒否
- 情報源の所属組織の `official_domain` とサブドメイン以外を拒否
- DNS解決結果の内部IP・予約済みIPを拒否し、リダイレクト先も再検証
- HTTPタイムアウト30秒、リダイレクト最大5回、PDF最大20MB
- HTTP 2xx以外、空応答、PDF以外のContent-TypeをError
- PDFヘッダーを別途検証し、拡張子やContent-Typeだけの偽装を拒否
- 最大500ページ、PDF内部画像1件あたり約16MB、解析・抽出各30秒

User-Agentは `PDF_CHECK_USER_AGENT` で指定できます。未指定時は `SOURCE_CHECK_USER_AGENT`、その次に既定値を使用します。

## Math.sumPrecise のpolyfill

unpdfが同梱するPDF.jsは `Math.sumPrecise` を使います（フォント再構築時のグリフサイズ合計、XFAのテーブル列幅、テキスト幅の算出）。この関数はTC39提案で、V8は14.6（Node 26.7.0）でもまだ実装していません。そのため該当コードパスへ入るPDFだけが `Math.sumPrecise is not a function` で解析に失敗していました。

実測で確認したこと。

- Node 25.2.1（V8 14.1.146.11）: `typeof Math.sumPrecise === 'undefined'`
- Node 26.7.0（V8 14.6.202.34）: 同じく `undefined`。**Node更新では解消しない**
- 有効化するV8フラグは存在しない（`--harmony` でも未定義）
- unpdf 1.6.2 / 1.7.0 / 1.8.0 / 1.8.1 のいずれも同じ呼び出しを含む。**依存のバージョン変更でも回避できない**

このためランタイム更新でも依存変更でも解決せず、`math-sum-precise.ts` で最小のpolyfillを入れています。Shewchukの非重複展開で丸め誤差を出さずに合計し、最後に1回だけ丸めます。空のiterableで `-0`、NaNや無限大の扱い、iterableでない引数や数値でない要素のTypeErrorも提案どおりにしています。

`installMathSumPrecise` は既に存在する場合は上書きしません。**V8がこの関数を実装したら `math-sum-precise.ts` とその読み込みを削除できます。** 実装後はランタイム側が自動的に使われます。

## 結果と終了コード

- `OK`: 全ページから問題なくテキストを抽出できた
- `WARNING`: 空ページ、日本語文字間空白の兆候、無効な情報源・組織などがある
- `ERROR`: HTTP取得、PDF判定、解析、または本文抽出に失敗した

終了コード:

- `0`: OKまたはWarning
- `1`: HTTP取得、PDF判定、解析、または抽出エラー
- `2`: 引数、情報源ID、台帳設定などが不正

呼び出し側は1件の失敗を例外または終了コード1として受け取り、必要なら残りの処理を継続できます。このコマンド自体は1回に1PDFだけを確認します。

## 結果を保存する運用

通常は保存しません。情報源・PDF URLの追加時に確認記録が必要な場合、または後続処理でエラーが出た際の再確認にだけ `--output` を指定します。同じ情報源で複数のPDFを確認しても、標準保存先は最新の1件で上書きし、実行履歴は増やしません。

保存JSONに含めるもの:

- 実行日時、ステータス、情報源ID、要求URLと最終URL
- HTTPステータス、Content-Type、応答サイズ、所要時間、リダイレクト数
- パーサー名、ページ数、テキスト取得ページ数、空ページ数、本文文字数
- ページ別文字数、Warning、先頭500文字のプレビュー
- エラー時は引数とエラー理由

PDFファイル、抽出全文、ページ別本文は保存しません。`--full` は保存内容に影響しません。標準保存先は情報源ごとに最新結果を上書きします。`data/logs/` はGit管理対象外で、台帳も自動更新しません。Pull RequestにはJSONを追加せず、結果の要約だけを記載してください。

## テストと制約

自動テストは `test/fixtures/youryou.pdf` と疑似パーサーを使い、外部サイトへアクセスしません。

```bash
npm test
```

現在の制約:

- テキスト埋め込みPDFだけを対象とし、OCRは行わない
- パスワード保護されたPDFは解析できず `No password given` のErrorになる
- PDF上の見た目、段組み、表、読み順を完全には再現しない
- 文字数や空ページは技術的な品質指標であり、内容の正しさを保証しない
- robots.txt解析、リトライ、キャッシュ、差分検知、定期実行は行わない
- DNS検証後から接続までのネットワーク変化を完全には防げない
