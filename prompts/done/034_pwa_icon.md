# 034: PWA対応(ホーム画面アイコン / manifest)

## 1. 目的
Android(Chrome)等のブラウザから「ホーム画面に追加」でアプリのように起動でき、ホーム画面に PlainChat の
アイコンが表示されるようにする。manifest.json とアイコン画像を用意し、standalone 表示・テーマ色を宣言する。
Service Worker は導入しない(オフライン対応は将来必要になってから)。

## 2. 対象
v1後の小改修(034)。フロントの静的追加のみ。chat.js・MCP・DB・認証には一切触れない。
HANDOVER「v1完成」後の追加タスク。

## 3. 前提・参照
- public/ は素の HTML/CSS/JS(ビルドなし)。index.html がエントリ、静的配信は src/index.js(express.static 等)
- UI テーマ色は青系 #2563eb(ユーザー吹き出し/主要ボタン)。背景は白 #ffffff
- 画像変換に sharp(または同等)を dev 依存として使ってよい。無ければ導入する
- prompts/ 配下は指示書。移動以外の編集はしない

## 4. 要件

### (a) アイコンのマスター SVG を配置
- 下記2つのマスター SVG を public/icons/ に保存する(青地 #2563eb・白の吹き出し+P。
  通常版は角丸、maskable 版は記号を小さめにして外周へ安全余白を確保):

  public/icons/icon.svg(通常版、正方形 512x512 相当):
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect x="0" y="0" width="512" height="512" rx="115" fill="#2563eb"/>
    <path d="M140 147 h230 a45 45 0 0 1 45 45 v128 a45 45 0 0 1 -45 45 h-122 l-70 64 v-64 h-38 a45 45 0 0 1 -45 -45 v-128 a45 45 0 0 1 45 -45 z" fill="#ffffff"/>
    <text x="256" y="300" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="166" font-weight="500" fill="#2563eb">P</text>
  </svg>

  public/icons/icon-maskable.svg(maskable 版、記号を中央寄せ・外周に安全余白。背景ベタ塗り全面):
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <rect x="0" y="0" width="512" height="512" fill="#2563eb"/>
    <path d="M166 172 h180 a38 38 0 0 1 38 38 v96 a38 38 0 0 1 -38 38 h-96 l-58 52 v-52 h-26 a38 38 0 0 1 -38 -38 v-96 a38 38 0 0 1 38 -38 z" fill="#ffffff"/>
    <text x="256" y="290" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="134" font-weight="500" fill="#2563eb">P</text>
  </svg>

- フォントは環境依存を避けるため上記のとおり汎用 sans(Arial/Helvetica)指定。P が中央からずれる場合は
  text の x/y・font-size を微調整して視覚的に中央へ収めてよい(青地・白吹き出し・白抜きでない青の P、という
  構成は変えない)

### (b) PNG 書き出し
- 上記 SVG から以下の PNG を public/icons/ に生成する(sharp 等で SVG→PNG):
  - icon-192.png(192x192、通常版 icon.svg から)
  - icon-512.png(512x512、通常版 icon.svg から)
  - icon-maskable-512.png(512x512、icon-maskable.svg から)
  - apple-touch-icon.png(180x180、通常版 icon.svg から。iOS Safari 用)
- 生成は一度きりの手順でよいが、再生成できるよう scripts/ に変換スクリプトを置くのは可(必須ではない)

### (c) manifest.json
- public/manifest.json を作成:
  - name: "PlainChat"、short_name: "PlainChat"
  - start_url: "/"、scope: "/"
  - display: "standalone"
  - background_color: "#ffffff"、theme_color: "#2563eb"
  - icons: icon-192.png(192, purpose "any")、icon-512.png(512, purpose "any")、
    icon-maskable-512.png(512, purpose "maskable")
  - lang: "ja"(任意)

### (d) index.html への link/meta 追加
- public/index.html の <head> に追加:
  - <link rel="manifest" href="/manifest.json">
  - <meta name="theme-color" content="#2563eb">
  - <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  - <link rel="icon" href="/icons/icon-192.png">(favicon 兼用でよい)
- 既存の <head> 内容・スクリプト読み込み順を壊さない

### (e) 静的配信の確認
- /manifest.json と /icons/* が既存の静的配信で配信されること(配信対象外なら express.static の対象に含める)。
  認証を要するパスに置かない(ホーム追加時に未ログインでも manifest/アイコンは取得できる必要がある)

## 5. やらないこと
- Service Worker の導入・オフライン対応・キャッシュ制御(将来必要になってから)
- chat.js・src/mcp/*・DB・認証・API の変更
- アイコンのモチーフ/配色の変更(青地 #2563eb・白の吹き出し+P で確定)
- manifest/アイコンを認証保護下に置くこと
- 追加の本番依存(sharp は dev/変換用途に留める)

## 6. 完了条件
1. public/icons/ に icon.svg・icon-maskable.svg・icon-192.png・icon-512.png・icon-maskable-512.png・
   apple-touch-icon.png が存在し、PNG が正しいサイズ・青地/白吹き出し+P で描画されている(画像を開いて目視)
2. /manifest.json が正しい JSON で配信され、name/display/theme_color/icons が要件どおり
3. /icons/* と /manifest.json が未ログインでも HTTP 200 で取得できる
4. index.html の <head> に manifest/theme-color/apple-touch-icon/icon の link・meta が追加され、
   既存 UI が壊れていない(ブラウザで通常表示・チャットが従来どおり動く)
5. 【ユーザー手動】Android Chrome で localhost/LAN の URL を開き「ホーム画面に追加」→ standalone 起動し、
   ホーム画面に PlainChat アイコンが表示される(この最終確認はユーザーが実機で行う)。
   Claude Code 側は 1〜4(ファイル生成・manifest妥当性・配信・HTML反映)までを確認する
6. 検証用の一時ファイルがあれば片付けて完了

## 7. 共通ルール
- git add / git commit は実行しない(ステージもしない)。コミットはレビュー後にユーザーが手動で行う
- 実装と動作確認が完了したら、この指示ファイルを prompts/done/ へ移動する