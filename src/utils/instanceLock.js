/**
 * Single-instance guard. services/sheets.js's local-first design assumes
 * exactly one bot process is the writer - a second instance (e.g.
 * start-bot.bat double-launched, or a stale process that didn't fully exit
 * before a restart) would load its own local copy and sync it back on its
 * own timer, silently stomping whatever the other instance had already
 * written. That failure mode is quiet and easy to miss until data's
 * already gone, so it's cheaper to just refuse to start.
 *
 * A plain PID file: acquire() writes this process's PID, checked against
 * any PID already on file via process.kill(pid, 0) (a no-op existence
 * check - doesn't actually signal anything, see Node docs). A stale lock
 * (process no longer running, e.g. from a crash that skipped shutdown())
 * is treated as free rather than blocking forever.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const LOCK_PATH = path.join(dataDir(), 'bot.lock');

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // process exists but owned by someone else - treat as running
  }
}

/**
 * Throws if another instance already holds the lock. Otherwise writes this
 * process's PID and returns.
 */
function acquire() {
  if (fs.existsSync(LOCK_PATH)) {
    const existingPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (existingPid && isPidRunning(existingPid)) {
      throw new Error(
        `Another instance of this bot is already running (PID ${existingPid}, see ${LOCK_PATH}). ` +
          `Running two instances against the same spreadsheet risks one silently overwriting the ` +
          `other's writes. If that process is actually gone (e.g. it crashed without cleaning up), ` +
          `delete ${LOCK_PATH} and try again.`
      );
    }
    // Stale lock from an unclean exit - fine to take over.
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
}

/** Removes the lock file, but only if it's still this process's own lock. */
function release() {
  try {
    if (fs.existsSync(LOCK_PATH) && parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch (err) {
    console.error('[instanceLock] Failed to release lock file on exit:', err.message);
  }
}

module.exports = { acquire, release, LOCK_PATH };
