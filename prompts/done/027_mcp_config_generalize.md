# 027: MCP設定ソースの抽象化と複数サーバー対応(箱)

## 1. 目的
026 のハードコード単一 searxng を loadMcpServers() 設定ソース抽象の背後に一般化し、複数 MCP サーバーを
接続・登録できるようにする。設定の出所(現状 .env、将来 DB+復号)を loadMcpServers() の1点に隔離し、
028 で DB・封筒暗号・設定画面を無改修で差せる境界を用意する。中身(DB/暗号化/UI/カタログ)は作らない。

## 2. 対象
Phase 4 / 027(箱・一般化)。DECISIONS.md「MCP設定は封筒暗号でDB保管(28で実装、27は箱のみ)」の
「027 = 箱」に従う。DB保管・封筒暗号・SECRET_ENC_KEY・設定画面・カタログ方式・builtin撤去は 028。

## 3. 前提・参照
- 026完了: src/mcp/client.js(stdio 単一サーバー接続の薄ラッパ)、src/mcp/register.js(listTools →
  <label>__<tool>・origin='mcp:<label>' で registry へ登録)、src/mcp/index.js(initMcp/closeMcp)。
  起動は src/index.js で「builtin読込→MCP接続+登録→syncToolsToDb」、SIGINT/SIGTERM で closeMcp
- 単一 searxng は node(process.execPath)で mcp-searxng の dist/cli.js を直接起動し、子プロセス env に
  SEARXNG_URL=DEBUG_searxng を渡す方式(026)。MCP_SEARXNG_ENABLED(既定 true、false のみ無効)
- 024 registry / 025 ループ / src/routes/chat.js は不変。package.json は "type":"commonjs"、SDK は動的 import
- 実行環境 Windows(外部プロセスへ SIGTERM 不可のため closeMcp 明示終了。mcp-searxng は起動時 URL 未検証)
- 秘密・実アドレスは .env 隔離のまま。027 では DB も暗号化も導入しない
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) 設定ソース抽象 loadMcpServers()(src/mcp/config.js 新規 等)
- loadMcpServers() は正規化済みサーバー構成の配列を返す:
  [{ label, enabled, command, args, env }]
  - label: サーバー識別ラベル(名前空間 prefix に使用。例 'searxng')
  - enabled: boolean
  - command / args: 子プロセス起動コマンドと引数(026 の node + mcp-searxng cli 起動を踏襲)
  - env: 子プロセスへ渡す環境変数の「解決済み実値」オブジェクト
    (例 { SEARXNG_URL: <DEBUG_searxng の実値> })
- 027 の実装ソースは .env。現行 searxng を 1 エントリとして構築する
  (enabled=MCP_SEARXNG_ENABLED、env.SEARXNG_URL=process.env.DEBUG_searxng、必要なら末尾スラッシュ正規化)
- 境界の厳守: 「設定がどこから来るか」を知るのは loadMcpServers() だけ。呼び出し側は正規化配列のみを扱い、
  .env のキー名や(将来の)DB/復号を一切意識しない。028 は loadMcpServers() の内部だけを
  DB+復号へ差し替えれば、同じ返り値形で動く

### (b) 複数サーバー対応への一般化(src/mcp/client.js / index.js)
- 026 の単一接続を、サーバー単位クライアントを label→client(+transport)のマップで管理する形に一般化
- initMcp(): loadMcpServers() を呼び、enabled=true の各サーバーを接続 → listTools →
  register(既存 register.js を label 付きで呼ぶ)。name='<label>__<tool>'、origin='mcp:<label>'
- 1 サーバーの接続/登録失敗は隔離(ログを残し、他サーバーとサーバー起動は継続。026 の退避方針を踏襲)
- closeMcp(): 管理下の全クライアントを close(全 MCP 子プロセス終了)
- 起動シーケンス(builtin読込→initMcp→syncToolsToDb)と SIGINT/SIGTERM→closeMcp は 026 のまま
- 名前空間 prefix によりサーバー間で同名ツールが衝突しない(複数サーバーでも一意)

### (c) 設定(.env / .env.example)
- 既存 DEBUG_searxng / MCP_SEARXNG_ENABLED を loadMcpServers() 経由で読む形へ寄せる
  (.env.example は現状のプレースホルダ据え置きで可)。新たなシークレット/実値は追加しない

## 5. やらないこと
- DB 保管(mcp_servers テーブル)・封筒暗号・SECRET_ENC_KEY・設定画面 UI・command/args カタログ方式(028)
- builtin 撤去(get_server_time は存置。撤去は 028)
- 024 registry プリミティブ・025 ループ・src/routes/chat.js の変更
- register.js の登録契約(name/description/parameters/handler/origin)変更
- MCP prompts/resources、Streamable HTTP/SSE、RAG
- .env 実値の DB/設定ファイル/コミットへの露出、自ホスト IP/ホスト名のコミット
- リッチな .env 設定フォーマット(JSON blob 等)の作り込み(028 で DB へ移すため不要)

## 6. 完了条件
（実 DB を手動バックアップの上で確認。検証用の一時変更は最後に元へ戻す。.env はコミットしない）
1. loadMcpServers() が正規化配列 [{label,enabled,command,args,env}] を返し、searxng 1 エントリを含む
   (env に解決済み SEARXNG_URL。node -e 等で確認)
2. npm start で 026 と同一に searxng が接続・4ツールが <label>__<tool>・origin='mcp:searxng' で登録され、
   getEnabledToolSchemas に含まれる(回帰確認)
3. 実検索が 026 同様に成立(searxng ツールが呼ばれ実結果が最終回答に反映、messages は user+assistant のみ)
4. MCP_SEARXNG_ENABLED=false で searxng が接続・登録されず、通常チャット・get_server_time は正常。確認後戻す
5. 複数サーバーの一般化検証: loadMcpServers() に一時的に第2エントリ(同一 mcp-searxng、label='searxng2')を
   加えて起動 → 両サーバーが接続し searxng__* と searxng2__* が別 prefix・別 origin(mcp:searxng2)で
   共に登録される(衝突しない)ことを確認。確認後、第2エントリを除去して元に戻す
6. 片側失敗の隔離: 第2エントリの command を不正にして起動 → そのサーバーだけ失敗ログが出て、
   searxng 側とサーバー起動は正常継続。確認後戻す
7. シャットダウン: closeMcp() で全 MCP 子プロセスが終了(孤児なし)
8. 「設定の出所」を知るのは loadMcpServers() のみに閉じている(呼び出し側が .env キーを直接参照していない)
   ことをコード上で確認。検証用の一時変更をすべて戻し、DB バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する