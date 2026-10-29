const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(opts = {}) {
  const levelName = opts.level || process.env.LOG_LEVEL || 'info';
  const minLevel = LEVELS[levelName] || LEVELS.info;
  const base = opts.base || {};
  const pretty = opts.pretty !== undefined ? opts.pretty : (process.env.NODE_ENV !== 'test');

  function write(level, msg, fields) {
    if (LEVELS[level] < minLevel) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...base, ...(fields || {}) };
    if (pretty) {
      const rest = { ...entry };
      delete rest.ts; delete rest.level; delete rest.msg;
      const suffix = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
      console.log(`[${entry.ts}] ${level.toUpperCase()} ${msg}${suffix}`);
    } else {
      console.log(JSON.stringify(entry));
    }
  }
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (extra) => createLogger({ ...opts, base: { ...base, ...extra } })
  };
}

const logger = createLogger();

module.exports = { createLogger, logger };