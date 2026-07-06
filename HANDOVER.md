# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯は DECISIONS.md を参照。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名等)はコミット禁止

## 現在地
- **フェーズ**: Phase 3 の①(画像→Vision)完成、空応答対応も完了。次は Phase 3 ②(ファイル添付)の設計相談へ
- **完了**: Phase 1(001〜007)、Phase 2(008〜012)、
  013 アップロード基盤、014 チャットのマルチモーダル対応、015 フロント添付UI(複数画像対応)、
  空応答対応(reasoning budget、コード変更なし・インフラ設定)
- **インフラ**: n_ctx=81920 / LLM_MAX_TOKENS=32768。MTP有効前提。Vision素通し(単一・複数)確認済み。
  textgen-webuiがllama.cppを内部起動、ローダの extra-flags に `--reasoning-budget 6000` を設定
  (思考がmax_tokensを食い尽くす空応答を解消。DECISIONS 2026-07-05参照)
- **次タスク**: Phase 3 ② ファイル添付(PDF/テキスト)の要約・QA。着手前にチャットで設計・分解を相談
- **Phase 3スコープメモ**: ①は画像+Vision-QA(複数画像・上限4枚)。③長文資料相談は②の使い方として吸収想定。
  WEB検索は候補。ロールプレイ機能は持ち込まない。添付ファイルの削除時クリーンアップは別タスク
- **運用メモ**: グローバル設定にClaude系プロンプト改変版(約11,600字)を適用。長文でも空応答は
  budgetで解消済み。budget値(現6000)はレイテンシ/推論深度を見て調整可
- **既知の外部課題(回避済み)**: llama.cpp の fattn.cu CUDA fatal error
  (Gemma4+fattn、Issue #24440/#24324系)。2GPUの tensor-split で再発するため、
  **--split-mode layer** で回避運用中。llama.cpp更新のみでは根治せず。
  ②以降でコンテキストが伸びる際はVRAM収まりを監視

## リポジトリ構成
- src/index.js            : Expressエントリポイント(ポート 18091)
- src/logger.js           : 簡易ロガー
- src/db.js               : SQLite接続・スキーマ初期化・初期ユーザーシード
- src/auth.js             : JWT認可ミドルウェア
- src/routes/auth.js      : ログイン/パスワード変更/me
- src/routes/conversations.js : 会話CRUD+メッセージ一覧
- src/routes/chat.js      : SSEチャット(ユーザー発話保存→LLM中継→応答保存)
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

