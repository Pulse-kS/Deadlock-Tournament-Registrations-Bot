/**
 * Tournament Registration Bot - Apps Script backend.
 *
 * Bind this script to your Google Sheet (Extensions > Apps Script), paste
 * this file in as Code.gs, then:
 *   1. Project Settings > Script Properties > add SHARED_SECRET
 *      (any long random string - it must match APPS_SCRIPT_SECRET in the
 *      bot's .env), and STATLOCKER_API_KEY if you want
 *      STATLOCKER_AVERAGE_PPSCORE available. Add CONTROL_SHEET_ID too if
 *      you'll send roster cards to the Control Sheet (see
 *      runRosterTemplate_'s doc comment) - the Control Sheet's
 *      spreadsheet ID.
 *   2. Run setupSheet() once from the editor (select it in the function
 *      dropdown, click Run) to create all tabs + header rows + lock the
 *      *_id columns to Plain Text (see note on that below). Safe to re-run
 *      against a live sheet - it only ever writes to a tab whose header
 *      row is blank or already matches SCHEMA exactly; anything else (a
 *      different order, a renamed/missing/extra column) is left untouched
 *      and reported in the log instead of being rewritten. If a tab's real
 *      header row has a column SCHEMA below no longer lists, or is missing
 *      one it does list, fix that by hand (delete/add/rename the column
 *      directly in Sheets, matching SCHEMA exactly) so a re-run picks it
 *      up - see replaceAllTables_'s doc comment for what happens if a
 *      column the bot expects to write is missing entirely.
 *   3. Deploy > New deployment > type "Web app".
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the deployment URL into APPS_SCRIPT_URL in the bot's .env.
 *   4. For the Tournament Admin sidebar (Send Rosters / Update Database /
 *      Clear Signups, no Discord or terminal needed): File > New > Html
 *      file in the script editor, name it exactly "ControlPanel", and
 *      paste in apps-script/ControlPanel.html's contents. Reload the
 *      spreadsheet - a "Tournament Admin" menu appears with an "Open
 *      Control Panel" item. No redeploy needed for this part (unlike the
 *      web app above, sidebar/menu changes take effect on next spreadsheet
 *      load).
 *
 * Teams is the single source of truth for the current event's roster
 * membership: p1-p6 (mains), s1/s2 (subs), c1/c2 (coaches) hold each slot's
 * account_id directly on the team row. TeamDB mirrors that same shape
 * (down to matching column names, including team_role_id) so a finished
 * event's Teams rows can be copied straight into TeamDB with no reshaping -
 * see the README's "Migrating a finished event" section. PlayerRegistry
 * holds pure player identity only - no roster/team fields live there.
 *
 * Teams and TeamDB both carry a logo_url column: the bot uploads a
 * captain's logo to Nextcloud (see nextcloud.js) and writes the resulting
 * URL there; TeamDB's copy is how a returning team's logo carries forward
 * without a fresh upload each event.
 *
 * Teams and TeamDB both also carry a vc_channel_id column, same shape and
 * same reason: the bot creates a private team voice channel on a team's
 * first commit and writes its snowflake there; TeamDB's copy is how a
 * returning team's channel gets reused (rather than a duplicate created)
 * next event, same as logo_url.
 *
 * STATLOCKER_AVERAGE_PPSCORE(range) is a custom sheet function for
 * on-demand average ppScore lookups (e.g. seeding) - see its own doc
 * comment below. It counts a player with too few recorded games for
 * statlocker to compute a ppScore as 0 in the average (rather than
 * dropping them from the denominator), and spills a warning into the cell
 * to the right whenever that happens.
 *
 * "Who has access: Anyone" sounds alarming, but nobody can do anything
 * without a valid HMAC signature over SHARED_SECRET - every request is
 * rejected without one. Requests carry a signature + timestamp instead of
 * the secret itself (see doPost/computeSignature_ below), so the secret
 * never travels on the wire and a captured request can't be replayed past
 * SIGNATURE_WINDOW_MS. Treat SHARED_SECRET like a password all the same
 * (don't commit it, don't post the deployment URL + secret together
 * anywhere public) - anyone who has it can still sign valid requests.
 *
 * Re-deploy (New deployment, not just Save) any time you edit this file -
 * Apps Script web apps don't hot-reload an existing deployment.
 */

const SCHEMA = {
  // Pure player identity: who someone is, not what team they're on -
  // roster/team membership lives entirely on Teams below.
  PlayerRegistry: ['account_id', 'discord_id', 'display_name', 'nationality', 'statlocker_username', 'historical_names'],
  // p1-p6 (mains), s1/s2 (subs), c1/c2 (coaches) hold that slot's
  // account_id directly on the team row - this is the only place current
  // roster membership lives. Deliberately the same shape as TeamDB below
  // (right down to column names and order) so post-event migration is a
  // straight row copy: no reshaping, no join against another tab.
  Teams: [
    'team_role_id',
    'team_name',
    // Team logo, captured via image upload in the registration thread (see
    // registrationFlow.js's handleMessage) - a Nextcloud share link when
    // NEXTCLOUD_SHARE_URL is configured (see nextcloud.js), otherwise a
    // raw Discord CDN attachment URL.
    'logo_url',
    // Snowflake of the team's private voice channel (see teams.js's
    // createTeamVoiceChannel) - blank until the bot creates one, which
    // only happens once TEAM_VC_CATEGORY_ID is configured on the bot side.
    'vc_channel_id',
    'p1',
    'p2',
    'p3',
    'p4',
    'p5',
    'p6',
    's1',
    's2',
    'c1',
    'c2',
  ],
  Flags: ['timestamp', 'type', 'account_id', 'on_file_name', 'new_name', 'tournament', 'raised_by', 'resolved'],
  // Historical player data staff maintain by hand (e.g. imported from past
  // events) - the bot only ever reads this tab (see src/services/
  // playerDB.js), never writes to it. Same local-first load-at-startup
  // rules as every other tab here apply: edit it while the bot is stopped,
  // or expect edits to be overwritten on the next background sync.
  PlayerDB: ['account_id', 'discord_id', 'best_name', 'nationality', 'past_igns', 'past_discord_names'],
  // Historical team rosters staff maintain by hand - same read-only,
  // bot-never-writes rules as PlayerDB above (see src/services/teamDB.js).
  // team_role_id is the Discord role snowflake for that team's role (from
  // whichever past event it last played), NOT an arbitrary label - the bot
  // matches a captain's currently-held roles against this column by exact
  // ID (see findHistoricalTeamMatch in registrationFlow.js). p1-p6 hold a
  // Steam ID for that slot - the bot runs each one through steam.js's
  // resolver before use, so SteamID64, a full numeric profile URL,
  // SteamID2/3, or a plain account_id all work here (unlike Teams above,
  // which only ever gets a plain account_id, always written by the bot
  // itself). Vanity URLs (steamcommunity.com/id/...) do NOT resolve (see
  // steam.js) - use one of the numeric forms instead. s1/s2 (subs) and
  // c1/c2 (coaches) are separate columns rather than a combined
  // sub-or-coach pair specifically so staff data entry can't mix the two
  // up. logo_url and vc_channel_id are staff's manually-copied-forward
  // versions of Teams' own columns of the same name - see this file's top
  // comment for how that copy happens.
  TeamDB: ['team_role_id', 'team_name', 'logo_url', 'vc_channel_id', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 's1', 's2', 'c1', 'c2'],
  // One row per player who signed up as a free agent (no team, no roster
  // slot) via /register's "I am a Free Agent" path - see
  // registrationFlow.js's finalizeFreeAgent/writeFreeAgentToSheets.
  // `wants_team` is "Yes"/"No" - whether the player asked to be assigned a
  // team, versus only being available as an emergency substitute.
  FreeAgents: ['account_id', 'discord_id', 'display_name', 'nationality', 'statlocker_username', 'wants_team'],
};

// How many data rows to pre-format as Plain Text on the *_id columns.
// Increase (and re-run setupSheet) if you exceed this many registrations.
const ID_COLUMN_PREFORMAT_ROWS = 2000;

/**
 * One-time (or re-runnable) setup: creates any missing tabs, writes header
 * rows, and formats every "*_id" column as Plain Text.
 *
 * The Plain Text formatting matters: Discord snowflakes and Steam64 IDs are
 * long enough (17-19 digits) to exceed the precision Sheets can hold in a
 * Number cell, so a plain number cell can silently corrupt an ID. Formatting
 * those columns as text before any data lands in them stops Sheets from
 * ever auto-converting the strings the bot writes.
 *
 * Safe to re-run against a live, populated, already-customized sheet: a tab
 * is only ever written to if its header row is currently BLANK (brand new
 * tab) or EXACTLY matches SCHEMA already (in which case only formatting is
 * reapplied - header text isn't rewritten). Any tab whose header row is
 * non-blank and doesn't exactly match SCHEMA - a different column order, a
 * renamed column, a still-on-an-older-schema-version tab, anything - is
 * left completely untouched, and reported in the log instead. This matters
 * because every other function in this file locates a column by matching
 * header TEXT, not position - so blindly overwriting row 1 to the "correct"
 * headers would relabel whatever's in each column without moving the data
 * beneath it, silently corrupting every row under a changed column. If a
 * tab genuinely needs to move to a new column layout, that means manually
 * moving the underlying data columns to match (e.g. cut/insert a column in
 * Sheets), not re-running this function - then a re-run will pick it up as
 * a match. To deliberately reset a single tab to SCHEMA's current layout,
 * clear just its header row (row 1) by hand first; a blank header row is
 * always safe to (re)write, same as a brand new tab.
 */
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const created = [];
  const alreadyCorrect = [];
  const skipped = [];

  Object.entries(SCHEMA).forEach(([name, headers]) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      writeHeaders_(sheet, headers);
      created.push(name);
      return;
    }

    const existingHeaders =
      sheet.getLastColumn() > 0
        ? sheet
            .getRange(1, 1, 1, sheet.getLastColumn())
            .getValues()[0]
            .map((h) => (h || '').toString().trim())
            .filter(Boolean)
        : [];

    if (existingHeaders.length === 0) {
      // Tab exists (e.g. created by hand) but has no header row yet -
      // nothing to conflict with, safe to write fresh.
      writeHeaders_(sheet, headers);
      created.push(name);
      return;
    }

    const exactMatch = existingHeaders.length === headers.length && existingHeaders.every((h, i) => h === headers[i]);
    if (exactMatch) {
      formatIdColumns_(sheet, headers); // idempotent - safe to reapply even when nothing changed
      alreadyCorrect.push(name);
      return;
    }

    const missing = headers.filter((h) => !existingHeaders.includes(h));
    const unexpected = existingHeaders.filter((h) => !headers.includes(h));
    const reordered = !missing.length && !unexpected.length; // same columns, different order
    skipped.push(
      `${name} (${reordered ? 'columns present but reordered' : 'differs'} - existing: [${existingHeaders.join(', ')}]` +
        (missing.length ? `; SCHEMA has but tab doesn't: [${missing.join(', ')}]` : '') +
        (unexpected.length ? `; tab has but SCHEMA doesn't: [${unexpected.join(', ')}]` : '') +
        ')'
    );
  });

  Logger.log(
    (created.length ? `Created/initialized (fresh header row written): ${created.join(', ')}. ` : '') +
      (alreadyCorrect.length ? `Already matches SCHEMA (formatting only reapplied): ${alreadyCorrect.join(', ')}. ` : '') +
      (skipped.length
        ? `SKIPPED, left untouched (see doc comment above for why): ${skipped.join(' | ')}.`
        : '') +
      (created.length || alreadyCorrect.length || skipped.length ? '' : 'Nothing to do.')
  );
}

function writeHeaders_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  formatIdColumns_(sheet, headers);
}

function formatIdColumns_(sheet, headers) {
  headers.forEach((header, i) => {
    if (header.indexOf('_id') !== -1) {
      sheet.getRange(1, i + 1, ID_COLUMN_PREFORMAT_ROWS + 1, 1).setNumberFormat('@');
    }
  });
}

/**
 * One-time migration for sheets that already have data from before the
 * switch to account_id as the canonical identifier (was steam_id64) and the
 * removal of the mmr column (ppScore is no longer recorded via the API -
 * see statlocker.js for why). Safe to re-run - already-migrated values
 * (plain account IDs, no mmr column) are left untouched.
 *
 * Run this once from the editor after pulling in this version of Code.gs,
 * THEN run setupSheet() to make sure headers/formatting are fully in sync.
 * If you don't have any real registration data yet (e.g. just test rows
 * you don't mind losing), it's simpler to just clear PlayerRegistry/Flags
 * and run setupSheet() fresh instead of migrating.
 */
function migrateSteamIdToAccountId() {
  const STEAM64_BASE = 76561197960265728;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let totalConverted = 0;

  ['PlayerRegistry', 'Flags'].forEach((tabName) => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) return;

    const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let colIndex = headerRow.indexOf('steam_id64');
    if (colIndex === -1) colIndex = headerRow.indexOf('account_id');
    if (colIndex === -1) return;

    sheet.getRange(1, colIndex + 1).setValue('account_id');

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    const range = sheet.getRange(2, colIndex + 1, lastRow - 1, 1);
    const values = range.getDisplayValues();
    const converted = values.map(([v]) => {
      const trimmed = (v || '').toString().trim();
      if (/^7656119\d{10}$/.test(trimmed)) {
        totalConverted++;
        return [(BigInt(trimmed) - BigInt(STEAM64_BASE)).toString()];
      }
      return [trimmed];
    });
    range.setValues(converted);
  });

  const registrySheet = ss.getSheetByName('PlayerRegistry');
  if (registrySheet) {
    const headers = registrySheet.getRange(1, 1, 1, registrySheet.getLastColumn()).getValues()[0];
    const mmrCol = headers.indexOf('mmr');
    if (mmrCol !== -1) {
      registrySheet.deleteColumn(mmrCol + 1);
      Logger.log('Removed unused mmr column from PlayerRegistry.');
    }
  }

  Logger.log(
    `Migration complete. Converted ${totalConverted} SteamID64 value(s) to account_id. ` +
      'Now run setupSheet() to sync headers/formatting fully.'
  );
}

/**
 * One-time migration for the 20260815 PlayerRegistry/PlayerDB column
 * cleanup: drops PlayerRegistry's `last_synced` column (unused - nothing
 * ever read it) and reorders both tabs' columns to
 * account_id/discord_id/best-or-display-name/nationality/igns-or-
 * statlocker/historical-or-past-discord-names, matching SCHEMA above.
 *
 * setupSheet() deliberately refuses to touch a tab whose header row is
 * non-blank and doesn't exactly match SCHEMA (see its doc comment) - so a
 * plain re-run of setupSheet() alone will NOT apply this reorder. Run this
 * function once instead, then setupSheet() afterward to reapply
 * formatting; it's what actually moves the underlying data columns.
 *
 * Safe to re-run: reads each row keyed by header TEXT (order-independent),
 * so already-migrated tabs just get rewritten in the same order (a no-op).
 * Any column present on the sheet but not in SCHEMA (e.g. `last_synced`,
 * or a staff-added column) is dropped - if you've added your own columns
 * to either tab, note them down before running this, since they won't be
 * restored automatically.
 */
function migratePlayerColumnOrder() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = [];

  ['PlayerRegistry', 'PlayerDB'].forEach((tabName) => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      results.push(`${tabName}: tab not found, skipped.`);
      return;
    }

    const newHeaders = SCHEMA[tabName];
    const lastCol = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    if (lastCol === 0) {
      results.push(`${tabName}: no header row, skipped (run setupSheet() to initialize it fresh).`);
      return;
    }

    const existingHeaders = sheet
      .getRange(1, 1, 1, lastCol)
      .getValues()[0]
      .map((h) => (h || '').toString().trim());
    const dropped = existingHeaders.filter((h) => h && !newHeaders.includes(h));

    let newRows = [];
    if (lastRow >= 2) {
      const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      newRows = values.map((row) =>
        newHeaders.map((h) => {
          const idx = existingHeaders.indexOf(h);
          return idx === -1 ? '' : row[idx];
        })
      );
    }

    sheet.clearContents();
    sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
    if (newRows.length) {
      sheet.getRange(2, 1, newRows.length, newHeaders.length).setValues(newRows);
    }
    // Clear stale formatting left over from the old (possibly wider) layout.
    if (lastCol > newHeaders.length) {
      sheet.getRange(1, newHeaders.length + 1, Math.max(lastRow, 1), lastCol - newHeaders.length).clear();
    }

    results.push(`${tabName}: reordered to [${newHeaders.join(', ')}]` + (dropped.length ? `; dropped column(s): [${dropped.join(', ')}]` : '') + '.');
  });

  Logger.log(results.join(' ') + ' Now run setupSheet() to reapply formatting.');
}

/** Builds a { headerName: columnIndex } map (0-indexed) from a header row. */
function headerIndexMap_(headers) {
  const map = {};
  headers.forEach((h, i) => {
    map[h] = i;
  });
  return map;
}

/**
 * Throws if any of `fields` is missing from `indexMap` (built by
 * headerIndexMap_) - used so a renamed/missing column fails loudly with a
 * clear message instead of the migration silently writing blanks.
 */
function assertHasColumns_(tabName, indexMap, fields) {
  const missing = fields.filter((f) => !(f in indexMap));
  if (missing.length) {
    throw new Error(`${tabName} tab is missing column(s) required for migration: ${missing.join(', ')}`);
  }
}

/**
 * Merges `newValues` into a comma-separated `existingCsv` string, appending
 * only values not already present (case-insensitive, trimmed) and
 * preserving existing order/casing. Shared by migratePlayerRegistryToPlayerDB
 * for both `past_igns` and `past_discord_names`, which are both "append any
 * new distinct value, never delete" fields.
 */
function mergeCsvList_(existingCsv, newValues) {
  const existing = (existingCsv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  (newValues || []).forEach((v) => {
    const trimmed = (v || '').trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) return;
    seen.add(trimmed.toLowerCase());
    existing.push(trimmed);
  });
  return existing.join(', ');
}

// Same shape in both tabs by design (see this file's top comment) - one
// field list drives both the match/read and the write for the migration.
const TEAM_MIGRATION_FIELDS = ['team_role_id', 'team_name', 'logo_url', 'vc_channel_id', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 's1', 's2', 'c1', 'c2'];

/**
 * Copies every `Teams` row into `TeamDB`, matched by `team_role_id` (see
 * "Migrating a finished event" in the README). A `Teams` row whose role ID
 * already has a `TeamDB` row updates that row's roster/name/logo columns in
 * place (so a team's history stays on one row across events, rather than
 * accumulating a stale duplicate every time); everything else - including
 * every `Teams` row with a blank `team_role_id`, which can't be matched to
 * anything - is appended as a new row. Columns other than
 * TEAM_MIGRATION_FIELDS (e.g. a staff-added notes column) are left alone.
 *
 * Purely additive to `TeamDB` - never touches `Teams` itself, so it's safe
 * to re-run. Run this (and migratePlayerRegistryToPlayerDB, if you're doing
 * that cleanup too) from the Apps Script editor while the bot is stopped -
 * same rule as every other tab in this spreadsheet: the bot's local store
 * is authoritative once loaded, so an edit made here while it's running
 * would just get overwritten on the next background sync.
 */
function migrateTeamsToTeamDB() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const teamsSheet = ss.getSheetByName('Teams');
  const teamDBSheet = ss.getSheetByName('TeamDB');
  if (!teamsSheet || !teamDBSheet) throw new Error('Teams and/or TeamDB tab not found.');

  const teamsHeaders = teamsSheet.getRange(1, 1, 1, teamsSheet.getLastColumn()).getValues()[0];
  const dbHeaders = teamDBSheet.getRange(1, 1, 1, teamDBSheet.getLastColumn()).getValues()[0];
  const teamsIdx = headerIndexMap_(teamsHeaders);
  const dbIdx = headerIndexMap_(dbHeaders);
  assertHasColumns_('Teams', teamsIdx, TEAM_MIGRATION_FIELDS);
  assertHasColumns_('TeamDB', dbIdx, TEAM_MIGRATION_FIELDS);

  const teamsLastRow = teamsSheet.getLastRow();
  if (teamsLastRow < 2) {
    Logger.log('Teams has no data rows - nothing to migrate.');
    return;
  }
  const teamsValues = teamsSheet.getRange(2, 1, teamsLastRow - 1, teamsHeaders.length).getDisplayValues();

  const dbLastRow = teamDBSheet.getLastRow();
  const dbValues = dbLastRow >= 2 ? teamDBSheet.getRange(2, 1, dbLastRow - 1, dbHeaders.length).getDisplayValues() : [];

  // Row-id blanks are never matched against (see doc comment above), so
  // only non-blank team_role_ids go in this map.
  const dbRowIndexByRoleId = new Map();
  dbValues.forEach((row, i) => {
    const roleId = (row[dbIdx.team_role_id] || '').trim();
    if (roleId) dbRowIndexByRoleId.set(roleId, i);
  });

  let updated = 0;
  let appended = 0;
  const toAppend = [];

  teamsValues.forEach((row) => {
    const roleId = (row[teamsIdx.team_role_id] || '').trim();
    const existingIdx = roleId ? dbRowIndexByRoleId.get(roleId) : undefined;

    if (existingIdx !== undefined) {
      TEAM_MIGRATION_FIELDS.forEach((f) => {
        dbValues[existingIdx][dbIdx[f]] = row[teamsIdx[f]] || '';
      });
      updated++;
    } else {
      const newRow = new Array(dbHeaders.length).fill('');
      TEAM_MIGRATION_FIELDS.forEach((f) => {
        newRow[dbIdx[f]] = row[teamsIdx[f]] || '';
      });
      toAppend.push(newRow);
      appended++;
    }
  });

  if (dbValues.length) {
    teamDBSheet.getRange(2, 1, dbValues.length, dbHeaders.length).setValues(sanitizeRows_(dbValues));
  }
  if (toAppend.length) {
    teamDBSheet.getRange(dbValues.length + 2, 1, toAppend.length, dbHeaders.length).setValues(sanitizeRows_(toAppend));
  }

  Logger.log(`Teams -> TeamDB migration complete. Updated ${updated} existing row(s), appended ${appended} new row(s).`);
  return { updated, appended };
}

/**
 * Shared core for migratePlayerRegistryToPlayerDB and
 * migrateFreeAgentsToPlayerDB below - both copy player-identity data into
 * `PlayerDB`, matched by `account_id`, with identical merge semantics
 * (archive every other name into `past_igns`, archive a changing
 * `discord_id` into `past_discord_names`, never touch a `PlayerDB` column
 * this function doesn't know about). sourceSheetName/requiredCols feed
 * assertHasColumns_ against that source tab; extractRow(row, idx) must
 * return { accountId, discordId, nationality, bestName, otherNames } for
 * one source row (otherNames already excludes bestName), or a falsy
 * accountId to skip that row (counted as skippedBlank).
 *
 * Purely additive to `PlayerDB` - never touches the source tab, so it's
 * safe to re-run. Same "run with the bot stopped" rule as
 * migrateTeamsToTeamDB above.
 */
function migrateToPlayerDB_(sourceSheetName, requiredCols, extractRow) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName(sourceSheetName);
  const dbSheet = ss.getSheetByName('PlayerDB');
  if (!sourceSheet || !dbSheet) throw new Error(`${sourceSheetName} and/or PlayerDB tab not found.`);

  const sourceHeaders = sourceSheet.getRange(1, 1, 1, sourceSheet.getLastColumn()).getValues()[0];
  const dbHeaders = dbSheet.getRange(1, 1, 1, dbSheet.getLastColumn()).getValues()[0];
  const srcIdx = headerIndexMap_(sourceHeaders);
  const dbIdx = headerIndexMap_(dbHeaders);
  assertHasColumns_(sourceSheetName, srcIdx, requiredCols);
  assertHasColumns_('PlayerDB', dbIdx, ['account_id', 'discord_id', 'nationality', 'best_name', 'past_igns', 'past_discord_names']);

  const sourceLastRow = sourceSheet.getLastRow();
  if (sourceLastRow < 2) {
    Logger.log(`${sourceSheetName} has no data rows - nothing to migrate.`);
    return { updated: 0, appended: 0, skippedBlank: 0 };
  }
  const sourceValues = sourceSheet.getRange(2, 1, sourceLastRow - 1, sourceHeaders.length).getDisplayValues();

  const dbLastRow = dbSheet.getLastRow();
  const dbValues = dbLastRow >= 2 ? dbSheet.getRange(2, 1, dbLastRow - 1, dbHeaders.length).getDisplayValues() : [];

  const dbRowIndexByAccountId = new Map();
  dbValues.forEach((row, i) => {
    const accountId = (row[dbIdx.account_id] || '').trim();
    if (accountId) dbRowIndexByAccountId.set(accountId, i);
  });

  let updated = 0;
  let appended = 0;
  let skippedBlank = 0;
  const toAppend = [];

  sourceValues.forEach((row) => {
    const extracted = extractRow(row, srcIdx);
    if (!extracted || !extracted.accountId) {
      skippedBlank++;
      return;
    }
    const { accountId, discordId, nationality, bestName, otherNames } = extracted;
    const existingIdx = dbRowIndexByAccountId.get(accountId);

    if (existingIdx === undefined) {
      const newRow = new Array(dbHeaders.length).fill('');
      newRow[dbIdx.account_id] = accountId;
      newRow[dbIdx.discord_id] = discordId;
      newRow[dbIdx.nationality] = nationality;
      newRow[dbIdx.best_name] = bestName;
      newRow[dbIdx.past_igns] = mergeCsvList_('', otherNames);
      toAppend.push(newRow);
      appended++;
      return;
    }

    const dbRow = dbValues[existingIdx];
    const existingBestName = (dbRow[dbIdx.best_name] || '').trim();
    const existingDiscordId = (dbRow[dbIdx.discord_id] || '').trim();

    const namesToArchive = otherNames.slice();
    if (existingBestName && bestName && existingBestName !== bestName) namesToArchive.push(existingBestName);
    dbRow[dbIdx.past_igns] = mergeCsvList_(dbRow[dbIdx.past_igns], namesToArchive);

    if (existingDiscordId && discordId && existingDiscordId !== discordId) {
      dbRow[dbIdx.past_discord_names] = mergeCsvList_(dbRow[dbIdx.past_discord_names], [existingDiscordId]);
    }

    dbRow[dbIdx.best_name] = bestName || existingBestName;
    dbRow[dbIdx.discord_id] = discordId || existingDiscordId;
    dbRow[dbIdx.nationality] = nationality || dbRow[dbIdx.nationality];
    updated++;
  });

  if (dbValues.length) {
    dbSheet.getRange(2, 1, dbValues.length, dbHeaders.length).setValues(sanitizeRows_(dbValues));
  }
  if (toAppend.length) {
    dbSheet.getRange(dbValues.length + 2, 1, toAppend.length, dbHeaders.length).setValues(sanitizeRows_(toAppend));
  }

  Logger.log(
    `${sourceSheetName} -> PlayerDB migration complete. Updated ${updated} existing row(s), appended ${appended} new row(s)` +
      (skippedBlank ? `, skipped ${skippedBlank} row(s) with no account_id` : '') +
      '.'
  );
  return { updated, appended, skippedBlank };
}

/**
 * Copies every `PlayerRegistry` row into `PlayerDB`, matched by
 * `account_id` (see "Migrating a finished event" in the README). `best_name`
 * is sourced from `display_name` (falling back to `statlocker_username` if
 * a player never set one); every other name PlayerRegistry has on file for
 * that player (`statlocker_username`, `historical_names`) is folded into
 * `past_igns` rather than discarded - see migrateToPlayerDB_ above for the
 * shared merge logic both this and migrateFreeAgentsToPlayerDB use.
 */
function migratePlayerRegistryToPlayerDB() {
  return migrateToPlayerDB_(
    'PlayerRegistry',
    ['account_id', 'statlocker_username', 'discord_id', 'historical_names', 'nationality', 'display_name'],
    (row, idx) => {
      const accountId = (row[idx.account_id] || '').trim();
      if (!accountId) return null;
      const statlockerUsername = (row[idx.statlocker_username] || '').trim();
      const historicalNames = (row[idx.historical_names] || '').trim();
      const bestName = (row[idx.display_name] || '').trim() || statlockerUsername;
      return {
        accountId,
        discordId: (row[idx.discord_id] || '').trim(),
        nationality: (row[idx.nationality] || '').trim(),
        bestName,
        otherNames: [statlockerUsername, historicalNames].filter((n) => n && n !== bestName),
      };
    }
  );
}

/**
 * Copies every `FreeAgents` row into `PlayerDB`, matched by `account_id` -
 * same shared merge logic as migratePlayerRegistryToPlayerDB above (see
 * migrateToPlayerDB_), just sourced from a free agent's own
 * `display_name`/`statlocker_username` instead of `PlayerRegistry`'s.
 * Purely additive to `PlayerDB` - never touches `FreeAgents` itself.
 * `wants_team` isn't carried over - `PlayerDB` is pure identity, not
 * per-event signup intent.
 */
function migrateFreeAgentsToPlayerDB() {
  return migrateToPlayerDB_(
    'FreeAgents',
    ['account_id', 'discord_id', 'display_name', 'nationality', 'statlocker_username'],
    (row, idx) => {
      const accountId = (row[idx.account_id] || '').trim();
      if (!accountId) return null;
      const statlockerUsername = (row[idx.statlocker_username] || '').trim();
      const bestName = (row[idx.display_name] || '').trim() || statlockerUsername;
      return {
        accountId,
        discordId: (row[idx.discord_id] || '').trim(),
        nationality: (row[idx.nationality] || '').trim(),
        bestName,
        otherNames: [statlockerUsername].filter((n) => n && n !== bestName),
      };
    }
  );
}

// --- Control Sheet roster migration -------------------------------------
const CONTROL_ROSTER_TAB = 'Rosters';

/**
 * Destination spreadsheet ID for migrateTeamsToRosterSheet() - the
 * printable/broadcast Control Sheet, a *separate* spreadsheet from this
 * one. Set via Project Settings > Script Properties > add
 * CONTROL_SHEET_ID (same place as SHARED_SECRET, see this file's top doc
 * comment) rather than a hardcoded const - Code.gs itself may get
 * copied/version-controlled/handed to another TO, and a spreadsheet ID
 * baked into the source would travel with it.
 */
function getControlSheetId_() {
  const id = PropertiesService.getScriptProperties().getProperty('CONTROL_SHEET_ID');
  if (!id) {
    throw new Error("Set CONTROL_SHEET_ID in Project Settings > Script Properties (the Control Sheet's spreadsheet ID) first.");
  }
  return id;
}

/**
 * True if every TEAM_MIGRATION_FIELDS cell in `row` is blank - used to
 * tell a genuinely empty `Teams` row (a deliberate gap) apart from a real
 * team row. Ignores any column outside TEAM_MIGRATION_FIELDS (e.g. a
 * staff-added notes column).
 */
function isBlankTeamsRow_(row, teamsIdx) {
  return TEAM_MIGRATION_FIELDS.every((f) => !(row[teamsIdx[f]] || '').trim());
}

/**
 * === Roster card template parser ===
 *
 * Replaces the old hardcoded migrateTeamsToRosterSheet() band layout. A TO
 * now designs the roster card directly on a `Template` tab INSIDE the
 * Control Sheet (the same spreadsheet ID as CONTROL_SHEET_ID) - real cell
 * formatting, merged cells, colors, an =IMAGE() formula for the logo,
 * whatever - using {{tag}} placeholders, and draws it multiple times
 * side-by-side/stacked, numbering each copy {{#1}}, {{#2}}, ... in the
 * cell that anchors that copy's top-left corner. This code infers the
 * layout (row-major/column-major, wrap point, gutter) purely from how
 * those numbered copies are arranged, then tiles real copies of block #1
 * across the `Rosters` tab, one per team, substituting tags with real
 * roster data. See README's "Migrating rosters to the Control Sheet" for
 * the tag vocabulary and worked examples.
 *
 * Never writes to the Template tab itself - strictly a read-only source
 * (see runRosterTemplate_ below, which only ever calls getRange/copyTo
 * FROM it).
 */

const ROSTER_TEMPLATE_TAB = 'Template';
const ROSTER_MAIN_SLOT_COUNT = 6;
const ROSTER_SUBCOACH_SLOT_COUNT = 2;
const ROSTER_DEFAULT_GUTTER = 1;
// Matches a {{...}} token, capturing its inner text. Run against a cell's
// text AFTER protectRosterEscapes_() has swapped out {{{{ / }}}} literal-brace
// escapes, so this never mistakes an escape for a tag.
const ROSTER_TAG_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const ROSTER_ESCAPE_OPEN = '\u0001';
const ROSTER_ESCAPE_CLOSE = '\u0002';

/**
 * Escaping convention (not demonstrated in template-examples.xlsx, so
 * this is our own choice - documented here and in the README): a TO who
 * needs literal `{{`/`}}` text doubles up the braces, `{{{{`/`}}}}`, to
 * get a literal `{{`/`}}` in the output. Chosen because it mirrors the
 * familiar "double the delimiter to escape it" convention (e.g. Python's
 * str.format `{{`/`}}`) using this template's own `{{`/`}}` delimiter.
 */
function protectRosterEscapes_(text) {
  return text.split('{{{{').join(ROSTER_ESCAPE_OPEN).split('}}}}').join(ROSTER_ESCAPE_CLOSE);
}
function restoreRosterEscapes_(text) {
  return text.split(ROSTER_ESCAPE_OPEN).join('{{').split(ROSTER_ESCAPE_CLOSE).join('}}');
}

/**
 * Classifies one {{...}} tag body (already trimmed/lowercased by the
 * caller). Returns { type, n? }. type is 'unknown' for anything that
 * doesn't match a known tag - callers turn that into a validation error
 * rather than silently ignoring it.
 */
function classifyRosterTag_(body) {
  if (/^#\d+$/.test(body)) return { type: 'anchor', n: parseInt(body.slice(1), 10) };
  if (body === 'team_name') return { type: 'team_name' };
  if (body === 'seed') return { type: 'seed' };
  if (body === 'captain') return { type: 'captain' };
  if (body === 'logo') return { type: 'logo' };
  if (body === 'player') return { type: 'player_pos' };
  if (body === 'sub/coach') return { type: 'subcoach_pos' };
  let m = body.match(/^player_(\d+)$/);
  if (m) return { type: 'player_explicit', n: parseInt(m[1], 10) };
  m = body.match(/^sub_(\d+)$/);
  if (m) return { type: 'subcoach_explicit', n: parseInt(m[1], 10) };
  if (body === 'nationality') return { type: 'nationality' };
  if (body === 'role') return { type: 'role' };
  return { type: 'unknown' };
}

/**
 * Parses the roster card template off `templateSheet`. Returns either
 * { errors: string[] } (never write real data if this is non-empty - see
 * runRosterTemplate_) or { layout, block, usesCaptain }, where:
 *   layout = { direction: 'row-major'|'column-major', wrapLimit (0 = no
 *             wrap), gutterRow, gutterCol }
 *   block  = { r0, c0, width, height, cellPlan } - block #1's bounding
 *             box (0-indexed, inclusive) and its per-cell tag plan, used
 *             as the actual copy source for every team.
 * Every anchor beyond #1 is used only to infer `layout` (direction/wrap/
 * gutter) and to sanity-check its own footprint matches block #1's size -
 * its exact drawn position is otherwise irrelevant (the real placement
 * math in runRosterTemplate_ is computed arithmetically from block #1 +
 * gutter, never by reading back an example block's coordinates).
 */
function parseRosterTemplate_(templateSheet) {
  const lastRow = templateSheet.getLastRow();
  const lastCol = templateSheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) {
    return { errors: [`The "${ROSTER_TEMPLATE_TAB}" tab is empty - draw at least one {{#1}} roster card block on it first.`] };
  }

  const range = templateSheet.getRange(1, 1, lastRow, lastCol);
  const values = range.getValues();
  const formulas = range.getFormulas();
  const merges = range.getMergedRanges();
  const errors = [];

  // "Occupied" = has literal content, a formula, OR is inside a merge
  // whose top-left cell is occupied - used to flood-fill each block's
  // bounding box below (merged non-top-left cells report blank values,
  // but are visually/logically part of the block).
  const occupied = [];
  for (let r = 0; r < lastRow; r++) occupied.push(new Array(lastCol).fill(false));
  for (let r = 0; r < lastRow; r++) {
    for (let c = 0; c < lastCol; c++) {
      const v = values[r][c];
      if (formulas[r][c] || (v !== '' && v !== null)) occupied[r][c] = true;
    }
  }
  merges.forEach((rng) => {
    const r0 = rng.getRow() - 1, c0 = rng.getColumn() - 1;
    const r1 = r0 + rng.getNumRows() - 1, c1 = c0 + rng.getNumColumns() - 1;
    const anyOccupied = occupied[r0][c0];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occupied[r][c] = occupied[r][c] || anyOccupied;
  });

  // Tags inside a formula are out of scope (spec) - flag clearly rather
  // than silently skipping them.
  for (let r = 0; r < lastRow; r++) {
    for (let c = 0; c < lastCol; c++) {
      if (formulas[r][c] && formulas[r][c].indexOf('{{') !== -1) {
        errors.push(`Cell ${templateSheet.getRange(r + 1, c + 1).getA1Notation()}: template tag found inside a formula (${formulas[r][c]}) - only plain literal cell text is supported for tags, not formulas.`);
      }
    }
  }

  // --- Find every {{#N}} anchor. ---
  const anchors = []; // { n, row, col } 0-indexed
  for (let r = 0; r < lastRow; r++) {
    for (let c = 0; c < lastCol; c++) {
      if (formulas[r][c]) continue;
      const raw = values[r][c];
      if (typeof raw !== 'string' || raw.indexOf('{{') === -1) continue;
      const protectedText = protectRosterEscapes_(raw);
      ROSTER_TAG_RE.lastIndex = 0;
      let m;
      while ((m = ROSTER_TAG_RE.exec(protectedText))) {
        const cls = classifyRosterTag_(m[1].trim().toLowerCase());
        if (cls.type === 'anchor') anchors.push({ n: cls.n, row: r, col: c });
      }
    }
  }
  if (anchors.length === 0) {
    errors.push(`No {{#1}} block anchor found on the "${ROSTER_TEMPLATE_TAB}" tab - put {{#1}} in the top-left cell of your roster card block.`);
    return { errors };
  }

  const byN = {};
  anchors.forEach((a) => (byN[a.n] = byN[a.n] || []).push(a));
  const ns = Object.keys(byN).map(Number).sort((a, b) => a - b);
  const maxN = ns[ns.length - 1];
  for (let n = 1; n <= maxN; n++) {
    if (!byN[n]) {
      errors.push(`Missing block anchor {{#${n}}} - anchors must be numbered contiguously starting at {{#1}} (found: ${ns.join(', ')}).`);
    } else if (byN[n].length > 1) {
      errors.push(`Duplicate block anchor {{#${n}}} at ${byN[n].map((a) => templateSheet.getRange(a.row + 1, a.col + 1).getA1Notation()).join(' and ')} - each anchor number must be used exactly once.`);
    }
  }
  if (errors.length) return { errors };

  const sortedAnchors = ns.map((n) => byN[n][0]); // one per n, n ascending

  // --- Direction + wrap inference from the step between each pair. ---
  let direction = null;
  let flipIndex = -1; // index into `steps` where direction first flips (wrap point), -1 = never
  const steps = [];
  for (let i = 0; i < sortedAnchors.length - 1; i++) {
    steps.push({ dRow: sortedAnchors[i + 1].row - sortedAnchors[i].row, dCol: sortedAnchors[i + 1].col - sortedAnchors[i].col });
  }
  if (steps.length === 0) {
    direction = 'row-major'; // single block, direction is moot (wrapLimit will be 0)
  } else {
    const s0 = steps[0];
    if (s0.dRow === 0 && s0.dCol !== 0) direction = 'row-major';
    else if (s0.dCol === 0 && s0.dRow !== 0) direction = 'column-major';
    else if (sortedAnchors.length === 2) {
      errors.push(
        `Can't infer layout direction: only two block anchors are given ({{#1}} at ${templateSheet.getRange(sortedAnchors[0].row + 1, sortedAnchors[0].col + 1).getA1Notation()}, {{#2}} at ${templateSheet.getRange(sortedAnchors[1].row + 1, sortedAnchors[1].col + 1).getA1Notation()}) and the step between them changes both row and column. Align them on the same row (row-major) or same column (column-major), or add a third example block.`
      );
    } else {
      errors.push(`Can't infer layout direction: the step from {{#1}} to {{#2}} changes both row and column. The first two example blocks must share a row (row-major) or a column (column-major).`);
    }
    if (errors.length) return { errors };
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      const isContinue = direction === 'row-major' ? st.dRow === 0 && st.dCol > 0 : st.dCol === 0 && st.dRow > 0;
      if (!isContinue) { flipIndex = i; break; }
    }
  }
  const wrapLimit = flipIndex === -1 ? 0 : flipIndex + 1;

  // --- Each block's bounding box (flood-fill down/right from its
  // anchor). Capped at the position of the NEXT anchor (in fill order) on
  // each axis, so two blocks drawn with zero gutter between them (fully
  // abutting, no blank row/column separator) don't bleed into each
  // other - content alone can't tell two abutting blocks apart, but "not
  // past where the next block starts" always holds true given anchors
  // are numbered in fill order. The last anchor has no such neighbor, so
  // it floods to the sheet's used-range edge instead.
  function boundingBoxFor_(idx) {
    const anchor = sortedAnchors[idx];
    const nextA = sortedAnchors[idx + 1];
    const rowCap = nextA && nextA.row > anchor.row ? nextA.row : lastRow;
    const colCap = nextA && nextA.col > anchor.col ? nextA.col : lastCol;
    let r0 = anchor.row, c0 = anchor.col, r1 = anchor.row, c1 = anchor.col;
    let grew = true;
    while (grew) {
      grew = false;
      if (r1 + 1 < rowCap) {
        let any = false;
        for (let c = c0; c <= c1; c++) if (occupied[r1 + 1][c]) { any = true; break; }
        if (any) { r1++; grew = true; }
      }
      if (c1 + 1 < colCap) {
        let any = false;
        for (let r = r0; r <= r1; r++) if (occupied[r][c1 + 1]) { any = true; break; }
        if (any) { c1++; grew = true; }
      }
    }
    return { r0, c0, r1, c1, height: r1 - r0 + 1, width: c1 - c0 + 1 };
  }
  const box1 = boundingBoxFor_(0);

  // Every other anchor's footprint must match block #1's size - a strong
  // signal something's wrong with that example block if it doesn't. Its
  // exact position is otherwise unused (see this function's doc comment).
  for (let i = 1; i < sortedAnchors.length; i++) {
    const box = boundingBoxFor_(i);
    if (box.width !== box1.width || box.height !== box1.height) {
      errors.push(
        `Block {{#${ns[i]}}} (at ${templateSheet.getRange(sortedAnchors[i].row + 1, sortedAnchors[i].col + 1).getA1Notation()}) is ${box.width}x${box.height} cells, but block {{#1}} is ${box1.width}x${box1.height} - every example block must be the same size.`
      );
    }
  }
  if (errors.length) return { errors };

  // --- Gutter: derived from block #1's size + the observed step deltas.
  // A single-anchor template has no step to measure - default gutter,
  // moot anyway since wrapLimit is 0 (nothing ever tiles beside it). ---
  let gutterCol = ROSTER_DEFAULT_GUTTER, gutterRow = ROSTER_DEFAULT_GUTTER;
  if (steps.length > 0) {
    const continueAxisDelta = direction === 'row-major' ? steps[0].dCol : steps[0].dRow;
    const continueGutter = continueAxisDelta - (direction === 'row-major' ? box1.width : box1.height);
    let wrapGutter = ROSTER_DEFAULT_GUTTER;
    if (flipIndex !== -1) {
      const flipAxisDelta = direction === 'row-major' ? steps[flipIndex].dRow : steps[flipIndex].dCol;
      wrapGutter = flipAxisDelta - (direction === 'row-major' ? box1.height : box1.width);
    }
    if (continueGutter < 0 || wrapGutter < 0) {
      errors.push(`Computed spacing between example blocks is negative - they appear to overlap. Check the gap between your {{#N}} anchors.`);
      return { errors };
    }
    gutterCol = direction === 'row-major' ? continueGutter : wrapGutter;
    gutterRow = direction === 'row-major' ? wrapGutter : continueGutter;
  }

  // --- Walk block #1 in reading order (top-to-bottom, then left-to-
  // right), collecting every tag token per cell. Two passes: pass 1
  // assigns each {{player}}/{{sub/coach}} tag its slot index and records
  // which ROW that slot lives on; pass 2 binds {{nationality}}/{{role}}
  // tags to whichever slot occupies THEIR row (not "whichever slot tag
  // was most recently seen" - column order within a row isn't
  // meaningful, e.g. a Role column left of a Sub/Coach column). ---
  const cellsRaw = [];
  for (let r = box1.r0; r <= box1.r1; r++) {
    for (let c = box1.c0; c <= box1.c1; c++) {
      if (formulas[r][c]) continue; // formula cells (e.g. =IMAGE(...)) carry no tags of their own - relative refs shift on copyTo
      const raw = values[r][c];
      if (typeof raw === 'string' && /^=/.test(raw.trim())) {
        errors.push(
          `Cell ${templateSheet.getRange(r + 1, c + 1).getA1Notation()} looks like a commented-out formula ("${raw}") - a leading ' makes Sheets store it as plain text, so it would be copied into every roster card as literal text, not a live formula. Remove the leading ' before running.`
        );
        continue;
      }
      if (typeof raw !== 'string' || raw.indexOf('{{') === -1) continue;
      const protectedText = protectRosterEscapes_(raw);
      const tokens = [];
      ROSTER_TAG_RE.lastIndex = 0;
      let m;
      while ((m = ROSTER_TAG_RE.exec(protectedText))) {
        const body = m[1].trim().toLowerCase();
        const cls = classifyRosterTag_(body);
        if (cls.type === 'anchor') { tokens.push({ start: m.index, end: m.index + m[0].length, type: cls.type }); continue; } // strip from output - see resolveRosterTagValue_
        const cellA1 = templateSheet.getRange(r + 1, c + 1).getA1Notation();
        if (cls.type === 'unknown') {
          errors.push(`Cell ${cellA1}: "{{${m[1]}}}" isn't a recognized tag (typo? see README for the supported tag list).`);
          continue;
        }
        tokens.push({ start: m.index, end: m.index + m[0].length, type: cls.type, n: cls.n, cellA1 });
      }
      if (tokens.length) cellsRaw.push({ relRow: r - box1.r0, relCol: c - box1.c0, protectedText, tokens });
    }
  }

  // Pass 1: slot-defining tags.
  const rowSlot = {}; // relRow -> { family, index }
  let sawPlayerPos = false, sawPlayerExplicit = false;
  let sawSubcoachPos = false, sawSubcoachExplicit = false;
  let playerPosCount = 0, subcoachPosCount = 0;
  const playerExplicitSeen = new Set();
  const subcoachExplicitSeen = new Set();
  let sawTeamName = false;
  let usesCaptain = false;

  cellsRaw.forEach((cell) => {
    cell.tokens.forEach((tok) => {
      if (tok.type === 'team_name') { sawTeamName = true; return; }
      if (tok.type === 'captain') { usesCaptain = true; return; }
      if (tok.type !== 'player_pos' && tok.type !== 'player_explicit' && tok.type !== 'subcoach_pos' && tok.type !== 'subcoach_explicit') return;

      let family, index;
      if (tok.type === 'player_pos') {
        sawPlayerPos = true; playerPosCount++; family = 'player'; index = playerPosCount;
      } else if (tok.type === 'player_explicit') {
        sawPlayerExplicit = true; family = 'player'; index = tok.n;
        if (tok.n < 1 || tok.n > ROSTER_MAIN_SLOT_COUNT) { errors.push(`Cell ${tok.cellA1}: {{player_${tok.n}}} is out of range - only player_1 through player_${ROSTER_MAIN_SLOT_COUNT} are valid.`); return; }
        if (playerExplicitSeen.has(tok.n)) errors.push(`Cell ${tok.cellA1}: {{player_${tok.n}}} is used more than once in block #1.`);
        playerExplicitSeen.add(tok.n);
      } else if (tok.type === 'subcoach_pos') {
        sawSubcoachPos = true; subcoachPosCount++; family = 'subcoach'; index = subcoachPosCount;
      } else {
        sawSubcoachExplicit = true; family = 'subcoach'; index = tok.n;
        if (tok.n < 1 || tok.n > ROSTER_SUBCOACH_SLOT_COUNT) { errors.push(`Cell ${tok.cellA1}: {{sub_${tok.n}}} is out of range - only sub_1 and sub_2 are valid.`); return; }
        if (subcoachExplicitSeen.has(tok.n)) errors.push(`Cell ${tok.cellA1}: {{sub_${tok.n}}} is used more than once in block #1.`);
        subcoachExplicitSeen.add(tok.n);
      }
      tok.slotFamily = family; tok.slotIndex = index;
      const existing = rowSlot[cell.relRow];
      if (existing && (existing.family !== family || existing.index !== index)) {
        errors.push(`Cell ${tok.cellA1}: row already has a different slot tag on it (${existing.family} ${existing.index}) - one slot per row.`);
      }
      rowSlot[cell.relRow] = { family, index };
    });
  });

  // Pass 2: row-scoped companion tags.
  cellsRaw.forEach((cell) => {
    cell.tokens.forEach((tok) => {
      if (tok.type !== 'nationality' && tok.type !== 'role') return;
      const slot = rowSlot[cell.relRow];
      if (!slot) { errors.push(`Cell ${tok.cellA1}: {{${tok.type}}} has no {{player}}/{{sub/coach}} tag on its row - can't tell which slot it belongs to.`); return; }
      if (tok.type === 'role' && slot.family !== 'subcoach') { errors.push(`Cell ${tok.cellA1}: {{role}} is on a main-roster player's row - {{role}} (Sub/Coach) is only supported for {{sub/coach}} slots.`); return; }
      tok.slotFamily = slot.family; tok.slotIndex = slot.index;
    });
  });

  const cellPlan = cellsRaw.map((cell) => ({
    relRow: cell.relRow,
    relCol: cell.relCol,
    protectedText: cell.protectedText,
    matches: cell.tokens.map((t) => ({ start: t.start, end: t.end, type: t.type, slotFamily: t.slotFamily, slotIndex: t.slotIndex })),
  }));

  if (sawPlayerPos && sawPlayerExplicit) errors.push(`Block #1 mixes positional {{player}} tags with explicit {{player_N}} tags - use one style only per block.`);
  if (sawSubcoachPos && sawSubcoachExplicit) errors.push(`Block #1 mixes positional {{sub/coach}} tags with explicit {{sub_N}} tags - use one style only per block.`);
  if (!sawPlayerPos && !sawPlayerExplicit) errors.push(`Block #1 has no {{player}} tags - needs exactly ${ROSTER_MAIN_SLOT_COUNT} (positional {{player}}, or explicit player_1..player_${ROSTER_MAIN_SLOT_COUNT}).`);
  if (sawPlayerPos && playerPosCount !== ROSTER_MAIN_SLOT_COUNT) errors.push(`Block #1 has ${playerPosCount} {{player}} tags, expected exactly ${ROSTER_MAIN_SLOT_COUNT}.`);
  if (sawPlayerExplicit) {
    const missing = [];
    for (let n = 1; n <= ROSTER_MAIN_SLOT_COUNT; n++) if (!playerExplicitSeen.has(n)) missing.push(n);
    if (missing.length) errors.push(`Block #1 is missing explicit player slot(s): ${missing.map((n) => `player_${n}`).join(', ')}.`);
  }
  if (!sawSubcoachPos && !sawSubcoachExplicit) errors.push(`Block #1 has no {{sub/coach}} tags - needs exactly ${ROSTER_SUBCOACH_SLOT_COUNT} (positional {{sub/coach}}, or explicit sub_1/sub_2).`);
  if (sawSubcoachPos && subcoachPosCount !== ROSTER_SUBCOACH_SLOT_COUNT) errors.push(`Block #1 has ${subcoachPosCount} {{sub/coach}} tags, expected exactly ${ROSTER_SUBCOACH_SLOT_COUNT}.`);
  if (sawSubcoachExplicit) {
    const missing = [];
    for (let n = 1; n <= ROSTER_SUBCOACH_SLOT_COUNT; n++) if (!subcoachExplicitSeen.has(n)) missing.push(n);
    if (missing.length) errors.push(`Block #1 is missing explicit sub/coach slot(s): ${missing.map((n) => `sub_${n}`).join(', ')}.`);
  }
  if (!sawTeamName) errors.push(`Block #1 never uses {{team_name}} - every roster card needs the team name somewhere in it.`);

  if (errors.length) return { errors };

  return {
    layout: { direction, wrapLimit, gutterRow, gutterCol },
    block: { r0: box1.r0, c0: box1.c0, width: box1.width, height: box1.height, cellPlan },
    usesCaptain,
  };
}

/**
 * Reads this spreadsheet's current `Teams` + `PlayerRegistry` into the
 * shape the template substitution needs. Reuses the exact same
 * gap-row/blank-row scanning rule as the old migration did (see
 * isBlankTeamsRow_), except a gap no longer becomes a placeholder card -
 * roster cards only exist for real teams now (see this file's
 * "Migrating rosters" README section for why that's a deliberate change
 * from the old band layout). Seed numbers still count gap rows, so
 * seeding stays aligned with `Teams`' row order either way.
 *
 * `captain_account_id` is an OPTIONAL Teams column this bot's Node side
 * does not currently write - see runRosterTemplate_'s doc comment for
 * why {{captain}} is a hard error unless you've added that column and
 * are populating it yourself.
 */
function loadTeamsForRoster_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const teamsSheet = ss.getSheetByName('Teams');
  const registrySheet = ss.getSheetByName('PlayerRegistry');
  if (!teamsSheet || !registrySheet) throw new Error('Teams and/or PlayerRegistry tab not found.');

  const teamsHeaders = teamsSheet.getRange(1, 1, 1, teamsSheet.getLastColumn()).getValues()[0];
  const teamsIdx = headerIndexMap_(teamsHeaders);
  assertHasColumns_('Teams', teamsIdx, TEAM_MIGRATION_FIELDS);
  const hasCaptainColumn = Object.prototype.hasOwnProperty.call(teamsIdx, 'captain_account_id');

  const regHeaders = registrySheet.getRange(1, 1, 1, registrySheet.getLastColumn()).getValues()[0];
  const regIdx = headerIndexMap_(regHeaders);
  assertHasColumns_('PlayerRegistry', regIdx, ['account_id', 'statlocker_username', 'nationality', 'display_name']);

  const regLastRow = registrySheet.getLastRow();
  const regValues = regLastRow >= 2 ? registrySheet.getRange(2, 1, regLastRow - 1, regHeaders.length).getDisplayValues() : [];
  const playerByAccountId = new Map();
  regValues.forEach((row) => {
    const id = (row[regIdx.account_id] || '').trim();
    if (!id) return;
    const name = (row[regIdx.display_name] || '').trim() || (row[regIdx.statlocker_username] || '').trim() || '(unnamed)';
    playerByAccountId.set(id, { name, nationality: (row[regIdx.nationality] || '').trim() });
  });

  const teamsLastRow = teamsSheet.getLastRow();
  if (teamsLastRow < 2) return { teams: [], hasCaptainColumn, missingPlayers: 0 };
  const teamsValues = teamsSheet.getRange(2, 1, teamsLastRow - 1, teamsHeaders.length).getDisplayValues();

  const teams = [];
  let missingPlayers = 0;
  for (let i = 0; i < teamsValues.length; i++) {
    const row = teamsValues[i];
    if (isBlankTeamsRow_(row, teamsIdx)) {
      const nextRow = teamsValues[i + 1];
      if (!nextRow || isBlankTeamsRow_(nextRow, teamsIdx)) break;
      continue; // isolated gap row - no card for it, but doesn't shift later seed numbers
    }

    const teamName = (row[teamsIdx.team_name] || '').trim() || '(unnamed team)';
    const logoUrl = (row[teamsIdx.logo_url] || '').trim();
    const captain = hasCaptainColumn ? (row[teamsIdx.captain_account_id] || '').trim() : null;

    const mains = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((f) => {
      const accountId = (row[teamsIdx[f]] || '').trim();
      if (!accountId) return { name: '', nationality: '' };
      const player = playerByAccountId.get(accountId);
      if (!player) { missingPlayers++; Logger.log(`Team "${teamName}" slot ${f}: account_id ${accountId} not found in PlayerRegistry.`); }
      return { name: player ? player.name : '(unknown player)', nationality: player ? player.nationality : '' };
    });

    const subcoach = [];
    [['s1', 'Sub'], ['s2', 'Sub'], ['c1', 'Coach'], ['c2', 'Coach']].forEach(([f, role]) => {
      const accountId = (row[teamsIdx[f]] || '').trim();
      if (!accountId) return;
      const player = playerByAccountId.get(accountId);
      if (!player) { missingPlayers++; Logger.log(`Team "${teamName}" slot ${f}: account_id ${accountId} not found in PlayerRegistry.`); }
      subcoach.push({ name: player ? player.name : '(unknown player)', nationality: player ? player.nationality : '', role });
    });

    teams.push({ seed: i + 1, teamName, logoUrl, captain, mains, subcoach });
  }
  return { teams, hasCaptainColumn, missingPlayers };
}

/** Resolves one tag match's replacement text for one team (or a ghost placeholder - see runRosterTemplate_). */
function resolveRosterTagValue_(m, ctx) {
  const { team, includeSeeding, ghost, ghostIndex } = ctx;
  switch (m.type) {
    case 'anchor': return '';
    case 'team_name': return ghost ? `Team ${ghostIndex + 1}` : team.teamName;
    case 'seed': if (!includeSeeding) return ''; return String(ghost ? ghostIndex + 1 : team.seed);
    case 'captain': return ghost ? '[Captain]' : (team.captain || '');
    case 'logo': return ghost ? '' : team.logoUrl; // left blank in preview rather than a fake URL - see README
    case 'player_pos':
    case 'player_explicit':
      if (ghost) return `Player ${m.slotIndex}`;
      return team.mains[m.slotIndex - 1].name;
    case 'subcoach_pos':
    case 'subcoach_explicit': {
      if (ghost) return `Sub/Coach ${m.slotIndex}`;
      const slot = team.subcoach[m.slotIndex - 1];
      return slot ? slot.name : '';
    }
    case 'nationality': {
      if (ghost) return 'NAT';
      const slot = m.slotFamily === 'player' ? team.mains[m.slotIndex - 1] : team.subcoach[m.slotIndex - 1];
      return slot ? slot.nationality : '';
    }
    case 'role': {
      if (ghost) return m.slotIndex === 1 ? 'Sub' : 'Coach';
      const slot = team.subcoach[m.slotIndex - 1];
      return slot ? slot.role : '';
    }
  }
  return '';
}

function renderRosterCellText_(cellPlanEntry, ctx) {
  let out = '';
  let last = 0;
  cellPlanEntry.matches.forEach((m) => {
    out += cellPlanEntry.protectedText.slice(last, m.start);
    out += resolveRosterTagValue_(m, ctx);
    last = m.end;
  });
  out += cellPlanEntry.protectedText.slice(last);
  return restoreRosterEscapes_(out);
}

/**
 * Parses the Template tab, validates it against current Teams data, and
 * (unless `ghost` is true) writes real roster cards to the Rosters tab -
 * or, when `ghost` is true, writes the exact same layout with placeholder
 * text instead of real data, so mistakes are visible before anything real
 * is overwritten. Both modes run full validation against real Teams data
 * (team/slot counts, {{captain}} data availability) - ghost mode is a
 * true dry run, not a separate lighter check, so a clean preview means
 * "Send Rosters" will succeed too.
 *
 * {{captain}} is a hard error unless Teams already has a
 * `captain_account_id` column - Teams' schema doesn't track who's
 * captain today (that's only known Node-bot-side, via the Discord
 * session/role that started registration). Wiring that through would
 * mean adding a column to Teams' SCHEMA in Code.gs AND having
 * registrationFlow.js populate it on commit - a Node bot change, out of
 * scope here; flagged rather than guessed at. Remove {{captain}} from
 * the template, or add and populate that column yourself, to use it.
 */
function runRosterTemplate_(ghost, includeSeeding) {
  const controlSheetId = getControlSheetId_();
  const controlSs = SpreadsheetApp.openById(controlSheetId);
  const templateSheet = controlSs.getSheetByName(ROSTER_TEMPLATE_TAB);
  if (!templateSheet) {
    throw new Error(`No "${ROSTER_TEMPLATE_TAB}" tab found in the Control Sheet - design your roster card there first (see README's "Migrating rosters to the Control Sheet").`);
  }
  if (ROSTER_TEMPLATE_TAB === CONTROL_ROSTER_TAB) throw new Error('Template and destination tab names can\'t be the same.');

  const parsed = parseRosterTemplate_(templateSheet);
  if (parsed.errors) {
    throw new Error(`Template has ${parsed.errors.length} problem(s):\n- ${parsed.errors.join('\n- ')}`);
  }

  const { teams, hasCaptainColumn, missingPlayers } = loadTeamsForRoster_();
  if (parsed.usesCaptain && !hasCaptainColumn) {
    throw new Error(`Template uses {{captain}}, but Teams has no "captain_account_id" column yet - see runRosterTemplate_'s doc comment in Code.gs for why this needs a Node bot change first.`);
  }
  const capacityErrors = teams
    .filter((t) => t.subcoach.length > ROSTER_SUBCOACH_SLOT_COUNT)
    .map((t) => `Team "${t.teamName}" (seed ${t.seed}) has ${t.subcoach.length} sub/coach entries but the template only has ${ROSTER_SUBCOACH_SLOT_COUNT} sub/coach slot(s).`);
  if (capacityErrors.length) {
    throw new Error(`${capacityErrors.length} team(s) don't fit the template:\n- ${capacityErrors.join('\n- ')}`);
  }
  if (teams.length === 0) {
    return { ok: true, teamsWritten: 0, ghost, missingPlayers: 0 };
  }

  let destSheet = controlSs.getSheetByName(CONTROL_ROSTER_TAB);
  if (!destSheet) destSheet = controlSs.insertSheet(CONTROL_ROSTER_TAB);

  const { direction, wrapLimit, gutterRow, gutterCol } = parsed.layout;
  const { width: bw, height: bh, r0, c0, cellPlan } = parsed.block;
  const originRow = 2, originCol = 2; // row/col 1 left blank for spacing, matching the old layout's margin

  const n = teams.length;
  const perGroup = wrapLimit || n;
  const groupsCount = wrapLimit ? Math.ceil(n / wrapLimit) : 1;
  const totalRows = direction === 'row-major'
    ? originRow - 1 + groupsCount * bh + Math.max(0, groupsCount - 1) * gutterRow
    : originRow - 1 + perGroup * bh + Math.max(0, perGroup - 1) * gutterRow;
  const totalCols = direction === 'row-major'
    ? originCol - 1 + perGroup * bw + Math.max(0, perGroup - 1) * gutterCol
    : originCol - 1 + groupsCount * bw + Math.max(0, groupsCount - 1) * gutterCol;

  if (destSheet.getMaxRows() < totalRows) destSheet.insertRowsAfter(destSheet.getMaxRows(), totalRows - destSheet.getMaxRows());
  if (destSheet.getMaxColumns() < totalCols) destSheet.insertColumnsAfter(destSheet.getMaxColumns(), totalCols - destSheet.getMaxColumns());
  if (totalRows > 0 && totalCols > 0) destSheet.getRange(1, 1, totalRows, totalCols).breakApart();
  destSheet.clearContents();

  const sourceRange = templateSheet.getRange(r0 + 1, c0 + 1, bh, bw);

  teams.forEach((team, i) => {
    const group = wrapLimit ? Math.floor(i / wrapLimit) : 0;
    const position = wrapLimit ? i % wrapLimit : i;
    const topRow = direction === 'row-major' ? originRow + group * (bh + gutterRow) : originRow + position * (bh + gutterRow);
    const topCol = direction === 'row-major' ? originCol + position * (bw + gutterCol) : originCol + group * (bw + gutterCol);

    sourceRange.copyTo(destSheet.getRange(topRow, topCol, bh, bw));
    cellPlan.forEach((cp) => {
      const text = renderRosterCellText_(cp, { team, includeSeeding, ghost, ghostIndex: i });
      destSheet.getRange(topRow + cp.relRow, topCol + cp.relCol).setValue(sanitizeCellValue_(text));
    });
  });

  Logger.log(
    `Roster cards ${ghost ? 'preview' : 'send'} complete: ${teams.length} team(s) written.` +
      (missingPlayers ? ` ${missingPlayers} roster slot(s) had no matching PlayerRegistry entry - see log above.` : '')
  );
  return { ok: true, teamsWritten: teams.length, ghost, missingPlayers };
}


/**
 * Runs all three migrations above in sequence - the normal entry point for
 * "archive a finished event" (see README's "Migrating a finished event").
 * Doesn't clear Teams afterward; that's still a manual step (delete the
 * data rows below the header) so nothing here can delete real data.
 *
 * Callable two ways: from the Apps Script editor directly (return value is
 * just discarded), or over HTTP via doPost's "migrateFinishedEvent" action -
 * see scripts/postEvent.js, which is the normal way to run this now.
 *
 * `players` combines both player-identity sources that feed PlayerDB -
 * PlayerRegistry (rostered players) and FreeAgents (players who signed up
 * without a team) - since both ultimately answer the same question
 * ("who's on file, and under what name"). Each source is migrated
 * separately (migratePlayerRegistryToPlayerDB/migrateFreeAgentsToPlayerDB)
 * so an account_id present in both still merges into one PlayerDB row
 * rather than colliding.
 */
function migrateFinishedEvent() {
  const teams = migrateTeamsToTeamDB();
  const registryResult = migratePlayerRegistryToPlayerDB();
  const freeAgentResult = migrateFreeAgentsToPlayerDB();
  return {
    teams,
    players: {
      updated: registryResult.updated + freeAgentResult.updated,
      appended: registryResult.appended + freeAgentResult.appended,
      skippedBlank: registryResult.skippedBlank + freeAgentResult.skippedBlank,
    },
  };
}

/**
 * Clears this event's signup rows from `Teams` (data rows only - header
 * row 1 is left alone), so the sheet is ready for the next event's
 * registrations. This is the "still a manual step" Teams cleanup
 * migrateFinishedEvent() above deliberately doesn't do on its own - run
 * this only after rosters have been sent and the database updated, since
 * there's no undo once these rows are gone.
 *
 * Deliberately does NOT touch PlayerRegistry: unlike Teams (which holds
 * only the CURRENT event's roster membership), PlayerRegistry is a
 * persistent player-identity table the bot looks players up in across
 * events (e.g. on rejoining Discord - see registry.js's
 * findPlayerByDiscordId) - clearing it would break returning-player
 * detection for every future event, not just reset this one.
 */
function clearCurrentSignups() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const teamsSheet = ss.getSheetByName('Teams');
  if (!teamsSheet) throw new Error('Teams tab not found.');
  const lastRow = teamsSheet.getLastRow();
  if (lastRow < 2) {
    return 'Teams already had no signup rows to clear.';
  }
  // Only clear the bot-managed columns (SCHEMA.Teams - team_role_id through
  // c2). Deliberately NOT sheet.getLastColumn(): staff often add their own
  // columns to the right (e.g. a =STATLOCKER_AVERAGE_PPSCORE(...) formula
  // for seeding) - those are outside the bot's schema and clearing to
  // getLastColumn() was wiping them out along with the actual signup data.
  const lastCol = SCHEMA.Teams.length;
  teamsSheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  return `Cleared ${lastRow - 1} signup row(s) from Teams.`;
}

/**
 * === Tournament Admin sidebar (apps-script/ControlPanel.html) ===
 * The five functions below are the sidebar's entire backend contract -
 * see ControlPanel.html's top comment for the exact shape each is called
 * with / expected to return. Each wraps existing logic above rather than
 * duplicating it, so the sidebar and a direct Apps Script editor run can
 * never drift out of sync with each other.
 *
 * "Send Rosters" used to take a manually-entered `teamsPerRow` - dropped
 * now that layout comes from the Template tab's {{#N}} anchors instead
 * (see runRosterTemplate_'s doc comment). `includeSeeding` is unrelated
 * to layout (just whether {{seed}} renders blank) so it stays. A new
 * "Preview Layout" action was added ahead of it - the template spec
 * calls for a dry run before committing real data, and the old sidebar
 * only had a single one-shot "Send Rosters" action to match, so this is
 * a genuinely new contract entry rather than a repurposed one.
 */

/** Prefills the sidebar's seeding checkbox from this file's module-level default. */
function getRosterDefaults() {
  return { includeSeeding: true };
}

function previewRosterTemplate(options) {
  const result = runRosterTemplate_(true, !!(options && options.includeSeeding));
  return `Preview written to the Control Sheet's "${CONTROL_ROSTER_TAB}" tab: ${result.teamsWritten} team(s), placeholder data. Check it over, then run Send Rosters.`;
}

function sendRostersToControlSheet(options) {
  const result = runRosterTemplate_(false, !!(options && options.includeSeeding));
  return `Rosters sent to the Control Sheet: ${result.teamsWritten} team(s).` + (result.missingPlayers ? ` ${result.missingPlayers} roster slot(s) had no matching PlayerRegistry entry - see Executions log.` : '');
}

function updateDatabase() {
  const result = migrateFinishedEvent();
  const t = result.teams;
  const p = result.players;
  return (
    `TeamDB: ${t.appended} added, ${t.updated} updated. ` +
    `PlayerDB: ${p.appended} added, ${p.updated} updated` +
    (p.skippedBlank ? `, ${p.skippedBlank} skipped (blank).` : '.')
  );
}

function onOpen(e) {
  SpreadsheetApp.getUi().createMenu('Tournament Admin').addItem('Open Control Panel', 'showControlPanel').addToUi();
}

function showControlPanel() {
  const html = HtmlService.createHtmlOutputFromFile('ControlPanel').setTitle('Tournament Admin').setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Custom sheet function: looks up every account_id in `range` via
 * statlocker's batch-profiles endpoint and returns the average ppScore
 * across all of them. Meant to be called directly from a formula at the
 * moment ppScore is actually needed (e.g. seeding) - see statlocker.js in
 * the bot for why ppScore is deliberately never stored anywhere ahead of
 * time (it's dynamic and goes stale). This is that "look it up fresh"
 * tool. `range` can be any shape (single cell, one row, one column, or a
 * full multi-row/column block) - flat() only ever needs to flatten one
 * level since Apps Script never passes a range argument deeper than 2D.
 *
 * Requires a Script Property named STATLOCKER_API_KEY (Project Settings >
 * Script Properties) - separate from the bot's own STATLOCKER_API_KEY env
 * var, since this runs inside Apps Script, not the bot process.
 *
 * A null ppScore means statlocker doesn't have enough recorded games for
 * that player to compute a real score yet - NOT the same as "account not
 * found". These count as 0 toward the average rather than being dropped,
 * so a roster padded with low-sample-size players doesn't quietly inflate
 * its average via a shrunk denominator. When at least one player counted
 * as 0 this way, the average spills into a second cell (to the right)
 * naming how many - if that cell already has unrelated content in it,
 * Sheets will show a #REF! "did not expand" error instead of overwriting
 * it, so keep the cell to the right of any use of this formula clear.
 *
 * Throws only if the whole batch call fails, or if the range contained no
 * valid account IDs at all.
 *
 * Usage: =STATLOCKER_AVERAGE_PPSCORE(Teams!C2:L2)
 */
function STATLOCKER_AVERAGE_PPSCORE(range) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('STATLOCKER_API_KEY');
  if (!apiKey) throw new Error('Missing STATLOCKER_API_KEY script property.');

  const accountIds = (Array.isArray(range) ? range.flat() : [range])
    .filter((v) => v !== '' && v !== null)
    .map((v) => Number(v))
    .filter((v) => !isNaN(v));

  if (accountIds.length === 0) return '';

  const url = 'https://statlocker.gg/api/profile/batch-profiles';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-API-Key': apiKey },
    payload: JSON.stringify(accountIds),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code !== 200) throw new Error('HTTP ' + code + ': ' + text);

  const data = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error('Unexpected response shape from batch-profiles: ' + text.slice(0, 200));
  }
  if (data.length === 0) {
    throw new Error('batch-profiles returned no rows for the given account ID(s).');
  }

  const scores = data.map((row) => (row && typeof row.ppScore === 'number' ? row.ppScore : 0));
  const zeroCount = scores.filter((s) => s === 0).length;
  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;

  if (zeroCount === 0) return average;

  return [[average, `⚠ ${zeroCount} of ${scores.length} player(s) had no/insufficient-games ppScore, counted as 0`]];
}

/**
 * Defense in depth: doPost is all this app should ever receive. If a GET
 * ever reaches it (e.g. some future HTTP client/proxy that behaves
 * differently on a redirect than Node's fetch does), return a clear JSON
 * error instead of Apps Script's generic HTML "Error" page - that page is
 * what caused a confusing, hard-to-diagnose failure previously.
 */
function doGet(e) {
  return jsonResponse_({ error: 'This endpoint only accepts POST requests.' });
}

// How much clock skew + retry/backoff delay (see appsScriptClient.js's
// MAX_ATTEMPTS/RETRY_DELAY_MS) to tolerate between a request being signed
// and reaching here. Generous relative to that retry budget (worst case a
// few 10s of seconds), tight enough that a captured request is useless to
// replay shortly after.
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** Must match appsScriptClient.js's sign(). Returns lowercase hex. */
function computeSignature_(secret, action, timestamp) {
  const raw = Utilities.computeHmacSha256Signature(`${action}:${timestamp}`, secret);
  return raw
    .map((byte) => {
      const v = (byte < 0 ? byte + 256 : byte).toString(16);
      return v.length === 1 ? `0${v}` : v;
    })
    .join('');
}

// Apps Script has no built-in constant-time string compare - this walks
// the full length regardless of where a mismatch occurs, rather than
// short-circuiting on the first differing character the way `===` / a
// naive loop-with-early-return would.
function timingSafeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: 'Invalid JSON body' });
  }

  const secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret) return jsonResponse_({ error: 'Unauthorized' });

  const timestamp = Number(body.timestamp);
  if (!timestamp || Math.abs(Date.now() - timestamp) > SIGNATURE_WINDOW_MS) {
    return jsonResponse_({ error: 'Unauthorized' });
  }

  const expectedSignature = computeSignature_(secret, body.action, timestamp);
  if (!timingSafeEqual_(String(body.signature || ''), expectedSignature)) {
    return jsonResponse_({ error: 'Unauthorized' });
  }

  try {
    switch (body.action) {
      case 'getTable':
        return jsonResponse_(getTable_(body.tab));
      case 'updateRow':
        return jsonResponse_(updateRow_(body.tab, body.rowNumber, body.row));
      case 'getAllTables':
        return jsonResponse_(getAllTables_());
      case 'replaceAllTables':
        return jsonResponse_(replaceAllTables_(body.tables));
      case 'migrateFinishedEvent':
        return jsonResponse_(migrateFinishedEvent());
      default:
        return jsonResponse_({ error: `Unknown action: ${body.action}` });
    }
  } catch (err) {
    return jsonResponse_({ error: String(err) });
  }
}

function getSheet_(tabName) {
  if (!Object.prototype.hasOwnProperty.call(SCHEMA, tabName)) {
    throw new Error(`Unknown tab: ${tabName}`);
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sheet) throw new Error(`Unknown tab: ${tabName}`);
  return sheet;
}

function getTable_(tabName) {
  const sheet = getSheet_(tabName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return { headers: [], values: [] };

  // getDisplayValues (not getValues) so every cell comes back as the string
  // it displays as, rather than Sheets' typed Number/Date/Boolean - the bot
  // does strict string comparisons on IDs and needs consistent strings.
  const all = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  const headers = all[0];
  const values = all.slice(1);
  return { headers, values };
}

/**
 * Formula-injection guard: prefixes a leading =, +, -, or @ with an
 * apostrophe so Sheets stores the value as literal text instead of parsing
 * it as a formula - same trick as manually typing '=1+1 into a cell to keep
 * it literal. Needed everywhere user-controlled strings (team/player names,
 * nationalities, etc.) reach a sheet write, since getDisplayValues() on a
 * text-typed cell returns the string without this prefix - a downstream
 * copy (e.g. Teams -> TeamDB, or -> the public Roster tab) re-triggers
 * formula parsing unless it's re-sanitized at its own write site too, which
 * is why this is called at every setValues/appendRow/setValue/setFormula
 * call below rather than once at the front door.
 * Non-strings (numbers, booleans, null/undefined) pass through untouched.
 */
function sanitizeCellValue_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function sanitizeRow_(row) {
  return row.map(sanitizeCellValue_);
}

function sanitizeRows_(rows) {
  return rows.map(sanitizeRow_);
}

function updateRow_(tabName, rowNumber, row) {
  const sheet = getSheet_(tabName);
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([sanitizeRow_(row)]);
  return { ok: true };
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Returns every tab's full contents in one call. Used once at bot startup
 * to populate its local in-memory copy - see sheets.js for the caching
 * architecture this supports (all reads/writes happen against that local
 * copy afterward; this Apps Script endpoint is only hit at startup and
 * roughly hourly for the reverse direction, replaceAllTables_).
 */
function getAllTables_() {
  const tables = {};
  Object.keys(SCHEMA).forEach((tabName) => {
    tables[tabName] = getTable_(tabName);
  });
  return { tables };
}

/**
 * Overwrites every tab's data rows (below the header) with what the bot's
 * local copy currently holds. Headers are left alone - setupSheet owns
 * those. This is a full replace, not a merge: whatever the bot sends is
 * authoritative, since the bot is the only writer (per the local-first
 * design this supports - nothing else should be editing this sheet while
 * the bot is running with a local copy, or those edits will be overwritten
 * on the next sync).
 *
 * Writes are by column NAME, never position: for each field the bot owns
 * (SCHEMA[tabName]), this looks up that field's CURRENT column in the
 * live sheet's own header row and writes there - so you're free to
 * reorder Teams'/PlayerRegistry's/etc columns, or insert a column of your
 * own (e.g. a PPscore formula) anywhere, including between two of the
 * bot's columns, without it corrupting anything on the next sync. A field
 * the bot owns that's missing from the live header row is a hard error
 * (nowhere safe to write it) rather than a silent guess.
 *
 * body.tables: { [tabName]: { headers: string[], rows: string[][] } } -
 * headers is the column-name order the bot's row arrays are in (not
 * necessarily the live sheet's own order); rows is the data, values only.
 */
function replaceAllTables_(tables) {
  if (!tables) throw new Error('replaceAllTables: missing "tables" in request body.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = {};

  Object.entries(tables).forEach(([tabName, table]) => {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, tabName)) {
      throw new Error(`Unknown tab: ${tabName}`);
    }
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) throw new Error(`Unknown tab: ${tabName}`);

    const schemaFields = SCHEMA[tabName] || [];
    const payloadHeaders = table.headers || [];
    const rows = table.rows || [];

    const lastCol = Math.max(sheet.getLastColumn(), 1);
    const liveHeaders = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    const lastRow = sheet.getLastRow();

    schemaFields.forEach((field) => {
      const payloadIdx = payloadHeaders.indexOf(field);
      if (payloadIdx === -1) return; // bot didn't send this field this round - leave the column as-is

      const liveCol = liveHeaders.indexOf(field) + 1; // 1-indexed; 0 -> not found
      if (liveCol === 0) {
        throw new Error(
          `replaceAllTables: "${tabName}" has no "${field}" column in its header row (columns may have been ` +
            `renamed or deleted). Restore the header or run setupSheet(), then retry.`
        );
      }

      // Clear the full old extent of this column first - a straight
      // overwrite would leave stale values behind below the new row count
      // if the new data has fewer rows than before.
      if (lastRow > 1) {
        sheet.getRange(2, liveCol, lastRow - 1, 1).clearContent();
      }
      if (rows.length > 0) {
        const columnValues = rows.map((row) => [sanitizeCellValue_(row[payloadIdx] !== undefined ? row[payloadIdx] : '')]);
        sheet.getRange(2, liveCol, columnValues.length, 1).setValues(columnValues);
      }
    });

    results[tabName] = { rowsWritten: rows.length };
  });

  return { ok: true, results };
}
