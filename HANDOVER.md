# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯は DECISIONS.md を参照。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名等)はコミット禁止

## 現在地
- **フェーズ**: Phase 2完了。次はPhase 3(mmproj/長CTXを活かした機能)の着手相談から
- **完了**: Phase 1全項目(001〜007)、008 タイトル自動生成、009 バグ修正、
  010 システムプロンプト設定(グローバル+会話別)、011 テンプレート変数展開、
  012 会話の検索・フィルタ(→ Phase 2全項目完了)
- **次タスク**: 未確定。Phase 3候補は「画像アップロード→Vision対応」
  「ファイル添付(テキスト/PDF)の要約・QA」「長CTXを活かした資料相談」「WEB検索」。
  着手前にチャットでタスク分解を相談する
- **Phase 3着手前の確認事項(インフラ側)**:
  - n_ctx の最終値確定(現行76800、当初計画81920。DECISIONS.md参照)
  - LLM_MAX_TOKENS の適正値確定(空応答防御で8192以上を推奨済み)
  - MTP有効状態の再確認
  ※Phase 3はVision/長文前提のため、これらを固めてから着手するのが安全
- **運用メモ**: グローバル設定にClaude系プロンプト改変版を適用済み
  ({{currentDateTime}}は011で展開)。WebSearchはPhase 3以降の候補として登録済み。
  llama.cppクラッシュはビルド更新で解決済み(DECISIONS.md参照)

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