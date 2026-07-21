
# 039-fix: tool-invocations-body の折りたたみが効かない不具合修正

## 1. 目的
039で追加した折りたたみ(assistantメッセージ下のツール呼び出し表示)が、hidden属性を
JSで切り替えているにも関わらず常に展開表示されたままになる不具合を修正する。

## 2. 対象
039のバグ修正(未コミット)。

## 3. 前提・参照
- public/js/app.js の createToolInvocationsSection() は body.hidden = true / false で
  開閉を制御しているが、public/css/style.css の .tool-invocations-body が
  display: flex を無条件指定しているため、hidden属性によるdisplay:noneが上書きされ、
  常に展開表示になってしまっている

## 4. 要件
- public/css/style.css に `.tool-invocations-body[hidden] { display: none; }` を追加し、
  hidden属性が付いているときは確実に非表示になるようにする
  (既存の `.tool-invocations-body { display: flex; ... }` はそのまま残してよい。
  CSS内での記述順序・詳細度により [hidden] 側が優先されることを確認すること)
- app.js側のJSロジック(body.hidden の切り替え自体)は変更しない

## 5. やらないこと
- 039の他の実装(パーサー・SSE拡張・DBスキーマ等)の変更
- hidden属性からクラストグル方式への変更(最小差分で直す)

## 6. 完了条件
- ブラウザで実際にツール呼び出しを発生させ、初期状態で折りたたまれている
  (結果カードが見えない)ことを確認
- ヘッダークリックで開く→もう一度クリックで閉じる、が正しく動作することを確認
- ダークモード・モバイル幅(375px)でも開閉が機能することを確認
- 既存の他の折りたたみ・モーダル(mcpServerForm等)の表示に影響が出ていないことを確認

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する