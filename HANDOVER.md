# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯は DECISIONS.md を参照。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名等)はコミット禁止

## 現在地
- **フェーズ**: Phase 4 着手中(WEB検索 / RAG / ツール呼び出し)。Phase 3 まで完了済み。
  ツール呼び出しは native ではなく MCP 経由で実装する方針(DECISIONS参照)
- **完了**: Phase 1(001〜007)、Phase 2(008〜012)、Phase 3(013〜023)、
  Spike 0(ツール呼び出し検証: textgen-webui経由 llama.cpp で OpenAI 形式 tools/tool_calls が
  native 動作することを実地確認。リポジトリ外の使い捨てで実施)、
  Phase 4 = 024 ツール呼び出し基盤(登録型ツール定義・DB tools 台帳・origin・起動時ミラー同期・
  検証用 builtin get_server_time。chat.js 無改修)
- **Phase 4 タスク採番/計画**:
  - 024 ツール呼び出し基盤(登録型ツール定義・DB tools 台帳・origin・起動時ミラー同期・
  検証用 builtin get_server_time。chat.js 無改修)、025 ツール呼び出しループ(chat.js を multi-round 化。
  tool_call/tool_result SSEイベント・上限時 tool_choice:'none'・失敗はループ継続・ツール往復は非保存)
  - 025 ツール呼び出しループ … 完了(chat.js multi-round 化)
  - 026 MCPクライアント+登録アダプタ … stdio 接続 → tools/list → 転送handler+origin='mcp:*' で登録
    → tools/call ディスパッチ。ツール名の名前空間化もここで。将来 prompts/resources の余地を塞がない
  - 検索サーバー … 自作せず既製 mcp-searxng を自分の SearXNG に向けて動かすインフラ手順
    (PlainChat のコーディングタスクではない)。初手トランスポートは stdio
  - RAG … 別途設計(embeddings/ベクタストア)。同じ台帳・ループ・LLM契約の上に載る
- **インフラ**: n_ctx=81920 / LLM_MAX_TOKENS=32768。MTP有効前提。Vision素通し確認済み。
  textgen-webuiがllama.cppを内部起動、extra-flags に
  `--reasoning-budget 6000 --reasoning-budget-message "..."`(空応答解消)
- **既知の外部課題(回避済み)**: llama.cpp の fattn.cu CUDA fatal error(Gemma4+fattn、
  Issue #24440/#24324系)。2GPUの tensor-split で再発するため `--split-mode layer` で回避運用中
- **SearXNG 準備メモ(026の前提)**: API用途には settings.yml の search.formats に json を足す
  (無効だと 403)。limiter/public_instance はオフのまま(server-to-server 想定)。接続先URLは .env に
  隔離(例: SEARX_ENDPOINT のプレースホルダ)。mcp-searxng は SEARXNG_URL で自分のインスタンスを指す
- **WEB検索の論点(解決済み・DECISIONS参照)**:
  - プロバイダ=SearXNG(セルフホスト)。方式=native ではなく MCP 経由(既製 mcp-searxng を consume)
  - トランスポート初手=stdio(旧SSEは非推奨のため不採用)
  - トリガ/注入/コンテキスト予算・「web search誘導」記述との接続は 025/026 で具体化
- **設計の動機メモ(プロジェクト内認識)**: 登録型ツール基盤・origin・MCPクライアントは、別プロジェクト
  NookResonance への流用(ツール呼び出しの共通土台化、キャラクター性格を prompts として供給する
  MCP サーバー化構想)を見込んだ投資。NookResonance 側の概念は PlainChat には持ち込まない
- **運用メモ**: グローバル設定にClaude系プロンプト改変版(約11,600字)。budget値(現6000)は
  レイテンシ/推論深度を見て調整可
- **既知の挙動(025で観測)**: TOOLS_ENABLED を false に切り替えても、同一会話の履歴にツール利用の
  文脈(過去にツール実行へ言及したアシスタント応答など)が残っていると、モデルが引きずられて
  空応答(reasoning budget 超過)になることがある。コードのバグではなくコンテキスト起因で、
  新規会話ではフォールバックは正常。運用上、ツール可否の切り替えは新規会話で行うのが無難

## リポジトリ構成
- src/index.js            : Expressエントリポイント(ポート 18091)。起動時にツール台帳ミラー同期
- src/logger.js           : 簡易ロガー
- src/db.js               : SQLite接続・スキーマ初期化・初期ユーザーシード(tools台帳を冪等作成)
- src/auth.js             : JWT認可ミドルウェア
- src/attachmentStorage.js    : data/の絶対パス化とattachment→ファイルパス解決(013〜017共有)
- src/attachmentCleanup.js     : 起動時の孤児アップロード回収(023)
- src/tools/types.js      : ツール定義のJSDoc型(name/description/parameters/handler/origin)
- src/tools/registry.js   : レジストリ(register/getRegisteredTools/getToolByName/
                            buildOpenAIToolSchemas/getEnabledToolSchemas/syncToolsToDb)
- src/tools/index.js      : builtinを読み込み自己登録させ registry を再エクスポート(同期の前提)
- src/tools/builtin/serverTime.js : 検証用 builtin get_server_time(origin='builtin', env前提なし)
- src/routes/auth.js      : ログイン/パスワード変更/me
- src/routes/conversations.js : 会話CRUD+メッセージ一覧
- src/routes/chat.js      : SSEチャット+ツール呼び出しループ(multi-round)。tools有効時は
                            tool_call/tool_result イベント発火・ツール実行、上限時 tool_choice:'none'。
                            ツール往復は非保存で最終応答のみ保存(025)
- src/routes/uploads.js   : 画像・ファイルのアップロード/配信API
- public/                 : フロントエンド(素のHTML/CSS/JS、CDNでmarked/DOMPurify/highlight.js)
- data/                   : SQLite DB等(gitignore対象)
- prompts/queue/ , done/  : 実装プロンプト(未実行/実行済み)
- DECISIONS.md            : 設計判断ログ
- .env.example            : 環境変数の雛形(実値は .env に。.env はコミット禁止)

## 起動方法
1. npm install
2. cp .env.example .env して各値を設定
3. npm start(開発時は npm run dev)
4. http://localhost:18091 → ブラウザからログインして利用

## 技術方針の要点
- スタック: Node.js + Express + better-sqlite3 + JWT(bcrypt)。フロントはビルドなし
- LLM接続: OpenAI互換 /chat/completions へ stream:true でSSE中継。
  接続先はtext-generation-webui経由でllama.cpp server(2段構成、意図的)
- LLMへのリクエストは Connection: close で使い捨て(undiciプール破損対策。DECISIONS.md参照)
- 中断時は部分応答を保存。初トークン前の失敗はユーザー発話のみ残す
- 認可: 全APIでuser_idスコープ。所有者不一致は404(存在を漏らさない)
- 単一ユーザー運用だがマルチユーザー対応可能な構造を維持

## 開発ワークフロー
1. チャットで設計合意 → 実装プロンプトを prompts/queue/NNN_名前.md に保存
2. Claude Code に「prompts/queue/NNN_名前.md を読んで実装」と指示
3. Claude Codeは完了時に指示ファイルを done/ へ移動(コミットはしない)
4. 結果をチャットでレビュー → OKならユーザーが手動コミット
5. HANDOVER.md(現在地)/ DECISIONS.md(判断)を更新し、ナレッジへ手動反映

