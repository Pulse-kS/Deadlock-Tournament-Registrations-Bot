# Tournament Registration Bot

Discord bot for team-based tournament signups. Captains (or any current team
member) run `/register` to open a private thread, build/edit their roster
against verified Steam IDs + statlocker.gg data, and the bot syncs Discord
roles + a Google Sheet backend automatically.

**New install?** See `QUICKSTART.md` for the shortest path from zero to a
running bot. This document covers the same ground in more depth, plus
Docker, remote updates, and everything else.

## Status: 20260822-01

Core registration flow (new team, edit existing team, keep/rename/discard
per slot, Steam ID resolution, statlocker lookup, nationality capture, role
sync, auto role creation, staff completion pings, participant role grants,
team logo upload, team voice channels) is implemented, syntax-checked, and
covered by 35 automated tests - but confirm the live-API paths (Discord
role/channel creation, the Apps Script round trip, statlocker lookups) work
end-to-end in a test server/sheet before opening real signups. See "Known
gaps" below for anything else worth knowing first.

## Setup

**Recommended**: run the interactive setup script instead of hand-editing
`.env` - it validates your bot token live, looks up your server's actual
channels/roles/categories, and lets you pick from a list instead of
needing Developer Mode + right-click + Copy ID for each one. It also
generates `APPS_SCRIPT_SECRET` for you.

- Windows: double-click `run-setup.bat` (installs Node.js for you via
  winget if it's not already on the machine).
- Mac/Linux, or Windows without the double-click: `npm install` then
  `npm run setup`.

Safe to re-run any time - it reads your current `.env` first and offers
every existing value as the default, and backs up the old file to
`.env.bak` before writing a new one. It only covers `.env` - you'll still
need to do steps 3-5 below (Discord permissions, Apps Script setup,
`npm run deploy-commands`, `npm start`) either way; the script's own
"Next steps" output at the end walks through exactly those.

<details>
<summary>Manual .env setup (if you'd rather not use the script, or need a var it doesn't ask about)</summary>

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` - reuse your existing bot application's credentials from the Discord Developer Portal, or create a new one - either works, nothing in the code cares which
   - `REGISTRATION_CHANNEL_ID` - text channel where registration threads get created. Also settable at runtime via `/config registration-channel` (see "Staff commands" below).
   - `STAFF_ROLE_ID` - role pinged when the bot needs manual intervention, and on every completed registration. Accepts a comma-separated list of role IDs (e.g. `123,456`) if you want more than one role to get pings/permissions - every listed role is treated equally everywhere staff role is checked (voice channel access, `/refresh`/`/config` permission, pings).
   - `ADMIN_ROLE_ID` - optional, same comma-separated shape as `STAFF_ROLE_ID`. Gets every permission `STAFF_ROLE_ID` does (team voice channel access, `/refresh`, `/config`) but is deliberately never pinged - see "Staff vs admin" below.
   - `PARTICIPANT_ROLE_ID` - optional. Role granted to every player on a completed registration, separate from per-team roles, for easier broad tournament permissions. Leave unset if you don't want this - the bot logs a notice on startup either way so it's clear whether it's active. Also settable at runtime via `/config participant-role`.
   - `FREE_AGENT_ROLE_ID` - optional. Role granted to a player who signs up via `/register`'s "I am a Free Agent" path instead of registering/joining a team. Same "unset is fine" treatment as `PARTICIPANT_ROLE_ID`, also settable at runtime via `/config free-agent-role`.
   - `TEAM_VC_CATEGORY_ID` - optional. Category channel ID a brand new team's private voice channel gets created under (visible/connectable to staff and that team's own role only, hidden from everyone else). Left unset, teams simply don't get a voice channel - same "notice either way on startup" treatment as `PARTICIPANT_ROLE_ID`. A returning team's channel is reused rather than duplicated (tracked via the `vc_channel_id` column - see the Google Sheet schema section), and if that channel was deleted since, a new one is created in its place. The welcome message posted in the channel the moment it's first created is only ever sent that once - not on later re-registrations - and is configurable via `TEAM_VC_WELCOME_MESSAGE` (`{team}` is replaced with the team name); a reasonable default is used if unset. Both are also settable at runtime via `/config team-vc-category`/`/config team-vc-welcome-message`.
   - `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET` - see "Google Apps Script setup" below, its own multi-step setup, not just an env var
   - `SHEETS_SYNC_INTERVAL_MINUTES` - optional, defaults to `60`. See "Local-first Sheets storage" below before changing this.
   - `STATLOCKER_API_BASE` - defaults to the real API, shouldn't need changing
   - `STATLOCKER_API_KEY` - statlocker.gg API key (see their `/api` page for how to request one)
   - `NEXTCLOUD_SHARE_URL` - optional. A Nextcloud public share link (`https://host/s/TOKEN`) pointing at a folder, with **"Allow upload and editing"** turned on for that share. When set, uploaded team logos get pushed there via WebDAV instead of only living as a Discord CDN link (which expires - see `src/services/nextcloud.js`). Each team gets exactly one file there, named after the team's current name (e.g. `team-alpha.png`) - re-uploading overwrites it in place, and a team rename or a replacement upload with a different extension renames/deletes the old file rather than leaving it behind, so the filename is always a reliable single source of truth for broadcast. Leave unset to keep using the Discord link as before (no dedupe/rename possible without a file server to do it on).
   - `NEXTCLOUD_SHARE_PASSWORD` - optional, only needed if the share above is password-protected
   - `NEXTCLOUD_PUBLIC_SHARE_URL` - optional. If the upload share above is password-protected, its files aren't freely viewable - anyone opening a `logo_url` link (e.g. another org) hits a password prompt instead of the image. Set this to a second, **view-only, no-password** share on that same Nextcloud folder, and that's the link that gets written into `logo_url` instead (specifically, a link through Nextcloud's preview endpoint - opens straight to the image in a browser rather than triggering a download) - uploads still go through the upload share above, this one is only ever used to build the URL that leaves the sheet. Leave unset to use the upload share for both (fine as long as it isn't password-protected, or you don't mind the recipient needing the password).

</details>

3. In the Discord Developer Portal, make sure the bot has the **Manage Roles** permission, and that its own role sits above any team roles it'll create (Discord won't let a bot assign/manage roles positioned above its own). Also enable the **Message Content Intent** (Bot tab, privileged intents section - same place as Server Members Intent) - needed for team logo uploads to work. `npm run deploy-commands` (registers `/register`, `/refresh`, `/config`, and `/update` to your guild - re-run only when command definitions change)

   **Also applies as of this version**: the `/config` command is new -
   re-run `npm run deploy-commands` after updating, or Discord won't show
   it yet. Its overrides persist to `config-overrides.json` (new file, next
   to `sessions.json`/`audit.log`) - nothing to set up, it's created
   automatically the first time an override is saved.
4. Optionally, populate the `PlayerDB` and/or `TeamDB` tabs manually with any past signup data you want preloaded - see "Player/Team history preload" below for the columns and how it's used. Leave them empty if you don't have this data yet; registration works fine either way.
5. `npm start` - or see "Running with Docker" below for a containerized alternative.

### Running with Docker

An alternative to steps 1 and 5 above, if you'd rather not install Node.js
directly on the host:

1. Run `npm run setup` (needs Node.js on the host just for this step, even
   though the bot itself will run in Docker) - or copy `.env.example` to
   `.env` and fill it in by hand as described in step 2 above.
2. `docker compose up -d --build`

Slash commands still need registering once (and again any time command
definitions change) - run `docker compose run --rm registration-bot npm run deploy-commands`.

Session/roster state (`sessions.json`, `sheets-snapshot.json`,
`pending-writes.json`, `audit.log`, `bot.lock`) persists in `./data` on the
host via a mounted volume, so it survives container rebuilds/updates. The
container restarts automatically on crash (`restart: unless-stopped`),
replacing the retry logic `start-bot.bat` handles for a non-Docker install.

### Updating remotely

To push a new version without connecting to the machine directly (e.g. over
SSH/console access only):

1. Grab the new release zip (e.g. from wherever it's shared - Dropbox, etc)
   and get it onto the server, in the bot's install directory.
2. Run `./update.sh <path-to-release-zip>`.

This backs up the current files to `backups/backup-<timestamp>/`, extracts
the new zip over the existing install, then rebuilds and restarts the
Docker container automatically. It never touches `.env` or `data/`, so
credentials and roster/session state are untouched by an update. If
something goes wrong, restore from the backup folder it created.

If you're running without Docker, the script installs the new
dependencies but you'll need to restart the `npm start` process yourself.

One-off maintenance scripts (`npm run post-event`, `npm run recover-ids`)
work the same way -
`docker compose run --rm registration-bot npm run <script>` - since they're
copied into the image alongside `src/`.

#### `/update` (Docker + git installs only)

An admin can run `/update` in Discord instead of doing any of the above by
hand. The bot can't rebuild/restart its own container from the inside (it
would kill itself mid-command), so `/update` just drops a request file in
`./data` - a separate script on the host has to be scheduled outside Docker
(cron, Unraid's User Scripts plugin, etc.) to actually notice it, check for
new commits, and (only if there are any) `git pull`, rebuild, and restart.

**That watcher script is intentionally not part of this repo.** It's the
one piece with real host access (git + Docker), so it's maintained
directly on the host, outside the update path it controls - a repo
compromise (or a compromised bot process) then can't rewrite the very
script that would execute its changes with host privileges on the next
update. If you're setting this up fresh, you'll need to write your own
watcher script (or ask whoever hosts this bot for theirs) - it assumes the
install directory is a `git clone` of this repo (via a read-only [deploy
key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)),
not something `update.sh`/a zip drop manages.

The watcher should check the actual git commit hash against GitHub before
doing anything else - if they already match, skip the rebuild/restart
entirely rather than causing a pointless outage to redeploy identical code,
and the bot posts an "already up to date" message instead. The commit hash
(not the `package.json` version number) is what's shown as proof either
way, since the version number is a human-typed label that's easy to forget
to bump - the hash is generated automatically for every commit and can't go
stale.

`ADMIN_ROLE_ID` must be set for `/update` to be usable at all - it's
deliberately gated on admin, not staff (see `commands/config.js`'s comment
on why those are kept separate).

### Google Apps Script setup

Sheets access goes through a small Apps Script web app bound to your sheet,
instead of a Google Cloud service account - no GCP project, no API
enablement, no JSON key file to guard.

1. Create the target Google Sheet.
2. In it, go to **Extensions > Apps Script**. Delete the default empty
   `Code.gs` content and paste in this repo's `apps-script/Code.gs`.
3. **Project Settings** (gear icon) > **Script Properties** > add:
   - `SHARED_SECRET` = any long random string. This is what stops strangers
     from hitting your web app URL - treat it like a password.
   - `STATLOCKER_API_KEY` (optional) = your statlocker.gg API key, only
     needed if you want to use `STATLOCKER_AVERAGE_PPSCORE(range)` as a
     sheet formula (e.g. `=STATLOCKER_AVERAGE_PPSCORE(Teams!C2:L2)` for a
     team's average ppScore at seeding time). Separate from the bot's own
     `STATLOCKER_API_KEY` env var - same key value works fine for both,
     they're just two different places it needs to be set.
   - `CONTROL_SHEET_ID` (optional) = a separate spreadsheet's ID, only
     needed for the roster-card broadcast feature - see "Migrating rosters
     to the Control Sheet" below. Skip this for now if you're not using
     that yet; nothing else depends on it.
4. Back in the editor, select `setupSheet` in the function dropdown (top
   toolbar) and click **Run**. First run will prompt you to authorize the
   script against your own Google account - approve it. This creates all
   required tabs with correct headers, and formats every `*_id` column as
   Plain Text (needed so 17-19 digit Steam/Discord IDs don't get silently
   rounded by Sheets treating them as numbers). Safe to re-run against a
   live, populated sheet: a tab is only ever written to if its header row
   is currently blank (new tab) or already matches `Code.gs`'s schema
   exactly - anything else (a customized column order, a still-on-an-
   older-schema-version tab, a `Code.gs` update that changed the schema)
   is left completely untouched and reported in the execution log instead,
   rather than silently rewritten. If a `Code.gs` update genuinely adds or
   drops a column and you want an already-set-up tab to pick that up, that
   means manually adding/removing the column in Sheets to match first (see
   that version's note at the top of `Code.gs`, e.g. v0.21.0 dropping
   `Teams`' `last_updated`) - `setupSheet` will then recognize the exact
   match and reformat it, but won't restructure it for you.
5. **Deploy > New deployment**, type **Web app**. Set **Execute as: Me** and
   **Who has access: Anyone**. Deploy, then copy the web app URL.
6. Put that URL in `APPS_SCRIPT_URL` and the same string you used for
   `SHARED_SECRET` in `APPS_SCRIPT_SECRET`, both in the bot's `.env`.
7. **File > New > Html file** in the script editor, name it exactly
   `ControlPanel`, and paste in this repo's `apps-script/ControlPanel.html`.
   Reload the spreadsheet - a **Tournament Admin** menu appears with an
   **Open Control Panel** item, a sidebar for running Send Rosters/Update
   Database/Clear Signups from inside the Sheet itself, no Discord or
   terminal needed (see "Migrating rosters to the Control Sheet" and
   "Migrating a finished event" below for what those actually do). No
   redeploy needed for this step - unlike the web app above, sidebar/menu
   changes take effect on the next spreadsheet load.

If you ever edit `Code.gs`, you need **Deploy > New deployment** again (or
"Manage deployments" > edit > new version) - saving the file alone doesn't
update a live web app deployment. **This applies now**, specifically: the
local-first storage change below added two new actions (`getAllTables`,
`replaceAllTables`) that an old deployment won't have - redeploy after
pulling in this version of `Code.gs`, or the bot will fail to start.

**Also applies as of v0.44.0**: request authentication changed from a bare
shared secret sent on every request to an HMAC signature + timestamp (same
`SHARED_SECRET` Script Property, no new setup needed) - see the doc comment
above `doPost` in `Code.gs`. Redeploy `Code.gs` alongside updating the bot
itself, or authenticated calls will start failing with `Unauthorized` (old
deployment expects `secret`, updated bot sends `signature`/`timestamp`
instead).

**Also applies as of this version**: `Teams` and `TeamDB` both gained a new
`vc_channel_id` column (see `TEAM_VC_CATEGORY_ID` above). On an
already-set-up sheet, `setupSheet` won't add this for you (see its doc
comment) - add the column by hand to both tabs, named exactly
`vc_channel_id`, positioned right after `logo_url` to match `Code.gs`'s
`SCHEMA`. Redeploy `Code.gs` after.

## Player/Team history preload

Two tabs in the same spreadsheet hold historical signup data staff maintain
by hand (e.g. imported from past events). The bot only ever reads them,
never writes - same "part of the local-first store" rules as every other
tab (see "Local-first Sheets storage" below), except that a staff edit to
either shows up on the next `/refresh` or background sync tick, not just a
bot restart (see "Crash safety" above).

### PlayerDB - one row per Statlocker/Steam ID

Columns: `account_id`, `discord_id`, `best_name`, `nationality`, `past_igns`,
`past_discord_names`.

- **nationality** - if known, the Player Nationality prompt is skipped
  entirely (same as when this player's already in `PlayerRegistry` from
  registering through the bot before) rather than asking every time. If it's
  not on file either place, the captain still gets asked.
- **best_name** is offered as a one-click "Use Player DB Name" choice
  alongside "Keep [statlocker name]" and "Set Custom" whenever a captain
  adds that player to a roster - never applied silently, since a captain
  (or the player) may want something different.
- **past_igns** is shown to the captain as context when the player is
  found.
- **discord_id** - if it resolves to someone actually in the current
  server, it's offered as a one-click linkage option ("Use `username`
  (Player DB match)") alongside the normal Tag/Skip choices. Never applied
  without that click.
- **past_discord_names** is informational only (not parsed for IDs - use
  the explicit `discord_id` column for that).

### Cross-team duplicate check

Whenever a player is added to a roster - manually via Add Player, or
preloaded from a TeamDB match - the bot checks `Teams` (current, live
rosters, not `TeamDB` history) for that account already being on a
*different* team. Manual add: rejected outright, captain sees which team
they're already on and is told to contact staff. TeamDB preload: that slot
is silently dropped from the imported roster rather than blocking the whole
import, and the captain is told which player was skipped and why.

### TeamDB - one row per historical team

Columns: `team_name`, `team_role_id`, `p1`-`p6` (main players' Steam IDs),
`s1`/`s2` (subs' Steam IDs), `c1`/`c2` (coaches' Steam IDs) - separate
columns rather than a combined sub-or-coach pair so staff data entry can't
mix the two up - plus `logo_url` (that team's logo from whichever past
event it last played, carried forward the same way as the roster columns -
see "Migrating a finished event") and `vc_channel_id` (that team's voice
channel, carried forward and reused the same way). **`team_role_id` is the Discord role
snowflake itself**
(that team's role from whichever past event it last played) - not an
arbitrary label. This is deliberately the exact same shape as `Teams`
below (see "Google Sheet schema") so post-event migration is a straight
row copy - see "Migrating a finished event" below.

When a captain runs `/register` and holds no *current-event* team role (i.e.
none of their Discord roles have a matching `Teams` row yet), the bot checks
every role ID they currently hold against TeamDB's `team_id` column - an
exact ID match, so there's no ambiguity from role naming. This only catches
a captain who still holds the literal role from a past event (e.g. it never
got re-registered as a `Teams` row for the new event); a deleted role has
nothing to match against. A single match
offers "sign this team up again?"; if they confirm, every Steam ID in that
row gets resolved (via `steam.js`) and looked up on statlocker.gg, enriched
with PlayerDB's `best_name`/`discord_id` where available, and dropped
straight into the roster editor for review - `logo_url`, if the row has one,
gets preloaded the same way and shows up on the roster editor immediately,
carrying forward without a re-upload unless the captain sends a new image.
`vc_channel_id`, if present and the channel still exists, is reused as-is
on commit rather than creating a new one.
Since the role already exists
and the captain already holds it, this commits the same way as editing any
other existing team (no new role to create, unlike a genuinely new team) -
the `Teams` tab row just gets created for that role if it doesn't already
have one. Multiple distinct role matches ping staff
instead of guessing. No match at all falls through to the normal "new team
/ join existing" prompt.

**Setup:** `setupSheet()` (see below) creates the `PlayerDB` and `TeamDB`
tabs and their headers along with everything else - no separate deployment
or env vars needed, since they're part of the same spreadsheet/Apps Script
deployment as `PlayerRegistry`/`Teams`/etc.

## Crash safety

`SHEETS_SYNC_INTERVAL_MINUTES` (default 60) is how often the local store
actually reaches Google Sheets. A clean shutdown (`Ctrl+C`, `SIGTERM`)
always flushes first - but an ungraceful crash (killed process, OOM, power
loss, terminal window closed) in between syncs would otherwise lose
anything committed since the last one.

Recovery from that is automatic: every completed registration commit is
queued in `pending-writes.json` (see `src/utils/pendingWrites.js`), and it
stays queued until a `sheets.flush()` actually confirms it reached the real
Google Sheet - not just until it's applied to the bot's local in-memory
copy, which happens instantly and proves nothing about durability. On
startup, anything still queued gets replayed against the freshly-pulled
local store, then flushed to Google Sheets immediately - both
`teams.createTeam`/`updateTeam` and `registry.upsertPlayer` are idempotent,
so replaying an already-synced job is harmless.

A narrower crash window exists earlier than that: a commit's Discord role/
voice-channel/logo changes happen before the roster is known to be fully
resolved (e.g. before a new voice channel's ID is known), so a crash during
that window isn't a completed job yet. A lightweight *intent* record
(which team, which thread - not a full job) is saved before any of that
Discord work starts, specifically so this window still leaves a trace
instead of nothing. This intent isn't auto-replayed on startup (see
"Finishing registration" below for why), but a leftover one is detected and
flagged to staff in the relevant thread.

`sheets-snapshot.json` (written after every commit, plus a
`LOCAL_SNAPSHOT_INTERVAL_MINUTES` timer, default 2, as a backstop for
anything not tied to a commit) is a secondary, manual-only fallback for
anything the queue above can't cover - it's local disk I/O, not a network
call, so it adds no noticeable delay. It's **never read back
automatically**; if you ever need it, open `sheets-snapshot.json` and
re-enter whatever it has that the real sheet and `pending-writes.json` both
don't.

## Local-first Sheets storage

Every read/write used to be its own Apps Script HTTP round trip. Correct,
but slow enough that opening the roster-edit menu or saving one could take
minutes with a full roster (see "Performance" below for the earlier,
partial fix). This is the real fix: at startup, the bot pulls the **entire**
spreadsheet into memory once (`sheets.init()`, via the new `getAllTables`
action) and every read/write for the rest of that run happens against that
local copy - no network call, no latency. The local copy gets pushed back
up to the real Google Sheet (`replaceAllTables`) right after every
completed registration commit, on a timer as a backstop
(`SHEETS_SYNC_INTERVAL_MINUTES`, default 60), and once more on a clean
shutdown (`Ctrl+C` / `SIGTERM`) so a deliberate restart doesn't lose
anything.

`flush()` calls themselves are serialized against each other - the
background sync timer, `/refresh`, and the post-commit push that follows
every registration all call `sheets.flush()` without waiting for each
other, so `flush()` chains every call onto one internal queue rather than
letting two `replaceAllTables` pushes run in parallel. That's specifically
so an older snapshot can never land *after*, and silently clobber, a newer
one, and so a write that lands while a push is already in flight gets its
own follow-up push instead of being folded into "nothing changed" once
that in-flight push resolves. See `flush()`/`doFlushOnce()` in `sheets.js`
(a generation counter on top of the queue does the second half of that)
and `test/sheets.test.js` for the regression tests.

This trades strict consistency for speed, on two assumptions specific to
this setup - re-check both before reusing this pattern elsewhere:

- **Nothing else edits this spreadsheet while the bot is running**, with
  one exception: you can freely reorder a tab's columns, or insert your
  own columns (e.g. a `PPscore` formula) anywhere, including between two
  of the bot's own - writes are matched to columns by header name, not
  position (see `replaceAllTables_` in `Code.gs`). Editing *values* the
  bot owns mid-session, deleting/renaming one of its columns, or adding a
  new *data* row by hand is still unsafe: the bot's local copy is
  authoritative once loaded, so a value edit gets silently overwritten by
  the next sync, and a missing/renamed column makes that sync fail
  outright (loud error, not silent) until the header's restored or
  `setupSheet()` is re-run.
- **A crash between syncs can still lose non-commit writes.** Every
  *completed registration commit* is durable now (see "Crash safety"
  above) - it's queued to `pending-writes.json` before the write even
  starts, survives a full process crash, and replays automatically on the
  next startup. What's **not** covered by that queue is any other local
  write this store makes outside a commit - specifically, the
  `PlayerRegistry` name/identity update that happens each time a captain
  adds or edits a player while still building their roster, before they've
  clicked Finish (see `registry.upsertPlayer` in `registrationFlow.js`).
  Those writes only exist in this process's memory until the next sync (or
  clean shutdown) pushes them up - a crash before that sync loses them from
  the Sheet's perspective, silently, with nothing queued to replay. This
  was an accepted trade-off for a single-operator setup on a machine that's
  reliably kept running, and the actual data at risk is narrow (a
  statlocker-name/nationality touch-up gets silently skipped rather than a
  whole registration) - but it's real. If that stops being an acceptable
  risk, the fix is extending the same commit-intent pattern to cover these
  writes too, or a shorter sync interval (cheap, only narrows the window).

Worth knowing: `pendingWrites.js` (the retry queue for background Sheets
writes after a captain's registration is confirmed - see "Performance"
below) is now largely redundant. It exists to smooth over Apps Script
network latency in the critical path of finishing a registration; with
local-first storage, those writes are just in-memory operations and
essentially instant regardless. It's harmless to leave as-is (still
functionally correct, just no longer providing much benefit), but it's a
candidate for simplification if you want less moving parts - ask if you'd
like that done as a follow-up rather than assuming.

### Steam ID formats

No Steam Web API key is used, so **vanity profile URLs** (`steamcommunity.com/id/somename`) can't be resolved automatically - captains need to submit one of:
- SteamID64 (e.g. `76561198083228566`)
- A numeric profile URL (`steamcommunity.com/profiles/76561198083228566`)
- SteamID2 (`STEAM_0:0:12345678`) or SteamID3 (`[U:1:12345678]`)
- Their bare account ID / "friend code" (Steam client > Friends > Add a Friend)

Worth mentioning this in your announcement post - the bot's error message covers it too, but a heads-up up front saves captains a failed attempt.

## Google Sheet schema

Create these tabs with these exact header rows (order doesn't matter, names do):

**PlayerRegistry**
| account_id | discord_id | display_name | nationality | statlocker_username | historical_names |
|---|---|---|---|---|---|
One row per known player, keyed by `account_id` - the Steam "account ID" /
"friend code" (32-bit), which is also exactly the ID statlocker.gg uses in
its own profile URLs. Captains can submit any Steam ID format (SteamID64, a
profile URL, SteamID2/3, or the bare account ID itself) and it's normalized
down to `account_id` automatically - see "Steam ID formats" below.
Deliberately does **not** store ppScore/MMR - it's a dynamic value that goes
stale between registration and the tournament actually starting, so
recording it here would just be wrong data by the time it matters. Look it
up fresh (e.g. via your own statlocker tooling) using `account_id` at the
point you actually need it, such as seeding. `nationality` is stored as an
ISO alpha-2 code (e.g. `AU`) for the Liquipedia-style roster export.
`historical_names` is currently just seeded with the first name seen (see
"Known gaps" - not yet appended to on change). `display_name` is optional
and only overrides what's *shown* on rosters (e.g. for inappropriate
statlocker names) - `statlocker_username` is left untouched underneath so
rename detection keeps working correctly. This is pure player identity -
**no team/roster fields live here** (see `Teams` below for that). This is
only meant to hold state for the currently-running event; once it wraps,
rows get migrated to `PlayerDB` by staff and this tab starts fresh for the
next event (see "Migrating a finished event" below) - same lifecycle as
`Teams`.

**Teams**
| team_role_id | team_name | logo_url | vc_channel_id | p1 | p2 | p3 | p4 | p5 | p6 | s1 | s2 | c1 | c2 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
`p1`-`p6` (mains), `s1`/`s2` (subs), `c1`/`c2` (coaches) hold that slot's
`account_id` - **this is the single source of truth for current roster
membership**, there's no separate per-player roster/join tab. A role only
"counts" as a team role (e.g. for detecting a captain's existing team on
`/register`) once it has a row here - see `teams.getMemberTeamRoleIds`. A
player not currently in the server still gets their role the moment they
join - see `teams.applyRoleOnJoin`, which resolves their `account_id` from
`PlayerRegistry` by `discord_id`, then checks live which Teams row (if any)
currently lists that `account_id`, rather than a separate queue. `vc_channel_id`
is the team's private voice channel (blank until one is created - see
`TEAM_VC_CATEGORY_ID` above); a returning team's channel is reused rather
than re-created, same carry-forward logic as `logo_url`. This tab
is deliberately the same shape as `TeamDB` (right down to matching column
names) specifically so post-event migration is a straight row copy - see
"Migrating a finished event" below. This is only meant to hold state for
the currently-running event; once it wraps, rows get migrated to `TeamDB`
by staff and this tab starts fresh for the next event.

**FreeAgents**
| account_id | discord_id | display_name | nationality | statlocker_username | wants_team |
|---|---|---|---|---|---|
One row per player who signed up via `/register`'s "I am a Free Agent"
path (`promptNewOrJoin` in `registrationFlow.js`) instead of registering or
joining a team - no roster slot, no team role, no voice channel. `wants_team`
is `Yes`/`No` - whether they asked staff to try assigning them to a team, or
they only want to be available as an emergency substitute. Keyed by
`account_id` same as everywhere else - re-registering as a free agent updates
the existing row rather than adding a duplicate. Player identity itself
(name/nationality/Discord link) is still also written to `PlayerRegistry` as
usual, same as a rostered player. The "I am a Free Agent" button itself can
be hidden entirely (e.g. for an event that isn't taking free agents) by
setting `FREE_AGENT_SIGNUP_ENABLED=false` - existing free agents and their
data are untouched, this only stops new sign-ups. Same lifecycle as `Teams`
and `PlayerRegistry`: this only holds the currently-running event's free
agents, and rows get migrated to `PlayerDB` by staff once the event wraps
(see "Migrating a finished event" below).

#### Migrating a finished event

Once signups close, `Teams`' `p1`-`p6` columns being live account_ids
(rather than buried in a per-player tab) is also what makes an average
ppScore per team easy to compute directly against the sheet - a formula or
script reading columns straight off `Teams`, same as you've done against
`TeamDB` in past events. When you're ready to archive:

1. Run whatever per-team lookup (ppScore or otherwise) you want recorded,
   reading straight off `Teams`' `p1`-`p6`.
2. Stop the bot, then run `npm run post-event` (add `-- --yes` to skip the
   confirmation prompt, or `-- --label=some-name` to control the archived
   log's filename). This is a convenience wrapper around two independent
   steps - each is also safe to do on its own if you only want one:
   - Calls the Apps Script web app's `migrateFinishedEvent` action, which
     copies `Teams` into `TeamDB` (matched by `team_role_id`; an existing
     team's row is updated in place rather than duplicated) and both
     `PlayerRegistry` and `FreeAgents` into `PlayerDB` (matched by
     `account_id`; any name/Discord ID change is archived into
     `past_igns`/`past_discord_names` rather than lost - an account present
     in both source tabs still merges into a single `PlayerDB` row). Only
     writes to `TeamDB`/`PlayerDB` - `Teams`, `PlayerRegistry`, and
     `FreeAgents` are all untouched, so it's safe to re-run. Requires the
     Code.gs deployment to include this action - redeploy (Manage
     deployments > edit > new version) after pulling in a `Code.gs` version
     that added it. `migrateTeamsToTeamDB()`,
     `migratePlayerRegistryToPlayerDB()`, and `migrateFreeAgentsToPlayerDB()`
     remain callable individually from the Apps Script editor too, same as
     before.
   - Archives `audit.log` locally (renamed to `audit-<label>.log`, not
     deleted) so a new one starts clean for the next event.
   The two steps are deliberately independent - if the Sheets migration
   fails, the log still gets archived (with a clear note in the output),
   rather than one failure blocking the other.
3. Clear `Teams`' and `PlayerRegistry`'s data rows (below the header) for
   the next event - still a manual step; nothing here deletes real signup
   data on its own. Only run this after step 2, since step 2 is what
   archives both tables into `TeamDB`/`PlayerDB` first - clearing before
   that would lose data with no undo. **Known gap:** clearing
   `PlayerRegistry` currently breaks returning-player detection on
   Discord rejoin (see `findPlayerByDiscordId` in `src/services/
   registry.js`) - that lookup hasn't been repointed at `PlayerDB` yet.

Restart the bot after (step 2's Sheets migration doesn't need its own
redeploy beyond the one-time `Code.gs` update above, but the bot's
`PlayerDB`/`TeamDB` local copy needs a refresh either way, which either a
restart or `/refresh` picks up).

**Flags**
| timestamp | type | account_id | on_file_name | new_name | tournament | raised_by | resolved |
|---|---|---|---|---|---|---|---|
Written automatically when a player's statlocker username no longer matches
what's on file - review and update `PlayerRegistry` manually, then mark
`resolved` = `TRUE`.

#### Migrating rosters to the Control Sheet

You design the roster card yourself, directly on a `Template` tab inside
the Control Sheet - real cell formatting, merged cells, colors, an
`=IMAGE(...)` formula for the logo, whatever you want - using `{{tag}}`
placeholders where real data should go. Draw that block as many times as
you like (side-by-side, stacked, or both) to show how you want teams
tiled across the page; number each copy's top-left cell `{{#1}}`,
`{{#2}}`, `{{#3}}`... in fill order. The sidebar's "Preview Layout" /
"Send Rosters" buttons (or `previewRosterTemplate()` /
`sendRostersToControlSheet()` from the Apps Script editor) infer
direction (row-major/column-major), wrap point, and gutter purely from
how those numbered blocks are arranged, then tile real copies of block
`{{#1}}` across the `Rosters` tab - one per team, tags substituted with
real data. Always **Preview Layout first** - it's a full dry run with
placeholder text (`Team 1`, `Player 3`, `NAT`, ...) instead of real
data, run through the exact same validation as a real send, so a clean
preview means the real send will succeed too. Never writes to the
`Template` tab itself.

Tag vocabulary (case-insensitive, tolerant of surrounding whitespace -
`{{Team_Name}}` and `{{ team_name }}` are both fine):

| Tag | Resolves to |
| --- | --- |
| `{{#1}}`, `{{#2}}`, ... | Block anchor - required once per example block, top-left cell. |
| `{{team_name}}` | Team name. Required at least once somewhere in the block. |
| `{{seed}}` | Seed number - blank if "Include seeding" is off. |
| `{{captain}}` | Captain's name - see the callout below before using this one. |
| `{{logo}}` | Team logo URL (plain text). Point an `=IMAGE(...)` formula at that same cell to render it - the formula's relative reference shifts automatically as the block is copied per team, no extra setup needed. |
| `{{player}}` | Main roster slot, positional - write it 6 times; 1st found (reading top-to-bottom then left-to-right) = player 1, etc. |
| `{{player_1}}`–`{{player_6}}` | Main roster slot, explicit. Use this instead of `{{player}}` if reading order wouldn't resolve your layout correctly - don't mix both styles in one block. |
| `{{sub/coach}}` | Sub/coach slot, positional - write it exactly 2 times. |
| `{{sub_1}}`, `{{sub_2}}` | Sub/coach slot, explicit - same don't-mix rule as players. |
| `{{nationality}}` | Nationality for whichever player/sub-coach slot is on the same row. |
| `{{role}}` | "Sub" or "Coach" for whichever sub/coach slot is on the same row - not valid on a main-roster row. |

Multiple tags (and literal text) can share one cell, e.g.
`"Seed {{seed}} - {{team_name}}"` or `"{{player}} - {{nationality}}"`.
Need a literal `{{`/`}}` in the output? Double the braces:
`{{{{`/`}}}}` renders as a literal `{{`/`}}`. Tags inside a formula
aren't supported (only plain cell text) and fail validation clearly if
you try.

**`{{captain}}` needs a `captain_account_id` column added to `Teams`
that you populate yourself** - this bot doesn't track who's captain
today (only the Discord session that ran `/register` knows that, and it
isn't written anywhere). Using `{{captain}}` in your template without
that column is a validation error, not a silent blank.

One-time setup: Project Settings > Script Properties > add
`CONTROL_SHEET_ID` set to the Control Sheet's spreadsheet ID (the long
string in its URL between `/d/` and `/edit`) - same place as
`SHARED_SECRET`, not a `Code.gs` edit.

Before running: sort `Teams` into seed order yourself first - the script
just uses row order, there's no separate seed column. `Teams`' logo_url
is passed straight through as `{{logo}}`'s value (no more built-in
Nextcloud preview→download conversion - point your own `=IMAGE(...)`/
link formula at whatever `logo_url` actually contains). Deliberately
never writes `team_role_id`, any Discord ID, or any account_id to the
Control Sheet, since it goes public once the event ends.

A blank `Teams` row (no team_name, no roster, no logo) is skipped
entirely now rather than becoming an empty placeholder card - seed
numbers still count the gap, so seeding stays aligned, but there's no
"leave a gap, paste the team in later" grid slot the way the old layout
had. Two blank rows in a row are read as "no more real data below" and
stop the scan there, same as before. A team with more sub/coach entries
than your template has `{{sub/coach}}`/`sub_N` slots for (more than 2)
fails validation rather than silently dropping the overflow - trim the
roster or add slots to the template.

Formatting on the `Rosters` tab is fully rebuilt from the `Template`
block on every run (real cell/format copy, not hand-preserved) - don't
rely on manual formatting surviving a re-run there the way the old
layout let you.



### Migrating existing data (SteamID64 → account_id)

If your sheet already has registrations from before this switch, run
`migrateSteamIdToAccountId()` once from the Apps Script editor (function
dropdown, click Run) - it converts existing SteamID64 values to account_id
in place, renames the column, and drops the now-unused `mmr` column. Then
run `setupSheet()` to make sure headers/formatting are fully in sync. If you
only have test data you don't mind losing, it's simpler to just clear
`PlayerRegistry`/`Flags` and run `setupSheet()` fresh instead.

### Migrating existing data (PlayerRegistry/PlayerDB column cleanup, 20260815)

If your sheet still has the pre-20260815 column layout, run
`migratePlayerColumnOrder()` once from the Apps Script editor - it drops
`PlayerRegistry`'s unused `last_synced` column and reorders both
`PlayerRegistry` and `PlayerDB` to the current SCHEMA order in place. Then
run `setupSheet()` to reapply formatting. Note down any columns you've
added yourself to either tab first - anything not in SCHEMA gets dropped.

## Performance: fast initial render, background Sheets writes

Two places were slow because they blocked on Apps Script HTTP round trips
before showing the captain anything:

- **Opening the thread.** Holding a team role is checked from Discord's own
  role cache (instant), but the old flow then waited on a full Sheets fetch
  (team row + every roster slot's registry lookup) before posting anything.
  Now, the moment a team role is detected, the Sheets fetch is kicked off in
  the background (not awaited) and the captain immediately gets an
  **Edit Team** / **I'm Not On This Team** prompt. By the time they click,
  the fetch has usually already resolved, so "Edit Team" is near-instant in
  practice. That fetch itself also got cheaper: player lookups used to be
  one Apps Script round trip *per roster slot*; now the whole
  `PlayerRegistry` table is fetched once (`registry.getPlayersMap`) and each
  player is looked up from that in memory. "I'm Not On This Team" doesn't
  need that fetch at all - it just strips the role from whoever clicked the
  button (not necessarily the team's original registered captain, if this
  role ended up on someone else) and starts an independent new-team
  registration; that old team's roster/Sheet data is never touched, since
  the team continues to exist for whoever else is on it. There's
  deliberately no one-click "wipe this team's roster" option - players are
  removed one at a time via Discard on the panel. The team-name shown in
  this prompt is a placeholder derived from the Discord role's own name -
  "Edit Team" corrects it to the real `team_name` once the fetch resolves.
- **New team role creation.** Same idea applied to role creation: the
  Discord role itself is created immediately (no Sheets dependency), the
  captain is told it's done, staff get pinged in the same message as every
  other completed registration, and the `Teams` row for that new role gets
  written as part of the same background job as the rest of the commit (see
  below).
- **Finishing registration.** Discord role changes now happen first and the
  captain is told "done" immediately - that's the part they can actually see
  and the part that matters for being let into the tournament. The Sheets
  write (Teams/PlayerRegistry rows) happens afterward, detached from
  the interaction, so the captain isn't stuck waiting on Apps Script. A
  commit *intent* (which team, which thread) is written to
  `pending-writes.json` (gitignored, local) *before any of that Discord role/
  voice-channel/logo work starts* - not just before the Sheets write - so a
  hard crash (killed process, OOM, host reboot) at any point after Finish is
  clicked leaves a durable trace that this commit was interrupted, not
  nothing. That intent record is upgraded in place to the full write job
  (roster, resolved logo/VC) once the Discord side effects finish, and it's
  removed from the queue the moment the Sheets write actually succeeds. On
  the next startup, any commit that never made it past the intent stage gets
  flagged to staff in its thread rather than replayed automatically - role
  changes are safe to blindly redo, but voice-channel creation isn't (no way
  to tell if one was already created before the crash), so recovering from
  one of these is a manual step: check Discord, then either re-run
  `/register` or fix it by hand. Roles being live before the sheet write
  lands means there's still a brief window where Discord and the sheet
  disagree even on the happy path - acceptable for a personal-use tool, but
  worth knowing about if you ever build automation that trusts the sheet as
  always-current.

## New team role creation

When a captain registers a **brand new** team, the bot creates the Discord
role itself immediately on "Finish Registration" - no staff approval step.
If the roster was preloaded from a Team Database name match (see
"Player/Team history preload" below), it re-grants that team's original
role instead of creating a duplicate, when the role still exists.

There is no staff gate on registration at all, new or existing team -
`STAFF_ROLE_ID` is pinged in the thread once a registration completes, not
before, so staff have a record of every signup without having to act on
each one.

## Team voice channels

If `TEAM_VC_CATEGORY_ID` is set (see Setup above), the bot also creates a
private voice channel for a team the first time it commits - hidden from
`@everyone`, visible and connectable only to `STAFF_ROLE_ID`/`ADMIN_ROLE_ID`
and the team's own role. The channel welcomes the team with
`TEAM_VC_WELCOME_MESSAGE` (`{team}` → team name) - but only that once, at
creation; a returning team whose channel is still on file (`vc_channel_id`
on `Teams`/`TeamDB`) just reuses it silently on every later commit. If that
channel was deleted since, a new one is created (and welcomed again) in its
place.

## Staff vs admin

`STAFF_ROLE_ID` and `ADMIN_ROLE_ID` grant identical permissions everywhere
in the bot (team voice channels, `/refresh`, `/config`) - the only
difference is pings. `STAFF_ROLE_ID` gets pinged
on every completed registration and whenever the bot needs manual
intervention; `ADMIN_ROLE_ID` never does. Use `ADMIN_ROLE_ID` for people who
should have full access but don't want the notification noise. Both are
optional to set as a list (comma-separated), and `ADMIN_ROLE_ID` is optional
to set at all - leave it unset if you don't need the distinction.

## Staff commands

- `/refresh` - staff-only. Registration commits already push themselves to
  Google Sheets right away (see "Local-first Sheets storage"), so this is
  mainly for forcing a re-download of `PlayerDB`/`TeamDB` after a staff
  edit, or checking that a push actually landed while testing, without
  waiting for the next `SHEETS_SYNC_INTERVAL_MINUTES` tick. Also re-downloads
  PlayerDB and TeamDB from the Sheet (same as the periodic background sync
  now does), so a staff edit to either shows up without a bot restart -
  neither tab is ever included in the push, since the bot never writes to
  them (see "Player/Team history preload" below). Reports a warning if
  either tab's header row doesn't match what the bot expects. Can take a
  while (the same Apps Script round trip `SHEETS_SYNC_INTERVAL_MINUTES`
  normally hides from you) - the bot defers its reply and edits it in once
  done.

- `/config` - staff/admin. Changes a hand-picked set of Discord-side
  settings at runtime, no `.env` edit or restart needed: `registration-channel`,
  `participant-role`, `free-agent-role`, `team-vc-category`,
  `team-vc-welcome-message` (each takes the new value directly -
  channel/role ones use Discord's native picker so only a real channel/role
  of the right type can ever be chosen), `view` (current value of all five,
  and whether each is overridden or still at its `.env` default), and
  `reset` (revert one setting back to its
  `.env` value). Every change is written to `audit.log` (before/after
  value, who made it). Overrides persist in `config-overrides.json` next to
  `sessions.json`/`audit.log` - delete that file (or `/config reset` each
  field) to fall back to `.env` entirely.

  This is deliberately **not** "every env var" - `DISCORD_TOKEN`,
  `APPS_SCRIPT_SECRET`, `STATLOCKER_API_KEY`, `NEXTCLOUD_SHARE_PASSWORD`,
  and the Nextcloud share URLs (which embed an access token) can never be
  shown or changed through this command; neither can `DISCORD_CLIENT_ID`/
  `DISCORD_GUILD_ID` (so `/config` can never be used to point the bot at a
  different server); neither can `STAFF_ROLE_ID`/`ADMIN_ROLE_ID` (so nobody
  - staff or admin - can grant or strip access, their own or anyone else's,
  through this command). All three exclusions are structural: those fields
  simply aren't representable as a `/config` subcommand, not filtered by
  checking who's asking.

## Testing

`npm test` runs the unit test suite (`test/`, using Node's built-in test
runner - no extra dependency). Covers the pure-logic modules where a wrong
answer would be hardest to notice live and easiest to break silently while
editing: fuzzy team-name matching (`teamNameMatch.js`), Steam ID resolution
(`steam.js`), roster column packing/unpacking (`teams.js`), and TeamDB's
exact/fuzzy/ambiguous name lookup (`teamDB.js`). Doesn't touch Discord,
Sheets, or statlocker.gg - `teamDB.test.js` stubs `services/sheets.js`'s
`getTable` in-process rather than hitting the network (see that file's own
comment for how/why); the same technique is the quickest way to extend
coverage to another `sheets`-backed module without standing up a real Apps
Script deployment.

Not covered (and not planned as unit tests): `registrationFlow.js`,
Discord role reconciliation, and the Apps Script side - those are
integration surface, not pure logic, and worth a manual dry run (see
"Known gaps" item 6) rather than mocking Discord.js/Sheets end-to-end for a
bot this size.

## Known gaps / TODO before going live

1. **Sessions persist to `sessions.json`** in the project root (gitignored -
   contains in-progress roster data). Survives bot restarts. If you ever move
   to running multiple bot instances/processes, this file-based approach
   won't work across instances and would need to move to a real datastore -
   not a concern for a single-process deployment.
2. **`historical_names` isn't appended to yet** - currently just seeded once.
   Low priority since name changes are flagged to staff anyway rather than
   auto-applied.
3. **Nationality is only collected for new/replaced roster slots.** Existing
   players kept as-is (`status: keep`) on a returning team aren't prompted,
   so anyone who registered before this field existed may have a blank
   `nationality` in `PlayerRegistry` until they're next added/renamed
   somewhere, or you backfill it manually.
4. **Team names must be unique** (case-insensitive) across active teams -
   enforced at commit time. A captain keeping their own team's existing name
   won't false-positive against themselves.
5. **Abandoned registration sessions auto-expire after 48h** - purged on bot
   startup, with the thread notified and archived. Adjust the threshold in
   `sessions.purgeStale()` if needed.
6. **Confirm the live-API paths work before your first real event** -
   recommend a dry run in a test server/sheet first. In particular, verify
   the bot's role position and Manage Roles permission are correct, and
   check the startup log for the `PARTICIPANT_ROLE_ID`/`TEAM_VC_CATEGORY_ID`
   notices to confirm they're configured the way you intend, before your
   first real new-team registration.
7. **Emergency day-of subs** are explicitly out of scope for this bot (per
   your earlier note) - handle those manually as before.
8. **No `.gitignore` / no version control yet.** This is currently
   distributed as a zip, not a repo - if/when it moves to one, `.env`,
   `sessions.json`, `pending-writes.json`, `config-overrides.json`, and
   `audit.log` all need to be excluded before that happens (all contain
   secrets or per-deployment runtime state, none belong in source control).
9. **"Existing team across past events" is now covered by TeamDB** (see
   "Player/Team history preload" above) for captains who still hold the
   literal Discord role from a past event. It does NOT cover a captain whose
   old role was deleted/never assigned to them - that's still a manual staff
   case.
10. **Background Sheets writes create a brief consistency window.** Discord
    roles are applied and the captain is told "done" before the sheet write
    happens (see "Performance" above). If the bot crashes between those two
    steps, the write sits in `pending-writes.json` until the bot restarts and
    retries it automatically. If you need the sheet to reflect reality
    *immediately* (e.g. testing, or about to run a seeding script), run
    `/refresh` rather than checking `pending-writes.json` by hand.
11. **Registration actions are logged to `audit.log`** (gitignored, project
    root - one JSON line per button click/modal submit/commit/logo upload,
    with actor id/tag and timestamp) and echoed to the console. Append-only,
    no rotation - `npm run post-event` (see "Migrating a finished event")
    archives it between events, or do it by hand if you just want that part.
12. **Apps Script request signing covers `action`+`timestamp`, not the rest
    of the payload.** A captured valid request's `tab`/`row`/`tables` fields
    could in principle be altered after signing without invalidating the
    signature, and there's no nonce/replay cache, so a captured request stays
    valid for the rest of its 5-minute signature window. Left as-is for now:
    the shared secret never goes on the wire and this is a single-operator
    deployment, not a public endpoint, so the realistic exposure is low
    relative to the complexity of canonicalizing a payload signature (and a
    replay cache) across Node and Apps Script. Worth revisiting if the
    deployment model ever changes (e.g. more than one API consumer, or the
    web app URL becoming less contained).

## Project structure

```
QUICKSTART.md             New-install checklist, no explanations
apps-script/
  Code.gs                 Apps Script web app - lives in the Sheet, not run by node
src/
  index.js              Bot entry point, event wiring
  config.js              Env var loading
  deploy-commands.js     Registers slash commands to your guild
  commands/
    register.js           /register command definition
    refresh.js             [Staff] /refresh - force-push local store to Google Sheets
    config.js               [Staff/Admin] /config - runtime-editable settings allowlist
  flows/
    registrationFlow.js   All thread-based registration logic
  services/
    sheets.js              Calls the Apps Script web app for sheet reads/writes
    steam.js                Steam ID normalization/resolution
    statlocker.js           statlocker.gg lookup (API key required - see setup)
    registry.js              PlayerRegistry CRUD + name-mismatch flagging
    teams.js                  Teams CRUD + Discord role reconciliation
    runtimeConfig.js          /config's persistence layer + allowlist
  utils/
    sessions.js              Persisted per-thread registration state
    validation.js            Nationality validation/normalization
    pendingWrites.js         Local retry queue for failed background Sheets writes
    instanceLock.js          Single-instance PID lock (see index.js's main())
test/
  teamNameMatch.test.js  Fuzzy team-name matching
  steam.test.js            Steam ID resolution
  teams.test.js             Roster column packing/unpacking
  teamDB.test.js           TeamDB name lookup (stubs services/sheets.js)
scripts/
  postEvent.js             `npm run post-event` - migrate + archive audit.log
  setup.js                    `npm run setup` / run-setup.bat - interactive .env generator
  run-setup.ps1               Windows wrapper run-setup.bat calls into
```
