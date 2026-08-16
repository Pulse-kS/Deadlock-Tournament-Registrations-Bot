/**
 * Runtime overrides for a hand-picked allowlist of config.discord fields -
 * lets /config (see commands/config.js) change how the bot interacts with
 * the server without editing .env and restarting. Deliberately does NOT
 * touch process.env or mutate config.js's required()-loaded values in
 * place - every override lives in its own on-disk store, and config.js's
 * getters for these 4 fields check here first, falling back to the .env
 * value otherwise. That keeps .env / required() startup validation as the
 * untouched, always-recoverable ground truth: deleting
 * config-overrides.json (or /config reset) always gets back to exactly
 * what .env says, nothing merged or clobbered in place.
 *
 * FIELDS below is the allowlist itself, and is intentionally short and
 * hand-picked rather than "every field not explicitly blocked" - see
 * commands/config.js's top comment for the safety reasoning (no secrets,
 * no server/guild identity, no permission-role fields).
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../utils/dataDir');

const PERSIST_PATH = path.join(dataDir(), 'config-overrides.json');
const TMP_PATH = `${PERSIST_PATH}.tmp`;

// type drives the slash command option used to collect a new value -
// 'channel'/'category' use Discord's native channel picker (restricted to
// that channel type), 'role' the native role picker, so an admin can only
// ever supply a real channel/role, never a typo'd or made-up ID.
const FIELDS = {
  registrationChannelId: {
    envVar: 'REGISTRATION_CHANNEL_ID',
    label: 'Registration channel',
    type: 'channel',
  },
  participantRoleId: {
    envVar: 'PARTICIPANT_ROLE_ID',
    label: 'Participant role',
    type: 'role',
  },
  teamVcCategoryId: {
    envVar: 'TEAM_VC_CATEGORY_ID',
    label: 'Team VC category',
    type: 'category',
  },
  teamVcWelcomeMessage: {
    envVar: 'TEAM_VC_WELCOME_MESSAGE',
    label: 'Team VC welcome message',
    type: 'text',
  },
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = fs.existsSync(PERSIST_PATH) ? JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8')) : {};
  } catch (err) {
    console.warn('[runtimeConfig] Could not load config-overrides.json, treating as empty:', err.message);
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    // Temp-file-then-rename, same as sessions.js/pendingWrites.js - a crash
    // mid-write must never corrupt this file.
    fs.writeFileSync(TMP_PATH, JSON.stringify(cache, null, 2));
    fs.renameSync(TMP_PATH, PERSIST_PATH);
  } catch (err) {
    console.error('[runtimeConfig] FAILED TO PERSIST a config override:', err.message);
  }
}

/** Live value for key: a saved override if one exists, else envDefault (whatever config.js's getter passes in). */
function resolve(key, envDefault) {
  const overrides = load();
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : envDefault;
}

/** Returns the override currently on file for key, or undefined if it's at its .env default. */
function getOverride(key) {
  return load()[key];
}

/** Saves an override for key. Throws on an unknown key - callers should only ever pass a FIELDS key. */
function set(key, value) {
  if (!FIELDS[key]) throw new Error(`Unknown configurable field: ${key}`);
  const overrides = load();
  overrides[key] = value;
  persist();
}

/** Clears key's override, reverting it back to whatever .env says. */
function reset(key) {
  if (!FIELDS[key]) throw new Error(`Unknown configurable field: ${key}`);
  const overrides = load();
  delete overrides[key];
  persist();
}

module.exports = { FIELDS, resolve, getOverride, set, reset };
