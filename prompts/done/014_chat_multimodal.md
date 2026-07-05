# 014: チャットのマルチモーダル対応(バックエンド)

## 1. 目的
チャット送信フローを拡張し、ユーザーメッセージに添付した画像をLLMへVision入力として
渡せるようにする。013のattachments基盤を実際の会話に接続する、バックエンドのみのタスク。

## 2. 対象
Phase 3「画像アップロード→Vision対応」のバックエンド統合部。
DECISIONS.md「Phase 3の着手順とスコープ」「画像添付まわりの設計判断」(2026-07-05)に従う。
フロント(添付UI・プレビュー・Blob表示)は015で扱う。

## 3. 前提・参照
- 013完了済み。attachmentsテーブル、POST /api/uploads/image({id,url}返却)、
  GET /api/uploads/image/:id(Bearer必須配信)が動作
- src/routes/chat.js の現行構造を踏まえること:
  - content文字列必須の検証、messages(role,content)へのuser保存
  - 履歴を ORDER BY id ASC で取得し content.trim()==='' を除外して構築
  - resolveSystemPrompt + テンプレート展開で system 挿入
  - stream:true でLLM中継、空応答防御(009)、初トークン後の中断時は部分応答保存
- LLMのマルチモーダル形式(NookResonanceで実証済み、textgen-webui経由も実証済み):
  messagesのcontentを配列にし、要素として
  { type:'text', text } と
  { type:'image_url', image_url:{ url:'data:<mime>;base64,<b64>' } } を並べる
- 013でdata/参照を絶対パス化(DATA_DIR等をpath.resolve)している。画像ファイル読み込みは
  同じ絶対パス解決を再利用する(共有モジュール化されていなければ最小限に切り出す)
- 認可はuser_idスコープ・不一致404(既存方針)
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### API拡張(送信)
- POST /api/conversations/:id/chat の body を { content, attachment_ids } に拡張
  (attachment_ids は省略可、idの配列)
- 検証の変更:
  - content が空文字でも、attachment_ids が1件以上あれば許可する(画像のみ送信を可能に)
  - content も attachment_ids も無い送信は従来どおり400
  - attachment_ids の各idは「自分の所有・この会話・未リンク(message_id IS NULL)・
    kind='image'」をすべて満たすこと。1件でも満たさなければ400を返し、副作用を残さない
    (userメッセージを保存する前に検証する)

### 添付の紐付け
- 検証通過後、userメッセージを保存(content文字列は従来どおり保存。空でも保存)
- 保存したmessageのidを対象attachmentsの message_id に UPDATE
  (WHERE に user_id / conversation_id も含めて安全に更新)

### LLMへのmessages構築(マルチモーダル化)
- 履歴取得を拡張し、各messageに紐づく image attachments(id, mime, path)も取得する
- 各messageのcontentを次の規則で組み立てる:
  - image attachmentが無い → 従来どおり文字列content
  - image attachmentがある → 配列content。textが非空なら先頭に { type:'text', text } を置き、
    続けて各画像を { type:'image_url', image_url:{ url:'data:<mime>;base64,<b64>' } } として追加。
    画像は保存パスを絶対パス解決して読み、base64化する
- 履歴の除外規則(009)を更新: 「contentが空」だけで除外せず、
  「textが空 かつ image attachmentも無い」ときのみ除外する(画像のみメッセージを落とさない)
- 画像は現在ターンだけでなく、履歴中の該当メッセージでも毎回再送する
  (DECISIONSの再送方針。CTX 81920前提で許容)
- system挿入・テンプレート展開・LLMパラメータ・stream中継・空応答防御・部分応答保存は
  現行のまま維持する(assistant応答は画像を持たないため空応答防御は不変)

### GET /:id/messages の拡張
- 各messageに attachments 配列を含める(要素: id, kind, mime, url。
  url は /api/uploads/image/:id)。画像を持たないメッセージは空配列
- 既存のレスポンス形 { conversation, messages } は壊さず、messages各要素へフィールド追加する
  (フロント015が履歴の画像を再表示するために使う)

## 5. やらないこと
- フロントエンド(添付ボタン・プレビュー・Blob表示・送信フロー):015で実装
- 画像以外(PDF/テキスト)の添付:後続タスク
- 画像のリサイズ・再エンコード・トークン量制御(再送方針は現状維持、最適化は将来候補)
- generate-title の変更(画像のみの先頭メッセージでタイトルが弱くなるのは許容。今回は触らない)
- 会話/メッセージ削除時の attachments・実ファイルのクリーンアップ(別タスク)
- 013で作ったアップロード/配信APIの仕様変更
- .env の変更

## 6. 完了条件
実LLM(textgen-webui経由)に接続し、curl等で確認する。
1. 013のPOSTで画像をアップロードしid取得 → POST /:id/chat に
   { content:"この画像に何が写っている?", attachment_ids:[id] } を送ると、
   画像内容に即した応答がdeltaでストリームされ done で終わる
   (textgen-webui経由のVision素通しを実地確認)
2. 該当attachments行の message_id が、保存されたuserメッセージのidに更新されている
3. GET /:id/messages のそのuserメッセージに attachments(id,kind,mime,url)が含まれる
4. 同じ会話で続けてテキストのみ送信 → 直前の画像を踏まえた応答になる。
   ログまたは一時的なリクエストキャプチャで、LLMへのリクエストに画像が再送されていることを確認
5. content空 + attachment_ids 1件の送信 → 400にならずVision応答が返る
6. 不正なattachment_id(他人所有/別会話/リンク済み/存在しない)を含む送信 → 400、
   userメッセージが保存されない(副作用なし)
7. リグレッション: attachment_idsなしの通常送信が従来どおり動く。content空+添付なしは400。
   空応答防御・中断時の部分応答保存が従来どおり動く
8. テストで作成した会話・メッセージ・attachments行・アップロード実ファイルを削除して完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する