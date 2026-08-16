#!/bin/bash
# Tournament Registration Bot - update script
#
# Usage: ./update.sh <path-to-release-zip>
#
# Downloads happen manually (Dropbox, etc) - this script just applies an
# already-downloaded release zip. It backs up the current install, replaces
# application code with the new zip's contents, and rebuilds/restarts the
# bot. It never touches .env or data/, so credentials and session/roster
# state survive the update untouched.
#
# Requires: unzip, rsync (both preinstalled on most Linux distros; if
# rsync is missing: `apt install rsync` / `apt-get install rsync`)

set -e

ZIP_FILE="$1"
if [ -z "$ZIP_FILE" ]; then
  echo "Usage: ./update.sh <path-to-release-zip>"
  exit 1
fi
if [ ! -f "$ZIP_FILE" ]; then
  echo "File not found: $ZIP_FILE"
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="backups/backup-$TIMESTAMP"

echo "== Tournament Registration Bot updater =="
echo "Backing up current files to $BACKUP_DIR ..."
mkdir -p "$BACKUP_DIR"
rsync -a --exclude 'data' --exclude 'node_modules' --exclude 'backups' ./ "$BACKUP_DIR"/

echo "Extracting update..."
TMP_DIR=$(mktemp -d)
unzip -q "$ZIP_FILE" -d "$TMP_DIR"

# If the zip contains one top-level folder (e.g. tournament-registration-bot-YYYYMMDD-NN/),
# step into it so files land in the right place instead of nested a level deep.
SRC="$TMP_DIR"
CONTENTS=("$TMP_DIR"/*)
if [ "${#CONTENTS[@]}" -eq 1 ] && [ -d "${CONTENTS[0]}" ]; then
  SRC="${CONTENTS[0]}"
fi

echo "Applying update (leaving .env and data/ untouched)..."
rsync -a --exclude '.env' --exclude 'data' "$SRC"/ ./
rm -rf "$TMP_DIR"

if command -v docker &> /dev/null && [ -f docker-compose.yml ]; then
  echo "Rebuilding and restarting via Docker..."
  docker compose down
  docker compose up -d --build
  echo ""
  echo "Done. Tail logs with: docker compose logs -f"
else
  echo "Docker not detected - installing dependencies with npm instead..."
  npm install --omit=dev
  echo ""
  echo "Update files are in place. Restart the bot process yourself (npm start)."
fi

echo "Previous version backed up to $BACKUP_DIR - safe to delete once you've confirmed the bot is working."
