# 017: チャットへのファイル注入(バックエンド)

## 1. 目的
テキスト系ファイル添付(kind='file')の本文を、チャットのLLMリクエストにテキストとして
注入する。014の画像マルチモーダル注入を、ファイル本文注入および画像+ファイル混在へ拡張する、
バックエンドのみのタスク。

## 2. 対象
Phase 3 ②「ファイル添付(テキスト)の要約・QA」のチャット注入部。
DECISIONS.md「Phase 3 ② テキストファイル添付のスコープ確定」(2026-07-05)に従う。
フロント(018)には手を入れない。

## 3. 前提・参照
- 013/014/015/016完了済み。
  - 014: chat.js は body { content, attachment_ids } を受け、userメッセージ保存後に
    attachmentを紐付け、履歴の画像attachmentを base64の image_url 要素にして
    マルチモーダルcontentを構築し、履歴も毎ターン再送する。attachment_ids検証は
    「自分の所有・この会話・未リンク・kind='image'」。履歴の除外規則は
    「textが空 かつ image添付も無い場合のみ除外」
  - 016: kind='file' のテキストファイル(txt/md/csv/json、UTF-8、1MB上限)を
    POST /api/uploads/file で受け、GET /api/uploads/file/:id で配信。本文は元ファイルを
    そのまま保持し、src/attachmentStorage.js の resolveAttachmentFilePath(attachment) で
    絶対パス解決 → fs.readFileSync(path,'utf8') で取得できる
  - conversations.js の GET /:id/messages は各messageに attachments 配列
    (id, kind, mime, url)を含める(014で追加)
- 注入方針(DECISIONS):本文は履歴に残る限り毎ターン再注入。注入は1ファイルあたり
  最大40000文字とし、超過は末尾を切り詰めて省略を明示。csv/json は整形せず生テキストで注入
- 認可・除外規則・空応答防御(009)・部分応答保存・system挿入/テンプレート展開は014の方針を維持
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### attachment_ids 検証の拡張(chat.js)
- 014の検証条件のうち kind を 'image' 限定から kind IN ('image','file') に広げる。
  他条件(自分の所有・この会話・未リンク message_id IS NULL)は不変
- content空でも attachment_ids が1件以上あれば許可する既存挙動は維持
  (画像のみ・ファイルのみ・混在のいずれでも成立)

### 本文の取得と切り詰め
- kind='file' の attachment は resolveAttachmentFilePath + fs.readFileSync(path,'utf8') で本文取得
- 1ファイルあたり40000文字を上限に切り詰める。超過時は先頭40000文字を採用し、末尾に
  切り詰めた事実と元文字数が分かる一文を付ける(文言は任意)
- 読み取り失敗(ファイル欠損等)はそのファイルを注入からスキップしてリクエストは継続する
  (致命エラーにしない。ログに残す)

### LLMへのcontent構築(chat.js、014の拡張)
- 各メッセージで、userテキストと、そのメッセージに紐づく kind='file' の本文を1つのテキストに
  まとめる。ファイルごとにファイル名ヘッダで区切る
  (例:userテキストの後に、各ファイルを「[添付ファイル: {original_name}]\n{本文}」で連結)
- そのメッセージに画像があれば、014同様 content を配列にし、先頭に上記まとめテキスト
  ({type:'text'})、続けて各画像({type:'image_url'})を並べる
- 画像が無ければ content は文字列(まとめテキスト)でよい(014の「画像がある時のみ配列」を踏襲)
- 除外規則を更新:「textが空 かつ image添付も file添付も無い場合のみ」履歴から除外する
- 画像・ファイルとも履歴に残る限り毎ターン再注入する(再読込・再構築)

### GET /:id/messages の url を kind 別に(conversations.js)
- 各 attachment の url を kind に応じて出し分ける:
  kind='image' → /api/uploads/image/:id、kind='file' → /api/uploads/file/:id
  (014で image 固定になっている場合は kind 別に修正)。
  レスポンス形({ conversation, messages })は壊さない

## 5. やらないこと
- フロントエンド(添付UI・合算4制御・表示):018
- 注入テキストの整形・要約・csv/jsonのパース(生テキストのまま)
- メッセージ/会話全体でのトークン予算管理・古い添付の間引き(Phase 4候補)
- 画像base64注入ロジックの仕様変更(014のまま流用)
- アップロード/配信API(013/016)の仕様変更
- 会話/メッセージ削除時のクリーンアップ(別タスク)
- .env の変更

## 6. 完了条件
実LLM(textgen-webui経由)に接続し、curl等で確認:
1. .txt/.csv 等を016のAPIでアップロードしid取得 → POST /:id/chat に
   { content:"このファイルを要約して", attachment_ids:[fileId] } → 内容に即した応答が返る
2. 同じ会話で続けてテキストのみ送信 → 直前のファイル内容を踏まえた応答になる
   (ログ/キャプチャで、LLMリクエストに本文が再注入されていることを確認)
3. 画像+ファイルを1メッセージに混在({ attachment_ids:[imgId, fileId] })で送信 →
   双方を踏まえた応答(混在content構築の確認)
4. content空+ファイルのみ、content空+画像のみ、いずれも400にならず応答が返る
5. 40000文字超のファイル → 応答が返り、LLMリクエスト上で本文が40000文字に切り詰められ
   省略明示が付いていることをログ/キャプチャで確認
6. 不正なattachment_id(他人所有/別会話/リンク済み/存在しない、image・file両方)→ 400、
   userメッセージ非保存(副作用なし)
7. GET /:id/messages で、file添付の url が /api/uploads/file/:id、image添付の url が
   /api/uploads/image/:id になっている
8. リグレッション:画像のみ送信(014)・テキストのみ送信(005)・空応答防御(009)・
   中断時の部分応答保存が従来どおり動く
9. テストで作成した会話・メッセージ・attachments・アップロード実ファイルを削除して完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する