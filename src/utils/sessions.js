/**
 * In-memory session state for registration flows in progress, backed by a
 * JSON file on disk so an in-progress (unconfirmed) registration survives a
 * bot restart. Committed data (already written to Sheets/roles) was always
 * safe regardless - this just protects the captain's unsaved progress too.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('./dataDir');

const PERSIST_PATH = path.join(dataDir(), 'sessions.json');
const TMP_PATH = `${PERSIST_PATH}.tmp`;

const sessions = new Map(loadFromDisk());

const SLOT_TYPE = {
  MAIN: 'main',
  SUB: 'sub',
  COACH: 'coach',
};

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return [];
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return Object.entries(obj);
  } catch (err) {
    console.warn('[sessions] Could not load persisted sessions, starting fresh:', err.message);
    return [];
  }
}

function persist() {
  try {
    const obj = Object.fromEntries(sessions);
    // Write to a temp file then rename over the real path - rename is
    // atomic on the same filesystem, so a crash mid-write (killed process,
    // power loss) never leaves a truncated/corrupt sessions.json behind.
    // Same pattern as services/localSnapshot.js.
    fs.writeFileSync(TMP_PATH, JSON.stringify(obj, null, 2));
    fs.renameSync(TMP_PATH, PERSIST_PATH);
  } catch (err) {
    console.warn('[sessions] Could not persist sessions to disk:', err.message);
  }
}

function create(threadId, initial) {
  const session = {
    threadId,
    sessionOwnerId: initial.sessionOwnerId,
    teamRoleId: initial.teamRoleId || null, // null = brand new team, no role yet
    teamName: initial.teamName || null,
    isNewTeam: !!initial.isNewTeam,
    // roster: array of { accountId, slotType, statlockerUsername, displayName,
    //   discordId, status: 'keep' | 'new' | 'renamed' | 'discard' }
    roster: initial.roster || [],
    logoUrl: initial.logoUrl || null,
    // Set once an image message is detected (see registrationFlow's
    // handleMessage) - { messageId, discordUrl, filename }. The actual
    // upload to the file server happens later, at commit (resolveLogoUrl),
    // not when this is set.
    pendingLogoUpload: initial.pendingLogoUpload || null,
    // Set when a non-PNG image is uploaded while awaitingLogo - holds that
    // image's { messageId, discordUrl, filename } until the captain's next
    // message, at which point it's accepted anyway (see handleMessage).
    pendingLogoWarning: initial.pendingLogoWarning || null,
    // true while waiting for the captain's next message (must contain an
    // image attachment) after clicking Team Logo - see registrationFlow's
    // promptTeamLogo/handleMessage.
    awaitingLogo: false,
    createdAt: Date.now(),
  };
  sessions.set(threadId, session);
  persist();
  return session;
}

function get(threadId) {
  return sessions.get(threadId);
}

/**
 * Finds an existing session owned by this Discord user, if any - used by
 * startRegistration (registrationFlow.js) to point a captain back at their
 * in-progress thread instead of spinning up a second one via /register.
 * O(n) over active sessions, which is fine at this scale (one Map, purged
 * regularly - see purgeStale) rather than worth a second ownerId->threadId
 * index.
 */
function findByOwner(ownerId) {
  for (const session of sessions.values()) {
    if (session.sessionOwnerId === ownerId) return session;
  }
  return null;
}

function update(threadId, patch) {
  const session = sessions.get(threadId);
  if (!session) return undefined;
  Object.assign(session, patch);
  persist();
  return session;
}

function clear(threadId) {
  sessions.delete(threadId);
  persist();
}

/**
 * Removes sessions older than maxAgeMs (default 48h) and returns the list of
 * purged { threadId } so the caller can optionally notify/archive those
 * threads. Intended to run once on bot startup.
 */
function purgeStale(maxAgeMs = 48 * 60 * 60 * 1000) {
  const now = Date.now();
  const purged = [];
  for (const [threadId, session] of sessions.entries()) {
    if (now - session.createdAt > maxAgeMs) {
      purged.push(threadId);
      sessions.delete(threadId);
    }
  }
  if (purged.length > 0) persist();
  return purged;
}

module.exports = { create, get, update, clear, purgeStale, findByOwner, SLOT_TYPE };
