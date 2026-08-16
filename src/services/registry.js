const sheets = require('./sheets');
const config = require('../config');

const TAB = config.sheets.tabs.playerRegistry;
const FLAGS_TAB = config.sheets.tabs.flags;

/** Returns the registry row for an account ID, or undefined if not registered yet. */
async function getPlayerByAccountId(accountId) {
  return sheets.findRow(TAB, (r) => r.account_id === accountId);
}

/** Returns the registry row for a Discord user ID, or undefined if none on file. Used on guildMemberAdd to resolve account_id, then check current team via teams.findTeamContainingAccountId. */
async function findPlayerByDiscordId(discordId) {
  return sheets.findRow(TAB, (r) => r.discord_id === discordId);
}

/**
 * Fetches the whole PlayerRegistry table once and returns it as an
 * account_id -> row Map. Use this instead of calling getPlayerByAccountId in
 * a loop - each call to that is its own Apps Script round trip, so looking
 * up N players one at a time costs N round trips instead of 1.
 */
async function getPlayersMap() {
  const { rows } = await sheets.getTable(TAB);
  const map = new Map();
  for (const row of rows) {
    map.set(row.account_id, row);
  }
  return map;
}

/**
 * Ensures a player exists in the registry, as a pure identity record - no
 * team/roster placement here (that lives on Teams' own
 * p1-p6/s1/s2/c1/c2 columns; see services/teams.js).
 * - If new: creates the row.
 * - If existing and statlocker username differs from what's on file: does NOT
 *   overwrite silently. Raises a flag row for staff review and keeps the
 *   existing on-file name authoritative for this registration.
 * Returns { player, flagged } where player is the registry row in use
 * (existing on-file data if flagged, otherwise the newly written data).
 *
 * Deliberately does NOT store ppScore/MMR - see statlocker.js for why.
 */
async function upsertPlayer({ accountId, statlockerUsername, discordId, nationality, displayName }, context = {}) {
  const existing = await getPlayerByAccountId(accountId);

  if (!existing) {
    const newRow = {
      account_id: accountId,
      statlocker_username: statlockerUsername,
      discord_id: discordId || '',
      historical_names: statlockerUsername,
      nationality: nationality || '',
      display_name: displayName || '',
    };
    await sheets.appendRow(TAB, newRow);
    return { player: newRow, flagged: false };
  }

  const onFileName = existing.statlocker_username;
  if (onFileName && statlockerUsername && onFileName !== statlockerUsername) {
    await raiseFlag({
      type: 'name_mismatch',
      accountId,
      onFileName,
      newName: statlockerUsername,
      tournament: context.tournamentName || '',
      raisedBy: context.discordUserTag || '',
    });
    // Keep existing on-file identity authoritative.
    // Nationality isn't identity-critical (unlike the display name), so
    // it's safe to update directly rather than flagging.
    await sheets.updateRow(TAB, existing._rowNumber, {
      nationality: nationality || existing.nationality,
      display_name: displayName || existing.display_name,
    });
    return { player: existing, flagged: true };
  }

  // Name matches (or no prior name on file) - just refresh discord linkage/nationality.
  await sheets.updateRow(TAB, existing._rowNumber, {
    discord_id: discordId || existing.discord_id,
    nationality: nationality || existing.nationality,
    display_name: displayName || existing.display_name,
  });
  return { player: existing, flagged: false };
}

async function raiseFlag({ type, accountId, onFileName, newName, tournament, raisedBy }) {
  await sheets.appendRow(FLAGS_TAB, {
    timestamp: new Date().toISOString(),
    type,
    account_id: accountId,
    on_file_name: onFileName,
    new_name: newName,
    tournament,
    raised_by: raisedBy,
    resolved: 'FALSE',
  });
}

module.exports = {
  getPlayerByAccountId,
  findPlayerByDiscordId,
  getPlayersMap,
  upsertPlayer,
  raiseFlag,
};
