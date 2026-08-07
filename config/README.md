# 情報源台帳の編集ガイド

このディレクトリの `sources.yaml` は、行政ニーズ収集の対象候補となる自治体・公共機関と、その公式情報源を管理する台帳です。

この台帳自体はWebページを取得しません。人またはAIが確認した公式URLを記録し、後続の収集処理へ渡すことを目的としています。

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
| `content_selector` | 個別ページの本文を抽出するCSSセレクター候補 |
| `category_includes` | RSSカテゴリなどの許可条件 |
| `title_excludes` | 結果公表など、明らかな対象外タイトルの除外条件 |
| `document_type_hints` | 想定される文書種別 |
| `notes` | 情報源の特徴、登録理由、注意事項 |
| `last_verified_at` | 人がURLを最後に確認した日。`YYYY-MM-DD`形式 |
| `verification_status` | URLの確認状態 |

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
