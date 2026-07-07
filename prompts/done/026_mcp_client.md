# 026: MCPクライアント(第一増分・mcp-searxng を stdio 接続)

## 1. 目的
PlainChat に MCP クライアントを導入し、既製の mcp-searxng を stdio で起動、tools/list で発見した
ツールをレジストリに登録して 025 のループから実 tools/call を呼べるようにする。実 SearXNG 検索が
ループを一周し最終回答に反映されることを実証する第一増分。

## 2. 対象
Phase 4 / 026(MCPクライアント第一増分)。DECISIONS.md「MCPクライアントは公式SDKで実装・段階導入・
builtin廃止(026/027)」に従う。JSON設定ファイル一般化・複数サーバー対応・builtin撤去は 027 で扱う。

## 3. 前提・参照
- 024完了: registry(register / getRegisteredTools / getToolByName / buildOpenAIToolSchemas /
  getEnabledToolSchemas / syncToolsToDb)、tools テーブル(origin 付き・冪等・起動時ミラー同期)
- 025完了: src/routes/chat.js のツール呼び出しループ。getEnabledToolSchemas で tools 送信、
  getToolByName(name).handler(args) でディスパッチ、tool_call/tool_result SSE、上限時 tool_choice:'none'、
  ツール失敗はループ継続、ツール往復は非保存(user+assistant のみ保存)
- package.json は "type": "commonjs"(PlainChat は CommonJS=require)。既存依存は
  express / better-sqlite3 / bcrypt / jsonwebtoken / multer / dotenv。Node は --watch 使用のため 18+ 想定
- 公式 SDK @modelcontextprotocol/sdk(v1.x, MIT)。peer dependency に zod。SDK は ESM 中心のため、
  CommonJS の PlainChat からは動的 import() で読み込む(アプリ全体の ESM 化はしない)
- 検索は既製 mcp-searxng を利用。接続先 SearXNG は .env の DEBUG_searxng を使う
  (実値は .env のみ。いかなるファイルにもハードコード/コミットしない)
- 実行環境は Windows。StdioClientTransport から npx/バイナリを起動する際の .cmd・シェルの扱いに注意
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) 依存追加
- @modelcontextprotocol/sdk と zod を導入。mcp-searxng も PlainChat の依存として導入し、実行時 npx の
  都度解決/ダウンロードを避ける(インストール済みエントリを起動する)。package.json に反映する

### (b) MCP クライアント(src/mcp/ 新規。例 src/mcp/client.js)
- CommonJS から動的 import() で SDK を読む(例:
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'); )
- 1 サーバー(ラベル例 'searxng')を stdio で起動する薄いラッパを提供(connect / listTools /
  callTool(mcpToolName, args) / close):
  - 起動 command/args は mcp-searxng のインストール済みエントリを指す。Windows の npx .cmd 問題を
    避けるため、プラットフォーム差を吸収する(例: node で bin を直接起動、または shell/.cmd 対応)
  - 子プロセスの env に SEARXNG_URL = process.env.DEBUG_searxng を渡す(PlainChat 側の変数名を
    mcp-searxng の期待する変数名へマッピング)。末尾スラッシュ等は必要なら正規化する
- 接続は起動時に一度確立。接続失敗(spawn 不可・DEBUG_searxng 未設定・サーバー無応答)は
  例外でサーバーを落とさず、ログを残して「searxng ツール無し」で続行する

### (c) 登録アダプタ(src/mcp/ 内)
- 接続後 listTools() の各ツールを PlainChat のツール定義へ変換し registry.register() する:
  - name = `<serverLabel>__<mcpToolName>`(例 searxng__searxng_web_search)。名前空間 prefix を一律付与
  - description = MCP ツールの説明。parameters = MCP ツールの inputSchema(JSON Schema)をそのまま使う
  - origin = `mcp:<serverLabel>`(例 mcp:searxng)
  - handler = async (args) => 対応する MCP ツールへ callTool を転送し、結果の content(text ブロック)を
    文字列に畳んで返す。MCP 側のエラー(isError / 例外)は throw し、025 のループにエラーとして扱わせる
- prefix→(serverLabel, mcpToolName)の対応は handler クロージャに閉じ込める(別テーブル不要)

### (d) 起動シーケンス(src/index.js)
- 順序を保証する: builtin 読み込み(src/tools)→ MCP 接続+登録 → syncToolsToDb(db)。
  MCP 登録は tools/list が非同期のため起動処理を async 化し、MCP 接続完了後にミラー同期を呼ぶ
- MCP 接続失敗時もミラー同期・サーバー起動は継続する(searxng ツールが registry に無いだけ。
  024 仕様どおり台帳の既存 searxng 行は残るが getEnabledToolSchemas には出ない)

### (e) シャットダウン
- SIGINT / SIGTERM 時に MCP クライアントを close し、mcp-searxng 子プロセスを終了させる
  (孤児プロセスを残さない)

### (f) 設定(.env / .env.example)
- .env.example に DEBUG_searxng= のプレースホルダを追記(実値は書かない)。
  簡易フラグ(例 MCP_SEARXNG_ENABLED、既定 true)を設けるなら .env.example にプレースホルダ追加
- .env(実値)は変更しない(DEBUG_searxng はユーザーが定義済み)

## 5. やらないこと
- 025 のループ本体・024 の registry プリミティブ(register / sync 等)の変更
  (026 は「MCP 由来ツールを registry に流し込む」側。既存の消費経路は不変に保つ)
- mcpServers 風 JSON 設定ファイル・複数 MCP サーバー対応(027)
- builtin 撤去(get_server_time は暫定存置。撤去は 027)
- MCP の prompts / resources の取得・利用(将来。026 は tools のみ)
- DB スキーマ/ロール変更、ツール往復の DB 保存(非保存方針は 025 のまま)
- Streamable HTTP / SSE トランスポート(初手は stdio のみ)
- 実 SearXNG アドレス等のハードコード/コミット、.env の変更、自ホストの IP/ホスト名のコミット
- アプリ全体の ESM 化(SDK は動的 import() で読む)

## 6. 完了条件
（実 DB を手動バックアップの上で確認。検証用の一時変更は最後に元へ戻す。.env はコミットしない）
1. npm install で SDK / zod / mcp-searxng が入り、npm start で起動。MCP クライアントが mcp-searxng を
   起動・接続し、listTools が 1 件以上返す
2. 起動後、tools テーブルに searxng 由来ツールが `<label>__<tool>` の name・origin='mcp:searxng' で
   登録されている(node -e / better-sqlite3 で確認)。get_server_time も従来どおり存在(暫定)
3. getEnabledToolSchemas(db) に searxng ツールが OpenAI 形式で含まれ、origin は含まれない
4. 実検索: Web 検索を要する質問(例「◯◯の最新情報を検索して要点を教えて」)を送ると、モデルが
   searxng ツールを呼び、025 ループが MCP tools/call を実行、実 SearXNG の結果が最終回答に反映される。
   SSE に tool_call / tool_result(success)が流れ、ターン後の messages は user+assistant のみ
5. 接続失敗の退避: DEBUG_searxng を一時的に不正値にして起動 → サーバーは起動し、searxng ツールは
   registry / schemas に出ず、通常チャット・get_server_time は正常。確認後 .env を元に戻す
6. シャットダウン: サーバー停止で mcp-searxng 子プロセスが残らない(プロセス一覧で確認)
7. CommonJS からの SDK 動的 import() が正しく動作する(起動時エラーなし)
8. 検証用の一時変更をすべて元に戻し、DB バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する