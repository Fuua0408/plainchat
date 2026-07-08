# 031: builtin撤去 + sync契約見直し(孤児tools対策) — MCP化の仕上げ

## 1. 目的
検証用 builtin(get_server_time)と後方互換 seed を撤去し、ツールの登録源を MCP のみに一本化する
(「DBが唯一の源」の形に到達)。あわせて syncToolsToDb の契約を見直し、削除済み MCP サーバーの
ツール行が tools 台帳にゾンビとして残り LLM に混入する問題を解消する。これにより Phase 4 の MCP 土台を
実運用可能な状態で仕上げる。

## 2. 対象
Phase 4 / 031(MCP化の仕上げ)。DECISIONS.md「MCPはHTTP主軸へ方針転換(思想3)」「syncToolsToDb の
孤児tools問題を031で見直す」に従う。撤去するのは検証用の中身(get_server_time・builtinローダ・
'builtin' origin値・後方互換seed・DEBUG_searxng依存)であり、stdio(ローカル系)の枠は searxng として存続。

## 3. 前提・参照
- 024: registry(register/getRegisteredTools/getToolByName/buildOpenAIToolSchemas/getEnabledToolSchemas/
  syncToolsToDb)、tools テーブル(origin 付き)。syncToolsToDb は現状 upsert のみで削除/無効化しない
- 026/027/030: MCP クライアント(stdio + http)、loadMcpServers()、initMcp が enabled 行を接続し
  register.js が <label>__<tool>・origin='mcp:<label>' で登録
- 028a: 後方互換 seed(src/mcp/seed.js、mcp_servers 空 かつ DEBUG_searxng 設定時に searxng を暗号化seed)
- 029: 設定画面から MCP サーバーを追加可能(searxng は DB の mcp_servers 行として管理済み)
- src/tools/index.js が builtin(serverTime)を require して自己登録、src/index.js 起動時に
  builtin読込→(後方互換seed)→MCP接続+登録→syncToolsToDb の順
- 現状 searxng 行は seed 由来で DB に存在し、env(SEARXNG_URL)が暗号化格納済み(030までで実接続実証済み)
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) builtin 撤去
- src/tools/builtin/serverTime.js を削除
- src/tools/index.js の builtin 読み込み(serverTime の require/自己登録)を削除。
  builtin が無くなっても registry の register/getter 群・MCP 登録経路は従来どおり機能すること
- ツール定義・registry・tools 台帳から origin の 'builtin' 値の概念を撤去(今後 origin は 'mcp:<label>' のみ)。
  origin 列自体は存続(値が mcp:* だけになる)
- 既存 DB に残っている get_server_time の tools 行は、(c) の sync 見直しで登録源に無い=無効化される経路、
  もしくは本タスクの一度きりのクリーンアップで除去する(下記完了条件で確認)

### (b) 後方互換 seed・DEBUG_searxng 依存の撤去
- src/mcp/seed.js(後方互換 seed)を削除し、src/index.js の起動シーケンスから seed 呼び出しを外す
- loadMcpServers()/config.js から DEBUG_searxng の参照を撤去する。searxng の接続先は mcp_servers の
  searxng 行(stdio型・env 暗号化)からのみ得る(028aで seed 済みの行が正)
- .env.example から DEBUG_searxng / MCP_SEARXNG_ENABLED のプレースホルダを撤去(または「廃止」の注記に置換)。
  .env(実値)は変更しないが、DEBUG_searxng はもう参照されない旨をコメントで残してよい
- 結果として、DB が空の新規環境では searxng は自動生成されない。以後は設定画面からの追加が正規手順
  (「DBが唯一の源」)。この挙動変更を許容する

### (c) syncToolsToDb 契約の見直し(孤児tools対策・慎重方式)
- syncToolsToDb を「接続に成功した登録源のツール一覧に存在しないツール行は enabled=0 に無効化する」へ変更:
  - initMcp の結果(接続成功サーバーのラベル集合)を sync に渡せるようにする
  - 各 tools 行について、その origin('mcp:<label>')が「今回接続成功したサーバー」に属する場合のみ、
    現在の登録ツール集合と照合し、登録に無ければ enabled=0(無効化。行は削除しない)
  - 接続に失敗したサーバー('mcp:<label>' がこの回の接続成功集合に無い)のツール行は触らない
    (一時的な接続失敗で無効化しないため。前回の enabled 等を保持)
  - 接続成功サーバーに再登場したツールは通常どおり upsert(必要なら enabled を 1 に戻すかは下記方針)
- enabled の扱い: ユーザーが設定画面等で明示的に enabled=0 にしたものを、再接続時に勝手に 1 へ戻さない。
  「sync による無効化(サーバーから消えた)」と「ユーザーによる無効化」を区別できるようにするか、
  少なくとも sync が既存 enabled をむやみに上書きしない設計にする(実装が過剰になる場合は、
  再登場ツールは enabled を据え置き=ユーザー設定尊重、を既定とする)
- ゾンビ混入の解消: getEnabledToolSchemas は enabled=1 のみを返すため、無効化された孤児は LLM に送られない

### (d) 起動シーケンスの整理(src/index.js)
- builtin読込・seed を除いた新順序: MCP接続+登録(initMcp)→ その接続成功集合を用いた syncToolsToDb。
  builtin が無くなったことで初期 registry は空から始まり、MCP 接続で埋まる

## 5. やらないこと
- 025 ツールループ・register.js の登録契約・secretBox・028a/029 の API 契約・030 の http/reload の変更
- 履歴窓化・要約(別枠)、既定引数機構(次タスク)
- mcp_servers スキーマの変更(tools 台帳の enabled 運用のみ)
- searxng 行そのものの削除(searxng は存続。撤去するのは builtin と seed 機構であって searxng ではない)
- per-user のツール/サーバー使用可否(将来)
- .env 実値の変更、シークレットのログ/レスポンス露出

## 6. 完了条件
（実 DB を手動バックアップ。WAL込みで退避。検証用の一時変更は最後に戻す）
1. 起動時に serverTime 関連のエラーが出ず、get_server_time が registry に登録されない。searxng(stdio)/
   nookresonance(http)は従来どおり接続・登録される(回帰)
2. tools 台帳から get_server_time が除去され(無効化 or 削除)、getEnabledToolSchemas に現れない。
   origin は mcp:* のみになる
3. 後方互換 seed が撤去され、seed 由来の自動生成が起きない。DEBUG_searxng を参照するコードが無い
   (grep で config.js 等に DEBUG_searxng 参照が残らないことを確認)。既存の searxng 行は生きており実検索が通る
4. 孤児対策(慎重方式)の検証:
   (i) 接続成功サーバーからツールが消えた状況を再現(例: 一時的に別ラベルのダミー MCP サーバーを接続→
       ツール行が登録される→そのサーバーの提供ツールを減らす/切替えて再接続)→ 消えたツール行が enabled=0 に
       無効化され、getEnabledToolSchemas から外れる。行自体は残る
   (ii) 接続失敗サーバーのツール行は無効化されない(例: nookresonance を一時到達不能にして再接続→
       nookresonance__* の行は enabled 据え置きで無効化されない)
   (iii) ユーザーが enabled=0 にしたツールが、再接続の sync で勝手に 1 へ戻らない
5. 新規環境の挙動: 空DB(またはコピー)で起動すると searxng は自動生成されず、設定画面から追加すれば
   正規に登録・接続される(「DBが唯一の源」)
6. reloadMcp/POST /api/mcp/reload(030)後も sync 契約が同様に効く(リロードでも孤児が無効化される)
7. 検証用の一時サーバー行・ツール行・変更をすべて元に戻し、DB バックアップを片付けて完了。
   最終状態で tools 台帳が実在の MCP ツール(searxng 4 + nookresonance 1 等)のみ・origin=mcp:* で構成される

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する