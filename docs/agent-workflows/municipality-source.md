# 自治体情報源登録ワークフロー

この文書は、CodexとClaude Codeが自治体・情報源を調査、登録、変更するときの共通の完了条件です。エージェント固有の報告方法は`AGENTS.md`または`CLAUDE.md`に置き、品質基準はこの文書を正本とします。

## 基本原則

- 「現在候補を取得できた」「台帳へ登録できた」「`sources:check`が成功した」だけでは完了としない。継続巡回して安全に使えるかまで確認する。
- AIは調査結果の一次整理役であり、営業判断やSource設計を自動決定しない。AI判定だけで外部連絡や意思決定を行わない。
- 1件の観察や既知Noticeを、直ちに共通仕様、閾値、collector変更へ一般化しない。実害と再現性を確認する。
- Source固有の問題にはSource固有の最小変更を優先し、依頼外のコード、config、Notion、並行作業者の変更へ広げない。
- 判断できない場合は、無理に有効化せず`disabled`、単発登録、将来再確認を選ぶ。

## 1. 作業開始前

- `git status --short`と対象ファイルのdiffを確認し、既存の未コミット変更を特定する。
- `AGENTS.md`、`config/README.md`、対象機能のREADME、`src/source-registry/schema.ts`、関連テストを読む。
- 対象自治体、組織ID、Source ID、URLの既存登録と重複を確認する。
- 並行作業者の変更を編集、stage、commit、restore、削除しない。
- 実アクセス、Claude、Notionを使う範囲がユーザーの依頼に含まれるか確認する。
- Notionを使用するコマンドでは、その時点でユーザーから指定された `database-url` を使用し、過去の会話、README、ログにある `database-url` を推測して再利用しない。

## 2. 実ページと取得経路

各Sourceは設定前に実ページを確認します。

- HTTP status、redirect、最終URL、Content-Type
- HTML、RSS、PDFなどの実構造
- 一覧の`link_selector`候補と個別ページの`content_selector`候補
- 掲載日・更新日の要素と周辺テキスト（評価方法は後述の「掲載日の評価」）
- RSSの有無
- 外部ドメイン、SPA、外部SaaSの有無
- 候補が0件になる時期が正常にあり得るか

CSS selectorは実ページで確認した構造だけを設定します。広すぎるselectorでナビゲーション、過年度索引、所属リンク、PDF添付を候補へ混ぜていないかも確認します。

### 掲載日の評価

掲載日は、DOM上の配置と`publishedAt`として解析できるかを分けて確認します。

A/B/Cは日付文字列の配置だけを表します。

- A: 候補リンクと同じ`li`/`tr`/行などから日付文字列を取得できる
- B: 日付文字列が候補リンクとは別要素にある
- C: 日付文字列を確認できない

A/B/Cは配置の区分であり、年の有無と日付の意味は別軸です。`publishedAt`として取得できるかは、この3軸の組み合わせで判定します。現行Collectorの一般ルールは次のとおりです。

- A かつ 年あり かつ 日付の意味が掲載日・更新日・公示日などとして妥当 → `publishedAt`取得可
- A かつ 年あり だが、入札日・開札日・締切日・募集期間・事業実施日などを掲載日として誤取得している → `publishedAt`としては取得不可
- A かつ 年なし → `publishedAt`取得不可
- B → 年の有無にかかわらず、現行の候補生成では`publishedAt`取得不可
- C → `publishedAt`取得不可

Bは候補リンクと同じ行から日付を読めないため、「2026年8月17日」のように年があっても`publishedAt`を確定できません。日付が共通の祖先にある場合は全候補へ同じ日付が付くことがありますが、案件ごとの掲載日ではないので取得できたとみなしません。

したがって「取得できる」と報告してよいのは、原則として A かつ年を含み、かつ日付の意味が`publishedAt`として妥当な場合だけです。Aであることだけでは`publishedAt`が取得できる根拠になりません。

各Sourceについて、A/B/Cとは別に次を確認して報告します。

- 日付表記の実例
- 年の有無
- `publishedAt`として解析可能か
- 日付の意味（掲載日 / 更新日 / 公示日 / 入札日 / 開札日 / 締切日 / 募集期間 / 事業実施日 / その他）
- `initial_since`や前回成功日時による期間filterが実際に機能するか

「Aだから期間filterが使える」と判断しないでください。日付文字列を取得できても、入札日、開札日、締切日などを掲載日として誤取得している場合は`publishedAt`として信頼できません。信頼できない場合はその旨を`notes`へ記録し、期間filterが機能しない前提で初回処理量を見積もります。

報告は次の形にします。

```text
掲載日の在り方: A
表記例: （8月19日）
年: なし
publishedAt取得: 不可
日付の意味: 掲載日
期間フィルタ: 不可
```

```text
掲載日の在り方: A
表記例: 2026年8月19日
年: あり
publishedAt取得: 可
日付の意味: 掲載日
期間フィルタ: 可
```

### RSSとHTMLの比較

RSSがあっても自動的にRSSを選びません。HTMLと次を比較します。

- 保持件数と保持期間
- `publishedAt`の取得可否と意味
- categoryの有無、粒度、独自価値
- HTMLにしかない候補、RSSにしかない候補
- 過去保持量と更新頻度

RSSの存在ではなく、継続巡回における取得価値で選びます。

## 3. 候補件数と初回処理量

有効化を検討するSourceは、可能な範囲で次を分けて記録します。

- raw candidates
- structural valid candidates
- `title_includes` / `title_excludes`などfilter適用後のcandidates
- `publishedAt`取得あり件数 / 日付不明件数（日付文字列の有無ではなく解析可能かで数える）
- 共通開始日または`initial_since`適用後の初回期間対象数
- 既定`--limit 5`適用時に、1回のWriteで未登録候補として後続処理へ進む最大件数

一覧の候補件数とClaude実行件数を混同しません。`collect:run`のlimitはCollectorの取得件数ではなく、Notionで未登録と確認され、HTML・PDF・Claude・登録処理へ進む候補数の上限です。指定範囲は1〜20、既定値は5です。

日付不明候補は期間filterで除外されず、警告付きでduplicate確認へ進みます。`initial_since`は初回開始日であると同時に自動収集の下限日であり、初回だけの設定ではありません。手動`--since`はこの下限より前を指定できますが、状態を進めません。

実際のClaude実行数は、Notionの既登録URL、本文取得失敗、利用上限などで最大件数より少なくなり得ます。正確な値と条件付きの上限を区別して報告します。

## 4. 継続巡回性

「現在1件取れる」ことと「次回以降も取れる」ことを分けて評価します。

- 一覧URLと個別案件URLが分離しているか
- Official URLが案件固有か
- 年度、回次、再公募ごとにURLが変わるか
- 固定URLを翌年度や次回募集で上書き再利用しないか
- 過去年度・過去回のURLパターンが確認できるか
- 新しい案件が同一URL更新の場合に取りこぼさないか
- 一覧の過去保持量とページャ対応の範囲
- `publishedAt`が本当に掲載日または更新日か
- 締切日、質問期限、回答日、事業実施日を誤取得していないか

固定URL更新型、`single_page`、ページ内複数案件では、初回取得できることを継続巡回の安全性とみなしません。安全でなければ、Sourceは残したまま無効化し、必要な現在案件だけ`notion:register`などで単発処理します。

## 5. URL単位duplicateとの整合

収集はURL単位duplicateを前提に評価します。登録済みURLはduplicate-firstにより、Content取得、PDF抽出、Claude解析、Notion作成を行わずにスキップされます。

特に次を確認します。

- 年度をまたいで同じURLを再利用する
- 同じ固定ページへ案件内容を上書きする
- 1ページ内に複数の独立案件がある
- 再公募だけ別URLで、当初公募は固定親ページ本文にある
- fragmentだけが異なる、またはredirect前後でURL表現が変わる
- 外部SaaSの固定view URLにレコードが追加され続ける

現在の事前重複確認は公式URLの完全一致を基本とし、候補が`http://`の場合だけ同一URLの`https://`版も確認します。固定URLの本文更新を検知して再解析する仕組みではありません。URL再利用と相性が悪いSourceを、`initial_since`やselectorだけで安全になったと判断しないでください。

## 6. Filterの安全性

`title_includes` / `title_excludes`は候補削減だけを目的に追加しません。Sourceごとの実タイトルで、可能な範囲で次を確認します。

- filter前後の件数
- 除外理由別の内訳
- recentな除外例
- 残存候補の種類
- 募集中、再募集、質問回答追記中の本体案件を誤除外しないか

他自治体の除外語を機械的に横展開しません。「質問」「質問回答」「回答」「選定結果」「更新」「募集終了」などの段階マーカーは自治体ごとに使い方が違います。質問回答が募集本体タイトルへ追記され、回答掲載中も提案受付が続く場合があります。

内容トピックによるnegative filterは、可能なら実登録後のAI判定と人間分類を突き合わせてから導入します。数件だけに効くfilter、既登録案件だけに効くfilter、1件の外れ値だけを狙うfilterは、共通仕様へ入れる前に過剰適合を疑います。

## 7. Disabled Source

無効なSourceも削除せず、理由と再確認条件を`notes`に残します。

代表例:

- 固定施策ハブで個別案件一覧がない
- 1ページ内に複数の独立案件がある
- 固定URLや案件URLが再利用される
- 現collectorではdirect PDF candidateを扱えない
- JavaScript / SPA / 外部SaaSである
- RSSにHTMLとは異なる価値がない
- 対象密度が極端に低い
- 他Sourceと完全に重複する

外部SPAやSaaSは、初期HTMLにデータがないだけで「手動しかない」と即断しません。容易に確認できる範囲で公開JSON、XHR、認証不要API、静的データの有無を確認します。ただし取得口が見つかっても、専用collector、外部ドメイン許可、新しい認証方式を依頼なく実装しません。必要性、安定性、利用条件を別途判断します。

## 8. Direct PDF candidateと添付PDF

次の2つを区別します。

- 一覧上のCandidate URL自体がPDF
- HTML案件ページの中にPDF添付がある

現行処理がHTML Candidateを前提とするSourceでは、source-specificなselectorでPDF直リンクを候補から外す判断があり得ます。ただし全Source共通でPDF直リンクを除外しません。募集情報そのものがPDFだけの自治体もあるため、direct PDF対応は実害が確認された時点で独立した論点として扱います。

## 9. `single_page`

`single_page`は「1ページ = 1候補」が妥当な場合だけ使います。

適する例:

- 通年の民間提案制度
- 行政DX計画
- 内容が安定した制度紹介
- ページ全体が1つの制度または募集を示す

適さない例:

- ページ内に複数の独立案件が並ぶ
- 各年度、各テーマを同じURLで更新する
- 将来内容が大きく入れ替わる固定ページ

`single_page`はSource URL自体を候補にし、掲載日は取得しません。日付不明として期間filterを通りますが、登録後は同じ公式URLがduplicate-firstでスキップされます。初回以降の本文更新を拾う仕組みではないため、URL再利用との相性を必ず評価します。

## 10. PDF・Word・Evidence

PDFのNoticeやWarningを1件見ただけで仕様変更しません。AI入力の品質に実害があるかを確認します。

- 高価値PDFが優先されているか
- `maxPdfs`の枠数。既定は3件で、文字数上限とは別である
- `charactersPerPdf`。既定は1PDFあたり20,000文字
- PDF合計文字数。既定は50,000文字
- `no_text`、`password_protected`、取得・解析失敗
- 一部ページを抽出できない`empty_pages`
- 長大PDFの`relevant_chunks`またはfallback切り詰め
- `pdf_truncated`
- 原文と根拠引用が一致しない`evidence_not_found`

枠数制約、1PDFの文字数制約、PDF合計文字数制約を混同しません。`no_text`やpassword保護は本文を渡せないため枠を消費せず次候補を試しますが、その他の取得・解析失敗は試行枠を消費します。既知Noticeは、選択されたPDF、Notion内容、AI判定への影響がなければ要約だけに留めます。

Word添付が現状の対象外なら、重要本文がWordにしかない実害ケースかを記録します。提出様式がWordであるだけなら共通機能追加の理由にしません。`evidence_not_found`も発生だけで即修正せず、引用、判定、登録内容への影響を確認します。

## 11. 検証

変更後は最低限、次を実行します。

```bash
npm run sources:validate
npm run sources:list
npm run sources:check -- --source <source-id>
npm run lint
npm run typecheck
npm test
```

`sources:check`は対象Sourceごとに実行し、`--output`が必要な場合だけ固定パスへ保存します。必要に応じて`content:check`、`pdf:check`、`source:verify`を追加します。実ClaudeやNotionがCodex環境で安定しない場合は無理に待機せず、Mockテストまでで停止してローカル実行コマンドを示します。

Vitestは末尾の断片だけで判断せず、次を明示的に確認します。

- `Test Files ... passed`
- `Tests ... passed`
- failedが0件であること

Source追加では、source registryの固定期待配列など関連テストの更新要否も確認します。fixtureやMock成功を実Web、実Claude、実Notionの成功として報告しません。

## 12. 初回Write

候補が多いSourceは最初から大量にClaudeへ送りません。原則として初回は`--limit 5`程度で実データを確認します。

実行後は次を確認します。

- Created / Previewed
- Duplicates skipped
- Failed
- Remaining new candidates
- Collection state
- duplicate-firstがContent/PDF/Claudeをスキップしたか
- Warning / Noticeと実害
- Claude CLIのusage limit
- PDF選択とAI判定の傾向
- Source固有filterの必要性

重複候補はlimitを消費しません。未処理候補が残る実行ではcollection stateを進めず、次回は同じ期間を再取得して登録済みURLを先にスキップします。Preview、失敗、手動`--since`でもstateを進めません。

## 13. 変更範囲と一般化

- Source固有の問題は、まずSource固有のselector、filter、無効化で解決できるか検討する。
- 1 Sourceの問題を見て、collector共通仕様、全Source共通filter、閾値を直ちに変更しない。
- 既知Warningを消すこと自体を目的にせず、取得内容、AI判定、Notion登録への実害を見る。
- 新しいcollector、provider、外部サービス連携、定期実行、データ保存を依頼なく追加しない。
- 依頼と関係ないコード、config、Notion内容、並行作業者の変更に触れない。

## 14. 完了判定

各Sourceについて、次のいずれかを明示できる状態にします。

- enabled維持
- disabled維持
- 要修正
- 将来再確認

完了報告では、各SourceについてSource ID、Source名称、`enabled` / `disabled`、priority、初回期間対象数を必ずセットで記載します。

最後に「このままcommitして初回Writeへ進んでよいか」を判断します。完了報告では、正常な既知項目を大量に列挙するのではなく、状態、初回処理量、判断根拠、異常・不確実性、検証結果、commit状況を中心に伝えます。
