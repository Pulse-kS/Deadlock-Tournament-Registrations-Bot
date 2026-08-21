const test = require('node:test');
const assert = require('node:assert/strict');
require('./_setEnv');

// Same swap-the-shared-module pattern as teamDB.test.js - see that file's
// comment for why.
const sheets = require('../src/services/sheets');

let mockFindRow = async () => undefined;
let appended = [];
let updated = [];
sheets.findRow = async (tab, predicate) => mockFindRow(tab, predicate);
sheets.appendRow = async (tab, row) => {
  appended.push({ tab, row });
};
sheets.updateRow = async (tab, rowNumber, patch) => {
  updated.push({ tab, rowNumber, patch });
};

const registry = require('../src/services/registry');

function reset({ existing } = {}) {
  appended = [];
  updated = [];
  mockFindRow = async () => existing;
}

// These exercise the 20260821 fix: registry.upsertPlayer used to write
// display_name exactly as passed in, with no fallback - and
// registrationFlow.js's handleKeepName (the "Use Steam name" button)
// never actually set a displayName at all, so a captain picking that
// option produced a blank display_name in PlayerRegistry even on a fully
// completed registration. Fixed at both layers: handleKeepName now sets it
// explicitly, and upsertPlayer here falls back to statlockerUsername as a
// second line of defense against any future caller making the same
// mistake.

test('upsertPlayer: new player, no displayName given, falls back to statlockerUsername', async () => {
  reset({ existing: undefined });
  await registry.upsertPlayer({ accountId: 'a1', statlockerUsername: 'CoolPlayer123' }, {});
  assert.equal(appended.length, 1);
  assert.equal(appended[0].row.display_name, 'CoolPlayer123');
});

test('upsertPlayer: new player, displayName given, uses it over statlockerUsername', async () => {
  reset({ existing: undefined });
  await registry.upsertPlayer({ accountId: 'a2', statlockerUsername: 'CoolPlayer123', displayName: 'Cooler Name' }, {});
  assert.equal(appended.length, 1);
  assert.equal(appended[0].row.display_name, 'Cooler Name');
});

test('upsertPlayer: existing player, no displayName given, keeps on-file name rather than blanking it', async () => {
  reset({ existing: { _rowNumber: 5, statlocker_username: 'CoolPlayer123', display_name: 'Existing Name', nationality: '' } });
  await registry.upsertPlayer({ accountId: 'a3', statlockerUsername: 'CoolPlayer123' }, {});
  assert.equal(updated.length, 1);
  assert.equal(updated[0].patch.display_name, 'Existing Name');
});

test('upsertPlayer: existing player with no on-file name either, falls back to statlockerUsername', async () => {
  reset({ existing: { _rowNumber: 5, statlocker_username: 'CoolPlayer123', display_name: '', nationality: '' } });
  await registry.upsertPlayer({ accountId: 'a4', statlockerUsername: 'CoolPlayer123' }, {});
  assert.equal(updated.length, 1);
  assert.equal(updated[0].patch.display_name, 'CoolPlayer123');
});

test('upsertPlayer: early ID-lookup call (no displayName) must not clobber a real on-file name on re-registration', async () => {
  reset({ existing: { _rowNumber: 5, statlocker_username: 'CoolPlayer123', display_name: 'Their Chosen Name', nationality: '' } });
  // Simulates registrationFlow.js's early ID-lookup upsertPlayer call,
  // which never passes displayName - this must not overwrite the name the
  // player already chose in a previous registration.
  await registry.upsertPlayer({ accountId: 'a5', statlockerUsername: 'CoolPlayer123' }, {});
  assert.equal(updated.length, 1);
  assert.equal(updated[0].patch.display_name, 'Their Chosen Name');
});
