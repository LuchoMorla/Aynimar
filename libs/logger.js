'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, msg, data) {
  if ((LEVELS[level] ?? 0) < current) return;
  const fn = level === 'error' ? console.error : console.log;
  fn(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

module.exports = {
  debug: (msg, data = {}) => emit('debug', msg, data),
  info:  (msg, data = {}) => emit('info',  msg, data),
  warn:  (msg, data = {}) => emit('warn',  msg, data),
  error: (msg, data = {}) => emit('error', msg, data),
};
