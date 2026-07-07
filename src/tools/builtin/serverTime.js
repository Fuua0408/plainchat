'use strict';

const { register } = require('../registry');

function formatNow(timezone) {
  const now = new Date();
  if (!timezone) return now.toISOString();

  try {
    // sv-SE は "YYYY-MM-DD HH:mm:ss" 形式を返すため、ISO風に整形する
    return now.toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
  } catch (e) {
    return now.toISOString();
  }
}

register({
  name: 'get_server_time',
  description: 'サーバーの現在時刻を返す(024の検証用ダミーツール)',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANAタイムゾーン名(例: Asia/Tokyo)。省略時はUTC',
      },
    },
    required: [],
  },
  handler: async (args) => formatNow(args && args.timezone),
});
