#!/bin/bash
# git-update-watcher.sh - runs on the UNRAID HOST, outside Docker.
#
# This is deliberately NOT something the bot's own container runs: when a
# container tears itself down (`docker compose down`) mid-script, every
# process inside it - including this one, if it were running in there -
# dies with it before `up -d --build` could ever run. So /update
# (src/commands/update.js) just drops a request file; this script is what
# actually does the work, running as a process the container restart can't
# kill out from under itself.
#
# Schedule this on the host - e.g. Unraid's "User Scripts" plugin, "Custom
# schedule" every 1-2 minutes - not inside the container. It's a no-op
# (exits immediately) whenever there's no pending request, so a short
# interval is cheap.
#
# Assumes APPDIR is a `git clone` of the private repo (deploy key, read-only
# access - see the GitHub deploy key setup you already have instructions
# for), NOT a directory managed by the old zip-based update.sh. Run
# `cd APPDIR && git status` first - if it says "not a git repository", set
# that up before pointing this script at it.
#
# Deliberately does NOT run `npm run recover-ids` automatically. That tool
# defaults to a dry run and is meant to be reviewed by a human before
# anything gets written - baking it into an unattended script would defeat
# that safeguard. Run it manually (`docker compose run --rm registration-bot
# npm run recover-ids`) if/when it's actually needed.

set -u

APPDIR="/mnt/user/appdata/apl-bot"      # <-- set to the real path
DEPLOY_KEY="/root/.ssh/apl-bot-github"  # <-- set to the real deploy key path
LOCK_FILE="/tmp/apl-bot-update-watcher.lock"

DATA_DIR="$APPDIR/data"
REQUEST_FILE="$DATA_DIR/update-request.json"
ACK_FILE="$DATA_DIR/update-ack.json"
FAILED_FILE="$DATA_DIR/update-failed.json"

# Skip silently if nothing's queued, or another run is still in progress
# (a slow rebuild could still be going when the next cron tick fires).
[ -f "$REQUEST_FILE" ] || exit 0
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

cd "$APPDIR" || { echo "[update-watcher] Could not cd to $APPDIR"; exit 1; }

extract_json_field() {
  # $1 = field name, $2 = file. Only handles flat string values, which is
  # all update-request.json / package.json's "version" line ever contain.
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$2" | head -1 | sed -E "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

CHANNEL_ID=$(extract_json_field channelId "$REQUEST_FILE")
FROM_VERSION=$(extract_json_field fromVersion "$REQUEST_FILE")
FROM_HASH=$(git rev-parse HEAD 2>/dev/null || echo unknown)

echo "[update-watcher] Update requested for channel ${CHANNEL_ID:-unknown} (from ${FROM_VERSION:-unknown} @ ${FROM_HASH}) - pulling..."

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes"
if ! git pull --ff-only; then
  echo "[update-watcher] git pull failed - leaving request in place for manual review."
  echo "{\"error\": \"git pull failed\", \"channelId\": \"$CHANNEL_ID\"}" > "$FAILED_FILE"
  mv "$REQUEST_FILE" "$FAILED_FILE" 2>/dev/null || rm -f "$REQUEST_FILE"
  exit 1
fi

TO_HASH=$(git rev-parse HEAD 2>/dev/null || echo unknown)
TO_VERSION=$(extract_json_field version package.json)

# index.js's announceUpdateIfPending() branches on ack.upToDate - if the
# pull didn't move HEAD, there's nothing new to run, so skip the
# rebuild/restart entirely rather than paying for a docker rebuild (and a
# few seconds of downtime) for a no-op. This is also the only case that
# doesn't restart the process, which is why it's the one index.js has to
# poll for on a timer instead of only checking once at boot.
if [ "$FROM_HASH" = "$TO_HASH" ]; then
  echo "[update-watcher] Already up to date (${TO_HASH}) - nothing to rebuild."
  rm -f "$REQUEST_FILE"
  if [ -n "$CHANNEL_ID" ]; then
    printf '{"channelId": "%s", "upToDate": true, "fromVersion": "%s", "fromHash": "%s", "toHash": "%s"}\n' \
      "$CHANNEL_ID" "$FROM_VERSION" "$FROM_HASH" "$TO_HASH" > "$ACK_FILE"
  fi
  exit 0
fi

echo "[update-watcher] Rebuilding and restarting..."
if ! docker compose down || ! docker compose up -d --build; then
  echo "[update-watcher] Docker rebuild/restart failed - check logs manually."
  echo "{\"error\": \"docker rebuild failed\", \"channelId\": \"$CHANNEL_ID\"}" > "$FAILED_FILE"
  rm -f "$REQUEST_FILE"
  exit 1
fi

rm -f "$REQUEST_FILE"
if [ -n "$CHANNEL_ID" ]; then
  printf '{"channelId": "%s", "upToDate": false, "fromVersion": "%s", "fromHash": "%s", "toHash": "%s"}\n' \
    "$CHANNEL_ID" "$FROM_VERSION" "$FROM_HASH" "$TO_HASH" > "$ACK_FILE"
fi

echo "[update-watcher] Done: ${FROM_VERSION:-unknown} @ ${FROM_HASH} -> ${TO_VERSION:-unknown} @ ${TO_HASH}"
