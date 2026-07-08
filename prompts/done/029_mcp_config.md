# 029: MCP設定UI + 暗号化格納(管理者ゲート・接続なし)

## 1. 目的
MCPサーバー設定を管理者が画面から登録・編集・削除できる UI と API を作る。HTTP型はurl/認証ヘッダ等を
自由入力、stdio型はコード側カタログの選択+必須env入力に限定し、任意プロセス起動(command/args のUI入力)を
封じる。受領したシークレット(認証ヘッダ/env)は secretBox で暗号化して mcp_servers へ格納する。
実接続・re-init はこのタスクでは行わない(030)。トークン投入の正規経路をここで確立する。

## 2. 対象
Phase 4 / 029(設定UI+格納、接続なし)。DECISIONS.md「タスク順を再入れ替え(設定UIを先行)」に従う。
実接続=030、builtin撤去=031。

## 3. 前提・参照
- 028a完了: mcp_servers テーブル(平文: label/enabled/transport/command/args/url/catalog_id/sort_order、
  暗号: env_enc/iv/tag・headers_enc/iv/tag)。src/mcp/secretBox.js(getKey/encryptSecret/decryptSecret、
  AES-256-GCM、鍵は .env の SECRET_ENC_KEY)。loadMcpServers() は DB読込+復号で正規化配列を返す
- 認可: 既存 JWT ミドルウェア(src/auth.js)。users.is_admin あり。管理者専用の重ねがけを行う
- 既存フロント: public/ の素の HTML/CSS/JS(ビルドなし。CDNで marked/DOMPurify/highlight.js)。
  設定系の既存画面(ユーザーのsystem_prompt編集等)があればその様式・認証取り回しに合わせる
- register.js/client.js/initMcp/025ループ/024 registry は本タスクでは変更しない(接続は030)
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) stdio カタログ(src/mcp/catalog.js 新規)
- コード側で既知 stdio サーバーのテンプレートを定義する配列/マップ:
  { id, displayName, transport:'stdio', command, args, requiredEnvKeys: [..], optionalEnvKeys?: [..], description }
- 当面 searxng を1件登録(028a の後方互換 seed と同じ command/args=node+mcp-searxng cli、
  requiredEnvKeys=['SEARXNG_URL'])。command/args はここにだけ存在し、API/UI からは編集不可
- getCatalog(): カタログ一覧(command/args を含まない表示用メタ = id/displayName/requiredEnvKeys/description)を返す
  公開関数と、内部用に id→完全定義を引く関数を分ける(command/args を外へ漏らさない)

### (b) API(src/routes/mcpAdmin.js 新規、管理者のみ)
- 認可: JWT + is_admin。非管理者は 403
- GET /api/mcp/catalog … カタログの表示用メタ(command/args 抜き)を返す
- GET /api/mcp/servers … mcp_servers 一覧。**シークレットは返さない**。各行に「シークレット設定済みか」の
  真偽(has_env / has_headers)と、平文メタ(label/enabled/transport/url/catalog_id/sort_order)のみ
- POST /api/mcp/servers … 追加。transport により分岐:
  - transport='http': 入力は label/url/enabled/headers(任意)。headers は受領後 encryptSecret して
    headers_* に格納。command/args/env は設定しない。url は http/https のみ許可(スキーム検証)
  - transport='stdio': 入力は label/catalog_id/enabled/env。command/args は **入力から受け付けず**、
    catalog_id からサーバー側でカタログの command/args を引いて格納。env は requiredEnvKeys を満たすか検証し
    encryptSecret して env_* に格納
  - label 一意制約。重複はエラー
- PATCH /api/mcp/servers/:id … label/enabled/sort_order/url(http時)/env・headers(再設定時のみ)を更新。
  env/headers は「新しい値が来たときだけ」再暗号化して差し替え、来なければ据え置き(既存暗号文を保持)。
  stdio の command/args は更新対象外(catalog_id 変更時はサーバー側でカタログから引き直す)
- DELETE /api/mcp/servers/:id … 行削除
- 全レスポンスで復号値・暗号文(enc/iv/tag)を返さない。ログにもシークレットを出さない
- SECRET_ENC_KEY 未設定時に暗号化が必要な POST/PATCH が来たら、保存を拒否し「鍵未設定」を示すエラーを返す
  (平文で保存しない)

### (c) UI(public/ に設定画面。管理者のみ表示)
- サーバー一覧(label/transport/enabled/シークレット設定済みバッジ)、追加/編集/削除
- 追加フォームは transport 選択で切替:
  - HTTP: url + 認証ヘッダ入力欄(例 "Authorization: Bearer ..." を貼る想定。複数ヘッダ対応でもよい)+ label + enabled
  - stdio: カタログ選択(displayName)+ 必須 env 入力(requiredEnvKeys のみ)+ label + enabled。
    command/args は画面に出さない
- **シークレットはマスク**: 認証ヘッダ/env は入力用のみ。保存後は値を再表示せず「設定済み/未設定」表示。
  編集時は「新しい値を入れたときだけ更新」(空なら据え置き)
- 非管理者にはこの画面/メニューを出さない(サーバー側 403 と二重で守る)

### (d) 配線
- src/index.js に /api/mcp ルータをマウント。既存の認証/静的配信の流儀に合わせる
- 保存は DB 即時。接続・initMcp の再実行はしない(030)。保存しても次回起動 or 030 実装まで実接続はされない旨、
  UI に一言注記してよい

## 5. やらないこと
- 実接続・StreamableHTTPClientTransport・re-init・接続リロード(030)
- client.js/register.js/initMcp/025ループ/024 registry/secretBox のロジック変更
  (secretBox は呼び出すだけ。変更しない)
- stdio の command/args を API/UI から入力・編集させること(カタログ選択のみ)
- builtin 撤去(031)、per-user のツール/サーバー使用可否(将来)
- シークレット(復号値・暗号文)のレスポンス/ログ/画面への露出
- .env 実値の変更、実トークン/実アドレスのコミット
- 実 NookResonance への接続テスト(接続は030。029は保存までの検証に留める)

## 6. 完了条件
（実 DB を手動バックアップの上で確認。検証用データは最後に削除。.env はコミットしない）
1. 非管理者トークンで /api/mcp/* が 403。管理者トークンで 200
2. GET /api/mcp/catalog が searxng を返し、command/args が含まれない(表示用メタのみ)
3. HTTP型を POST(url + ダミー認証ヘッダ)→ mcp_servers に transport='http'・url 平文・headers_* に暗号文が入り、
   DB に平文ヘッダ文字列が存在しない(ダンプ確認)。command/args/env は null
4. stdio型を POST(catalog_id=searxng + env{SEARXNG_URL: ダミー})→ command/args がカタログ由来で格納され、
   API 入力に command/args を混ぜても無視/拒否される。env_* に暗号文、平文 env が DB に無い
5. GET /api/mcp/servers がシークレットを返さず has_env/has_headers と平文メタのみを返す
6. PATCH で enabled 切替・url 変更ができ、env/headers を空で送ると既存暗号文が据え置かれ、新値を送ると
   再暗号化で差し替わる。DELETE で行が消える
7. SECRET_ENC_KEY 未設定で暗号化が要る POST/PATCH が保存拒否(平文保存されない)
8. UI: 管理者で設定画面が見え、HTTP/stdio でフォームが切替、stdio で command/args が非表示、保存後に
   シークレットが再表示されない(マスク)。非管理者に画面が出ない
9. loadMcpServers() が 029 で追加した行を(028aの正規化形で)読めることを確認(復号が通る=格納が正しい)。
   検証用データを削除し、DB バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する