# 是正: reasoning_content フォールバック(空応答の救済)

## 1. 目的
LLMがストリーム中に本来の回答を content ではなく reasoning_content 側に分類してしまった場合に、
PlainChat が「空応答」と宣言してしまう問題を救済する。delta.content が最後まで一度も来なかったときに限り、
蓄積した reasoning_content を思考タグ除去のうえ最終回答として採用するフォールバックを chat.js に追加する。

## 2. 対象
Phase 4 本流とは別枠の是正タスク(chat.js の LLM 応答処理)。DECISIONS.md「LLM空応答の切り分けと
chat.js の構造差分(NookResonance比較)」の是正方針(優先・小)に対応。履歴窓化・要約は本タスクに含めない(別枠)。

## 3. 前提・参照
- src/routes/chat.js は OpenAI互換 /chat/completions へ stream:true で送り、SSEを逐次パースして
  delta.content を蓄積・ストリームし、最終的に応答を保存する。現状 reasoning_content は一切読まない
- Spike 0 の観測: バックエンド(Gemma系)は content と reasoning_content を delta で別枠に返す。
  通常は content に本文、reasoning_content に思考。ただし境界検出の都合等で本文が reasoning_content 側に
  丸ごと入るケースがあり得る(その場合 content が空のまま終わる=現状「空応答」)
- 既存挙動: content が空のまま終わると「LLMの応答が空でした(思考トークン超過の可能性)」等で空応答扱い
- 025 のツール呼び出しループ: finish_reason='tool_calls' の中間ラウンドの扱い、tool_call/tool_result
  イベント、最終ラウンドの content ストリームは現状どおり。フォールバックは「最終的にユーザーへ返す
  アシスタント本文」の確定段でのみ効かせる(中間ツールラウンドの判定を壊さない)
- 中断・部分応答保存の既存ロジックを壊さない

## 4. 要件

### (a) reasoning_content の蓄積
- SSEパース中、delta.content と別に delta.reasoning_content も蓄積する(バッファを分ける)
- 既存の delta.content ストリーム/蓄積は一切変更しない(通常時の挙動は現状と完全同一)

### (b) フォールバック発動条件(厳格に限定)
- 「最終アシスタント応答を確定する時点で、その応答ラウンドの content が一度も来ておらず空」かつ
  「reasoning_content が非空」のときに限り、reasoning_content を最終本文として採用する
- content が少しでも流れていた場合はフォールバックしない(途中まで正常な content があれば、それが正)
- 中断(ユーザー切断)で content が途中まで来ていたケースは従来どおり部分応答保存。フォールバックは
  「content が最後まで皆無」の場合のみ
- 025 のツールループでは、中間の tool_calls ラウンドの content 非ストリームを空と誤認しないこと。
  フォールバックは「モデルがユーザー向け最終回答を返すべきラウンド(finish_reason='stop' 相当)」で
  content が空だったときにのみ評価する

### (c) 思考タグの除去
- reasoning_content を本文採用する際、<think>…</think> 等の思考タグ・明らかな思考枠マーカーを簡易に除去する
  (NookResonance の cleanLLMResponse 相当の考え方。ただしコードは移植せず PlainChat 独自に最小実装)
- 除去後に残った本文が空になる場合は、フォールバックせず従来どおり空応答扱い(タグだけで実体が無いなら救済しない)

### (d) 可視化・保存
- フォールバックで本文採用した場合、通常応答と同様にユーザーへストリーム/表示し、DBにも通常のアシスタント
  応答として保存する(保存経路は既存を流用。フォールバック由来である旨の内部ログは残してよいが、
  ユーザー向け表示に「フォールバックした」旨を出す必要はない)
- フォールバックが効かず本文が得られない場合は、従来の空応答挙動を維持

## 5. やらないこと
- 履歴の窓化・要約・トリム(別枠タスク)
- stop シーケンスの追加、enable_thinking:false 等の思考制御(別途検討)
- 025 ツールループの判定ロジック・tool_call/tool_result・上限/退避の変更
- src/mcp/* ・registry ・MCP 周りの変更
- reasoning_content を常時表示すること(あくまで content が皆無のときの救済のみ。通常時は従来どおり
  reasoning_content をユーザーに出さない)
- NookResonance のコード移植、.env 実値の変更

## 6. 完了条件
（実 DB を手動バックアップ。WAL込みで退避。検証用の一時変更は最後に戻す）
1. 通常時の回帰: content が正常に来る通常の会話で、挙動が現状と完全に同一(reasoning_content はユーザーに
   出ない、応答・保存は従来どおり)。ツールを使う会話(searxng)も従来どおり動く
2. フォールバック発動: content が空で reasoning_content のみが返るケースを再現し(例: 使い捨てスクリプトで
   content 空・reasoning_content 非空の SSE を模したモックレスポンス、または実バックエンドで再現できるなら実測)、
   reasoning_content が思考タグ除去のうえ最終本文として採用・表示・保存されることを確認
3. タグのみのケース: reasoning_content が思考タグだけで実体が無い場合、フォールバックせず従来の空応答挙動になる
4. 中断: content が途中まで来て中断された場合は従来どおり部分応答保存(フォールバックが誤発動しない)
5. ツールループ非干渉: 中間 tool_calls ラウンド(content 非ストリーム)をフォールバック対象と誤認せず、
   最終回答ラウンドでのみ評価される
6. reasoning_content や思考内容が、通常時にユーザーへ漏れないことを確認
7. 検証用の一時変更を戻し、DB バックアップを片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する