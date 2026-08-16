#!/usr/bin/env node
/**
 * Recovery tool for truncated Discord snowflake IDs in the staff-maintained
 * TeamDB (team_role_id) and PlayerDB (discord_id) tabs. Discord snowflakes
 * are 17-19 digit integers - well past what a double-precision float (or a
 * typical CSV/paste import into a "Number"-formatted cell) can represent
 * exactly, so IDs pasted into these tabs without the column pre-formatted
 * as Plain Text silently lose trailing digits. This is a recurring hazard
 * of the current import workflow, not a one-off incident - this script is
 * meant to be re-run whenever it happens again, not thrown away after use.
 *
 * This can only ever be a best-effort RECOVERY, not a guaranteed fix - for
 * any row where it can't find exactly one confident candidate, it leaves
 * that row alone and reports it rather than guessing.
 *
 * Two independent passes:
 *
 * TeamDB.team_role_id: matches each row's team_name against live Discord
 * role names, and its corrupted id against each candidate role's real id -
 * a genuine id and a numeric/scientific-notation-corrupted one still share
 * the same LEADING digits (trailing digits are what floating point loses),
 * so a long matching leading-digit run plus a strong name match is treated
 * as the same role. See normalizeCorruptedId/commonPrefixLength below.
 *
 * PlayerDB.discord_id: tries a fast, exact-confidence path first - if this
 * bot has ever registered this account_id live (PlayerRegistry), that row's
 * discord_id came straight from discord.js at registration time, never
 * round-tripped through CSV, so it's trustworthy as-is and needs no fuzzy
 * matching at all. Only for rows with no PlayerRegistry match does this
 * fall back to scanning the full guild membership, matching past_discord_names
 * against each member's username/tag/display name plus the same
 * leading-digit-prefix check used for TeamDB.
 *
 * This does NOT go through the running bot or its local Sheets cache - it
 * talks to Discord and Apps Script directly, the same way postEvent.js
 * does. Run with the bot stopped, or run /refresh afterward, since a write
 * via this script won't reach the bot's in-memory copy until it reloads.
 *
 * Usage:
 *   npm run recover-ids                      dry run, prints a report, writes nothing
 *   npm run recover-ids -- --apply           also prompts to confirm+write each clean match
 *   npm run recover-ids -- --apply --yes     write every clean match with no prompting - use only
 *       after reviewing a dry-run report, or when stdin isn't an interactive terminal (e.g. run via
 *       a web terminal's "docker compose run", where [y/N] prompts can never be answered and hang)
 *   npm run recover-ids -- --min-prefix=8    require at least 8 matching leading digits (default 6)
 *   npm run recover-ids -- --min-name=0.7    require at least this name-similarity score, 0-1 (default 0.6)
 *   npm run recover-ids -- --only=teamdb     just one table - teamdb or playerdb (default: both)
 *   npm run recover-ids -- --min-trailing-zeros=2   flag an already-17-19-digit id as
 *       still-corrupted if it ends in this many zeroes (default 2). Precision loss often
 *       pads a corrupted id out to a length that still passes the 17-19 digit snowflake
 *       check, so length alone isn't enough - a long trailing-zero run is the tell.
 */
const readline = require('readline');
const { Client, GatewayIntentBits } = require('discord.js');
const config = require('../src/config');
const { callAppsScript } = require('../src/utils/appsScriptClient');
const { combinedSimilarity, FUZZY_MATCH_MIN_CONFIDENCE } = require('../src/utils/teamNameMatch');

function parseArgs(argv) {
  const args = { apply: false, minPrefix: 6, minName: FUZZY_MATCH_MIN_CONFIDENCE, only: 'both', minTrailingZeros: 2, yes: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg.startsWith('--min-prefix=')) args.minPrefix = Number(arg.slice('--min-prefix='.length));
    else if (arg.startsWith('--min-name=')) args.minName = Number(arg.slice('--min-name='.length));
    else if (arg.startsWith('--only=')) args.only = arg.slice('--only='.length).toLowerCase();
    else if (arg.startsWith('--min-trailing-zeros=')) args.minTrailingZeros = Number(arg.slice('--min-trailing-zeros='.length));
  }
  return args;
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Pulls whatever digits are actually present out of a corrupted id value
 * and reconstructs its best-guess full magnitude, so "7.6561198E+17" and
 * "765611980000000000" both normalize to a comparable leading-digit run.
 * Plain already-correct-looking digit strings pass through untouched.
 */
function normalizeCorruptedId(raw) {
  const s = String(raw || '').trim();
  const sciMatch = /^(\d)(?:\.(\d+))?[eE]\+?(\d+)$/.exec(s);
  if (sciMatch) {
    const leading = sciMatch[1] + (sciMatch[2] || '');
    const exponent = Number(sciMatch[3]);
    const totalDigits = exponent + 1;
    return leading.padEnd(totalDigits, '0').slice(0, totalDigits);
  }
  return s.replace(/[^0-9]/g, '');
}

/** Length of the longest common leading-digit run between two id strings. */
function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** A Discord snowflake is realistically never shorter than 17 digits (pre-2015 IDs don't exist in a live guild). */
function looksLikeFullSnowflake(raw) {
  return /^\d{17,19}$/.test(String(raw || '').trim());
}

/** Length of the trailing run of zeroes at the end of a digit string. */
function trailingZeroRunLength(raw) {
  const match = /0+$/.exec(String(raw || '').trim());
  return match ? match[0].length : 0;
}

/**
 * True if this value needs recovery. Length alone (looksLikeFullSnowflake)
 * isn't sufficient: precision loss can pad a corrupted id out to a length
 * that still happens to fall in the 17-19 digit range, so a full-length id
 * ending in a long run of zeroes is still treated as corrupted.
 */
function needsFix(raw, minTrailingZeros) {
  if (!looksLikeFullSnowflake(raw)) return true;
  return trailingZeroRunLength(raw) >= minTrailingZeros;
}

async function recoverTeamDB(guild, args) {
  const TAB = config.sheets.tabs.teamDB;
  console.log('\n=== TeamDB.team_role_id ===');
  const { headers, values } = await callAppsScript(config.sheets.webAppUrl, config.sheets.sharedSecret, 'getTable', { tab: TAB }, '[recover]');
  const nameIdx = headers.indexOf('team_name');
  const roleIdIdx = headers.indexOf('team_role_id');
  if (nameIdx === -1 || roleIdIdx === -1) {
    console.log(`  SKIPPED - TeamDB is missing team_name or team_role_id in its headers: ${headers.join(', ')}`);
    return [];
  }
  const rows = values
    .map((v, i) => ({ rowNumber: i + 2, values: v, teamName: v[nameIdx], corruptedId: v[roleIdIdx] }))
    .filter((r) => r.teamName && needsFix(r.corruptedId, args.minTrailingZeros)); // already-fine rows need no work

  console.log(`${rows.length} row(s) look like they need a fix (of ${values.length} total).`);

  const roles = await guild.roles.fetch();
  const results = [];
  for (const row of rows) {
    const normalizedCorrupted = normalizeCorruptedId(row.corruptedId);
    const candidates = [];
    for (const role of roles.values()) {
      const nameScore = combinedSimilarity(row.teamName, role.name);
      if (nameScore < args.minName) continue;
      const prefixLen = commonPrefixLength(normalizedCorrupted, role.id);
      if (prefixLen < args.minPrefix) continue;
      candidates.push({ label: role.name, id: role.id, nameScore, prefixLen });
    }
    candidates.sort((a, b) => b.prefixLen - a.prefixLen || b.nameScore - a.nameScore);
    results.push({ table: 'TeamDB', tab: TAB, idColumn: roleIdIdx, row, rowLabel: row.teamName, candidates });
  }
  reportResults(results);
  return results;
}

async function recoverPlayerDB(guild, args) {
  const TAB = config.sheets.tabs.playerDB;
  console.log('\n=== PlayerDB.discord_id ===');
  const { headers, values } = await callAppsScript(config.sheets.webAppUrl, config.sheets.sharedSecret, 'getTable', { tab: TAB }, '[recover]');
  const acctIdx = headers.indexOf('account_id');
  const discordIdx = headers.indexOf('discord_id');
  const namesIdx = headers.indexOf('past_discord_names');
  if (acctIdx === -1 || discordIdx === -1) {
    console.log(`  SKIPPED - PlayerDB is missing account_id or discord_id in its headers: ${headers.join(', ')}`);
    return [];
  }
  const rows = values
    .map((v, i) => ({ rowNumber: i + 2, values: v, accountId: v[acctIdx], corruptedId: v[discordIdx], pastNames: v[namesIdx] || '' }))
    .filter((r) => r.corruptedId && needsFix(r.corruptedId, args.minTrailingZeros)); // blank or already-fine rows need no work

  console.log(`${rows.length} row(s) look like they need a fix (of ${values.length} total).`);

  // Fast, exact-confidence path: this bot's own PlayerRegistry, wherever it
  // has a full-length discord_id for the same account_id - that value came
  // straight from discord.js at registration time, never round-tripped
  // through a CSV, so no fuzzy matching needed.
  const registryTab = config.sheets.tabs.playerRegistry;
  const registry = await callAppsScript(config.sheets.webAppUrl, config.sheets.sharedSecret, 'getTable', { tab: registryTab }, '[recover]');
  const regAcctIdx = registry.headers.indexOf('account_id');
  const regDiscordIdx = registry.headers.indexOf('discord_id');
  const registryMap = new Map();
  if (regAcctIdx !== -1 && regDiscordIdx !== -1) {
    for (const v of registry.values) {
      const discordId = v[regDiscordIdx];
      if (looksLikeFullSnowflake(discordId)) registryMap.set(v[regAcctIdx], discordId);
    }
  }

  const remaining = [];
  const results = [];
  for (const row of rows) {
    const fromRegistry = registryMap.get(row.accountId);
    if (fromRegistry && fromRegistry !== row.corruptedId) {
      results.push({
        table: 'PlayerDB',
        tab: TAB,
        idColumn: discordIdx,
        row,
        rowLabel: row.pastNames || row.accountId,
        candidates: [{ label: 'this bot\'s own PlayerRegistry (exact account_id match)', id: fromRegistry, nameScore: 1, prefixLen: fromRegistry.length }],
      });
    } else {
      remaining.push(row);
    }
  }

  // Fallback for players never registered live through this bot: scan the
  // full guild membership and match by name.
  if (remaining.length) {
    console.log(`Fetching full guild membership for the ${remaining.length} row(s) with no PlayerRegistry match...`);
    const members = await guild.members.fetch();
    for (const row of remaining) {
      const normalizedCorrupted = normalizeCorruptedId(row.corruptedId);
      const candidates = [];
      for (const member of members.values()) {
        const namesToCheck = [member.user.username, member.user.tag, member.displayName].filter(Boolean);
        const nameScore = Math.max(0, ...namesToCheck.map((n) => combinedSimilarity(row.pastNames, n)));
        if (nameScore < args.minName) continue;
        const prefixLen = commonPrefixLength(normalizedCorrupted, member.id);
        if (prefixLen < args.minPrefix) continue;
        candidates.push({ label: member.user.tag, id: member.id, nameScore, prefixLen });
      }
      candidates.sort((a, b) => b.prefixLen - a.prefixLen || b.nameScore - a.nameScore);
      results.push({ table: 'PlayerDB', tab: TAB, idColumn: discordIdx, row, rowLabel: row.pastNames || row.accountId, candidates });
    }
  }

  reportResults(results);
  return results;
}

function reportResults(results) {
  const clean = results.filter((r) => r.candidates.length === 1);
  const ambiguous = results.filter((r) => r.candidates.length > 1);
  const noMatch = results.filter((r) => r.candidates.length === 0);

  console.log(`  ${clean.length} clean match(es), ${ambiguous.length} ambiguous, ${noMatch.length} unmatched.`);
  for (const { row, rowLabel, candidates } of clean) {
    const c = candidates[0];
    console.log(`  - row ${row.rowNumber} "${rowLabel}": ${row.corruptedId || '(blank)'} -> ${c.id} (${c.label})`);
  }
  if (ambiguous.length) {
    console.log('  Ambiguous (needs a human pick):');
    for (const { row, rowLabel, candidates } of ambiguous) {
      console.log(`  - row ${row.rowNumber} "${rowLabel}" (${row.corruptedId || '(blank)'}):`);
      for (const c of candidates.slice(0, 5)) {
        console.log(`      ${c.id}  "${c.label}"  (name score ${c.nameScore.toFixed(2)}, ${c.prefixLen} leading digits)`);
      }
    }
  }
  if (noMatch.length) {
    console.log('  No candidate above the thresholds:');
    for (const { row, rowLabel } of noMatch) {
      console.log(`  - row ${row.rowNumber} "${rowLabel}" (${row.corruptedId || '(blank)'})`);
    }
  }
}

async function applyResults(results, args) {
  const clean = results.filter((r) => r.candidates.length === 1);
  if (!clean.length) return;
  if (!args.yes && !process.stdin.isTTY) {
    console.error(
      `\n${clean.length} clean match(es) ready to write, but stdin isn't an interactive terminal, so the ` +
        `[y/N] prompts below can never be answered and would hang forever (this is likely what happened if ` +
        `you ran this via "docker compose run" through a web terminal or other non-interactive shell). ` +
        `Re-run with "docker compose run --rm -it ..." for real prompts, or add --yes to write all clean ` +
        `matches above without prompting (only do this once you've reviewed the report).`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\n--apply given: ${args.yes ? 'writing all clean matches without prompting (--yes).' : 'confirming each clean match before writing.'}`);
  for (const { table, tab, idColumn, row, rowLabel, candidates } of clean) {
    const c = candidates[0];
    if (!args.yes) {
      const answer = await confirm(`[${table}] Write "${rowLabel}" (row ${row.rowNumber}) = ${c.id} (${c.label})? [y/N] `);
      if (answer !== 'y' && answer !== 'yes') {
        console.log('  skipped.');
        continue;
      }
    } else {
      console.log(`[${table}] Writing "${rowLabel}" (row ${row.rowNumber}) = ${c.id} (${c.label})...`);
    }
    const newValues = row.values.slice();
    newValues[idColumn] = c.id;
    await callAppsScript(config.sheets.webAppUrl, config.sheets.sharedSecret, 'updateRow', { tab, rowNumber: row.rowNumber, row: newValues }, '[recover]');
    console.log('  written.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Settings: min leading-digit match = ${args.minPrefix}, min name similarity = ${args.minName}, ` +
      `min trailing zeroes to flag = ${args.minTrailingZeros}, only = ${args.only}, apply = ${args.apply}`
  );

  console.log('Logging into Discord (read-only)...');
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  await client.login(config.discord.token);
  const guild = await client.guilds.fetch(config.discord.guildId);

  const allResults = [];
  if (args.only === 'both' || args.only === 'teamdb') {
    allResults.push(...(await recoverTeamDB(guild, args)));
  }
  if (args.only === 'both' || args.only === 'playerdb') {
    allResults.push(...(await recoverPlayerDB(guild, args)));
  }

  if (!args.apply) {
    console.log('\nDry run only - nothing written. Re-run with --apply to confirm and write the clean matches above.');
  } else {
    await applyResults(allResults, args);
  }

  await client.destroy();
  console.log('\nDone. If the bot is running, run /refresh (or restart it) to pick up these changes.');
  console.log(
    'Note: this fixes the data, not the cause - re-pasting IDs into TeamDB/PlayerDB without the column ' +
      'formatted as Plain Text (Format > Number > Plain text) will corrupt them again.'
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
