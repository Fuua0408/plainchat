# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯は DECISIONS.md を参照。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名等)はコミット禁止

## 現在地
- **フェーズ**: Phase 3(mmproj/長CTXを活かした機能)進行中。Vision先行で①画像アップロード→Vision
- **完了**: Phase 1(001〜007)、Phase 2(008〜012)、
  013 アップロード基盤(attachmentsテーブル+アップロード/配信API)、
  014 チャットのマルチモーダル対応(chat.jsで画像をVision入力として送信・履歴再送)
- **インフラ**: n_ctx=81920 / LLM_MAX_TOKENS=32768 で確定。MTP有効前提。
  textgen-webui経由のVision素通しは014で実地確認済み(実LLMで色を正答)
- **次タスク**: 015 フロント添付UI(添付ボタン・プレビュー・アップロード→送信フロー・
  Blob表示・履歴画像の再描画)。設計はDECISIONS「画像添付まわりの設計判断」(2026-07-05)参照
- **Phase 3スコープメモ**: 今回は画像+Vision-QAのみ(添付は単一画像)。②ファイル添付(PDF/テキスト)
  ③長文資料相談は後続。WEB検索は候補のままスコープ外。ロールプレイ機能は持ち込まない
- **運用メモ**: グローバル設定にClaude系プロンプト改変版を適用済み。空応答が続く場合は
  LLM_TEMP引き下げも緩和策候補(DECISIONS 2026-07-05参照)

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