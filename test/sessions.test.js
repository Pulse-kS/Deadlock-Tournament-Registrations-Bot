const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// sessions.js resolves its persistence path via dataDir() at require-time
// (DATA_DIR env var, falling back to the project root) - point it at a
// throwaway directory before requiring it, so these tests never touch the
// real sessions.json.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-test-'));
process.env.DATA_DIR = tmpDir;
const sessions = require('../src/utils/sessions');

// These exercise the fix in the 20260821 maintenance review: purgeStale()
// used to measure a session's age from createdAt (thread creation), so a
// captain who'd been genuinely active the whole time but started more than
// maxAgeMs ago would still get purged mid-conversation. Fixed by tracking
// lastActivityAt (bumped on every update()) and purging off that instead.

test('create(): starts lastActivityAt equal to createdAt', () => {
  const session = sessions.create('thread-1', { sessionOwnerId: 'user-1' });
  assert.equal(session.lastActivityAt, session.createdAt);
});

test('update(): bumps lastActivityAt without requiring the patch to mention it', () => {
  const session = sessions.create('thread-2', { sessionOwnerId: 'user-2' });
  const originalActivity = session.lastActivityAt;
  session.lastActivityAt = originalActivity - 10_000; // simulate time having passed
  sessions.update('thread-2', { teamName: 'New Name' });
  const updated = sessions.get('thread-2');
  assert.equal(updated.teamName, 'New Name');
  assert.ok(updated.lastActivityAt > originalActivity - 10_000, 'lastActivityAt should have been bumped to roughly now');
});

test("purgeStale(): a session with old createdAt but recent activity survives", () => {
  const session = sessions.create('thread-3', { sessionOwnerId: 'user-3' });
  // Simulate a thread opened 3 days ago (older than the 48h default) but
  // whose captain did something (update()) within the last hour.
  session.createdAt = Date.now() - 72 * 60 * 60 * 1000;
  session.lastActivityAt = Date.now() - 60 * 60 * 1000;

  const purged = sessions.purgeStale(48 * 60 * 60 * 1000);

  assert.ok(!purged.includes('thread-3'), 'an actively-used session should not be purged just because the thread is old');
  assert.ok(sessions.get('thread-3'), 'session should still exist');
});

test('purgeStale(): a session with no activity past maxAgeMs is purged', () => {
  const session = sessions.create('thread-4', { sessionOwnerId: 'user-4' });
  session.createdAt = Date.now() - 72 * 60 * 60 * 1000;
  session.lastActivityAt = Date.now() - 72 * 60 * 60 * 1000; // never touched since

  const purged = sessions.purgeStale(48 * 60 * 60 * 1000);

  assert.ok(purged.includes('thread-4'), 'a genuinely stale session should still be purged');
  assert.equal(sessions.get('thread-4'), undefined);
});

test('purgeStale(): falls back to createdAt for a session persisted before lastActivityAt existed', () => {
  const session = sessions.create('thread-5', { sessionOwnerId: 'user-5' });
  delete session.lastActivityAt; // simulate an old sessions.json entry from before this field existed
  session.createdAt = Date.now() - 72 * 60 * 60 * 1000;

  const purged = sessions.purgeStale(48 * 60 * 60 * 1000);

  assert.ok(purged.includes('thread-5'), 'should fall back to createdAt and still purge correctly');
});
