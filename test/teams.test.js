const test = require('node:test');
const assert = require('node:assert/strict');
require('./_setEnv');
const { rosterFromTeamRow, buildRosterColumns } = require('../src/services/teams');
const { SLOT_TYPE } = require('../src/utils/sessions');

test('rosterFromTeamRow: reads mains/subs/coaches, skips blanks', () => {
  const row = { p1: '111', p2: '', p3: '222', p4: '', p5: '', p6: '', s1: '333', s2: '', c1: '', c2: '444' };
  const roster = rosterFromTeamRow(row);
  assert.deepEqual(roster, [
    { accountId: '111', slotType: SLOT_TYPE.MAIN },
    { accountId: '222', slotType: SLOT_TYPE.MAIN },
    { accountId: '333', slotType: SLOT_TYPE.SUB },
    { accountId: '444', slotType: SLOT_TYPE.COACH },
  ]);
});

test('buildRosterColumns: assigns each slot type to its own column block, in roster order', () => {
  const roster = [
    { accountId: '1', slotType: SLOT_TYPE.SUB },
    { accountId: '2', slotType: SLOT_TYPE.MAIN },
    { accountId: '3', slotType: SLOT_TYPE.COACH },
    { accountId: '4', slotType: SLOT_TYPE.MAIN },
  ];
  const cols = buildRosterColumns(roster);
  assert.equal(cols.p1, '2');
  assert.equal(cols.p2, '4');
  assert.equal(cols.p3, '');
  assert.equal(cols.s1, '1');
  assert.equal(cols.s2, '');
  assert.equal(cols.c1, '3');
  assert.equal(cols.c2, '');
});

test('buildRosterColumns: drops discard-status slots', () => {
  const roster = [
    { accountId: '1', slotType: SLOT_TYPE.MAIN, status: 'discard' },
    { accountId: '2', slotType: SLOT_TYPE.MAIN },
  ];
  const cols = buildRosterColumns(roster);
  assert.equal(cols.p1, '2');
  assert.equal(cols.p2, '');
});

test('buildRosterColumns: overflow beyond a bucket\'s column count is silently dropped, not thrown', () => {
  // 7 mains - one more than p1-p6 has room for. This is a pure data-shaping
  // helper (callers validate roster size before this runs - see teams.js's
  // doc comment), so it must not throw; it just can't fit the 7th.
  const roster = ['1', '2', '3', '4', '5', '6', '7'].map((accountId) => ({ accountId, slotType: SLOT_TYPE.MAIN }));
  const cols = buildRosterColumns(roster);
  assert.equal(cols.p1, '1');
  assert.equal(cols.p6, '6');
  assert.ok(!Object.values(cols).includes('7'), 'the 7th main should not appear anywhere in the output');
});

test('buildRosterColumns + rosterFromTeamRow round-trip', () => {
  const original = [
    { accountId: '10', slotType: SLOT_TYPE.MAIN },
    { accountId: '20', slotType: SLOT_TYPE.SUB },
    { accountId: '30', slotType: SLOT_TYPE.COACH },
  ];
  const row = buildRosterColumns(original);
  const roundTripped = rosterFromTeamRow(row);
  assert.deepEqual(roundTripped, original);
});
