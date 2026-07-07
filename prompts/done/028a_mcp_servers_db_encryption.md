# 028a: mcp_servers の DB 保管 + 封筒暗号(UIなし土台)

## 1. 目的
MCPサーバー設定を DB(mcp_servers テーブル)へ保管し、シークレット(env/headers)を .env の鍵で
AES-256-GCM 封筒暗号して格納・使用時復号する土台を作る。loadMcpServers() の内部だけを DB+復号へ
差し替え、返り値形は 027 のまま保つ。設定画面(029)・builtin撤去(030)は含めない。

## 2. 対象
Phase 4 / 028a(DB保管+封筒暗号の土台、UIなし)。DECISIONS.md「028 スキーマと封筒暗号の確定」に従う。
設定画面・カタログ方式は 029、builtin撤去と後方互換seed/DEBUG_searxng撤去は 030。

## 3. 前提・参照
- 027完了: src/mcp/config.js の loadMcpServers() が正規化配列
  [{ label, enabled, transport?, command, args, env }] を返す(env=解決済み実値)。.env 参照は config.js のみ。
  src/mcp/index.js の initMcp() がこの配列をループ接続・登録、closeMcp() で全終了
- 024 の DB 冪等パターン: src/db.js の migrate() 内 CREATE TABLE IF NOT EXISTS、created_at/updated_at 規約、
  ON CONFLICT。既存テーブル: users(is_admin あり)/conversations/messages/attachments/tools
- package.json は "type":"commonjs"。Node 標準 crypto のみ使用(追加依存なし)
- 秘密は .env 隔離が原則。DB には平文の実値を置かず、暗号文のみ。鍵は DB に置かない
- 現行 searxng は transport='stdio'、command=node(process.execPath)、args=mcp-searxng の cli、
  env={SEARXNG_URL: DEBUG_searxng}(026/027)。MCP_SEARXNG_ENABLED は現行の有効フラグ
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) mcp_servers テーブル(src/db.js、冪等追加)
- CREATE TABLE IF NOT EXISTS mcp_servers:
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - label TEXT NOT NULL UNIQUE        -- 平文。名前空間prefix
  - enabled INTEGER NOT NULL DEFAULT 1 -- 平文
  - transport TEXT NOT NULL DEFAULT 'stdio' -- 'stdio' | 'http'。平文
  - command TEXT                       -- 平文(stdio系)
  - args TEXT                          -- 平文。JSON配列文字列(stdio系)
  - url TEXT                           -- 平文(http系。031まで未使用)
  - env_enc TEXT / env_iv TEXT / env_tag TEXT          -- env の封筒暗号(独立)
  - headers_enc TEXT / headers_iv TEXT / headers_tag TEXT -- headers の封筒暗号(独立。031まで未使用)
  - catalog_id TEXT                    -- 平文。029用。当面NULL可
  - sort_order INTEGER NOT NULL DEFAULT 0
  - created_at TEXT NOT NULL DEFAULT (datetime('now'))
  - updated_at TEXT NOT NULL DEFAULT (datetime('now'))
- 既存DB起動時に冪等作成され、既存テーブル・データ無傷。再起動でエラーなし
- env と headers はそれぞれ独立の (enc,iv,tag) 3列。片方のみ保持(NULL可)を許容

### (b) 封筒暗号(src/mcp/secretBox.js 新規)
- AES-256-GCM、Node 標準 crypto のみ
- 鍵は process.env.SECRET_ENC_KEY(base64 エンコードされた 32 バイト)。デコードして 32 バイトでなければ
  「鍵不正」として扱う
- getKey(): 鍵の有無・妥当性を判定して返す(未設定/不正なら null 相当)
- encryptSecret(obj): obj(プレーンな JS オブジェクト)を JSON 化し暗号化 → { enc, iv, tag }(いずれ base64)。
  obj が null/空なら 3値とも null を返す(暗号項目なし)。IV は毎回ランダム生成
- decryptSecret({enc,iv,tag}): 復号して元オブジェクトを返す。enc が null なら null を返す。
  鍵不正・authTag 検証失敗は例外
- 復号値・鍵をログ/エラーメッセージ/レスポンスに出さない(失敗時も詳細を秘匿しつつ原因種別だけログ)

### (c) loadMcpServers() の内部差し替え(src/mcp/config.js、境界は不変)
- 実装ソースを .env 直読みから DB(mcp_servers)へ切り替える:
  - getDb() で mcp_servers の enabled=1 を sort_order, id 順に読む
  - 各行で env_*/headers_* を decryptSecret で復号(暗号項目が無ければ空扱い)。args は JSON.parse
  - 027 と同一の正規化形へ組み立てて配列で返す:
    { label, enabled, transport, command, args, env }(transport==='http' のときは url, headers も付す)
- 返り値の形・意味は 027 から不変(env=解決済み実値)。initMcp()/register.js/client.js は無改修で動くこと
- 鍵未設定/不正で復号できない行(暗号項目を持つ行)は、その行をスキップしログを残す。
  他の行と PlainChat 起動は継続する(暗号項目を持たない行は鍵無しでも通す)
- .env のキー(DEBUG_searxng 等)を直接読むのは、下記 (d) の seed 経路に限定する

### (d) 後方互換の自動 seed(028a限定・030で撤去予定)
- 起動時(DB初期化後・initMcp 前)、mcp_servers が 0 件 かつ process.env.DEBUG_searxng が設定済みの場合のみ、
  searxng を 1 件 seed する:
  - label='searxng'、enabled=(MCP_SEARXNG_ENABLED が 'false' 以外なら 1、'false' なら 0)、transport='stdio'
  - command/args は現行(026/027)の node + mcp-searxng cli 起動と同一
  - env={ SEARXNG_URL: <DEBUG_searxng の実値、必要なら末尾スラッシュ正規化> } を encryptSecret して env_* に格納
  - headers_* は null、url は null、catalog_id は null
- seed は「空のときの初回だけ」。2 回目以降の起動では走らない(DB が正)
- SECRET_ENC_KEY 未設定時は seed の暗号化ができないため seed をスキップしログを残す
  (この場合、searxng は当面 registry に載らない。鍵設定を促すログを出す)
- このブロックには「028a の後方互換。030 で撤去」の旨をコメントで明記する

### (e) .env.example
- SECRET_ENC_KEY= のプレースホルダを追記(実値は書かない)。生成方法をコメントで併記
  (例: base64 で 32 バイトのランダム鍵。node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
- DEBUG_searxng / MCP_SEARXNG_ENABLED は後方互換として残す(プレースホルダ据え置き)
- .env(実値)は変更しない

## 5. やらないこと
- 設定画面 UI・管理者ゲート・カタログ方式(command/args の書込制御)= 029
- builtin 撤去・後方互換 seed の撤去・DEBUG_searxng 依存の除去 = 030
- http トランスポートの実接続(url/headers 欄は器のみ。実装は 031)
- 024 registry プリミティブ・025 ループ・src/routes/chat.js・register.js の登録契約の変更
- initMcp()/client.js/register.js のロジック変更(loadMcpServers の返り値形が不変なので触れない)
- mcp_servers への平文シークレット格納、鍵の DB 格納、復号値のログ/レスポンス露出
- 実 SearXNG アドレス等のコミット、.env 実値の変更、自ホスト情報のコミット
- 追加 npm 依存(crypto は標準)

## 6. 完了条件
（実 DB を手動バックアップの上で確認。検証用の一時変更は最後に元へ戻す。.env はコミットしない）
1. 既存DBで npm start → mcp_servers が冪等作成、既存テーブル・データ無傷、再起動でエラーなし
2. SECRET_ENC_KEY を .env に設定した状態で、mcp_servers 空 + DEBUG_searxng 設定済みから起動 →
   searxng 行が 1 件 seed され、env_enc/env_iv/env_tag が非NULL(暗号文)で、平文の SEARXNG_URL は
   DB のどの列にも存在しない(node -e / better-sqlite3 で確認)
3. seed 後、searxng が 026/027 同様に接続・登録され(searxng__* / origin='mcp:searxng')、実検索が
   最終回答に反映、messages は user+assistant のみ(回帰)
4. 2回目起動で seed が再実行されない(searxng 行が重複しない)
5. secretBox の往復: encryptSecret({SEARXNG_URL:'x'}) → decryptSecret で元に戻る。tag/iv 改竄時は復号失敗
   (簡易スクリプトで確認)。復号値がログに出ていないことを確認
6. 鍵未設定の退避: SECRET_ENC_KEY を外して起動 → 暗号項目を持つ searxng 行はスキップされ、
   PlainChat は起動継続、通常チャット・get_server_time は正常。鍵設定を促すログが出る。確認後 .env を戻す
7. loadMcpServers() の返り値形が 027 と同一({label,enabled,transport,command,args,env})で、
   initMcp()/register.js/client.js を無改修のまま searxng が動く
8. 手動で mcp_servers に enabled=0 の行を作る/ enabled=1 に戻す等でDBが源として効くことを確認。
   検証用の一時変更・seed 実験をすべて元に戻し、DB バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する