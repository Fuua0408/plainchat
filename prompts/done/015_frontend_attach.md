# 015: フロント添付UI・画像表示(Vision、複数画像対応)

## 1. 目的
チャット画面から画像を複数添付して送信し、Vision応答を得られるフロントUIを実装する。
013/014のバックエンドAPIに接続する、フロントエンドのみのタスク。

## 2. 対象
Phase 3「画像アップロード→Vision対応」のフロント部。
DECISIONS.md「Phase 3の着手順とスコープ」「画像添付まわりの設計判断」
「画像添付は複数対応(上限つき・フロント方針)」(2026-07-05)に従う。

## 3. 前提・参照
- 013/014完了済み。利用するAPI:
  - POST /api/uploads/image (FormData: conversation_id, image。Bearer必須) → { id, url }
    ※1リクエスト1画像。複数枚は画像の数だけ呼ぶ
  - GET  /api/uploads/image/:id (Bearer必須) → 画像バイト(Cache-Control: no-store)
  - POST /api/conversations/:id/chat の body は { content, attachment_ids }。
    content は空でも attachment_ids があれば可。attachment_ids は複数idの配列を受け付ける
  - GET  /api/conversations/:id/messages の各messageに attachments 配列
    (id, kind, mime, url)が含まれる(複数あり得る)
- フロント現行構造:
  - public/js/api.js: streamChat(convId, content, {onDelta,onDone,onError,onAbort,signal}) が
    body {content} を送る。fetchラッパーでBearer付与
  - public/js/app.js: handleSend(e) が送信処理(未選択時は会話自動作成 →
    appendMessageBubble('user',text) → streamChat)。renderMessages(messages) が
    履歴描画で appendMessageBubble(role,content) を呼ぶ。setBubbleContent は
    user=textContent / assistant=marked+DOMPurify
  - index.html: 入力欄は chatForm / chatInput(textarea) / sendBtn。描画先は messageList
- 技術方針: ビルドなしの素のHTML/CSS/JS、CDNのみ(新規npm依存を追加しない)
- 表示認証はBlob方式: 画像URLはBearer必須のため <img src> 直指定は不可。
  認証付きfetchでBlobを取得し objectURL を <img> に使う。URLクエリにトークンを載せない
- 画像添付の上限は1メッセージ4枚(フロントの定数として定義し、変更しやすくする)
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### api.js
- uploadImage(conversationId, file): FormDataに conversation_id と image を入れて
  POST /api/uploads/image。{ id, url } を返す(Bearer付与)
- streamChat に attachment_ids(省略可の配列)を追加し、body を
  { content, attachment_ids } にする。未指定時は従来どおり動く
- fetchImageObjectUrl(url): 認証付きfetchで画像を取得し URL.createObjectURL で
  objectURL を返すヘルパー

### 添付UI(index.html + css)
- 入力欄付近に添付ボタン(📎等)と、accept="image/*" かつ multiple の hidden file input を追加
- 選択した画像を送信前プレビューとして横並びのサムネイル群で表示。各サムネイルに×(個別解除)
- 上限(4枚)を超える選択は、超過分を無視するかメッセージで知らせる(実装は任意、
  採用した挙動を報告)。既に選択済みと合わせて上限を超えないこと
- レイアウトを崩さず、ダーク/ライト両テーマで見えること

### 送信フロー(app.js handleSend)
- 送信可能条件を「テキストが非空 または 画像が1枚以上添付」に変更(両方空なら何もしない)
- 画像添付ありの手順:
  1. 会話未選択なら従来どおり自動作成
  2. 選択画像を順に(または並行で)uploadImage し、id を配列に集める。
     1枚でもアップロード失敗したら、エラー表示して送信を中断する(部分送信はしない)
  3. ユーザーバブルをテキスト+画像サムネイル(複数)で即時表示
     (即時表示は手元のローカルプレビュー[FileReaderのdata URL]を流用してよい。追加fetch不要)
  4. streamChat(convId, text, { attachment_ids:[...ids], ...既存コールバック })
  5. 送信成功後に添付状態(プレビュー・保持File群)をすべてクリア
- 受信中は添付ボタンも無効化。停止・エラー・中断時の既存挙動は維持

### 履歴・再描画での画像表示
- renderMessages / appendMessageBubble を拡張し、messageに attachments があれば
  その全画像を表示する。履歴ロード時は手元にファイルが無いため fetchImageObjectUrl で
  objectURL を取得して各 <img> に設定する
- 画像は <img> 要素をDOM生成して追加する(innerHTMLに値を差し込まない。既存のXSS方針を維持)
- objectURLの解放: messageList をクリア/再描画する箇所(会話切り替え・onAbort時の再取得等)で、
  それまでに生成した objectURL をすべて URL.revokeObjectURL で解放し、リークさせない

## 5. やらないこと
- バックエンドの変更(013/014のAPIで完結。不足を見つけたら実装せず報告)
- ドラッグ&ドロップ、クリップボード貼り付け(将来)
- 画像以外(PDF/テキスト)の添付(後続タスク)
- 画像のクライアント側リサイズ・圧縮
- 会話/メッセージ削除時のattachmentクリーンアップ(別タスク)
- npmフロント依存の追加(CDNのみ)
- .env の変更

## 6. 完了条件
ブラウザ(http://localhost:18091)で実LLMに接続して確認:
1. 添付ボタンから画像を複数選択 → サムネイルが並び、各×で個別解除できる。
   上限(4枚)を超える選択が抑止される
2. 画像2枚以上+テキストを送信 → ユーザーバブルに全サムネイル+テキストが出て、
   Vision応答が逐次表示される。応答が複数画像の内容を踏まえている
   (textgen-webui経由での複数画像素通しの実地確認)
3. テキスト空+画像のみ(複数)で送信できる
4. 会話を切り替えて戻る/リロードで、履歴の複数画像がBlob経由で再表示される
   (画像URLにトークンが載っていないことを開発者ツールで確認)
5. 複数アップロードの途中で1枚失敗させた場合(例: 一時的にサーバー停止)、
   エラー表示され送信が中断し、部分送信されない → 復帰確認
6. 受信中は送信が停止ボタンに切り替わり添付ボタンも無効。停止で中断できる
   (このとき「初トークン後の中断→部分応答保存」も併せて確認する)
7. <img onerror=...> のようなファイル名/入力でもスクリプトが実行されない
   (srcに objectURL / data URL のみを設定していることの確認)
8. 会話切り替えを繰り返しても objectURL が revoke され、メモリリークしない(確認できる範囲で)
9. コンソールに未処理エラーがない
10. テストで作成した会話・画像を削除して完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する