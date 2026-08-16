/**
 * Shared Apps Script web app HTTP client, used by services/sheets.js to
 * talk to the bot's operational spreadsheet deployment. Factored out of
 * sheets.js on its own (rather than left inline) since it's a fiddly bit of
 * redirect-handling worth keeping isolated and easy to find.
 *
 * Apps Script web apps respond to the initial POST with a 302 redirect. The
 * FIRST hop (script.google.com/exec) is where doPost/doGet actually
 * executes; the redirect target (script.googleusercontent.com/macros/echo?...)
 * is a separate, read-only content-delivery endpoint serving the
 * already-computed response, and it rejects POST outright (405). So the
 * first request must keep its real method/body (that's what triggers
 * doPost), but every hop after that needs to drop to a plain GET with no
 * body, same as a browser follows it automatically.
 *
 * The echo hop also requires the session cookie Google sets on the initial
 * response - without it, the "content-delivery" GET isn't recognized as
 * belonging to that execution and Google bounces it back to /exec instead
 * of serving the computed response. Since that bounced request is a GET,
 * it lands on doGet (see the "POST only" guard in Code.gs) instead of
 * doPost, which is the confusing failure this was seeing. A manual cookie
 * jar carried across hops avoids the bounce.
 *
 * Per-hop details are buffered into `trace` rather than logged as they
 * happen - on a healthy call that's just noise on every single request.
 * logTraceOnError below is what actually prints it, and only on the error
 * exits in callAppsScript, so hop info only reaches the console when a
 * call actually fails.
 *
 * Each hop carries its own timeout (HOP_TIMEOUT_MS) so a stalled connection
 * fails predictably instead of hanging indefinitely - Node's built-in
 * fetch has no timeout by default. A cold Apps Script deployment (one that
 * hasn't served a request in a while) can be slow to respond to its first
 * request, which callAppsScript's retry/backoff below is built to absorb.
 * Requests are authenticated with an HMAC-SHA256 signature over the action
 * and a timestamp (see sign() below) rather than sending SHARED_SECRET
 * itself on the wire on every call - Apps Script's own execution log can
 * capture request bodies, so a secret sent in plaintext on every request
 * is one log-access-leak away from being usable by anyone, indefinitely.
 * The signature also can't be replayed past the timestamp window Code.gs
 * enforces server-side, unlike a bare shared secret which is valid forever
 * once known. See Code.gs's doPost for the matching verification.
 */
const crypto = require('crypto');
const HOP_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000; // multiplied by attempt number, so later retries wait longer

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HMAC-SHA256(secret, "action:timestamp") as hex - must match Code.gs's computeSignature_. */
function sign(secret, action, timestamp) {
  return crypto.createHmac('sha256', secret).update(`${action}:${timestamp}`).digest('hex');
}

async function postWithRedirects(url, options, trace, maxRedirects = 5) {
  let currentUrl = url;
  let currentOptions = options;
  const cookieJar = new Map(); // cookie name -> "name=value"
  for (let i = 0; i <= maxRedirects; i++) {
    const headers = { ...(currentOptions.headers || {}) };
    if (cookieJar.size) headers.Cookie = [...cookieJar.values()].join('; ');
    const res = await fetch(currentUrl, {
      ...currentOptions,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
    });
    trace.push(`hop ${i}: ${currentOptions.method} ${currentUrl} -> HTTP ${res.status}`);

    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) cookieJar.set(pair.slice(0, eq), pair);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      trace.push(`  Location: ${location || '(none)'}`);
      if (!location) return res;
      currentUrl = location;
      currentOptions = { method: 'GET' };
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects (>${maxRedirects}) while calling the Apps Script web app.`);
}

/** Prints a buffered hop trace - only called from callAppsScript's error exits. */
function logTraceOnError(trace, logPrefix) {
  if (!trace.length) return;
  console.error(`${logPrefix} request trace (call failed):\n${trace.map((l) => `  ${l}`).join('\n')}`);
}

/**
 * POSTs { secret, action, ...payload } to an Apps Script web app deployment
 * and returns the parsed JSON body. Throws on network failure, non-JSON
 * response, or an { error } field in the response.
 *
 * Retries transient-looking failures (a non-JSON response, or a POST that
 * got bounced to doGet - see the module comment above) up to MAX_ATTEMPTS
 * times total, waiting RETRY_DELAY_MS * attempt between each one. Each
 * attempt's own duration is logged alongside the retry message, so a
 * failure that took a while to surface (a stalled connection hitting
 * HOP_TIMEOUT_MS) is distinguishable in the logs from one that failed
 * immediately (more likely a deployment/URL problem than a transient
 * hiccup).
 */
async function callAppsScript(webAppUrl, secret, action, payload = {}, logPrefix = '[apps-script]', attempt = 1) {
  const trace = [];
  const attemptStartedAt = Date.now();
  const timestamp = Date.now();
  const signature = sign(secret, action, timestamp);
  let res;
  try {
    res = await postWithRedirects(
      webAppUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, timestamp, signature, ...payload }),
      },
      trace
    );
  } catch (err) {
    const elapsedMs = Date.now() - attemptStartedAt;
    if (attempt < MAX_ATTEMPTS) {
      console.log(
        `${logPrefix} attempt ${attempt}/${MAX_ATTEMPTS} for "${action}" failed to reach Apps Script after ${elapsedMs}ms (${err.message}), retrying...`
      );
      await sleep(RETRY_DELAY_MS * attempt);
      return callAppsScript(webAppUrl, secret, action, payload, logPrefix, attempt + 1);
    }
    logTraceOnError(trace, logPrefix);
    throw new Error(`Failed to reach Apps Script web app (${action}) after ${attempt} attempts: ${err.message}`);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    // Seen in practice: the echo hop 404s outright (Google's generic Docs/
    // Sheets 404 page) instead of either serving the computed response or
    // bouncing to doGet. Same underlying flakiness the GET-bounce retry
    // below covers, just a different failure shape.
    const elapsedMs = Date.now() - attemptStartedAt;
    if (attempt < MAX_ATTEMPTS) {
      console.log(
        `${logPrefix} attempt ${attempt}/${MAX_ATTEMPTS} for "${action}" got a non-JSON response (HTTP ${res.status}) after ${elapsedMs}ms, retrying...`
      );
      await sleep(RETRY_DELAY_MS * attempt);
      return callAppsScript(webAppUrl, secret, action, payload, logPrefix, attempt + 1);
    }
    logTraceOnError(trace, logPrefix);
    throw new Error(
      `Apps Script returned a non-JSON response for "${action}" (HTTP ${res.status}) at ${res.url} after ${attempt} attempts. ` +
        `This usually means the web app isn't deployed correctly, or the deployment URL is stale. ` +
        `Response started with: ${text.slice(0, 200)}`
    );
  }

  // A GET landing on doGet (see Code.gs) means the echo redirect hop got
  // bounced back to /exec instead of serving its content - normally fixed
  // by the cookie jar in postWithRedirects, but Google's redirect chain
  // has been seen to hiccup on a single request before.
  if (body.error === 'This endpoint only accepts POST requests.' && attempt < MAX_ATTEMPTS) {
    console.log(`${logPrefix} attempt ${attempt}/${MAX_ATTEMPTS} for "${action}" got a GET-bounce error, retrying...`);
    await sleep(RETRY_DELAY_MS * attempt);
    return callAppsScript(webAppUrl, secret, action, payload, logPrefix, attempt + 1);
  }

  if (!res.ok || body.error) {
    logTraceOnError(trace, logPrefix);
    throw new Error(`Apps Script error (${action}): ${body.error || res.statusText}`);
  }
  return body;
}

module.exports = { callAppsScript };
