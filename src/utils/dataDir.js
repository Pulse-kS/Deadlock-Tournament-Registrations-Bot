/**
 * Resolves the directory sessions.json / sheets-snapshot.json /
 * pending-writes.json are persisted in. Defaults to the project root (same
 * behavior as before this existed, for anyone running via start-bot.bat /
 * npm start directly) - set DATA_DIR to point these at a mounted volume
 * instead, e.g. when running in Docker.
 */

const path = require('path');

function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, '..', '..');
}

module.exports = { dataDir };
