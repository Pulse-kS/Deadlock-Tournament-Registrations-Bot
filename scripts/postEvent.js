#!/usr/bin/env node
/**
 * One-command "archive a finished event" - see README's "Migrating a
 * finished event". Combines two independent, individually-safe-to-run
 * steps behind one command purely for convenience:
 *
 *   1. Calls the Apps Script web app's "migrateFinishedEvent" action,
 *      which runs migrateTeamsToTeamDB() + migratePlayerRegistryToPlayerDB()
 *      server-side (see Code.gs) - copies Teams -> TeamDB and
 *      PlayerRegistry -> PlayerDB directly in the live sheet.
 *   2. Archives audit.log locally (renamed, not deleted) so a new one
 *      starts clean for the next event.
 *
 * Deliberately does NOT touch Teams' data rows - clearing those for the
 * next event is still a manual step, so nothing here can delete real
 * signup data. Deliberately does NOT combine these into one function on
 * the Apps Script side either - a bug in the migration and a problem
 * archiving the log are different failure domains, and step 2 still runs
 * (with a clear note) even if step 1 fails, rather than one taking the
 * other down with it.
 *
 * Requires: the Code.gs deployment must include the "migrateFinishedEvent"
 * doPost action (Deploy > Manage deployments > edit > new version, same as
 * any other Code.gs change - see README). Run this with the bot STOPPED -
 * same rule as running the migration from the Apps Script editor directly:
 * this writes to the live Sheet, and the bot's local store doesn't know
 * about the write until its next restart/`/refresh`.
 *
 * Usage:
 *   npm run post-event                  interactive confirmation prompt
 *   npm run post-event -- --yes         skip the prompt (e.g. scripting)
 *   npm run post-event -- --label=finals-2026-08
 *                                        custom audit.log archive name
 *                                        (default: audit-<timestamp>.log)
 */
const fs = require('fs');
const readline = require('readline');
const config = require('../src/config');
const { callAppsScript } = require('../src/utils/appsScriptClient');
const { LOG_PATH } = require('../src/utils/auditLog');

function parseArgs(argv) {
  const args = { yes: false, label: null };
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg.startsWith('--label=')) args.label = arg.slice('--label='.length);
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

function defaultLabel() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function runMigration() {
  console.log('Calling Apps Script to migrate Teams -> TeamDB and PlayerRegistry -> PlayerDB...');
  const result = await callAppsScript(config.sheets.webAppUrl, config.sheets.sharedSecret, 'migrateFinishedEvent', {}, '[post-event]');
  console.log(
    `  Teams -> TeamDB: updated ${result.teams.updated}, appended ${result.teams.appended}.\n` +
      `  PlayerRegistry -> PlayerDB: updated ${result.players.updated}, appended ${result.players.appended}` +
      (result.players.skippedBlank ? `, skipped ${result.players.skippedBlank} row(s) with no account_id` : '') +
      '.'
  );
}

function archiveAuditLog(label) {
  if (!fs.existsSync(LOG_PATH)) {
    console.log('No audit.log present - nothing to archive.');
    return;
  }
  const archivePath = LOG_PATH.replace(/audit\.log$/, `audit-${label}.log`);
  fs.renameSync(LOG_PATH, archivePath);
  console.log(`Archived audit.log -> ${archivePath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label || defaultLabel();

  console.log('This writes directly to the live Google Sheet. Make sure the bot is STOPPED before continuing.');
  if (!args.yes) {
    const answer = await confirm('Continue? [y/N] ');
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Aborted - nothing was changed.');
      return;
    }
  }

  let migrationFailed = false;
  try {
    await runMigration();
  } catch (err) {
    migrationFailed = true;
    console.error(`Migration failed: ${err.message}`);
    console.error('audit.log will still be archived below - the two steps are independent (see this file\'s doc comment).');
  }

  archiveAuditLog(label);

  if (migrationFailed) {
    console.error('\nDone, but the Sheets migration failed - re-run once fixed (safe to re-run; see Code.gs\'s doc comments).');
    process.exitCode = 1;
  } else {
    console.log('\nDone. Remaining manual step: clear Teams\' data rows for the next event.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
