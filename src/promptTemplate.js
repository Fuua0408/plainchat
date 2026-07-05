'use strict';

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} (${WEEKDAYS_JA[d.getDay()]}曜日)`;
}

function formatTime(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatDateTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())} (${WEEKDAYS_JA[d.getDay()]}曜日)`;
}

// システムプロンプト内の {{currentDateTime}} 等のテンプレート変数を展開する。
// サーバーのローカルタイムゾーンを使用。未知の {{...}} はそのまま残す
function expandPromptTemplate(text, now = new Date()) {
  const values = {
    currentDateTime: formatDateTime(now),
    currentDate: formatDate(now),
    currentTime: formatTime(now),
  };

  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

module.exports = { expandPromptTemplate };
