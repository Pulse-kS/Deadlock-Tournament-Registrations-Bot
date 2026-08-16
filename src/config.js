require('dotenv').config();

const runtimeConfig = require('./services/runtimeConfig');

function required(name) {
  const val = process.env[name];
  if (!val) {
    // Fail fast at startup instead of warning and letting the bot come up
    // in a broken state - a missing essential var (e.g. DISCORD_TOKEN,
    // APPS_SCRIPT_SECRET) would otherwise only surface later as a confusing
    // runtime error the first time that code path is hit, possibly mid-way
    // through a captain's registration.
    throw new Error(`[config] Missing required environment variable: ${name}. Set it in .env and restart.`);
  }
  return val;
}

/**
 * Same as required() but for a comma-separated list of IDs (currently just
 * STAFF_ROLE_ID) - splits, trims, and drops empty entries so a stray
 * trailing comma or extra space doesn't produce a bad ID down the line.
 */
function requiredList(name) {
  return required(name)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Same as requiredList() but for an optional comma-separated list
 * (currently just ADMIN_ROLE_ID) - unset is a valid choice, returning [].
 */
function optionalList(name) {
  const val = process.env[name];
  if (!val) return [];
  return val
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Parses a Nextcloud public share link (https://host/s/TOKEN) into the
 * host + token pair services/nextcloud.js builds WebDAV/download URLs
 * from. Returns null if envValue is unset, so callers can fall back to a
 * different share (see the nextcloudPublic default below).
 */
function parseNextcloudShare(envValue, password) {
  const shareUrl = envValue || '';
  if (!shareUrl) return null;
  try {
    const parsed = new URL(shareUrl);
    return { baseUrl: parsed.origin, shareToken: parsed.pathname.split('/').filter(Boolean).pop(), sharePassword: password || '' };
  } catch (err) {
    console.warn(`[config] "${shareUrl}" is not a valid URL - logo uploads will fall back to Discord links.`);
    return null;
  }
}

// Env defaults for the 4 /config-overridable fields - computed once here
// (registrationChannelId still goes through required(), so a genuinely
// unset .env still fails startup immediately, same as before /config
// existed) rather than inline in each getter above, since a getter re-runs
// on every access and required()'s error-throw / the hardcoded message
// fallback have no business re-evaluating every single read.
const registrationChannelIdDefault = required('REGISTRATION_CHANNEL_ID');
const participantRoleIdDefault = process.env.PARTICIPANT_ROLE_ID || null;
const teamVcCategoryIdDefault = process.env.TEAM_VC_CATEGORY_ID || null;
const teamVcWelcomeMessageDefault =
  process.env.TEAM_VC_WELCOME_MESSAGE || "Welcome, {role}! This is **{team}**'s private voice channel for the tournament. Thanks for signing up!";

module.exports = {
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: required('DISCORD_GUILD_ID'),
    // registrationChannelId, participantRoleId, teamVcCategoryId, and
    // teamVcWelcomeMessage are the /config allowlist (see
    // services/runtimeConfig.js and commands/config.js) - each getter
    // checks for a saved override first, falling back to the env default
    // computed below. token/clientId/guildId above and staffRoleIds/
    // adminRoleIds below are deliberately NOT part of that allowlist and
    // must never be added to it - see commands/config.js's top comment for
    // why (no secrets, no server identity, no permission-role fields).
    get registrationChannelId() {
      return runtimeConfig.resolve('registrationChannelId', registrationChannelIdDefault);
    },
    // A comma-separated list of role IDs is accepted (e.g. two separate
    // staff tiers) - staffRoleIds is always an array, even for one role.
    // staffMention is the pre-joined "<@&id> <@&id>" text every ping site
    // uses, so a multi-role mention doesn't need rebuilding at each call
    // site - see registrationFlow.js's pingStaff and index.js/refresh.js.
    staffRoleIds: requiredList('STAFF_ROLE_ID'),
    get staffMention() {
      return this.staffRoleIds.map((id) => `<@&${id}>`).join(' ');
    },
    // Optional, same comma-separated shape as STAFF_ROLE_ID. Admins get
    // every permission staff does (team VC access, /refresh, and any
    // future admin-only slash command e.g. config editing) but are
    // deliberately never pinged - staffMention/pingStaff intentionally
    // stay staff-only. See privilegedRoleIds below, which is what any
    // permission gate meant for "staff or admin" should check.
    adminRoleIds: optionalList('ADMIN_ROLE_ID'),
    get privilegedRoleIds() {
      return [...new Set([...this.staffRoleIds, ...this.adminRoleIds])];
    },
    // Optional - granted to every player on a completed registration (see
    // teams.applyParticipantRole). Unset is a valid choice, not a
    // misconfiguration, so this deliberately does NOT go through
    // required() - see index.js's startup check for the console notice.
    get participantRoleId() {
      return runtimeConfig.resolve('participantRoleId', participantRoleIdDefault);
    },
    // Optional - category a brand new team's private voice channel gets
    // created under (see teams.createTeamVoiceChannel). Unset is a valid
    // choice, same as participantRoleId above - VC creation is simply
    // skipped on commit until this is set (see index.js's startup notice).
    get teamVcCategoryId() {
      return runtimeConfig.resolve('teamVcCategoryId', teamVcCategoryIdDefault);
    },
    // {team} is replaced with the team's name, {role} with a ping of the
    // team's role (see registrationFlow.js's resolveVcChannel, which also
    // sets allowedMentions so the role ping actually fires). Only ever
    // posted once, in the channel itself, at the moment the channel is
    // first created.
    get teamVcWelcomeMessage() {
      return runtimeConfig.resolve('teamVcWelcomeMessage', teamVcWelcomeMessageDefault);
    },
  },
  sheets: {
    webAppUrl: required('APPS_SCRIPT_URL'),
    sharedSecret: required('APPS_SCRIPT_SECRET'),
    // How often the local copy gets pushed up to the real Google Sheet.
    syncIntervalMs: parseInt(process.env.SHEETS_SYNC_INTERVAL_MINUTES || '60', 10) * 60 * 1000,
    // Backstop for services/localSnapshot.js - most snapshots actually
    // happen right after a commit (see writeToSheets), not on this timer;
    // this just catches any local-store change that isn't tied to a
    // registration commit (e.g. a flag raised mid-flow).
    snapshotIntervalMs: parseInt(process.env.LOCAL_SNAPSHOT_INTERVAL_MINUTES || '2', 10) * 60 * 1000,
    tabs: {
      playerRegistry: 'PlayerRegistry',
      teams: 'Teams',
      flags: 'Flags',
      // Staff-maintained historical signup data, read-only from the bot's
      // side - see services/playerDB.js and services/teamDB.js.
      playerDB: 'PlayerDB',
      teamDB: 'TeamDB',
    },
  },
  statlocker: {
    apiBase: process.env.STATLOCKER_API_BASE || 'https://statlocker.gg/api/public',
    apiKey: required('STATLOCKER_API_KEY'),
  },
  // Optional - team logos get uploaded here (via WebDAV to a share with
  // upload/edit rights) instead of only living as a Discord CDN link, since
  // those carry an expiring signature (see registrationFlow.js's
  // handleMessage). Unset is a valid choice - logos just fall back to the
  // Discord link when it's not configured, same as before this existed.
  //
  // Two separate shares on the same Nextcloud folder are supported: this
  // one (NEXTCLOUD_SHARE_URL) needs upload/edit rights and is what the bot
  // actually writes/renames/deletes files through - see nextcloud.js. If
  // that share also requires visitors to enter a password to view a file
  // directly (reasonable, since it can modify the folder), set
  // NEXTCLOUD_PUBLIC_SHARE_URL to a second, view-only, no-password share on
  // that same folder - that's the URL that then gets written into
  // logo_url, so a link handed to another org opens straight to the image
  // instead of a password prompt. Leave NEXTCLOUD_PUBLIC_SHARE_URL unset to
  // use the upload share for both, same as before this existed.
  nextcloud: parseNextcloudShare(process.env.NEXTCLOUD_SHARE_URL, process.env.NEXTCLOUD_SHARE_PASSWORD) || {
    baseUrl: null,
    shareToken: null,
    sharePassword: null,
  },
  nextcloudPublic:
    parseNextcloudShare(process.env.NEXTCLOUD_PUBLIC_SHARE_URL) ||
    parseNextcloudShare(process.env.NEXTCLOUD_SHARE_URL, process.env.NEXTCLOUD_SHARE_PASSWORD) || {
      baseUrl: null,
      shareToken: null,
      sharePassword: null,
    },
  roster: {
    maxMain: parseInt(process.env.ROSTER_MAX_MAIN || '6', 10),
    maxSubs: parseInt(process.env.ROSTER_MAX_SUBS || '2', 10),
  },
  // How often to sweep for and archive stale (inactive) registration
  // sessions - see sessions.purgeStale/index.js. Previously this only ran
  // once at startup, so a long-running bot never expired an abandoned
  // registration thread until its next restart.
  sessionPurgeIntervalMs: parseInt(process.env.SESSION_PURGE_INTERVAL_MINUTES || '60', 10) * 60 * 1000,
};
