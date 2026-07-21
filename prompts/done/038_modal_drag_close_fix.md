# 038: モーダルのドラッグ誤クローズ修正(MCP設定 + 汎用モーダル)

## 1. 目的
モーダル上でテキスト選択などのドラッグを行い、mouseup がオーバーレイに着地したときに
モーダルが誤って閉じ、入力がやり直しになる問題を直す。

## 2. 対象
改善フェーズ(UIの粗潰し)。新機能なし。

## 3. 前提・参照
- 現象: MCP設定モーダルで入力欄からドラッグするとモーダルが閉じてやり直しになる(PC)。
- 原因: オーバーレイのクローズ判定が click の着地点のみで行われている。
  mousedown がモーダル内 → mouseup がオーバーレイだと、共通祖先で click が発火して閉じる。
- 対象は public/js/app.js にある次の **2箇所** の overlay クリッククローズ:
  (a) 汎用モーダル(グローバル設定 / 会話設定)。「設定モーダル」セクション末尾:
        modalOverlay.addEventListener('click', (e) => {
          if (e.target === modalOverlay) closeModal();
        });
  (b) MCP設定モーダル。「MCPサーバー設定モーダル」セクション:
        mcpModalOverlay.addEventListener('click', (e) => {
          if (e.target === mcpModalOverlay) closeMcpAdminModal();
        });
- 対象外(今回は触らない):
  - MCPの追加/編集フォーム mcpServerForm は overlay ではなく hidden 切替の内側フォーム。
  - サイドバードロワー sidebarOverlay はモーダルではない(モバイル用ドロワー)。除外する。
- Esc での閉じは document の keydown リスナ(modalOverlay / mcpModalOverlay 両対応)で
  行われている。これは変更しない。
- フロントはビルドなし。キャッシュ罠: 変更した js は index.html の ?v= を必ず上げる
  (現在は全て ?v=036)。

## 4. 要件
- オーバーレイ・クリックでの閉じ判定を「mousedown の発生元もオーバーレイ自身だったときのみ閉じる」
  に変更する。実装は小さな共通ヘルパにまとめてよい(過剰な抽象化はしない)。例:
      function attachOverlayClickToClose(overlayEl, closeFn) {
        let downOnOverlay = false;
        overlayEl.addEventListener('mousedown', (e) => {
          downOnOverlay = (e.target === overlayEl);
        });
        overlayEl.addEventListener('click', (e) => {
          if (downOnOverlay && e.target === overlayEl) closeFn();
          downOnOverlay = false;
        });
      }
  これを modalOverlay(closeModal)と mcpModalOverlay(closeMcpAdminModal)の両方に適用し、
  既存の2つの click ハンドラを置き換える。
- ×ボタン・Esc での閉じる、保存/キャンセル等の既存挙動は不変。
- モーダル外の素直なクリック(mousedown も mouseup もオーバーレイ)では従来どおり閉じること。

## 5. やらないこと
- モーダルのデザイン・レイアウト変更。
- モーダルの開閉以外のロジック(保存 / バリデーション / API / フォーム表示切替)の変更。
- sidebarOverlay(ドロワー)の挙動変更。
- バックエンド / API / .env の変更。
- ドラッグ・テキスト選択そのものの抑止(選択は許可したまま、誤クローズだけ止める)。

## 6. 完了条件
1. MCP設定モーダル(管理者)で入力欄内から文字列をドラッグ選択し、マウスをオーバーレイ上で
   離してもモーダルが閉じないこと。
2. 汎用モーダル(グローバル設定 / 会話設定)でも同様に閉じないこと。
3. 各オーバーレイの何もない所を素直にクリック(押した場所で離す)すると従来どおり閉じること。
4. ×ボタン・Esc での閉じるが両モーダルで従来どおり動くこと。
5. 変更した js の ?v= を 038 に上げ、PC実機で反映を確認すること。
6. 開発者ツールのコンソールに未処理エラーが出ていないこと。
7. MCP設定モーダルは管理者ゲート(is_admin)のため、検証には is_admin=1 の一時ユーザーが必要。
   検証用に作成した一時ユーザーは検証後に削除すること。

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う。
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する。
