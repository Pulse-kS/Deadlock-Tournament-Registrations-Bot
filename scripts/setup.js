#!/usr/bin/env node
// Setup script version: 1.3
'use strict';

/**
 * Interactive .env setup for the Tournament Registration Bot.
 *
 * Run `node scripts/setup.js` (or `npm run setup`, or double-click
 * run-setup.bat on Windows - see that file). Deliberately talks to
 * Discord's REST API directly via fetch rather than requiring
 * src/config.js or discord.js's Client - config.js's required() calls
 * would throw immediately on a .env that doesn't exist yet, and this
 * script's whole point is to create that file for the first time (or
 * update specific fields in an existing one).
 *
 * What this gets you over hand-editing .env: once you paste in a bot
 * token, everything else - Client ID, which server, which channels/roles/
 * categories - gets looked up and shown as a pick-a-number list instead of
 * needing Developer Mode + right-click + Copy ID for each one individually.
 *
 * Deliberately out of scope here: the Google Apps Script side (creating
 * the Sheet, pasting Code.gs, deploying the web app) is an inherently
 * manual, click-through-Google's-UI process - see README's "Google Apps
 * Script setup" section. This script generates the SHARED_SECRET value
 * that step needs and reminds you to come back and fill in
 * APPS_SCRIPT_URL once you have it, same as it does for anything else
 * you'd rather fill in later.
 *
 * Safe to re-run: reads any existing .env first and offers every current
 * value as the default (secrets show "[keep existing]" rather than the
 * actual value, so nothing already-set gets echoed to the screen or
 * terminal scrollback). Backs the old file up to .env.bak before writing
 * a new one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const ENV_PATH = path.join(__dirname, '..', '.env');
const ENV_BAK_PATH = path.join(__dirname, '..', '.env.bak');
const IS_WINDOWS = process.platform === 'win32';
const DISCORD_API = 'https://discord.com/api/v10';

// View Channel, Send Messages, Add Reactions (marks logo uploads with ✅
// - registrationFlow.js), Manage Messages (deleting a captain's stray
// @-mention message during player lookup - same file, currently fails
// silently without this), Embed Links (the registration panel is sent as
// an embed every time it renders - without this the panel just never
// sends), Read Message History (re-fetching a message by ID to
// edit/delete it - three call sites, same file), Manage Channels (VC
// creation + permission overwrites), Manage Roles (team role
// creation/assignment), Attach Files (logo uploads), Create Private
// Threads + Send Messages in Threads (registration threads - always
// ChannelType.PrivateThread, never public), Manage Threads (archiving
// them on cancel/complete), Connect (so the bot can grant Connect via
// overwrite to staff/team roles on team VCs - see teams.js's
// createTeamVoiceChannel; Discord won't let it grant a permission it
// doesn't hold itself). Built from named bits rather than one hardcoded
// integer so it's obvious what each part is for and easy to audit/adjust.
const INVITE_PERMISSIONS = (
  0x400n | // VIEW_CHANNEL
  0x800n | // SEND_MESSAGES
  0x40n | // ADD_REACTIONS
  0x2000n | // MANAGE_MESSAGES
  0x4000n | // EMBED_LINKS
  0x10000n | // READ_MESSAGE_HISTORY
  0x10n | // MANAGE_CHANNELS
  0x10000000n | // MANAGE_ROLES
  0x8000n | // ATTACH_FILES
  0x1000000000n | // CREATE_PRIVATE_THREADS
  0x4000000000n | // SEND_MESSAGES_IN_THREADS
  0x400000000n | // MANAGE_THREADS
  0x100000n // CONNECT
).toString();

function fail(message) {
  console.error('');
  console.error(message);
  console.error('');
  process.exit(1);
}

async function discordApi(token, endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(`${DISCORD_API}${endpoint}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `timed out reaching Discord's API after 10s. This usually means a firewall, VPN, or ` +
        `antivirus is blocking outbound HTTPS to discord.com - try disabling it temporarily, ` +
        `or check your network connection.`
      );
    }
    throw new Error(`could not reach Discord's API (${err.message}). Check your internet connection.`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord API ${endpoint} returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function ask(rl, question, opts) {
  opts = opts || {};
  const suffix = opts.defaultValue ? ` [${opts.defaultValue}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  if (!answer && opts.defaultValue) return opts.defaultValue;
  if (!answer && opts.required) {
    console.log('  This one is required - please enter a value.');
    return ask(rl, question, opts);
  }
  return answer;
}

/**
 * Same as ask(), but masks typed input with "*" - for secrets (bot token,
 * API keys) so they aren't left visible in terminal scrollback or a screen
 * recording. If existingValue is passed, the prompt shows "[keep
 * existing]" (never the real value) and pressing Enter reuses it as-is.
 */
async function askSecret(rl, question, opts) {
  opts = opts || {};
  const suffix = opts.existingValue ? ' [keep existing]' : '';
  rl.output.write(`${question}${suffix}: `);
  const originalWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
  rl._writeToOutput = function (stringToWrite) {
    rl.output.write(/[\r\n]/.test(stringToWrite) ? stringToWrite : '*');
  };
  let answer;
  try {
    // readline/promises' question() takes an options object as its 2nd
    // arg (e.g. { signal }), NOT a callback - await its returned promise
    // directly instead of wrapping a callback that never gets called.
    answer = await rl.question('');
  } finally {
    if (originalWrite) rl._writeToOutput = originalWrite;
    else delete rl._writeToOutput;
  }
  const trimmed = answer.trim();
  if (!trimmed && opts.existingValue) return opts.existingValue;
  if (!trimmed && opts.required) {
    console.log('  This one is required - please enter a value.');
    return askSecret(rl, question, opts);
  }
  return trimmed;
}

/**
 * Prints a numbered list and asks for one or more picks by number.
 * Returns an array of the chosen items' `.id`. allowMultiple lets a
 * comma-separated list of numbers through (used for STAFF_ROLE_ID /
 * ADMIN_ROLE_ID); otherwise only the first number given is used. Blank
 * input returns [] - callers decide whether that's acceptable via
 * opts.required.
 */
async function pickFromList(rl, items, opts) {
  opts = opts || {};
  if (!items.length) {
    console.log(`  (no ${opts.emptyLabel || 'options'} found - skipping)`);
    return [];
  }
  items.forEach((item, i) => console.log(`  ${i + 1}. ${item.name}`));
  const raw = await ask(rl, opts.prompt || 'Pick a number', { required: opts.required });
  if (!raw) return [];
  const indexes = opts.allowMultiple ? raw.split(',').map((s) => s.trim()) : [raw];
  const picked = [];
  for (const idx of indexes) {
    const n = parseInt(idx, 10);
    if (!Number.isInteger(n) || n < 1 || n > items.length) {
      console.log(`  "${idx}" isn't one of the numbers above - try again.`);
      return pickFromList(rl, items, opts);
    }
    picked.push(items[n - 1]);
  }
  return picked;
}

function loadExistingEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  try {
    return require('dotenv').parse(fs.readFileSync(ENV_PATH, 'utf8'));
  } catch (err) {
    console.warn(`Could not parse existing .env (${err.message}) - starting fresh.`);
    return {};
  }
}

function copyToClipboard(text) {
  if (!IS_WINDOWS) return false;
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync('clip', [], { input: text });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function main() {
  console.log('');
  console.log('=== Tournament Registration Bot - Setup ===');
  console.log('');

  const existing = loadExistingEnv();
  if (Object.keys(existing).length) {
    console.log('Found an existing .env - press Enter on any question to keep its current value.');
    console.log('');
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // --- Bot token, validated live, and used to derive everything else ---
  console.log("Discord bot token - Developer Portal > your app > Bot > Reset Token / Copy.");
  let token = '';
  let botUser = null;
  for (;;) {
    token = await askSecret(rl, 'DISCORD_TOKEN', { existingValue: existing.DISCORD_TOKEN, required: true });
    console.log('  Validating with Discord (this should take a couple seconds)...');
    try {
      botUser = await discordApi(token, '/users/@me');
      break;
    } catch (err) {
      console.log(`  Could not validate that token (${err.message})`);
    }
  }
  console.log(`  Connected as ${botUser.username}.`);

  const application = await discordApi(token, '/applications/@me');
  const clientId = application.id;
  console.log(`  Client ID: ${clientId} (looked up automatically - no need to copy this from the portal).`);

  // --- Guild: list the bot's servers, or hand back an invite link if it's in none ---
  console.log('');
  let guilds = await discordApi(token, '/users/@me/guilds');
  while (!guilds.length) {
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`;
    console.log("This bot isn't in any servers yet. Invite it with this link, then come back here:");
    console.log(`  ${inviteUrl}`);
    await ask(rl, 'Press Enter once invited to check again');
    guilds = await discordApi(token, '/users/@me/guilds');
  }
  console.log('Which server is this for?');
  const [guild] = await pickFromList(
    rl,
    guilds.map((g) => ({ id: g.id, name: g.name })),
    { prompt: 'Server number', required: true }
  );
  const guildId = guild.id;

  const channels = await discordApi(token, `/guilds/${guildId}/channels`);
  const roles = (await discordApi(token, `/guilds/${guildId}/roles`)).filter((r) => r.name !== '@everyone');
  const textChannels = channels.filter((c) => c.type === 0).map((c) => ({ id: c.id, name: `#${c.name}` }));
  const categories = channels.filter((c) => c.type === 4).map((c) => ({ id: c.id, name: c.name }));
  const roleOptions = roles.map((r) => ({ id: r.id, name: `@${r.name}` }));

  console.log('');
  console.log('Which channel should captains use /register in?');
  const [registrationChannel] = await pickFromList(rl, textChannels, {
    prompt: 'Channel number',
    required: true,
    emptyLabel: 'text channels',
  });

  console.log('');
  console.log('Staff role(s) - pinged on completed registrations and when the bot needs help.');
  console.log('You can pick more than one (comma-separated numbers).');
  const staffRoles = await pickFromList(rl, roleOptions, {
    prompt: 'Role number(s)',
    required: true,
    allowMultiple: true,
    emptyLabel: 'roles',
  });

  console.log('');
  console.log('Admin role(s) - optional. Same access as staff, but never pinged. Press Enter to skip.');
  const adminRoles = await pickFromList(rl, roleOptions, {
    prompt: 'Role number(s)',
    allowMultiple: true,
    emptyLabel: 'roles',
  });

  console.log('');
  console.log('Participant role - optional. Granted to every player on a completed registration. Press Enter to skip.');
  const [participantRole] = await pickFromList(rl, roleOptions, { prompt: 'Role number', emptyLabel: 'roles' });

  console.log('');
  console.log("Team voice channel category - optional. Where each team's private VC gets created. Press Enter to skip.");
  const [teamVcCategory] = await pickFromList(rl, categories, { prompt: 'Category number', emptyLabel: 'categories' });

  let teamVcWelcomeMessage = existing.TEAM_VC_WELCOME_MESSAGE || '';
  if (teamVcCategory) {
    console.log('');
    console.log('Message posted once, the moment a team\'s voice channel is first created. {team} is replaced with the team name.');
    teamVcWelcomeMessage = await ask(rl, 'Welcome message', {
      defaultValue: teamVcWelcomeMessage || "Welcome, **{team}**! This is your team's private voice channel for the tournament. Thanks for signing up!",
    });
  }

  // --- Apps Script secret: generate now, URL comes later ---
  console.log('');
  let appsScriptSecret = existing.APPS_SCRIPT_SECRET || '';
  if (appsScriptSecret) {
    console.log('Apps Script shared secret already on file - keeping it.');
  } else {
    appsScriptSecret = crypto.randomBytes(24).toString('hex');
    console.log("Generated a shared secret for the Google Apps Script side (see README's");
    console.log('"Google Apps Script setup" - paste this exact value into the SHARED_SECRET');
    console.log('Script Property):');
    console.log('');
    console.log(`  ${appsScriptSecret}`);
    if (copyToClipboard(appsScriptSecret)) {
      console.log('');
      console.log("  It's already on your clipboard - just paste it in when you get there.");
    }
  }
  console.log('');
  console.log("Apps Script web app URL - only exists after you've finished that setup. Press Enter to fill in later.");
  const appsScriptUrl = await ask(rl, 'APPS_SCRIPT_URL', { defaultValue: existing.APPS_SCRIPT_URL || '' });

  console.log('');
  console.log('Statlocker.gg API key (see their /api page) - currently required to finish setup');
  console.log("despite the README calling it optional; get one now if you don't have it yet.");
  const statlockerKey = await askSecret(rl, 'STATLOCKER_API_KEY', { existingValue: existing.STATLOCKER_API_KEY, required: true });

  // --- Optional Nextcloud logo hosting ---
  console.log('');
  const wantNextcloud = (await ask(rl, 'Set up Nextcloud logo hosting now? (y/N)', { defaultValue: 'n' })).toLowerCase();
  let nextcloudShareUrl = existing.NEXTCLOUD_SHARE_URL || '';
  let nextcloudSharePassword = existing.NEXTCLOUD_SHARE_PASSWORD || '';
  let nextcloudPublicShareUrl = existing.NEXTCLOUD_PUBLIC_SHARE_URL || '';
  if (wantNextcloud === 'y' || wantNextcloud === 'yes') {
    nextcloudShareUrl = await ask(rl, 'NEXTCLOUD_SHARE_URL (upload share, e.g. https://host/s/TOKEN)', { defaultValue: nextcloudShareUrl });
    nextcloudSharePassword = await askSecret(rl, 'NEXTCLOUD_SHARE_PASSWORD (blank if not password-protected)', { existingValue: nextcloudSharePassword });
    nextcloudPublicShareUrl = await ask(rl, 'NEXTCLOUD_PUBLIC_SHARE_URL (optional, view-only share)', { defaultValue: nextcloudPublicShareUrl });
  }

  rl.close();

  // --- Write .env ---
  if (fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(ENV_PATH, ENV_BAK_PATH);
  }

  const lines = [
    '# Generated by scripts/setup.js - safe to hand-edit afterward, and safe to',
    '# re-run the script again later (it reads this file first and offers every',
    '# current value as the default).',
    '',
    '# --- Discord ---',
    `DISCORD_TOKEN=${token}`,
    `DISCORD_CLIENT_ID=${clientId}`,
    `DISCORD_GUILD_ID=${guildId}`,
    `REGISTRATION_CHANNEL_ID=${registrationChannel.id}`,
    `STAFF_ROLE_ID=${staffRoles.map((r) => r.id).join(',')}`,
    adminRoles.length ? `ADMIN_ROLE_ID=${adminRoles.map((r) => r.id).join(',')}` : '# ADMIN_ROLE_ID=',
    participantRole ? `PARTICIPANT_ROLE_ID=${participantRole.id}` : '# PARTICIPANT_ROLE_ID=',
    teamVcCategory ? `TEAM_VC_CATEGORY_ID=${teamVcCategory.id}` : '# TEAM_VC_CATEGORY_ID=',
    teamVcWelcomeMessage ? `TEAM_VC_WELCOME_MESSAGE=${teamVcWelcomeMessage}` : '# TEAM_VC_WELCOME_MESSAGE=',
    '',
    '# --- Google Apps Script (see README "Google Apps Script setup") ---',
    `APPS_SCRIPT_URL=${appsScriptUrl}`,
    `APPS_SCRIPT_SECRET=${appsScriptSecret}`,
    '',
    '# --- statlocker.gg ---',
    `STATLOCKER_API_KEY=${statlockerKey}`,
    '',
    '# --- Nextcloud logo hosting (optional) ---',
    nextcloudShareUrl ? `NEXTCLOUD_SHARE_URL=${nextcloudShareUrl}` : '# NEXTCLOUD_SHARE_URL=',
    nextcloudSharePassword ? `NEXTCLOUD_SHARE_PASSWORD=${nextcloudSharePassword}` : '# NEXTCLOUD_SHARE_PASSWORD=',
    nextcloudPublicShareUrl ? `NEXTCLOUD_PUBLIC_SHARE_URL=${nextcloudPublicShareUrl}` : '# NEXTCLOUD_PUBLIC_SHARE_URL=',
    '',
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n'));

  console.log('');
  console.log('=== Done ===');
  console.log('Wrote .env' + (fs.existsSync(ENV_BAK_PATH) ? ' (previous version backed up to .env.bak)' : '') + '.');
  console.log('');
  console.log('Next steps:');
  console.log('1. In the Discord Developer Portal, enable the Message Content Intent (Bot');
  console.log('   tab, privileged intents section) - needed for team logo uploads. Also make');
  console.log("   sure the bot's own role sits above any team roles it'll create (Server");
  console.log('   Settings > Roles) - Discord blocks a bot from managing roles above its own.');
  let step = 2;
  if (!appsScriptUrl) {
    console.log(`${step}. Finish the Google Apps Script setup (README's "Google Apps Script`);
    console.log('   setup" section) using the shared secret printed above, then put the web');
    console.log('   app URL in .env as APPS_SCRIPT_URL.');
    step += 1;
  }
  console.log(`${step}. npm run deploy-commands`);
  step += 1;
  console.log(`${step}. npm start (or start-bot.bat on Windows)`);
  console.log('');
}

main().catch((err) => {
  fail(`Setup failed unexpectedly: ${err.message}`);
});
