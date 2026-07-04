# plainchat

ロールプレイ要素を持たない、飾らない汎用チャットツール。

## セットアップ

```bash
npm install
cp .env.example .env
npm start
```

起動後、`http://localhost:18091` にアクセス(ポートは `.env` の `PORT` で変更可能)。
ヘルスチェック: `curl http://localhost:18091/api/health`

開発時はファイル変更を自動反映する `npm run dev` を使用可能。
