const test = require('node:test');
const assert = require('node:assert/strict');
require('./_setEnv');

// services/teamDB.js calls sheets.getTable(TAB) internally. Rather than
// standing up the real Apps Script client (network) or sheets.init()
// (also network, plus global module state), swap getTable on the shared
// `sheets` module object before requiring teamDB - CommonJS modules are
// singletons, so teamDB's own `const sheets = require('./sheets')` sees
// this same mutated object. Cheap and dependency-free; if this gets fragile
// as more of teamDB needs testing, that's the point to add a real mocking
// library instead.
const sheets = require('../src/services/sheets');

let mockRows = [];
sheets.getTable = async (tab) => ({ headers: [], rows: mockRows });

const teamDB = require('../src/services/teamDB');

function setRows(rows) {
  mockRows = rows;
}

test('findTeamsByName: exact (normalized) match', async () => {
  setRows([{ team_name: 'Dooms Goons', team_role_id: '1' }, { team_name: 'Black King Bar', team_role_id: '2' }]);
  const result = await teamDB.findTeamsByName('  dooms goons  ');
  assert.equal(result.length, 1);
  assert.equal(result[0].team_role_id, '1');
});

test('findTeamsByName: single confident fuzzy match', async () => {
  setRows([{ team_name: 'Weird & Spectacular', team_role_id: '1' }, { team_name: 'Black King Bar', team_role_id: '2' }]);
  const result = await teamDB.findTeamsByName('weird and spectacular');
  assert.equal(result.length, 1);
  assert.equal(result[0].team_role_id, '1');
});

test('findTeamsByName: no match at all returns empty', async () => {
  setRows([{ team_name: 'Black King Bar', team_role_id: '2' }]);
  const result = await teamDB.findTeamsByName('Completely Different Name');
  assert.deepEqual(result, []);
});

test('findTeamsByName: exact duplicate names in the sheet are ambiguous', async () => {
  setRows([
    { team_name: 'Dooms Goons', team_role_id: '1' },
    { team_name: 'Dooms Goons', team_role_id: '2' },
  ]);
  const result = await teamDB.findTeamsByName('Dooms Goons');
  assert.equal(result.length, 2);
});

test('findTeamsByName: two fuzzy candidates too close to call are ambiguous', async () => {
  // Both are one-letter edits of "Team", equally close - neither should
  // win outright per FUZZY_MATCH_MIN_MARGIN.
  setRows([
    { team_name: 'Team A', team_role_id: '1' },
    { team_name: 'Team B', team_role_id: '2' },
  ]);
  const result = await teamDB.findTeamsByName('Team C');
  assert.equal(result.length, 2);
});

test('findTeamsByName: blank input returns empty without touching the sheet', async () => {
  setRows([{ team_name: 'Dooms Goons', team_role_id: '1' }]);
  const result = await teamDB.findTeamsByName('   ');
  assert.deepEqual(result, []);
});

test('findTeamsByRoleIds: exact ID match only, dedupes repeated ids', async () => {
  setRows([
    { team_name: 'Dooms Goons', team_role_id: 'role1' },
    { team_name: 'Black King Bar', team_role_id: 'role2' },
  ]);
  const result = await teamDB.findTeamsByRoleIds(['role1', 'role1', 'role3']);
  assert.equal(result.length, 1);
  assert.equal(result[0].team_role_id, 'role1');
});
