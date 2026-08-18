# Claude Code向けプロジェクト指示

このリポジトリの全般的な安全ルール、変更範囲、必須検証は `AGENTS.md` に従ってください。

## 自治体・情報源の追加と変更

自治体または情報源を調査・追加・変更するときは、作業前に `docs/agent-workflows/municipality-source.md` を読み、記載された品質基準をすべて満たしてください。台帳登録や `sources:check` 成功だけで完了にせず、継続巡回性、URL再利用、`publishedAt`、duplicate、filterの安全性、無効化理由まで確認します。

報告を短くするために調査を省略してはいけません。調査は共通workflowどおり実施し、ユーザーへの通常報告だけを原則として次に絞ります。

1. 追加・変更した各SourceのSource ID・名称・`enabled` / `disabled`・priority
2. 初回の期間対象数と、既定limitでClaudeへ進む最大件数
3. 判断に影響した根拠
4. Warning、不確実性、将来再確認事項
5. `sources:validate`、対象Sourceの`sources:check`、lint、typecheck、testの結果
6. commitの有無と作業ツリーに残る別作業

問題がなければ、全HTTP結果、全selector比較、全PDF文字数、既知Notice、正常な候補・Skippedの全明細、既知仕様の長い説明は繰り返しません。異常、新しい観察、設計判断に影響する事実がある場合だけ必要な詳細を示してください。

簡潔な報告は調査品質を下げる理由にはなりません。判断根拠と検証結果は内部で確認し、不確実な点を推測で正常扱いしないでください。
