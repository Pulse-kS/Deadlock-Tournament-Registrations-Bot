/**
 * /config - lets staff/admin (config.discord.privilegedRoleIds) change a
 * hand-picked allowlist of Discord-side settings at runtime, no .env edit
 * or restart needed (see services/runtimeConfig.js for the persistence
 * layer and config.js for how these 4 fields resolve a saved override vs
 * their .env default).
 *
 * The allowlist is deliberately narrow and hand-picked, NOT "everything
 * not explicitly blocked" - three categories are permanently excluded and
 * must never be added here, regardless of future feature requests:
 *   1. Secrets - DISCORD_TOKEN, APPS_SCRIPT_SECRET, STATLOCKER_API_KEY,
 *      NEXTCLOUD_SHARE_PASSWORD, and Nextcloud share URLs (the URL itself
 *      embeds an access token) are never shown or settable through this
 *      command, full stop.
 *   2. Bot/server identity - DISCORD_CLIENT_ID and DISCORD_GUILD_ID stay
 *      out, so this command can never be used to relocate the bot to a
 *      different Discord server.
 *   3. Permission-defining roles - STAFF_ROLE_ID and ADMIN_ROLE_ID (i.e.
 *      config.discord.staffRoleIds/adminRoleIds) stay out, so nobody using
 *      this command - staff or admin - can grant themselves or anyone else
 *      more access, or strip access from another admin, through it. This
 *      is the *only* mechanism enforcing that guarantee; it works by these
 *      fields simply not being representable here, not by checking who's
 *      asking, so it can't be bypassed by a clever value.
 * Channel/category/role fields use Discord's native picker options
 * (addChannelTypes/role type) rather than a free-text ID, so a bad or
 * made-up ID can't be entered in the first place - anything the picker
 * offers already exists and is the right type.
 */

const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const config = require('../config');
const runtimeConfig = require('../services/runtimeConfig');
const auditLog = require('../utils/auditLog');

function isPrivileged(interaction) {
  return config.discord.privilegedRoleIds.some((id) => interaction.member.roles.cache.has(id));
}

function describeValue(key) {
  const value = config.discord[key];
  const override = runtimeConfig.getOverride(key);
  const status = override !== undefined ? '(overridden via /config)' : '(from .env)';
  if (!value) return `*unset* ${status}`;
  const field = runtimeConfig.FIELDS[key];
  if (field.type === 'channel' || field.type === 'category') return `<#${value}> ${status}`;
  if (field.type === 'role') return `<@&${value}> ${status}`;
  return `"${value}" ${status}`;
}

async function applyChange(interaction, key, newValue) {
  const before = config.discord[key];
  runtimeConfig.set(key, newValue);
  auditLog.record(interaction.user.id, interaction.user.tag, 'config.set', {
    field: key,
    before,
    after: newValue,
  });
  await interaction.reply({
    content: `**${runtimeConfig.FIELDS[key].label}** updated: ${describeValue(key)}`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('[Staff/Admin] View or change the bot\'s Discord-side settings.')
    .addSubcommand((sub) => sub.setName('view').setDescription('Show current values for every configurable setting.'))
    .addSubcommand((sub) =>
      sub
        .setName('registration-channel')
        .setDescription('Set the channel captains open /register in.')
        .addChannelOption((opt) => opt.setName('channel').setDescription('New registration channel').setRequired(true).addChannelTypes(ChannelType.GuildText))
    )
    .addSubcommand((sub) =>
      sub
        .setName('participant-role')
        .setDescription('Set the role granted to every player on a completed registration.')
        .addRoleOption((opt) => opt.setName('role').setDescription('New participant role').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('team-vc-category')
        .setDescription("Set the category a new team's private voice channel is created under.")
        .addChannelOption((opt) => opt.setName('category').setDescription('New VC category').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
    )
    .addSubcommand((sub) =>
      sub
        .setName('team-vc-welcome-message')
        .setDescription("Set the message posted once a team's voice channel is first created.")
        .addStringOption((opt) =>
          opt.setName('message').setDescription('Use {team} for the team name, {role} to ping the team role').setRequired(true).setMaxLength(500)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Revert a setting back to its .env value.')
        .addStringOption((opt) =>
          opt
            .setName('field')
            .setDescription('Which setting to reset')
            .setRequired(true)
            .addChoices(...Object.entries(runtimeConfig.FIELDS).map(([key, field]) => ({ name: field.label, value: key })))
        )
    ),

  async execute(interaction) {
    if (!isPrivileged(interaction)) {
      await interaction.reply({ content: 'This command is staff/admin-only.', flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const lines = Object.entries(runtimeConfig.FIELDS).map(([key, field]) => `**${field.label}**: ${describeValue(key)}`);
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'reset') {
      const key = interaction.options.getString('field', true);
      const before = config.discord[key];
      runtimeConfig.reset(key);
      auditLog.record(interaction.user.id, interaction.user.tag, 'config.reset', { field: key, before });
      await interaction.reply({
        content: `**${runtimeConfig.FIELDS[key].label}** reset to its .env value: ${describeValue(key)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'registration-channel') {
      await applyChange(interaction, 'registrationChannelId', interaction.options.getChannel('channel', true).id);
      return;
    }

    if (sub === 'participant-role') {
      await applyChange(interaction, 'participantRoleId', interaction.options.getRole('role', true).id);
      return;
    }

    if (sub === 'team-vc-category') {
      await applyChange(interaction, 'teamVcCategoryId', interaction.options.getChannel('category', true).id);
      return;
    }

    if (sub === 'team-vc-welcome-message') {
      await applyChange(interaction, 'teamVcWelcomeMessage', interaction.options.getString('message', true));
      return;
    }
  },
};
