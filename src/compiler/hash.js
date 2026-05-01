'use strict';

const crypto = require('crypto');

function generatePromptHash(promptText, existingHashes) {
  const baseHash = crypto.createHash('md5').update(promptText, 'utf8').digest('hex').slice(0, 8);
  if (!existingHashes.has(baseHash)) {
    return baseHash;
  }
  let counter = 1;
  let candidate = baseHash;
  while (existingHashes.has(candidate)) {
    const suffix = counter.toString(16).slice(0, 2);
    candidate = `${baseHash.slice(0, 8 - suffix.length)}${suffix}`;
    counter += 1;
  }
  return candidate;
}

module.exports = { generatePromptHash };
