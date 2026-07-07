# 025: ツール呼び出しループ(chat.js の multi-round 化)

## 1. 目的
チャットの生成を「1往復のSSE中継」から「ツール呼び出しループ」へ拡張する。モデルが tool_calls を
返す間はツールを実行して結果を戻し再送し、通常応答(stop)になったら最終回答をストリームする。
024で用意した登録型ツール基盤(getEnabledToolSchemas / getToolByName / handler)を消費する。

## 2. 対象
Phase 4(WEB検索 / RAG / ツール呼び出し)。025=呼び出しループ本体。
DECISIONS.md「ツール呼び出しループの制御方式(024の前提)」および同日の origin/MCP 方針転換に従う。
検証は 024 の builtin ダミー get_server_time のみで完結する(MCP・SearXNG には依存しない)。

## 3. 前提・参照
- 024完了済み。src/tools(registry)は以下を公開:
  - getEnabledToolSchemas(db): enabled=1 かつ登録済みツールを OpenAI 形式
    [{type:'function', function:{name, description, parameters}}] で返す(origin は含まない)
  - getToolByName(name): ディスパッチ用にツールを引く(handler(args) を持つ。origin 等のメタも保持)
- src/routes/chat.js の現行仕様: ユーザー発話保存 → OpenAI互換 /chat/completions へ stream:true で
  SSE中継 → 応答保存。LLMリクエストは Connection: close で使い捨て、model は未指定
  (textgen-webui のロード済みモデルを使用)。中断時は部分応答を保存、初トークン前失敗は
  ユーザー発話のみ残す。reasoning_content は content と別枠(Spike 0 で確認)
- Spike 0(2026-07-07)の観測: finish_reason は 'tool_calls'/'stop' で判別可能。stream:true でも
  tool_calls は1チャンクで完結する傾向だが単発検証のため、断片化に耐える実装にする。
  2ターン目は標準形式(assistant+tool_calls → tool+tool_call_id)がそのまま通る
- 制御env(.env.example に 024 で追記済み。ここで読み取る): TOOLS_ENABLED, TOOLS_MAX_ROUNDS

## 4. 要件

### (a) 制御envの読み取り
- TOOLS_ENABLED: 'true'/'false' を解釈。未設定・不正値は true とみなす
- TOOLS_MAX_ROUNDS: 整数。未設定・不正値は 4。最小 1 を保証(0以下は1に丸める)

### (b) ツール送信の条件
- TOOLS_ENABLED=true かつ getEnabledToolSchemas(db) が1件以上を返すときだけ、LLMリクエストに
  tools を含める。上記を満たさない場合は tools を一切付けず、現行(Phase 3)と完全に同一の
  単発挙動にフォールバックする(=安全弁)

### (c) ループ本体(1ユーザーターン内)
- 下流(ブラウザ)へのSSEストリームは、ターン全体で1本を維持する(各ラウンドで開き直さない)。
  上流(LLM)へのリクエストはラウンドごとに Connection: close で使い捨て、を踏襲する
- 各ラウンド: messages を送信 → ストリームを読みながら finish_reason・tool_calls・content・
  reasoning_content を仕分ける。tool_calls は index ごとにバッファ結合し、finish_reason 受領で確定する
- finish_reason='tool_calls' のラウンド(=中間ラウンド):
  - そのラウンドの assistant.content は最終回答として扱わない/ストリームしない
    (進捗は下記 tool_call/tool_result イベントで伝える)
  - 各 tool_call について順に:
    - SSEで tool_call イベントを送る(ペイロードは呼び出されたツール名のみ。引数は載せない)
    - function.arguments(JSON文字列)を安全にパース。失敗時はツールエラー結果として扱う
    - getToolByName で引く。未登録 or 無効(enabled=0 相当で getEnabledToolSchemas に無い)なら
      エラー結果として扱う
    - handler(args) を await。例外は try/catch で捕捉しエラー結果に変換(ループは落とさない)
    - 結果(成功/失敗いずれも)を role:'tool'・tool_call_id 付きで messages に追記(=in-memory のみ。
      DBには保存しない)。合わせて直前の assistant(tool_calls 付き)メッセージも messages に追記する
    - SSEで tool_result イベントを送る(ペイロードはツール名と status: 'success'|'error' のみ。
      結果本文は載せない)
  - ラウンド数をインクリメントして次ラウンドへ
- finish_reason='stop' のラウンド(=最終ラウンド): content を現行どおり delta でストリームし、
  done で締める。この content を最終アシスタント応答として扱う
- 上限到達: ラウンド数が TOOLS_MAX_ROUNDS に達したら、次の送信は tool_choice:'none' を指定して
  再送し、モデルにツール無しで最終回答させる(空回答で終わらせない)。この応答を最終回答とする

### (d) SSEイベント種別
- 既存: delta / done / error は維持
- 追加: tool_call(ツール名のみ)/ tool_result(ツール名 + status)
- 既存フロントが未知イベントで壊れないこと(名前付きイベントはリスナ未登録なら無視される想定)。
  フロントでの見せ方(「実行中…」表示等)の実装は 025 の必須範囲外(イベントを出すところまでが025)

### (e) 永続化(方針どおり)
- ユーザー発話は現行どおり開始時に保存。最終アシスタント応答(最終ラウンドの content)のみ保存する
- ツール往復(assistant+tool_calls / role:'tool' 結果)は DB に保存しない。messages のスキーマ・
  ロール(system/user/assistant)は変更しない

### (f) 中断・エラー
- 中断: 既存の部分応答保存を踏襲。最終回答のストリーム中に中断されたら、その時点までの content を保存。
  中間ツールラウンド中(最終 content がまだ無い)に中断されたら、初トークン前失敗と同様に
  ユーザー発話のみ残す(新規保存なし)
- ツール実行失敗・未登録・引数パース失敗はいずれも (c) のとおりエラー結果としてモデルに返し、
  ループを継続する(サーバーは落とさない)
- 上流LLM呼び出し自体の失敗は既存のエラーハンドリング(error イベント)を踏襲

## 5. やらないこと
- src/tools(registry・024)の変更。MCP クライアント/接続/tools/list 等(026)
- DB スキーマ/ロールの変更、messages への tool 行の保存
- generate-title 等のツールを使わない他経路の変更(タイトル生成はツール非対象)
- uploads / auth / 認可方針の変更
- フロントの tool_call/tool_result 表示UIの作り込み(必須外。イベント発火までが025)
- .env(実値)の変更(.env.example は 024 で追記済み。ここでは読み取るだけ)
- WEB検索・SearXNG・RAG 等の実用ツール(MCP経由・026以降)

## 6. 完了条件
（既存DBを手動バックアップの上で確認し、検証用の一時変更は最後に元へ戻すこと）
1. TOOLS_ENABLED=true で、get_server_time を呼ばせるプロンプト(例:「サーバーの現在時刻を教えて」)を送ると、
   ループがツールを実行し、SSEに tool_call・tool_result(status:'success')が流れ、最終回答に時刻が
   反映される。ターン後の messages はユーザー1行+アシスタント1行のみで、'tool' 行や tool_calls は
   保存されていない(node -e / better-sqlite3 で確認)
2. ツールを要さないプロンプト(例:「こんにちは」)では tool_calls は発生せず、単発ラウンドで
   現行どおり応答・保存される
3. TOOLS_ENABLED=false で起動すると tools が送られず、Phase 3 相当の単発挙動に戻る
   (ツール可視化イベントも出ない)
4. 上限到達: TOOLS_MAX_ROUNDS=1 に設定し、ツールを呼ぶプロンプトを送ると、1回のツールラウンド後の
   再送で tool_choice:'none' が指定され、モデルがツール無しで最終回答を返す(ループが無限化しない)
5. ツール失敗: get_server_time の handler を一時的に throw させると、ループは落ちず、
   tool_result の status が 'error' になり、モデルはエラーを踏まえた最終回答を返し、サーバーは継続稼働する。
   確認後コードを戻す
6. 中断: 最終回答のストリーム中に中断すると部分応答が保存される。中間ツールラウンド中に中断すると
   ユーザー発話のみ残る
7. reasoning_content が従来どおり別枠で扱われ、tool_calls 判定や最終 content を汚染しない。
   空応答(reasoning budget)の既存挙動が壊れていない
8. 検証用に変更した env / コードをすべて元に戻し、一時バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する