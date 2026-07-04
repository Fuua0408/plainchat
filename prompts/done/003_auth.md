# 003: 認証(JWT)の実装

## 1. 目的
JWTによるログイン認証と、以降のAPIで使う認可ミドルウェアを実装する。

## 2. 対象
Phase 1「認証(本人専用、JWT方式を踏襲)」

## 3. 前提・参照
- 001/002完了済み(Express起動、usersテーブルとシード済み初期ユーザーあり)
- 流用元: .base/src/routes/auth.js および .base/src/auth.js(存在する場合)。
  bcrypt比較・jwt.sign/verify・ログ出力の構造をベースにしてよい
- 変更方針:
  - is_advanced は使わない(PlainChatに存在しない概念)
  - JWTペイロードは { id, username, is_admin } の3項目のみ
  - エラーメッセージ・ログの形式は流用元に準拠しつつ "plainchat" 文脈に合わせる
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### src/auth.js(新規)
- authMiddleware: Authorization: Bearer <token> を検証し、
  成功時 req.user にペイロードを格納、失敗時 401 { error: 'Unauthorized' }
- JWT_SECRET 未設定時は起動時に警告ログを出す(リクエスト時ではなく)

### src/routes/auth.js(新規)
- POST /api/auth/login
  - body: { username, password }
  - 検証OKで { token, user: { id, username, is_admin } } を返す
  - JWTの有効期限は30日
  - 失敗時 401 { error: 'Invalid credentials' }(ユーザー不在とパスワード誤りを区別しない)
  - 成功/失敗をloggerに出力(パスワードはログに残さない)
- POST /api/auth/change-password(authMiddleware適用)
  - body: { current_password, new_password }
  - new_passwordは8文字以上(流用元の6文字から引き上げ)
  - 成功時 { ok: true }
- GET /api/auth/me(authMiddleware適用)
  - { user: { id, username, is_admin } } を返す(トークン有効性の確認用)

### src/index.js の変更
- /api/auth ルートを登録

## 5. やらないこと
- ユーザー登録API・ユーザー管理API(作らない方針)
- トークンのリフレッシュ機構、ログアウトのサーバー側管理(MVP不要)
- フロントエンドのログイン画面(チャットUIタスクで実装)
- レートリミット等のブルートフォース対策(ローカル利用前提のMVPでは見送り)
- .env の変更・実値の記入

## 6. 完了条件
- curlで確認:
  1. POST /api/auth/login(正しい認証情報)→ token取得
  2. POST /api/auth/login(誤パスワード)→ 401
  3. GET /api/auth/me(Bearer付き)→ user情報
  4. GET /api/auth/me(トークンなし/不正トークン)→ 401
  5. POST /api/auth/change-password → { ok: true } →
     旧パスワードでlogin失敗・新パスワードでlogin成功を確認 →
     確認後、パスワードを元に戻す(change-passwordを再実行)
- ログにパスワード平文が出力されていないことを確認

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する