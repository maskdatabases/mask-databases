#!/usr/bin/env node

'use strict';

/**
 * mask-delete — Remove prompts from local .mask files and regenerate code.
 *
 * Usage:
 *   mask-delete                      Interactive shell (list, delete, exit)
 *   mask-delete --list               List all local prompts
 *   mask-delete --hash <hash>        Delete by hash
 *   mask-delete --prompt "<text>"    Delete by prompt text
 *   mask-delete --failed             Delete all prompts in query + model failed lists
 *
 * Only modifies local data files (.mask/local/ or .mask/ legacy).
 * After deletion the generated query/model modules are rebuilt from
 * the remaining metadata — no Mask Databases calls are made.
 */

const fs = require('fs');
const readline = require('readline');
const { getPaths, getProjectRoot } = require('../paths');
const { readMaskConfigRawObject } = require('./config');
const { loadJsonFile, saveJsonFile, ensureMaskDirs } = require('./fs-utils');
const {
  getSyncConfig,
  loadMergedQueriesPromptMap,
  loadMergedQueriesMetadata,
  loadMergedQueriesFailedPrompts,
  loadMergedModelsFailedPrompts,
  loadMergedQueriesNeedsReview,
  loadMergedModelsPromptMap,
  loadMergedModelsMetadata,
  ensureSyncDirs
} = require('./sync-data');
const { getCompilerAdapter } = require('./get-adapter');

// ── Paths & sync detection ──────────────────────────────────────────

function resolveContext() {
  const projectRoot = getProjectRoot();
  const paths = getPaths(projectRoot);
  ensureMaskDirs(paths);
  const syncConfig = getSyncConfig(paths);
  // Always use .mask/local data layout for delete operations.
  // Legacy .mask/queries and .mask/models are no longer defaulted.
  const useSync = true;
  if (useSync) ensureSyncDirs(paths);
  return { paths, useSync };
}

// ── Read a lightweight config (does NOT require syncApiKey) ─────────

function loadDeleteConfig(paths) {
  if (!fs.existsSync(paths.config)) {
    return { database: 'mongodb', dbModulePath: 'src/db' };
  }
  try {
    const c = readMaskConfigRawObject(paths) || {};
    return {
      database: c.database || 'mongodb',
      dbModulePath: (typeof c.dbModulePath === 'string' && c.dbModulePath.trim() ? c.dbModulePath : 'src/db').trim()
    };
  } catch (_) {
    return { database: 'mongodb', dbModulePath: 'src/db' };
  }
}

// ── Data accessors (correct path for sync vs legacy) ────────────────

function queryPromptMapPath(paths, useSync) {
  return useSync ? paths.local.queries.promptMap : paths.queries.promptMap;
}
function queryMetadataPath(paths, useSync) {
  return useSync ? paths.local.queries.metadata : paths.queries.metadata;
}
function queryFailedPath(paths, useSync) {
  return useSync ? paths.local.queries.failedPrompts : paths.queries.failedPrompts;
}
function queryNeedsReviewPath(paths, useSync) {
  return useSync ? paths.local.queries.needsReview : paths.queries.needsReview;
}
function modelPromptMapPath(paths, useSync) {
  return useSync ? paths.local.models.promptMap : paths.models.promptMap;
}
function modelMetadataPath(paths, useSync) {
  return useSync ? paths.local.models.metadata : paths.models.metadata;
}
function modelFailedPath(paths, useSync) {
  return useSync ? paths.local.models.failedPrompts : paths.models.failedPrompts;
}

// ── Listing ─────────────────────────────────────────────────────────

function getAllPrompts(paths, useSync) {
  const qMap = useSync
    ? loadMergedQueriesPromptMap(paths, true)
    : loadJsonFile(paths.queries.promptMap, {});
  const mMap = useSync
    ? loadMergedModelsPromptMap(paths, true)
    : loadJsonFile(paths.models.promptMap, {});
  return { queryMap: qMap, modelMap: mMap };
}

function printPromptTable(queryMap, modelMap) {
  const qEntries = Object.entries(queryMap);
  const mEntries = Object.entries(modelMap);
  if (!qEntries.length && !mEntries.length) {
    console.log('  (no prompts found)'); // eslint-disable-line no-console
    return;
  }
  if (qEntries.length) {
    console.log(`\n  Queries (${qEntries.length}):`); // eslint-disable-line no-console
    for (const [prompt, hash] of qEntries) {
      const short = prompt.length > 70 ? prompt.slice(0, 67) + '...' : prompt;
      console.log(`    [${hash}]  ${short}`); // eslint-disable-line no-console
    }
  }
  if (mEntries.length) {
    console.log(`\n  Models (${mEntries.length}):`); // eslint-disable-line no-console
    for (const [prompt, hash] of mEntries) {
      const short = prompt.length > 70 ? prompt.slice(0, 67) + '...' : prompt;
      console.log(`    [${hash}]  ${short}`); // eslint-disable-line no-console
    }
  }
  console.log(''); // eslint-disable-line no-console
}

// ── Deletion logic ──────────────────────────────────────────────────

function deleteByHash(paths, useSync, hash) {
  let removed = 0;

  // --- Queries ---
  const qpFile = queryPromptMapPath(paths, useSync);
  const qmFile = queryMetadataPath(paths, useSync);
  const qfFile = queryFailedPath(paths, useSync);
  const qnFile = queryNeedsReviewPath(paths, useSync);

  const qPromptMap = loadJsonFile(qpFile, {});
  const qMeta = loadJsonFile(qmFile, {});
  const qFailed = loadJsonFile(qfFile, []);
  const qNeedsReview = loadJsonFile(qnFile, []);

  const removedPrompts = [];
  for (const [prompt, h] of Object.entries(qPromptMap)) {
    if (h === hash) {
      delete qPromptMap[prompt];
      removedPrompts.push(prompt);
      removed++;
    }
  }
  const hashStillUsedQ = Object.values(qPromptMap).includes(hash);
  if (!hashStillUsedQ) delete qMeta[hash];

  const newFailed = qFailed.filter((p) => !removedPrompts.includes(p));
  const newNeedsReview = qNeedsReview.filter(
    (entry) => !(typeof entry === 'object' && entry.prompt && removedPrompts.includes(entry.prompt))
  );

  saveJsonFile(qpFile, qPromptMap);
  saveJsonFile(qmFile, qMeta);
  saveJsonFile(qfFile, newFailed);
  saveJsonFile(qnFile, newNeedsReview);

  // --- Models ---
  const mpFile = modelPromptMapPath(paths, useSync);
  const mmFile = modelMetadataPath(paths, useSync);
  const mfFile = modelFailedPath(paths, useSync);
  const mPromptMap = loadJsonFile(mpFile, {});
  const mMeta = loadJsonFile(mmFile, {});
  const mFailed = loadJsonFile(mfFile, []);

  const removedModelPrompts = [];
  for (const [prompt, h] of Object.entries(mPromptMap)) {
    if (h === hash) {
      delete mPromptMap[prompt];
      removedModelPrompts.push(prompt);
      removed++;
    }
  }
  const hashStillUsedM = Object.values(mPromptMap).includes(hash);
  if (!hashStillUsedM) delete mMeta[hash];

  const newMFailed = mFailed.filter((p) => !removedModelPrompts.includes(p));

  saveJsonFile(mpFile, mPromptMap);
  saveJsonFile(mmFile, mMeta);
  saveJsonFile(mfFile, newMFailed);
  markDeletedInLocalSyncMeta(paths, useSync, removedPrompts, removedModelPrompts);

  return removed;
}

function deleteByPrompt(paths, useSync, promptText) {
  let removed = 0;
  const removedQueryPrompts = [];
  const removedModelPrompts = [];

  // --- Queries ---
  const qpFile = queryPromptMapPath(paths, useSync);
  const qmFile = queryMetadataPath(paths, useSync);
  const qfFile = queryFailedPath(paths, useSync);
  const qnFile = queryNeedsReviewPath(paths, useSync);

  const qPromptMap = loadJsonFile(qpFile, {});
  const qMeta = loadJsonFile(qmFile, {});
  const qFailed = loadJsonFile(qfFile, []);
  const qNeedsReview = loadJsonFile(qnFile, []);

  if (promptText in qPromptMap) {
    const hash = qPromptMap[promptText];
    delete qPromptMap[promptText];
    removed++;
    if (!Object.values(qPromptMap).includes(hash)) delete qMeta[hash];
    const newFailed = qFailed.filter((p) => p !== promptText);
    const newNR = qNeedsReview.filter(
      (e) => !(typeof e === 'object' && e.prompt === promptText)
    );
    saveJsonFile(qfFile, newFailed);
    saveJsonFile(qnFile, newNR);
    removedQueryPrompts.push(promptText);
  }
  saveJsonFile(qpFile, qPromptMap);
  saveJsonFile(qmFile, qMeta);

  // --- Models ---
  const mpFile = modelPromptMapPath(paths, useSync);
  const mmFile = modelMetadataPath(paths, useSync);
  const mfFile = modelFailedPath(paths, useSync);
  const mPromptMap = loadJsonFile(mpFile, {});
  const mMeta = loadJsonFile(mmFile, {});
  let mFailed = loadJsonFile(mfFile, []);

  if (promptText in mPromptMap) {
    const hash = mPromptMap[promptText];
    delete mPromptMap[promptText];
    removed++;
    if (!Object.values(mPromptMap).includes(hash)) delete mMeta[hash];
    removedModelPrompts.push(promptText);
    mFailed = mFailed.filter((p) => p !== promptText);
  }
  saveJsonFile(mpFile, mPromptMap);
  saveJsonFile(mmFile, mMeta);
  saveJsonFile(mfFile, mFailed);
  markDeletedInLocalSyncMeta(paths, useSync, removedQueryPrompts, removedModelPrompts);

  return removed;
}

function purgePromptsFromFailedLists(paths, useSync, promptTexts) {
  const set = new Set((Array.isArray(promptTexts) ? promptTexts : []).filter((p) => typeof p === 'string' && p.trim()));
  if (!set.size) return;
  const qfFile = queryFailedPath(paths, useSync);
  const mfFile = modelFailedPath(paths, useSync);
  const qf = loadJsonFile(qfFile, []);
  const mf = loadJsonFile(mfFile, []);
  saveJsonFile(qfFile, qf.filter((p) => !set.has(p)));
  saveJsonFile(mfFile, mf.filter((p) => !set.has(p)));
}

function deleteAllFailed(paths, useSync) {
  const qFailed = useSync
    ? loadMergedQueriesFailedPrompts(paths, true)
    : loadJsonFile(paths.queries.failedPrompts, []);
  const mFailed = useSync
    ? loadMergedModelsFailedPrompts(paths, true)
    : loadJsonFile(paths.models.failedPrompts, []);
  const strOk = (p) => typeof p === 'string' && p.trim();
  const fromQ = (Array.isArray(qFailed) ? qFailed : []).filter(strOk);
  const fromM = (Array.isArray(mFailed) ? mFailed : []).filter(strOk);
  const uniqueFailedPrompts = [...new Set([...fromQ, ...fromM])];

  if (!uniqueFailedPrompts.length) {
    return { attempted: 0, removed: 0 };
  }

  let removed = 0;
  for (const promptText of uniqueFailedPrompts) {
    removed += deleteByPrompt(paths, useSync, promptText);
  }
  purgePromptsFromFailedLists(paths, useSync, uniqueFailedPrompts);
  return { attempted: uniqueFailedPrompts.length, removed };
}

function markDeletedInLocalSyncMeta(paths, useSync, queryPrompts, modelPrompts) {
  if (!useSync) return;
  const qPrompts = Array.isArray(queryPrompts) ? queryPrompts : [];
  const mPrompts = Array.isArray(modelPrompts) ? modelPrompts : [];
  if (!qPrompts.length && !mPrompts.length) return;
  const now = Date.now();

  if (qPrompts.length) {
    const qSync = loadJsonFile(paths.local.queries.syncMeta, {});
    for (const p of qPrompts) {
      const prev = (qSync && qSync[p]) || { version: 1, lastModified: 0 };
      qSync[p] = {
        ...prev,
        version: (Number(prev.version) || 1) + 1,
        lastModified: now,
        isDeleted: true,
        isSynced: false
      };
    }
    saveJsonFile(paths.local.queries.syncMeta, qSync);
  }

  if (mPrompts.length) {
    const mSync = loadJsonFile(paths.local.models.syncMeta, {});
    for (const p of mPrompts) {
      const prev = (mSync && mSync[p]) || { version: 1, lastModified: 0 };
      mSync[p] = {
        ...prev,
        version: (Number(prev.version) || 1) + 1,
        lastModified: now,
        isDeleted: true,
        isSynced: false
      };
    }
    saveJsonFile(paths.local.models.syncMeta, mSync);
  }
}

// ── Regenerate generated modules from remaining metadata ────────────

function regenerateGenerated(paths, useSync) {
  const config = loadDeleteConfig(paths);
  let adapter;
  try {
    adapter = getCompilerAdapter(config.database);
  } catch (_) {
    console.warn('[Mask] Could not load adapter for', config.database, '— skipping code regeneration.'); // eslint-disable-line no-console
    return;
  }

  const queryMeta = useSync
    ? { ...loadMergedQueriesMetadata(paths, true) }
    : loadJsonFile(paths.queries.metadata, {});
  const modelMeta = useSync
    ? { ...loadMergedModelsMetadata(paths, true) }
    : loadJsonFile(paths.models.metadata, {});

  const profile = { database: config.database };

  const queriesSrc = adapter.generateQueriesModuleSource(queryMeta, profile, {
    dbModulePath: config.dbModulePath,
    modelMeta
  });
  const modelsSrc = adapter.generateModelsModuleSource(modelMeta, {
    dbModulePath: config.dbModulePath
  });

  if (!fs.existsSync(paths.generated.dir)) {
    fs.mkdirSync(paths.generated.dir, { recursive: true });
  }
  fs.writeFileSync(paths.generated.queries, queriesSrc, 'utf8');
  fs.writeFileSync(paths.generated.models, modelsSrc, 'utf8');
}

// ── CLI argument parsing ────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('--list') || args.includes('-l')) return { mode: 'list' };
  if (args.includes('--failed') || args.includes('--delete-failed')) return { mode: 'failed' };
  const hashIdx = args.indexOf('--hash');
  if (hashIdx !== -1 && args[hashIdx + 1]) return { mode: 'hash', value: args[hashIdx + 1] };
  const promptIdx = args.indexOf('--prompt');
  if (promptIdx !== -1 && args[promptIdx + 1]) return { mode: 'prompt', value: args[promptIdx + 1] };
  if (args.length === 0) return { mode: 'interactive' };
  return { mode: 'help' };
}

// ── Interactive shell ───────────────────────────────────────────────

function startShell(paths, useSync) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'mask> '
  });

  console.log(''); // eslint-disable-line no-console
  console.log('  Mask interactive shell — manage local prompts'); // eslint-disable-line no-console
  console.log('  Commands: list, delete <hash>, delete-prompt "<text>", delete-failed, help, exit'); // eslint-disable-line no-console
  console.log(''); // eslint-disable-line no-console
  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === 'exit' || input === 'quit' || input === '.exit') {
      rl.close();
      return;
    }

    if (input === 'help' || input === '?') {
      console.log(''); // eslint-disable-line no-console
      console.log('  list                       List all prompts with hashes'); // eslint-disable-line no-console
      console.log('  delete <hash>              Delete prompt(s) by hash'); // eslint-disable-line no-console
      console.log('  delete-prompt "<text>"     Delete a prompt by its text'); // eslint-disable-line no-console
      console.log('  delete-failed              Delete all prompts in failed-prompts'); // eslint-disable-line no-console
      console.log('  exit                       Exit the shell'); // eslint-disable-line no-console
      console.log(''); // eslint-disable-line no-console
      rl.prompt();
      return;
    }

    if (input === 'list' || input === 'ls') {
      const { queryMap, modelMap } = getAllPrompts(paths, useSync);
      printPromptTable(queryMap, modelMap);
      rl.prompt();
      return;
    }

    if (input.startsWith('delete ') && !input.startsWith('delete-prompt')) {
      const hash = input.slice(7).trim();
      if (!hash) {
        console.log('  Usage: delete <hash>'); // eslint-disable-line no-console
        rl.prompt();
        return;
      }
      const count = deleteByHash(paths, useSync, hash);
      if (count === 0) {
        console.log(`  No prompt found for hash "${hash}".`); // eslint-disable-line no-console
      } else {
        regenerateGenerated(paths, useSync);
        console.log(`  Deleted ${count} prompt(s) for hash "${hash}". Generated files updated.`); // eslint-disable-line no-console
      }
      rl.prompt();
      return;
    }

    if (input.startsWith('delete-prompt ')) {
      let text = input.slice(14).trim();
      if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        text = text.slice(1, -1);
      }
      if (!text) {
        console.log('  Usage: delete-prompt "<prompt text>"'); // eslint-disable-line no-console
        rl.prompt();
        return;
      }
      const count = deleteByPrompt(paths, useSync, text);
      if (count === 0) {
        console.log(`  No prompt matching that text was found.`); // eslint-disable-line no-console
      } else {
        regenerateGenerated(paths, useSync);
        console.log(`  Deleted ${count} prompt(s). Generated files updated.`); // eslint-disable-line no-console
      }
      rl.prompt();
      return;
    }

    if (input === 'delete-failed') {
      const outcome = deleteAllFailed(paths, useSync);
      if (outcome.attempted === 0) {
        console.log('  No failed prompts found.'); // eslint-disable-line no-console
      } else if (outcome.removed === 0) {
        console.log('  Failed prompts were listed, but none matched local prompt maps for deletion.'); // eslint-disable-line no-console
      } else {
        regenerateGenerated(paths, useSync);
        console.log(`  Deleted ${outcome.removed} prompt(s) from failed prompts list. Generated files updated.`); // eslint-disable-line no-console
      }
      rl.prompt();
      return;
    }

    console.log(`  Unknown command: ${input}. Type "help" for available commands.`); // eslint-disable-line no-console
    rl.prompt();
  });

  rl.on('close', () => {
    console.log('[Mask] Bye.'); // eslint-disable-line no-console
  });
}

// ── Main ────────────────────────────────────────────────────────────

function run() {
  const parsed = parseArgs(process.argv);
  const { paths, useSync } = resolveContext();

  if (parsed.mode === 'help') {
    console.log(''); // eslint-disable-line no-console
    console.log('Usage:'); // eslint-disable-line no-console
    console.log('  mask-delete                   Interactive shell'); // eslint-disable-line no-console
    console.log('  mask-delete --list            List all prompts'); // eslint-disable-line no-console
    console.log('  mask-delete --hash <hash>     Delete by hash'); // eslint-disable-line no-console
    console.log('  mask-delete --prompt "<text>" Delete by prompt text'); // eslint-disable-line no-console
    console.log('  mask-delete --failed          Delete all failed prompts'); // eslint-disable-line no-console
    console.log(''); // eslint-disable-line no-console
    return;
  }

  if (parsed.mode === 'list') {
    const { queryMap, modelMap } = getAllPrompts(paths, useSync);
    printPromptTable(queryMap, modelMap);
    return;
  }

  if (parsed.mode === 'hash') {
    const count = deleteByHash(paths, useSync, parsed.value);
    if (count === 0) {
      console.log(`[Mask] No prompt found for hash "${parsed.value}".`); // eslint-disable-line no-console
      process.exitCode = 1;
      return;
    }
    regenerateGenerated(paths, useSync);
    console.log(`[Mask] Deleted ${count} prompt(s) for hash "${parsed.value}". Generated files updated.`); // eslint-disable-line no-console
    return;
  }

  if (parsed.mode === 'prompt') {
    const count = deleteByPrompt(paths, useSync, parsed.value);
    if (count === 0) {
      console.log('[Mask] No prompt matching that text was found.'); // eslint-disable-line no-console
      process.exitCode = 1;
      return;
    }
    regenerateGenerated(paths, useSync);
    console.log(`[Mask] Deleted ${count} prompt(s). Generated files updated.`); // eslint-disable-line no-console
    return;
  }

  if (parsed.mode === 'failed') {
    const outcome = deleteAllFailed(paths, useSync);
    if (outcome.attempted === 0) {
      console.log('[Mask] No failed prompts found.'); // eslint-disable-line no-console
      process.exitCode = 1;
      return;
    }
    if (outcome.removed === 0) {
      console.log('[Mask] Failed prompts were listed, but none matched local prompt maps for deletion.'); // eslint-disable-line no-console
      process.exitCode = 1;
      return;
    }
    regenerateGenerated(paths, useSync);
    console.log(`[Mask] Deleted ${outcome.removed} prompt(s) from failed prompts list. Generated files updated.`); // eslint-disable-line no-console
    return;
  }

  // Interactive shell
  startShell(paths, useSync);
}

run();
