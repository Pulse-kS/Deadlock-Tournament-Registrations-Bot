const sheets = require('./sheets');
const config = require('../config');

const TAB = config.sheets.tabs.freeAgents;

/**
 * FreeAgents tab access. Row writes for a *new* free-agent signup still
 * happen in registrationFlow.js's writeFreeAgentToSheets (that path also
 * needs to touch PlayerRegistry in the same job, so it isn't a clean fit
 * here) - this module is for the other direction: looking a free agent up
 * by account_id, and removing their row once they've joined a team roster
 * (see performCommit's free-agent-to-roster handling).
 */

/** Returns the FreeAgents row for an account ID, or undefined if none on file. */
async function findByAccountId(accountId) {
  return sheets.findRow(TAB, (r) => r.account_id === accountId);
}

/**
 * Removes a player's FreeAgents row, e.g. once they've been added to a
 * team roster and are no longer an unrostered signup. No-op (returns
 * false) if they have no FreeAgents row to remove.
 */
async function remove(accountId) {
  const existing = await findByAccountId(accountId);
  if (!existing) return false;
  await sheets.deleteRow(TAB, existing._rowNumber);
  return true;
}

module.exports = {
  findByAccountId,
  remove,
};
