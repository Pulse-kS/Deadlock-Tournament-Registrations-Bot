/**
 * Sheets writes now happen in the background, after Discord roles are
 * already applied and the captain's been told they're done (see
 * registrationFlow.js performCommit). A job is saved here the moment
 * registration commits and stays queued until a sheets.flush() actually
 * confirms it reached the real Google Sheet (see registrationFlow.js's
 * clearPendingWritesSyncedBefore) - not just until it's applied to the
 * bot's local in-memory copy, which happens near-instantly and proves
 * nothing about durability. That's what lets an ungraceful crash (killed
 * process, power loss, terminal window closed) between commit and the next
 * flush recover cleanly on restart: retryPendingWrites() replays anything
 * still queued here against the freshly-pulled-from-Sheets local store.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const PERSIST_PATH = path.join(dataDir(), 'pending-writes.json');
const TMP_PATH = `${PERSIST_PATH}.tmp`;

function loadAll() {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return {};
    return JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
  } catch (err) {
    console.warn('[pendingWrites] Could not load pending-writes.json, treating as empty:', err.message);
    return {};
  }
}

function persistAll(obj) {
  try {
    // Temp-file-then-rename, same as sessions.js/localSnapshot.js - a crash
    // mid-write must never corrupt this file, since it's the crash-recovery
    // queue itself.
    fs.writeFileSync(TMP_PATH, JSON.stringify(obj, null, 2));
    fs.renameSync(TMP_PATH, PERSIST_PATH);
  } catch (err) {
    // If we can't even persist the failure record, there's nothing more we
    // can do locally - this is logged loudly on purpose.
    console.error('[pendingWrites] FAILED TO PERSIST a queued write - data may be lost:', err.message);
  }
}

/** Saves a failed write job for later retry. Returns its id. */
function save(job) {
  const all = loadAll();
  const id = job.id || `${job.teamRoleId || 'unknown'}-${Date.now()}`;
  all[id] = { ...job, id, savedAt: job.savedAt || Date.now() };
  persistAll(all);
  return id;
}

function remove(id) {
  const all = loadAll();
  delete all[id];
  persistAll(all);
}

function listAll() {
  return Object.values(loadAll());
}

module.exports = { save, remove, listAll };
