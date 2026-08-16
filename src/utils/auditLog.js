/**
 * Lightweight audit trail for registration actions - answers "who did what,
 * when" after the fact (staff dispute, accidental roster wipe, abuse, etc).
 * This is deliberately separate from the console.log/console.error calls
 * scattered through registrationFlow.js, which are for debugging control
 * flow, not for accountability - those get lost once the terminal scrolls
 * or the process restarts, and don't consistently include actor identity.
 *
 * Every entry is one line of JSON appended to audit.log (gitignored, lives
 * next to sessions.json/pending-writes.json in the project root) AND echoed
 * to console so it shows up in the live terminal too.
 *
 * Rotates automatically by size (see AUDIT_LOG_MAX_BYTES below) rather than
 * relying on a human to archive it before each event - this log is meant to
 * be invisible to the end user (a TO running the bot day-to-day should never
 * need to know it exists), so it can't depend on someone remembering to run
 * a manual archive step. Rotated files are renamed (audit-<timestamp>.log),
 * never deleted - same "archive, don't destroy" rule the old postEvent.js
 * archive step followed.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const LOG_PATH = path.join(dataDir(), 'audit.log');

// 5MB default - at typical entry sizes (a few hundred bytes of small-object
// JSON) that's tens of thousands of entries, comfortably more than one
// tournament's worth of activity, so healthy operation should rotate rarely
// if ever. Override via env if a deployment's usage pattern differs.
const MAX_BYTES = parseInt(process.env.AUDIT_LOG_MAX_BYTES || String(5 * 1024 * 1024), 10);

function archivePathFor(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(dataDir(), `audit-${stamp}.log`);
}

/** Renames audit.log out of the way if it's grown past MAX_BYTES, so the next append starts a fresh file. */
function rotateIfNeeded() {
  let stats;
  try {
    stats = fs.statSync(LOG_PATH);
  } catch (err) {
    if (err.code === 'ENOENT') return; // nothing written yet - nothing to rotate
    console.error('[audit] Could not stat audit.log for rotation check:', err.message);
    return;
  }
  if (stats.size < MAX_BYTES) return;
  try {
    const archived = archivePathFor();
    fs.renameSync(LOG_PATH, archived);
    console.log(`[audit] audit.log exceeded ${MAX_BYTES} bytes - archived to ${path.basename(archived)}, starting fresh.`);
  } catch (err) {
    // If rotation itself fails, keep appending to the oversized file rather
    // than losing entries - a big log is a much smaller problem than a
    // missing one.
    console.error('[audit] Could not rotate audit.log (will keep appending to it):', err.message);
  }
}

/**
 * @param {string} actorId - Discord user/member id.
 * @param {string} actorTag - Discord username/tag, for human-readable reading.
 * @param {string} action - short machine-ish label, e.g. "register.start", "reg:finish".
 * @param {object} [detail] - extra context (team name, thread id, etc). Kept
 *   flat/small on purpose - this is a log line, not a data store.
 */
function record(actorId, actorTag, action, detail = {}) {
  const entry = {
    ts: new Date().toISOString(),
    actorId,
    actorTag,
    action,
    ...detail,
  };
  const line = JSON.stringify(entry);
  console.log(`[audit] ${line}`);
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch (err) {
    // Audit logging failing shouldn't ever block the actual registration
    // action - just shout loudly so it gets noticed and fixed.
    console.error('[audit] Could not write to audit.log:', err.message);
  }
}

module.exports = { record, LOG_PATH, rotateIfNeeded, MAX_BYTES };
