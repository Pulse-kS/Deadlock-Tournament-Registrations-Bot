const config = require('../config');
const appsScriptClient = require('../utils/appsScriptClient');

/**
 * Local-first Sheets access.
 *
 * sheets.init() pulls the ENTIRE spreadsheet into an in-memory store once
 * at bot startup (dropping any fully-blank rows along the way - see
 * isBlankRow), and every function below (getTable/appendRow/updateRow/
 * findRow/findRows) operates purely on that local copy - no network call,
 * no latency, in the same process the bot is already running in. The local
 * copy is pushed back up to the real Google Sheet on a timer (see
 * startBackgroundSync) rather than on every write. flush() sends each
 * tab's data as { headers, rows } rather than bare positional arrays, so
 * the Apps Script side (see Code.gs's replaceAllTables_) matches each
 * field to its column by name - the live sheet's columns can be freely
 * reordered without breaking the sync.
 *
 * This trades strict consistency for speed: nothing else may edit this
 * spreadsheet while the bot is running (any such edit would just get
 * overwritten by the next sync, since the bot's local copy is authoritative
 * once loaded), and any writes since the last sync are only ever in this
 * process's memory - a crash or unclean restart before the next sync loses
 * them from the Sheet's perspective. Both are accepted trade-offs for this
 * setup specifically (single trusted operator, bot is the only writer,
 * reliable always-on local machine) - not a default to reuse elsewhere
 * without re-checking those assumptions hold.
 *
 * The external API (getTable/appendRow/updateRow/findRow/findRows) is the
 * same shape regardless of how it's backed, so registry.js/teams.js don't
 * need to know or care about any of the above.
 */

let store = null; // Map<tabName, { headers: string[], rows: object[] }>
let dirty = false;
// Bumped on every local write (appendRow/updateRow). Lets flush() tell
// whether a write landed while its network request was in flight - see
// doFlushOnce() below for why that matters.
let storeGeneration = 0;
let syncTimer = null;
let initialized = false;

// Tracks consecutive background-sync failures (reset to 0 on any successful
// sync). A single failed sync is routine - Apps Script cold starts/transient
// timeouts happen and the next hourly attempt almost always recovers - so it
// logs at 'warn'. Only once failures stack up across multiple consecutive
// cycles (SYNC_FAILURE_ALERT_THRESHOLD) does it escalate to 'error', since
// that's the point where it stops being noise and starts meaning the live
// Google Sheet has been silently stale for hours and is worth a human check.
let consecutiveSyncFailures = 0;
const SYNC_FAILURE_ALERT_THRESHOLD = 3; // ~3 hours at the default 60-min interval

// PlayerDB/TeamDB are staff-maintained, bot-never-writes tabs (see
// services/playerDB.js and services/teamDB.js). They still get pulled into
// `store` at init() like every other tab so getTable() works uniformly, but
// they must never be pushed back out - flush() below excludes them.
const READ_ONLY_TABS = new Set([config.sheets.tabs.playerDB, config.sheets.tabs.teamDB]);

// appsScriptClient.js handles a redirect-handling quirk specific to Apps
// Script web apps - see src/utils/appsScriptClient.js, which still holds it
// as a standalone module even though sheets.js is currently its only
// caller (was shared with a separate historical-lookup deployment before
// that got folded into this same spreadsheet - see PlayerDB/TeamDB in
// apps-script/Code.gs).
async function callAppsScript(action, payload = {}) {
  return appsScriptClient.callAppsScript(config.sheets.webAppUrl, config.sheets.sharedSecret, action, payload, '[sheets]');
}

function rowFromValues(headers, values, rowNumber) {
  const row = { _rowNumber: rowNumber };
  headers.forEach((h, i) => {
    row[h] = values[i] !== undefined ? values[i] : '';
  });
  return row;
}

/**
 * True if every cell in this row is blank. getTable_ (apps-script/Code.gs)
 * reads every row up to the sheet's last row of content, which can include
 * rows that are entirely empty (e.g. leftover from manual edits/deletes
 * done directly in Sheets). Loading those in as real rows would carry them
 * forward on every flush() forever - not just wasted space, but they land
 * at whatever sheet row their position sorts to, showing up as an
 * inexplicable gap between real data rows. Drop them at load time instead.
 */
function isBlankRow(row, headers) {
  return headers.every((h) => (row[h] || '') === '');
}

function assertInitialized() {
  if (!initialized) {
    throw new Error('sheets.init() must be called (and awaited) before any read/write - the local store is not loaded yet.');
  }
}

/** Pulls the entire spreadsheet into the local store. Call once at bot startup, before anything else in this module is used. */
async function init() {
  const { tables } = await callAppsScript('getAllTables');
  const next = new Map();
  for (const [tabName, { headers, values }] of Object.entries(tables)) {
    const rows = values
      .map((v, idx) => rowFromValues(headers, v, idx + 2)) // 1-indexed, +1 for header row
      .filter((row) => !isBlankRow(row, headers));
    next.set(tabName, { headers, rows });
  }
  store = next;
  dirty = false;
  initialized = true;
}

let flushChain = Promise.resolve({ skipped: true });

/**
 * Pushes the local store's current state up to the real Google Sheet,
 * replacing each tab's data rows wholesale. No-ops if nothing has changed
 * since the last flush.
 *
 * Callers (background sync timer, /refresh, and flushSoon() after every
 * registration commit) are NOT mutually exclusive with each other and can
 * fire close together, so this serializes them onto one chain rather than
 * letting two replaceAllTables() network calls run in parallel - with two
 * in flight at once, whichever happened to *start* with the older snapshot
 * could still *finish* second and silently overwrite the newer one that
 * "won" the race by responding first.
 */
function flush() {
  assertInitialized();
  // Chaining onto the previous call (rather than only running when idle)
  // also fixes a second, subtler race: a write landing in the local store
  // while a flush's network request is already in flight would otherwise
  // get folded into "nothing new happened" once that flush resolves (its
  // snapshot was taken before the write, but a naive `dirty = false` after
  // doesn't know that) - see doFlushOnce()'s generation check for the other
  // half of that fix. `.catch(() => {})` keeps one failed flush from
  // permanently blocking every flush queued after it.
  flushChain = flushChain.catch(() => {}).then(() => doFlushOnce());
  return flushChain;
}

async function doFlushOnce() {
  if (!dirty) return { skipped: true };

  const generationAtStart = storeGeneration;
  const tables = {};
  for (const [tabName, table] of store.entries()) {
    if (READ_ONLY_TABS.has(tabName)) continue; // never push PlayerDB/TeamDB - staff own that data
    tables[tabName] = {
      headers: table.headers,
      rows: table.rows
        .slice()
        .sort((a, b) => a._rowNumber - b._rowNumber)
        .map((row) => table.headers.map((h) => (row[h] !== undefined ? row[h] : ''))),
    };
  }

  await callAppsScript('replaceAllTables', { tables });

  // Only clear dirty if nothing wrote to the local store while that request
  // was in flight - a write that landed mid-flight wasn't in the snapshot
  // above, so it still needs a flush of its own. Leaving dirty alone here
  // means the *next* flush() call (chained right after this one resolves,
  // or the next scheduled/manual one) will pick it up instead of it being
  // silently dropped. This also protects refreshAllTables() below, which
  // trusts !dirty to mean "the local store has nothing unpushed and is
  // safe to wholesale-replace."
  if (storeGeneration === generationAtStart) dirty = false;
  return { skipped: false };
}

/**
 * Re-downloads EVERY tab (writable ones included, not just PlayerDB/TeamDB)
 * from the live Sheet and replaces the entire local store with it.
 *
 * Only safe to call once any local dirty writes are confirmed pushed (or
 * there were none) - this wholesale-replaces `store`, so any not-yet-flushed
 * local write would be silently discarded. Every call site below calls this
 * immediately after a successful flush() for that reason; it refuses to run
 * (and returns false) if `dirty` is still true when called, as a guard
 * against a future call site getting that ordering wrong.
 *
 * This is what lets a manual edit made directly in the Sheet against a
 * writable tab (e.g. staff deleting a bad row in PlayerRegistry) actually
 * stick - previously only PlayerDB/TeamDB were re-downloaded here, so a
 * writable-tab row deleted by hand in the Sheet stayed alive in the bot's
 * local memory and got written straight back on the next flush (e.g. the
 * next team signing up), silently undoing the manual fix.
 */
async function refreshAllTables() {
  assertInitialized();
  if (dirty) {
    console.error('[sheets] refreshAllTables() called with unflushed local writes pending - skipping to avoid losing them.');
    return false;
  }
  const generationAtStart = storeGeneration;
  const { tables } = await callAppsScript('getAllTables');

  // Same generation check as doFlushOnce() above, and for the same reason:
  // the dirty check up top only proves nothing was pending *before* this
  // network call started - a write landing during it (e.g. a registration
  // committing while a scheduled refresh is mid-flight) wouldn't be caught
  // by that check, and `store = next` below would otherwise silently
  // discard it. If that happened, bail without touching `store` - dirty is
  // already true again from that write, so the next flush()+refresh cycle
  // (chained onto flushChain, so it can't overlap this one) will pick it up
  // correctly instead.
  if (storeGeneration !== generationAtStart) {
    console.error('[sheets] refreshAllTables() detected a write during its own fetch - discarding this refresh to avoid losing it. Will retry next sync.');
    return false;
  }

  const next = new Map();
  for (const [tabName, { headers, values }] of Object.entries(tables)) {
    const rows = values
      .map((v, idx) => rowFromValues(headers, v, idx + 2))
      .filter((row) => !isBlankRow(row, headers));
    next.set(tabName, { headers, rows });
  }
  store = next;
  return true;
}

/** Starts the periodic background push to Google Sheets. Call once, after init(). */
function startBackgroundSync(intervalMs, onFlushSuccess) {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    const flushStartedAt = Date.now();
    // refreshAllTables() only runs after flush() resolves (not in parallel
    // with it) - it must never run while a push could still be in flight or
    // could still fail, or it'd wholesale-discard those unpushed local writes.
    flush()
      .then((result) => {
        if (!result.skipped && typeof onFlushSuccess === 'function') onFlushSuccess(flushStartedAt);
        return refreshAllTables();
      })
      .then(() => {
        consecutiveSyncFailures = 0;
      })
      .catch((err) => {
        consecutiveSyncFailures += 1;
        const message = `[sheets] Background sync to Google Sheets failed (will retry next interval): ${err.message}`;
        if (consecutiveSyncFailures >= SYNC_FAILURE_ALERT_THRESHOLD) {
          console.error(`${message} - this is sync failure #${consecutiveSyncFailures} in a row; the live Google Sheet may be stale, worth checking.`);
        } else {
          console.warn(message);
        }
      });
  }, intervalMs);
  // Don't let this timer alone keep the process alive (e.g. during a clean shutdown).
  if (typeof syncTimer.unref === 'function') syncTimer.unref();
}

function stopBackgroundSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/**
 * Reads all rows from a tab. Assumes row 1 is a header row.
 * Returns { headers: string[], rows: object[] } where each row object
 * is keyed by header name. Purely local - no network call.
 */
async function getTable(tabName) {
  assertInitialized();
  const table = store.get(tabName);
  if (!table) return { headers: [], rows: [] };
  return { headers: table.headers, rows: table.rows.map((r) => ({ ...r })) };
}

/**
 * Appends a single row to a tab. rowObject keys must match header names;
 * missing keys are written as empty strings. Extra keys not in headers are ignored.
 */
async function appendRow(tabName, rowObject) {
  assertInitialized();
  const table = store.get(tabName);
  if (!table) throw new Error(`Unknown tab: ${tabName}`);

  const nextRowNumber = table.rows.length > 0 ? Math.max(...table.rows.map((r) => r._rowNumber)) + 1 : 2;
  const row = rowFromValues(table.headers, table.headers.map((h) => (rowObject[h] !== undefined ? rowObject[h] : '')), nextRowNumber);
  table.rows.push(row);
  dirty = true;
  storeGeneration += 1;
}

/**
 * Overwrites a specific row (by 1-indexed sheet row number, as returned in
 * _rowNumber from getTable) with new values. Only provided keys are updated;
 * others retain existing values.
 */
async function updateRow(tabName, rowNumber, rowObject) {
  assertInitialized();
  const table = store.get(tabName);
  if (!table) throw new Error(`Unknown tab: ${tabName}`);

  let existing = table.rows.find((r) => r._rowNumber === rowNumber);
  if (!existing) {
    // Shouldn't normally happen - callers always get rowNumber from a row
    // they just read - but stay lenient rather than throwing, matching the
    // old network-backed version's behavior.
    existing = { _rowNumber: rowNumber };
    table.rows.push(existing);
    table.rows.sort((a, b) => a._rowNumber - b._rowNumber);
  }

  const merged = { ...existing, ...rowObject };
  table.headers.forEach((h) => {
    existing[h] = merged[h] !== undefined ? merged[h] : '';
  });
  dirty = true;
  storeGeneration += 1;
}

/** Returns the entire local store (all tabs) - local-only, no network call. Used by services/localSnapshot.js. */
async function getAllTablesLocal() {
  assertInitialized();
  const out = {};
  for (const [tabName, table] of store.entries()) {
    out[tabName] = { headers: table.headers, rows: table.rows.map((r) => ({ ...r })) };
  }
  return out;
}

/** Finds the first row matching a predicate. Returns undefined if none found. */
async function findRow(tabName, predicate) {
  const { rows } = await getTable(tabName);
  return rows.find(predicate);
}

/** Finds all rows matching a predicate. */
async function findRows(tabName, predicate) {
  const { rows } = await getTable(tabName);
  return rows.filter(predicate);
}

module.exports = {
  init,
  flush,
  startBackgroundSync,
  stopBackgroundSync,
  getTable,
  getAllTablesLocal,
  refreshAllTables,
  appendRow,
  updateRow,
  findRow,
  findRows,
};
