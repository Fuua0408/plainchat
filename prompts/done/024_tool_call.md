# 024: ツール呼び出し基盤(定義の抽象・レジストリ・DB台帳)

## 1. 目的
ツールを「登録型」で扱う土台を作る。ツールの定義(OpenAI関数スキーマ)と実体をコードで持ち、
その運用状態(存在・有効/無効・表示順)をDBの tools テーブルで管理する。以降ツールを足すときは
モジュールを1つ追加するだけで済み、呼び出し側(chat.js)を無改修に保てる状態を用意する。
将来ツールの登録源が増えても(例: MCPサーバー)器を作り直さずに済むよう、定義に origin を持たせる。

## 2. 対象
Phase 4(ツール呼び出し / WEB検索 / RAG)の基盤。024=基盤のみ。
DECISIONS.md「2026-07-07 ツールは登録型でDB定義する(P2採用)」および同日追補
「ツール抽象に origin を持たせる」に従う。
本タスクでは chat.js・送信フロー・実際のツール呼び出しループには一切手を入れない(025で扱う)。

## 3. 前提・参照
- 001〜023完了済み。src/db.js は better-sqlite3、migrate() 内の CREATE TABLE IF NOT EXISTS と
  ensureColumn() による冪等マイグレーションパターンを持つ。これを踏襲する
- Spike 0(2026-07-07)で、接続経路が OpenAI 形式の tools/tool_calls を扱えることを確認済み。
  定義フォーマットは { type:'function', function:{ name, description, parameters(JSON Schema) } }
- 役割分担(DECISIONS参照): 実体(handler)と契約(parameters)はコードが正。
  DBは存在・enabled・sort_order・description・origin の運用状態のみを持つ
- origin は「そのツールがどこで定義されているか」を表す(当面 'builtin' 固定。
  将来 'mcp:<server>' を追加できる余地を残すだけで、MCP実装は本タスクの対象外)
- 認可・所有者方針、既存の env 命名(LLM_* 等)の作法に合わせる
- prompts/ 配下は指示書であり、移動以外の編集はしない

## 4. 要件

### (a) ツール定義の抽象(src/tools/types などの記述で可)
- 1ツール = { name(string, 一意), description(string), parameters(JSON Schemaオブジェクト),
  handler(async (args) => 文字列 または JSON化可能な値), origin(string, 既定 'builtin') } とする
- parameters は OpenAI 関数呼び出しの JSON Schema をそのまま書く(コードが契約の源)

### (b) コードレジストリ(src/tools/registry.js 新規)
- register(tool) でツールをメモリ上のレジストリに登録する。origin 未指定なら 'builtin' を補う
- 「前提となる env が揃っているときだけ自己登録する」方式に対応できるようにする
  (各ツールモジュール側で、必要な env が無ければ register を呼ばない、という書き方を可能にする)
- getRegisteredTools(): 登録済みツールの一覧(origin 含む)を返す
- getToolByName(name): ディスパッチ用にツールを引く
- buildOpenAIToolSchemas(names?): 登録済み(必要なら names で絞った)ツールを
  [{ type:'function', function:{ name, description, parameters } }] の配列に変換して返す
  (origin は LLM へ送るスキーマには含めない。運用メタなので送信対象外)
- getEnabledToolSchemas(db): 「コード等で登録済み」かつ「tools.enabled=1」のツールだけを
  OpenAIスキーマ配列で返す(025のループが送信に使う想定の公開関数。ここで定義まで用意する)

### (c) DB tools 台帳(src/db.js)
- tools テーブルを CREATE TABLE IF NOT EXISTS で追加(冪等):
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - name TEXT NOT NULL UNIQUE
  - description TEXT
  - origin TEXT NOT NULL DEFAULT 'builtin'
  - enabled INTEGER NOT NULL DEFAULT 1
  - sort_order INTEGER NOT NULL DEFAULT 0
  - created_at TEXT NOT NULL DEFAULT (datetime('now'))
  - updated_at TEXT NOT NULL DEFAULT (datetime('now'))
- 既存DBでの起動時に自動作成され、再起動してもエラーが出ない(冪等)こと
- per-user 列は作らない(単一ユーザー範囲。DECISIONS参照)。シークレットは一切格納しない

### (d) 起動時ミラー同期(src/db.js の初期化後 または起動処理内)
- サーバー起動時、「登録源が申告したツール」(=このタスクではコードレジストリの登録済みツール)を
  tools テーブルへ upsert する。将来 MCP 等の登録源が増えても同じ経路で同期できる書き方にする:
  - 行が無ければ INSERT(enabled=1 を既定、description と origin はツール定義の値、
    sort_order は登録順など妥当な値)
  - 行が有れば description と origin をツール定義側で更新する。enabled と sort_order は
    ユーザーの選択を尊重してクロバーしない(上書きしない)
  - INSERT ... ON CONFLICT(name) DO UPDATE SET description=excluded.description,
    origin=excluded.origin, updated_at=datetime('now') の形で、enabled/sort_order は据え置く
- コードに存在しないツールの行(過去に登録され今は無いもの)は削除しない(台帳の履歴として残す。
  レジストリに無い=実行対象にならないので実害はない)
- この同期は失敗してもサーバー起動を止めない(try/catchで隔離しログに残して続行)

### (e) 検証用ダミーツール(src/tools/builtin/serverTime.js など 新規)
- env前提なしで常に自己登録される単純なツールを1つ用意する(origin='builtin')
  (例: name='get_server_time'、引数なしまたは任意のタイムゾーン文字列、handlerは現在時刻のISO文字列を返す)
- これは024の検証用。実用ツール(WEB検索=026)はここでは作らない

## 5. やらないこと
- src/routes/chat.js・送信フロー・履歴構築・ツール呼び出しループの実装(025)
- 実際にモデルへ tools を送る/ tool_calls を実行する処理(025)
- MCPクライアント本体・MCPサーバーへの接続・tools/list による discover・
  origin='mcp:*' の実際の登録(将来タスク。本タスクは origin の器を用意するだけ)
- WEB検索・SearXNG・RAG 等の実用ツール(026以降)
- 管理画面UI・ツールのCRUD API・per-user のツール権限・会話単位のツール選択(将来タスク)
- messages スキーマ/ロールの変更(ツール往復はターン内一時利用の方針。DB保存しない)
- tools テーブルへのシークレット格納
- TOOLS_ENABLED / TOOLS_MAX_ROUNDS の消費(定義・読み取りは025で行う。024では .env.example への
  追記のみ許可: TOOLS_ENABLED=true / TOOLS_MAX_ROUNDS=4 をプレースホルダとして記載してよい)
- .env(実値)の変更

## 6. 完了条件
1. 既存DB(バックアップの上)でサーバー起動 → tools テーブルが冪等作成され、既存テーブル・データが無傷。
   再起動してもエラーが出ない
2. 起動後、tools に get_server_time の行が1件あり、origin='builtin'・enabled=1 で入っている
   (sqlite3 または node -e の確認スクリプトで確認)
3. getEnabledToolSchemas(db) が get_server_time を OpenAI 形式
   ({ type:'function', function:{ name, description, parameters } })で1件返す。
   返るスキーマに origin が含まれていないこと(運用メタは送信対象外)を確認
4. tools の get_server_time 行を enabled=0 に手動更新して再起動 →
   getEnabledToolSchemas(db) の結果から外れる(=個別on/offが効く)
5. description をコード側で変えて再起動 → 台帳の description が更新される一方、
   手動で変えた enabled/sort_order は据え置かれる(クロバーされない)
6. ミラー同期処理を意図的に失敗させても(例: 一時的に握りつぶし確認)サーバー起動は継続する
7. 確認用に変更した enabled 等を元に戻し、検証用の一時変更を片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する