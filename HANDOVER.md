# PlainChat HANDOVER

新しいチャットセッション/開発セッションはまずこのファイルを読むこと。
設計判断の経緯は DECISIONS.md を参照。

## プロジェクト概要
- 自宅LLM環境(llama.cpp server + Gemma4カスタムモデル)向けの個人専用汎用チャットアプリ
- ChatGPT / Claude / Gemini の代替。ロールプレイ要素なし
- GitHub Public(MIT License)。機密・実環境情報(IP/ホスト名等)はコミット禁止

## 現在地
- **フェーズ**: Phase 1(コアチャット)
- **完了**: 001 初期スキャフォールド(Express起動、/api/health、静的配信)
- **次タスク**: 未定(候補: DB基盤 → 認証 → 会話CRUD → SSEストリーミング → チャットUI)

## リポジトリ構成
- src/index.js      : Expressエントリポイント(ポート 18091)
- src/logger.js     : 簡易ロガー
- public/           : フロントエンド(現在はプレースホルダ)
- data/             : SQLite DB等(gitignore対象)
- prompts/queue/    : 未実行の実装プロンプト
- prompts/done/     : 実行済みプロンプト
- .base/            : NookResonance参照コード(gitignore対象、ローカルのみ、安定後に削除予定)
- DECISIONS.md      : 設計判断ログ
- .env.example      : 環境変数の雛形(実値は .env に。.env はコミット禁止)

## 起動方法
1. npm install
2. cp .env.example .env して各値を設定
3. npm start(開発時は npm run dev)
4. http://localhost:18091 で確認

## 技術方針の要点
- スタック: Node.js + Express + better-sqlite3 + JWT(bcrypt)
- NookResonance(ポート18090)とは完全独立で動作。コードは初期段階のみ流用可
- LLM連携はSSEストリーミングを新規実装(NookResonanceの非ストリーミング実装は流用不可)
- 単一ユーザー前提。ユーザー登録UI・管理者メニューは作らない

## 開発ワークフロー
1. チャットで設計合意 → 実装プロンプトを prompts/queue/NNN_名前.md に保存
2. Claude Code に「prompts/queue/NNN_名前.md を読んで実装」と指示
3. 結果をチャットでレビュー → プロンプトを prompts/done/ へ移動
4. HANDOVER.md(現在地)/ DECISIONS.md(判断)を更新し、ナレッジへ手動反映