const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSteamId, steamId64ToAccountId, accountIdToSteamId64 } = require('../src/services/steam');

test('steamId64ToAccountId / accountIdToSteamId64 round-trip', () => {
  const accountId = steamId64ToAccountId('76561198012345678');
  assert.equal(accountId, '52079950');
  assert.equal(accountIdToSteamId64(accountId), '76561198012345678');
});

test('resolveSteamId: bare account ID / friend code', async () => {
  const result = await resolveSteamId('122962838');
  assert.equal(result.accountId, '122962838');
  assert.equal(result.resolvedFrom, 'account_id');
});

test('resolveSteamId: raw SteamID64', async () => {
  const result = await resolveSteamId('76561198012345678');
  assert.equal(result.resolvedFrom, 'steamid64');
  assert.equal(result.accountId, steamId64ToAccountId('76561198012345678'));
});

test('resolveSteamId: full steamcommunity profile URL', async () => {
  const result = await resolveSteamId('https://steamcommunity.com/profiles/76561198012345678');
  assert.equal(result.resolvedFrom, 'profile_url');
  assert.equal(result.accountId, steamId64ToAccountId('76561198012345678'));
});

test('resolveSteamId: statlocker.gg profile URL, with and without trailing path', async () => {
  const a = await resolveSteamId('https://statlocker.gg/profile/122962838');
  const b = await resolveSteamId('https://statlocker.gg/profile/122962838/matches');
  assert.equal(a.accountId, '122962838');
  assert.equal(b.accountId, '122962838');
  assert.equal(a.resolvedFrom, 'statlocker_url');
});

test('resolveSteamId: SteamID2', async () => {
  const result = await resolveSteamId('STEAM_0:1:12345678');
  assert.equal(result.resolvedFrom, 'steamid2');
  assert.equal(result.accountId, String(12345678 * 2 + 1));
});

test('resolveSteamId: SteamID3', async () => {
  const result = await resolveSteamId('[U:1:12345678]');
  assert.equal(result.resolvedFrom, 'steamid3');
  assert.equal(result.accountId, '12345678');
});

test('resolveSteamId: rejects vanity URLs with a specific, actionable message', async () => {
  await assert.rejects(
    () => resolveSteamId('https://steamcommunity.com/id/somevanityname'),
    /Vanity profile links/
  );
});

test('resolveSteamId: rejects empty input', async () => {
  await assert.rejects(() => resolveSteamId(''), /Empty Steam ID input/);
  await assert.rejects(() => resolveSteamId('   '), /Empty Steam ID input/);
});

test('resolveSteamId: rejects garbage input', async () => {
  await assert.rejects(() => resolveSteamId('not-a-steam-id-at-all'), /Could not resolve/);
});

test('resolveSteamId: rejects an account ID number out of 32-bit range', async () => {
  // 10 digits but over the 32-bit ceiling (4294967296) - must not be
  // silently accepted as a valid account ID.
  await assert.rejects(() => resolveSteamId('9999999999'), /Could not resolve/);
});

test('resolveSteamId: rejects input over the length guard', async () => {
  await assert.rejects(() => resolveSteamId('1'.repeat(201)), /too long/);
});
