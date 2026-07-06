# 016: 添付基盤のファイル対応(バックエンド)

## 1. 目的
テキスト系ファイル(txt / Markdown / csv / json)のアップロード・永続化・配信を可能にする。
013の画像アップロード基盤を kind 対応へ拡張する、バックエンドのみのタスク。
チャットへの注入(017)・フロント(018)には手を入れない。

## 2. 対象
Phase 3 ②「ファイル添付(テキスト/PDF等)の要約・QA」の基盤部分(テキスト系のみ、
バックエンド)。DECISIONS.md「Phase 3 ② テキストファイル添付のスコープ確定」(2026-07-05)に従う。

## 3. 前提・参照
- 013/014/015完了済み。attachments テーブル、POST /api/uploads/image、
  GET /api/uploads/image/:id、src/attachmentStorage.js(DATA_DIR絶対パス化・
  attachment→ファイルパス解決)が動作している
- attachments は現状 kind カラムを持ち、画像は kind='image'。
  本タスクでテキストファイルを kind='file' として扱えるようにする
- スキーマ変更は010以降の「起動時の冪等 ALTER/CREATE」パターンを踏襲(既存DBを壊さない)
- 認可は user_id スコープ、所有不一致は404(既存方針)
- 保存・配信・所有チェックの仕組みは013のものを再利用する(attachmentStorage.jsを活用)
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### 受け入れ形式・制約
- 許可拡張子/MIME: text/plain(.txt)、text/markdown(.md)、text/csv(.csv)、
  application/json(.json)。MIMEが曖昧なケースに備え拡張子でも判定してよいが、
  許可セット外は拒否する
- サイズ上限: 1ファイル 1MB(超過は保存前に拒否)
- 文字コード: UTF-8前提。妥当なUTF-8として読めない場合は拒否してよい(実装した挙動を報告)

### スキーマ / 保存
- attachments に、テキスト本文の抽出結果を参照するための情報を持たせる。
  本文はDBセルに直接入れず、data/ 配下にサイドカーとして保存し attachments から参照する
  (例: 元ファイルとは別に .txt を保存、または元ファイルをそのまま本文として扱う。
  どちらでも良いが、017が「本文テキスト」を安定して取得できる形にすること)
- 既存の画像行・既存カラムを壊さないこと。新カラムが必要なら冪等ALTERで追加
- 保存先は data/uploads/{userId}/ 配下(013の方式を踏襲、絶対パス解決はattachmentStorage.jsを使う)

### アップロードAPI
- 画像用 POST /api/uploads/image はそのまま維持する
- テキストファイル用に POST /api/uploads/file を追加(authMiddleware、multer single)
  - body に conversation_id を要求し、自分の会話か確認(不一致/不存在は、保存済み一時ファイルを
    unlink してから 404)
  - 形式・サイズ検証NG時も一時ファイルを残さず 400
  - 検証OKで attachments に INSERT(kind='file'、mime、size、original_name、本文参照情報、
    message_id は NULL)
  - レスポンス: { id, url, kind:'file', original_name, size } を返す
    (url は配信パス /api/uploads/file/:id)
- 実装を共通化できるなら image/file でハンドラを共有してよいが、許可MIME・kind・上限が
  分岐することを明確にすること

### 配信API
- GET /api/uploads/file/:id を追加(authMiddleware、Bearer必須)
  - id 数値バリデーション、attachments を id で取得、user_id 不一致や不存在は404
  - kind='file' のもののみ配信(画像idを間違って渡されたらこのルートでは扱わない)
  - 実ファイルを絶対パス解決して返す。Content-Type は保存mime、Cache-Control は no-store
  - パストラバーサル防止(attachmentStorage.jsの解決を使う)

## 5. やらないこと
- src/routes/chat.js・注入ロジック・履歴構築(017)
- フロントエンド(018)
- message_id の実際の紐付け(017でメッセージ保存時にUPDATE。既存の画像と同じ流れ)
- PDF/docx/pptx/画像PDF・OCR、csv/jsonのパースや整形(生テキストのまま扱う。今回対象外)
- 注入時の文字数上限・切り詰め(017)
- 複数ファイル・画像との混在のフロント制御(018)
- 会話/メッセージ削除時の attachments・実ファイルのクリーンアップ(別タスク)
- 画像用API(/api/uploads/image, /image/:id)の仕様変更
- .env の変更

## 6. 完了条件
実DBに対して curl 等で確認する。
1. サーバー起動でスキーマ変更が冪等に適用され、既存の会話・メッセージ・画像attachmentsが無傷。
   再起動でエラーなし
2. 自分の会話へ .txt / .md / .csv / .json をPOST → { id, url, kind:'file', ... } が返り、
   data/uploads/{userId}/ に保存され、attachments行(kind='file'、message_id NULL)が入る
3. GET /api/uploads/file/:id を Bearer 付きで叩くと本文が取得でき、トークンなしでは401
4. 017が使う「本文テキスト」が、保存物から安定して取得できる形になっている
   (実装方針を報告)
5. 1MB超のファイル → 400で拒否、ファイルが残らない
6. 許可外(例: application/pdf、実行ファイル、非UTF-8バイナリ)→ 400で拒否、ファイルが残らない
7. 他人の会話IDでPOST → 404、一時ファイルが残らない。他人/存在しないidをGET → 404
8. 画像経路(/api/uploads/image 系)が従来どおり動作する(リグレッションなし)
9. テストで作成した会話・attachments行・アップロード実ファイルを削除して完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する