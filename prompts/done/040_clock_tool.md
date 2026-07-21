# 040: 現在日時取得ツール(clock)の追加

## 1. 目的
モデルが能動的に現在の日付・時刻を確認できるMCPツールを追加する。Web検索等のクエリ組み立て時に
年号判断を誤らないようにする。外部npm依存・シークレットいずれも不要な自前実装とし、新規/既存
デプロイの両方でデフォルト有効になるようにする。

## 2. 対象
Phase 4「改善フェーズ」。DECISIONS.md「2026-07(040): 現在日時取得ツール(clock)の追加」に従う。

## 3. 前提・参照
- 032で「登録源はMCPのみ」に一本化済み(origin='builtin'のコードパスは存在しない)。今回もこの原則は
  崩さない。builtinを復活させるのではなく、通常のMCPサーバー(stdio)として実装する
- src/mcp/catalog.js: stdioカタログのテンプレート定義。searxng用エントリ(command/args/
  requiredEnvKeys等)が既にある。getCatalog()(表示用メタ、command/args抜き)とgetCatalogEntry(id)
  (内部用、command/args込み)を公開している
- src/routes/mcpAdmin.js の POST /api/mcp/servers(stdio分岐): catalog_idからカタログを引き、
  command/argsをそこから複製してDBへ格納する。env はrequiredEnvKeys/optionalEnvKeysに基づき検証・
  暗号化(空でもSECRET_ENC_KEY要求される)。ただし今回追加する自動seedはこのAPI経由ではなく、
  起動時に直接DBへINSERTするため、この制約(SECRET_ENC_KEY必須)を受けない
- mcp_servers スキーマ: label(UNIQUE)/enabled/transport/command/args/url/env_enc,iv,tag/
  headers_enc,iv,tag/catalog_id/sort_order。env_*系は片方だけの保持やNULLを許容する
- src/mcp/client.js の connectServer(): stdio/httpを問わず正規化済みサーバー設定を受け取って接続する
  汎用ラッパ。stdioは StdioClientTransport({ command, args, env, stderr:'pipe' })
- src/mcp/register.js: listTools結果を `<label>__<tool>`・origin='mcp:<label>' で registry へ登録
- package.jsonは "type":"commonjs" だが、新規作成する自前MCPサーバーは独立した子プロセスとして
  起動されるだけの別ファイルなので、拡張子 .mjs にすれば親のcommonjs設定に関わらず常にESMとして
  実行される(Node標準の挙動)。これにより @modelcontextprotocol/sdk を動的import()せず素直に
  静的importできる。SDKは既存依存なのでnode_modules探索は問題なく通る
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) 自前MCPサーバー本体(新規: src/mcp-servers/clock/index.mjs)
- @modelcontextprotocol/sdk の *サーバー側* API(Server, StdioServerTransport,
  ListToolsRequestSchema, CallToolRequestSchema 等。実際のAPI形は node_modules内の
  @modelcontextprotocol/sdk のバージョンを確認して合わせること。mcp-searxngのような
  一般的なMCPサーバー実装と同型のパターンでよい)でstdioサーバーを実装する
- 公開ツールは1つ: get_current_datetime
  - 説明文(そのままモデルに見える。文言はこの通りで固定):
    「現在のシステム日時を取得します。相対的な日付表現(今日・今年・最新等)を扱う場合や、
    Web検索のクエリに年号を含める前には、まずこのツールで現在日時を確認してください。」
  - 入力スキーマ: 引数なし({ type: 'object', properties: {} }相当)
  - 戻り値: content に text ブロック1つ。中身はJSON文字列で以下のキーを持つ:
    { iso, date, time, weekday, timezone, unix }
    - iso: new Date().toISOString()相当だが、可能であればシステムのローカルタイムゾーンの
      オフセット付き(例 2026-07-22T15:32:10+09:00)。Node標準機能(Intl.DateTimeFormat等)で
      構築する。厳密なタイムゾーンDB連携が難しければ、素直にサーバーのローカル時刻+
      オフセットが得られれば十分(過度な作り込みはしない)
    - date: YYYY-MM-DD、time: HH:MM:SS(ローカル時刻)
    - weekday: 日本語の曜日(例「水曜日」)
    - timezone: システムのタイムゾーン名(Intl.DateTimeFormat().resolvedOptions().timeZone等)
    - unix: Unix秒
  - 外部通信・ファイルI/O・環境変数への依存は一切なし

### (b) カタログ登録(src/mcp/catalog.js)
- buildCatalog() に新エントリを追加:
  - id: 'clock'
  - displayName: '現在日時取得(組み込み)'
  - transport: 'stdio'
  - command: process.execPath
  - args: [(a)で作成したindex.mjsへの絶対パス。path.join(__dirname, ...)で解決し、
    searxngエントリのrequire.resolve方式と同様、ファイルが見つからない場合はcommand/argsを
    nullにして安全側に倒す]
  - requiredEnvKeys: []、optionalEnvKeys: []
  - description: 'システムの現在日時を返す軽量MCPサーバー。外部通信・追加のシークレット不要'

### (c) 起動時の自動seed(src/db.js または src/index.js。既存のtools/mcp_serversテーブル
    冪等初期化と同じ場所・流儀に合わせて配置する)
- DB初期化後・initMcp()呼び出し前のタイミングで実行する
- 条件: mcp_servers に label='clock' の行が存在しない場合のみ、以下でINSERTする:
  - label='clock', enabled=1, transport='stdio', catalog_id='clock'
  - command/argsはgetCatalogEntry('clock')から複製(JSON.stringifyしたargs配列)
  - env_enc/env_iv/env_tag は NULL(シークレット不要なため暗号化自体を行わない。
    SECRET_ENC_KEY未設定でもこのseedは成功すること)
  - headers_* は NULL、url は NULL、sort_order は既存の nextSortOrder 相当のロジックで採番
- 既に label='clock' の行が存在する場合(ユーザーが無効化・編集済みの場合を含む)は何もしない
  (seedは「一度追加するだけ」。enabled状態の上書きはしない)
- カタログエントリのcommand解決に失敗している場合(ファイルが見つからない等)はseedをスキップし
  ログを残す。起動自体は継続する

## 5. やらないこと
- builtinコードパス(origin='builtin')の復活。032の「登録源はMCPのみ」は維持する
- 「削除後に自動で再度追加される」挙動の抑止(専用のseed済みフラグ機構等)。これは既知の仕様として
  許容する(DECISIONS.md 2026-07(040)参照)
- タイムゾーンの動的切り替え・複数タイムゾーン対応・サマータイム等の高度な処理
- 011の{{currentDateTime}}システムプロンプト変数機構の変更
- 025のツール呼び出しループ本体・client.js/register.jsのロジック変更(catalog.jsへの追記のみ)
- mcpAdmin.js API・管理画面UIの変更(既存のcatalog選択フローがそのまま使えるはず)
- .envの変更

## 6. 完了条件
（実DBを手動バックアップの上で確認。検証用の一時変更は最後に元へ戻すこと）
1. 既存DBのまま再起動 → mcp_servers に label='clock' の行が自動で追加され、enabled=1になっている
   (node -e / better-sqlite3で確認)
2. 管理画面(MCPサーバー設定)を開くと、clockサーバーが一覧に表示され、有効チェックが入っている
3. 実際にモデルへ「今日は何年何月何日?」等、現在日時を要する質問を送ると、clock__get_current_datetime
   が呼ばれ、正しい日付を踏まえた応答が返る(SSEのtool_callイベント・DBのtool_invocationsの両方で確認)
4. Web検索を要する質問(例「今年の最新ニュースを検索して」)で、モデルがclockを先に呼んでから
   検索クエリを組み立てる(または少なくとも正しい年を使ったクエリになる)ことを確認する
5. サーバーを再起動しても clock の行が重複追加されない(1行のみ)
6. 管理画面で clock を「無効化」(enabledチェックを外す)→ 再起動しても enabled=0 のまま
   (自動で有効に戻らない)ことを確認。確認後、有効に戻す
7. SECRET_ENC_KEY を一時的に未設定にした状態でDBを空にして起動 → clock のseedは成功し
   (シークレット不要なため)、他のシークレットを要するサーバーの復号はスキップされる(028aの
   既存退避動作と両立)。確認後 .env を元に戻す
8. 検証用に変更したコード・DBデータ・.envをすべて元に戻し、一時バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する