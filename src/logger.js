// logger.js — log colorido com timestamp. Sem dependência externa.

export const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
};

const ts = () => new Date().toISOString().slice(11, 23);

export const log = (color, prefix, msg) =>
  console.log(`${C.gray}${ts()}${C.reset} ${color}${prefix}${C.reset} ${msg}`);
