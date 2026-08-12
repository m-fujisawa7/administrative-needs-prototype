# 情報源チェック機能

`config/sources.yaml` に登録した情報源について、入口URLへ安全にアクセスし、RSSまたは一覧ページから候補を抽出できるか確認する機能です。

この機能が確認するのは、**技術的な疎通と候補抽出**です。情報源が行政ニーズの発見に有用か、抽出された案件が対象分野に該当するかは自動判定しません。表示されたサンプルを人が確認してください。

`npm run collect:run`も、この機能から切り出した共通Collectorを直接呼び出します。RSS／一覧ページの取得、公式ドメイン制限、台帳フィルター、候補の順序は情報源チェックと同じです。CLIを子プロセスとして呼んだり、チェック結果JSONを入力にしたりしません。

## 対応範囲

初期版で対応する `collector_type`:

- `rss`: RSS 2.0を解析し、台帳の `category_includes` と `title_excludes` を適用
- `list_page`: `link_selector` で候補リンクを抽出

次は `Unsupported` として表示します。

- `single_page`
- `manual`
- `custom`

一覧ページでは `link_selector` だけを確認します。このコマンドでは個別ページを取得しないため、`content_selector` は常に「未確認」と表示します。個別ページは `npm run content:check` で別に確認します。

## コマンド

1件だけ確認:

```bash
npm run sources:check -- --source osaka-digital-rss
```

有効な組織に属する有効な情報源をすべて確認:

```bash
npm run sources:check -- --enabled
```

無効な情報源を含む台帳全件を確認:

```bash
npm run sources:check -- --all
```

表示するサンプル数を指定:

```bash
npm run sources:check -- --all --limit 5
```

結果をJSONへ保存:

```bash
npm run sources:check -- \
  --source osaka-digital-rss \
  --output
```

`--source`、`--enabled`、`--all` は、いずれか1つだけ指定します。`--limit` はサンプル表示数だけを制限し、解析する候補数は制限しません。既定値は3、指定可能範囲は1から20です。`--output` は任意で、指定しなければ結果を保存しません。

`--output` の保存先を省略すると、1件指定は `data/logs/source-check/source-id.json`、`--enabled` は `enabled.json`、`--all` は `all.json` へ保存します。独自の一時保存先が必要な場合だけ `--output path/to/result.json` と指定できます。

## 結果を保存する運用

通常時は画面表示だけを行い、次の場合に `--output` で保存します。

- 情報源、URL、フィルター、CSSセレクターを追加・変更したとき
- 後続の収集処理でエラーや抽出0件が発生し、再確認するとき
- 障害調査の証跡を一時的に残したいとき

保存先の親ディレクトリは自動作成します。標準保存先は同じ対象の最新結果で必ず置き換え、日付や実行回数ごとの履歴ファイルは作りません。JSONには実行日時、対象条件、サンプル上限、集計、各情報源の結果・警告・サンプルを保存します。取得したRSS・HTML本文は保存しません。

`data/logs/` は `.gitignore` の対象です。通常はJSON自体をGitへコミットせず、情報源の追加・変更時はPull Requestへ結果の要約を記載してください。台帳の `verification_status` と `last_verified_at` は、結果を人が確認した後に手動で更新します。

## 結果の見方

各情報源について次を表示します。

- HTTPステータス、Content-Type、応答サイズ、所要時間
- リダイレクト後の最終URLと回数
- 生件数: RSSの全item数、またはCSSセレクター一致数
- 構造上有効: タイトルと公式ドメイン内URLを取得できた件数
- 利用可能: フィルター、重複、自己リンクなどを処理した後の件数
- 除外理由と件数
- 最新公開日候補
- 先頭サンプル
- `link_selector` と `content_selector` の確認状態

公開日候補は、西暦（`2026年8月5日` / `2026-08-05`）、令和のフル表記（`令和8年8月5日`）、RFC822、および和暦の略記（`R8.8.5`）から解析します。略記は宮城県のプロポーザル一覧のような表で使われます。バージョン番号などの誤検知を避けるため、略記は行頭・空白・括弧に続く独立したトークンの場合だけ解析し、`R8.13.1`のように実在しない日付は解析しません。

ステータス:

- `OK`: 取得と解析に成功し、警告がない
- `WARNING`: 候補は取得できたが、欠損・重複・Content-Type不一致などがある
- `ERROR`: HTTP取得、解析、セレクター、またはフィルター適用後の候補取得に失敗
- `UNSUPPORTED`: 未対応の `collector_type`

終了コード:

- `0`: OKまたはWarningのみ。`--all` で無効なUnsupportedを含む場合も0
- `1`: Errorがある、指定した1件がUnsupported、または有効な情報源がUnsupported
- `2`: コマンド引数または台帳設定が不正

## RSSのフィルター

RSSは次の順で処理します。

1. RSS 2.0として解析
2. タイトルとURLを取得
3. 公式ドメイン外URLと重複URLを除外
4. `category_includes` に一致しないitemを除外
5. `title_excludes` に一致するitemを除外

フィルター適用後に候補が0件ならErrorです。RSS自体にitemがあっても、設定が厳しすぎる問題を検出できます。

## 一覧ページのリンク

一覧ページは次を除外します。

- タイトルまたはURLがないリンク
- 公式ドメイン外のリンク
- `http` / `https` 以外のリンク
- 情報源ページ自身へのリンク
- 重複URL
- `title_excludes` に一致するリンク

一覧ページのタイトルはリンクテキストそのものです。`title_excludes` の判定はRSSと共通で、NFKC正規化・小文字化・空白除去の後に部分一致で比較するため、全角の「ＦＡＱ」と半角の「FAQ」も一致します。除外した候補は本文取得、PDF抽出、AI判定、Notionの重複確認と登録へ進まず、`--limit` も消費しません。適用後に候補が0件ならErrorです。

部分一致なので、除外語は実際のタイトルに合わせて確認してください。たとえば「サービスの使い方」はサービス名が挟まる「公共施設予約サービス「よやっQ（く）北九州」の使い方」に一致しません。

相対URLは、最終的に取得した一覧ページURLを基準に絶対URLへ変換します。

## HTTPアクセスの安全対策

チェック対象は台帳に登録されたURLだけです。さらに次を実施します。

- `http` / `https` 以外を拒否
- ユーザー名・パスワードを含むURLを拒否
- 組織の `official_domain` と、そのサブドメイン以外を拒否
- IPアドレスの直接指定を拒否
- DNS解決結果がlocalhost、プライベートIP、リンクローカル、予約済みIPなら拒否
- 自動リダイレクトを使わず、各リダイレクト先を再検証
- リダイレクトは最大5回
- タイムアウトは20秒
- 展開後の応答本文は最大5MB
- 同一ホストへのアクセス間隔は既定1秒

アクセス間隔は環境変数で変更できます。

```bash
SOURCE_CHECK_INTERVAL_MS=3000 npm run sources:check -- --enabled
```

0から60000ミリ秒の整数を指定できます。自治体サイトへの負荷を抑えるため、通常は0にしないでください。

User-Agentも環境変数で指定できます。

```bash
SOURCE_CHECK_USER_AGENT="organization-source-check/0.1 (+contact@example.jp)" \
  npm run sources:check -- --enabled
```

共有運用では、実在する連絡先を含むUser-Agentを設定してください。

## 台帳の更新

チェック結果を `config/sources.yaml` へ自動書き戻ししません。結果を人が確認し、必要な場合だけ次を更新します。

```yaml
verification_status: verified
last_verified_at: "YYYY-MM-DD"
```

セレクター修正や無効化も、人が結果と実ページを確認したうえで別の変更として行ってください。

## テストとGitHub Actions

自動テストは `test/fixtures/` の保存済みRSS・HTMLを使い、外部サイトへアクセスしません。

```bash
npm test
```

通常のGitHub Actionsでも実アクセスは行いません。第三者サイトの状態に左右されるため、CIではfixtureテスト、台帳検証、lint、型検査だけを実行します。実アクセスは追加・変更時に人が明示的に実行してください。

## 現在の制約

- RSS 2.0のみ対応し、Atomは未対応
- HTMLとXMLはUTF-8として読み込む
- 個別ページと `content_selector` はこのコマンドでは確認しない
- robots.txt解析、キャッシュ、リトライ、差分検知、定期実行は行わない
- DNS検証後から接続までのネットワーク変化を完全には防げないため、信頼できる台帳を前提とする
- 技術的に取得できても、行政ニーズ情報源としての有用性は人がサンプルを見て判断する
