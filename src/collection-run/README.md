# 情報源候補からNotionまでの手動一括実行

台帳へ登録済みの情報源から対象期間の候補URLを取得し、Notionの公式URL重複確認を行いながら、未登録候補を最大20件まで直列処理する手動コマンドです。候補一覧やAI結果は保存しません。

## 実行

デフォルトはプレビューです。初回は2026-07-01から実行開始時刻までを対象にします。

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

手動バックフィルでは`--since YYYY-MM-DD`を指定できます。保存済み日時より優先されますが、バックフィルによって通常収集の状態は進みません。

```bash
AI_PROVIDER=claude_cli npm run collect:run -- \
  --source osaka-digital-rss \
  --since 2026-07-15 \
  --limit 10 \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

`--source`と、`--database-url`または`--database-id`の一方が必須です。URLとIDは同時指定できません。`--limit`の既定値は5、指定範囲は1から20です。

## 対象期間

実行開始時刻を最初に固定し、次の優先順で開始日時を決めます。

1. `--since`があれば指定日
2. 情報源の`last_successful_check_at`があれば、その3日前
3. 状態がなく、台帳に`initial_since`があればその日
4. どれもなければ2026-07-01

3日前が下限日より前になる場合は下限日へ丸めます。下限日は`initial_since`があればその日、なければ2026-07-01です。候補の公開日・更新日が対象期間内なら処理対象です。日付が取れない候補は除外せず、警告を表示して重複確認へ進めます。

実行開始時刻より後の日付も、掲載日ではなく掲載日不明として扱います。北九州市のプロポーザル募集一覧のように、見出しへ「【令和8年8月21日申込締切】」と申込締切を入れる一覧があり、この日付を公開日として解釈すると募集中の案件が期間外で落ちて締切済みの案件だけが通ってしまいます。公開日が実行開始時刻より後になることはないため、期間外として除外せず処理へ回します。期間より前の過去日は従来どおり除外します。

`initial_since`は台帳側の任意設定で、過去分が非常に多く初回からすべてをAI解析したくない情報源に使います。初回収集の開始位置であると同時に、**自動収集の下限日**でもあります。状態ができた後の通常巡回でも、前回成功日時の3日前がこの日より前になる場合は`initial_since`へ丸めるため、自動収集がこの日より過去へ遡ることはありません。

手動バックフィルの`--since`だけはこの下限の対象外で、`initial_since`より前を指定できます。`--since`との併用では`--since`が優先され、従来どおり状態を進めません。`initial_since`を使った通常の`--write`は手動バックフィルではないため、完全成功すれば状態を進めます。

初回実行のログは、その情報源で実際に採用する開始日を表示します。

```text
Initial collection since:
2026-08-01

Effective since:
2026-08-01
```

## limitと重複確認

`--limit`はCollectorの取得件数ではなく、1回にHTML・PDF取得、Claude解析、Notion登録へ進める未登録候補数の安全上限です。

候補をURL文字列で重複排除した後、1件ずつNotionの`公式URL`完全一致検索を行います。登録済みURLはHTML・PDF・Claudeをすべてスキップし、limitを消費しません。未登録候補がlimitを超えた場合は残件数を表示し、状態を進めません。次回は同じ期間を再取得し、前回登録できたURLを重複スキップして残りを処理します。

完全一致で見つからず、候補URLが`http://`の場合だけ、schemeを`https://`へ替えたURLでもう1度だけ照合します。一覧ページが`http://`のリンクを張り、サーバが`https://`へリダイレクトする情報源があり、そのままではHTML・PDF・Claudeとlimitを消費してから登録直前の確認で重複と分かるためです。置き換えるのはschemeだけで、ホスト・ポート・パス・クエリ・フラグメントは変更しません。`https://`から`http://`への逆方向は照合しません。

登録直前にも`公式URL`をもう一度検索します。こちらはAI判定が返した最終URLで照合するため、事前確認の後に別処理が登録した場合の競合対策として残しています。この経路で重複と判明した場合、消費したlimitは戻しません。

## 収集状態

状態はGit管理外の`data/collection-state.json`へ情報源ID単位で保存します。

```json
{
  "osaka-digital-rss": {
    "last_successful_check_at": "2026-08-07T12:00:00+09:00"
  }
}
```

保存する値は処理終了時刻ではなく実行開始時刻です。一時ファイルへ書いてからrenameするatomic writeを使用します。

次の条件をすべて満たした場合だけ状態を更新します。

- `--write`モード
- Collectorが成功
- 失敗が0件
- 対象期間の未登録候補をすべて処理済み
- `--since`を使用していない

プレビュー、Collector・HTML・PDF・Claude・Notionの失敗、limit残件、手動`--since`では更新しません。全件重複または候補0件の正常なWriteは更新できます。プレビューでは状態ファイル自体も作りません。

Claude CLIの利用上限を検出した場合も、失敗と同じく状態を更新しません。停止した情報源の未処理候補は次回の再実行で処理され、登録済みURLは重複としてスキップされます。利用上限より前に完全成功して条件を満たした別の情報源の状態は、そのまま維持します。

状態ファイルが存在しないことは正常な初回状態です。JSON破損や不正な構造を検出した場合は初期化・上書きせず、Collectorや外部処理を始める前にエラー終了します。内容を確認して、正しいJSONへ手動で復旧してください。

## 処理順

1. 引数、台帳、状態ファイルを検証し、実行開始時刻と対象期間を確定
2. `collector_type`に対応する既存Collectorで候補を取得
3. URL文字列の重複排除と期間フィルタ（日付不明は保持）
4. 候補ごとにNotionの公式URL重複を直列確認
5. 未登録候補だけ、limitまで既存の1件処理へ渡す
6. 結果、残件、状態更新可否を表示
7. 条件を満たすWriteだけ状態をatomic write

1件が失敗しても後続候補を処理します。失敗が1件以上、情報源取得失敗、Notion接続失敗、引数・状態不正の場合は終了コード1です。プレビュー・作成・重複スキップだけ、またはlimit残件だけの場合は0ですが、残件があれば状態は進みません。

## Claude CLIの利用上限

Claude CLIが利用上限に達した場合、`ai_analysis`の汎用エラーとして次の候補を試し続けず、その実行を打ち切ります。

```text
[ERROR] Claude CLI usage limit reached.
You've hit your limit · resets 10pm (Asia/Tokyo)

AI processing has been stopped for the rest of this run.
```

`collect:run`では残りの候補へClaudeを呼びません。`collect:batch`では利用上限がClaude全体の状態であるため、後続の情報源も実行せずバッチを終了します。Final summaryの`Created` / `Previewed` / `Duplicates skipped` / `Failed` / `Remaining new candidates`は従来どおり表示し、末尾に停止理由と開始しなかった情報源数を追加します。

すでに作成済みのNotionページはロールバックしません。自動再実行、リセット時刻までの待機、他Providerへのfallbackは行いません。

## 安全策と制約

- `--write`がない限りNotionへ書き込まない
- Mock解析結果を登録しない
- Notionのスキーマや選択肢を自動変更しない
- 既存ページを更新・削除しない
- トークン、Authorizationヘッダー、Claude入力、HTML・PDF本文を表示・保存しない
- 候補、AI結果、実行履歴のJSON・CSV・データベース保存を行わない
- SQLite、ロック、並列処理、自動リトライ、定期実行を追加しない

実Claudeと実Notionを使うため、公開文書、対象期間、limitを確認してから手動実行してください。実行後はAI判定とNotion登録内容を人が確認します。

Codex実行環境で実Claude CLIが応答しない場合は、結合確認を無理に待機せず、外部アクセスを行わないMockテストまでで停止します。上記のプレビューと`--write`コマンドをローカルターミナルから実行してください。Mock成功を実Claude・実Notionの結合確認成功として扱いません。
