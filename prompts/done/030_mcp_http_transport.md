# 030(続行): HTTPトランスポート対応 — 退避整備・明示リロード・残completion

## 1. 目的
HTTPトランスポート対応(030)のうち、既に実装済みの (a) 分岐に続き、接続の退避整備・管理者の明示リロード・
残りの動作確認を完了させる。実 NookResonance への接続・登録は実証済みのため、本続行では退避の堅牢化と
運用に必要なリロード導線、および回帰/後始末の確認を仕上げる。

## 2. 対象
Phase 4 / 030(続行分)。DECISIONS.md「MCPはHTTP主軸へ方針転換(思想3)」「タスク順を再入れ替え」に従う。
既定引数機構(user_id 等のサーバー既定引数)は含めない(次タスク)。builtin撤去=031。

## 3. 前提・参照(実装済みの現状)
- 【実装済み(a)】src/mcp/client.js の connectServer() に transport 分岐を追加済み。
  transport==='http' で StreamableHTTPClientTransport(new URL(url), { requestInit:{ headers } }) を使用。
  stdio 経路は無変更。実 NookResonance(label='nookresonance', transport='http')へ接続成功し、
  nookresonance__get_character_profile(origin='mcp:nookresonance')が登録されることを確認済み。
  ログに Authorization/トークンが出ないことも確認済み
- loadMcpServers()(027/028a)は {transport:'http', url, headers:{Authorization:...}} を正しく返す。
  029の設定画面から http 行を登録可能。secretBox で headers を復号
- initMcp/closeMcp(src/mcp/index.js)、register.js、025ループ、024 registry は本続行で契約変更しない
- SDK v1.x、package.json "type":"commonjs"(SDK は動的 import)。Node は Windows 環境
- 【テスト前提】ユーザーが設定画面から登録済みの label='nookresonance' http 行が DB にある(実接続可)。
  トークンは DB 暗号文のみ。指示文/コード/ログに値を書かない
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件(残り)

### (b) 接続の退避を要件どおり整備(src/mcp/client.js / index.js)
- 既に「失敗しても continuing without it」でサーバー起動は継続する。これを次の観点で堅牢化する:
  - 接続/initialize 時の 401(認証失敗)を「接続失敗」として明示的に扱いスキップ(他サーバー・起動は継続)
  - 接続タイムアウトの上限を設ける(無応答の http サーバーで initMcp が停止しないこと)
  - 失敗ログに Authorization/トークン/ヘッダ値を出さない(伏字)。失敗理由の種別(到達不能/401/タイムアウト/
    初期化失敗 等)は残してよい
- 稼働中の tools/call 時の 401・ツールエラーは 025 のループがツール失敗として処理(handler が throw →
  025 が tool_result:error)。ここは既存経路で処理される想定。追加改修は不要だが、handler が
  トークンを例外メッセージに載せないことを確認する

### (c) 明示リロード(src/mcp/index.js + src/routes/mcpAdmin.js + public/)
- reloadMcp(): closeMcp() → initMcp() を安全に実行。二重実行を防ぐガード(実行中フラグ等)を設け、
  短時間の連打で競合しないこと
- POST /api/mcp/reload(管理者のみ、requireAdmin)を追加し reloadMcp() を呼ぶ。レスポンスは
  接続成功サーバーのラベル一覧と、失敗ラベル+理由種別の要約(トークン伏字)
- UI(public/): MCP設定画面に「MCP再接続」ボタン(管理者のみ)を追加、POST /api/mcp/reload を叩き結果表示。
  029で入れた「保存しても実接続はされない」注記を、「再接続ボタンまたは再起動で反映」に更新
- 起動時接続は現状どおり(initMcp が enabled の stdio/http 全行を接続)

### (d) テスト用スタブ(任意)
- 実 NookResonance 行が無い環境でも (b) の退避や tools/call 一周を自動検証できるよう、test/ 配下に
  最小 Streamable HTTP MCPスタブ(1ツール・固定応答・任意/固定Bearer受理)を置いてよい。
  置く場合も本体(src/)には含めない。無くても可

## 5. やらないこと
- 既定引数機構(user_id 等)= 次タスク
- 025ループ・024 registry・register.js の登録契約・secretBox・028a/029 API 契約の変更
- stdio(026)経路のロジック変更(既に入った http 分岐以外は触れない)
- builtin撤去(031)、per-user のサーバー/ツール使用可否(将来)
- 実 NookResonance URL 以外の秘密の指示文/コード/ログ/コミットへの記載(トークンは DB 暗号文のみ)
- 旧 HTTP+SSE の実装、.env 実値の変更

## 6. 完了条件
（実 DB を手動バックアップ。WALのため .db-wal/.db-shm も含めるか VACUUM INTO。検証用の一時行/変更は
  最後に元へ戻す。トークンを一切出力しない)
1. 【回帰・実装済みの再確認】起動時に searxng(stdio)と nookresonance(http)が接続され、
   searxng__* と nookresonance__get_character_profile(origin='mcp:nookresonance')が登録される。
   ログにトークンが出ない
2. 退避(到達不能): 到達不能な url のダミー http 行を一時投入して起動 → 当該サーバーはスキップ、
   失敗ログ(伏字)、他サーバー・起動は継続。タイムアウト上限で initMcp が停止しない。確認後ダミー行削除
3. 退避(401): 不正な認証ヘッダのダミー http 行で接続 → 401 を接続失敗としてスキップ、起動継続、
   トークン値がログに出ない。確認後削除
4. 明示リロード: 管理者で POST /api/mcp/reload → closeMcp→initMcp が走り、接続結果の要約(伏字)が返る。
   短時間連打で二重実行ガードが効く(競合・多重接続が起きない)
5. リロード反映: enabled を DB で切り替えてから /api/mcp/reload → 反映される(有効化で接続、無効化で切断)
6. UI: 管理者に「MCP再接続」ボタンが見え、押下で結果表示。非管理者には出ない。029の注記が更新されている
7. stdio(searxng)が 026 同様に動作(実検索が最終回答に反映)。回帰なし
8. シャットダウンで stdio 子プロセスが終了、http 接続がクローズされる(孤児・リーク無し)
9. 【実 tools/call はユーザー手動】nookresonance__get_character_profile を user_id/キャラ名を伴って
   呼ぶ実会話確認はユーザーが手動で実施(system_prompt にテスト user_id、会話でキャラ名)。
   Claude Code 側は接続・登録・スキーマ反映・退避・リロードまでを自動確認する
10. 今回のバグ修正(connectServer の http 分岐)を含む差分をレビュー可能な状態にし、検証用の一時変更を
    すべて元へ戻し、DB バックアップを片付けて完了。トークンがログ/レスポンス/コミットのどこにも出ていないことを最終確認

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する