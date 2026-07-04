# 001: PlainChat 初期スキャフォールド構築

## 1. 目的
汎用チャットアプリ PlainChat のリポジトリ骨格を構築し、
Expressサーバーがヘルスチェックに応答する状態までを作る。

## 2. 対象
Phase 1(コアチャット)の土台。機能実装はまだ行わない。

## 3. 前提・参照
- リポジトリ: plainchat(GitHub Public、clone済み、README / .gitignore(Node) / MIT LICENSE あり)
- スタック: Node.js + Express + better-sqlite3(DBは後続タスクで導入。今回は依存に含めるだけ)
- 自宅LLM環境(llama.cpp server)向けだが、今回はLLM接続を実装しない
- 別プロジェクト NookResonance と同一ホストで同居するため、ポートはデフォルト 18091 とする
  (NookResonance は 18090 を使用中)
- リポジトリ直下の .base/ に参照用としてNookResonanceの全コードが置かれている。
  初期実装の土台として読むこと・コピーすることは許可されている(今回のタスクでは使用しない)
- prompts/ 配下は指示書であり、実装対象のコードではない。移動以外の編集はしない

## 4. 要件
以下の構成を作成する:

plainchat/
├── src/
│   ├── index.js        # Expressエントリポイント
│   └── logger.js       # 簡易ロガー(console ベース、info/warn/error)
├── public/             # フロント用(今回は index.html のプレースホルダのみ)
├── data/               # SQLite DB・アップロード置き場(gitignore対象)
├── prompts/
│   ├── queue/          # Claude Code向け実装プロンプト(未実行)
│   └── done/           # 実行済みプロンプト
├── .env.example
├── .gitignore          # 既存に追記
├── package.json
└── README.md           # 既存に起動手順を追記

### package.json
- name: plainchat, type: commonjs
- 依存: express, better-sqlite3, bcrypt, jsonwebtoken, dotenv
- scripts: "start": "node src/index.js", "dev": "node --watch src/index.js"

### src/index.js
- dotenv 読み込み
- express.json() ミドルウェア
- GET /api/health → { ok: true, name: "plainchat" } を返す
- public/ を静的配信
- process.env.PORT(デフォルト 18091)で listen し、起動ログを出す

### .env.example(実値は書かず、プレースホルダのみ)
PORT=18091
JWT_SECRET=change-me-to-strong-random-string
DB_PATH=./data/plainchat.db
LLM_ENDPOINT=http://localhost:5000/v1
LLM_API_KEY=sk-fake
LLM_MAX_TOKENS=2048
LLM_TEMP=0.7
LLM_TOP_P=0.95
LLM_TOP_K=64
LLM_REP_PENALTY=1.15
LLM_TIMEOUT=120

### .gitignore への追記
.env / data/ / .base/ / node_modules(既存テンプレートにあれば重複不要)

### public/index.html
「PlainChat - under construction」程度の最小プレースホルダ

## 5. やらないこと
- 認証、DB接続、LLM接続、チャットUIの実装(すべて後続タスク)
- .env の作成・コミット(.env.example のみ。実IPやホスト名等の実環境情報は
  いかなるファイルにも書かない。これはPublicリポジトリの恒久ルール)

## 6. 完了条件
- npm install が成功する
- cp .env.example .env の後 npm start でサーバーが起動する
- curl http://localhost:18091/api/health が { "ok": true, "name": "plainchat" } を返す
- ブラウザで http://localhost:18091 にプレースホルダが表示される
- git status で .env、data/、.base/ が追跡されていないことを確認
- 上記確認後、コミット(メッセージ例: "chore: initial scaffold")