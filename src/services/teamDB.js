const sheets = require('./sheets');
const config = require('../config');
const sessions = require('../utils/sessions');
const { normalizeTeamName, combinedSimilarity, FUZZY_MATCH_MIN_CONFIDENCE, FUZZY_MATCH_MIN_MARGIN } = require('../utils/teamNameMatch');

const TAB = config.sheets.tabs.teamDB;
const SLOT_TYPE = sessions.SLOT_TYPE;

// Must match the TeamDB entry in apps-script/Code.gs's SCHEMA exactly - see
// playerDB.js's EXPECTED_HEADERS for why this matters.
const EXPECTED_HEADERS = ['team_role_id', 'team_name', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 's1', 's2', 'c1', 'c2', 'logo_url', 'vc_channel_id'];

// p1-p6 are always mains. s1/s2 are subs, c1/c2 are coaches - kept as
// separate columns (rather than one ambiguous sub-or-coach pair) so
// there's no free-text/prefix parsing that staff data entry could get
// wrong.
const MAIN_COLUMNS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const SUB_COLUMNS = ['s1', 's2'];
const COACH_COLUMNS = ['c1', 'c2'];

/**
 * Read-only lookup against the TeamDB tab - historical team rosters staff
 * maintain by hand. Same rules as playerDB.js: bot never writes to this
 * tab, and the local copy only refreshes on bot restart.
 */

/**
 * Finds TeamDB rows whose team_role_id matches any of the given Discord
 * role IDs. team_role_id is the Discord role snowflake itself (see
 * Code.gs, and Teams' own column of the same name in teams.js), so this
 * is an exact ID match, no name collisions possible. Returns every
 * distinct match rather than just the first, so callers can detect and
 * handle an ambiguous multi-match case.
 */
async function findTeamsByRoleIds(roleIds) {
  const idSet = new Set(roleIds.filter(Boolean));
  if (idSet.size === 0) return [];

  const { rows } = await sheets.getTable(TAB);
  const seen = new Set();
  const matches = [];
  for (const row of rows) {
    const teamRoleId = (row.team_role_id || '').trim();
    if (!teamRoleId || !idSet.has(teamRoleId)) continue;
    if (seen.has(teamRoleId)) continue;
    seen.add(teamRoleId);
    matches.push(row);
  }
  return matches;
}

/**
 * Finds TeamDB rows matching team_name: an exact (normalized) match if
 * one exists, otherwise falls back to fuzzy matching (see
 * ../utils/teamNameMatch) so a captain typing "weird and spectacular"
 * still finds "Weird & Spectacular". Used to offer a historical
 * re-registration to a captain who no longer holds (or never held) the
 * team's Discord role - unlike findTeamsByRoleIds, this is a
 * self-reported claim, not proof of identity, so callers must not skip
 * the normal staff-approval gate off the back of a match here.
 *
 * Returns: [] for no match, a single-row array for a confident match
 * (exact, or a fuzzy match that clearly beat every other candidate), or
 * multiple rows when the match is genuinely ambiguous (an exact
 * duplicate name in the sheet, or two+ fuzzy candidates too close to
 * call) - callers treat 2+ as "needs manual resolution", same as
 * findTeamsByRoleIds' ambiguous case.
 */
async function findTeamsByName(teamName) {
  const normalized = normalizeTeamName(teamName);
  if (!normalized) return [];

  const { rows } = await sheets.getTable(TAB);

  const exact = rows.filter((row) => normalizeTeamName(row.team_name) === normalized);
  if (exact.length) return exact;

  const scored = rows
    .map((row) => ({ row, score: combinedSimilarity(teamName, row.team_name || '') }))
    .filter((s) => s.score >= FUZZY_MATCH_MIN_CONFIDENCE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];
  if (scored.length === 1) return [scored[0].row];

  const clearWinner = scored[0].score - scored[1].score >= FUZZY_MATCH_MIN_MARGIN;
  if (clearWinner) return [scored[0].row];

  return scored.filter((s) => scored[0].score - s.score < FUZZY_MATCH_MIN_MARGIN).map((s) => s.row);
}

/**
 * Flattens a TeamDB row into a roster shape: [{ steamIdRaw, slotType }],
 * skipping blank slots. steamIdRaw is whatever staff typed into that cell -
 * still needs resolving via steam.js before use elsewhere (see teamDB usage
 * in registrationFlow.js).
 */
function rosterFromTeamRow(row) {
  const slots = [];
  for (const col of MAIN_COLUMNS) {
    const val = (row[col] || '').trim();
    if (val) slots.push({ steamIdRaw: val, slotType: SLOT_TYPE.MAIN });
  }
  for (const col of SUB_COLUMNS) {
    const val = (row[col] || '').trim();
    if (val) slots.push({ steamIdRaw: val, slotType: SLOT_TYPE.SUB });
  }
  for (const col of COACH_COLUMNS) {
    const val = (row[col] || '').trim();
    if (val) slots.push({ steamIdRaw: val, slotType: SLOT_TYPE.COACH });
  }
  return slots;
}

/** Same check as playerDB.js's getHeaderWarning - see there for why this matters. */
async function getHeaderWarning() {
  const { headers } = await sheets.getTable(TAB);
  const actual = new Set(headers.map((h) => h.trim().toLowerCase()));
  const missing = EXPECTED_HEADERS.filter((h) => !actual.has(h));
  if (missing.length === 0) return null;
  return `TeamDB tab is missing expected column(s): ${missing.join(', ')} (actual headers: ${headers.join(', ') || '(none)'}). Those field(s) will read as blank until the header row is fixed to match.`;
}

module.exports = {
  findTeamsByRoleIds,
  findTeamsByName,
  rosterFromTeamRow,
  getHeaderWarning,
};
