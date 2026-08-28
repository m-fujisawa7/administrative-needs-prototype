# 情報源台帳の編集ガイド

このディレクトリの `sources.yaml` は、行政ニーズ収集の対象候補となる自治体・公共機関と、その公式情報源を管理する台帳です。

この台帳自体はWebページを取得しません。人またはAIが確認した公式URLを記録し、後続の収集処理へ渡すことを目的としています。

登録済みの組織・情報源・有効状態は `sources.yaml` を正本とします。情報源を追加するたびにルートのREADMEへ件数や個別一覧を追記する必要はありません。最新の一覧は `npm run sources:list`、有効な情報源だけの一覧は `npm run sources:list -- --enabled` で確認してください。情報源固有の注意事項や無効化理由は、対象項目の `notes` に記録します。

## 編集時の重要ルール

1. URLは必ず自治体・公共機関の公式サイトで確認する。
2. URL、組織名、ページ名を推測で登録しない。
3. 編集前に、同じ組織ID・情報源ID・URLが登録済みでないか確認する。
4. 既存のIDは、明確な理由がない限り変更しない。
5. 不確かな情報源は削除せず、`enabled: false` または `verification_status: needs_review` として残す。
6. 追加後は必ず台帳の検証と一覧表示を実行する。
7. 実アクセス確認を行っていない場合は、URLやCSSセレクターを確認済みと記載しない。
8. 本文取得やAI解析を行ったと誤認させる記述をしない。

## AI判定用の自社適合度判定基準

`company-fit-criteria.yaml` は、AIが自社関連度A・B・C・対象外を判定する基準です。初期値は実装指示書に記載されたWeb・CMS・UI/UXなどの想定領域です。実運用前に、推測ではなく自社の提供サービス、将来注力領域、パートナー方針に合わせて確認・更新してください。

- `direct_fit`: 自社単独で直接提供できる領域
- `partner_fit`: パートナー連携により関与できる領域
- `strategic_interest`: 直近の案件化可能性は低いが、将来に向けて継続確認したい領域・段階
- `out_of_scope`: 原則として関与しない領域

秘密情報、顧客固有情報、社外秘の営業方針は記載しないでください。この判定基準はHTML・PDF本文とともにAIへ送信されます。

## 台帳の構造

`sources.yaml` は、組織を表す `organizations` と、監視候補を表す `sources` に分かれています。

```yaml
version: 1

organizations:
  - id: osaka-city
    name: 大阪市
    organization_type: designated_city
    prefecture: 大阪府
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

1つの組織に複数の情報源を紐付けられます。`sources[].organization_id` には、`organizations[].id` に存在するIDを指定してください。

## 組織の項目

### 必須項目

| 項目 | 内容 |
| --- | --- |
| `id` | 組織を一意に識別するID。小文字英数字とハイフンを使用 |
| `name` | 自治体・公共機関名 |
| `organization_type` | 組織種別 |
| `official_domain` | 公式サイトのドメイン。例: `city.osaka.lg.jp` |
| `enabled` | この組織を後続処理の対象にするか |

### 任意項目

| 項目 | 内容 |
| --- | --- |
| `prefecture` | 都道府県名 |
| `parent_organization_id` | 親組織のID |
| `notes` | 補足・注意事項 |

`organization_type` は次のいずれかです。

- `designated_city`: 政令指定都市
- `prefecture`: 都道府県
- `municipality`: 市区町村
- `special_ward`: 特別区
- `public_agency`: 公共機関
- `external_organization`: 外郭団体など

## 情報源の項目

### 必須項目

| 項目 | 内容 |
| --- | --- |
| `id` | 情報源を一意に識別するID。小文字英数字とハイフンを使用 |
| `organization_id` | 所属する組織のID |
| `name` | 人が読んで分かる情報源名 |
| `url` | 公式サイトで確認した監視候補URL |
| `collector_type` | 将来使用する取得方式 |
| `source_category` | 情報源の分類 |
| `priority` | 監視優先度 |
| `enabled` | 後続処理の対象にするか |

### 任意項目

| 項目 | 内容 |
| --- | --- |
| `link_selector` | 一覧ページから個別ページへのリンクを抽出するCSSセレクター候補 |
| `title_selector` | 個別ページのタイトルをSource固有の要素から取得するCSSセレクター |
| `content_selector` | 個別ページの本文を抽出するCSSセレクター候補 |
| `trusted_pdf_domains` | 添付PDF取得時だけ追加で許可する完全一致hostの配列 |
| `category_includes` | RSSカテゴリの許可条件。`collector_type: rss` だけに適用 |
| `title_includes` | 収集対象とするタイトルの条件。1件以上設定すると、いずれかの語を含む候補だけを残す。`rss` と `list_page` に適用 |
| `title_excludes` | よくある質問など、明らかな対象外タイトルの除外条件。`rss` と `list_page` に適用 |
| `document_type_hints` | 想定される文書種別 |
| `notes` | 情報源の特徴、登録理由、注意事項 |
| `last_verified_at` | 人がURLを最後に確認した日。`YYYY-MM-DD`形式 |
| `verification_status` | URLの確認状態 |
| `initial_since` | この情報源の初回収集開始日、かつ自動収集の下限日。`YYYY-MM-DD`形式 |
| `allow_empty_candidates` | `link_selector` に一致するリンクが0件でも正常として扱う。`collector_type: list_page` だけに適用 |
| `ignore_list_published_at` | 一覧から取得できる日付を `publishedAt` として使わず、掲載日不明として扱う。`collector_type: list_page` だけに適用 |

`initial_since` は、過去分が非常に多く初回からすべてをAI解析したくない情報源で使います。省略した場合は共通の初回収集開始日（`2026-07-01`）を使います。初回の開始位置になるだけでなく自動収集の下限日でもあり、収集状態ができた後の通常巡回でも、前回成功日時の3日前がこの日より前になる場合はこの日へ丸めます。手動の`--since`だけはこの下限の対象外で、より前を指定できます。詳細は `../src/collection-run/README.md` を参照してください。

`title_selector` は、ページ先頭の`h1`が共通ロゴなどで、個別ページの実タイトルを別の要素から取得する必要があるSourceだけに設定します。指定要素の表示テキストを空白正規化して使用します。セレクターが不正、一致0件、または表示テキストが空の場合は、汎用の`h1` / `title`へフォールバックせず本文抽出エラーにします。未設定の場合は従来どおり、空でない`h1`、`title`の順で取得します。

`trusted_pdf_domains` は、公式記事が添付PDFだけを外部CDNから配信する場合に限って設定します。値はprotocol、port、pathを含まないhostnameだけを指定し、PDF取得時に完全一致したhostだけを追加許可します。一覧、RSS、個別記事HTML、外部リンクの候補化には使わず、所属組織と親組織の`official_domain`による既存の許可範囲も変更しません。

`category_includes` は、RSS解析（`../src/source-check/rss-checker.ts`）だけが読み取ります。`list_page` など他の `collector_type` に設定しても無視され、台帳の検証もエラーにならないため、設定したつもりで効いていない状態になります。

`title_excludes` は `rss` と `list_page` の両方で有効です。判定は共通で、NFKC正規化・小文字化・空白除去の後に部分一致で比較します。一覧ページではリンクテキストが候補タイトルなので、そのままリンクテキストと比較されます。除外した候補は本文取得、PDF抽出、AI判定、Notionの重複確認と登録へ進まず、`--limit` も消費しません。

`title_includes` は `title_excludes` と対になる任意設定で、正規化と部分一致の仕様は同じです。**1件以上設定した場合だけ、いずれかの語をタイトルに含む候補（OR条件）を残します。** 未設定または空配列なら従来どおり全候補を通すため、設定していない情報源の挙動は変わりません。同じ候補が `title_includes` と `title_excludes` の両方に一致した場合は除外が勝ちます。除外された候補は本文取得、PDF抽出、AI判定、Notionの重複確認と登録へ進まず、`--limit` も消費しません。

除外語で落とせない種類のノイズを減らしたいときに使います。新潟県の入札・発注・売却RSSは全庁横断で物品購入と土木・設備工事が大半を占めますが、「購入」「賃貸借」を `title_excludes` へ入れると「LANシステム用サーバ機器等一式の借上げ」のような対象性の高い案件まで落ちてしまいます。そこで残したい語の側を `title_includes` に列挙しています。

`allow_empty_candidates` は、募集中・実施中のものだけを載せる一覧のように、**候補0件が異常ではなく正常状態になり得る**情報源で使います。`true` にすると `link_selector` に一致するリンクが0件でもエラーにせず、0件の結果を返して正常終了します。0件だった事実は「`allow_empty_candidates` により正常として扱いました」というWARNINGとして残るため、設定したことで状況が見えなくなることはありません。未設定なら従来どおりエラーです。

緩めるのは「`link_selector` に一致するリンクが0件」の場合だけです。次の4つは設定の誤りや除外語の効きすぎを示すシグナルなので、`true` にしても従来どおりエラーになります。

- `link_selector` が未設定
- `link_selector` がCSSとして不正
- タイトルと公式ドメイン内URLを持つ候補が0件（セレクターが案件以外を掴んでいる）
- `title_includes` / `title_excludes` の適用後に0件（除外語が過剰）

読み取るのは一覧ページ解析（`../src/source-check/list-page-checker.ts`）だけです。`rss` など他の `collector_type` に設定しても無視されます。0件で正常終了した場合、その実行に候補は1件も無いため本文取得、PDF抽出、AI判定、Notion登録へは進まず、`--limit` も消費しません。収集状態は既存の成功条件に従い、`--write` かつ `--since` 無しなら進み、Previewでは進みません。

`ignore_list_published_at` は、一覧に日付が並んでいても**その日付が掲載日・更新日・公示日ではない**情報源で使います。`true` にすると、候補リンクと同じ行から日付を解析できた場合でも `publishedAt` を `null`（掲載日不明）にします。掲載日不明の候補は期間filterで除外されず、警告付きで重複確認へ進むため、掲載日として無効な日付で候補が静かに落ちることを防げます。

沖縄県の年度別発注情報がこの形です。案件名のアンカーと日付が同じ `tr` にあるので日付は解析できますが、その値は募集期間の開始日、開札日、プロポーザル実施日であり掲載日ではありません。設定しない場合、令和8年度の一覧14件のうち10件が「募集期間が共通開始日より前」という理由だけで初回処理から外れていました。

読み取るのは一覧ページ解析（`../src/source-check/list-page-checker.ts`）だけで、`rss` や `single_page` に設定しても無視されます（`single_page` はもともと掲載日を取得しません）。`true` にしても候補件数、`link_selector`、`title_includes` / `title_excludes` の判定は変わらず、落ちるのは日付だけです。その情報源では `sources:check` の「最新公開日候補」が常に「取得できず」になり、`initial_since` は効かなくなるため、初回処理量はfilter適用後の全候補数で見積もります。日付の意味が掲載日・更新日として妥当な情報源には設定しないでください。期間filterが働かなくなり、初回処理量と巡回コストが増えます。

部分一致のため、除外語は実際のタイトルを見て決めてください。「サービスの使い方」はサービス名が挟まる「公共施設予約サービス「よやっQ（く）北九州」の使い方」に一致しません。また「結果公表」「公募」「募集」のような語は有用な案件まで落とすため、明らかな固定・案内ページに絞り、判断が必要なものは後続のAI判定に任せてください。

`single_page` は入口ページ自体を1件の候補として扱います。ページ内のリンクは候補にせず、掲載日も取得しません（常に掲載日不明として処理されるため `initial_since` は効きません）。**ページ内に独立した複数の案件・課題が並ぶ固定ページには使えません。** 1ページが1レコードになるため粒度が粗くなり、重複判定が公式URL単位である以上、候補を分割しても2件目以降がすべて重複になります。有効にするのは、ページ全体が1つの行政ニーズまたは政策シグナルを指す情報源だけにしてください。詳細は `../src/source-check/README.md` を参照してください。

### 許可される値

`collector_type`:

- `rss`
- `list_page`
- `single_page`
- `manual`
- `custom`

`source_category`:

- `procurement`
- `rfi`
- `proposal`
- `public_private_partnership`
- `digital_news`
- `policy_signal`
- `budget`
- `council`
- `plan`
- `other`

`priority`:

- `high`
- `medium`
- `low`

`verification_status`:

- `verified`: 人が公式URLとページ内容を確認済み
- `unverified`: 未確認
- `needs_review`: 過去に確認したが再確認が必要

## 新しい情報源を追加する

既存組織へ追加する場合は、次のテンプレートを `sources` の末尾へ追加します。

```yaml
  - id: organization-purpose-type
    organization_id: existing-organization-id
    name: 公式ページに記載された名称
    url: https://official.example.jp/path/
    collector_type: list_page
    source_category: other
    priority: medium
    enabled: true
    notes: 登録理由と、このページから得られそうな情報
    last_verified_at: "YYYY-MM-DD"
    verification_status: verified
```

CSSセレクターが分からない場合は、推測で `link_selector` や `content_selector` を追加せず、省略してください。後から実ページを調査して追加できます。

## 新しい組織を追加する

最初に `organizations` へ組織を追加します。

```yaml
  - id: example-city
    name: 例市
    organization_type: municipality
    prefecture: 例県
    official_domain: city.example.jp
    enabled: true
    notes: 追加理由
```

続けて `sources` へ1件以上の情報源を追加し、`organization_id` に新しい組織IDを指定します。

### 自治体事業が独自公式ドメインを使う場合

情報源チェックは、所属組織の`official_domain`とそのサブドメインだけへアクセスします。同じ自治体の公式事業でも別ドメインを使う場合は、この制限を広げず、自治体を`parent_organization_id`に持つ`external_organization`を追加してください。自治体名として扱う必要がある場合は子組織の`name`も自治体名とし、`notes`に事業名と分離理由を記載します。Hatch Technology NAGOYAはこの方式で管理しています。

## AIへ追加を依頼する場合

次の依頼文をコピーし、対象自治体や情報源を具体化してAIへ渡してください。

```text
config/README.md のルールに従い、config/sources.yaml に情報源を追加してください。

対象組織:
追加したい情報源の種類:
確認済みの公式URL:
追加理由:

作業条件:
- 既存の組織ID、情報源ID、URLとの重複を最初に確認する
- URLやページ名を推測しない
- 必要最小限の差分にする
- CSSセレクターは実ページで確認できた場合だけ設定する
- npm run sources:validate を実行する
- npm run sources:list で追加内容を確認する
- ネットワークアクセスが許可されている場合は npm run sources:check で対象情報源を確認する
- 候補個別ページとcontent_selectorを確認する場合は npm run content:check を実行する
- 個別ページで見つけたPDFのテキスト取得を確認する場合は npm run pdf:check を実行する
- 取得本文のAI判定を確認する場合は config/company-fit-criteria.yaml を確認して npm run ai:check を実行する
- 新規SourceをNotion書き込み直前までまとめて確認する場合は npm run source:verify -- --source <source-id> を実行する
- 追加・変更時の詳細結果が必要なら --output で情報源ごとの最新結果を上書き保存する
- 保存したJSONはGitへコミットせず、結果の要約をPull Requestへ記載する
- 最後に、追加内容、確認根拠、検証結果、不明点を報告する
```

公式URLが分からない場合は、AIに「公式サイトを調査して候補を提示するところまで」を依頼し、人が候補を確認してから台帳へ追加する運用を推奨します。

## 追加後の検証

リポジトリのルートで次を実行します。

```bash
npm install
npm run sources:validate
npm run sources:list
npm run lint
npm run typecheck
npm test
```

有効な情報源だけ確認する場合:

```bash
npm run sources:list -- --enabled
```

組織や優先度を絞り込む場合:

```bash
npm run sources:list -- --organization osaka-city
npm run sources:list -- --priority high
```

登録したRSSまたは一覧ページを実際に確認する場合:

```bash
npm run sources:check -- --source osaka-digital-rss
```

追加・変更時の結果を一時保存する場合:

```bash
npm run sources:check -- \
  --source osaka-digital-rss \
  --output
```

保存先は `data/logs/source-check/osaka-digital-rss.json` のような固定パスで、再実行時は最新結果へ上書きされます。Git管理対象外です。Pull RequestにはJSONファイルを追加せず、OK・Warning・Errorの件数と主な警告を記載してください。

候補となった個別ページと `content_selector` を確認する場合:

```bash
npm run content:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html" \
  --output
```

`content_selector` は、実ページのタイトル、本文プレビュー、文字数、使用セレクターを確認してから台帳へ設定してください。このチェックは意味的な適否を自動判定しません。詳細は `../src/content-check/README.md` を参照してください。

個別ページで見つけたPDFを確認する場合:

```bash
npm run pdf:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/cmsfiles/contents/0000684/684546/01_youryou5.pdf" \
  --output
```

PDFの保存結果にはメタデータ、ページ別文字数、警告、プレビューだけを残します。同じ情報源で複数PDFを確認した場合も、`data/logs/pdf-check/source-id.json` の最新結果を上書きします。このチェックも技術的なテキスト取得可否だけを確認し、行政ニーズとしての適切さは判定しません。詳細は `../src/pdf-check/README.md` を参照してください。

本文がAIで判定・構造化できるか確認する場合:

```bash
npm run ai:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

AI結果は保存されません。公開文書だけを対象にし、自社適合度判定基準とAIの根拠引用を人が確認してください。詳細は `../src/ai/README.md` を参照してください。

新規Sourceの候補取得、HTML・PDF本文取得、AI判定をまとめて確認する場合:

```bash
AI_PROVIDER=claude_cli npm run source:verify -- \
  --source osaka-digital-rss \
  --limit 3
```

`--limit`は省略時3件、最大5件です。Notion APIやcollection stateは使用せず、結果も保存しません。詳細は `../src/source-verify/README.md` を参照してください。

チェック機能は外部サイトへアクセスします。実行できない環境では、fixtureテストの成功を実アクセス成功として報告しないでください。詳細は `../src/source-check/README.md` を参照してください。

## Pull Requestの確認項目

GitHubで共有する場合は、追加をPull Requestにして次を確認します。

- [ ] 公式サイトのURLである
- [ ] 組織ID、情報源ID、URLが重複していない
- [ ] ページ名を公式サイトの表記に合わせている
- [ ] `enabled` と `priority` の理由が説明できる
- [ ] 確認日と確認状態が正しい
- [ ] 既存項目を意図せず変更していない
- [ ] `npm run sources:validate` が成功する
- [ ] 一覧表示で追加内容を確認できる
- [ ] 候補個別ページがある場合はタイトル・本文プレビュー・使用セレクターを確認した
- [ ] PDFを対象にした場合はページ数・文字数・空ページ・プレビューを確認した
- [ ] AI判定を行った場合は公開文書であること、自社適合度判定基準、根拠引用を確認した

プロジェクト全体の概要と後続処理からの読み込み方法は、リポジトリルートの `README.md` を参照してください。
