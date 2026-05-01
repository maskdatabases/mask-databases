'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('./comments');
const { loadPromptsRegisteryFromMaskConfig } = require('./sync-data');
const { DEFAULT_IGNORE_DIRS } = require('../package-config');

/** Escape a string for use inside a RegExp (so literal . and () etc. are matched). */
function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a regex pattern that matches (?:Identifier1|Identifier2|...).methodName\s*\(\s*(['"`])([\s\S]*?)\1
 * so the compiler can find calls when the user imports with a different name (e.g. MyModels.define).
 * Includes \s* after ( so multi-line calls like define(\n  '...') are matched. Uses non-capturing
 * group for identifiers so match[1]=quote, match[2]=string content (same as default pattern).
 */
function buildCallPattern(identifiers, methodName) {
  if (!Array.isArray(identifiers) || identifiers.length === 0) return null;
  const names = identifiers.map(escapeForRegex).join('|');
  return `(?:${names})\\.${escapeForRegex(methodName)}\\s*\\(\\s*(['"\`])([\\s\\S]*?)\\1`;
}

/** Get the regex pattern string for MaskDatabase.prompt / custom prompt call. */
function getPromptCallPattern(profile) {
  if (profile && profile.promptCallPattern) return profile.promptCallPattern;
  const names = (profile && profile.promptCallNames) || ['MaskDatabase'];
  const built = buildCallPattern(Array.isArray(names) ? names : [names], 'prompt');
  return built || "MaskDatabase\\.prompt\\(\\s*(['\"`])([\\s\\S]*?)\\1";
}

/** Get the regex pattern string for MaskModels.define / custom model define call. */
function getModelDefinePattern(profile) {
  if (profile && profile.modelDefinePattern) return profile.modelDefinePattern;
  const names = (profile && profile.modelDefineNames) || ['MaskModels'];
  const built = buildCallPattern(Array.isArray(names) ? names : [names], 'define');
  return built || "MaskModels\\.define\\(\\s*(['\"`])([\\s\\S]*?)\\1";
}

function collectSourceFiles(dir, profile) {
  const result = [];
  if (!fs.existsSync(dir)) {
    return result;
  }
  const extensions = (profile && profile.fileExtensions) || ['.js'];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      result.push(...collectSourceFiles(fullPath, profile));
    } else if (entry.isFile()) {
      const hasExt = extensions.some((ext) => fullPath.endsWith(ext));
      if (hasExt) result.push(fullPath);
    }
  }
  return result;
}

/**
 * Collect all source files under projectRoot, excluding ignored dirs (node_modules, .git, .mask, etc.).
 * Used for project-wide model discovery when modelPaths is not set.
 */
function collectSourceFilesFromRoot(projectRoot, profile) {
  const result = [];
  const extensions = (profile && profile.fileExtensions) || ['.js'];
  const extensionsSet = new Set(Array.isArray(extensions) ? extensions : ['.js']);

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const hasExt = [...extensionsSet].some((ext) => fullPath.endsWith(ext));
        if (hasExt) result.push(fullPath);
      }
    }
  }

  walk(projectRoot);
  return result;
}

/**
 * Resolve config modelPaths (array of file or folder paths) to a list of source files.
 * Each path is relative to projectRoot. Files are included as-is; dirs are recursed (with standard ignores).
 */
function collectSourceFilesFromPaths(projectRoot, modelPaths, profile) {
  const result = [];
  const extensions = (profile && profile.fileExtensions) || ['.js'];
  const extensionsSet = new Set(Array.isArray(extensions) ? extensions : ['.js']);

  for (const raw of modelPaths) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) continue;
    const fullPath = path.isAbsolute(p) ? p : path.join(projectRoot, p);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      if ([...extensionsSet].some((ext) => fullPath.endsWith(ext))) result.push(fullPath);
    } else if (stat.isDirectory()) {
      result.push(...collectSourceFiles(fullPath, profile));
    }
  }
  return result;
}

function extractPromptsFromFile(filePath, profile) {
  const contents = fs.readFileSync(filePath, 'utf8');
  const withoutComments = stripComments(contents, profile);
  const prompts = [];
  const pattern = getPromptCallPattern(profile || {});
  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (_) {
    regex = /MaskDatabase\.prompt\(\s*(['"`])([\s\S]*?)\1/g;
  }
  let match;
  while ((match = regex.exec(withoutComments)) !== null) {
    let promptText = match[2];

    // Support JS string concatenation inside the call:
    //   MaskDatabase.prompt('a' + 'b', meta)
    // Regex below captures only the first string literal. If we detect a `+ '...`
    // right after the match, we append subsequent literals.
    let full = promptText;
    let idx = regex.lastIndex;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Skip whitespace/newlines.
      while (idx < withoutComments.length && /\s/.test(withoutComments[idx])) idx += 1;
      if (withoutComments[idx] !== '+') break;
      idx += 1;
      while (idx < withoutComments.length && /\s/.test(withoutComments[idx])) idx += 1;
      const quote = withoutComments[idx];
      if (!quote || quote !== '"' && quote !== "'" && quote !== '`') break;

      // Find the end of the string literal, respecting backslash escapes so
      // we don't prematurely close on escaped quotes.
      const start = idx;
      idx += 1;
      while (idx < withoutComments.length) {
        const ch = withoutComments[idx];
        if (ch === '\\') {
          // Skip escaped char.
          idx += 2;
          continue;
        }
        if (ch === quote) break;
        idx += 1;
      }
      if (withoutComments[idx] !== quote) break;

      const nextLiteral = withoutComments.slice(start + 1, idx);
      full += nextLiteral;
      idx += 1; // consume closing quote
    }

    if (full && full.trim()) {
      prompts.push(full);
    }
  }
  return prompts;
}

function discoverAllPrompts(projectRoot, profile) {
  const promptSet = new Set();
  const queryPaths = profile && profile.queryPaths;
  let files;
  if (Array.isArray(queryPaths) && queryPaths.length > 0) {
    files = collectSourceFilesFromPaths(projectRoot, queryPaths, profile || {});
  } else {
    files = collectSourceFilesFromRoot(projectRoot, profile || {});
  }
  for (const file of files) {
    const prompts = extractPromptsFromFile(file, profile);
    for (const prompt of prompts) {
      promptSet.add(prompt);
    }
  }
  return promptSet;
}


/**
 * Load the prompts registery from resolved project config key "registery" (from compile output / persisted config).
 * Returns { key: "full prompt text" } for MaskDatabase.prompt('mask-key') in code.
 */
function loadPromptsFromRegistery(paths) {
  return loadPromptsRegisteryFromMaskConfig(paths);
}

function discoverAllModelPrompts(projectRoot, profile) {
  const promptSet = new Set();
  const modelPaths = profile && profile.modelPaths;
  let files;
  if (Array.isArray(modelPaths) && modelPaths.length > 0) {
    files = collectSourceFilesFromPaths(projectRoot, modelPaths, profile || {});
  } else {
    files = collectSourceFilesFromRoot(projectRoot, profile || {});
  }
  const pattern = getModelDefinePattern(profile || {});
  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (_) {
    regex = /MaskModels\.define\(\s*(['"`])([\s\S]*?)\1/g;
  }
  for (const file of files) {
    let contents;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    const withoutComments = stripComments(contents, profile);
    let match;
    while ((match = regex.exec(withoutComments)) !== null) {
      let promptText = match[2];

      // Support JS string concatenation inside the call:
      //   MaskModels.define('a' + 'b')
      let full = promptText;
      let idx = regex.lastIndex;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        while (idx < withoutComments.length && /\s/.test(withoutComments[idx])) idx += 1;
        if (withoutComments[idx] !== '+') break;
        idx += 1;
        while (idx < withoutComments.length && /\s/.test(withoutComments[idx])) idx += 1;
        const quote = withoutComments[idx];
        if (!quote || quote !== '"' && quote !== "'" && quote !== '`') break;

        const start = idx;
        idx += 1;
        while (idx < withoutComments.length) {
          const ch = withoutComments[idx];
          if (ch === '\\') {
            idx += 2;
            continue;
          }
          if (ch === quote) break;
          idx += 1;
        }
        if (withoutComments[idx] !== quote) break;

        const nextLiteral = withoutComments.slice(start + 1, idx);
        full += nextLiteral;
        idx += 1;
      }

      if (full && full.trim()) {
        promptSet.add(full);
      }
    }
  }
  return promptSet;
}

module.exports = {
  collectSourceFiles,
  extractPromptsFromFile,
  discoverAllPrompts,
  discoverAllModelPrompts,
  loadPromptsFromRegistery
};
