'use strict';

function timestamp() {
  return new Date().toISOString();
}

function info(message, ...args) {
  console.log(`${timestamp()} [info] ${message}`, ...args);
}

function warn(message, ...args) {
  console.warn(`${timestamp()} [warn] ${message}`, ...args);
}

function error(message, ...args) {
  console.error(`${timestamp()} [error] ${message}`, ...args);
}

module.exports = { info, warn, error };
