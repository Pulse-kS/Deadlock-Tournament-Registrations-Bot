const sheets = require('./sheets');
const config = require('../config');

const TAB = config.sheets.tabs.playerDB;

// Must match the PlayerDB entry in apps-script/Code.gs's SCHEMA exactly -
// this module reads columns by these exact names (see getPlayerRecord
// below). If staff typed different header text into row 1 of the actual
// sheet (e.g. "Best Name" instead of "best_name"), every lookup against
// that column silently returns '' instead of erroring, which is why
// getHeaderWarning() below checks for this explicitly rather than trusting
// it silently.
const EXPECTED_HEADERS = ['account_id', 'discord_id', 'nationality', 'best_name', 'past_igns', 'past_discord_names'];

/**
 * Read-only lookup against the PlayerDB tab - historical player data staff
 * maintain by hand (e.g. imported from past events), living in the same
 * spreadsheet/local-first store as everything else in services/sheets.js.
 * This module never writes to that tab - staff own that data; the bot only
 * ever calls sheets.findRow, never appendRow/updateRow, against it.
 *
 * Because it's part of the same local-first store as PlayerRegistry/Teams/
 * etc, it follows the same rules as those (see sheets.js): loaded once at
 * bot startup, no live re-fetch - a staff edit needs a bot restart to be
 * picked up.
 */

/** Returns the PlayerDB row for an account ID, or undefined if none on file. */
async function getPlayerRecord(accountId) {
  const row = await sheets.findRow(TAB, (r) => r.account_id === accountId);
  if (!row) return undefined;

  return {
    accountId: row.account_id,
    discordId: (row.discord_id || '').trim(),
    nationality: (row.nationality || '').trim(),
    bestName: (row.best_name || '').trim(),
    pastIgns: (row.past_igns || '').trim(),
    pastDiscordNames: (row.past_discord_names || '').trim(),
  };
}

/**
 * Compares the PlayerDB tab's actual row-1 headers against what this module
 * expects. Returns a human-readable warning string if any expected column
 * is missing (case/whitespace-insensitive match), or null if everything
 * lines up. A missing column doesn't throw anywhere upstream - it just
 * makes that field silently blank in every lookup - so this is the only
 * way to actually notice the mismatch.
 */
async function getHeaderWarning() {
  const { headers } = await sheets.getTable(TAB);
  const actual = new Set(headers.map((h) => h.trim().toLowerCase()));
  const missing = EXPECTED_HEADERS.filter((h) => !actual.has(h));
  if (missing.length === 0) return null;
  return `PlayerDB tab is missing expected column(s): ${missing.join(', ')} (actual headers: ${headers.join(', ') || '(none)'}). Those field(s) will read as blank until the header row is fixed to match.`;
}

module.exports = {
  getPlayerRecord,
  getHeaderWarning,
};
