'use strict';

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - 一意なツール名
 * @property {string} description - モデルに見せる説明文
 * @property {Object} parameters - OpenAI関数呼び出し形式のJSON Schema
 * @property {(args: Object) => Promise<string|Object>} handler - 実行本体
 * @property {string} origin - 登録源。'mcp:<serverLabel>' の形式(必須)
 */

module.exports = {};
