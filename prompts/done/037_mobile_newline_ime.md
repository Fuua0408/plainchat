# 037: モバイルでの改行対応 + PC日本語IME誤送信ガード

## 1. 目的
スマホの入力欄でメッセージに改行を入れられるようにする。あわせて、PCでの
日本語IME変換確定Enterによる誤送信を防ぐ。

## 2. 対象
改善フェーズ(実用機能の粗潰し)。新機能なし。

## 3. 前提・参照
- v1完成・実運用中。フロントはビルドなしの素のHTML/CSS/JS。
- 該当箇所は public/js/app.js 末尾付近(「ログイン・ログアウト」セクションの直前)にある、
  chatInput への keydown ハンドラ **1箇所のみ**。現状は次の実装:
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          chatForm.requestSubmit();
        }
      });
  スマホのソフトキーボードには Shift が無いため Enter が常に送信に化け、改行を入れられない。
  また現状は IMEガードが無く、日本語変換確定のEnterでも送信されてしまう。
- 送信ボタン(sendBtn)は type="submit" で chatForm の submit → handleSend に繋がっている。
  よってモバイルで Enter を奪わなくても、送信ボタンからの送信は従来どおり機能する。
- モバイル判定は既存のレスポンシブ規約 @media(max-width:768px) に揃え、
  window.matchMedia('(max-width:768px)').matches を使う。判定はハンドラ内で毎回評価し、
  リサイズ/画面回転に追従させること(モジュール読み込み時に一度だけ評価して固定しない)。
- リネーム入力欄(startRenameConversation 内の input.addEventListener('keydown', ...))は
  別機能。今回は触らない。
- キャッシュ罠: css/js を変更したら index.html の該当リンクの ?v= を必ず上げる。
  現在は全て ?v=036。上げないと実機ブラウザが旧資産を掴み、変更が実機で反映されない。

## 4. 要件
- モバイル(window.matchMedia('(max-width:768px)').matches が真)のとき:
  Enter を奪わない(preventDefault も requestSubmit もしない)。改行は既定動作に任せ、
  送信は送信ボタンのみとする。
- デスクトップ(上記が偽)のとき:
  従来どおり Enter で送信、Shift+Enter で改行を維持する。
  ただし IME変換中は送信しない: e.isComposing が真、または e.keyCode === 229 の場合は
  送信処理をスキップする(この場合 preventDefault もしない=変換確定を妨げない)。
- 変更は上記 chatInput の keydown ハンドラ内に閉じること。handleSend 本体は変更しない。
- (任意)index.html の chatInput プレースホルダ「Enterで送信、Shift+Enterで改行」は
  デスクトップ前提の文言。モバイルで誤解を招くため簡潔に調整してよい。対応した場合は方式を報告。

## 5. やらないこと
- 送信ロジック本体(handleSend)・ストリーミング・添付まわりの変更。
- リネーム入力欄の keydown(startRenameConversation)の変更。
- モバイルレイアウト(@media 内)のこの件以外の変更。PC(2カラム)の既存ルールは触らない。
- バックエンド / API / .env の変更。送信ボタンの見た目変更。

## 6. 完了条件
1. 実機(Android)またはモバイル幅+タッチのエミュレーションで、入力欄の改行キーで
   改行が入り送信されないこと。送信ボタンで送信できること。※実機を正とする。
2. PC(768px超)で Enter送信・Shift+Enter改行が従来どおり動くこと。
3. PCで日本語入力中、変換候補確定のEnterで送信されず、確定後の追加Enterで送信されること。
4. ウィンドウをモバイル幅↔PC幅にリサイズし、各挙動が切り替わること。
5. 変更した js(必要なら css / index.html)について ?v= を 037 に上げ、実機で新挙動が
   反映されることを確認すること。
6. 開発者ツールのコンソールに未処理エラーが出ていないこと。
7. 検証用に一時ユーザーを作成した場合は、検証後に削除すること
   (bcryptで作成→検証後削除の確立済み手法)。

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う。
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する。
