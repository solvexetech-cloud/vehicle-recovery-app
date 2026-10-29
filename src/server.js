const config = require('./config');
const { createApp } = require('./app');
const { logger } = require('./logger');

const log = logger.child({ component: 'server' });
const { app } = createApp({ logger: log });

const server = app.listen(config.port, () => {
  log.info('server.listening', { url: 'http://localhost:' + config.port, env: config.nodeEnv, version: config.appVersion });
});

function shutdown(signal) {
  log.info('server.shutdown', { signal });
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { log.error('uncaught', { err: (e && e.stack) || String(e) }); process.exit(1); });
process.on('unhandledRejection', (e) => { log.error('unhandled_rejection', { err: String(e) }); });