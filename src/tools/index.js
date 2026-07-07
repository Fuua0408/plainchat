'use strict';

// 各ツールモジュールをrequireすると、モジュール側で自己登録(register)される。
// 前提envが無ければ自己登録をスキップする、という書き方を各モジュール側で行える。
require('./builtin/serverTime');

module.exports = require('./registry');
