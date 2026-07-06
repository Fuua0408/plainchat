# 018: フロント ファイル添付UI・画像との混在(合算4)

## 1. 目的
チャット画面からテキストファイル(txt/md/csv/json)を添付・送信し、履歴でも表示できる
フロントUIを実装する。015の画像添付UIを、ファイル対応と「画像+ファイル合計4」の混在管理へ
拡張する、フロントエンドのみのタスク。これでPhase 3 ②が完成する。

## 2. 対象
Phase 3 ②「ファイル添付(テキスト)の要約・QA」のフロント部。
DECISIONS.md「Phase 3 ② テキストファイル添付のスコープ確定」および「複数/混在(合計4に統合)」
(2026-07-05)に従う。

## 3. 前提・参照
- 013〜017完了済み。利用するAPI:
  - POST /api/uploads/file (FormData: conversation_id, file。Bearer必須) → { id, url, kind:'file', original_name, size }
    ※1リクエスト1ファイル。複数は数だけ呼ぶ。許可は txt/md/csv/json、1ファイル1MB上限(サーバ側で拒否)
  - POST /api/uploads/image (既存) → { id, url }(画像。kindは 'image')
  - POST /api/conversations/:id/chat の body は { content, attachment_ids }。
    content空でも attachment_ids があれば可。attachment_ids は image/file 混在の配列を受け付ける(017)
  - GET /api/conversations/:id/messages の各messageの attachments 配列は
    (id, kind, mime, url)。url は kind 別(image→/api/uploads/image/:id、file→/api/uploads/file/:id)(017)
  - GET /api/uploads/file/:id (Bearer必須) → 本文テキスト
- フロント現行構造(015):
  - public/js/api.js: uploadImage(convId,file)、fetchImageObjectUrl(url)、
    streamChat(convId, content, { attachment_ids, ...callbacks }) が実装済み
  - public/js/app.js: 添付選択・プレビュー・上限管理・アップロード〜送信フロー・
    履歴の画像復元・objectURL解放が画像向けに実装済み。handleSend が送信処理
  - 画像添付は「最大4枚」の定数で制御されている(本タスクでこの上限を合算4へ統合)
- 技術方針: ビルドなしの素のHTML/CSS/JS、CDNのみ(新規npm依存を追加しない)
- 添付上限は「画像+ファイルの合計4点」。015の画像専用4カウントは撤去し、合算に統合する
- ファイル本文表示はBearer必須のため、認証付きfetchで取得する(画像のBlob方式に倣う)
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### api.js
- uploadFile(conversationId, file): FormDataに conversation_id と file を入れて
  POST /api/uploads/file。{ id, url, kind, original_name, size } を返す(Bearer付与)
- ファイル本文取得ヘルパー: GET /api/uploads/file/:id を認証付きfetchで取得しテキストを返す
  (履歴表示で本文プレビューを出す場合に使用。画像の fetchImageObjectUrl に相当)

### 添付UI(index.html + css)
- 既存の画像添付ボタン/input を、ファイルも選べるように拡張する。実装は任意で、
  (a) 同じ添付ボタンで accept を画像+テキスト形式に広げる、または
  (b) ファイル用の入力を別途足す、のどちらでもよい。採用した方式を報告
  - ファイル入力の accept は .txt,.md,.csv,.json 相当(text/plain,text/markdown,text/csv,application/json)
- 送信前プレビュー: 画像はサムネイル、ファイルは「アイコン/種別+ファイル名(+サイズ)」の
  チップ表示。各要素に×(個別解除)。画像とファイルが混在して並ぶ
- 上限は画像+ファイルの合計4。超過選択は超過分を無視し、chatError等で通知
  (015の画像超過通知に倣う)

### 送信フロー(app.js handleSend)
- 送信可能条件を「テキスト非空 または 添付(画像/ファイル)が1つ以上」に更新
- 添付ありの手順(画像・ファイル混在対応):
  1. 会話未選択なら自動作成(既存)
  2. 添付を順に(または並行で)アップロード。画像は uploadImage、ファイルは uploadFile を使い、
     返った id を1つの attachment_ids 配列に集める。1つでも失敗したら中断し
     エラー表示(部分送信しない。015の方針を踏襲)
  3. ユーザーバブルをテキスト+添付(画像サムネイル/ファイルチップ)で即時表示。
     画像の即時表示は手元のローカルプレビュー(data URL)を流用してよい。
     ファイルはファイル名チップでよい(本文の即時表示は不要)
  4. streamChat(convId, text, { attachment_ids:[...混在ids], ...既存コールバック })
  5. 送信成功後に添付状態(画像・ファイル両方のプレビューと保持データ)をすべてクリア
- 受信中は添付ボタンも無効化(既存)。停止・エラー・中断時の既存挙動は維持
- 添付クリアのタイミングは015と同一(streamChat呼び出し前。中断リトライでの再リンク400回避のため)

### 履歴・再描画での表示
- renderMessages / appendMessageBubble を拡張し、message.attachments のうち
  kind='file' のものを「ファイルチップ(種別+ファイル名)」として表示する。
  画像(kind='image')の表示は015のまま
- ファイルチップは、クリックで本文プレビューを表示できると望ましい(任意)。
  実装する場合は上記の本文取得ヘッダで取得し、モーダルや展開領域にプレーンテキストで表示
  (textContentで描画。innerHTMLに本文を差し込まない)。実装可否は任意で、採用を報告
- objectURL の解放(画像)は015の仕組みを維持。ファイル本文取得でobjectURLを作る場合は
  同様にrevoke対象へ含める

## 5. やらないこと
- バックエンドの変更(013〜017で完結。不足を見つけたら実装せず報告)
- ドラッグ&ドロップ、クリップボード貼り付け(将来)
- PDF/docx/pptx/画像PDF・OCR(スコープ外)
- ファイル本文のクライアント側整形・シンタックスハイライト(プレーン表示で可)
- csv/jsonのテーブル描画等のリッチ表示
- 会話/メッセージ削除時の添付クリーンアップ(別タスク)
- npmフロント依存の追加(CDNのみ)
- .env の変更

## 6. 完了条件
ブラウザ(http://localhost:18091)で実LLMに接続して確認:
1. ファイル添付ボタンから .txt/.md/.csv/.json を選択 → ファイルチップが表示され、×で解除できる
2. ファイル+テキストを送信 → ユーザーバブルにチップ+テキストが出て、内容に即した応答が返る
3. 画像とファイルを混在して添付・送信 → 双方が即時表示され、双方を踏まえた応答が返る
4. 添付を合計5つ選ぼうとすると4で頭打ちになり、超過分が無視され通知される
   (画像2+ファイル3など、画像とファイルを跨いだ合算で4になること)
5. 会話を切り替えて戻る/リロードすると、履歴のファイルチップと画像が再表示される
   (画像URL・ファイルURLにトークンが載っていないことを開発者ツールで確認)
6. アップロード失敗時(例: 1MB超ファイルやサーバ一時停止)にエラー表示され、
   部分送信されず、アプリが固まらない
7. 受信中は送信が停止ボタンに切り替わり添付ボタンも無効。停止で中断できる
8. ファイル名に <img onerror=...> 等を含めてもスクリプトが実行されない
   (チップ・本文プレビューともDOM生成/textContentで、innerHTMLに値を差し込まない)
9. 会話切り替えを繰り返してもobjectURLがrevokeされ、メモリリークしない(確認できる範囲で)
10. コンソールに未処理エラーがない
11. テストで作成した会話・画像・ファイルを削除して完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する