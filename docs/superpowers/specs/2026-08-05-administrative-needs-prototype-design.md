# 行政ニーズ収集プロトタイプ 設計書

> [!NOTE]
> この文書は初期設計と将来構想を記録したものです。現在のミニマム実装とは機能名・構成・スコープが異なる箇所があります。現行機能と実行方法はリポジトリ直下の`README.md`、運用ルールは`AGENTS.md`を正としてください。

- 作成日: 2026-08-05
- 元指示書: `行政ニーズ収集プロトタイプ Claude Code実装指示書`（PDF, 22ページ）
- 実装場所: このGitリポジトリのルート
- 本文中の「§N」は元指示書の節番号を指す

## 0. 先行作業との関係

別PRD（「行政ニーズシグナルDB」）由来の先行設計案がある。
そちらは **Next.js + SQLite の専用Webアプリ**構成であり、本指示書 §6 / §24 の「専用Webアプリ・独自DB・認証・Supabaseは作らない」「Notionを画面として使う」と正面から矛盾する。

**本設計書が対象とするのは本指示書（Notion構成）のみ。** `gyosei-needs-db` は変更せず放置する。
ただし以下は先行設計から流用する。

- `prompts/company-profile.md`（自社 = Studio の判定基準）
- 和暦・金額の正規化ルール
- 根拠一致検査の考え方
- SSRF対策の拒否リスト
- `claude -p` サブプロセスでAIを実行する判断

矛盾する箇所は**すべて本指示書を正とする**。具体的には次の3点が先行設計と異なる。

| 項目 | 先行設計 | 本設計（指示書準拠） |
| --- | --- | --- |
| AI確信度 | 0〜1 の実数 | **0〜100 の整数**（§12-1 の `"confidence":92`、§17-1 の Number） |
| 成熟段階 | 8種 | **9種**（§14 で「不明」が追加） |
| 確認状態 | 未確認/AI解析済み/承認済み/要修正/対象外 | **未確認/確認済み/要修正/対象外**（§18） |

---

## 1. 目的

自治体の公式サイトから Web・DX・デジタル領域の行政ニーズを収集し、AIで構造化して Notion データベースへ登録する**ローカル実行スクリプト**を作る。専用Webアプリは作らない。

§1 が挙げる検証目的は6つ。

1. 自治体の公式サイトから必要な情報を取得できるか
2. Web・DX・デジタル領域の情報を適切に抽出できるか
3. AIによる行政課題の整理が実用的か
4. コンタクト候補の発見につながるか
5. どの情報源を今後自動化すべきか
6. 対象自治体を後から追加できるか

全国網羅は目的ではない。初期対象は**大阪市のみ**（§4）。

## 2. スコープ

### 2-1. 含む

| 機能 | 根拠 |
| --- | --- |
| RSS / 一覧ページからの新着リンク収集 | §9, §10 |
| 個別ページの本文抽出 | §10 |
| 添付PDFのテキスト抽出 | §10 |
| 重複判定（4段階） | §11 |
| AI 2段階処理（対象判定 → 構造化解析） | §12 |
| Notion DB 登録（重複回避・人手項目の保護） | §17, §20 |
| Notion DB の自動作成（`setup:notion`） | §17（本設計での追加、後述 §16-2） |
| 手動投入（URL / テキスト / PDF） | §22 |
| ローカル永続化（処理済み・AI結果・ログ） | §21 |
| モックAIモード | §26 |
| サンプルデータ4件 | §25 |
| 単体・結合テスト | §26 |

### 2-2. 含まない（§24 のとおり）

専用Webアプリ / 独自DB画面 / 認証 / Supabase / 全国一括クロール / 議会議事録の全量取得 / マニフェスト・予算資料の自動横断取得 / 複数文書の自動クラスタリング / 同一課題の自動統合 / OCR / 自治体への自動連絡 / メール自動送信 / 担当者個人情報の推測 / CRM連携 / 入札資格の完全判定 / パートナー自動マッチング / 提案書自動作成 / 受注後の案件管理。

通知機能も初期版では実装しない（§23）。利用者は Notion の「新着・未確認」ビューを見る。

## 3. 決定事項

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript / Node.js（Node v25.2.1） | §6 の推奨。実行環境に導入済み |
| 収集の主軸 | **RSS を主軸、一覧ページで補完** | 大阪市は局単位のRSSを提供しており、`title` / `link` / `pubDate` / `category`（局名を含む分類パス）が構造化済みで取れる。§9 が `collector_type: rss` を想定内としている。詳細は §5 |
| ローカル保存 | **`node:sqlite`**（Node標準搭載） | §21 の「可能であればSQLite」を、`better-sqlite3` のネイティブビルドなしで満たせる。追加依存ゼロ |
| AI実行方法 | **`claude -p` サブプロセス** + `mock` | APIキー発行・従量課金なしで実AI品質を検証できる。Provider インターフェースで差し替え可能にし、Phase 5 のAPI移行に備える |
| HTML抽出 | **cheerio + 情報源ごとのセレクタ** + 汎用フォールバック | 大阪市CMSは `#mol_contents` が本文コンテナであることを実測確認（§6-1）。汎用Readabilityより確実かつ軽い |
| PDF抽出 | **`unpdf`**（pdfjs ラッパー） | 実在の添付PDF（4ページ / 877KB）から4,921文字を正しく抽出できることを実測確認（§7） |
| テスト | Vitest + 実取得fixture | ネットワークなしで全テストが回る |
| 列挙値の保存形式 | 指示書の日本語表記をそのまま使う | 変換レイヤーを1枚減らす。社内向け日本語ツールで i18n 要件がない |
| 認証 | なし（ローカル実行のみ） | §6, §24 |

## 4. フォルダ構成

```
administrative-needs-prototype/
├── README.md
├── .env.example
├── .env                              (gitignore)
├── .gitignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── config/
│   └── sources.yaml                  情報源定義
├── prompts/
│   ├── classify.md                   ①対象判定
│   ├── analyze.md                    ②構造化解析
│   └── company-profile.md            自社（Studio）の定義
├── data/                             (gitignore)
│   ├── app.db                        node:sqlite
│   ├── raw/                          取得した本文・PDFのキャッシュ
│   └── logs/                         実行ログ (JSONL)
├── samples/                          §25 の4サンプル（モック用の固定本文）
├── docs/superpowers/specs/           本設計書
├── test/
│   ├── fixtures/                     実取得したHTML / RSS / PDF
│   └── *.test.ts
└── src/
    ├── collect.ts                    エントリ: 収集フロー
    ├── import.ts                     エントリ: 手動投入
    ├── setup-notion.ts               エントリ: Notion DB作成
    ├── config.ts                     sources.yaml 読み込み + Zod検証
    ├── collectors/
    │   ├── index.ts                  collector_type → 実装のディスパッチ
    │   ├── rss.ts
    │   └── list-page.ts
    ├── fetch-page.ts                 HTTP取得（SSRF / サイズ上限 / タイムアウト / リトライ）
    ├── rate-limiter.ts               ホスト単位のアクセス間隔
    ├── extract-content.ts            HTML本文抽出
    ├── extract-pdf.ts                PDFテキスト抽出
    ├── ai/
    │   ├── provider.ts               インターフェースと型
    │   ├── claude-cli.ts             ClaudeCliProvider
    │   ├── mock.ts                   MockProvider
    │   ├── schema.ts                 Zod スキーマ（§12-1 / §12-2）
    │   ├── prompt.ts                 prompts/*.md の読み込みと組み立て
    │   └── index.ts                  環境変数によるプロバイダ選択
    ├── normalize.ts                  日付（和暦/西暦）・金額の正規化
    ├── evidence.ts                   根拠一致検査
    ├── url.ts                        URL正規化
    ├── dedupe.ts                     重複判定（§11 の4段階）
    ├── store.ts                      SQLite アクセス
    ├── notion.ts                     Notion API クライアント
    ├── notion-schema.ts              プロパティ定義（単一の真実）
    ├── notion-map.ts                 AI出力 → Notionプロパティ変換
    ├── logger.ts                     実行ログ
    ├── errors.ts                     エラーコードと文言
    └── types.ts
```

### 設計原則

1. **ロジックは純粋関数に置き、エントリポイントは薄い組み立てだけにする。** URL正規化・日付/金額正規化・Zod検証・根拠検査・重複判定・Notionプロパティ変換は、ネットワークもDBもNotionも要らない単体テストで検証できる。

2. **`notion-schema.ts` を単一の真実にする。** `setup:notion` がこれを読んでDBを作り、`collect` 起動時のプロパティ検証も同じ定義を読む。プロパティ名の綴りズレが構造的に起きなくなり、§20 の「プロパティが存在しない場合は分かりやすいエラー」も同じ定義から自動生成できる。

3. **プロンプトは `prompts/*.md` に外置きする。** 検証の主目的はAI出力の質であり、コードを触らずに文言を直して再実行できる状態が必要。

## 5. 情報源

### 5-1. 調査結果（2026-08-05 実測）

大阪市公式サイトを実際に調査して確認した事実。

**RSSが局単位で提供されている。** 各100件。

| フィード | URL |
| --- | --- |
| 全市 | `https://www.city.osaka.lg.jp/main/rss/rss.xml` |
| デジタル統括室 | `https://www.city.osaka.lg.jp/ictsenryakushitsu/rss/rss.xml` |
| 産業・ビジネス | `https://www.city.osaka.lg.jp/sangyo/rss/rss.xml` |
| 市政 | `https://www.city.osaka.lg.jp/shisei/rss/rss.xml` |

各 `<item>` は `title` / `link` / `pubDate`（RFC822）/ `category`（複数可）を持つ。`category` は分類パス形式で、局名を含む。

```
入札契約情報->各局等入札契約情報->デジタル統括室->入札・契約のお知らせ
方針・条例->主要な計画、指針・施策->事業別計画、指針・施策->DX・デジタル化・スマートシティ->スーパーシティ
```

**一覧ページとして有用なもの。**

| ページ | URL | 役割 |
| --- | --- | --- |
| プロポーザル方式等発注案件 | `https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/0-Curr.html` | 全局横断の公募案件。常時15件以上。対象・対象外が自然に混在 |
| デジタル統括室 報道発表資料 | `https://www.city.osaka.lg.jp/hodoshiryo/98-Curr.html` | 上流シグナル（DX推進本部会議・AI活用基本方針・CXサービスグランドデザイン・スマートシティ戦略） |

プロポーザル一覧のURLは `/templates/proposal_hattyuuannkenn/<局コード>/<記事ID>.html` の形式で、**パスに局コードが含まれる**（`seisakukikakushitsu` / `keizaisenryaku` / `port` / `kodomo` など）。担当部署候補として利用できる。

**使えないと判明したもの。**

- デジタル統括室「新着情報一覧」（`/ictsenryakushitsu/news/curr.html`）は**空**。月次ローテーション（`curr` / `prev1` / `prev2`）で、月初は中身がない。`prev1` も空だった。情報源にしない。
- 指定管理者 募集・選定状況（`/keiyakukanzai/page/0000181355.html`）は施設運営中心でWeb・DX関連度が低い。`enabled: false` で定義だけ置く。

**アクセス条件。**

- `robots.txt` は 404（クロール制限の宣言なし）。それでもレート制限をかける（§10）。
- 本文中に **CC-BY 4.0** の表記がある。本文の保存・引用に問題はない。

**検証に最適な実在ページ。**

`https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html`
「大阪市CXサービスデザイン推進事業に係る情報提供について」

- デジタル統括室 / 公開日 2026-07-30 / 参加申込期限 2026-08-10 / 情報提供提出期限 2026-08-21
- §12-2 の出力例にある `"published_at":"2026-07-30"` `"deadline":"2026-08-21"` と完全一致する。指示書はこのページを見て書かれている
- **2026-08-05 時点で公募中**
- 本文（`#mol_contents`）から1,753文字が抽出でき、締切・メールアドレス（`bb0010@city.osaka.lg.jp`）・電話番号・担当部署がすべて本文内にある
- 詳細要件は添付 `01_youryou5.pdf`（4ページ / 877KB）側にある。**PDF抽出は任意機能ではなく必須**

### 5-2. `config/sources.yaml`

情報源はコードへ直接書かず、YAMLで管理する（§9）。新しい自治体・情報源は原則としてこのファイルへの追記だけで追加できる。

```yaml
defaults:
  request_interval_ms: 3000        # 同一ホストへの最小アクセス間隔
  timeout_ms: 20000
  max_retries: 2
  max_bytes: 10485760              # 10MB
  # 初回セットアップ時に連絡先を実在のメールアドレスへ差し替える（README に手順を記載）。
  # 自治体サイトへのアクセス主体を明示するため、プレースホルダのまま運用しない。
  user_agent: "administrative-needs-prototype/0.1 (+<連絡先メールアドレス>)"
  max_items_per_run: 60            # 1情報源あたりの上限（暴走防止）

sources:
  - id: osaka-digital-rss
    organization: 大阪市
    name: デジタル統括室 RSS
    url: https://www.city.osaka.lg.jp/ictsenryakushitsu/rss/rss.xml
    collector_type: rss
    enabled: true
    category_includes:              # 空なら全件通す
      - 入札契約情報
      - DX・デジタル化・スマートシティ
      - 主要な計画、指針・施策
    title_excludes:                 # 結果公表のみを落とす（後述）
      - 入札結果
      - 随意契約結果
      - 選定結果
      - 再委託状況
      - 要綱・要領等

  - id: osaka-proposal-list
    organization: 大阪市
    name: プロポーザル方式等発注案件
    url: https://www.city.osaka.lg.jp/templates/proposal_hattyuuannkenn/0-Curr.html
    collector_type: list_page
    enabled: true
    link_selector: "#mol_contents a[href*='/templates/proposal_hattyuuannkenn/']"
    content_selector: "#mol_contents"

  - id: osaka-digital-press
    organization: 大阪市
    name: デジタル統括室 報道発表資料
    url: https://www.city.osaka.lg.jp/hodoshiryo/98-Curr.html
    collector_type: list_page
    enabled: true
    link_selector: "#mol_contents a[href*='/hodoshiryo/ictsenryakushitsu/']"
    content_selector: "#mol_contents"

  - id: osaka-shitei-kanri
    organization: 大阪市
    name: 指定管理者 募集・選定状況
    url: https://www.city.osaka.lg.jp/keiyakukanzai/page/0000181355.html
    collector_type: list_page
    enabled: false                  # Web・DX関連度が低いため初期は無効
    link_selector: "#mol_contents a[href*='/page/']"
    content_selector: "#mol_contents"
```

`collector_type` は §9 のとおり `list_page` / `rss` / `single_page` / `manual` / `custom` を型として定義する。初期実装は `rss` と `list_page` のみ。`single_page`（1ページを定期的に見る）は `list_page` のリンク抽出をスキップするだけなので後から容易に足せる。`custom` は自治体固有コレクターを追加する場合の逃げ道として型だけ用意する。

`config.ts` は Zod でこのYAMLを検証し、未知の `collector_type` や必須項目の欠落を起動時に弾く。

### 5-3. 事前絞り込みの方針

**Web・DXのキーワードによる絞り込みは行わない。** それは §12-1 のAI対象判定の仕事であり、ここで機械的に落とすと §28 の精度検証（対象・対象外を混ぜて評価する）が成立しない。

`title_excludes` で落とすのは **結果公表のみ**（「入札結果」「随意契約結果」「選定結果」「再委託状況」「要綱・要領等」）。これらは過去の結果であって民間へのニーズではないため、Web・DX関連度の判断を含まない安全な除外である。デジタル統括室RSSの実データにはこれらが多数含まれており、除外しないとAI呼び出しが無駄になる。

**照合方法**: `title_excludes` / `category_includes` はいずれも**部分一致**（正規表現ではない）。照合前にタイトルとカテゴリの両方を全角→半角統一・空白除去で正規化する（§10 の前処理と同じ関数を使う）。`title_excludes` はどれか1つに一致すれば除外、`category_includes` はどれか1つを含めば通過。`category_includes` が空配列または未指定なら全件通過。

**除外した件数と内訳（どのパターンで何件落ちたか）は必ずログに出す。** 黙って件数を絞ると「全部見た」と誤読されるため。

## 6. 情報取得処理

### 6-1. 一覧ページ（§10）

`link_selector` で個別案件へのリンクを抽出し、以下を取得する。

- リンクテキスト
- URL（相対URLは絶対化する。大阪市は `./cmsfiles/...` 形式の相対URLを使う）
- 一覧上の日付（リンク近傍のテキストから抽出。取れなければ null）
- 周辺テキスト（`<li>` / `<td>` / 直近の親要素のテキスト、最大200文字）

同じドメイン内のリンクを優先し、外部ドメインへのリンクは除外する。
`max_items_per_run` で1回の実行で扱う件数に上限をかける。

### 6-2. RSS

`title` / `link` / `pubDate` / `category[]` を取得する。`pubDate` は RFC822 をパースして `YYYY-MM-DD` に落とす。
`category_includes` が指定されていれば、いずれかの文字列を含む `category` を持つ item のみ通す。
`category` の分類パス末尾付近に局名が現れる場合（`->デジタル統括室->`）、担当部署の候補として保持する。

### 6-3. 個別ページ（§10）

`content_selector` で本文を抽出し、以下を得る。セレクタは情報源ごとに指定し、既定は `#mol_contents`。

**セレクタが一致しなかった場合のフォールバック順序**を固定する。

1. `<main>`
2. `<article>`
3. `[role="main"]`
4. `#contents` / `#content` / `.content`（この順）
5. 上記すべて外れた場合: `<body>` から `script` / `style` / `nav` / `header` / `footer` / `aside` / `form` を除去したうえで、テキスト長が最大の `<div>` を選ぶ

どのフォールバック段まで降りたかをログに記録する。5段目まで降りた件が多い情報源は、`content_selector` を設定すべき合図として扱う。

- ページタイトル（`<h1>` または `<title>` から、サイト名サフィックスを除去）
- URL
- HTML本文（テキスト化）
- 公開日候補（本文中の日付表現、`<time>`、一覧上の日付、RSSの `pubDate` の順に採用）
- 担当部署候補（問い合わせ先ブロック、RSSのcategory、URLパスの局コードから）
- 添付PDFのURL（`href` が `.pdf` で終わるもの。相対URLを絶対化）
- 問い合わせ情報候補（メールアドレス・電話番号の正規表現＋「問合せ先」ブロック）

ナビゲーション・ヘッダー・フッター・パンくず・広告は `content_selector` の外なので自然に除外される。

**大阪市CMS固有の末尾定型文を除去する。** 実測で本文末尾に以下が付くことを確認している。

- 「CC（クリエイティブコモンズ）ライセンス における CC-BY4.0 で提供いたします。」
- 「オープンデータを探す 大阪市オープンデータポータルサイト」
- 「Adobe Acrobat Reader DCのダウンロード（無償）」
- 「PDFファイルを閲覧できない場合には…」
- 「探している情報が見つからない」

除去マーカーの一覧を `extract-content.ts` に持つ。**問い合わせ先ブロックは除去マーカーより先に抽出する**（有用な情報なので落とさない）。

抽出本文が200文字未満なら `EXTRACT_FAILED` として扱い、その件はスキップする。

### 6-4. アクセス制御（§10）

- ホスト単位で `request_interval_ms`（既定3秒）の間隔を空ける（`rate-limiter.ts`）
- タイムアウト `timeout_ms`（既定20秒）
- リトライは `max_retries`（既定2回）まで。指数バックオフ
- レスポンスサイズ上限 `max_bytes`（既定10MB）を `Content-Length` とストリーム実測の両方で強制
- `User-Agent` に連絡先を含める
- robots.txt は取得を試み、存在すれば `Disallow` を尊重する（大阪市は404だが他自治体では存在しうる）
- ログイン・画像認証は回避しない。認証が必要なページは扱わない

## 7. PDF抽出（§10）

`unpdf`（pdfjs ラッパー）を使う。テキスト抽出可能なPDFのみ対象とし、**OCRは行わない**（§24）。

実測で確認した挙動と対策。

| 事象 | 対策 |
| --- | --- |
| `Math.sumPrecise is not a function` の警告が多数出る（Node 25 に未実装） | 読み込み前に polyfill を当てる。当てても抽出結果は 4,921文字で同一だったので、警告は表示上の問題のみ |
| `TT: undefined function` の警告（埋め込みTrueTypeフォント由来） | 無害。抽出結果に影響しない。ログレベルを下げて抑制する |
| **日本語の途中に空白が入る**（`令和 8 年 8 月 21 日`、`大阪市 CX サービスデザイン`） | 日付・金額の正規化と根拠一致検査の前処理で空白を除去する |
| **全角数字と半角数字が同一文書内で混在**（`令和 8 年` と `令和８年８月`） | 正規化の前処理で全角→半角に統一する |

抽出できない場合（画像PDF・スキャンPDF・破損）は `PDF_EXTRACT_FAILED` をログに記録するが、**その件を失敗にはしない**。§10 のとおり公式PDFのURLだけを記録して処理を続ける。

複数のPDFが添付されている場合は、`.pdf` のもののみを対象とし、合計文字数に上限（既定50,000文字）をかけてから本文へ追記する。追記時は `--- 添付PDF: <ファイル名> ---` の区切りを入れ、本文とPDF由来テキストの境界が分かるようにする。根拠一致検査でどちらに含まれるかを判別するため。

## 8. AI処理（§12）

### 8-1. Provider インターフェース

```ts
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
  analyze(input: AnalyzeInput): Promise<AnalyzeResult>;
}

export type AnalysisInput = {
  title: string;
  bodyText: string;          // 本文 + 添付PDFテキスト
  sourceUrl: string;
  organizationHint?: string | null;
  documentTypeHint?: string | null;
  publishedAtHint?: string | null;
};

export type ClassifyResult = { data: Classification; raw: string };
export type AnalyzeResult  = { data: NeedAnalysis;  raw: string };
```

`raw`（モデルの生出力）を必ず保持する。プロンプト改善のために生出力が必要。

### 8-2. `ClaudeCliProvider`

```
claude -p \
  --output-format json \
  --model <AI_MODEL> \
  --allowed-tools "" \
  --append-system-prompt "<prompts/*.md の内容>"
```

- **本文は stdin で渡す。** 引数長制限とシェルエスケープ事故を避ける
- `--allowed-tools ""` でツール実行を禁止する。副作用ゼロにし応答も速くなる
- `--output-format json` は `{ "result": "...", ... }` のエンベロープを返すため `result` を取り出す。コードフェンス（```json …）で包まれていても剥がしてから `JSON.parse` → Zod検証
- タイムアウト既定180秒。超過時はプロセスを kill し `AI_TIMEOUT`
- CLIが見つからない・非ゼロ終了なら `AI_UNAVAILABLE`

**実装の最初のステップで `claude --help` を実測し、上記オプション名が現行CLI（v2.1.88）に存在することとヘッドレス動作を確認する。** 異なる場合は実測結果に合わせる。

### 8-3. `MockProvider`

`prompts/` を読まず、入力タイトルに応じて §25 の4サンプルに対応する固定JSONを返す。
`AI_PROVIDER=mock` で選択。claude CLI なしで全フローが通る状態を維持する（§26, §27）。

### 8-4. 2段階処理

**① 対象判定**（`prompts/classify.md`）

```json
{ "is_target": true, "reason": "市民向けポータルと行政DXに関する情報提供依頼である", "confidence": 92 }
```

対象外の場合は詳細解析を行わない（§12-1）。

**② 構造化解析**（`prompts/analyze.md`）— 対象と判定された場合のみ

§12-2 の出力形式をそのまま使う。全26フィールド。

```
document_type, organization_name, department_name, published_at, deadline, budget,
official_title, need_title, problem_summary, background, desired_state,
request_to_private_sector, categories[], maturity_stage, domain_relevance,
domain_relevance_reason, company_relevance, company_relevance_reason,
possible_company_roles[], required_partners[], contact_recommendation,
recommended_action, questions_to_confirm[], risks_and_conditions[],
confidence, evidence_quotes[]
```

**対象外情報の扱い。** §12-1 は「精度検証のため、対象外情報も任意でNotionへ記録できる設定を持たせる」としている。本設計では `RECORD_NON_TARGET=true` を**既定ON**にする。初期の目的が精度検証（§28）であり、§19 の「対象外・見送り」ビューも「精度検証のため、対象外情報を削除しない」と明示しているため。対象外は最小プロパティ（タイトル・自治体・公式URL・文書種別・AI確信度・根拠・検知日・AI処理日時）＋確認状態 `対象外` で登録する。

### 8-5. Zodスキーマ（`src/ai/schema.ts`）

- `is_target` は boolean
- `confidence` は **0〜100 の整数**（§12-1, §17-1）
- 日付はすべて `YYYY-MM-DD` または `null`。正規表現で検証
- `budget` は数値（円単位）または `null`
- `maturity_stage` / `domain_relevance` / `company_relevance` / `contact_recommendation` / `document_type` は §9 の列挙
- `categories` / `possible_company_roles` / `required_partners` / `questions_to_confirm` / `risks_and_conditions` は文字列配列
- `evidence_quotes` は `{ field: string, quote: string }[]`
- 余剰キーは無視する（Zod `z.object()` の既定挙動）
- 欠損・不正enum・不正日付形式は `AI_INVALID_RESPONSE`

正規化（§10）は **Zod検証の前**に通す。モデル出力は揺れるため。

## 9. 列挙値

`src/types.ts` に `as const` で定義し、Zod enum と Notion の Select 選択肢の両方から参照する。

| 分類 | 値 | 根拠 |
| --- | --- | --- |
| 文書種別 | `RFI` / `情報提供依頼` / `サウンディング` / `民間提案` / `プロポーザル` / `入札` / `実証事業` / `官民連携` / `議会` / `予算` / `計画` / `マニフェスト` / `審議会` / `行政評価` / `その他` | §18 |
| ニーズ成熟段階 | `課題表明` / `政策方針` / `検討中` / `予算化` / `市場対話` / `公募中` / `実施中` / `評価・再検討` / `不明` | §14 |
| 分野関連度 | `A` / `B` / `C` / `対象外` | §15 |
| 自社関連度 | `A` / `B` / `C` / `対象外` | §15 |
| コンタクト推奨度 | `高` / `中` / `低` / `不要` | §16 |
| 確認状態（人手） | `未確認` / `確認済み` / `要修正` / `対象外` | §18 |
| 対応判断（人手） | `未判断` / `追う` / `保留` / `継続監視` / `見送り` / `対応中` / `終了` | §18 |
| 温度感（人手） | `未確認` / `低い` / `情報交換` / `関心あり` / `具体的な相談あり` / `案件化可能性あり` | §18 |

**文書種別に `RFI` と `情報提供依頼` の両方があるのは指示書 §18 のとおり。** 実質同義だが、指示書に忠実に両方を選択肢として用意する。プロンプトでは「英語表記の公式名称がある場合は `RFI`、日本語で『情報提供依頼』と書かれている場合は `情報提供依頼`」と使い分けを指示し、実データの分布を見てから統合を検討する（READMEの制約に記載）。

**分野（`categories`）は列挙で縛らない。** §5 に40項目以上あり、初期段階で固定すると実際の分布が見えなくなる。Notion の Multi-select には §5 の一覧を初期投入し、プロンプトでその一覧から選ぶよう指示するが、外れた値は Notion 側で自動追加させてログに出す。実データを見てから正規化する。

## 10. 正規化（`src/normalize.ts`）

プロンプトで西暦・円単位を指定するが、モデル出力とPDF由来テキストは揺れるため後処理で吸収する。

**前処理（必須）**: 全角→半角統一、空白・改行の除去。§7 のとおりPDF由来テキストは `令和 8 年 8 月 21 日` のように日本語の途中に空白が入り、全角半角が混在する。

### 日付

| 入力 | 出力 |
| --- | --- |
| `令和8年8月21日` / `令和 8 年 8 月 21 日` / `令和８年８月21日` | `2026-08-21` |
| `令和8年8月21日（金曜日）17時00分` | `2026-08-21` |
| `2026/8/21` / `2026.8.21` / `2026年8月21日` | `2026-08-21` |
| `8月21日`（年なし）＋公開日が2026年 | `2026-08-21` |
| `未定` / `-` / 空 / 判定不能 | `null` |

和暦の元号は令和のみ対応する（令和1年 = 2019年、令和8年 = 2026年）。平成以前の日付は本用途では現れない。現れた場合は `null` にしてログに残す。

### 金額

| 入力 | 出力（円） |
| --- | --- |
| `1,200万円` | `12000000` |
| `12,000,000円` | `12000000` |
| `1億2千万円` | `120000000` |
| `約500万円程度` | `5000000` |
| `-` / `未定` / 空 | `null` |

## 11. 根拠一致検査（`src/evidence.ts`）

§13 は「主要な判断には、可能な限り根拠となる原文抜粋を付ける」「AIは日付・金額・担当部署・個人名・連絡先・参加資格・公募予定・自治体の正式方針を捏造しない」と要求するが、プロンプトだけでは保証できない。保存前に機械検査する。

- `evidence_quotes[].quote` が本文（HTML由来 + PDF由来）に部分文字列として含まれるかを検証する
- 比較前に、空白・改行・全角半角スペース・全角半角数字・連続空白を正規化する。§7 のとおりPDF由来テキストには日本語の途中に空白が入るため、この正規化なしでは全件が不一致になる
- 一致しない引用があれば `EVIDENCE_MISMATCH` として記録し、**その件を失敗にはしない**。Notion の「根拠」プロパティとページ本文に警告を併記する

## 12. 重複判定（§11）

### 判定の優先順位

1. 公式URL（完全一致）
2. 正規化URL（`url.ts`: スキームをhttpsに、`www.` を保持、末尾スラッシュ統一、追跡パラメータ `utm_*` / `fbclid` などを除去、フラグメント除去、パーセントエンコーディングを正規化）
3. 本文ハッシュ（`sha256(正規化した本文)`）
4. 自治体名 + タイトルの組み合わせ

### Notion 側の確認

§11 のとおり、**ローカルDBに無くてもNotionを公式URLで検索する。** ローカルDBを消した場合や別マシンで実行した場合にも重複を作らない。
検索は Notion の `POST /v1/databases/{id}/query` に `公式URL` の `equals` フィルタを使う。

### 更新検知

同じURLで `content_hash` が変わっていた場合、§11 のとおり高度な差分管理は行わない。

- Notion の「更新あり」Checkbox を `true` にする
- ログへ記録する
- **再解析はしない**（初期版）

## 13. ローカル保存（§21）

`node:sqlite` を使い `data/app.db` に保存する。

### `processed`

| 列 | 型 | 用途 |
| --- | --- | --- |
| `url_normalized` | TEXT PK | 正規化URL |
| `url` | TEXT NOT NULL | 元URL |
| `source_id` | TEXT | どの情報源から来たか |
| `organization` | TEXT | 自治体名 |
| `title` | TEXT | ページタイトル |
| `content_hash` | TEXT NOT NULL | `sha256(正規化本文)` |
| `is_target` | INTEGER | 0/1、未判定は NULL |
| `status` | TEXT NOT NULL | 後述 |
| `error_code` | TEXT | エラーコード |
| `error_detail` | TEXT | 内部詳細（Notionへは出さない） |
| `ai_provider` / `ai_model` | TEXT | 使用したProviderとモデル |
| `ai_classify_json` | TEXT | ①対象判定の結果（生出力込み） |
| `ai_analyze_json` | TEXT | ②構造化解析の結果（生出力込み） |
| `analyzed_at` | TEXT | AI処理日時（ISO 8601） |
| `notion_page_id` | TEXT | 登録済みのNotionページID |
| `notion_synced_at` | TEXT | Notion登録日時 |
| `first_seen_at` / `last_seen_at` | TEXT NOT NULL | 検知日時 |

`status`: `pending_analysis` / `analyzed` / `pending_notion` / `synced` / `skipped` / `failed`

インデックス: `content_hash` / `status` / `(organization, title)` / `notion_page_id`

### `run_logs`

実行単位のサマリ。`run_id` / `started_at` / `finished_at` / `source_id` / `found` / `excluded` / `fetched` / `analyzed` / `target` / `non_target` / `synced` / `failed`。

本文とPDFの生データは `data/raw/<sha256の先頭2文字>/<sha256>.txt` にキャッシュする（§21）。
明細ログは `data/logs/<YYYY-MM-DD>.jsonl` に1行1イベントで追記する（§18相当）。

### Notion書き込み失敗時の保全（§21）

**AI解析結果をNotion書き込みの前にSQLiteへ確定させる。** これが §21「Notion書き込みに失敗した場合でも、取得内容とAI解析結果を失わないようにする」の実装。

書き込みに失敗した行は `status = pending_notion` で残り、**次回 `npm run collect` の冒頭で再送する**。Notionが落ちていても収集とAI解析が無駄にならない。

## 14. データフロー

```
config/sources.yaml
      ↓
collect.ts ─── 冒頭で status=pending_notion を再送（§21）
      ↓
collectors/  rss.ts | list-page.ts   → 候補 { url, linkText, listDate, context, categoryHint }
      ↓
title_excludes による除外（結果公表のみ。除外件数をログ）
      ↓
dedupe.ts   処理済みURLを除外 ← fetch前に切る
      ↓
fetch-page.ts   レート制限 / タイムアウト / リトライ / サイズ上限 / SSRF検証
      ↓
extract-content.ts   本文・公開日候補・部署候補・添付PDF URL・問い合わせ候補
      ↓
extract-pdf.ts   添付PDFのテキストを本文へ追記（抽出不能ならURLのみ記録し継続）
      ↓
store.ts   本文とハッシュを保存（status=pending_analysis）
      ↓
analyze.ts   ①対象判定 → 対象外なら②スキップ
      ↓
normalize.ts（日付・金額）→ Zod検証 → evidence.ts（根拠一致検査）
      ↓
store.ts   AI結果を保存（status=analyzed）★Notionより先
      ↓
notion.ts   公式URLで既存検索 → 無ければ作成 / あれば自動項目のみ更新
      ↓
store.ts   notion_page_id を記録（status=synced）
           失敗時は status=pending_notion で次回再送
      ↓
サマリ出力: 発見N / 除外E / 取得F / 対象T / 対象外X / Notion登録S / 失敗L
```

**1件の失敗で全体を止めない。** 件ごとに try/catch してログに記録し次へ進む。最後にサマリを出す。

## 15. 手動投入（§22）

```bash
npm run import -- --url "https://example.jp/page"
npm run import -- --file "./data/input.txt"
npm run import -- --file "./data/document.pdf"
npm run import -- --file "./data/document.pdf" --organization "大阪市" --type "計画"
npm run import -- --text "本文をここに直接..." --title "タイトル"
```

`--organization` と `--type` は任意。指定があればAI抽出値より**優先し、AIの値で上書きしない**。

`--url` の場合は `fetch-page.ts` → `extract-content.ts` を通す。`--file` は拡張子で分岐し、`.pdf` は `extract-pdf.ts`、それ以外はテキストとして読む。以降は収集フローと同じ経路（AI → Notion）を通る。

手動投入は §4 の「手動投入する情報」（議会議事録・委員会資料・施政方針・マニフェスト・総合計画・中期計画・DX推進計画・予算資料・審議会資料・行政評価）の検証手段。これらの自動取得は初期スコープ外（§4）。

### SSRF対策（`src/fetch-page.ts`）

手動投入で任意URLを受けるため必要。

- `http` / `https` のみ許可
- ホスト名解決後のIPを検査し、以下を拒否: ループバック（`127.0.0.0/8`, `::1`）、プライベート（`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`）、リンクローカル（`169.254/16`, `fe80::/10`）、メタデータサービス（`169.254.169.254`）、`0.0.0.0`
- リダイレクトは最大3回、各ホップで上記検査を再実行する

## 16. Notion

### 16-1. プロパティ定義

Notion に「行政ニーズDB」を1つ作成する。複数DBへの分割やRelationは使わない（§17）。
プロパティは自動入力27個（§17-1）＋人手入力11個（§17-2）＋本設計での追加1個 = **39個**。

**自動入力（スクリプトが書く）**

| プロパティ名 | Notion型 | 由来 |
| --- | --- | --- |
| タイトル | Title | `official_title`（空なら `need_title`） |
| 自治体・組織 | Select | `organization_name` |
| 担当部署 | Text | `department_name` |
| 文書種別 | Select | `document_type` |
| 公開日 | Date | `published_at` |
| 期限 | Date | `deadline` |
| 公式URL | URL | 収集したURL |
| 行政課題 | Text | `problem_summary` |
| 課題の背景 | Text | `background` |
| 実現したい状態 | Text | `desired_state` |
| 民間に求めること | Text | `request_to_private_sector` |
| 分野 | Multi-select | `categories[]` |
| 成熟段階 | Select | `maturity_stage` |
| 分野関連度 | Select | `domain_relevance` |
| 自社関連度 | Select | `company_relevance` |
| 関連度の理由 | Text | `domain_relevance_reason` と `company_relevance_reason` を見出し付きで結合 |
| 想定する自社の役割 | Multi-select | `possible_company_roles[]` |
| 必要なパートナー | Multi-select | `required_partners[]` |
| コンタクト推奨度 | Select | `contact_recommendation` |
| 推奨アクション | Text | `recommended_action` |
| 確認したいこと | Text | `questions_to_confirm[]` を箇条書き結合 |
| リスク・参加条件 | Text | `risks_and_conditions[]` を箇条書き結合 |
| AI確信度 | Number | `confidence`（0〜100の整数） |
| 根拠 | Text | `evidence_quotes[]` の結合（全件はページ本文へ） |
| 検知日 | Date | 収集実行日 |
| AI処理日時 | Date | 解析完了時刻 |
| 更新あり | Checkbox | `content_hash` 変化時に `true` |
| **予算** | **Number** | **`budget`（円単位）— 本設計での追加。後述** |

**人手入力（スクリプトは書かない）**

| プロパティ名 | Notion型 |
| --- | --- |
| 確認状態 | Select |
| 対応判断 | Select |
| 社内担当 | Person |
| コンタクト先 | Text |
| コンタクト日 | Date |
| 温度感 | Select |
| 面談メモ | Text |
| 次のアクション | Text |
| 次回確認日 | Date |
| 見送り理由 | Text |
| 社内メモ | Text |

#### 「予算」プロパティの追加理由

§12-2 のAI出力には `budget` があり、§13 は予算を「原文で確認できる場合のみ出力する事実情報」として挙げ、§16 は「予算化されている」をコンタクト推奨度「中」の判断材料としている。しかし §17-1 のプロパティ一覧に予算の置き場がない。

抽出した予算を捨てるか本文に埋めるかしかなくなるため、**Number型（円単位）のプロパティを1つ追加する。** 指示書への明示的な追加としてREADMEに記載する。

#### 人手項目を書かない規則の唯一の例外

**新規作成時のみ「確認状態」に `未確認` を設定する。更新時は触らない。**

§19 の「新着・未確認」ビューは `確認状態 = 未確認` でフィルタするが、Notion の Select には既定値の概念がない。空のままだとこのビューに1件も現れず、§23「利用者はNotionの『新着・未確認』ビューを確認する」が成立しない。

対象外と判定された情報については、新規作成時に `対象外` を設定する（§19 の「対象外・見送り」ビューが機能するため）。

これ以外の人手項目は、新規作成時も更新時も一切書かない。

#### Multi-select の初期選択肢

表記揺れを抑えるため、`setup:notion` で選択肢を初期投入し、プロンプトでその一覧から選ぶよう指示する。Notion は未知のオプションを自動追加するため、外れた値も失われないが**追加が起きたらログに出す**。

| プロパティ | 初期選択肢の出典 |
| --- | --- |
| 分野 | §5「原則として対象」＋「内容を見て判断」の全項目 |
| 想定する自社の役割 | §3「自社にとっての機会」（Webサイト・ポータル構築 / CMS導入 / UI・UX設計 / コンテンツ運用 / 運用内製化支援 / 共同提案） |
| 必要なパートナー | §15 の想定パートナー（地域の制作会社 / 広告代理店 / SIer / コンサルティング会社 / 自治体向けシステム事業者） |
| 自治体・組織 | 大阪市（＋§4 の追加予定: 福岡市 / 横浜市 / 札幌市 / 石川県 / 静岡県） |

### 16-2. `setup:notion`

§20 は「初期版では、スクリプトがNotion DB自体を自動作成する必要はない」としているが、**39プロパティの手作業はミスの温床**であり、プロパティ名が1文字違うだけで全件の書き込みが失敗する。`npm run setup:notion` で自動作成する。

```bash
npm run setup:notion -- --parent-page-id <ページID>
```

- `notion-schema.ts` の定義を読み、`POST /v1/databases` でDBを作成する
- Select / Multi-select の選択肢を同時に投入する
- 作成した `database_id` を標準出力に出し、`.env` へ書く手順を案内する
- 既存DBを指定した場合（`--database-id`）は**不足プロパティの追加のみ**を行い、既存プロパティの型変更や削除はしない

前提として、Notion の Integration トークン発行と親ページへの接続は手動で行う（APIでは不可能）。README に手順を書く。

**ビューは Notion API で作成できない。** §19 の6ビューは README に作成手順（フィルタ条件・ソート）を表で記載する。

### 16-3. ビュー（§19、手動作成）

| ビュー名 | フィルタ | ソート |
| --- | --- | --- |
| 新着・未確認 | 確認状態 = 未確認 | 検知日 降順 |
| コンタクト候補 | 自社関連度 が A または B / コンタクト推奨度 が 高 または 中 / 対応判断 が 未判断 または 追う | コンタクト推奨度、期限 昇順 |
| 市場対話・公募 | 文書種別 が RFI / **情報提供依頼** / サウンディング / 民間提案 / プロポーザル / 入札 のいずれか | 期限 昇順 |
| 上流シグナル | 文書種別 が 議会 / 予算 / 計画 / マニフェスト / 審議会 / 行政評価 のいずれか | 公開日 降順 |
| 継続監視 | 対応判断 = 継続監視 | 次回確認日 昇順 |
| 対象外・見送り | 確認状態 = 対象外 または 対応判断 = 見送り | 検知日 降順 |

§19 のとおり、**精度検証のため対象外情報を削除しない。**

「市場対話・公募」ビューのフィルタに **`情報提供依頼` を追加している**。§19 の記載は `RFI` / `サウンディング` / `民間提案` / `プロポーザル` / `入札` の5つだが、§18 の文書種別には `RFI` と `情報提供依頼` の両方が選択肢として存在するため、追加しないと `情報提供依頼` と判定されたレコードがこのビューから消える。

### 16-4. API連携の実装要件（§20）

- **レート制限**: Notion API は平均3リクエスト/秒。リクエスト間隔を333ms以上空ける
- **429応答**: `Retry-After` ヘッダを尊重して待機・リトライ（最大3回）
- **長いテキストの切り詰め**: rich_text は1テキストオブジェクト2,000文字上限。全Textプロパティを2,000文字で切り、切り詰めたら末尾に `…` を付ける
- **プロパティとページ本文の役割分担**:
  - プロパティ = 検索・絞り込み・ビュー用（切り詰めあり）
  - **ページ本文（children blocks）= 原文全文・根拠の逐語引用全件・添付PDFのURL一覧**（切り詰めなし。2,000文字ごとに分割したパラグラフブロックで積む）
- **既存レコードの検索**: 公式URLの `equals` フィルタで検索し、あれば新規作成しない
- **既存レコードの更新**: 自動入力プロパティのみ `PATCH /v1/pages/{id}`。人手項目は含めない
- **プロパティ検証**: 起動時に `GET /v1/databases/{id}` を1回呼び、`notion-schema.ts` の定義と照合する。不足・型不一致があれば `NOTION_SCHEMA_MISMATCH` で**即停止**する（1件ずつ失敗させない）。エラーには不足しているプロパティ名と期待する型を列挙する
- **APIエラーはログへ記録する**

## 17. エラー処理

エラーは `{ code, userMessage, internalDetail }` で表現する（`src/errors.ts`）。
コンソールとログには `userMessage` を出し、`internalDetail` はSQLiteとログファイルにのみ残す。

| コード | 発生条件 | 挙動 |
| --- | --- | --- |
| `CONFIG_INVALID` | sources.yaml の検証失敗 | **起動時に即停止** |
| `NOTION_SCHEMA_MISMATCH` | プロパティ欠落・型違い | **起動時に即停止** |
| `URL_INVALID` | http/https以外、プライベートIP、メタデータサービス等 | 該当件をスキップ |
| `URL_FETCH_FAILED` | DNS失敗・接続失敗・タイムアウト・4xx・5xx・リダイレクト上限 | 該当件をスキップ |
| `CONTENT_TOO_LARGE` | `max_bytes` 超過 | 該当件をスキップ |
| `CONTENT_TYPE_UNSUPPORTED` | HTML / PDF 以外 | 該当件をスキップ |
| `EXTRACT_FAILED` | 抽出本文が200文字未満 | 該当件をスキップ |
| `PDF_EXTRACT_FAILED` | 画像PDF・破損PDF | **失敗にしない。** 公式PDFのURLだけ記録して継続（§10） |
| `AI_UNAVAILABLE` | CLIが見つからない・非ゼロ終了 | 該当件を `failed`。原文は残り再実行可 |
| `AI_TIMEOUT` | タイムアウト超過 | 同上 |
| `AI_INVALID_RESPONSE` | JSONでない・Zod検証失敗 | 同上。生出力を保存 |
| `EVIDENCE_MISMATCH` | 根拠引用が原文にない | **失敗にしない。** Notionに警告を併記 |
| `NOTION_RATE_LIMITED` | 429 | `Retry-After` 尊重してリトライ |
| `NOTION_WRITE_FAILED` | その他の書き込み失敗 | `status=pending_notion` で次回再送 |
| `DB_ERROR` | SQLite失敗 | 該当件を `failed` |

## 18. 実行方法（§8）

```bash
npm run setup:notion -- --parent-page-id <ページID>   # 初回のみ
npm run collect                                        # 収集
npm run import -- --url "..."                          # 手動投入
npm run test / lint / typecheck
```

`npm run collect` の処理順（§8）

1. 設定ファイルを読み込む（Zod検証）
2. Notion DBのプロパティを検証する
3. `status=pending_notion` の未同期分を再送する
4. 監視対象の一覧ページ / RSS を取得する
5. 新しいリンクを抽出する
6. `title_excludes` で結果公表を除外する（件数をログ）
7. 処理済みURLを除外する
8. 個別ページの本文を取得する
9. 必要に応じてPDF本文を取得する
10. AIで対象判定する
11. 対象情報をAIで構造化する
12. 正規化・Zod検証・根拠一致検査を通す
13. SQLiteへ保存する
14. Notionへ登録する
15. 処理済み情報とログを保存し、サマリを出力する

補助コマンド（実装するが §8 の要求外）

- `npm run collect -- --dry-run` — Notionへ書かずに解析結果を標準出力へ。プロンプト調整に使う
- `npm run collect -- --source <id>` — 特定の情報源のみ
- `npm run collect -- --limit <n>` — 件数上限
- `npm run seed` — §25 のサンプル4件を投入

## 19. 環境変数（`.env.example`）

```
# Notion
NOTION_TOKEN=
NOTION_DATABASE_ID=

# AI（§20 の AI_API_KEY は claude CLI 方式では不要）
AI_PROVIDER=claude_cli          # claude_cli | mock
AI_MODEL=sonnet
CLAUDE_CLI_PATH=/opt/homebrew/bin/claude
AI_TIMEOUT_MS=180000

# 挙動
RECORD_NON_TARGET=true          # 対象外情報もNotionへ記録（§12-1、精度検証のため既定ON）
DATABASE_PATH=./data/app.db
LOG_LEVEL=info
```

§20 は `AI_API_KEY=` を挙げているが、`claude -p` 方式ではCLI側の認証を使うため不要。`.env.example` にコメントで理由を書く。Phase 5 でAPI移行する際に追加する。

## 20. ログ（§21）

| 記録項目 | 保存先 |
| --- | --- |
| 処理済みURL | `processed.url_normalized` |
| 本文ハッシュ | `processed.content_hash` |
| 最終処理日時 | `processed.last_seen_at` |
| AI処理結果 | `processed.ai_classify_json` / `ai_analyze_json`（生出力込み） |
| AI処理日時・使用モデル | `processed.analyzed_at` / `ai_provider` / `ai_model` |
| エラーログ | `processed.error_code` / `error_detail` ＋ `data/logs/*.jsonl` |
| 元ページ本文のキャッシュ | `data/raw/<hash>.txt` |
| 実行サマリ | `run_logs` テーブル |

## 21. テスト（§26）

Vitest。fixture は **2026-08-05 に実際に取得した実物**を使う。ネットワークなしで全テストが回る。

| fixture | 内容 |
| --- | --- |
| `rfi.html` | CXサービスデザインRFIのページ（本文1,753文字が取れることを確認済み） |
| `proposal-list.html` | プロポーザル方式等発注案件一覧（176KB、15件以上） |
| `digital-press.html` | デジタル統括室 報道発表資料一覧 |
| `ict-rss.xml` | デジタル統括室RSS（100 item） |
| `youryou.pdf` | RFI添付の実施要領（4ページ / 877KB / 4,921文字） |

### 単体テスト

| 対象 | ケース |
| --- | --- |
| URL正規化 | 末尾スラッシュ / `utm_*` 除去 / フラグメント除去 / 相対URL絶対化 / 大文字小文字 |
| 重複判定 | 4段階の優先順位が順に効く。正規化URL一致・本文ハッシュ一致・自治体+タイトル一致 |
| 本文ハッシュ生成 | 空白差異を吸収して同一ハッシュになる |
| AIレスポンスのスキーマ検証 | §12-2 の完全なJSONを受理。必須欠損・不正enum・不正日付・`confidence` 範囲外（-1 / 101 / 小数）を拒否。余剰キーをstrip |
| 関連度の値検証 | `A` / `B` / `C` / `対象外` のみ受理 |
| 成熟段階の値検証 | §14 の9種のみ受理（`不明` を含む） |
| コンタクト推奨度の値検証 | `高` / `中` / `低` / `不要` のみ受理 |
| 日付の正規化 | §10 の表の全ケース。**PDF由来の `令和 8 年 8 月 21 日`（空白入り）と `令和８年８月21日`（全角混在）を含む** |
| 金額の正規化 | §10 の表の全ケース |
| Notionプロパティへの変換 | 全27+1プロパティが正しい型で出る。2,000文字超が切り詰められ `…` が付く。`null` が正しく空値になる |
| 人が入力する項目を上書きしないこと | 更新リクエストのpropertiesに §17-2 の11項目が含まれない。新規作成時は「確認状態」のみ含む |
| 根拠一致検査 | 完全一致を通す。空白・改行・全角空白・全角数字の差異を吸収して通す。**PDF由来テキストの引用を通す**。原文にない引用を検出する |
| 本文抽出 | `rfi.html` から1,700文字以上が取れる。ナビ・フッター・CC表記・Adobe案内が除去される。問い合わせ先（`bb0010@city.osaka.lg.jp`）が抽出される。200文字未満は `EXTRACT_FAILED` |
| PDF抽出 | `youryou.pdf` から4,900文字以上が取れる。`令和 8 年 8 月 21 日` が含まれる |
| RSS解析 | `ict-rss.xml` から100件。`category_includes` / `title_excludes` が効く。除外件数が返る |
| 一覧リンク抽出 | `proposal-list.html` から15件以上。ナビゲーションリンクを拾わない。外部ドメインを除外する |
| SSRF検証 | `localhost` / `127.0.0.1` / `10.0.0.1` / `172.16.0.1` / `172.31.255.255` / `192.168.1.1` / `169.254.169.254` / `[::1]` / `0.0.0.0` / `file:` / `ftp:` を拒否。`https://www.city.osaka.lg.jp/...` と `172.32.0.1`（境界）を許可 |

### 結合テスト（§26）

- 一覧ページから新着リンクを取得できる
- RSSから新着を取得できる
- 個別ページから本文を取得できる
- 本文をAI解析できる（モック）
- AI解析結果をNotionへ登録できる（APIモック）
- 既存URLを重複登録しない
- **Notion書き込み失敗後に再実行できる**（`pending_notion` が次回実行で再送される）
- 手動URLを解析して登録できる
- PDFを解析して登録できる
- 対象外情報が `RECORD_NON_TARGET=true` で登録され、確認状態が `対象外` になる
- 本文変更で「更新あり」が `true` になる
- 1件が失敗しても残りの処理が続行し、サマリに失敗件数が出る

### モックモード（§26 必須）

`AI_PROVIDER=mock` で claude CLI を呼ばずに全フローが通る。

## 22. サンプル（§25）

`npm run seed` で4件を投入する。モックProviderが対応する固定JSONを返す。

| # | 内容 | 期待する判定 |
| --- | --- | --- |
| 1 | 大阪市CXサービスデザイン推進事業RFI（**実在**。`test/fixtures/rfi.html` と `youryou.pdf` を使用） | 対象 / 成熟段階 `市場対話` / コンタクト推奨度 `高` |
| 2 | 観光ポータル構築の公募型プロポーザル（架空） | 対象 / 成熟段階 `公募中` / 自社関連度 `A` または `B` |
| 3 | 自治体DXの5カ年計画（架空） | 対象 / 成熟段階 `政策方針` / コンタクト推奨度 `低` または `中` / 対応判断候補 `継続監視` |
| 4 | 庁舎用プリンター購入（架空） | **対象外** |

## 23. 受け入れ条件（§27）

### 情報取得
- [ ] 大阪市の指定した一覧ページを取得できる
- [ ] RSSから新着を取得できる
- [ ] 一覧から個別ページへのリンクを抽出できる
- [ ] 個別ページの本文を取得できる
- [ ] テキストPDFを解析できる
- [ ] 処理済みURLを重複処理しない

### AI解析
- [ ] 対象・対象外を判定できる
- [ ] 行政課題を要約できる
- [ ] 実現したい状態を整理できる
- [ ] 民間に求める内容を整理できる
- [ ] 成熟段階を判定できる
- [ ] 自社関連度を判定できる
- [ ] コンタクト推奨度を判定できる
- [ ] 根拠となる原文を出力できる
- [ ] 不明な日付や金額を捏造しない（`null` になる）
- [ ] 根拠引用が原文にない場合に検出される

### Notion
- [ ] 対象情報をNotion DBへ登録できる
- [ ] 公式URLによる重複登録を防げる
- [ ] 人が入力するプロパティを上書きしない
- [ ] API失敗時にデータが失われない（次回実行で再送される）
- [ ] 社内メンバーがNotion上で閲覧・編集できる

### 手動投入
- [ ] URLを指定して解析・登録できる
- [ ] テキストファイルを解析・登録できる
- [ ] PDFを解析・登録できる

### 品質
- [ ] READMEがある
- [ ] `.env.example` がある
- [ ] 設定ファイルの例がある
- [ ] AIプロンプトがファイルとして管理されている
- [ ] モックAIモードがある
- [ ] `npm run lint` / `typecheck` / `test` が通る
- [ ] 実行ログが残る

## 24. 検証方法（§28）

最初に30〜50件を処理する。対象・対象外を混ぜる。§5-1 のとおり、プロポーザル一覧だけで「CNPデジタルプラットフォーム構築」（対象）と「国産木材を活用した庁舎整備」「クルーズ客船受入」（対象外）が自然に混在するため、この条件は1つの情報源で満たせる。

人が評価する項目（§28）

- 対象判定が正しいか / 行政課題の要約が使えるか / 実現したい状態が妥当か / 自社関連度が妥当か / コンタクト推奨度が妥当か
- 実際にコンタクト候補になったか / 面談や情報交換につながったか
- どの情報源が有用だったか / どの情報源を次に自動化すべきか

AI出力の4段階評価（§28）: `そのまま使える` / `軽微な修正で使える` / `大幅な修正が必要` / `誤っている`

この評価は Notion 上で行う。§17-2 の「社内メモ」に記録する運用とし、専用プロパティは追加しない（指示書のプロパティ一覧に評価欄がないため、勝手に増やさない）。件数が増えて集計が必要になった段階で専用のSelectプロパティ追加を検討する。

## 25. 指示書から意図的に変えた点

| # | 変更 | 根拠 |
| --- | --- | --- |
| 1 | **RSSを収集の主軸にした** | §9 が `collector_type: rss` を想定内としている。§10 は一覧ページHTML前提の書き方だが、大阪市は構造化されたRSSを局単位で提供しており、`pubDate` と局名が確実に取れてHTML構造変更に強い |
| 2 | **「確認状態」のみ新規作成時に設定する** | §17-2 は人手項目だが、NotionのSelectに既定値がないため空だと §19「新着・未確認」ビューが機能せず、§23 の運用が成立しない。更新時は触らない |
| 3 | **`setup:notion` でDBを自動作成する** | §20 は「必要はない」とするが、39プロパティの手作業はミスの温床で、1文字違いで全件失敗する |
| 4 | **「予算」プロパティを追加した** | §12-2 が `budget` を出力し §13 が事実として扱い §16 が判断材料にしているのに、§17-1 に置き場がない |
| 5 | **対象外情報の記録を既定ONにした** | §12-1 は「任意」だが、初期目的が精度検証（§28）で §19 も「対象外情報を削除しない」と明示している |
| 6 | **AI確信度を0〜100の整数に確定した** | §12-1 の `"confidence":92` と §17-1 の Number 型に合わせた。隣接する先行設計の0〜1は破棄 |
| 7 | **`AI_API_KEY` を使わない** | `claude -p` 方式ではCLI側の認証を使う。§20 の環境変数リストから外し、理由を `.env.example` に書く |
| 8 | **`--dry-run` / `--source` / `--limit` / `npm run seed` を追加した** | §8 の要求外だが、プロンプト調整と検証（§28）に必要 |
| 9 | **「市場対話・公募」ビューに `情報提供依頼` を足した** | §19 の列挙は5つだが §18 の文書種別に `RFI` と `情報提供依頼` が併存するため、足さないと `情報提供依頼` のレコードがビューから消える |

## 26. 既知の制約と仮定

### 制約

1. **`claude -p` 方式はローカル専用。** Phase 5 のGitHub Actions移行時は API Provider への差し替えが必須。Provider インターフェースを維持しているため1ファイル追加と環境変数の切替で済む想定
2. **AI呼び出しは逐次。** `claude -p` の多重起動を避けるため同時実行1。1件あたり数十秒かかり、50件で20〜40分程度を見込む
3. **OCR未対応**（§24）。画像PDF・スキャンPDFは公式URLのみ記録
4. **ビューはAPIで作れない。** §19 の6ビューはREADMEの手順に従って手動作成する
5. **更新の差分管理は最小。** 本文が変わっても「更新あり」を立てるだけで再解析しない（§11）
6. **1文書＝1レコード。** 複数文書の同一テーマ統合は Phase 4（§29）
7. **分野タグを列挙で縛っていない。** 表記揺れが出る可能性がある。実データを見て正規化する
8. **文書種別に `RFI` と `情報提供依頼` が併存する**（§18 のまま）。実質同義。実データの分布を見てから統合を検討する
9. **AI出力の4段階評価に専用プロパティを設けていない。** 「社内メモ」への記録運用。集計が必要になったら追加する
10. **`Math.sumPrecise` polyfill が必要**（Node 25 に未実装）。将来Nodeが実装したら不要になる

### 仮定

1. 「自社」は Studio。判定基準は `prompts/company-profile.md` の初版とし、実データを見ながら調整する
2. 本文抽出の下限は200文字。これを下回るページは抽出失敗として扱う
3. 添付PDFのテキストは合計50,000文字を上限に本文へ追記する
4. 同一ホストへのアクセス間隔は3秒。robots.txt に `Crawl-delay` があればそれを優先する
5. 和暦は令和のみ対応する（令和8年 = 2026年）
6. 検証件数は §28 のとおり30〜50件を目安とする
7. Notion の Integration トークン発行と親ページ接続は手動で行う（APIでは不可能）

## 27. 今後の拡張（§29）

| Phase | 内容 |
| --- | --- |
| 1 | 福岡市・横浜市・札幌市の追加 / 情報源設定の追加 / 自治体固有コレクター（`custom`）/ 更新・期限変更の検知 |
| 2 | 予算・新規事業・DX計画の自動取得 / 継続監視機能 / 関連文書の手動紐付け |
| 3 | 議会議事録の限定取得 / 行政答弁と議員質問の区別 / 特定キーワード・委員会の監視 |
| 4 | 複数文書を同一行政テーマとして統合 / 時系列表示 / ニーズ成熟度の変化検知 |
| 5 | GitHub Actions やクラウドへの移行 / 定期実行 / Slack通知 / 対象自治体の拡大 |

§23 の通知機能（Slack週次まとめ / 関連度Aの新着通知 / コンタクト推奨度「高」の通知 / 締切前通知 / 取得エラー通知）は Phase 5 で検討する。
