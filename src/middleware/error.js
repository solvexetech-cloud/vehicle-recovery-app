const { AppError } = require('../errors');
const { logger } = require('../logger');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found', path: req.path });
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isApp = err instanceof AppError || err.isAppError;
  const status = isApp ? err.status : 500;
  const code = isApp ? err.code : 'internal_error';
  const isDev = process.env.NODE_ENV !== 'production';

  const payload = { error: code };
  if (isApp && err.details) payload.details = err.details;
  if (isDev && err.message) payload.message = err.message;
  if (!isApp && isDev && err.message) payload.message = err.message;

  if (status >= 500) {
    logger.error('request.failed', { code, path: req.path, method: req.method, err: (err && err.stack) || String(err) });
  } else {
    logger.warn('request.rejected', { code, path: req.path, method: req.method });
  }
  res.status(status).json(payload);
}

module.exports = { notFoundHandler, errorHandler };