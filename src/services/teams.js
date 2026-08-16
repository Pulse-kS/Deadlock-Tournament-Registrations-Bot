const { ChannelType, PermissionFlagsBits } = require('discord.js');
const sheets = require('./sheets');
const config = require('../config');
const registry = require('./registry');
const sessions = require('../utils/sessions');

const TEAMS_TAB = config.sheets.tabs.teams;
const SLOT_TYPE = sessions.SLOT_TYPE;

// Teams is the single source of truth for roster membership - each slot's
// account_id lives directly on the team row, same shape as TeamDB (see
// teamDB.js). p1-p6 are always mains; s1/s2 subs, c1/c2 coaches, kept as
// separate columns rather than one ambiguous pool so there's no need to
// infer slot type from position.
const MAIN_COLUMNS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const SUB_COLUMNS = ['s1', 's2'];
const COACH_COLUMNS = ['c1', 'c2'];

/**
 * Flattens a Teams row's p1-p6/s1/s2/c1/c2 into a roster shape:
 * [{ accountId, slotType }], skipping blank slots. Unlike
 * teamDB.rosterFromTeamRow, no Steam ID resolution is needed here - these
 * cells are only ever written by this bot, always as a plain account_id.
 */
function rosterFromTeamRow(row) {
  const slots = [];
  for (const col of MAIN_COLUMNS) {
    const val = (row[col] || '').trim();
    if (val) slots.push({ accountId: val, slotType: SLOT_TYPE.MAIN });
  }
  for (const col of SUB_COLUMNS) {
    const val = (row[col] || '').trim();
    if (val) slots.push({ accountId: val, slotType: SLOT_TYPE.SUB });
  }
  for (const col of COACH_COLUMNS) {
    const val = (row[col] || '').trim();
    if (val) slots.push({ accountId: val, slotType: SLOT_TYPE.COACH });
  }
  return slots;
}

/**
 * Builds the p1-p6/s1/s2/c1/c2 column patch for a session-shaped roster
 * (see sessions.js) - 'discard'-status slots are dropped, everything else
 * is bucketed by slotType and assigned to the next free column in that
 * bucket, in roster order. Callers (registrationFlow's commit path) already
 * validate roster size against config.roster.maxMain/maxSubs before this
 * runs, so overflow shouldn't happen - but slots beyond a bucket's column
 * count are silently dropped rather than thrown away loudly, since this is
 * a pure data-shaping helper, not the validation point.
 */
function buildRosterColumns(roster) {
  const active = (roster || []).filter((r) => r.status !== 'discard');
  const mains = active.filter((r) => r.slotType === SLOT_TYPE.MAIN).map((r) => r.accountId);
  const subs = active.filter((r) => r.slotType === SLOT_TYPE.SUB).map((r) => r.accountId);
  const coaches = active.filter((r) => r.slotType === SLOT_TYPE.COACH).map((r) => r.accountId);

  const cols = {};
  MAIN_COLUMNS.forEach((col, i) => {
    cols[col] = mains[i] || '';
  });
  SUB_COLUMNS.forEach((col, i) => {
    cols[col] = subs[i] || '';
  });
  COACH_COLUMNS.forEach((col, i) => {
    cols[col] = coaches[i] || '';
  });
  return cols;
}

/** Returns all team role IDs that a guild member currently holds (checked against registered Teams, not a separate config tab). */
async function getMemberTeamRoleIds(member) {
  const allTeams = await getAllTeams();
  const teamRoleIds = new Set(allTeams.map((t) => t.team_role_id));
  return member.roles.cache.filter((role) => teamRoleIds.has(role.id)).map((role) => role.id);
}

/**
 * Creates the Discord role for a brand new team. Called only after staff
 * approval (see registrationFlow's staff-approve-new-team step) - the bot
 * creates the role itself so staff never have to touch role creation by
 * hand, they just approve. The corresponding Teams row (which is what makes
 * this role count in getMemberTeamRoleIds above) gets written separately in
 * the background - see registrationFlow's commit path.
 */
async function createTeamRole(guild, teamName) {
  return guild.roles.create({
    name: teamName,
    mentionable: true,
    reason: 'New tournament team registration approved',
  });
}

/**
 * Creates a brand new team's private voice channel: hidden from @everyone,
 * visible/connectable to staff and the team's own role only. Caller
 * (registrationFlow's resolveVcChannel) is responsible for checking
 * config.discord.teamVcCategoryId is set and for not calling this again if
 * a channel is already on file for the team - this always creates a new
 * one.
 */
async function createTeamVoiceChannel(guild, teamName, teamRoleId) {
  return guild.channels.create({
    name: teamName.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: config.discord.teamVcCategoryId,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      // Explicit self-overwrite: setting any permissionOverwrites on
      // creation replaces category inheritance entirely, so without this
      // the bot has no ViewChannel on the channel it just made (even
      // though its role has ViewChannel at the category level) and can't
      // post the welcome message below - "Missing Access".
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages] },
      ...config.discord.privilegedRoleIds.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] })),
      { id: teamRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    ],
    reason: `Private team voice channel for ${teamName}`,
  });
}

// ---- Teams ----

async function getTeamByRoleId(teamRoleId) {
  return sheets.findRow(TEAMS_TAB, (r) => r.team_role_id === teamRoleId);
}

async function getAllTeams() {
  const { rows } = await sheets.getTable(TEAMS_TAB);
  return rows;
}

/**
 * Finds a team whose name matches (case-insensitive) another team's name,
 * excluding the team identified by excludeTeamRoleId (so a team keeping its
 * own existing name doesn't flag against itself).
 */
async function findTeamByName(teamName, excludeTeamRoleId) {
  const all = await getAllTeams();
  const normalized = teamName.trim().toLowerCase();
  return all.find(
    (t) => t.team_role_id !== excludeTeamRoleId && (t.team_name || '').trim().toLowerCase() === normalized
  );
}

async function createTeam({ teamRoleId, teamName, roster, logoUrl, vcChannelId }) {
  // Field set here must stay column-for-column in sync with Code.gs's
  // Teams SCHEMA - adding, removing, or renaming a field here requires the
  // matching change there, or writes land in the wrong columns.
  const row = {
    team_role_id: teamRoleId,
    team_name: teamName,
    ...buildRosterColumns(roster),
    logo_url: logoUrl || '',
    vc_channel_id: vcChannelId || '',
  };
  await sheets.appendRow(TEAMS_TAB, row);
  return row;
}

/** Finds the Teams row (if any) whose roster columns contain this account_id. Used by applyRoleOnJoin below. */
async function findTeamContainingAccountId(accountId) {
  if (!accountId) return undefined;
  const all = await getAllTeams();
  return all.find((row) => rosterFromTeamRow(row).some((slot) => slot.accountId === accountId));
}

async function updateTeam(teamRoleId, updates) {
  const existing = await getTeamByRoleId(teamRoleId);
  if (!existing) throw new Error(`No team found for role ${teamRoleId}`);
  await sheets.updateRow(TEAMS_TAB, existing._rowNumber, updates);
}

// ---- Discord role diffing ----

/**
 * Reconciles a team's Discord role assignments against the desired set of
 * Discord user IDs. Scoped strictly to teamRoleId - never touches other roles.
 * Members not currently in the guild are simply skipped - Teams' roster
 * columns already reflect the intent, so applyRoleOnJoin (below) picks it up
 * live whenever they actually join, no separate queue needed.
 *
 * Returns an array of { discordId, action: 'add'|'remove', error } for any
 * individual role change that failed - e.g. Discord silently refuses to let
 * anyone but the account itself manage the guild owner's roles, even with
 * Manage Roles/Administrator, so removing an owner from a roster will always
 * fail here. Previously these errors were swallowed entirely (.catch(() =>
 * {})) with no way to tell "successfully removed" apart from "silently
 * failed to remove" - that's what let a role like this stick around
 * unnoticed. Doesn't throw on an individual failure - one member's
 * permission quirk shouldn't stop the rest of the roster from reconciling.
 */
async function reconcileTeamRole(guild, teamRoleId, desiredDiscordIds) {
  const role = await guild.roles.fetch(teamRoleId);
  if (!role) throw new Error(`Team role ${teamRoleId} does not exist in this guild.`);

  const desired = new Set(desiredDiscordIds.filter(Boolean));
  const currentMembers = role.members; // Collection<snowflake, GuildMember>

  const toRemove = currentMembers.filter((m) => !desired.has(m.id));
  const toAddIds = [...desired].filter((id) => !currentMembers.has(id));
  const failures = [];

  for (const member of toRemove.values()) {
    await member.roles.remove(role, 'Roster update: no longer on team').catch((error) => {
      failures.push({ discordId: member.id, action: 'remove', error });
    });
  }

  for (const id of toAddIds) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member) {
      await member.roles.add(role, 'Roster update: added to team').catch((error) => {
        failures.push({ discordId: id, action: 'add', error });
      });
    }
  }

  return failures;
}

/**
 * Keeps a team's Discord role name in sync with its registered team_name.
 * createTeamRole only sets the name once, at creation - captains can
 * rename their team afterward (see registrationFlow's promptRenameTeam),
 * and without this the role silently drifts from the name on record in
 * the Teams sheet forever. No-op if the role is already correctly named
 * or can't be fetched (e.g. deleted).
 */
async function syncTeamRoleName(guild, teamRoleId, teamName) {
  const role = await guild.roles.fetch(teamRoleId).catch(() => null);
  if (!role || role.name === teamName) return;
  await role.setName(teamName, 'Keeping team role name in sync with registered team name');
}

/**
 * Grants config.discord.participantRoleId to every given Discord user on a
 * completed registration - kept separate from per-team roles so staff can
 * gate broad tournament permissions (channels, event pings, etc) off one
 * role instead of the full list of team roles. No-ops per-member if
 * they're not in the guild or already have the role. Returns failures in
 * the same { discordId, action, error } shape as reconcileTeamRole.
 */
async function applyParticipantRole(guild, discordIds) {
  const roleId = config.discord.participantRoleId;
  if (!roleId) return [];
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return [];

  const failures = [];
  for (const id of new Set(discordIds.filter(Boolean))) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member || member.roles.cache.has(roleId)) continue;
    await member.roles.add(role, 'Completed tournament registration').catch((error) => {
      failures.push({ discordId: id, action: 'add', error });
    });
  }
  return failures;
}

/**
 * Called from guildMemberAdd. Looks up the new joiner's PlayerRegistry row
 * by discord_id to get their account_id, then checks every Teams row's
 * roster columns for that account_id (live, not a queued snapshot) - if
 * found, grants that team's role. Reading current state on every join
 * rather than a pre-written queue means a player removed from a roster
 * before joining never gets an outdated role.
 *
 * This is a scan over every Teams row rather than a single-row lookup;
 * with local-first storage that's still just an in-memory pass, not a
 * network round trip, so it's not a meaningful cost.
 */
async function applyRoleOnJoin(member) {
  const player = await registry.findPlayerByDiscordId(member.id);
  if (!player) return;
  const team = await findTeamContainingAccountId(player.account_id);
  if (!team) return;
  const role = await member.guild.roles.fetch(team.team_role_id).catch(() => null);
  if (role) {
    await member.roles.add(role, 'Applying roster role on join').catch(() => {});
  }
}

module.exports = {
  createTeamRole,
  createTeamVoiceChannel,
  getMemberTeamRoleIds,
  getTeamByRoleId,
  getAllTeams,
  findTeamByName,
  findTeamContainingAccountId,
  createTeam,
  updateTeam,
  reconcileTeamRole,
  syncTeamRoleName,
  applyParticipantRole,
  applyRoleOnJoin,
  rosterFromTeamRow,
  buildRosterColumns,
};
