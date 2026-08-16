const { SlashCommandBuilder } = require('discord.js');
const registrationFlow = require('../flows/registrationFlow');
const auditLog = require('../utils/auditLog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register')
    .setDescription('Start or update your team\'s tournament registration.'),

  async execute(interaction) {
    auditLog.record(interaction.user.id, interaction.user.tag, 'register.command', {
      guildId: interaction.guildId,
    });
    await registrationFlow.startRegistration(interaction);
  },
};
