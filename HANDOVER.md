# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯・理由は DECISIONS.md を参照(このファイルは「今どこにいるか」に絞る)。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名/トークン等)はコミット禁止

## 現在地(2026-07 / 032完了時点)
- **フェーズ**: Phase 4(WEB検索 / RAG / ツール呼び出し)。**MCP化は一区切り(032完了)し、実運用可能な状態**。
  Phase 1〜3 完了済み。RAG は未着手
- **使える機能**:
  - WEB検索: SearXNG を MCP(stdio, 既製 mcp-searxng)経由で consume
  - NookResonance 連携: キャラクター性格取得を MCP(HTTP/Streamable HTTP, 認証あり)経由で consume
  - ツールは登録型で MCP のみが登録源(builtin は 032 で撤去)。DB(mcp_servers)が設定の唯一の源
  - 管理者向け MCP 設定画面(追加/編集/削除/有効切替/再接続)。シークレットは封筒暗号で DB 格納
- **アーキテクチャの芯(詳細は DECISIONS)**:
  - ツール呼び出しは chat.js の multi-round ループ。tools は登録型(registry)+DB台帳(tools)。
    往復はターン内一時利用でDB非保存。制御 env: TOOLS_ENABLED / TOOLS_MAX_ROUNDS
  - MCP は「接続情報を DB に持つ HTTP 型」が主役、「ローカルに実体を持つ stdio 型」が脇役。
    登録源は origin='mcp:<label>'、LLM 向けツール名は <label>__<tool> で名前空間化
  - シークレット(env/headers)は AES-256-GCM 封筒暗号(鍵は .env の SECRET_ENC_KEY)。DBには暗号文のみ

- **直近の完了(024〜032。詳細な判断は DECISIONS 参照)**:
  - 024 ツール基盤(登録型 registry + DB tools 台帳 + origin + 起動時ミラー同期)
  - 025 ツール呼び出しループ(chat.js multi-round化。tool_call/tool_result SSE・上限 tool_choice:'none'・
    失敗はループ継続・往復は非保存)
  - 026 MCPクライアント第一増分(stdio、mcp-searxng を子プロセス起動して接続)
  - 027 設定ソース抽象化 loadMcpServers() + 複数サーバー対応
  - 028a mcp_servers テーブル + 封筒暗号(env/headers 別カラム)+ 鍵未設定退避 + 後方互換seed
  - 029 MCP設定UI(管理者ゲート・HTTP自由入力/stdioカタログ選択・暗号化格納・マスク)
  - 030 HTTPトランスポート対応(StreamableHTTPClientTransport・退避=timeout/401・明示リロード)。
    実 NookResonance 接続と get_character_profile 登録を実証
  - 031 [是正] reasoning_content フォールバック(content皆無時のみ思考タグ除去して本文採用)
  - 032 builtin撤去 + sync契約見直し(登録源をMCPのみに一本化。孤児toolsは接続成功源から消えた分だけ
    enabled=0 無効化。後方互換seed・DEBUG_searxng依存を撤去 = DBが唯一の源)

- **次のタスク**:
  - (安定性・宿題) クラッシュ時の MCP 子プロセス孤児化の対処 ← 次に着手予定
  - 033 既定引数機構(MCPツールにサーバー既定引数=例 user_id を持たせ handler が注入。
    029設定画面に欄追加・mcp_servers にカラム追加。NookResonance 連携を実用レベルに)

- **未決/宿題**:
  - 履歴窓化+要約: chat.js は全履歴を無制限再送しており長会話でプロンプトが肥大。直近Nターン/トークン予算で
    打ち切り+要約に畳む改修が必要(NookResonance の character/affinity 等の概念は持ち込まない)。別トラック
  - クラッシュ時の子プロセス後始末: Node が正常シャットダウン経路(SIGTERM→closeMcp)を通らず落ちると
    MCP(stdio)子プロセスが孤児化。Windows のシグナル制約(taskkill /F 必須)と相まって node.exe が溜まる。
    app.listen error 捕捉・uncaughtException/unhandledRejection での closeMcp・子プロセス生存連動 等で対処予定
  - RAG: 未着手(embeddings/ベクタストア。同じ registry/ループ/LLM契約の上に載る想定)

- **インフラ/既知の運用注意**:
  - LLM: n_ctx=81920 / LLM_MAX_TOKENS=32768(実.env)。textgen-webui が llama.cpp を内部起動(2段構成)、
    extra-flags に `--reasoning-budget 6000 --reasoning-budget-message "..."`(空応答対策)
  - fattn 回避: llama.cpp fattn.cu CUDA fatal error(Gemma4+fattn、Issue #24440/#24324系)を
    `--split-mode layer` で回避運用中
  - LLM空応答の切り分け(解決済): 「挨拶でも空応答」の再現は Git Bash(CP932)から curl へ日本語を
    シェル引数で渡した文字化けが主因のテスト手法バグ。検証時は日本語ボディを必ずファイル化して
    `--data-binary @file` で送る(ブラウザ経由の正常UTF-8では再現しない)。加えてバックエンドが答えを
    reasoning_content 側に分類した場合は 031 のフォールバックで救済済み
  - DBバックアップ: WAL のため plainchat.db 単体コピーでは未チェックポイント分が漏れる。
    better-sqlite3 の .backup() か VACUUM INTO でスナップショットを取る
  - Windows: 外部/デタッチ済みプロセスへ正規の SIGTERM/SIGINT を送る手段が乏しい(taskkill /F 前提)。
    MCP 子プロセスの後始末は closeMcp() 経由が基本
  - 運用: グローバル設定に Claude 系プロンプト改変版(約11,600字)。reasoning-budget(現6000)は
    レイテンシ/推論深度を見て調整可

## リポジトリ構成
- src/index.js            : Expressエントリポイント(ポート 18091)。起動を async 化
                            (MCP接続+登録→ツール台帳ミラー同期)。SIGINT/SIGTERM で closeMcp()
- src/logger.js           : 簡易ロガー
- src/db.js               : SQLite接続・スキーマ初期化・初期ユーザーシード。tools / mcp_servers を冪等作成
- src/auth.js             : JWT認可ミドルウェア(authMiddleware)+ 管理者ゲート requireAdmin
- src/attachmentStorage.js    : data/の絶対パス化と attachment→ファイルパス解決(013〜017共有)
- src/attachmentCleanup.js     : 起動時の孤児アップロード回収(023)
- src/tools/types.js      : ツール定義のJSDoc型(name/description/parameters/handler/origin)
- src/tools/registry.js   : レジストリ(register/getters/buildOpenAIToolSchemas/getEnabledToolSchemas/
                            unregisterByOrigin/syncToolsToDb=接続成功源から消えたツールを enabled=0 無効化)
- src/tools/index.js      : registry の再エクスポート(builtin 読み込みは 032 で撤去。登録源は MCP のみ)
- src/mcp/config.js       : loadMcpServers()。DB(mcp_servers)を読み env/headers を復号して正規化配列を返す
- src/mcp/client.js       : MCPクライアント薄ラッパ。connectServer(serverConfig) で stdio/http を接続
                            (動的importでSDK、stdio=子プロセス、http=StreamableHTTPClientTransport)
- src/mcp/register.js     : listTools 結果を <label>__<tool>・origin='mcp:<label>' で registry へ登録
                            (再接続時に同 origin を一掃)
- src/mcp/secretBox.js    : AES-256-GCM 封筒暗号(getKey/encryptSecret/decryptSecret。鍵は .env の SECRET_ENC_KEY)
- src/mcp/index.js        : initMcp()/closeMcp()/reloadMcp() のオーケストレーション
- src/mcp/catalog.js      : stdioカタログ(既知サーバーのテンプレ)。command/args はここのみ・UI/APIから編集不可
- src/routes/auth.js      : ログイン/パスワード変更/me
- src/routes/conversations.js : 会話CRUD+メッセージ一覧
- src/routes/chat.js      : SSEチャット+ツール呼び出しループ(multi-round)。tool_call/tool_result・
                            上限 tool_choice:'none'・往復非保存。reasoning_content フォールバック
- src/routes/uploads.js   : 画像・ファイルのアップロード/配信API
- src/routes/mcpAdmin.js  : MCP設定API(管理者のみ。catalog取得/servers CRUD/reload。シークレットは暗号化格納・非返却)
- public/                 : フロントエンド(素のHTML/CSS/JS、CDNで marked/DOMPurify/highlight.js)。
                            MCP設定モーダル(管理者)を含む
- data/                   : SQLite DB等(gitignore対象)
- prompts/queue/ , done/  : 実装プロンプト(未実行/実行済み)
- DECISIONS.md            : 設計判断ログ(経緯・理由はこちら)
- .env.example            : 環境変数の雛形(実値は .env に。.env はコミット禁止)

## 起動方法
1. npm install
2. cp .env.example .env して各値を設定(SECRET_ENC_KEY を含む。生成は .env.example のコメント参照)
3. npm start(開発時は npm run dev)
4. http://localhost:18091 → ブラウザからログインして利用
5. MCP サーバーは管理者ログイン後、設定画面から追加(HTTP型は url+認証ヘッダ、stdio型はカタログ選択+env)

## 技術方針の要点
- スタック: Node.js(CommonJS)+ Express + better-sqlite3 + JWT(bcrypt)。フロントはビルドなし
- LLM接続: OpenAI互換 /chat/completions へ stream:true でSSE中継(text-generation-webui 経由 llama.cpp、2段構成)。
  リクエストは Connection: close で使い捨て(undiciプール破損対策)。中断時は部分応答を保存
- ツール呼び出し: 登録型。実体(handler)と契約(parameters)はコードが正、DB(tools)は運用状態(enabled等)のみ。
  ループはツール非依存で、ツール追加=MCPサーバー追加のみ。WEB検索等は native ではなく MCP 経由
- MCP: 公式 @modelcontextprotocol/sdk(v1.x、CommonJS からは動的 import)。stdio と Streamable HTTP。
  シークレットは封筒暗号で DB 格納、command/args は stdio カタログ(コード側)に閉じ UI から編集不可(制約2)
- 認可: 全APIで user_idスコープ。所有者不一致は404(存在を漏らさない)。MCP設定は管理者(is_admin)のみ
- 単一ユーザー運用だがマルチユーザー対応可能な構造を維持

## 開発ワークフロー
1. チャットで設計合意 → 実装プロンプトを prompts/queue/NNN_名前.md に保存
2. Claude Code に「prompts/queue/NNN_名前.md を読んで実装」と指示
3. Claude Codeは完了時に指示ファイルを done/ へ移動(コミットはしない)
4. 結果をチャットでレビュー → OKならユーザーが手動コミット
5. HANDOVER.md(現在地)/ DECISIONS.md(判断)を更新し、ナレッジへ手動反映
   ※ HANDOVER は差分を積み増さず、区切りで現在地を書き直すと肥大化しない