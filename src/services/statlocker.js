const config = require('../config');

// 429/5xx/network errors are transient - worth a couple of retries before
// making the captain click the button again themselves. 401/403/404 are
// not retried below - those won't succeed on a second attempt.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000; // multiplied by attempt number if no Retry-After header

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * statlocker.gg profile lookups. Confirmed against the real (early-state) API
 * docs at statlocker.gg/api:
 *   GET https://statlocker.gg/api/public/profile/{accountId}
 *   Header: X-API-Key: <key>
 *   -> { name, ppScore, accountId, ... }
 * accountId is the Steam "account ID" (32-bit) - the same value stored as
 * the canonical player identifier everywhere else in this app, so it's
 * passed straight through with no conversion needed.
 *
 * ppScore is deliberately NOT recorded from here. It's a dynamic, frequently
 * changing value - a number captured at registration time is stale by the
 * time a tournament actually starts, so storing it would just be wrong data.
 * Seeding/ranking should look ppScore up fresh (e.g. via a separate tool)
 * at the time it's actually needed, not read whatever this bot recorded
 * weeks earlier. This lookup exists purely to confirm the account has a
 * real statlocker profile and to pull the verified display name (the actual
 * anti-GIGO purpose - catching joke/offensive Steam names before they end
 * up as the on-record player name).
 */
async function lookupPlayer(accountId) {
  const url = `${config.statlocker.apiBase}/profile/${accountId}`;
  let lastNetworkError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': config.statlocker.apiKey || '' },
      });
    } catch (err) {
      lastNetworkError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw new StatlockerLookupError(`Network error contacting statlocker.gg: ${lastNetworkError.message}`);
    }

    if (res.status === 401) {
      throw new StatlockerLookupError(
        'statlocker.gg rejected the API key (401). Check STATLOCKER_API_KEY is set correctly - contact staff.'
      );
    }
    if (res.status === 403) {
      throw new StatlockerLookupError('statlocker.gg API key is not permitted to access this endpoint (403).');
    }
    if (res.status === 404) {
      throw new StatlockerLookupError('No statlocker.gg profile found for this Steam ID.');
    }

    // Rate limit and server errors are worth a retry before giving up - both
    // are transient rather than "this account/key is wrong". A Retry-After
    // header (seconds) takes priority over the default backoff if present.
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_ATTEMPTS) {
        const retryAfterHeader = Number(res.headers.get('Retry-After'));
        const delayMs = retryAfterHeader > 0 ? retryAfterHeader * 1000 : RETRY_DELAY_MS * attempt;
        await sleep(delayMs);
        continue;
      }
      if (res.status === 429) {
        throw new StatlockerLookupError('statlocker.gg rate limit hit (429) and retries were exhausted. Try again in a bit.');
      }
      throw new StatlockerLookupError(`statlocker.gg API returned ${res.status} ${res.statusText} and retries were exhausted.`);
    }

    if (!res.ok) {
      throw new StatlockerLookupError(`statlocker.gg API returned ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    const username = typeof data.name === 'string' && data.name.trim() ? data.name : null;
    if (!username) {
      console.error('[statlocker] unexpected profile response shape:', JSON.stringify(data));
      throw new StatlockerLookupError(
        'statlocker.gg response had no player name - the profile may not exist, or the API response shape changed since this was wired up.'
      );
    }

    return { username };
  }

  // Unreachable in practice (every branch above either returns or throws),
  // but keeps this function's return type honest if that ever changes.
  throw new StatlockerLookupError('statlocker.gg lookup failed after retries.');
}

class StatlockerLookupError extends Error {}

module.exports = {
  lookupPlayer,
  StatlockerLookupError,
};
