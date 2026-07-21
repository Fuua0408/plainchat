# 039: WEB検索等の出典表示 — tool_invocationsの永続化+折りたたみ表示

## 1. 目的
MCPツール呼び出し(tool_call/tool_result)の往復を message に紐づけて永続化し、assistantメッセージ
下の折りたたみセクションで実際にツールが返した生データを確認できるようにする。モデルの自己申告(本文
要約)ではなく、ツールの実際の戻り値を検証可能にする。

## 2. 対象
Phase 4「改善フェーズ」。DECISIONS.md「2026-07(039): WEB検索の出典表示(②)— 設計確定」に従う。

## 3. 前提・参照
- 025完了: src/routes/chat.js のツール呼び出しループ(multi-round)。現状は「往復はターン内一時利用で
  DB非保存」(user+assistantのみ保存)。tool_call/tool_result はSSEで名前とstatusのみ通知
  ({ name: toolName } / { name: toolName, status })
- chat.js には saveAssistantMessage(text) ヘルパがあり、ストリーム正常終了・タイムアウト/切断による
  部分応答保存など、アシスタントメッセージを保存する全経路がここに集約されている
  (最初のトークン前の失敗時はこの関数は呼ばれず、メッセージ自体を保存しない=既存方針)
- 013(attachments)のパターンを踏襲する:
  - スキーマは attachments と同様、conversation_id / user_id を持たせて所有者スコープを直接引ける形にする
  - conversations.js の GET /:id/messages は attachmentsByMessage という「message_id→配列」のMapを
    作って各messageにマージする書き方をしている。tool_invocations も同型のパターンで実装する
- mcp-searxng(ihor-sokoliuk/mcp-searxng)の searxng_web_search は、検索結果ごとに
  「Title: .../Description: .../URL: .../Relevance Score: 0.xxx」の4行ブロックを空行区切りで連結した
  単一テキストを返す(src/mcp/client.js の extractTextContent() を通過後、PlainChat内では既に1本の
  文字列になっている)
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) DBスキーマ(src/db.js、冪等追加)
CREATE TABLE IF NOT EXISTS tool_invocations:
- id INTEGER PRIMARY KEY AUTOINCREMENT
- message_id INTEGER NOT NULL       -- 紐づくassistantメッセージ
- conversation_id INTEGER NOT NULL  -- attachmentsに倣い直接持たせる(所有者スコープ確認を簡潔にするため)
- user_id INTEGER NOT NULL
- round_index INTEGER NOT NULL      -- そのターン内でのツールラウンド順(0始まり)
- tool_name TEXT NOT NULL           -- 例 searxng__searxng_web_search
- arguments_json TEXT NOT NULL      -- モデルが渡した引数(JSON文字列。パース失敗時は生文字列でも可)
- status TEXT NOT NULL              -- 'success' | 'error'
- result_text TEXT NOT NULL         -- ツールの戻り値(生テキスト。整形・解析はしない)
- created_at TEXT NOT NULL DEFAULT (datetime('now'))

外部キー・削除連動は attachments テーブルの既存実装(会話削除時にどう消えるか)を確認し、同じ方式に揃える
こと。既存DB起動時に冪等作成され、既存テーブル・データ無傷であること。

### (b) chat.jsでの記録(multi-roundループ内)
- ループ開始前に空配列 toolInvocationsBuffer を用意する
- 各ツール実行(handler呼び出し)の直後、成功/失敗いずれの場合も
  { round_index: roundsUsed, tool_name, arguments_json, status, result_text: resultContent }
  を toolInvocationsBuffer に積む(現状の tool_call/tool_result SSE送出はそのまま維持)
- saveAssistantMessage(text) が実際にメッセージを保存した(=呼ばれた)経路でのみ、返ってきた
  messageId に対して toolInvocationsBuffer の内容を一括INSERT(conversation_id=req.params.id,
  user_id=req.user.id を付与)。saveAssistantMessage が一度も呼ばれない経路(最初のトークン前の失敗)
  ではtoolInvocationsBufferを保存せず捨てる(既存の「何も保存しない」方針と整合させる)
- 呼び出し箇所がchat.js内に複数ある場合(正常終了/タイムアウト/切断時の部分保存等)、
  すべてで同じ挿入処理が効くようにする(共通関数化を推奨)

### (c) SSE doneイベントの拡張(chat.js)
- 既存の done イベント(messageId を含む)に tool_invocations 配列を追加する:
  { messageId, tool_invocations: [{ round_index, tool_name, arguments_json, status, result_text }, ...] }
  (toolInvocationsBufferが空ならから配列でよい)
- 中断/エラー系のイベント(abort等)の扱いは変更しない。正常完了時のdoneイベントのみ拡張する

### (d) GET /api/conversations/:id/messages の拡張(src/routes/conversations.js)
- attachmentsByMessage と同型のMap構築で、messages.id をキーに tool_invocations を取得し、
  各messageに tool_invocations: [...]( round_index 昇順)を追加する。無ければ空配列
- 既存のレスポンス形・他フィールドは変更しない

### (e) フロントエンド表示(public/js/app.js + 対応CSS)
- assistantメッセージバブルの下に、tool_invocations が1件以上あるときだけ折りたたみセクションを追加する
  - デフォルト閉じ。ヘッダクリックで開閉(例: 「🔧 ツール呼び出し(N件)」のようなラベル)
  - 展開すると round_index 順に各呼び出しを表示: tool_name、引数(整形済みJSON)、status、結果
  - 結果表示は tool_name→パーサー のルックアップを用意し、`searxng__searxng_web_search` に一致する
    場合のみ result_text を「Title: / Description: / URL: / Relevance Score:」の空行区切りブロックとして
    パースし、タイトル(URLへのリンク)+説明+スコアのカード列で表示する。パースに失敗した場合・
    未知のtool_nameの場合は result_text をそのまま<pre>等で表示する(フォールバック必須)
  - status が 'error' の場合は視覚的に区別する(色・アイコン等、既存のsetChatError等の配色に揃える)
- 表示元は2経路:
  1. 送信直後: SSEのdoneイベントに含まれる tool_invocations をそのまま使い即時描画
  2. 履歴再読込時: GET /:id/messages が返す message.tool_invocations を使う
  - 両経路で同じ整形・折りたたみ描画関数を共用すること(重複実装しない)
- ダークモード・モバイル幅(既存 @media(max-width:768px))双方で崩れないこと
- app.js のみ ?v=039 に更新(index.htmlのscriptタグ)

## 5. やらないこと
- 025 のツール呼び出しループ本体(handler呼び出し・エラー処理・上限tool_choice:'none'等)の変更。
  今回追加するのは「記録して保存する」処理のみ
- searxng以外のMCPツール向けパーサーの作り込み(未知ツールはraw textフォールバックで十分。
  将来ツールが増えたら都度パーサーを追加する運用でよい)
- バックエンドでのresult_textの解析・構造化・正規化(すべてフロント側の表示専用ロジックに閉じる)
- tool_invocationsの編集・削除UI、ツール往復の再実行機能
- 会話削除以外の個別メッセージ削除・tool_invocations単体の削除API
- RAG・履歴窓化+要約など他の未着手項目
- .env の変更

## 6. 完了条件
(実DBを手動バックアップの上で確認。検証用の一時変更は最後に元へ戻すこと)
1. WEB検索を要するプロンプトを送ると、SSEのdoneイベントに tool_invocations が含まれ、送信直後の
   画面に折りたたみ(デフォルト閉じ)が表示される。展開するとsearxngの結果がカード表示される
2. DBを直接確認し、tool_invocations に該当行が message_id/conversation_id/user_id/round_index/
   tool_name/arguments_json/status/result_text とともに保存されている(node -e / better-sqlite3)
3. ツールを使わない通常の応答では tool_invocations が0件で、折りたたみセクション自体が表示されない
4. 会話を再読み込み(別会話に切り替えてから戻る、またはリロード)しても、保存済みの出典表示が
   同じ内容で再現される(GET /:id/messages 経由)
5. ツール実行がエラーになるケース(例: handlerを一時的にthrowさせる)でも記録され、statusが
   'error'として視覚的に区別されて表示される。確認後コードを戻す
6. 未知のtool_name(例: 一時的にtool_nameを書き換えて検証)ではraw textのフォールバック表示になり、
   JSエラーにならない
7. モバイル幅(375px程度)・ダークモード両方で表示崩れがない
8. 会話削除時にtool_invocationsも道連れで消える(孤児レコードが残らない)ことを確認
9. 検証用に変更したコード・DBデータをすべて元に戻し、一時バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する