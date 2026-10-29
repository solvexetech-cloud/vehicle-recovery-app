const { getActiveSession, parseCookies, COOKIE_NAME } = require('../auth');
const { Errors } = require('../errors');

function attachUser(db) {
  return (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const session = getActiveSession(db, cookies[COOKIE_NAME]);
      if (session) {
        const user = db.prepare(
          'SELECT id, country_id, role, full_name, email, phone, status, mfa_enabled FROM users WHERE id = ?'
        ).get(session.user_id);
        if (user && user.status === 'active') {
          req.user = user;
          req.session = session;
        }
      }
    } catch (_) { /* ignore */ }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return next(Errors.unauthorized('authentication_required'));
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(Errors.unauthorized('authentication_required'));
    if (!roles.includes(req.user.role)) return next(Errors.forbidden('insufficient_role'));
    next();
  };
}

module.exports = { attachUser, requireAuth, requireRole };