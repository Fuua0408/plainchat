# 019: 履歴attachmentに original_name / size を追加(バックエンド追補)

## 1. 目的
GET /api/conversations/:id/messages が返す attachments に original_name と size を含める。
履歴表示でファイルの実名が失われる問題(018で発見)を解消する、小さなバックエンド追補。

## 2. 対象
Phase 3 ②「ファイル添付」の仕上げ。018の実行報告で判明したAPI仕様のギャップ対応。

## 3. 前提・参照
- 013〜018完了済み。attachments テーブルには original_name, size カラムが既に存在する(013)
- GET /api/conversations/:id/messages は src/routes/conversations.js にあり、
  現在 attachments を { id, kind, mime, url } で返している(url は017で kind 別に出し分け済み)
- 画像(kind='image')にも original_name/size は存在するが、主用途はファイルチップの実名表示
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件
- GET /api/conversations/:id/messages の各 attachment に original_name と size を追加し、
  { id, kind, mime, url, original_name, size } を返す
- original_name が NULL のレコードは null のまま返してよい(フロント側でフォールバック)
- 既存のレスポンス形({ conversation, messages })・url の出し分け・他フィールドは変更しない
- 画像・ファイル双方でメタが返ること(SELECT にカラムを追加するだけで足りるはず)

## 5. やらないこと
- フロントエンドの変更(履歴チップが original_name を使う追従は020以降で別途判断)
- attachments スキーマの変更(既存カラムを読むだけ)
- アップロード/配信API・chat.js・注入ロジックの変更
- .env の変更

## 6. 完了条件
実DBに対して curl 等で確認:
1. ファイル添付を含む会話で GET /:id/messages → 該当 attachment に original_name と
   size が含まれ、値が保存時のものと一致する
2. 画像添付でも original_name/size が返る
3. original_name が NULL のレコードで null が返り、エラーにならない
4. レスポンスの既存フィールド(id/kind/mime/url)と url の kind 別出し分けが従来どおり
5. テストで作成した会話・添付を削除して完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する