const config = require('../config');

// Node's built-in fetch has no timeout by default - without this, a hung
// Nextcloud instance would leave the calling command (registration commit)
// hanging indefinitely instead of failing over to the Discord-link fallback
// (see registrationFlow.js's resolveLogoUrl catch block). Same approach
// utils/appsScriptClient.js already uses for its own upstream calls.
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Nextcloud public share access for team logos, via the public WebDAV
 * endpoint - so a logo lives somewhere permanent instead of only as a
 * Discord CDN link. Those carry an expiring signature (`ex`/`is`/`hm`
 * query params), so a link saved at registration time can stop resolving
 * weeks later for anything that isn't discord.js re-fetching the message.
 * See registrationFlow.js's resolveLogoUrl for the caller, which uses
 * uploadToShare/renameInShare/deleteFromShare together to guarantee
 * exactly one logo file per team on the share, named after the team's
 * current name: a same-name re-upload overwrites in place (plain WebDAV
 * PUT semantics), a rename with no new upload moves the existing file to
 * match the new name, and a new upload that lands under a different
 * filename (renamed team, or a different extension than before) deletes
 * whatever file it replaced.
 *
 * Two shares are involved, both pointing at the same underlying Nextcloud
 * folder: config.nextcloud (NEXTCLOUD_SHARE_URL) is where every WebDAV
 * call below (PUT/MOVE/DELETE) actually happens, and needs "Allow upload
 * and editing" turned on - a view/download-only share will reject those
 * with 403. config.nextcloudPublic (NEXTCLOUD_PUBLIC_SHARE_URL) is only
 * ever used to build the final URL handed back to the caller (see
 * previewUrl) - a separate, view-only, no-password share on the same
 * folder, so the link written into logo_url opens straight to the image
 * for anyone, rather than a password prompt only the upload share's own
 * credentials get past. If NEXTCLOUD_PUBLIC_SHARE_URL isn't set,
 * config.nextcloudPublic falls back to the same share as config.nextcloud.
 * If the upload share is password-protected, that password goes in
 * NEXTCLOUD_SHARE_PASSWORD.
 */

function shareFileUrl(filename) {
  const { baseUrl } = config.nextcloud;
  return `${baseUrl}/public.php/webdav/${encodeURIComponent(filename)}`;
}

function authHeader() {
  const { shareToken, sharePassword } = config.nextcloud;
  return `Basic ${Buffer.from(`${shareToken}:${sharePassword || ''}`).toString('base64')}`;
}

// WebDAV's PUT/MOVE responses don't carry a public URL - built ourselves
// from the public share's token (config.nextcloudPublic, not the upload
// share these WebDAV calls actually ran against - see the module comment
// above). This format (?path=%2F&files=<name>) addresses a single file
// inside a shared *folder*; if that share ever points at a single-file
// share instead of a folder, this link shape would need to change too.
// Forces a download (Content-Disposition: attachment) regardless of file
// type - previewUrl below is what actually goes into logo_url; this is
// kept as a fallback/utility for anything that specifically wants the
// original file bytes rather than a rendered preview.
function downloadUrl(filename) {
  const { baseUrl, shareToken } = config.nextcloudPublic;
  return `${baseUrl}/s/${shareToken}/download?path=%2F&files=${encodeURIComponent(filename)}`;
}

// Renders the file inline in a browser instead of forcing a download, via
// Nextcloud's public share preview endpoint (the same one its own web UI
// uses for share thumbnails/previews) - this is what actually goes into
// logo_url. x/y bound the rendered size; `a=1` preserves the original
// aspect ratio within that box rather than stretching/cropping to fit it.
// Trade-off versus downloadUrl above: this serves a rendered preview, not
// guaranteed byte-for-byte identical to the original file - unnoticeable
// for a logo displayed in a browser or broadcast graphic, but worth
// knowing if pixel-perfect original bytes ever matter somewhere.
function previewUrl(filename) {
  const { baseUrl, shareToken } = config.nextcloudPublic;
  return `${baseUrl}/apps/files_sharing/publicpreview/${shareToken}?file=${encodeURIComponent(`/${filename}`)}&x=1920&y=1920&a=1`;
}

function assertConfigured() {
  if (!config.nextcloud.baseUrl || !config.nextcloud.shareToken) {
    throw new Error('NEXTCLOUD_SHARE_URL is not configured.');
  }
}

// Nextcloud's Sabre/DAV layer usually puts the actual reason in the
// response body (an XML error doc) - the status line alone ("409 Conflict")
// isn't enough to debug from, e.g. it can't distinguish "share is read-only"
// from "share points at a single file, not a folder". Truncated since it's
// XML/HTML, not meant for display, just for logs.
async function describeError(res) {
  const body = await res.text().catch(() => '');
  return `${res.status} ${res.statusText}${body ? ` - ${body.slice(0, 300)}` : ''}`;
}

async function uploadToShare(filename, buffer) {
  assertConfigured();

  const res = await fetch(shareFileUrl(filename), {
    method: 'PUT',
    headers: { Authorization: authHeader() },
    body: buffer,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Nextcloud upload failed: ${await describeError(res)}`);
  return previewUrl(filename);
}

/**
 * Renames a file already on the share via WebDAV MOVE - no re-download/
 * re-upload of bytes needed. Used to keep a team's logo filename in sync
 * with its current team name after a rename with no new logo upload this
 * session. Returns false (not an error) if the source file doesn't exist -
 * nothing to rename, most likely it was already cleaned up or never
 * uploaded to Nextcloud in the first place (e.g. a Discord-link fallback).
 */
async function renameInShare(oldFilename, newFilename) {
  assertConfigured();
  if (oldFilename === newFilename) return true;

  const res = await fetch(shareFileUrl(oldFilename), {
    method: 'MOVE',
    headers: {
      Authorization: authHeader(),
      Destination: shareFileUrl(newFilename),
      Overwrite: 'T',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Nextcloud rename failed: ${await describeError(res)}`);
  return true;
}

/**
 * Deletes a file from the share. Used to clean up the old logo file once a
 * team's logo has moved to a new filename (renamed team, or a replacement
 * upload with a different extension), so there's never more than one logo
 * file for a team at once. 404 is treated as success - already gone is the
 * goal state either way.
 */
async function deleteFromShare(filename) {
  assertConfigured();

  const res = await fetch(shareFileUrl(filename), {
    method: 'DELETE',
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 404) return;
  if (!res.ok) throw new Error(`Nextcloud delete failed: ${await describeError(res)}`);
}

/**
 * Extracts the filename this module encoded into a share URL (see
 * downloadUrl/previewUrl) - null if url isn't one of ours, e.g. a Discord
 * CDN fallback link from when Nextcloud wasn't configured, or an upload
 * failed and the Discord link got used instead. Those aren't files on the
 * share, so there's nothing to rename/delete for them. Matches against
 * config.nextcloudPublic, since that's the share whose URL shape actually
 * ends up in logo_url. Recognizes both URL shapes this module has ever
 * written (downloadUrl's and previewUrl's) so a logo_url saved before
 * previewUrl existed still gets picked up correctly.
 */
function filenameFromShareUrl(url) {
  const { baseUrl, shareToken } = config.nextcloudPublic;
  if (!url || !baseUrl || !shareToken) return null;

  if (url.startsWith(`${baseUrl}/s/${shareToken}/download?`)) {
    const match = /[?&]files=([^&]+)/.exec(url);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  if (url.startsWith(`${baseUrl}/apps/files_sharing/publicpreview/${shareToken}?`)) {
    const match = /[?&]file=([^&]+)/.exec(url);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]).replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  return null;
}

function isConfigured() {
  return Boolean(config.nextcloud.baseUrl && config.nextcloud.shareToken);
}

module.exports = {
  uploadToShare,
  renameInShare,
  deleteFromShare,
  filenameFromShareUrl,
  downloadUrl,
  previewUrl,
  isConfigured,
};
