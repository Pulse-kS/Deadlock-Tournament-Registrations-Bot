const fs = require('fs');
const path = require('path');
const { dataDir } = require('../utils/dataDir');
const sheets = require('./sheets');

/**
 * Writes the ENTIRE local sheets.js store to disk as JSON, as a fast
 * write-only safety net: SHEETS_SYNC_INTERVAL_MINUTES defaults to 60, so
 * without this, an ungraceful crash (killed process, power loss, OOM - not
 * a clean SIGTERM, which already flushes to Google Sheets on the way out)
 * could lose up to an hour of committed registrations. This file is meant
 * to close that gap to "however long the last snapshot write took" (well
 * under a second for this data size) instead.
 *
 * Deliberately NEVER read back automatically on startup. Google Sheets
 * stays the single source of truth on boot - reconciling two possibly-
 * conflicting copies isn't worth the complexity for a single-operator bot.
 * If the bot crashes before a sync and this snapshot is ahead of the real
 * sheet, recovery is manual: open sheets-snapshot.json and re-enter/import
 * whatever's missing.
 *
 * JSON, not .xlsx: this is only ever opened by a human in a rare emergency,
 * and needs to write fast enough it's never perceptible after a commit -
 * JSON is both simpler to produce and faster to write than a real
 * spreadsheet file. Trivial to eyeball or convert by hand if that ever
 * comes up.
 */

const SNAPSHOT_PATH = path.join(dataDir(), 'sheets-snapshot.json');
const TMP_PATH = `${SNAPSHOT_PATH}.tmp`;

async function writeSnapshot() {
  const tables = await sheets.getAllTablesLocal();
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), tables }, null, 2);

  // Write to a temp file then rename over the real path - rename is atomic
  // on the same filesystem, so a crash mid-write never leaves a
  // half-written (and therefore useless) snapshot at SNAPSHOT_PATH.
  await fs.promises.writeFile(TMP_PATH, payload);
  await fs.promises.rename(TMP_PATH, SNAPSHOT_PATH);
}

module.exports = { writeSnapshot, SNAPSHOT_PATH };
