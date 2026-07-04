# 004: 会話CRUD APIの実装

## 1. 目的
会話スレッドの作成・一覧・更新・削除と、メッセージ履歴取得のAPIを実装する。
全エンドポイントでuser_idスコープの認可を徹底する。

## 2. 対象
Phase 1「単一/複数セッション(会話スレッド)の作成・一覧・切り替え・削除」
および「会話履歴のDB永続化」(読み取り側)

## 3. 前提・参照
- 001〜003完了済み(DB: conversations/messagesテーブルあり、認証: authMiddlewareあり)
- src/auth.js の authMiddleware を全ルートに適用する
- 設計方針: 全クエリで user_id による所有者チェックを行う。
  「単一ユーザーだから」を理由にWHERE句を省かない(DECISIONS.md 2026-07-05参照)
- .base/ の参照は任意(本タスクはPlainChat独自スキーマのため、参照価値は低い)
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### src/routes/conversations.js(新規)
router.use(authMiddleware) を適用したうえで:

- GET /api/conversations
  - 自分(req.user.id)の会話一覧を updated_at 降順で返す
  - レスポンス: { conversations: [{ id, title, created_at, updated_at }] }

- POST /api/conversations
  - body: { title? }(省略時はDBデフォルトの「新しい会話」)
  - 自分のuser_idで作成し、作成した会話を201で返す

- PATCH /api/conversations/:id
  - body: { title }(必須、空文字不可、200文字以内)
  - 所有者チェック: 自分の会話でなければ404
  - updated_at も更新。更新後の会話を返す

- DELETE /api/conversations/:id
  - 所有者チェック: 自分の会話でなければ404
  - 削除成功で { ok: true }(messagesはON DELETE CASCADEで消える)

- GET /api/conversations/:id/messages
  - 所有者チェック: 自分の会話でなければ404
  - メッセージを id 昇順で返す
  - レスポンス: { messages: [{ id, role, content, created_at }] }

### 実装上の注意
- 所有者チェックは「存在しない」と「他人の所有」を区別せず、どちらも404
  { error: 'Not found' } とする(存在の推測を許さない)
- :id が数値でない場合は400
- prepared statementを使用(better-sqlite3の標準的な使い方)

### src/index.js の変更
- /api/conversations ルートを登録

## 5. やらないこと
- メッセージの書き込みAPI(005のLLM連携ストリーミング処理に含める)
- 会話の検索・フィルタ(Phase 2)
- タイトル自動生成(Phase 2)
- ページネーション(MVPでは全件返却で十分。Phase 2の検索と合わせて検討)
- フロントエンドの実装
- .env の変更

## 6. 完了条件
curl(Bearerトークン付き)で以下を確認:
1. POST で会話作成 → 201、title指定あり/なし両方
2. GET 一覧 → 作成した会話が updated_at 降順で並ぶ
3. PATCH でタイトル変更 → 反映と updated_at の更新を確認
4. PATCH に空文字タイトル → 400
5. GET /:id/messages → { messages: [] }(まだ書き込みAPIがないため空)
6. DELETE → { ok: true }、一覧から消えることを確認
7. 存在しないID/数値でないIDへのアクセス → 404 / 400
8. トークンなしで各エンドポイント → 401
9. (可能なら)DBに直接別ユーザーの会話を1件作り、他人の会話への
   GET/PATCH/DELETE が404になることを確認 → 確認後にテストデータを削除

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する