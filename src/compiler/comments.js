'use strict';

/**
 * Strip line and block comments from source using project profile. Preserves string contents.
 * Comment positions are replaced with spaces. If profile is omitted, uses Node/JS defaults.
 */
function stripComments(contents, profile) {
  const lineStart = (profile && profile.lineCommentStart) || '//';
  const blockStart = (profile && profile.blockCommentStart) || '/*';
  const blockEnd = (profile && profile.blockCommentEnd) || '*/';
  const stringChars = (profile && profile.stringDelimiters) || ['"', "'", '`'];

  const len = contents.length;
  let i = 0;
  let out = '';
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let stringChar = null;

  function matchesAt(str, pos) {
    if (!str || pos + str.length > len) return false;
    for (let j = 0; j < str.length; j += 1) {
      if (contents[pos + j] !== str[j]) return false;
    }
    return true;
  }

  while (i < len) {
    const c = contents[i];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out += c;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (matchesAt(blockEnd, i)) {
        inBlockComment = false;
        for (let k = 0; k < blockEnd.length; k += 1) out += ' ';
        i += blockEnd.length;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (c === '\\' && i + 1 < len) {
        out += c + contents[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) {
        inString = false;
        stringChar = null;
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    if (matchesAt(lineStart, i)) {
      inLineComment = true;
      for (let k = 0; k < lineStart.length; k += 1) out += ' ';
      i += lineStart.length;
      continue;
    }
    if (matchesAt(blockStart, i)) {
      inBlockComment = true;
      for (let k = 0; k < blockStart.length; k += 1) out += ' ';
      i += blockStart.length;
      continue;
    }
    if (stringChars.indexOf(c) !== -1) {
      inString = true;
      stringChar = c;
      out += c;
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

module.exports = { stripComments };
