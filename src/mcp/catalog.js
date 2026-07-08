'use strict';

// stdio型MCPサーバーのカタログ。command/argsはここにだけ存在し、API/UIからは編集不可
// (029: 任意プロセス起動を封じるため、stdioはカタログ選択+必須env入力のみを許可する)

function resolveSearxngEntry() {
  try {
    return require.resolve('mcp-searxng/dist/cli.js');
  } catch (e) {
    return null;
  }
}

function buildCatalog() {
  const searxngEntry = resolveSearxngEntry();
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
