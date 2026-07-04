# 005: LLM連携(SSEストリーミング)の実装

## 1. 目的
llama.cpp serverへのストリーミング接続を実装し、ユーザー発話の保存から
アシスタント応答のトークン逐次中継・保存までを1エンドポイントで実現する。

## 2. 対象
Phase 1「llama.cpp serverへのストリーミング接続(トークン逐次表示)」
「会話履歴のDB永続化」(書き込み側)

## 3. 前提・参照
- 001〜004完了済み(認証、会話CRUD、messagesテーブルあり)
- 参照: .base/src/routes/llm.js — .envからの設定読み込み、パラメータ組み立て、
  エラーハンドリング(タイムアウト/401/接続不可)のパターンを踏襲する。
  ただし同ファイルは非ストリーミング実装のため、SSE中継部分は新規実装(DECISIONS.md参照)
- [TEMP DEBUG] とマークされたログブロックは移植しない
- llama.cpp serverはOpenAI互換の /v1/chat/completions を提供し、
  stream: true でSSE(data: {...} 行、終端 data: [DONE])を返す
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### src/routes/chat.js(新規)
POST /api/conversations/:id/chat(authMiddleware適用)

処理フロー:
1. 所有者チェック(自分の会話でなければ404。004と同じ方針)
2. body: { content } を検証(必須、空文字不可)
3. ユーザー発話を messages に保存(role='user')
4. この会話の全メッセージをid昇順で取得し、LLMへのmessages配列を構築
5. llama.cpp serverへ stream: true でリクエスト
6. レスポンスをSSEとしてクライアントへ中継:
   - Content-Type: text/event-stream、Cache-Control: no-store
   - トークン受信ごとに event: delta / data: {"text":"..."} を送出
   - 完了時に event: done / data: {"messageId": <保存したID>} を送出
7. ストリーム完了後、全文を messages に保存(role='assistant')し、
   conversations.updated_at を更新

### パラメータ・設定(.base/src/routes/llm.js のパターンを踏襲)
- LLM_ENDPOINT, LLM_API_KEY, LLM_MAX_TOKENS, LLM_TEMP, LLM_TOP_P,
  LLM_TOP_K, LLM_REP_PENALTY, LLM_TIMEOUT を .env から読む(すべて既存)
- LLM_ENDPOINT 未設定時は 503 { error: ... }

### エラー・中断時の扱い
- 最初のトークン受信前にLLMエラー/接続不可/タイムアウト:
  アシスタントメッセージは保存せず、SSE上で event: error / data: {"error":"..."}
  を送出して終了(ユーザー発話は保存済みのまま残す)
- ストリーム途中でのLLMエラーまたはクライアント切断(req/resのcloseを監視):
  それまでに受信した部分応答を messages に保存して終了
- LLM側への接続は AbortController で確実に切断する(クライアント切断時のリソースリーク防止)

### src/index.js の変更
- ルート登録

## 5. やらないこと
- フロントエンドの実装(006)
- 会話タイトル自動生成(Phase 2)
- system プロンプト設定機能(Phase 2。今回はsystemメッセージなしで送る)
- Vision/画像対応(Phase 3)
- 長い履歴のトリミング・要約(CTX 81920の範囲では当面不要)
- .env の変更・実値の記入

## 6. 完了条件
実LLMサーバー(.envのLLM_ENDPOINT)に接続して確認:
1. curl -N で POST /api/conversations/:id/chat → delta イベントが
   逐次届き、done で終わることを確認
2. 完了後、GET /:id/messages で user/assistant の両方が保存されている
3. 2往復目を送り、履歴を踏まえた応答になっている(文脈が通じている)
4. 空contentで400、他人/存在しない会話で404、トークンなしで401
5. LLM_ENDPOINT を無効な値にして再起動 → 接続不可時に event: error が
   返り、アシスタントメッセージが保存されないこと → 確認後 .env を元に戻す
   (この確認のための .env 一時変更は許可する)
6. curl を途中で Ctrl+C し、部分応答が messages に保存されることを確認
7. テストで作成した会話・メッセージを削除して確認完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する