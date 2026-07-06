# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯は DECISIONS.md を参照。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名等)はコミット禁止

## 現在地
- **フェーズ**: Phase 3 の①(画像→Vision)+②(テキストファイル添付)完成、磨き込みまで完了。
  次タスクは未確定(Phase 3をここで締める / WEB検索へ)
- **完了**: Phase 1(001〜007)、Phase 2(008〜012)、
  013 アップロード基盤 / 014 チャットのマルチモーダル化 / 015 フロント画像添付(複数) /
  空応答対応(reasoning budget、インフラ設定) /
  016 ファイル添付基盤 / 017 チャットへのファイル注入 / 018 フロントファイル添付(合算4混在) /
  019 履歴attachmentにoriginal_name・size追加 / 020 履歴チップの実名表示 /
  021 ドラッグ&ドロップ添付 / 022 ユーザーバブル内チップの視認性修正
- **インフラ**: n_ctx=81920 / LLM_MAX_TOKENS=32768。MTP有効前提。
  Vision素通し(単一・複数)確認済み。textgen-webuiがllama.cppを内部起動し、ローダの
  extra-flags に `--reasoning-budget 6000 --reasoning-budget-message "..."` を設定(空応答解消)
- **既知の外部課題(回避済み)**: llama.cpp の fattn.cu CUDA fatal error
  (Gemma4+fattn、Issue #24440/#24324系)。2GPUの tensor-split で再発するため
  `--split-mode layer` で回避運用中。②以降でCTXが伸びる際はVRAM収まりを監視
- **次タスク**: 未確定。Phase 3を①②で締めるか、WEB検索(候補として登録済み)に進むかを相談
- **Phase 3スコープメモ**: ①=画像+Vision-QA(合算4)。②=テキストファイル(txt/md/csv/json)の
  添付・要約・QA。③長文資料相談は②の注入方式に吸収済み。PDF/OCR/docx/pptxは見送り(後続レバー)。
  ロールプレイ機能は持ち込まない。添付ファイルの削除時クリーンアップは別タスク
- **運用メモ**: グローバル設定にClaude系プロンプト改変版(約11,600字)を適用。長文でも空応答は
  budgetで解消済み。budget値(現6000)はレイテンシ/推論深度を見て調整可

## リポジトリ構成
- src/index.js            : Expressエントリポイント(ポート 18091)
- src/logger.js           : 簡易ロガー
- src/db.js               : SQLite接続・スキーマ初期化・初期ユーザーシード
- src/auth.js             : JWT認可ミドルウェア
- src/attachmentStorage.js    : data/の絶対パス化とattachment→ファイルパス解決(013〜017共有)
- src/routes/auth.js      : ログイン/パスワード変更/me
- src/routes/conversations.js : 会話CRUD+メッセージ一覧
- src/routes/chat.js      : SSEチャット(ユーザー発話保存→LLM中継→応答保存)
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

