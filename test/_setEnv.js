/**
 * config.js validates required env vars the moment it's require()'d (fail
 * fast at real startup - see its own doc comment). That means any test
 * that transitively requires config.js (services/teams.js and
 * services/teamDB.js both do, via services/sheets.js) needs those vars set
 * even though these tests never actually talk to Discord/Sheets/statlocker.
 * Require this file first, before requiring anything from src/, to stand
 * them in. Values are arbitrary - nothing here makes a real network call.
 */
const STAND_INS = {
  DISCORD_TOKEN: 'test',
  DISCORD_CLIENT_ID: 'test',
  DISCORD_GUILD_ID: 'test',
  REGISTRATION_CHANNEL_ID: 'test',
  STAFF_ROLE_ID: 'test',
  APPS_SCRIPT_URL: 'http://localhost/test',
  APPS_SCRIPT_SECRET: 'test',
  STATLOCKER_API_KEY: 'test',
};

for (const [key, value] of Object.entries(STAND_INS)) {
  if (!process.env[key]) process.env[key] = value;
}
