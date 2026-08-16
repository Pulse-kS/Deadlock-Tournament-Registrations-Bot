const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
  MessageFlags,
} = require('discord.js');

const config = require('../config');
const sessions = require('../utils/sessions');
const pendingWrites = require('../utils/pendingWrites');
const auditLog = require('../utils/auditLog');
const localSnapshot = require('../services/localSnapshot');
const sheets = require('../services/sheets');
const teams = require('../services/teams');
const registry = require('../services/registry');
const playerDB = require('../services/playerDB');
const teamDB = require('../services/teamDB');
const steamService = require('../services/steam');
const statlocker = require('../services/statlocker');
const nextcloud = require('../services/nextcloud');
const { validateNationality, formatNationality } = require('../utils/validation');
const {
  detectImageType,
  assertSizeWithinLimit,
  assertImageDimensionsWithinLimit,
  DOWNLOAD_TIMEOUT_MS,
} = require('../utils/imageValidation');
const { StatlockerLookupError } = statlocker;

const SLOT_TYPE = sessions.SLOT_TYPE;
const STATUS_ICON = { keep: '✅', renamed: '🔁', discard: '❌', new: '➕' };

// Team data fetches kicked off before the captain has decided whether they
// even want it (see startExistingTeamFlow) - short-lived (seconds) and
// deliberately NOT persisted like sessions.js. If the bot restarts mid-flight
// the button handler just falls back to fetching fresh.
const pendingTeamDataFetches = new Map();

// ---------------------------------------------------------------------------
// Entry point: /register command
// ---------------------------------------------------------------------------

async function startRegistration(interaction) {
  // Defer immediately, before any Discord REST calls below (channel fetch,
  // thread creation, adding the member to it) - those can occasionally take
  // long enough on their own to blow past Discord's 3s interaction-ack
  // window. If that happens before the old reply() call further down, the
  // interaction has already expired by the time it fires, and Discord
  // rejects it with "Unknown interaction" (10062) - exactly what showed up
  // in testing. Same pattern as commitRegistration further down this file.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const member = interaction.member;

  // One active registration thread per user - otherwise repeated /register
  // clicks (accidental or malicious) each spin up a new private thread,
  // which is wasted channel clutter at best and a cheap way to spam thread
  // creation at worst.
  const existing = sessions.findByOwner(member.id);
  if (existing) {
    const existingThread = await guild.channels.fetch(existing.threadId).catch(() => null);
    if (existingThread && !existingThread.archived) {
      await interaction.editReply({
        content: `You already have a registration in progress: ${existingThread}. Continue there, or use Cancel in that thread to start over.`,
      });
      return;
    }
    // Thread was deleted or got archived out from under the session -
    // nothing to redirect back to, so clear it and let a fresh one start.
    sessions.clear(existing.threadId);
  }

  const parentChannel = await guild.channels.fetch(config.discord.registrationChannelId);
  if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
    await interaction.editReply({
      content: 'Registration channel is misconfigured. Contact staff.',
    });
    return;
  }

  const thread = await parentChannel.threads.create({
    name: `registration-${member.user.username}`,
    type: ChannelType.PrivateThread,
    reason: `Tournament registration started by ${member.user.tag}`,
  });
  await thread.members.add(member.id);

  await interaction.editReply({
    content: `Registration started: ${thread}`,
  });

  const teamRoleIds = await teams.getMemberTeamRoleIds(member);

  if (teamRoleIds.length > 1) {
    await pingStaff(
      thread,
      `${member} holds multiple team roles (${teamRoleIds.join(', ')}). This needs manual resolution before registration can continue.`
    );
    return;
  }

  if (teamRoleIds.length === 1) {
    await startExistingTeamFlow(thread, member, teamRoleIds[0]);
    return;
  }

  await startNoTeamRoleFlow(thread, member);
}

async function startNoTeamRoleFlow(thread, member) {
  sessions.create(thread.id, { sessionOwnerId: member.id, isNewTeam: true });

  const historicalMatch = await findHistoricalTeamMatch(thread, member);
  if (historicalMatch) {
    sessions.update(thread.id, { pendingHistoricalTeam: historicalMatch });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('reg:history_team:yes')
        .setLabel(`Yes, sign up ${historicalMatch.team_name} again`.slice(0, 80))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('reg:history_team:no').setLabel("No, that's not my team").setStyle(ButtonStyle.Secondary)
    );

    await thread.send({
      content:
        `${member}, a Discord role you hold matches **${historicalMatch.team_name}** in the Team Database - ` +
        `a team that's signed up before. Sign that team up again for this event?`,
      components: [row],
    });
    return;
  }

  await promptNewOrJoin(thread, member);
}

/** The plain "new team or join existing" prompt - used when there's no Team Database match, or the captain says that match isn't them. */
async function promptNewOrJoin(thread, member) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reg:new_team').setLabel('Register New Team').setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('reg:join_existing')
      .setLabel('Join an Existing Team')
      .setStyle(ButtonStyle.Secondary)
  );

  await thread.send({
    content:
      `${member}, are you registering a **brand new team**, or joining a team that already exists?\n\n` +
      `Joining an existing team requires staff confirmation, since only current team members can self-edit a roster.`,
    components: [row],
  });
}

/**
 * Looks for a Team Database match via the captain's Discord roles: checks
 * every role ID they hold against TeamDB's team_id column - team_id is the
 * Discord role snowflake itself (see Code.gs), so this is an exact ID
 * match, not a name/text match. Only catches captains who still hold the
 * actual role from a prior event (e.g. a leftover role that never got
 * re-registered as a Teams row this event) - if that role was deleted,
 * there's nothing to match against.
 *
 * Returns the matched TeamDB row, or null if there's no match or more than
 * one distinct match (staff gets pinged for the latter rather than guessing
 * which team is meant).
 */
async function findHistoricalTeamMatch(thread, member) {
  const candidateRoleIds = [...member.roles.cache.keys()];
  if (candidateRoleIds.length === 0) return null;

  const matches = await teamDB.findTeamsByRoleIds(candidateRoleIds);
  if (matches.length === 0) return null;

  if (matches.length > 1) {
    await pingStaff(
      thread,
      `${member} holds Discord role(s) matching multiple Team Database entries (${matches.map((m) => m.team_name).join(', ')}). Needs manual resolution before a historical signup can be offered.`
    );
    return null;
  }

  return matches[0];
}

/**
 * Resolves a TeamDB row into roster entries ready to drop into a session:
 * each slot's Steam ID gets normalized (steam.js handles Steam64/vanity/
 * profile URL/etc.) and looked up on statlocker.gg for a current username,
 * then enriched with whatever Player Database has on file (Best Name,
 * Discord ID) and whatever this bot's own PlayerRegistry has on file
 * (nationality, if this player registered through the bot before).
 * Slots that fail to resolve are skipped and reported back in `failures`
 * rather than aborting the whole preload over one bad entry.
 */
async function buildRosterFromTeamDB(teamRow) {
  const slots = teamDB.rosterFromTeamRow(teamRow);
  const roster = [];
  const failures = [];
  const duplicates = [];

  await Promise.all(
    slots.map(async (slot) => {
      try {
        const { accountId } = await steamService.resolveSteamId(slot.steamIdRaw);

        // Cross-team check, same reasoning as the manual add-slot flow -
        // done before the statlocker.gg call (network cost) since a hit
        // here means this slot gets skipped entirely, not added.
        // teamRow.team_role_id is this same team's own role, so re-adding a
        // player already on THIS team's live roster doesn't trip it.
        const conflictingTeam = await teams.findTeamContainingAccountId(accountId);
        if (conflictingTeam && conflictingTeam.team_role_id !== teamRow.team_role_id) {
          const history = await playerDB.getPlayerRecord(accountId);
          const name = (history && history.bestName) || slot.steamIdRaw;
          duplicates.push(`**${name}** has already been registered for **${conflictingTeam.team_name}** - they won't be included in your roster.`);
          return;
        }

        const lookup = await statlocker.lookupPlayer(accountId);
        const history = await playerDB.getPlayerRecord(accountId);
        const registryRow = await registry.getPlayerByAccountId(accountId);

        roster.push({
          accountId,
          slotType: slot.slotType,
          statlockerUsername: lookup.username,
          displayName: (history && history.bestName) || (registryRow && registryRow.display_name) || '',
          nationality: (registryRow && registryRow.nationality) || (history && history.nationality) || '',
          discordId: (history && history.discordId) || '',
          status: 'new',
        });
      } catch (err) {
        failures.push(`${slot.steamIdRaw} (${err.message})`);
      }
    })
  );

  // Promise.all resolution order isn't guaranteed - resort so mains show
  // before subs/coaches regardless of which lookup finished first, and
  // drop any duplicate account IDs (keeping the first) in case TeamDB has
  // the same player entered twice across its columns by mistake.
  const seen = new Set();
  return {
    roster: roster
      .sort((a, b) => (a.slotType === SLOT_TYPE.MAIN ? 0 : 1) - (b.slotType === SLOT_TYPE.MAIN ? 0 : 1))
      .filter((r) => (seen.has(r.accountId) ? false : (seen.add(r.accountId), true))),
    failures,
    duplicates,
  };
}

/**
 * Name-based counterpart to findHistoricalTeamMatch: for a captain with no
 * team role at all, checks the team name they just typed against TeamDB.
 * Unlike the role-based match, holding no role means this is a claim, not
 * proof - so a match here only offers to preload the roster, it never
 * skips the staff-approval gate (see handleHistoryNameYes / the
 * !session.teamRoleId check in commitRegistration).
 */
async function findHistoricalTeamMatchByName(thread, teamName) {
  const matches = await teamDB.findTeamsByName(teamName);
  if (matches.length === 0) return null;

  if (matches.length > 1) {
    await pingStaff(
      thread,
      `Team name "${teamName}" matches multiple Team Database entries. Not offering a historical re-registration for it - if this is a legitimate team, they'll need to register fresh and you can fix the roster manually.`
    );
    return null;
  }

  return matches[0];
}

async function handleHistoryNameYes(interaction, session) {
  const thread = interaction.channel;
  const teamRow = session.pendingHistoricalTeamByName;

  if (!teamRow) {
    await interaction.update({ content: 'That historical match expired - continuing with a fresh registration.', components: [] });
    await renderControlPanel(thread);
    return;
  }

  await interaction.update({ content: `Loading **${teamRow.team_name}**'s last roster...`, components: [] });

  const { roster, failures, duplicates } = await buildRosterFromTeamDB(teamRow);

  // Deliberately NOT setting teamRoleId here - this captain hasn't proven
  // they're actually this team, so it still has to go through the normal
  // staff-approval-for-no-role path in commitRegistration. Stashing the old
  // role ID separately lets commitRegistration reuse that role
  // (rather than creating a duplicate) if staff approve and it still exists.
  sessions.update(thread.id, {
    roster,
    logoUrl: teamRow.logo_url || null,
    vcChannelId: teamRow.vc_channel_id || null,
    historicalTeamRoleId: teamRow.team_role_id || null,
    pendingHistoricalTeamByName: null,
  });

  if (failures.length) {
    await pingStaff(
      thread,
      `Couldn't preload ${failures.length} player(s) from Team Database for **${teamRow.team_name}**: ${failures.join('; ')}. Add them manually via Add Player.`
    );
  }

  if (duplicates.length) {
    await thread.send({
      content: `${duplicates.join('\n')}\nPlease contact ${config.discord.staffMention} if you believe any of them should be on your team.`,
      allowedMentions: { roles: config.discord.staffRoleIds },
    });
  }

  await thread.send({
    content: `Preloaded ${roster.length} player(s) from **${teamRow.team_name}**'s last tournament. This still needs staff approval since you don't currently hold that team's role - please update the roster if any players have changed, then Finish.`,
  });
  await renderControlPanel(thread);
}

async function handleHistoryNameNo(interaction, session) {
  const thread = interaction.channel;
  sessions.update(thread.id, { pendingHistoricalTeamByName: null });
  await interaction.update({ content: "No problem - let's set up your roster from scratch.", components: [] });
  await renderControlPanel(thread);
}

async function handleHistoryTeamYes(interaction, session) {
  const thread = interaction.channel;
  const teamRow = session.pendingHistoricalTeam;

  if (!teamRow) {
    await interaction.update({ content: "That historical match expired - let's start fresh.", components: [] });
    await promptNewOrJoin(thread, interaction.member);
    return;
  }

  await interaction.update({ content: `Loading **${teamRow.team_name}**'s last roster...`, components: [] });

  const { roster, failures, duplicates } = await buildRosterFromTeamDB(teamRow);

  // team_id is the Discord role snowflake itself, and the captain already
  // holds it (that's how this match was found) - so there's no role to
  // create and no staff-approval gate needed, unlike a genuinely brand new
  // team. This commits the same way as editing any other existing team.
  sessions.update(thread.id, {
    teamName: teamRow.team_name,
    teamRoleId: teamRow.team_role_id,
    isNewTeam: false,
    roster,
    logoUrl: teamRow.logo_url || null,
    vcChannelId: teamRow.vc_channel_id || null,
    pendingHistoricalTeam: null,
  });

  if (failures.length) {
    await pingStaff(
      thread,
      `Couldn't preload ${failures.length} player(s) from Team Database for **${teamRow.team_name}**: ${failures.join('; ')}. Add them manually via Add Player.`
    );
  }

  if (duplicates.length) {
    await thread.send({
      content: `${duplicates.join('\n')}\nPlease contact ${config.discord.staffMention} if you believe any of them should be on your team.`,
      allowedMentions: { roles: config.discord.staffRoleIds },
    });
  }

  await thread.send({
    content: `Preloaded ${roster.length} player(s) from **${teamRow.team_name}**'s last tournament. Please update if any players have changed.`,
  });
  await renderControlPanel(thread);
}

/**
 * Declining a Team Database historical match means this role isn't wanted
 * either - same reasoning as handleLeaveAndRegisterNew (the currently-active
 * team equivalent of this same choice): drop the stale Discord role rather
 * than leaving the captain stuck holding a role for a team they just said
 * isn't theirs. The Team Database record itself isn't touched.
 */
async function handleHistoryTeamNo(interaction, session) {
  const thread = interaction.channel;
  const teamRow = session.pendingHistoricalTeam;

  if (teamRow && teamRow.team_role_id) {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (member) {
      await member.roles.remove(teamRow.team_role_id, 'Captain declined a Team Database historical-team match').catch(() => {});
    }
  }

  sessions.update(thread.id, { pendingHistoricalTeam: null });
  await interaction.update({ content: "No problem - dropped that old role, let's set up a new registration.", components: [] });
  await promptNewOrJoin(thread, interaction.member);
}

async function startExistingTeamFlow(thread, member, teamRoleId) {
  // Kick off the Sheets fetch immediately, before we even know what the
  // captain wants to do - most of the latency here is the Apps Script HTTP
  // round trip, so overlapping it with Discord's own round trip + however
  // long the captain takes to click a button is close to free.
  const fetchPromise = loadTeamData(teamRoleId);
  pendingTeamDataFetches.set(thread.id, fetchPromise);

  const role = await thread.guild.roles.fetch(teamRoleId).catch(() => null);
  const placeholderName = role ? role.name : 'your team';

  sessions.create(thread.id, {
    sessionOwnerId: member.id,
    teamRoleId,
    teamName: placeholderName,
    isNewTeam: false,
    roster: [],
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reg:continue_existing').setLabel('Edit Team').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('reg:leave_and_register_new').setLabel("I'm Not On This Team").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('reg:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );

  await thread.send({
    content: `${member}, you have already been signed up to play for **${placeholderName}**. Do you want to edit your team roster? Or are you not on this team?`,
    components: [row],
  });
}

/**
 * Fetches a team's row + full roster for the panel. The roster (which
 * account_ids are on the team, and as what slot type) comes straight off
 * the Teams row itself (see teams.rosterFromTeamRow) rather than a
 * PlayerRegistry scan; PlayerRegistry is only consulted afterward to
 * enrich each account_id with display info (name, Discord link,
 * nationality) - one bulk fetch (getPlayersMap) rather than one lookup per
 * slot.
 */
async function loadTeamData(teamRoleId) {
  const team = await teams.getTeamByRoleId(teamRoleId);
  if (!team) return { team: null, roster: [] };

  const slots = teams.rosterFromTeamRow(team);
  const playersMap = await registry.getPlayersMap();
  const roster = slots.map(({ accountId, slotType }) => {
    const player = playersMap.get(accountId);
    return {
      accountId,
      slotType,
      statlockerUsername: player ? player.statlocker_username : '',
      displayName: (player && player.display_name) || '',
      discordId: (player && player.discord_id) || '',
      nationality: (player && player.nationality) || '',
      status: 'keep',
    };
  });
  return { team, roster };
}

async function handleContinueExisting(interaction, session) {
  const thread = interaction.channel;
  await interaction.update({ content: 'Loading roster...', components: [] });

  const pending = pendingTeamDataFetches.get(thread.id);
  pendingTeamDataFetches.delete(thread.id);
  const { team, roster } = pending ? await pending : await loadTeamData(session.teamRoleId);

  if (!team) {
    await pingStaff(
      thread,
      `${interaction.user} holds team role <@&${session.teamRoleId}> but no matching Teams row exists in the sheet. Needs manual resolution.`,
      [interaction.user.id]
    );
    return;
  }

  sessions.update(thread.id, {
    teamName: team.team_name,
    roster,
    logoUrl: team.logo_url || null,
    vcChannelId: team.vc_channel_id || null,
  });
  await renderControlPanel(thread);
}

/**
 * Decouples this player from the old team entirely and starts a brand new,
 * independent team - same path as someone who held no team role at all.
 * Leaving is a Discord-role action only, scoped to whoever clicked this
 * button (interaction.user) - NOT session.sessionOwnerId, which is just
 * whoever started this particular editing thread and may not be the same
 * person for every team member.
 * The old team's roster/Sheet data isn't touched here at all, since that
 * team continues to exist for whoever else is on it.
 */
async function handleLeaveAndRegisterNew(interaction, session) {
  const thread = interaction.channel;
  // Don't need the old team's data for this path - let the in-flight fetch
  // resolve and get garbage collected rather than awaiting it.
  pendingTeamDataFetches.delete(thread.id);

  const oldTeamRoleId = session.teamRoleId;
  const oldTeamName = session.teamName;

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (member && oldTeamRoleId) {
    await member.roles.remove(oldTeamRoleId, 'Captain leaving to register a separate new team').catch(() => {});
  }

  sessions.update(thread.id, {
    teamRoleId: null,
    teamName: null,
    isNewTeam: true,
    roster: [],
  });

  await interaction.update({
    content:
      `Left **${oldTeamName}** (that team's roster is untouched). Starting a brand new team registration - ` +
      `use **Add Player** below, then set a **Team Name**.`,
    components: [],
  });
  await renderControlPanel(thread);
}

// ---------------------------------------------------------------------------
// Control panel (roster summary + action buttons), re-rendered after each change
// ---------------------------------------------------------------------------

async function renderControlPanel(thread) {
  const session = sessions.get(thread.id);
  if (!session) return;

  const visibleRoster = session.roster.filter((r) => r.status !== 'discard');
  const lines = visibleRoster.length
    ? visibleRoster.map((r) => {
        const natText = r.nationality ? ` [${formatNationality(r.nationality)}]` : ' ⚠️ _missing nationality_';
        return `${STATUS_ICON[r.status] || ''} **${r.displayName || r.statlockerUsername}**${natText} - ${r.slotType}`;
      })
    : ['_No players added yet._'];

  const mains = visibleRoster.filter((r) => r.slotType === SLOT_TYPE.MAIN).length;
  const subs = visibleRoster.filter((r) => r.slotType === SLOT_TYPE.SUB || r.slotType === SLOT_TYPE.COACH).length;
  const missingNationality = visibleRoster.filter((r) => !r.nationality);

  const embed = new EmbedBuilder()
    .setTitle(session.isNewTeam ? 'New Team Registration' : `Editing: ${session.teamName}`)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: 'Main players', value: `${mains} / ${config.roster.maxMain} max`, inline: true },
      { name: 'Subs/Coaches', value: `${subs} / ${config.roster.maxSubs} max`, inline: true }
    )
    .setColor(missingNationality.length ? 0xed4245 : 0x5865f2);
  if (missingNationality.length) {
    embed.addFields({
      name: '⚠️ Missing info',
      value: `${missingNationality.length} player(s) still need a nationality set before registration can finish: ${missingNationality
        .map((r) => r.displayName || r.statlockerUsername)
        .join(', ')}`,
    });
  }
  if (session.pendingLogoUpload) embed.setThumbnail(session.pendingLogoUpload.discordUrl);
  else if (session.logoUrl) embed.setThumbnail(session.logoUrl);

  const modifiableSlots = session.roster.filter((r) => r.status !== 'discard');
  const components = [];

  if (modifiableSlots.length > 0) {
    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('reg:select:modify_slot')
        .setPlaceholder('Select a player to rename/remove')
        .addOptions(
          modifiableSlots.slice(0, 25).map((r, i) => ({
            label: r.statlockerUsername,
            description: r.slotType,
            value: String(session.roster.indexOf(r)),
          }))
        )
    );
    components.push(selectRow);
  }

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reg:add_slot').setLabel('Add Player').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('reg:rename_team').setLabel('Team Name').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('reg:team_logo')
      .setLabel(session.logoUrl || session.pendingLogoUpload ? 'Change Logo' : 'Team Logo')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('reg:finish').setLabel('Finish Registration').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('reg:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
  );
  components.push(buttonRow);

  // Repost at the bottom rather than editing in place, so the panel is
  // always the last message in the thread - no scrolling back up past
  // whatever flow messages (nationality prompts, "Added X", etc.) landed
  // after the previous panel.
  if (session.panelMessageId) {
    const oldMsg = await thread.messages.fetch(session.panelMessageId).catch(() => null);
    if (oldMsg) {
      await oldMsg.delete().catch(async () => {
        // Fall back to stripping components if delete isn't possible for
        // some reason, so the stale panel at least can't be clicked.
        await oldMsg.edit({ components: [] }).catch(() => {});
      });
    }
  }

  const sent = await thread.send({ embeds: [embed], components });
  sessions.update(thread.id, { panelMessageId: sent.id });
}

// ---------------------------------------------------------------------------
// Button / select menu router
// ---------------------------------------------------------------------------

// customIds that only make sense mid-way through adding/editing a single
// roster slot - see the pendingSlot guard in handleComponent below.
const PENDING_SLOT_REQUIRED_IDS = new Set([
  'reg:select:slot_type',
  'reg:select:slot_only',
  'reg:name:keep',
  'reg:name:use_history',
  'reg:name:custom',
  'reg:linkage:history',
  'reg:linkage:user',
  'reg:linkage:skip',
  'reg:retry_nationality',
  'reg:continue_nationality',
]);

async function handleComponent(interaction) {
  const thread = interaction.channel;
  const session = sessions.get(thread.id);

  if (!session) {
    await interaction.reply({ content: 'This registration session has expired. Run /register again.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== session.sessionOwnerId) {
    await interaction.reply({ content: 'Only the person who started this registration can use these controls.', flags: MessageFlags.Ephemeral });
    return;
  }

  const id = interaction.customId;
  auditLog.record(interaction.user.id, interaction.user.tag, id, {
    threadId: thread.id,
    teamName: session.teamName,
  });

  // These all continue an in-progress "add/edit a player" sequence and
  // read session.pendingSlot without a null check further down. pendingSlot
  // is set to null the moment a slot is finalized (see applyPendingSlotLinkage)
  // - so a stale button from a step that's already been completed (double
  // tap, or an old ephemeral message re-clicked after the flow moved on)
  // would otherwise crash with "Cannot read properties of null" deep inside
  // one of these handlers. Catch it here instead, once, with a message that
  // tells the captain what to do next.
  if (PENDING_SLOT_REQUIRED_IDS.has(id) && !session.pendingSlot) {
    await interaction.reply({
      content: "That step isn't active anymore (this player was already added, or the flow restarted). Use **Add Player** to continue.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (id === 'reg:history_team:yes') return handleHistoryTeamYes(interaction, session);
  if (id === 'reg:history_team:no') return handleHistoryTeamNo(interaction, session);
  if (id === 'reg:history_name:yes') return handleHistoryNameYes(interaction, session);
  if (id === 'reg:history_name:no') return handleHistoryNameNo(interaction, session);
  if (id === 'reg:new_team') return handleNewTeam(interaction, session);
  if (id === 'reg:continue_existing') return handleContinueExisting(interaction, session);
  if (id === 'reg:leave_and_register_new') return handleLeaveAndRegisterNew(interaction, session);
  if (id === 'reg:join_existing') return handleJoinExisting(interaction, session);
  if (id === 'reg:add_slot') return promptAddSlot(interaction);
  if (id === 'reg:rename_team') return promptRenameTeam(interaction);
  if (id === 'reg:team_logo') return promptTeamLogo(interaction, session);
  if (id === 'reg:finish') return commitRegistration(interaction, session);
  if (id === 'reg:cancel') return cancelRegistration(interaction, session);
  if (id === 'reg:select:modify_slot') return handleModifySlotSelect(interaction, session);
  if (id.startsWith('reg:slotaction:')) return handleSlotAction(interaction, session, id);
  if (id === 'reg:select:slot_type') return handleSlotTypeSelect(interaction, session);
  if (id === 'reg:select:slot_only') return handleSlotOnlySelect(interaction, session);
  if (id === 'reg:name:keep') return handleKeepName(interaction, session);
  if (id === 'reg:name:use_history') return handleUseHistoricalName(interaction, session);
  if (id === 'reg:name:custom') return promptCustomDisplayName(interaction, session);
  if (id === 'reg:linkage:history') {
    return finalizePendingSlot(interaction, session, {
      discordId: session.pendingSlot.historyMemberId,
    });
  }
  if (id === 'reg:linkage:user') return promptSelectDiscordUser(interaction, session);
  if (id === 'reg:linkage:skip') return finalizePendingSlot(interaction, session, { discordId: '' });
  if (id === 'reg:retry_nationality') return showNationalityModal(interaction, '');
  if (id === 'reg:continue_nationality') return showNationalityModal(interaction, '');
  if (id === 'reg:retry_discord_user') return promptSelectDiscordUser(interaction, session);

  await interaction.reply({ content: `Unhandled action: ${id}`, flags: MessageFlags.Ephemeral });
}

async function handleNewTeam(interaction, session) {
  // showModal() must be the first response to this interaction, so we can't
  // interaction.update() first - the modal submit handler renders the panel.
  await promptRenameTeam(interaction);
}

async function handleJoinExisting(interaction, session) {
  await interaction.update({ content: 'Request sent to staff - Please tell them which team you are on.', components: [] });
  await pingStaff(
    interaction.channel,
    `${interaction.user} wants to join an existing team but holds no team role. Please confirm which team, then either have a current team member add them via /register, or grant them the team role directly.`
  );
}

// ---------------------------------------------------------------------------
// Team name modal
// ---------------------------------------------------------------------------

async function promptRenameTeam(interaction) {
  const modal = new ModalBuilder().setCustomId('reg:modal:team_name').setTitle('Team Name');
  const input = new TextInputBuilder()
    .setCustomId('team_name')
    .setLabel('Team name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// Team logo: Discord modals can't take file inputs, so this is a plain
// message-attachment upload instead of a modal - see handleMessage below,
// wired up from index.js's messageCreate.
// ---------------------------------------------------------------------------

const PNG_EXTENSION = /\.png$/i;
const ANY_IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

function isPngAttachment(attachment) {
  if (attachment.contentType && attachment.contentType === 'image/png') return true;
  // contentType isn't always set (depends on client/upload path) - fall back
  // to the filename extension rather than rejecting outright.
  return PNG_EXTENSION.test(attachment.name || '');
}

function isAnyImageAttachment(attachment) {
  if (attachment.contentType && attachment.contentType.startsWith('image/')) return true;
  return ANY_IMAGE_EXTENSION.test(attachment.name || '');
}

async function promptTeamLogo(interaction, session) {
  sessions.update(interaction.channel.id, { awaitingLogo: true });
  await interaction.reply({
    content:
      'Please post your team logo in this chat as a PNG. Make sure the ratio is 1:1 (square) so it looks nice ' +
      "on the broadcast. We'd also request that logos not be sexually explicit or AI generated.",
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Called from index.js on every message the bot can see. Almost always a
 * no-op - only does anything when the message lands in a thread that has an
 * active session currently awaiting a logo upload, from the person who
 * clicked Team Logo. Everything else (other threads, other users, messages
 * with no session, non-image attachments) is ignored rather than replied to,
 * since this fires on every message in the server and most of them have
 * nothing to do with registration.
 *
 * Deliberately doesn't touch Nextcloud here - just remembers where the
 * attachment lives (messageId + a Discord link for preview purposes). The
 * actual upload happens once at commit time (see resolveLogoUrl), once the
 * final team name is locked in and it's clear the captain is actually
 * finishing rather than clicking through several logos first.
 */
async function handleMessage(message) {
  if (message.author.bot) return;
  const thread = message.channel;
  const session = sessions.get(thread.id);
  if (!session || !session.awaitingLogo) return;
  if (message.author.id !== session.sessionOwnerId) return;

  const attachment = message.attachments.first();

  if (attachment && isPngAttachment(attachment)) {
    // Both contentType and the filename extension are client-supplied and
    // spoofable - confirm this is really a PNG (and a reasonable size)
    // before trusting it, rather than only at commit time when the
    // captain has moved on and a bad file would be a surprise.
    try {
      assertSizeWithinLimit(attachment);
    } catch (err) {
      await thread.send({ content: `${message.author}, ${err.message}`, allowedMentions: { users: [message.author.id] } });
      return;
    }

    let buffer;
    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Discord returned HTTP ${res.status} fetching that attachment.`);
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      await thread.send({
        content: `${message.author}, couldn't download that attachment to check it (${err.message}). Please try uploading again.`,
        allowedMentions: { users: [message.author.id] },
      });
      return;
    }

    if (detectImageType(buffer) !== 'png') {
      await thread.send({
        content: `${message.author}, that file's contents don't actually match a PNG image (even though it's named/tagged as one). Please re-export it as a real PNG and try again.`,
        allowedMentions: { users: [message.author.id] },
      });
      return;
    }

    try {
      assertImageDimensionsWithinLimit(buffer, 'png');
    } catch (err) {
      await thread.send({ content: `${message.author}, ${err.message}`, allowedMentions: { users: [message.author.id] } });
      return;
    }

    sessions.update(thread.id, {
      pendingLogoUpload: { messageId: message.id, discordUrl: attachment.url, filename: attachment.name || '' },
      pendingLogoWarning: null,
      awaitingLogo: false,
    });
    auditLog.record(message.author.id, message.author.tag, 'logo.upload', {
      threadId: thread.id,
      teamName: session.teamName,
      filename: attachment.name || '',
    });
    await message.react('✅').catch(() => {});
    await thread.send({ content: `${message.author}, logo saved.`, allowedMentions: { users: [message.author.id] } });
    await renderControlPanel(thread);
    return;
  }

  // Already warned once about a non-PNG image: whatever they send next
  // (a reupload of the same file, a different non-PNG image, or just a
  // reply) is treated as "fine, use the format I warned about" - go ahead
  // and accept the image from the warning message rather than this one.
  if (session.pendingLogoWarning) {
    const warned = session.pendingLogoWarning;
    sessions.update(thread.id, {
      pendingLogoUpload: { messageId: warned.messageId, discordUrl: warned.discordUrl, filename: warned.filename },
      pendingLogoWarning: null,
      awaitingLogo: false,
    });
    await thread.send({
      content:
        `${message.author}, I've stored the image in the bad file format, but please get the correct format ` +
        'to make production\'s life easier. You can always come back and edit your roster later.',
      allowedMentions: { users: [message.author.id] },
    });
    await renderControlPanel(thread);
    return;
  }

  if (attachment && isAnyImageAttachment(attachment)) {
    try {
      assertSizeWithinLimit(attachment);
    } catch (err) {
      await thread.send({ content: `${message.author}, ${err.message}`, allowedMentions: { users: [message.author.id] } });
      return;
    }

    let buffer;
    try {
      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Discord returned HTTP ${res.status} fetching that attachment.`);
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      await thread.send({
        content: `${message.author}, couldn't download that attachment to check it (${err.message}). Please try uploading again.`,
        allowedMentions: { users: [message.author.id] },
      });
      return;
    }

    const type = detectImageType(buffer);
    if (!type) {
      await thread.send({
        content: `${message.author}, that doesn't look right. Please try again with your logo saved as PNG.`,
        allowedMentions: { users: [message.author.id] },
      });
      return;
    }

    try {
      assertImageDimensionsWithinLimit(buffer, type);
    } catch (err) {
      await thread.send({ content: `${message.author}, ${err.message}`, allowedMentions: { users: [message.author.id] } });
      return;
    }

    sessions.update(thread.id, {
      pendingLogoWarning: { messageId: message.id, discordUrl: attachment.url, filename: attachment.name || '' },
    });
    await thread.send({
      content: `${message.author}, I can see that image, but it's not in the PNG format. Please convert it and reupload so that staff don't have to.`,
      allowedMentions: { users: [message.author.id] },
    });
    return;
  }

  await thread.send({
    content: `${message.author}, that doesn't look right. Please try again with your logo saved as PNG.`,
    allowedMentions: { users: [message.author.id] },
  });
}

// Builds the on-disk logo filename from a team name. Keeps spaces (matches
// how the name actually appears on broadcast, per production's request)
// rather than converting them to dashes - safe to do because every place
// this filename ends up in a URL (see services/nextcloud.js) already runs
// it through encodeURIComponent. Still strips characters that are illegal
// in a Windows/Nextcloud filename (< > : " / \ | ? *) and collapses/trims
// whitespace, so a team name with punctuation can't produce a broken or
// unexpectedly-nested path.
function slugifyTeamName(teamName) {
  return (
    (teamName || 'team')
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'team'
  );
}

/**
 * Also guarantees at most one logo file per team on Nextcloud,
 * named after the team's current name - broadcast relies on that filename
 * as the single source of truth. Resolves whatever the session currently
 * knows about a logo into the final URL to persist - called once from
 * performCommit, not on every panel render. Kept in sync on every commit,
 * new upload or not:
 *  - a pending upload with Nextcloud configured: re-fetch the message (its
 *    attachment URL is refreshed on every fetch, unlike the one captured at
 *    upload time, which may be stale by commit time) and push it to the
 *    share under a name built from the now-final team name. If that lands
 *    under a different filename than whatever was there before (team
 *    renamed, or the new file has a different extension), the old file is
 *    deleted so it doesn't linger as an orphan.
 *  - no pending upload, but the team was renamed and its existing logo
 *    lives on Nextcloud under the old name: rename that file in place
 *    (WebDAV MOVE, no re-upload needed) so the filename still matches.
 *  - no pending upload and nothing needs renaming: keep whatever logo_url
 *    is already on record (e.g. unchanged while editing an existing team,
 *    or none set at all).
 *  - Nextcloud isn't configured at all: just use the Discord link, same as
 *    this feature's very first version - no dedupe/rename possible without
 *    a file server to do it on.
 */
async function resolveLogoUrl(thread, session) {
  const pending = session.pendingLogoUpload;

  if (!nextcloud.isConfigured()) {
    return pending ? pending.discordUrl : session.logoUrl || '';
  }

  const oldFilename = nextcloud.filenameFromShareUrl(session.logoUrl);

  if (pending) {
    try {
      const message = await thread.messages.fetch(pending.messageId);
      const attachment = message.attachments.first();
      if (!attachment) throw new Error('The original logo message no longer has an attachment.');
      // Only size is re-checked here, not detectImageType/assertImageDimensionsWithinLimit -
      // both already ran against this exact attachment in handleMessage at upload time.
      // Safe to skip re-running them because a Discord attachment's bytes are immutable
      // for the life of its message/attachment ID (the URL can't be pointed at different
      // content later), so this re-fetch is guaranteed to return the same buffer that was
      // already sniffed and dimension-checked. If that ever stops being true - e.g. this
      // fetch is changed to pull from somewhere other than the original Discord attachment -
      // those checks need to come back too.
      assertSizeWithinLimit(attachment);

      const res = await fetch(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Fetching the attachment from Discord failed (${res.status}).`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const extMatch = /\.(png|jpe?g|gif|webp)$/i.exec(attachment.name || pending.filename || '');
      const ext = extMatch ? extMatch[0].toLowerCase() : '.png';
      const newFilename = `${slugifyTeamName(session.teamName)}${ext}`;

      const url = await nextcloud.uploadToShare(newFilename, buffer);

      if (oldFilename && oldFilename !== newFilename) {
        await nextcloud.deleteFromShare(oldFilename).catch((err) => {
          console.error(
            `[registrationFlow] Failed to clean up old logo file "${oldFilename}" for ${session.teamName}: ${err.message}`
          );
        });
      }

      return url;
    } catch (err) {
      console.error(`[registrationFlow] Nextcloud logo upload failed at commit, falling back to the Discord link (thread ${thread.id}, team "${session.teamName}"): ${err.message}`);
      await pingStaff(
        thread,
        `Logo upload to the file server failed for **${session.teamName}** (using the Discord link instead, which will eventually expire): ${err.message}\n` +
          `If this keeps happening, upload the file to the file server manually and update the Teams sheet's logo_url column for this team.`
      ).catch(() => {});
      return pending.discordUrl;
    }
  }

  // No new upload this commit - if the team was renamed and its logo lives
  // on Nextcloud, rename the file in place so it still matches.
  if (!oldFilename) return session.logoUrl || '';

  const ext = (/\.[a-z0-9]+$/i.exec(oldFilename) || ['.png'])[0].toLowerCase();
  const newFilename = `${slugifyTeamName(session.teamName)}${ext}`;
  if (newFilename === oldFilename) return session.logoUrl;

  try {
    const renamed = await nextcloud.renameInShare(oldFilename, newFilename);
    return renamed ? nextcloud.previewUrl(newFilename) : session.logoUrl;
  } catch (err) {
    console.error(`[registrationFlow] Failed to rename logo file for renamed team "${session.teamName}" (thread ${thread.id}): ${err.message}`);
    await pingStaff(
      thread,
      `Couldn't rename **${session.teamName}**'s logo file to match its new name on the file server: ${err.message}\n` +
        `The old link still works, but you may want to rename it manually.`
    ).catch(() => {});
    return session.logoUrl;
  }
}

// ---------------------------------------------------------------------------
// Add / rename slot: Steam ID modal -> slot type select -> discord linkage
// ---------------------------------------------------------------------------

async function promptAddSlot(interaction, title = 'Add Player') {
  const modal = new ModalBuilder().setCustomId('reg:modal:add_slot').setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId('steam_id')
    .setLabel('Statlocker ID / Steam Friend Code')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleModalSubmit(interaction) {
  const thread = interaction.channel;
  const session = sessions.get(thread.id);
  if (!session) {
    await interaction.reply({ content: 'This registration session has expired. Run /register again.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== session.sessionOwnerId) {
    await interaction.reply({ content: 'Only the person who started this registration can use these controls.', flags: MessageFlags.Ephemeral });
    return;
  }

  auditLog.record(interaction.user.id, interaction.user.tag, interaction.customId, {
    threadId: thread.id,
    teamName: session.teamName,
  });

  // Same stale-step problem as PENDING_SLOT_REQUIRED_IDS in handleComponent -
  // these two modals only make sense mid-way through a pendingSlot.
  if (
    (interaction.customId === 'reg:modal:display_name' || interaction.customId === 'reg:modal:nationality') &&
    !session.pendingSlot
  ) {
    await interaction.reply({
      content: "That step isn't active anymore (this player was already added, or the flow restarted). Use **Add Player** to continue.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.customId === 'reg:modal:team_name') {
    const teamName = interaction.fields.getTextInputValue('team_name').trim();
    sessions.update(thread.id, { teamName });
    await interaction.reply({ content: `Team name set to **${teamName}**.`, flags: MessageFlags.Ephemeral });

    // Offer a historical re-registration by name only for a captain who
    // holds no team role and hasn't already built a roster - and only once
    // per session, so renaming later (reg:rename_team) doesn't re-trigger
    // this on every edit.
    const freshSession = sessions.get(thread.id);
    if (freshSession.isNewTeam && !freshSession.teamRoleId && !freshSession.historicalNameCheckDone && freshSession.roster.length === 0) {
      sessions.update(thread.id, { historicalNameCheckDone: true });
      const historicalMatch = await findHistoricalTeamMatchByName(thread, teamName);
      if (historicalMatch) {
        sessions.update(thread.id, { pendingHistoricalTeamByName: historicalMatch });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('reg:history_name:yes')
            .setLabel(`Yes, re-register ${historicalMatch.team_name}`.slice(0, 80))
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('reg:history_name:no').setLabel("No, this is a new team").setStyle(ButtonStyle.Secondary)
        );
        await thread.send({
          content:
            `**${historicalMatch.team_name}** matches a team in the Team Database, but you don't currently hold that team's Discord role. ` +
            `Preload that team's last roster? Staff will still need to approve before it's finalized.`,
          components: [row],
        });
        return;
      }
    }

    await renderControlPanel(thread);
    return;
  }

  if (interaction.customId.startsWith('reg:modal:rename_only:')) {
    const idx = parseInt(interaction.customId.split(':')[3], 10);
    const displayName = interaction.fields.getTextInputValue('display_name').trim();
    if (!displayName) {
      await interaction.reply({ content: 'Display name cannot be empty.', flags: MessageFlags.Ephemeral });
      return;
    }

    const roster = [...session.roster];
    const prevStatus = roster[idx].status;
    roster[idx] = { ...roster[idx], displayName, status: prevStatus === 'new' ? 'new' : 'renamed' };
    sessions.update(thread.id, { roster });

    await interaction.reply({ content: `Renamed to **${displayName}**.`, flags: MessageFlags.Ephemeral });
    await renderControlPanel(thread);
    return;
  }

  if (interaction.customId === 'reg:modal:display_name') {
    const displayName = interaction.fields.getTextInputValue('display_name').trim();
    if (!displayName) {
      await interaction.reply({ content: 'Display name cannot be empty.', flags: MessageFlags.Ephemeral });
      return;
    }

    sessions.update(thread.id, { pendingSlot: { ...session.pendingSlot, displayName } });
    // goToNationalityStep handles the modal-submit case itself (routes
    // through an intermediate button if it needs to open another modal -
    // see its doc comment for why).
    await goToNationalityStep(interaction, session);
    return;
  }

  if (interaction.customId === 'reg:modal:nationality') {
    const raw = interaction.fields.getTextInputValue('nationality').trim();
    const code = validateNationality(raw);
    if (!code) {
      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('reg:retry_nationality').setLabel('Try Again').setStyle(ButtonStyle.Primary)
      );
      await interaction.reply({
        content: `"${raw}" doesn't match a recognized country - use a full name, a 2-letter code (e.g. "Australia" or "AU"), or "None" to decline.`,
        components: [retryRow],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // "Nationality" edit-menu action (promptNationalityOnly) marks pendingSlot
    // this way so this finalizes the slot directly with its existing Discord
    // linkage untouched, instead of routing into proceedPastNationality's
    // Tag/Skip step (which is what this modal is normally a step toward,
    // during Add Player / Change Steam ID).
    if (session.pendingSlot && session.pendingSlot.nationalityOnly) {
      sessions.update(thread.id, { pendingSlot: { ...session.pendingSlot, nationality: code } });
      const result = applyPendingSlotLinkage(thread, { discordId: session.pendingSlot.discordId || '' });
      await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
      if (result.ok) await renderControlPanel(thread);
      return;
    }

    await proceedPastNationality(interaction, session, code);
    return;
  }

  if (interaction.customId === 'reg:modal:add_slot') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawInput = interaction.fields.getTextInputValue('steam_id').trim();

    let accountId;
    try {
      const resolved = await steamService.resolveSteamId(rawInput);
      accountId = resolved.accountId;
    } catch (err) {
      await interaction.editReply({ content: `Couldn't resolve that Steam ID: ${err.message}` });
      return;
    }

    const replaceIndex = (session.pendingSlot || {}).replaceIndex;
    const dupeIdx = session.roster.findIndex(
      (r, i) => r.status !== 'discard' && r.accountId === accountId && i !== replaceIndex
    );
    if (dupeIdx !== -1) {
      await interaction.editReply({
        content: `That player is already on this roster as **${session.roster[dupeIdx].displayName || session.roster[dupeIdx].statlockerUsername}** - a player can only be entered once.`,
      });
      return;
    }

    let lookup;
    try {
      lookup = await statlocker.lookupPlayer(accountId);
    } catch (err) {
      if (err instanceof StatlockerLookupError) {
        await interaction.editReply({ content: `statlocker.gg lookup failed: ${err.message}` });
      } else {
        await interaction.editReply({ content: `Unexpected error during statlocker lookup: ${err.message}` });
      }
      return;
    }

    // Cross-team check: is this player already rostered on a DIFFERENT
    // team? (session.teamRoleId is undefined for a brand new team being
    // registered for the first time, so this naturally checks against every
    // team in that case; for an existing team being edited, it excludes
    // that team itself so re-confirming a player already on this roster
    // doesn't trip it.) Checked against Teams (current, bot-owned roster
    // data), not TeamDB (that's past-season history, not a live conflict).
    const conflictingTeam = await teams.findTeamContainingAccountId(accountId);
    if (conflictingTeam && conflictingTeam.team_role_id !== session.teamRoleId) {
      // This used to just tell the captain to contact staff via a role
      // mention inside this same ephemeral reply - but an ephemeral message
      // is never visible to anyone except the captain who triggered it, so
      // that "ping" never actually reached staff. Now it does: a short
      // ephemeral reply closes out the captain's interaction, and a real
      // public pingStaff() puts the conflict in front of staff.
      await interaction.editReply({
        content: `**${lookup.username}** already exists on **${conflictingTeam.team_name}**. Staff have been notified to help sort this out.`,
      });
      await pingStaff(
        thread,
        `${interaction.user} tried to add **${lookup.username}** to this roster, but they're already on **${conflictingTeam.team_name}**. Needs a decision on which team they belong to.`
      );
      return;
    }

    // A player's own PlayerRegistry row is only ever pulled here after the
    // cross-team check above already confirmed this account isn't on any
    // live roster - so if a row already exists, it's someone who's played
    // before but isn't currently on a team. That's on-file data worth
    // surfacing, not silently discarding: this is folded into `history`
    // below the same way a PlayerDB match is, so the captain gets the same
    // import prompts (saved name, Discord link) regardless of which table
    // the data came from.
    const { player, flagged } = await registry.upsertPlayer(
      { accountId, statlockerUsername: lookup.username },
      { tournamentName: '', discordUserTag: interaction.user.tag }
    );

    if (flagged) {
      // Deliberately doesn't include the on-file name here - this posts into
      // the registration thread, which the captain (not just staff) can see.
      // The old/new name pair is already recorded in the Flags tab
      // (raiseFlag, above) for staff to review there.
      await pingStaff(
        thread,
        `Name mismatch for account ID ${accountId}: statlocker now reports **${lookup.username}**, which doesn't match what's on file. ` +
          `Using on-file name for this registration until reviewed. Flagged in the Flags tab for review.`
      );
    }

    // Player Database lookup (separate, read-only historical data - see
    // services/playerDB.js). Independent of the flagged name-mismatch check
    // above, and independent of whether this player has registered through
    // this bot before. Preferred over the PlayerRegistry fallback below when
    // both exist, since Best Name is staff-curated and worth surfacing over
    // the bot's own records.
    const dbHistory = await playerDB.getPlayerRecord(accountId);
    const registryHistory =
      player && (player.display_name || player.discord_id)
        ? { bestName: player.display_name || '', discordId: player.discord_id || '', nationality: player.nationality || '', pastIgns: '' }
        : null;
    const history = dbHistory || registryHistory;

    // Preserve replaceIndex if this add_slot submission is actually completing
    // a "rename/replace" action on an existing slot (see handleSlotAction).
    const priorPending = session.pendingSlot || {};
    sessions.update(thread.id, {
      pendingSlot: {
        replaceIndex: priorPending.replaceIndex,
        accountId,
        // Deliberately lookup.username (the live statlocker report), not
        // player.statlocker_username - when flagged, that's the old on-file
        // name kept authoritative for anti-impersonation purposes (see
        // registry.upsertPlayer's doc comment), which has no business being
        // shown to or editable by the captain as "the name" - it's an
        // internal identity-tracking detail, surfaced to staff via the flag
        // above, not something to hand this player's current teammate.
        statlockerUsername: lookup.username,
        nationality: player.nationality || (history && history.nationality) || '',
        // "Best Name" from the Player Database is only ever offered as a
        // one-click choice (see handleSlotTypeSelect/handleUseHistoricalName)
        // - never applied silently - per the user's decision that this one
        // field needs confirmation even though the rest of history preloads.
        suggestedDisplayName: (history && history.bestName) || '',
        historyDiscordId: history ? history.discordId : '',
      },
    });

    const selectRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('reg:select:slot_type')
        .setPlaceholder('Select role on team')
        .addOptions(
          { label: 'Starter', value: SLOT_TYPE.MAIN },
          { label: 'Sub', value: SLOT_TYPE.SUB },
          { label: 'Coach', value: SLOT_TYPE.COACH }
        )
    );

    let content = `Found **${lookup.username}**. What's their role on the team?`;
    if (dbHistory && dbHistory.pastIgns) {
      content += `\n📜 Player Database: past name(s) on file - ${dbHistory.pastIgns}`;
    }

    await interaction.editReply({
      content,
      components: [selectRow],
    });
  }
}

async function handleSlotTypeSelect(interaction, session) {
  const slotType = interaction.values[0];
  const pending = { ...session.pendingSlot, slotType };
  sessions.update(interaction.channel.id, { pendingSlot: pending });

  const hasHistoricalName =
    pending.suggestedDisplayName && pending.suggestedDisplayName !== pending.statlockerUsername;

  const buttons = [];
  if (hasHistoricalName) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('reg:name:use_history')
        .setLabel(`Use saved name: ${pending.suggestedDisplayName}`.slice(0, 80))
        .setStyle(ButtonStyle.Success)
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId('reg:name:keep')
      .setLabel(`Use Steam name ${pending.statlockerUsername}`.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
  );
  buttons.push(new ButtonBuilder().setCustomId('reg:name:custom').setLabel('Pick a different name').setStyle(ButtonStyle.Primary));

  await interaction.update({
    content:
      `Role set to **${slotType}**. Their statlocker name is **${pending.statlockerUsername}**` +
      (hasHistoricalName ? `, and we have **${pending.suggestedDisplayName}** on file from a previous registration` : '') +
      ' - choose which to use for the team roster, or set something custom. Their real statlocker.gg identity is ' +
      'still tracked underneath for rename detection either way.',
    components: [new ActionRowBuilder().addComponents(buttons)],
  });
}

async function handleKeepName(interaction, session) {
  await goToNationalityStep(interaction, session);
}

/** Applies the Player Database's "Best Name" as this slot's display name - only reachable via an explicit button click, never silently. */
async function handleUseHistoricalName(interaction, session) {
  sessions.update(interaction.channel.id, {
    pendingSlot: { ...session.pendingSlot, displayName: session.pendingSlot.suggestedDisplayName },
  });
  await goToNationalityStep(interaction, session);
}

/**
 * Nationality is already known (either this player registered through this
 * bot before - PlayerRegistry - or the Player Database's own nationality
 * column has it on file) often enough that asking every single time is just
 * friction. If pendingSlot.nationality is already set, skip the modal
 * entirely and go straight to the Discord-linkage step; only prompt when it
 * isn't known, exactly like before.
 *
 * Discord's API allows replying to a modal submission with another modal,
 * but discord.js doesn't expose that - ModalSubmitInteraction has no
 * showModal() method (unlike Button/SelectMenu/ChatInputCommand
 * interactions, which all do). Calling this straight from a modal submit
 * (e.g. after the "Set Custom Display Name" modal) would throw
 * "interaction.showModal is not a function". So when this is reached from a
 * modal submit and nationality still needs asking, show a one-click
 * "Continue" button first - that button click is a fresh interaction that
 * *can* open the modal.
 */
async function goToNationalityStep(interaction, session) {
  const known = session.pendingSlot.nationality;
  if (known) {
    await proceedPastNationality(interaction, session, known, { skipped: true });
    return;
  }
  if (interaction.isModalSubmit()) {
    const continueRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reg:continue_nationality').setLabel('Set Nationality').setStyle(ButtonStyle.Primary)
    );
    await interaction.reply({ content: "Next: this player's nationality.", components: [continueRow], flags: MessageFlags.Ephemeral });
    return;
  }
  await showNationalityModal(interaction, '');
}

/**
 * Shared by the three ways a nationality can get set: the modal submit
 * (reg:modal:nationality), or skipping the modal entirely in
 * goToNationalityStep because it was already known. Resolves the Discord
 * linkage suggestion and shows the Tag/Skip/Use-match buttons.
 */
async function proceedPastNationality(interaction, session, code, opts = {}) {
  const thread = interaction.channel;

  // Check the Discord ID the Player Database has on file for this player
  // against the current guild - only offer it as a linkage option if it
  // actually resolves to someone present in this server right now, rather
  // than guessing.
  let historyMember = null;
  if (session.pendingSlot.historyDiscordId) {
    historyMember = await interaction.guild.members.fetch(session.pendingSlot.historyDiscordId).catch(() => null);
  }

  sessions.update(thread.id, {
    pendingSlot: { ...session.pendingSlot, nationality: code, historyMemberId: historyMember ? historyMember.id : null },
  });

  const linkageButtons = [];
  if (historyMember) {
    linkageButtons.push(
      new ButtonBuilder()
        .setCustomId('reg:linkage:history')
        .setLabel(`Use ${historyMember.user.username} (on file)`.slice(0, 80))
        .setStyle(ButtonStyle.Success)
    );
  }
  linkageButtons.push(
    new ButtonBuilder().setCustomId('reg:linkage:user').setLabel('Tag Discord User (in server)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('reg:linkage:skip').setLabel('No Discord').setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content:
      `Nationality set to **${code}**${opts.skipped ? ' (already on file - skipped asking)' : ''}. Does this player have Discord?`,
    components: [new ActionRowBuilder().addComponents(linkageButtons)],
    flags: MessageFlags.Ephemeral,
  });
}

async function promptCustomDisplayName(interaction, session) {
  const modal = new ModalBuilder().setCustomId('reg:modal:display_name').setTitle('Custom Display Name');
  const input = new TextInputBuilder()
    .setCustomId('display_name')
    .setLabel('Player Name')
    .setStyle(TextInputStyle.Short)
    .setValue(session.pendingSlot.statlockerUsername || '')
    .setRequired(true)
    .setMaxLength(80);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function showNationalityModal(interaction, prefill) {
  const modal = new ModalBuilder().setCustomId('reg:modal:nationality').setTitle('Player Nationality');
  const input = new TextInputBuilder()
    .setCustomId('nationality')
    .setLabel('Country (eg South Africa or ZA), or None')
    .setPlaceholder('Type "None" if the player prefers not to disclose')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  if (prefill) input.setValue(prefill);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function promptSelectDiscordUser(interaction, session) {
  await requestPlayerMention(interaction, session);
}

/**
 * Rather than a component (dropdowns don't scale to large member lists, and
 * modal text fields don't get the live @mention popup - only the actual
 * message box does), ask the captain to just @ the player as a normal
 * message in the thread, and pick it up with a one-shot message collector.
 */
async function requestPlayerMention(interaction, session) {
  const thread = interaction.channel;

  await interaction.update({
    content: 'Send a message in this thread @-mentioning the player (just type "@" and pick them like normal). You have 5 minutes.',
    components: [],
  });

  const collector = thread.createMessageCollector({
    filter: (m) => m.author.id === session.sessionOwnerId && m.mentions.users.size > 0,
    max: 1,
    time: 5 * 60 * 1000,
  });

  collector.on('collect', async (message) => {
    const member = message.mentions.members?.first();
    await message.delete().catch(() => {});

    if (!member) {
      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('reg:retry_discord_user').setLabel('Try Again').setStyle(ButtonStyle.Primary)
      );
      await thread.send({
        content: "That mention didn't resolve to someone currently in this server. Try again.",
        components: [retryRow],
      });
      return;
    }

    await finalizePendingSlotFromMessage(thread, { discordId: member.id });
  });

  collector.on('end', (collected) => {
    if (collected.size === 0) {
      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('reg:retry_discord_user').setLabel('Try Again').setStyle(ButtonStyle.Primary)
      );
      thread
        .send({ content: "Didn't catch a mention in time. Try again when you're ready.", components: [retryRow] })
        .catch(() => {});
    }
  });
}

/** Shared core: applies a resolved discordId to the pending slot. */
function applyPendingSlotLinkage(thread, { discordId }) {
  const current = sessions.get(thread.id);
  const pending = current && current.pendingSlot;
  if (!pending) {
    return { ok: false, message: 'No pending player to finalize - something went out of sync. Try Add Player again.' };
  }

  const newRoster = [...current.roster];
  const replaceIdx = pending.replaceIndex;
  const entry = {
    accountId: pending.accountId,
    slotType: pending.slotType,
    statlockerUsername: pending.statlockerUsername,
    displayName: pending.displayName || '',
    nationality: pending.nationality || '',
    discordId,
    status: replaceIdx != null ? 'renamed' : 'new',
  };

  if (replaceIdx != null) {
    newRoster[replaceIdx] = entry;
  } else {
    newRoster.push(entry);
  }

  sessions.update(thread.id, { roster: newRoster, pendingSlot: null });
  const verb = replaceIdx != null ? 'Updated' : 'Added';
  return { ok: true, message: `${verb} **${entry.displayName || entry.statlockerUsername}**.` };
}

/** Used by the "Skip for now" button - a component interaction that hasn't responded yet. */
async function finalizePendingSlot(interaction, session, linkage) {
  const thread = interaction.channel;
  const result = applyPendingSlotLinkage(thread, linkage);
  await interaction.update({ content: result.message, components: [] });
  if (result.ok) await renderControlPanel(thread);
}

/** Used by the message-collector path above - no interaction to respond to. */
async function finalizePendingSlotFromMessage(thread, linkage) {
  const result = applyPendingSlotLinkage(thread, linkage);
  await thread.send({ content: result.message });
  if (result.ok) await renderControlPanel(thread);
}

// ---------------------------------------------------------------------------
// Keep / rename / discard on existing slots
// ---------------------------------------------------------------------------

async function handleModifySlotSelect(interaction, session) {
  const idx = parseInt(interaction.values[0], 10);
  const slot = session.roster[idx];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:keep`).setLabel('Keep').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:edit`).setLabel('Edit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:discard`).setLabel('Remove').setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({
    content: `**${slot.displayName || slot.statlockerUsername}** (${slot.slotType}) - what would you like to do?`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSlotAction(interaction, session, customId) {
  const [, , idxStr, action] = customId.split(':');
  const idx = parseInt(idxStr, 10);

  if (action === 'keep') {
    session.roster[idx].status = 'keep';
    await interaction.update({ content: `Kept **${session.roster[idx].displayName || session.roster[idx].statlockerUsername}**.`, components: [] });
    await renderControlPanel(interaction.channel);
    return;
  }

  if (action === 'discard') {
    session.roster[idx].status = 'discard';
    await interaction.update({ content: `Removed **${session.roster[idx].displayName || session.roster[idx].statlockerUsername}**.`, components: [] });
    await renderControlPanel(interaction.channel);
    return;
  }

  if (action === 'edit') {
    await promptEditMenu(interaction, idx);
    return;
  }

  if (action === 'rename') {
    await promptRenameOnly(interaction, session, idx);
    return;
  }

  if (action === 'change_id') {
    await promptChangeSteamId(interaction, session, idx);
    return;
  }

  if (action === 'tag_discord') {
    await promptTagDiscord(interaction, session, idx);
    return;
  }

  if (action === 'nationality') {
    await promptNationalityOnly(interaction, session, idx);
    return;
  }

  if (action === 'change_slot') {
    await promptChangeSlotType(interaction, session, idx);
    return;
  }
}

/** Shown from the "Edit" button on the slot menu - one action per field so each reuses its own focused flow below instead of re-running the whole add-player pipeline. */
async function promptEditMenu(interaction, idx) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:rename`).setLabel('Rename').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:change_id`).setLabel('Statlocker/Steam').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:tag_discord`).setLabel('Tag Discord').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:nationality`).setLabel('Nationality').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`reg:slotaction:${idx}:change_slot`).setLabel('Slot').setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({ content: 'What would you like to edit?', components: [row], flags: MessageFlags.Ephemeral });
}

/**
 * "Statlocker/Steam" - re-points this slot at a different Steam ID/
 * statlocker account. Reuses the full add-slot pipeline (same as a brand
 * new player) with replaceIndex set, so applyPendingSlotLinkage overwrites
 * this slot in place instead of appending a new one. If the new account
 * already has its own PlayerRegistry row (see the add_slot handler above),
 * that's offered to the captain as an import, same as a PlayerDB match -
 * nothing here silently merges or renames PlayerRegistry rows.
 */
async function promptChangeSteamId(interaction, session, idx) {
  sessions.update(interaction.channel.id, { pendingSlot: { replaceIndex: idx } });
  await promptAddSlot(interaction, 'Statlocker/Steam ID');
}

/**
 * "Tag Discord" - reuses the existing Discord-linkage flow verbatim
 * (promptSelectDiscordUser -> requestPlayerMention's @-mention collector ->
 * finalizePendingSlotFromMessage -> applyPendingSlotLinkage), just seeded
 * from this slot's current data + replaceIndex instead of a fresh add.
 */
async function promptTagDiscord(interaction, session, idx) {
  const slot = session.roster[idx];
  sessions.update(interaction.channel.id, {
    pendingSlot: {
      replaceIndex: idx,
      accountId: slot.accountId,
      slotType: slot.slotType,
      statlockerUsername: slot.statlockerUsername,
      displayName: slot.displayName,
      nationality: slot.nationality,
    },
  });
  await promptSelectDiscordUser(interaction, session);
}

/**
 * "Nationality" - sets nationality only, leaving Discord linkage untouched.
 * Reuses showNationalityModal's modal/validation, but marks pendingSlot
 * with nationalityOnly so the reg:modal:nationality submit handler below
 * finalizes directly instead of routing into the Discord-linkage step
 * (which is what that modal is normally a step toward, during Add Player).
 */
async function promptNationalityOnly(interaction, session, idx) {
  const slot = session.roster[idx];
  sessions.update(interaction.channel.id, {
    pendingSlot: {
      replaceIndex: idx,
      accountId: slot.accountId,
      slotType: slot.slotType,
      statlockerUsername: slot.statlockerUsername,
      displayName: slot.displayName,
      discordId: slot.discordId,
      nationalityOnly: true,
    },
  });
  await showNationalityModal(interaction, slot.nationality || '');
}

/** "Slot" - moves a player between Main/Sub/Coach without touching anything else about them. */
async function promptChangeSlotType(interaction, session, idx) {
  const slot = session.roster[idx];
  sessions.update(interaction.channel.id, {
    pendingSlot: {
      replaceIndex: idx,
      accountId: slot.accountId,
      statlockerUsername: slot.statlockerUsername,
      displayName: slot.displayName,
      nationality: slot.nationality,
      discordId: slot.discordId,
    },
  });
  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('reg:select:slot_only')
      .setPlaceholder('Select role on team')
      .addOptions(
        { label: 'Starter', value: SLOT_TYPE.MAIN },
        { label: 'Sub', value: SLOT_TYPE.SUB },
        { label: 'Coach', value: SLOT_TYPE.COACH }
      )
  );
  await interaction.reply({
    content: `Move **${slot.displayName || slot.statlockerUsername}** to a different slot type:`,
    components: [selectRow],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSlotOnlySelect(interaction, session) {
  const slotType = interaction.values[0];
  sessions.update(interaction.channel.id, { pendingSlot: { ...session.pendingSlot, slotType } });
  await finalizePendingSlot(interaction, session, { discordId: session.pendingSlot.discordId || '' });
}

async function promptRenameOnly(interaction, session, idx) {
  const slot = session.roster[idx];
  const modal = new ModalBuilder().setCustomId(`reg:modal:rename_only:${idx}`).setTitle('Rename Player');
  const input = new TextInputBuilder()
    .setCustomId('display_name')
    .setLabel('Player Name')
    .setStyle(TextInputStyle.Short)
    .setValue(slot.displayName || slot.statlockerUsername || '')
    .setRequired(true)
    .setMaxLength(80);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// Commit / cancel
// ---------------------------------------------------------------------------

async function commitRegistration(interaction, session) {
  // Guards against double-clicking Finish (or two rapid taps before Discord
  // updates the button) racing two commits for the same session - each
  // click is its own interaction, so nothing upstream deduplicates this.
  if (session.committing) {
    await interaction.reply({ content: 'Already processing your registration - one moment.', flags: MessageFlags.Ephemeral });
    return;
  }
  sessions.update(interaction.channel.id, { committing: true });

  // Defer immediately, before any Sheets calls - those go over HTTP to Apps
  // Script now and can take longer than Discord's 3s interaction-ack window,
  // which would otherwise throw "Unknown interaction" on the reply below.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const activeRoster = session.roster.filter((r) => r.status !== 'discard');
  const mains = activeRoster.filter((r) => r.slotType === SLOT_TYPE.MAIN).length;
  const subs = activeRoster.filter((r) => r.slotType !== SLOT_TYPE.MAIN).length;

  const errors = [];
  if (mains > config.roster.maxMain) {
    errors.push(`Too many main players (max ${config.roster.maxMain}, currently ${mains}).`);
  }
  if (subs > config.roster.maxSubs) errors.push(`Too many subs/coaches (max ${config.roster.maxSubs}, currently ${subs}).`);
  if (!session.teamName) errors.push('Team name is not set.');

  const missingNationality = activeRoster.filter((r) => !r.nationality);
  if (missingNationality.length) {
    errors.push(
      `Missing nationality for: ${missingNationality.map((r) => r.displayName || r.statlockerUsername).join(', ')}. ` +
        `Use the player select menu > Nationality to set it ("None" is fine if they'd rather not disclose).`
    );
  }

  if (session.teamName) {
    const nameClash = await teams.findTeamByName(session.teamName, session.teamRoleId);
    if (nameClash) {
      errors.push(
        `Team name "${session.teamName}" is already used by another registered team. Pick a different name, or contact staff if this is a rebrand of that team.`
      );
    }
  }

  if (errors.length) {
    sessions.update(interaction.channel.id, { committing: false });
    await interaction.editReply({ content: `Can't finish yet:\n${errors.map((e) => `- ${e}`).join('\n')}` });
    return;
  }

  // Brand new team, no role yet: create the role immediately rather than
  // gating on a staff approval click - registration doesn't wait on staff
  // at all, they just get pinged once it's done (see below).
  let teamRoleId = session.teamRoleId;
  let panelMessageId;
  try {
    if (session.isNewTeam && !teamRoleId) {
      // If this roster came from a by-name Team Database match, prefer
      // re-granting that team's original role over creating a duplicate one -
      // it may still exist (e.g. left over from a prior event) even though
      // this captain never held it. Falls back to creating a new role if it
      // was deleted or the fetch fails.
      let role = session.historicalTeamRoleId
        ? await interaction.guild.roles.fetch(session.historicalTeamRoleId).catch(() => null)
        : null;
      if (!role) {
        role = await teams.createTeamRole(interaction.guild, session.teamName);
      }
      teamRoleId = role.id;
      sessions.update(interaction.channel.id, { teamRoleId });
      session = sessions.get(interaction.channel.id);
    }

    // Grab this before performCommit clears the session out from under us.
    panelMessageId = session.panelMessageId;

    await performCommit(interaction.guild, interaction.channel, session, teamRoleId, interaction.user.tag, interaction.user.id);
  } catch (err) {
    // performCommit clears the session on success (and everything before it
    // in this block is retryable) - on any failure, unstick the session so
    // the captain isn't locked out of Finish by a commit that never
    // completed.
    sessions.update(interaction.channel.id, { committing: false });
    throw err;
  }

  // Everything the captain was waiting on (role changes, logo upload) is
  // done at this point - the Sheets write itself is fire-and-forget in the
  // background and doesn't block this. Remove the control panel now so it
  // can't be clicked again on a finished/cleared session.
  if (panelMessageId) {
    const panelMsg = await interaction.channel.messages.fetch(panelMessageId).catch(() => null);
    if (panelMsg) await panelMsg.delete().catch(() => {});
  }

  await interaction.editReply({ content: `Registration complete for **${session.teamName}**.` });

  const historicalNote = session.historicalTeamRoleId
    ? ` **Note:** roster was preloaded from a Team Database match by name only - ${interaction.user} did not hold that team's Discord role. Worth a spot check.`
    : '';
  await pingStaff(
    interaction.channel,
    `**${session.teamName}** (${activeRoster.length} players) completed registration.${historicalNote}`
  );

  scheduleArchive(interaction.channel);
}

/**
 * Creates a team's private voice channel on its first-ever commit, or
 * confirms a channel already on file (from Teams directly, or carried
 * forward via TeamDB for a returning team - see the three
 * session.vcChannelId seed points above) still exists. Only posts the
 * welcome message at the moment a brand new channel is created - a reused
 * channel already had that posted for it, possibly in a past event.
 * Returns '' (not null) on any failure/skip so it always safely round-trips
 * through the Sheets row as a blank rather than the literal string "null".
 */
async function resolveVcChannel(guild, thread, session, teamRoleId) {
  if (session.vcChannelId) {
    const existing = await guild.channels.fetch(session.vcChannelId).catch(() => null);
    if (existing) return session.vcChannelId;
    // Falls through to create a replacement below - the on-file channel
    // was deleted at some point (e.g. end-of-event cleanup).
  }

  if (!config.discord.teamVcCategoryId) return session.vcChannelId || '';

  let channel;
  try {
    channel = await teams.createTeamVoiceChannel(guild, session.teamName, teamRoleId);
  } catch (err) {
    await pingStaff(thread, `Could not create a team voice channel for **${session.teamName}**: ${err.message || err}`).catch(() => {});
    return session.vcChannelId || '';
  }

  await channel
    .send({
      content: config.discord.teamVcWelcomeMessage
        .replace(/\{team\}/g, session.teamName)
        .replace(/\{role\}/g, `<@&${teamRoleId}>`),
      allowedMentions: { roles: [teamRoleId] },
    })
    .catch((err) => {
      pingStaff(thread, `Created a voice channel for **${session.teamName}** but couldn't post the welcome message: ${err.message || err}`).catch(() => {});
    });

  return channel.id;
}

/**
 * Applies Discord role changes first - that's the part the captain actually
 * cares about and can see immediately - then hands the Sheets write off to
 * run in the background rather than making the captain wait on an Apps
 * Script round trip. The session is cleared as soon as roles are set; from
 * the captain's perspective registration is already done at that point.
 */
async function performCommit(guild, thread, session, teamRoleId, actorTag, actorId) {
  const activeRoster = session.roster.filter((r) => r.status !== 'discard');
  auditLog.record(actorId, actorTag, 'registration.commit', {
    threadId: thread.id,
    teamName: session.teamName,
    teamRoleId,
    rosterSize: activeRoster.length,
    isNewTeam: session.isNewTeam,
  });
  const rosterDiscordIds = activeRoster.map((r) => r.discordId).filter(Boolean);
  // Anyone on the active roster with no Discord account linked gets neither
  // the team role nor the participant role below (both need a discordId to
  // grant to) - and since a "kept"/unchanged slot looks fully complete in
  // the panel, nothing else prompts the captain to notice or fix this. Left
  // silent, this persists invisibly across every future re-registration too
  // - so call it out explicitly on every commit instead.
  const missingDiscordLink = activeRoster.filter((r) => !r.discordId);
  // Always keep the captain who ran /register on the team role, even if
  // they didn't add themselves as a roster slot - otherwise they can't get
  // back into Continue Existing to edit the roster later (that flow is
  // gated on holding the role). Deliberately kept separate from
  // rosterDiscordIds below - this is a team-role fallback, not a claim that
  // the captain is a player, so it shouldn't also grant the participant role.
  const desiredDiscordIds = [...new Set([...rosterDiscordIds, session.sessionOwnerId])];

  const roleFailures = await teams.reconcileTeamRole(guild, teamRoleId, desiredDiscordIds);
  if (roleFailures.length) {
    const lines = roleFailures.map(
      (f) => `- Could not ${f.action} role for <@${f.discordId}>: ${f.error.message || f.error}`
    );
    await pingStaff(
      thread,
      `Some Discord role changes for **${session.teamName}** didn't go through - the sheet/roster is still ` +
        `correct, but these need a manual role fix:\n${lines.join('\n')}`,
      roleFailures.map((f) => f.discordId)
    ).catch(() => {});
  }

  await teams.syncTeamRoleName(guild, teamRoleId, session.teamName).catch((error) => {
    pingStaff(thread, `Could not rename Discord role to **${session.teamName}**: ${error.message || error}`).catch(() => {});
  });

  const participantFailures = await teams.applyParticipantRole(guild, rosterDiscordIds);
  if (participantFailures.length) {
    const lines = participantFailures.map(
      (f) => `- Could not add participant role for <@${f.discordId}>: ${f.error.message || f.error}`
    );
    await pingStaff(
      thread,
      `Some participant role grants for **${session.teamName}** didn't go through:\n${lines.join('\n')}`,
      participantFailures.map((f) => f.discordId)
    ).catch(() => {});
  }

  if (missingDiscordLink.length) {
    const lines = missingDiscordLink.map(
      (r) => `- **${r.displayName || r.statlockerUsername}** - no Discord account on file. Use "Tag Discord" on their slot to fix.`
    );
    await pingStaff(
      thread,
      `**${session.teamName}**: these roster members got neither the team role nor the participant role, since no Discord account is linked for them:\n${lines.join('\n')}`
    ).catch(() => {});
  }

  const writeJob = {
    teamRoleId,
    teamName: session.teamName,
    roster: session.roster,
    logoUrl: await resolveLogoUrl(thread, session),
    vcChannelId: await resolveVcChannel(guild, thread, session, teamRoleId),
    actorTag,
  };

  // Persist to disk BEFORE attempting the write, not just if it fails - if
  // this only happened in writeToSheets' catch block, a hard crash (killed
  // process, OOM) between here and a completed write would throw nothing
  // catchable, and the job would never make it to pending-writes.json at
  // all. Saving synchronously first closes that gap: from this line on, the
  // roster survives a full bot crash no matter where it happens.
  const jobId = pendingWrites.save(writeJob);
  writeJob.id = jobId;

  sessions.clear(thread.id);

  // Deliberately not awaited - see writeToSheets for failure handling.
  writeToSheets(writeJob, thread);
}

/**
 * The actual Sheets write, run detached from the interaction that triggered
 * it. Never throws outward - on failure it leaves the job queued locally
 * (see utils/pendingWrites.js, already saved by performCommit before this
 * was called) and pings staff in-thread, since roles are already live and
 * the captain already believes they're registered.
 *
 * Note this only writes into sheets.js's local store (no network call - see
 * sheets.js) - it does NOT mean the data has reached the real Google Sheet
 * yet, that only happens on the next sheets.flush() (background timer,
 * /refresh, or clean shutdown). So the job stays in pending-writes.json even
 * after this succeeds - see clearPendingWritesSyncedBefore, which is what
 * actually retires it once a flush confirms it's durable. Removing it here
 * instead would defeat the point: an ungraceful crash between this line and
 * the next flush would have nothing left to replay on restart, exactly the
 * gap this queue exists to cover.
 */
async function writeToSheets(job, thread) {
  try {
    const existingTeam = await teams.getTeamByRoleId(job.teamRoleId);
    if (!existingTeam) {
      await teams.createTeam({
        teamRoleId: job.teamRoleId,
        teamName: job.teamName,
        roster: job.roster,
        logoUrl: job.logoUrl,
        vcChannelId: job.vcChannelId,
      });
    } else {
      const updates = teams.buildRosterColumns(job.roster);
      if (existingTeam.team_name !== job.teamName) updates.team_name = job.teamName;
      if ((existingTeam.logo_url || '') !== job.logoUrl) updates.logo_url = job.logoUrl;
      if ((existingTeam.vc_channel_id || '') !== job.vcChannelId) updates.vc_channel_id = job.vcChannelId;
      await teams.updateTeam(job.teamRoleId, updates);
    }

    // Discarded slots need no explicit clearing here - they're simply
    // omitted from buildRosterColumns above, so the Teams row stops
    // listing them. PlayerRegistry is pure identity now (see registry.js),
    // so a discarded slot's only registry-side effect is that this loop
    // skips it - their identity row (name/discord link/nationality) is
    // untouched, since being off a roster doesn't erase who they are.
    for (const slot of job.roster) {
      if (slot.status === 'discard') continue;
      await registry.upsertPlayer(
        {
          accountId: slot.accountId,
          statlockerUsername: slot.statlockerUsername,
          discordId: slot.discordId,
          nationality: slot.nationality,
          displayName: slot.displayName,
        },
        { discordUserTag: job.actorTag }
      );
    }
  } catch (err) {
    // Job is already on disk (performCommit saved it before calling this) -
    // just re-save to refresh it, e.g. in case anything changed, and keep
    // its existing id so retries don't pile up duplicate queue entries.
    const id = pendingWrites.save(job);
    console.error(`[writeToSheets] Failed for team ${job.teamName} (queued as ${id}):`, err.message);
    if (thread) {
      await pingStaff(
        thread,
        `Sheet write failed for **${job.teamName}** after Discord roles were already updated: ${err.message}\n` +
          `Saved locally (queue id \`${id}\`) - the bot will retry automatically on next restart, or ask whoever runs the bot to check \`pending-writes.json\`.`
      ).catch(() => {});
    }
  }

  // Whatever happened above (success or partial failure), the in-memory
  // store may have just changed - snapshot it locally now rather than
  // waiting for the next periodic Google Sheets sync (SHEETS_SYNC_INTERVAL_
  // MINUTES defaults to an hour). This is what actually closes the crash-
  // loss window; it's local disk I/O so it doesn't add real latency here,
  // and writeToSheets is already fire-and-forget from the caller's side.
  localSnapshot.writeSnapshot().catch((err) => {
    console.error(`[writeToSheets] Local snapshot write failed: ${err.message}`);
  });

  // Also pushes straight to the real Google Sheet now, rather than leaving
  // it to sit in the local store until the next SHEETS_SYNC_INTERVAL_MINUTES
  // tick or a manual /refresh. Same fire-and-forget shape as index.js's
  // background sync - failures just stay queued for the next timer tick.
  flushSoon();
}

function flushSoon() {
  const flushStartedAt = Date.now();
  sheets
    .flush()
    .then((result) => {
      if (!result.skipped) clearPendingWritesSyncedBefore(flushStartedAt);
    })
    .catch((err) => {
      console.error(`[writeToSheets] Immediate push to Google Sheets failed (will retry on next background sync): ${err.message}`);
    });
}

/** Called on bot startup to retry anything left in the queue from a previous failure. */
async function retryPendingWrites() {
  const jobs = pendingWrites.listAll();
  for (const job of jobs) {
    await writeToSheets(job, null);
  }
  return jobs.length;
}

/**
 * Retires everything in the pending-writes queue that was saved before a
 * flush started, since that flush's push to Google Sheets included it -
 * it's now durable there, not just in this process's memory. cutoffMs must
 * be captured BEFORE calling sheets.flush(), not after: a job saved while
 * that flush was still in flight isn't guaranteed to have been included in
 * it. Called from index.js's background sync and from /refresh, both right
 * after a successful (non-skipped) flush.
 */
function clearPendingWritesSyncedBefore(cutoffMs) {
  for (const job of pendingWrites.listAll()) {
    if (job.savedAt <= cutoffMs) pendingWrites.remove(job.id);
  }
}

function scheduleArchive(thread) {
  setTimeout(() => {
    thread.setArchived(true).catch(() => {});
  }, 5000);
}

async function cancelRegistration(interaction, session) {
  sessions.clear(interaction.channel.id);
  await interaction.update({ content: 'Registration cancelled. No changes were saved.', components: [] });
  scheduleArchive(interaction.channel);
}

// ---------------------------------------------------------------------------

// allowedUserIds: exact Discord user IDs to also permit pinging, for the
// rare pingStaff message that embeds a real <@id> mention inside `message`
// itself (e.g. "Could not add participant role for <@id>") - passed by
// exact ID, never a `parse` category, so nothing else in `message` (which
// may itself contain attacker-controlled text like a team name) can ride
// along as an unintended ping.
async function pingStaff(thread, message, allowedUserIds = []) {
  await thread.send({
    content: `${config.discord.staffMention} ${message}`,
    allowedMentions: { roles: config.discord.staffRoleIds, users: allowedUserIds },
  });
}

module.exports = {
  startRegistration,
  handleComponent,
  handleModalSubmit,
  handleMessage,
  retryPendingWrites,
  clearPendingWritesSyncedBefore,
};
