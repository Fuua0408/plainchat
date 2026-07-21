'use strict';

const path = require('path');
const fs = require('fs');

// stdio型MCPサーバーのカタログ。command/argsはここにだけ存在し、API/UIからは編集不可
// (029: 任意プロセス起動を封じるため、stdioはカタログ選択+必須env入力のみを許可する)

function resolveSearxngEntry() {
  try {
    return require.resolve('mcp-searxng/dist/cli.js');
  } catch (e) {
    return null;
  }
}

// 040: 自前実装(外部npm依存なし)のためrequire.resolveではなく素直なファイル存在確認で解決する
function resolveClockEntry() {
  const entryPath = path.join(__dirname, '..', 'mcp-servers', 'clock', 'index.mjs');
  return fs.existsSync(entryPath) ? entryPath : null;
}

function buildCatalog() {
  const searxngEntry = resolveSearxngEntry();
  const clockEntry = resolveClockEntry();
  return [
    {
      id: 'searxng',
      displayName: 'SearXNG (Web検索)',
      transport: 'stdio',
      command: searxngEntry ? process.execPath : null,
      args: searxngEntry ? [searxngEntry] : [],
      requiredEnvKeys: ['SEARXNG_URL'],
      optionalEnvKeys: [],
      description: 'mcp-searxng経由でSearXNGインスタンスに検索クエリを送るWeb検索サーバー',
    },
    {
      id: 'clock',
      displayName: '現在日時取得(組み込み)',
      transport: 'stdio',
      command: clockEntry ? process.execPath : null,
      args: clockEntry ? [clockEntry] : [],
      requiredEnvKeys: [],
      optionalEnvKeys: [],
      description: 'システムの現在日時を返す軽量MCPサーバー。外部通信・追加のシークレット不要',
    },
  ];
}

const CATALOG = buildCatalog();

// カタログの表示用メタ(command/argsを含まない)を返す。API/UI公開用
function getCatalog() {
  return CATALOG.map(({ command, args, ...meta }) => meta);
}

// id→完全定義(command/args含む)を引く。サーバー内部専用、外へ渡さないこと
function getCatalogEntry(id) {
  return CATALOG.find((entry) => entry.id === id) || null;
}

module.exports = { getCatalog, getCatalogEntry };
