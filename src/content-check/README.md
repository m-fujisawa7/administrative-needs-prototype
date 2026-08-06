# 個別ページ抽出チェック機能

`config/sources.yaml` の情報源から得た候補URLへ安全にアクセスし、タイトル、本文、公開日候補、PDFリンクを抽出できるか人が確認するコマンドです。

この機能が確認するのは、**本文らしい内容を技術的に抽出できたか**です。抽出内容が行政ニーズとして有用か、対象分野に該当するかは自動判定しません。本文プレビューを人が確認してください。

取得できたHTML本文とPDF本文をAIで判定する手動チェックは `npm run ai:check` で行います。詳細は `../ai/README.md` を参照してください。

## コマンド

```bash
npm run content:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

本文全文をターミナルへ表示:

```bash
npm run content:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html" \
  --full
```

結果をJSONへ保存:

```bash
npm run content:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html" \
  --output
```

`--source` と `--url` は必須で、それぞれ1回だけ指定します。`enabled: false` の情報源も確認できますが、結果はWarningになります。`--full` と `--output` は任意です。保存先を省略した `--output` は `data/logs/content-check/source-id.json` を使用します。独自の一時保存先が必要な場合だけ `--output path/to/result.json` と指定できます。

## 処理の範囲

実施する処理:

- 台帳から情報源と所属組織を取得
- 組織の公式ドメイン内に限定して個別ページを取得
- HTMLからタイトルと本文を抽出
- 公開日候補を抽出
- 本文内のPDFリンクを絶対URLへ変換
- 使用した本文セレクター、警告、本文プレビューを表示

実施しない処理:

- 行政ニーズとしての意味的な適否判定
- PDF本文の取得・抽出
- AI解析、要約、Notion登録
- 通常収集、定期実行、データベース保存

## 本文抽出

台帳に `content_selector` がある場合は最初に使用します。未設定、一致0件、不正なセレクター、または抽出本文が200文字未満の場合は次の順に試します。

1. `main`
2. `article`
3. `[role="main"]`
4. `#mol_contents`
5. `#main`
6. `#contents`
7. `#content`
8. `.content`
9. `body`

設定された `content_selector` を使用できずフォールバックした場合はWarningです。`body` を使用した場合も、共通メニューなどの混入を人が確認できるようWarningにします。すべての候補で本文が200文字未満ならErrorです。

抽出対象から次を除外します。

- `script`、`style`、`noscript`
- `nav`、`header`、`footer`、`aside`、`form`
- `iframe`、`svg`
- `hidden` または `aria-hidden="true"` の要素

自治体固有の定型文除去は行いません。

## タイトル・公開日・PDFリンク

タイトルは空でない `h1`、`title` の順で取得し、どちらもなければErrorです。

公開日候補はページ全体から次の順で探します。

1. `time` 要素
2. `article:published_time`、`datePublished` などのmeta
3. `.page_day01` などの日付表示と本文冒頭

取得できない場合は `null` とし、Warningを表示します。高度な日付推定は行いません。

PDFリンクは、実際に本文として選択した要素内から取得します。`<base href>` を考慮して絶対URLへ変換し、`.PDF`、`.pdf?download=1`、`.pdf#page=2` にも対応します。このコマンドではリンクを列挙するだけです。PDF自体の取得・抽出は、対象を人が選んで `npm run pdf:check` を実行します。詳細は `../pdf-check/README.md` を参照してください。

## HTTPアクセスの安全対策

入口チェックと同じ安全な取得関数を再利用します。

- `http` / `https` 以外を拒否
- URL内のユーザー名・パスワードを拒否
- 情報源の所属組織の `official_domain` とサブドメイン以外を拒否
- IPアドレス直接指定、内部IP、予約済みIPを拒否
- リダイレクト先も同じ条件で再検証
- タイムアウト20秒、リダイレクト最大5回、本文最大5MB
- 2xx以外、空本文、HTML以外のContent-TypeをError

User-Agentは `CONTENT_CHECK_USER_AGENT` で指定できます。未指定時は `SOURCE_CHECK_USER_AGENT`、その次に既定値を使用します。

## 結果と終了コード

- `OK`: 設定されたセレクターなどで問題なく抽出できた
- `WARNING`: フォールバック、`body` 使用、公開日欠損、無効情報源などがある
- `ERROR`: HTTP取得、HTML判定、タイトル、本文抽出に失敗した

終了コード:

- `0`: OKまたはWarning
- `1`: HTTP取得または抽出エラー
- `2`: 引数、情報源ID、台帳設定などが不正

通常表示は本文の先頭500文字だけです。`--full` はターミナル表示だけを変更します。

## 結果を保存する運用

通常は保存せず、情報源・URL・`content_selector` の追加変更時、または後続処理のエラー調査時だけ `--output` を指定します。同じ情報源で複数の個別ページを確認しても、標準保存先は最新の1件で上書きし、実行履歴は増やしません。

保存するJSONには実行日時、ステータス、HTTP情報、タイトル、文字数、公開日候補、セレクター、警告、PDF URL、500文字のプレビューを含めます。HTMLと本文全文は保存しません。抽出エラーの場合も、引数とエラー理由を保存します。

`data/logs/` はGit管理対象外です。Pull RequestにはJSONを追加せず、結果の要約を記載してください。台帳は自動更新しません。

## テストと制約

自動テストは `test/fixtures/rfi.html` などの保存済みHTMLを使い、外部サイトへアクセスしません。実アクセスは追加・変更時に人が明示的に実行します。

```bash
npm test
```

現在の制約:

- HTMLはUTF-8として読み込む
- JavaScript実行後に生成される本文には対応しない
- 本文品質は文字数、セレクター、プレビューによる技術確認に限る
- robots.txt解析、リトライ、キャッシュ、差分検知、定期実行は行わない
- DNS検証後から接続までのネットワーク変化を完全には防げない
