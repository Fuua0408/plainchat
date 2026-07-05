# 013: 画像アップロード基盤(バックエンド)

## 1. 目的
画像ファイルのアップロード・永続化・認証付き配信を行うバックエンド基盤を実装する。
Phase 3(Vision)の共有土台であり、チャット送信フローには一切手を入れない。

## 2. 対象
Phase 3「画像アップロード→Vision対応」の基盤部分(バックエンドのみ)。
DECISIONS.md「Phase 3の着手順とスコープ」「画像添付まわりの設計判断」(2026-07-05)に従う。

## 3. 前提・参照
- 001〜012完了済み。src/routes/chat.js が会話所有チェック→SSE中継を行っている
- スキーマ変更は010で確立した「起動時の冪等作成」パターンを踏襲する
  (新規テーブルは db.js 初期化時に CREATE TABLE IF NOT EXISTS。既存DBを壊さないこと)
- 認可方針: リソースの所有者不一致は403ではなく404(DECISIONS 2026-07-05「認可エラーの表現方針」)
- 認証は src/auth.js の authMiddleware(Bearer)を使用。今回はURLクエリトークン方式は使わない
- 画像の表示はフロント側で「認証付きfetch→Blob URL」を用いる前提(014で実装)。
  したがって配信APIはBearerヘッダー必須の通常エンドポイントでよい
- multer を新規依存として追加する(MITライセンス。package.jsonに追加しnpm install)
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### 依存追加
- multer を package.json に追加してインストールする

### スキーマ(src/db.js)
- attachments テーブルを追加(CREATE TABLE IF NOT EXISTS を初期化時に実行):
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - user_id INTEGER NOT NULL
  - conversation_id INTEGER NOT NULL
  - message_id INTEGER            -- NULL可。アップロード時点では未確定(014で紐付け)
  - kind TEXT NOT NULL DEFAULT 'image'
  - mime TEXT NOT NULL
  - size INTEGER NOT NULL
  - path TEXT NOT NULL            -- data/ からの相対パス
  - original_name TEXT
  - created_at                    -- 既存テーブル(messages等)と同じ規約で
- 既存DBでの起動時に自動作成され、再起動してもエラーが出ない(冪等)こと

### ストレージ
- 保存先ディレクトリ: data/uploads/{userId}/(存在しなければ再帰的に作成)
- ファイル名は衝突しにくい形にする(例: `${Date.now()}_${短いランダム}_${sanitize済み元名}${拡張子}`)。
  元ファイル名は path.basename で拡張子を分離し、英数字_- 以外を除去、拡張子は小文字化
- 会話IDはファイルパスに含めない(attachmentsのカラムで管理)。
  これにより multer の destination は req.user.id のみに依存する(authMiddleware後なので確実に存在)

### アップロードAPI(src/routes/uploads.js 新規)
- POST /api/uploads/image (authMiddleware, multer single('image'))
  - 制約: 許可MIMEは image/jpeg, image/png, image/webp, image/gif のみ。
    サイズ上限10MB。multerのfileFilter/limitsで弾く
  - body に conversation_id を要求(FormData)
  - conversation_id が自分の会話か確認(SELECT id FROM conversations WHERE id=? AND user_id=?)。
    不一致または不存在、あるいはファイル/MIME不正のときは、保存済み一時ファイルを
    fs.unlink で必ず削除してから 400 または 404 を返す
    (会話所有の不一致は404、リクエスト不備は400)
  - 検証OKなら attachments に INSERT(message_id は NULL、kind='image')
  - レスポンス: { id, url } を返す。url は配信パス `/api/uploads/image/${id}`

- GET /api/uploads/image/:id (authMiddleware)
  - :id は数値バリデーション
  - attachments を id で取得。行が無い、または user_id が自分と不一致なら404
  - 保存パスを data/ 基準で安全に解決し(path.basename等でトラバーサル防止)、
    実ファイルが無ければ404。あれば保存時の mime を Content-Type にして sendFile
  - Cache-Control は no-store(認証必須リソースのため)

### ルート登録(src/index.js)
- uploads ルーターを /api/uploads にマウント

## 5. やらないこと
- src/routes/chat.js・送信フロー・履歴構築・マルチモーダルcontentの構築(014)
- フロントエンド(添付UI・プレビュー・Blob表示)(014)
- message_id の実際の紐付け(014でメッセージ保存時にUPDATE)
- 画像以外(PDF/テキスト)の受け入れ(②後続タスク)
- URLクエリにトークンを載せる配信方式(Blob方式のためBearerヘッダーのみ)
- 会話削除時のattachments/実ファイルのクリーンアップ、孤児アップロードの回収
  (別タスクで扱う。今回はconversations/authに手を入れない)
- .env の変更

## 6. 完了条件
実DBに対してcurl等で確認する。
1. サーバー起動でattachmentsテーブルが冪等作成される(既存の会話・メッセージが無傷、
   再起動でエラーなし)
2. 自分の会話IDで画像をPOST → { id, url } が返り、data/uploads/{userId}/ に保存され、
   attachments行が1件入る(message_id が NULL)
3. GET /api/uploads/image/:id を Bearer 付きで叩くと画像が返る(Content-Typeが正しい)。
   トークンなしでは401
4. 他人の会話IDでPOST → 404。かつ一時ファイルが残っていない(unlink済み)
5. 他人のattachment idをGET、および存在しないidをGET → いずれも404
6. 11MBの画像 → 拒否。application/pdf 等の非許可MIME → 拒否(いずれもファイルが残らない)
7. テストで作成した会話・アップロードファイル・attachments行を削除して完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する