# AI判定・構造化チェック機能

指定した個別ページのHTML本文と添付PDF本文を既存機能で取得し、1回のAI問い合わせで対象判定と行政ニーズを構造化できるか確認するコマンドです。

初期ProviderはClaude CLIで、テスト用Mockも利用できます。AI結果のファイル保存、SQLite、Notion登録、一括処理、定期実行、他Provider対応は行いません。

## 実行前の確認

AIへ送るのは自治体・公共機関の公式サイトで公開されている文書だけにしてください。秘密情報、社外秘、認証後ページ、手元の非公開資料、追加の個人情報を入力しないでください。

自社関連度は `config/company-fit-criteria.yaml` を使用します。初期値は実装指示書の想定であり、実運用前に自社の提供領域、将来注力領域、パートナー方針に合わせて確認してください。この判定基準もAIへ送信されます。

Claude CLIの存在と認証状態を確認します。

```bash
claude --version
claude --help
```

認証確認だけでなく、`claude -p` の非対話実行が成功することを確認してください。出力0バイトの場合は認証と決めつけず、CLI引数、終了コード、標準出力長、標準エラー、解析段階を確認します。

## コマンド

Claude CLIで実AI確認:

```bash
npm run ai:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

Codex実行環境でClaude CLIが応答しない場合は、結合確認のために長時間待機や繰り返し実行をしません。fixture・Mock・疑似子プロセスを使う自動テストまで完了し、上記の実行コマンドをユーザーへ提示して、ローカルターミナルで実Claudeの結果を確認してもらいます。Mock成功を実Claude成功として扱いません。

Mockで取得・入力組み立て・表示だけを確認:

```bash
AI_PROVIDER=mock npm run ai:check -- \
  --source osaka-digital-rss \
  --url "https://www.city.osaka.lg.jp/ictsenryakushitsu/page/0000684546.html"
```

解析JSONだけを標準出力:

```bash
npm run --silent ai:check -- --source osaka-digital-rss --url "https://..." --json
```

機械処理へパイプする場合は、npm自身の実行バナーを混ぜないため `npm run --silent` を使用してください。`ai-check.ts` は解析JSONだけを標準出力し、Warningは標準エラーへ分離します。

PDFを取得・送信せずHTML本文だけで解析:

```bash
npm run ai:check -- --source osaka-digital-rss --url "https://..." --no-pdf
```

`--json`でもWarningは標準エラーへ表示します。AI結果をファイルへ保存するオプションはありません。

## 処理の流れ

1. 台帳から情報源と組織を取得
2. 既存の `content-check` でHTML本文、タイトル、PDF URLを取得
3. PDF URLを重複除外し、優先度順に抽出して本文が取れたものを最大3件集める
4. PDF失敗はWarningにしてHTML本文だけで続行。本文0文字のPDFは枠を消費せず次候補を試す
5. HTML最大30,000文字、1PDF最大20,000文字、PDF合計最大50,000文字へ先頭・末尾を残して切り詰め
6. 外部プロンプトと自社適合度判定基準を使いAIへ1回送信
7. 行政ニーズJSONの`JSON.parse`に失敗した場合だけ、修正指示付きで最大1回再試行
8. 標準入力に含めたJSON Schemaで出力を指示し、アプリ側Zodで構造を検証
9. 根拠引用の出典URLと、空白正規化後の原文包含を確認
10. 人間向け表示または `--json` で標準出力

根拠照合に失敗しても解析自体は表示しますが、Warningになります。AIの判定は人が根拠原文と照合してください。

## AI入力の可視化

候補ごとに、Claudeへ実際に渡した原文の量を表示します。取得できた全文ではなく送信量です。

```text
AI input:
HTML characters: 583
PDF documents included: 2
PDF characters: 17389
Total source characters: 17972

PDF input:
- プロポーザル実施要領（PDF：452KB）: 9681 chars
- 富山県市町村デジタル人材確保支援業務委託仕様書（PDF：528KB）: 7708 chars

PDF skipped from AI input:
- (別添1)プロポーザル審査基準（PDF：400KB）
```

`ai:check`、`source:verify`、`collect:run`、`collect:batch`、`notion:batch`、`notion:register` が同じブロックを共有します。Claude解析へ進まなかった候補（重複スキップ、本文取得失敗）には表示しません。

Claude CLIの外側JSONが `usage.input_tokens` を返した場合だけ `Claude input tokens:` を追加します。usage が無い、または数値でない環境では文字数だけを表示し、解析は通常どおり続行します。この値の取得のためにClaude CLIの引数や呼び出し方式は変えていません。

## PDFの優先度

行政ニーズ（課題・目的・要求事項）が書かれている可能性でPDFを4段階に分けます。判定はリンクテキスト、ファイル名、URLパスのキーワード一致で、PDFの内容は読みません。`normalizeForMatch` でNFKC正規化・小文字化してから部分一致を見るため、全角半角と大文字小文字の差は吸収します。

| 優先度 | 例 |
| --- | --- |
| 高 | 仕様書、要求仕様、実施要領、募集要項、募集要領、公募要領、情報提供依頼、RFI、業務概要、事業概要 |
| 中 | 概要、説明資料、参考資料、計画、ガイドライン |
| その他 | キーワードに一致しない資料 |
| 低 | 評価基準、審査基準、採点表、評価項目、様式、申込書、申請書、質問、契約書、契約約款、入札書、委任状、特記事項、見積書、見積額、配置図、作成要領、チラシ、地図、料金表 |

高優先キーワードは低優先キーワードより強いため、「募集要項及び応募様式」は高優先になります。

**低優先PDFは、それ以外のPDFが1件でもあればClaude入力へ送りません。** 最大3件に余りがあっても、枠を埋めるために低優先PDFを送りません。評価基準や様式は案件の存在を示すだけで判定材料をほとんど含まないため、外しても判定品質を落とさずに入力量とPDF取得の通信を減らせます。

低優先しか無い場合は候補を絞らず全件を対象にします。PDFを1件も渡さないと判定材料がHTML本文だけになり、必要以上に情報を失うためです。評価基準しか添付が無い候補でPDFを完全に捨てることはありません。

括弧は `normalizeForMatch` でも落ちないため、除外語は括弧を含めない形で持ちます。実データに多い「契約書（案）」は `契約書案` に一致しないため `契約書` で判定します。同様に「質問書」「質問票」「質問及び回答」は `質問` の1語でまとめています。自治体固有の語はキーワードに入れません。

`特記事項`、`見積書`、`見積額`、`配置図`、`作成要領` は、実測で3枠目に入っていた添付資料（個人情報取扱特記事項、再委託見積額、配置図、企画提案書作成要領）を狙って追加したものです。`個人情報`、`見積`、`設営` のような単語では有用な資料まで巻き込むため使いません。「訓練施設の設営について」のように安全に狙える語が無いものは `other` のまま残しています。高優先キーワードが先に判定されるため、「業務仕様書（特記事項含む）」は高優先のままです。

## 本文0文字のPDF

画像PDFやスキャンPDFで本文が実質0文字だった場合、そのPDFはAI入力枠を消費させず次順位の候補を試します。本文を取得できたPDFが最大3件そろった時点で残りの候補は取得しません。判定は `text.trim() === ''` で、独自のしきい値は設けていません。

枠を消費しなかったことは `pdf_empty_text` のNOTICEで示します。テキストを抽出できなかった事実そのものは既存の `pdf_warning`（`empty_pages`）がWARNINGとして残るため、重要度を二重に数えません。0文字PDFを成功したPDFとして扱わず、`pdf_inputs` にも入れません。

**取得や解析そのものが失敗した場合は、従来どおり枠を消費します。** 補充は本文0文字の場合だけです。次候補を試しても3件に届かない場合はその件数のまま解析へ進みます。全PDFが0文字でもHTML本文だけで解析を続けます。OCRは追加していません。

## PDF文字数の2段階上限

1PDFあたり20,000文字、PDF合計50,000文字の2段階で制限します。先に1PDFあたりの上限を当て、そのうえで合計が上限を超える場合だけ既存の均等配分を行います。切り取り方は従来と同じ先頭70%＋末尾30%です。

1PDFあたりの上限を入れた理由は、実測で1ファイルが49,846文字を占め、合計上限だけでは1件が予算をほぼ独占して他の資料が入らなくなっていたためです。20,000は合計の40%に当たり、実測した高優先PDFの最大12,307文字に対して余裕があります。3件が上限に張り付いても均等配分が働きます。短いPDFは従来どおり全文を使います。

これはRelevant Chunk化までの暫定措置です。切り詰めが起きた候補では、AI入力ブロックの `PDF characters` に `20000 (extracted 49846)` の形で抽出全文の文字数を併記します。

## AnalyzerとClaude CLI

共通の `AdministrativeNeedAnalyzer` を `ClaudeCliAnalyzer` と `MockAnalyzer` が実装します。Claude固有の子プロセス処理は `claude-cli.ts` と `process.ts` に閉じています。プロンプトは `prompts/ai-check.md`、自社適合度判定基準は `config/company-fit-criteria.yaml` です。

Claude CLIはシェルを経由せず引数配列で起動し、システム指示、出力JSON Schema、行政文書を標準入力で渡します。互換性確認済みの最小引数だけを使用します。

```text
-p
--output-format json
--max-turns 1
```

標準出力はClaude CLIの外側JSONとして解析し、`type=result`、`subtype=success`、`is_error=false`、文字列型の`result`を順番に確認します。`result`をtrimし、文字列全体が`json`付きまたは言語指定なしのMarkdownコードフェンスで囲まれている場合だけ外側のフェンスを除去します。その後JSON解析し、最後にZodで検証します。説明文からJSONらしい部分を探索・抽出する処理は行いません。プロンプトでもコードフェンスや前後の説明文を付けず、JSONオブジェクトだけを返すよう指示します。

初回の行政ニーズJSONが`JSON.parse`できない場合だけ、同じ分析対象をClaude CLIへ最大1回再送します。再試行プロンプトでは、前回が不正JSONだったこと、JSON文字列内のダブルクォートを`\"`へエスケープすること、コードフェンスや説明文を付けないことを明示します。初回成功、外側JSON・CLI実行の失敗、Zod validation失敗では再試行しません。コード側で不正JSONを修復したり、`{...}`を探索・抽出したりはしません。再試行成功時は`ai_json_parse_retry` Warningを表示し、再試行後も失敗した場合は通常どおりエラー終了します。

Claude CLIが非zeroで終了した場合は、汎用エラーにする前に標準出力と標準エラーを確認します。`--output-format json`の標準出力がJSONとして解析できる場合は外側JSONの文字列値を先に調べ、解析できない場合もraw標準出力・標準エラーから判定します。実際に返る`You've hit your limit`を含む行を検出した場合だけ、通常の`Claude CLI execution failed`と区別できる`ClaudeUsageLimitError`を投げます。`limit`単独やレート制限の文言では判定しません。曲がりアポストロフィは直線に寄せて比較します。検出したメッセージはリセット時刻を含む場合があるため、そのまま保持して表示します。利用上限の場合はJSON再試行のための再送も行いません。

子プロセスは一時ディレクトリで起動し、タイムアウト時はプロセスグループを終了します。標準出力は2MB、標準エラーは64KBを上限とします。失敗時は認証と決めつけず、終了コード、シグナル、標準出力文字数、標準エラー、失敗した解析段階を表示します。入力本文そのものはエラーへ表示しません。外側JSONの`result`がstage 7でJSON解析できなかった場合に限り、`result`全体とフェンス除去後の文字数、コードフェンスの検出・除去状態、元の`JSON.parse`エラー、除去後文字列の先頭・末尾各最大500文字を表示します。エラーメッセージから位置を取得できる場合は、その前後各最大200文字も`Parse error context`として表示します。既知のAPIキー・token形式、Bearer値、秘密値を示す名前付き代入は表示前にマスクします。通常成功時の出力は変わりません。

## 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `AI_PROVIDER` | `claude_cli` | `claude_cli` または `mock` |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI実行ファイル |
| `AI_TIMEOUT_MS` | `180000` | AI実行タイムアウト。1,000〜600,000ms |
| `AI_MAX_PDFS` | `3` | 取得するPDF数。1〜10 |
| `AI_MAX_HTML_CHARACTERS` | `30000` | AIへ送るHTML文字数上限 |
| `AI_MAX_PDF_CHARACTERS` | `50000` | AIへ送るPDF本文合計文字数上限 |
| `AI_MAX_CHARACTERS_PER_PDF` | `20000` | AIへ送る1PDFあたりの文字数上限。1,000〜500,000 |
| `AI_CHECK_PROMPT_PATH` | `prompts/ai-check.md` | プロンプトファイル |
| `AI_COMPANY_FIT_CRITERIA_PATH` | `config/company-fit-criteria.yaml` | 自社適合度判定基準 |

最小引数構成ではモデルを指定せず、Claude CLI側の既定モデルを使用します。アプリの表示上はモデルが `not applicable` になります。

## 出力スキーマ

内部値は比較しやすい固定IDです。主な項目:

- `is_target`
- `document_type`: `rfi`、`sounding`、`proposal`、`bid`など
- `problem_summary`、`desired_state`、`request_to_private_sector`
- `categories`: 12種類の固定された日本語カテゴリ名から1〜3件（対象外は空配列）
- `company_relevance`: `A`、`B`、`C`、`out_of_scope`
- `contact_recommendation`: `high`、`medium`、`low`、`none`
- `reason`
- `evidence_quotes`: `source_type`、`source_url`、`quote`を持つ配列

対象外の場合は `company_relevance=out_of_scope`、`contact_recommendation=none` を必須とします。未知キー、未知の列挙値、空の根拠引用はZodで拒否します。

カテゴリ候補は `src/ai/categories.ts` の共通定義だけで管理します。プロンプト読み込み時に `{{CATEGORY_OPTIONS}}` を候補名と判断基準へ置換し、固定候補外、4件以上、重複、「その他」と他カテゴリの併用をZodで拒否します。AIのカテゴリ名は変換せず、そのままNotionの`multi_select`名として使用します。

## 終了コード

- `0`: AI解析成功。PDF失敗や根拠不一致などのWarningを含む場合も0
- `1`: HTML取得、AI実行、JSON解析、Zod検証に失敗
- `2`: 引数、情報源ID、自社適合度判定基準、プロンプト、環境設定、Claude CLIパスが不正

## テストと制約

`npm test`はネットワークとClaude CLIを使用せず、fixture、Mock、疑似子プロセスで検証します。Mock成功を実AI成功として報告しないでください。GitHub Actionsでも実AIは呼びません。

現在の制約:

- AI判定は確率的で、同じ入力でも表現や判定が変わる可能性がある
- 見た目、図、画像PDF、OCR対象は解析しない
- PDFは優先度で最大3件まで。優先度はリンクテキストとファイル名のキーワード判定で、内容は読まない
- HTML本文はAI入力から削らない。PDF本文の要約や部分抽出も行わず原文を渡す
- 文字数上限は厳密なトークン計算ではない
- 根拠照合は空白正規化後の包含確認で、意味的一致は判定しない
- AI結果だけで自治体へ連絡したり、営業・入札判断を確定しない
- AI結果の保存、履歴管理、複数案件統合、一括実行は行わない
