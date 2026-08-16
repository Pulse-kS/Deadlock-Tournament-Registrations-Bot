const STEAMID64_REGEX = /^7656119\d{10}$/;

// Steam's "account ID" (32-bit) is SteamID64 minus this base offset - this is
// also the number statlocker.gg uses in its profile URLs (confirmed against
// a real profile: statlocker.gg/profile/<accountId>/matches) and matches
// the "friend code" shown in the Steam client. This is now the canonical
// stored identifier throughout the app - steamId64 is only kept around as a
// derived convenience (e.g. for building a profile link) since it's a
// reversible 1:1 conversion either direction.
const STEAM64_BASE = 76561197960265728n;

function steamId64ToAccountId(steamId64) {
  const accountId = BigInt(steamId64) - STEAM64_BASE;
  return accountId >= 0n ? accountId.toString() : null;
}

function accountIdToSteamId64(accountId) {
  return (STEAM64_BASE + BigInt(accountId)).toString();
}

/**
 * Accepts any of:
 *  - raw SteamID64 (e.g. 76561198012345678)
 *  - full profile URL (https://steamcommunity.com/profiles/76561198012345678)
 *  - SteamID2 (STEAM_0:0:12345678)
 *  - SteamID3 ([U:1:12345678])
 *  - a bare account ID / "friend code" (e.g. 122962838) - also what
 *    statlocker.gg uses directly, so this is the fastest path for most users
 *  - a statlocker.gg profile URL (https://statlocker.gg/profile/122962838),
 *    with or without a trailing /matches or similar
 * Deliberately does NOT resolve vanity URLs/names (steamcommunity.com/id/...)
 * - that requires a Steam Web API key, which this bot doesn't use. Players
 * with a vanity URL need to submit one of the numeric forms above instead
 * (their full profile URL works if it happens to already be numeric, or
 * their account ID/friend code from Steam > Friends > Add a Friend).
 * Returns { accountId, steamId64, resolvedFrom } or throws Error if it can't
 * be resolved. accountId is the canonical value to store/use everywhere;
 * steamId64 is included only as a convenience derivative.
 */
const MAX_INPUT_LENGTH = 200; // generous - every accepted format is well under this

async function resolveSteamId(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) throw new Error('Empty Steam ID input.');
  if (trimmed.length > MAX_INPUT_LENGTH) {
    throw new Error(`That doesn't look like a Steam ID or profile URL (too long - ${trimmed.length} characters).`);
  }

  if (STEAMID64_REGEX.test(trimmed)) {
    const accountId = steamId64ToAccountId(trimmed);
    return { accountId, steamId64: trimmed, resolvedFrom: 'steamid64' };
  }

  const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d+)/i);
  if (profileMatch && STEAMID64_REGEX.test(profileMatch[1])) {
    const accountId = steamId64ToAccountId(profileMatch[1]);
    return { accountId, steamId64: profileMatch[1], resolvedFrom: 'profile_url' };
  }

  // statlocker.gg profile URLs use the bare account ID directly (see note above),
  // e.g. https://statlocker.gg/profile/122962838 or .../122962838/matches
  const statlockerMatch = trimmed.match(/statlocker\.gg\/profile\/(\d+)/i);
  if (statlockerMatch) {
    const accountId = statlockerMatch[1];
    return { accountId, steamId64: accountIdToSteamId64(accountId), resolvedFrom: 'statlocker_url' };
  }

  const id2Match = trimmed.match(/^STEAM_[0-5]:([01]):(\d+)$/i);
  if (id2Match) {
    const y = BigInt(id2Match[1]);
    const z = BigInt(id2Match[2]);
    const accountId = (z * 2n + y).toString();
    return { accountId, steamId64: accountIdToSteamId64(accountId), resolvedFrom: 'steamid2' };
  }

  const id3Match = trimmed.match(/^\[U:1:(\d+)\]$/i);
  if (id3Match) {
    const accountId = id3Match[1];
    return { accountId, steamId64: accountIdToSteamId64(accountId), resolvedFrom: 'steamid3' };
  }

  if (/steamcommunity\.com\/id\//i.test(trimmed)) {
    throw new Error(
      'Vanity profile links (steamcommunity.com/id/...) can\'t be resolved automatically. ' +
        'Use your numeric SteamID64, account ID/friend code instead - right-click your profile ' +
        'in the Steam client > Copy Page URL if it shows numbers, or find it via a site like steamid.io.'
    );
  }

  // Bare account ID / "friend code" - fits in a 32-bit unsigned int.
  if (/^\d{1,10}$/.test(trimmed)) {
    const n = BigInt(trimmed);
    if (n < 4294967296n) {
      return { accountId: trimmed, steamId64: accountIdToSteamId64(trimmed), resolvedFrom: 'account_id' };
    }
  }

  throw new Error(
    `Could not resolve "${input}" as a Steam ID. Accepted: your account ID/friend code, SteamID64, ` +
      `a numeric profile URL, a statlocker.gg profile URL, STEAM_0:0:12345678, or [U:1:12345678].`
  );
}

module.exports = {
  resolveSteamId,
  steamId64ToAccountId,
  accountIdToSteamId64,
};
