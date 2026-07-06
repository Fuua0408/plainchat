# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯は DECISIONS.md を参照。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名等)はコミット禁止

## 現在地
- **フェーズ**: Phase 3 完了(①画像→Vision / ②テキストファイル添付 / 磨き込み / 後片付け)。
  次は WEB検索を別スレッドで設計相談
- **完了**: Phase 1(001〜007)、Phase 2(008〜012)、
  Phase 3 = 013 アップロード基盤 / 014 マルチモーダル化 / 015 フロント画像添付(複数) /
  空応答対応(reasoning budget) / 016 ファイル添付基盤 / 017 ファイル注入 /
  018 フロントファイル添付(合算4混在) / 019 attachmentメタ追加 / 020 履歴チップ実名 /
  021 D&D / 022 チップ視認性 / 023 削除時クリーンアップ+孤児回収
- **インフラ**: n_ctx=81920 / LLM_MAX_TOKENS=32768。MTP有効前提。Vision素通し(単一・複数)確認済み。
  textgen-webuiがllama.cppを内部起動、extra-flags に
  `--reasoning-budget 6000 --reasoning-budget-message "..."`(空応答解消)
- **既知の外部課題(回避済み)**: llama.cpp の fattn.cu CUDA fatal error(Gemma4+fattn、
  Issue #24440/#24324系)。2GPUの tensor-split で再発するため `--split-mode layer` で回避運用中
- **次タスク**: WEB検索の設計相談(別スレッドで新規開始)。主要論点は下記
- **WEB検索の論点メモ(次スレッド用)**:
  - 位置づけ: 「Phase 3以降の候補」登録済み。Phase 4「外部ツール呼び出し」と重複するため線引きが要る
  - 検索プロバイダの選定(API・コスト・プライバシー。自宅運用として何を使うか)
  - 呼び出しトリガ: 手動トグル か モデルのツール呼び出し/自動判定 か
  - 結果の注入方法と引用表示、コンテキスト消費(81920とreasoning budgetとの兼ね合い)
  - 既存のグローバルSystem Prompt内に温存済みの「web search誘導」記述との接続
- **Phase 3スコープメモ**: ①=画像+Vision-QA(合算4)。②=テキストファイル(txt/md/csv/json)の
  添付・要約・QA。③は②の注入方式に吸収。PDF/OCR/docx/pptxは見送り(後続レバー)。
  ロールプレイ機能は持ち込まない
- **運用メモ**: グローバル設定にClaude系プロンプト改変版(約11,600字)。長文でも空応答はbudgetで
  解消済み。budget値(現6000)はレイテンシ/推論深度を見て調整可

## リポジトリ構成
- src/index.js            : Expressエントリポイント(ポート 18091)
- src/logger.js           : 簡易ロガー
- src/db.js               : SQLite接続・スキーマ初期化・初期ユーザーシード
- src/auth.js             : JWT認可ミドルウェア
- src/attachmentStorage.js    : data/の絶対パス化とattachment→ファイルパス解決(013〜017共有)
- src/attachmentCleanup.js     : 起動時の孤児アップロード回収(023)
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

