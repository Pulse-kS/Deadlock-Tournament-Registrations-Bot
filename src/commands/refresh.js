const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../config');
const sheets = require('../services/sheets');
const playerDB = require('../services/playerDB');
const teamDB = require('../services/teamDB');
const registrationFlow = require('../flows/registrationFlow');
const auditLog = require('../utils/auditLog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('[Staff] Push local changes to Google Sheets and re-download the entire spreadsheet, right now.'),

  async execute(interaction) {
    const isStaff = config.discord.privilegedRoleIds.some((id) => interaction.member.roles.cache.has(id));
    if (!isStaff) {
      await interaction.reply({ content: 'This command is staff-only.', flags: MessageFlags.Ephemeral });
      return;
    }

    auditLog.record(interaction.user.id, interaction.user.tag, 'refresh.command', {
      guildId: interaction.guildId,
    });

    // Apps Script round trips have been seen taking up to ~2 minutes -
    // defer immediately or this blows Discord's 3s ack window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const lines = [];

    try {
      const flushStartedAt = Date.now();
      const result = await sheets.flush();
      if (!result.skipped) registrationFlow.clearPendingWritesSyncedBefore(flushStartedAt);
      lines.push(result.skipped ? 'No local changes to push.' : 'Pushed local changes to Google Sheets.');
    } catch (err) {
      lines.push(`Push to Google Sheets failed: ${err.message}`);
    }

    try {
      const refreshed = await sheets.refreshAllTables();
      lines.push(
        refreshed
          ? 'Re-downloaded the entire spreadsheet - any manual edits made directly in Sheets (including deletions) are now picked up.'
          : 'Skipped re-download - there were still unpushed local changes (the push above must have failed).'
      );
    } catch (err) {
      lines.push(`Re-downloading the spreadsheet failed: ${err.message}`);
    }

    // Surface a header mismatch immediately rather than leaving it to be
    // discovered as "why is this field blank" later - see playerDB.js/
    // teamDB.js's getHeaderWarning for what this actually catches.
    const [playerWarning, teamWarning] = await Promise.all([
      playerDB.getHeaderWarning().catch(() => null),
      teamDB.getHeaderWarning().catch(() => null),
    ]);
    if (playerWarning) lines.push(`⚠️ ${playerWarning}`);
    if (teamWarning) lines.push(`⚠️ ${teamWarning}`);

    await interaction.editReply({ content: lines.join('\n') });
  },
};
