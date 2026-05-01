'use strict';

const { getSupportedDbs } = require('./support');

class CompilationFailedError extends Error {
  constructor(message, promptText) {
    super(message);
    this.name = 'CompilationFailedError';
    this.promptText = promptText;
  }
}

class NonsensicalPromptError extends Error {
  constructor(warning, promptText) {
    super(warning || 'Prompt is unclear or nonsensical.');
    this.name = 'NonsensicalPromptError';
    this.warning = warning || 'Prompt is unclear or nonsensical.';
    this.promptText = promptText;
  }
}

/** Rate or plan limit reached. */
class MaskDatabasesRateLimitedError extends Error {
  constructor(message, retryAfterMs) {
    super(message || 'Mask Databases rate limit exceeded.');
    this.name = 'MaskDatabasesRateLimitedError';
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null;
  }
}

class MaskDatabasesPlanLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message || 'Mask Databases plan limit reached.');
    this.name = 'MaskDatabasesPlanLimitError';
    this.retryAfterMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : null;
  }
}

/** Thrown when a prompt exceeds the allowed size limit. */
class MaskPromptTooLargeError extends Error {
  constructor(message, { actualBytes, limitBytes, kind } = {}) {
    super(message || 'Prompt is too large.');
    this.name = 'MaskPromptTooLargeError';
    this.actualBytes = Number.isFinite(actualBytes) ? actualBytes : null;
    this.limitBytes = Number.isFinite(limitBytes) ? limitBytes : null;
    this.kind = kind || 'prompt';
  }
}

/**
 * Thrown when a project/config specifies a database adapter that Mask doesn't support.
 */
class UnsupportedDbsError extends Error {
  constructor(database) {
    const supportedDbs = getSupportedDbs();
    super(
      `[Mask] Unsupported database "${database}". Use one of: ${
        supportedDbs ? supportedDbs.join(', ') : ''
      } in mask.compile.cjs overrideConfig (e.g. "database": "mongodb").`
    );
    this.name = 'UnsupportedDbsError';
    this.database = database;
    this.supportedDbs = Array.isArray(supportedDbs) ? supportedDbs : null;
  }
}

module.exports = {
  CompilationFailedError,
  NonsensicalPromptError,
  MaskDatabasesRateLimitedError,
  MaskDatabasesPlanLimitError,
  MaskPromptTooLargeError,
  UnsupportedDbsError
};
