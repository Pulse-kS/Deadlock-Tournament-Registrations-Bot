/**
 * /update - admin-only. The bot can't safely update or restart itself from
 * inside its own container (a `docker compose down` kills this process
 * mid-command, before `up -d --build` could ever finish). So this command
 * doesn't touch git or Docker directly - it just drops a request file in
 * DATA_DIR (bind-mounted to the host, see utils/dataDir.js) and returns.
 * A separate script running on the HOST (outside Docker, scheduled via
 * cron/User Scripts - see scripts/git-update-watcher.sh) polls for that
 * file, does the actual `git pull` + rebuild + restart, and leaves an ack
 * file behind. index.js's announceUpdateIfPending() picks that up on the
 * next boot and posts the result back to whichever channel asked.
 *
 * Gated on adminRoleIds specifically (not privilegedRoleIds/staff) since
 * this can pull and run arbitrary code changes onto the host - see
 * config.js's comment on why ADMIN_ROLE_ID is kept separate from
 * STAFF_ROLE_ID for exactly this kind of elevated action.
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const auditLog = require('../utils/auditLog');
const { dataDir } = require('../utils/dataDir');
const pkg = require('../../package.json');

const REQUEST_PATH = path.join(dataDir(), 'update-request.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription('[Admin] Pull the latest code from GitHub and restart the bot.'),

  async execute(interaction) {
    if (!config.discord.adminRoleIds.length) {
      await interaction.reply({
        content: 'No ADMIN_ROLE_ID is configured, so /update is disabled - set one and restart the bot to enable it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const isAdmin = config.discord.adminRoleIds.some((id) => interaction.member.roles.cache.has(id));
    if (!isAdmin) {
      await interaction.reply({ content: 'This command is admin-only.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (fs.existsSync(REQUEST_PATH)) {
      await interaction.reply({
        content: 'An update is already queued (or the last one never got picked up by the host script) - not queuing a second one.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    auditLog.record(interaction.user.id, interaction.user.tag, 'update.request', { guildId: interaction.guildId });

    const request = {
      requestedAt: new Date().toISOString(),
      requestedByTag: interaction.user.tag,
      channelId: interaction.channelId,
      fromVersion: pkg.version,
    };

    try {
      fs.writeFileSync(REQUEST_PATH, JSON.stringify(request, null, 2));
    } catch (err) {
      await interaction.reply({
        content: `Could not write the update request file: ${err.message}. The host's watcher won't see this - update manually.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content:
        "Update requested. The host's watcher script will pull the latest code and restart the bot shortly " +
        "(usually within a couple minutes) - I'll post here once I'm back online. If nothing happens after " +
        "several minutes, the watcher script may not be running on the host.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
