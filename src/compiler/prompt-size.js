'use strict';

const { MaskPromptTooLargeError } = require('./errors');
const { MAX_PROMPT_BYTES } = require('../package-config');

/**
 * Throws if promptText exceeds MAX_PROMPT_BYTES (UTF-8).
 * @param {string} [promptText]
 * @param {string} kind - e.g. 'query-prompt', 'model-prompt'
 */
function assertPromptSize(promptText, kind) {
  if (typeof promptText !== 'string') return;
  const limitBytes = MAX_PROMPT_BYTES;
  const actualBytes = Buffer.byteLength(promptText, 'utf8');
  if (actualBytes > limitBytes) {
    throw new MaskPromptTooLargeError(
      `[Mask] Refusing to compile: ${kind} too large (${actualBytes} bytes). Max allowed is ${limitBytes} bytes.`,
      { actualBytes, limitBytes, kind }
    );
  }
}

module.exports = { assertPromptSize };
