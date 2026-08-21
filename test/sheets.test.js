const test = require('node:test');
const assert = require('node:assert/strict');
require('./_setEnv');

// sheets.js calls appsScriptClient.callAppsScript(...) as a property access
// (not a destructured local), specifically so it can be swapped out here
// the same way teamDB.test.js swaps sheets.getTable - see sheets.js's own
// require of appsScriptClient for the comment explaining why.
const appsScriptClient = require('../src/utils/appsScriptClient');

let mockImpl = async () => {
  throw new Error('mockImpl not set for this test');
};
appsScriptClient.callAppsScript = (...args) => mockImpl(...args);

const sheets = require('../src/services/sheets');

async function initWith(tables) {
  mockImpl = async (url, secret, action) => {
    if (action === 'getAllTables') return { tables };
    throw new Error(`initWith's mock only handles getAllTables, got: ${action}`);
  };
  await sheets.init();
}

// These exercise the two races described in the 20260819 maintenance
// review: overlapping flush() calls letting an older snapshot land after
// (and silently clobber) a newer one, and a write landing while a flush's
// network request is already in flight getting its dirty flag wrongly
// cleared by that flush's completion - which would then let
// refreshAllTables() wholesale-discard it. See sheets.js's flush()/
// doFlushOnce() comments for the fix (a serialized flush chain plus a
// generation counter).

test('flush(): concurrent calls with no new writes between them only push once', async () => {
  await initWith({ Teams: { headers: ['team_role_id'], values: [] } });
  await sheets.appendRow('Teams', { team_role_id: 'r1' });

  let pushCount = 0;
  let releaseFirstPush;
  const firstPushGate = new Promise((resolve) => {
    releaseFirstPush = resolve;
  });
  mockImpl = async (url, secret, action) => {
    if (action !== 'replaceAllTables') throw new Error(`unexpected action: ${action}`);
    pushCount += 1;
    await firstPushGate;
    return { ok: true };
  };

  const p1 = sheets.flush();
  const p2 = sheets.flush(); // fires while p1's network call is still pending
  releaseFirstPush();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(pushCount, 1, 'p2 should not have triggered its own network call - nothing changed after p1 took its snapshot');
  assert.equal(r1.skipped, false);
  assert.equal(r2.skipped, true, 'p2 should see dirty already cleared by p1 and skip');
});

test('flush(): a write landing mid-flight is not lost - it gets its own follow-up push', async () => {
  await initWith({ Teams: { headers: ['team_role_id'], values: [] } });
  await sheets.appendRow('Teams', { team_role_id: 'r1' });

  const pushedRowSets = [];
  let releaseFirstPush;
  const firstPushGate = new Promise((resolve) => {
    releaseFirstPush = resolve;
  });
  let pushCount = 0;
  mockImpl = async (url, secret, action, payload) => {
    if (action !== 'replaceAllTables') throw new Error(`unexpected action: ${action}`);
    pushCount += 1;
    pushedRowSets.push(payload.tables.Teams.rows.map((r) => r[0]));
    if (pushCount === 1) await firstPushGate;
    return { ok: true };
  };

  const p1 = sheets.flush();
  // Let flush()'s synchronous snapshot-building (before its own await)
  // actually run before writing more - it's scheduled via .then(), so it
  // needs a tick before the mock above has even been called yet.
  await new Promise((resolve) => setImmediate(resolve));
  await sheets.appendRow('Teams', { team_role_id: 'r2' }); // lands while p1's push is in flight
  const p2 = sheets.flush(); // chained after p1 - runs once p1 resolves
  releaseFirstPush();
  await Promise.all([p1, p2]);

  assert.equal(pushCount, 2, 'the write that landed mid-flight should have triggered its own push, not been silently dropped');
  assert.deepEqual(pushedRowSets[0], ['r1'], 'first push only had what was written before it started');
  assert.deepEqual(pushedRowSets[1], ['r1', 'r2'], 'second push picked up the write that landed mid-flight');
});

test('refreshAllTables(): still refuses to run when a mid-flight write kept data unflushed', async () => {
  await initWith({ Teams: { headers: ['team_role_id'], values: [] } });
  await sheets.appendRow('Teams', { team_role_id: 'r1' });

  let releaseFirstPush;
  const firstPushGate = new Promise((resolve) => {
    releaseFirstPush = resolve;
  });
  let pushCount = 0;
  mockImpl = async (url, secret, action) => {
    if (action === 'replaceAllTables') {
      pushCount += 1;
      if (pushCount === 1) await firstPushGate;
      return { ok: true };
    }
    throw new Error(`refreshAllTables should not have been reached - got action: ${action}`);
  };

  const p1 = sheets.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await sheets.appendRow('Teams', { team_role_id: 'r2' }); // lands mid-flight, same as above
  releaseFirstPush();
  await p1;

  const refreshed = await sheets.refreshAllTables();
  assert.equal(refreshed, false, 'refreshAllTables() must not wholesale-replace the store while r2 is still unpushed');
});

test("refreshAllTables(): a write landing during its own fetch (not flush()'s) isn't silently discarded", async () => {
  await initWith({ Teams: { headers: ['team_role_id'], values: [['r1']] } });
  // dirty is false here - nothing written since init(), so refreshAllTables()'s
  // upfront guard would let it proceed straight to the network call.

  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  mockImpl = async (url, secret, action) => {
    if (action === 'getAllTables') {
      await fetchGate;
      // Simulate the live sheet as it was at the moment this fetch started -
      // i.e. NOT including the write that's about to land locally below.
      return { tables: { Teams: { headers: ['team_role_id'], values: [['r1']] } } };
    }
    throw new Error(`unexpected action: ${action}`);
  };

  const refreshPromise = sheets.refreshAllTables();
  await new Promise((resolve) => setImmediate(resolve));
  await sheets.appendRow('Teams', { team_role_id: 'r2' }); // lands while the fetch above is in flight
  releaseFetch();
  const refreshed = await refreshPromise;

  assert.equal(refreshed, false, 'refreshAllTables() should detect the mid-fetch write and bail rather than discard it');
  const table = await sheets.getTable('Teams');
  assert.deepEqual(
    table.rows.map((r) => r.team_role_id),
    ['r1', 'r2'],
    'the write that landed during the fetch must still be in the local store - refreshAllTables() must not have overwritten it'
  );
});

test('retryPendingWrites-style flush: a flush triggered during another in-flight flush is not dropped', async () => {
  // Models scenario 5 from the 20260819 maintenance review follow-up: a
  // pending-write replay loop calls flush() once per job, and a live
  // registration commit can call flush() (via flushSoon()) around the same
  // time. Both just go through the same public flush() API used elsewhere
  // in this file - this test exists for direct traceability to that
  // scenario, not because the mechanism differs from the tests above.
  await initWith({ Teams: { headers: ['team_role_id'], values: [] } });
  await sheets.appendRow('Teams', { team_role_id: 'replayed-job' });

  const pushedRowSets = [];
  let releaseFirstPush;
  const firstPushGate = new Promise((resolve) => {
    releaseFirstPush = resolve;
  });
  let pushCount = 0;
  mockImpl = async (url, secret, action, payload) => {
    if (action !== 'replaceAllTables') throw new Error(`unexpected action: ${action}`);
    pushCount += 1;
    pushedRowSets.push(payload.tables.Teams.rows.map((r) => r[0]));
    if (pushCount === 1) await firstPushGate;
    return { ok: true };
  };

  const replayFlush = sheets.flush(); // e.g. the pending-write retry loop's flushSoon() call
  await new Promise((resolve) => setImmediate(resolve));
  await sheets.appendRow('Teams', { team_role_id: 'live-commit' }); // a registration committing at the same time
  const liveCommitFlush = sheets.flush();
  releaseFirstPush();
  await Promise.all([replayFlush, liveCommitFlush]);

  assert.equal(pushCount, 2, 'the live commit should not have been silently absorbed into the already-in-flight replay push');
  assert.deepEqual(pushedRowSets[0], ['replayed-job']);
  assert.deepEqual(pushedRowSets[1], ['replayed-job', 'live-commit']);
});
