# Notion接続・データベース構成確認

`.env`の`NOTION_TOKEN`を使用し、指定したNotionデータベースと配下の全データソースを読み取り確認するコマンドです。

この機能が使用するNotion APIは次のGET系処理だけです。

- データベース取得: `notion.databases.retrieve`
- データソース取得: `notion.dataSources.retrieve`

ページ、データベース、データソース、プロパティの作成・更新・削除は行いません。行データの検索も行いません。

## 準備

リポジトリ直下の`.env`へトークンを設定します。`.env`はGit管理対象外です。

```env
NOTION_TOKEN=your-token
```

トークンをコマンド出力、エラー、ログへ表示しません。Notion SDKの内部ログも無効化しています。

## 実行

データベースURLを指定:

```bash
npm run notion:check -- \
  --database-url "https://app.notion.com/p/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=..."
```

データベースIDを指定:

```bash
npm run notion:check -- \
  --database-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

`--database-url`と`--database-id`はどちらか一方だけ指定します。URLではパス部分から32文字IDまたはUUID形式IDを取得し、クエリパラメータのビューIDは使用しません。`notion.com`、`notion.so`、`notion.site`とそのサブドメイン以外は拒否します。

## APIバージョンとSDK

- Notion API: `2026-03-11`
- SDK: `@notionhq/client` v5.12.0以上

クライアントは`notionVersion: "2026-03-11"`を明示して作成します。

## 表示内容

- データベース名とID
- 配下のデータソース数
- 全データソースの名前とID
- 各プロパティの名前、ID、種類
- 接続・読み取り成功と、書き込みを行っていない旨

データソースが複数ある場合はすべて表示し、登録先を自動選択しません。1件の場合だけ、次の登録実装で使用する候補IDとして表示します。

## エラーと終了コード

- `0`: 接続・読み取り確認成功
- `1`: Notion APIエラー、データソース0件、レスポンス不備
- `2`: トークン未設定、引数・URL・ID不正

401、403、404は認証、権限、存在・共有状態のメッセージへ変換します。それ以外のAPIエラーはHTTPステータスとNotion APIエラーコードだけを表示し、APIの生メッセージは表示しません。

## テスト

```bash
npm test
```

単体テストはNotionクライアントをモックし、Notion APIへアクセスしません。実アクセスはユーザーから明示的に指定されたデータベースだけに対して手動実行します。
