# 033: MCP子プロセスの孤児化防止(異常終了時の後始末)

## 1. 目的
Node が正常なシャットダウン経路(SIGINT/SIGTERM→closeMcp)を通らずに終了した場合でも、MCP(stdio)の
子プロセスが孤児として残らないよう、異常終了経路からも後始末を確実化する。発生源を塞ぐ「予防」に集中し、
起動時の残留プロセス掃除は行わない(Windows でのプロセス特定が困難・誤爆リスクのため)。

## 2. 対象
安定性の宿題タスク(033)。MCP の機能追加ではなく、ライフサイクルの堅牢化。
HANDOVER「宿題: クラッシュ時の子プロセス後始末」に対応。既定引数機構は 034(別タスク)。

## 3. 前提・参照
- src/mcp/client.js: connectServer(serverConfig) が stdio(子プロセス起動)/http を接続。stdio は
  StdioClientTransport 経由で mcp-searxng 等を子プロセスとして起こす
- src/mcp/index.js: initMcp()/closeMcp()/reloadMcp()。closeMcp() は現状 SIGINT/SIGTERM ハンドラと
  reloadMcp から呼ばれ、各 MCP クライアントを close(子プロセス終了)する
- src/index.js: 起動時に initMcp、SIGINT/SIGTERM で closeMcp。app.listen(18091)
- 観測済み問題(032): app.listen の EADDRINUSE が未捕捉例外で落ち、SIGTERM 経路を通らないため
  stdio 子プロセスが孤児化した。Windows は外部/デタッチ済みプロセスへ正規シグナルを送りにくく
  (taskkill /F 前提)、孤児 node.exe が溜まる
- 制約: uncaughtException 等のハンドラ内での非同期 close は「プロセスが落ちきる前に完了する」保証が弱い。
  よって「発生確率を大きく下げるベストエフォート」がゴールであり、100%保証は狙わない(過剰実装を避ける)
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) 子プロセスハンドル/PID の把握
- stdio 接続時、起動した子プロセス(またはその PID)を、後始防衛で同期 kill できるよう保持する仕組みを設ける
  (client.js が管理下の stdio クライアントの子プロセス参照を index.js/index側の後始末から辿れるようにする、
   あるいは PID の集合を保持する等。既存の closeMcp が持つ管理構造を流用してよい)
- http 接続には子プロセスが無いため対象外(close でネットワーク接続を閉じるのみ)

### (b) app.listen のエラー捕捉
- app.listen に error ハンドラを付け、EADDRINUSE 等の起動時エラーを未捕捉例外にしない。
  エラー時は closeMcp()(可能な範囲で)を試み、明示的なログを出して整然と終了する
  (既に initMcp 済みで子プロセスが起きている状態で listen が失敗しても、子プロセスを残さない)

### (c) 異常終了経路からの後始末
- process.on('uncaughtException') / process.on('unhandledRejection') を追加し、ログ出力のうえ
  closeMcp() を試みてから終了する(二重終了・ハンドラ内エラーで無限ループしないようガード)
- これらは「アプリを継続させる」ためではなく「落ちる前に後始末する」ため。後始末後は非ゼロ終了でよい

### (d) exit での同期 kill 最終防衛
- process.on('exit') は同期処理のみ実行可能。ここで、保持している stdio 子プロセスの PID に対して
  同期的に kill を撃つ最終防衛を実装する(非同期 close が間に合わなかった場合の保険)
- Windows での同期 kill が確実に子プロセスを終了させるか(child.kill / process.kill(pid) の効き方)は
  実装時に検証する。効きが不十分な場合は、確実に効く手段(例: 適切なシグナル/強制終了)に切り替える。
  ただし kill 対象は「自分が起動した stdio 子プロセスの PID」に厳密に限定し、無関係プロセスを殺さない

### (e) 既存の正常経路を壊さない
- 既存の SIGINT/SIGTERM→closeMcp、reloadMcp→close の動作は変更しない(追加のみ)
- 二重に closeMcp/kill が走っても安全(冪等・多重ガード)にする

## 5. やらないこと
- 起動時の残留(前回の孤児)プロセスの検出・掃除(Windows でのプロセス特定困難・誤爆リスクのため対象外)
- MCP の機能・接続ロジック・register.js/025ループ/024 registry/secretBox の変更
- http トランスポート側の変更(子プロセスが無いため)
- 既定引数機構(034)、履歴窓化、RAG
- 無関係な node.exe への kill(kill は自分が起こした stdio 子プロセスの PID に厳密限定)
- .env 実値の変更

## 6. 完了条件
（実 DB を手動バックアップ。WAL込み。検証用の一時変更は最後に戻す。kill は自分の子プロセス限定を厳守）
1. 正常経路の回帰: 通常起動→Ctrl+C(または SIGTERM 相当)で closeMcp が走り、stdio 子プロセスが終了する
   (孤児なし)。searxng/nookresonance の接続・reload は従来どおり動作
2. EADDRINUSE 再現: 18091 を別プロセスが使用中の状態で起動→app.listen error が捕捉され、未捕捉例外で
   落ちず整然と終了し、この起動で起こした stdio 子プロセスが残らない(プロセス一覧で確認)
3. uncaughtException/unhandledRejection 再現: 意図的に未捕捉例外/未処理 rejection を発生させる一時コードで、
   ハンドラが closeMcp を試みてから終了し、子プロセスが残らない(確認後に一時コードを除去)
4. exit 同期 kill: 非同期 close が間に合わない状況(例: close 前に強制的に exit へ向かうケース)を模して、
   exit ハンドラの同期 kill で子プロセスが終了することを確認。kill 対象が自分の子プロセス PID に
   限定されていること(無関係 node.exe が生存)を確認
5. 冪等性: 二重に終了経路が走っても多重 kill でエラー/誤爆が起きない
6. Windows 上での同期 kill の実効性を確認(効かない場合は確実な手段へ切替済み)
7. 検証用の一時コード・変更をすべて除去し、DB バックアップを片付けて完了。最終的に検証で起こした
   MCP 子プロセスの孤児が残っていないことをプロセス一覧で確認

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する