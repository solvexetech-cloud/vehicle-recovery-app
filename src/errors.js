class AppError extends Error {
  constructor(code, message, status, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status || 400;
    this.details = details;
    this.isAppError = true;
  }
}

const Errors = {
  badRequest: (msg, d) => new AppError('bad_request', msg || 'Bad request', 400, d),
  unauthorized: (msg) => new AppError('unauthorized', msg || 'Unauthorized', 401),
  forbidden: (msg) => new AppError('forbidden', msg || 'Forbidden', 403),
  notFound: (msg) => new AppError('not_found', msg || 'Not found', 404),
  conflict: (msg, d) => new AppError('conflict', msg || 'Conflict', 409, d),
  validation: (msg, d) => new AppError('validation_error', msg || 'Validation failed', 422, d),
  internal: (msg) => new AppError('internal_error', msg || 'Internal server error', 500),
  mfaRequired: () => new AppError('mfa_required', 'MFA code required', 403),
  invalidMfaCode: () => new AppError('invalid_mfa_code', 'Invalid MFA code', 401),
  mfaSetupRequired: () => new AppError('mfa_setup_required', 'MFA enrollment required', 403),
  mfaAlreadyEnabled: () => new AppError('mfa_already_enabled', 'MFA already enabled', 409),
  mfaNotInitiated: () => new AppError('mfa_not_initiated', 'MFA enrollment not started', 422),
  crossCountryForbidden: () => new AppError('cross_country_forbidden', 'Cross-country access forbidden', 403)
};

module.exports = { AppError, Errors };