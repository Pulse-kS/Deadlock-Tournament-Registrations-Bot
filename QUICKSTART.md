# Quickstart

For a TO setting this up for the first time. This is the shortest path to
a running bot - no explanations, no edge cases. See `README.md` for the
"why" behind any step, Docker, remote updates, historical player/team
data preload, or the Control Sheet roster-card feature (all optional,
none needed to get the bot running).

Steps are ordered to cut down on tab-switching - each phase does
everything it can in one place before moving on. Before you start, grab
a Statlocker.gg API key from their `/api` page - it's asked for partway
through step 3 and setup can't finish without one.

## 1. Discord Developer Portal

1. [Discord Developer Portal](https://discord.com/developers/applications)
   > **New Application**.
2. **Bot** tab > **Reset Token** > copy it - you'll paste it into the
   setup script in step 3.
3. Still on the **Bot** tab, enable **Message Content Intent** AND
   **Server Members Intent** (privileged intents section) - the bot
   won't start without both.

## 2. Google Sheet

Leave this tab open when you're done - you'll come back to it in step 4.

1. Create a new Google Sheet.
2. Go to **Extensions > Apps Script**. Delete the default `Code.gs`
   content and paste in this repo's `apps-script/Code.gs`.
3. Pick `setupSheet` from the function dropdown (top toolbar) and click
   **Run**. Approve the authorization prompt. This creates all the tabs
   the bot needs.
4. **Deploy > New deployment**, type **Web app**. Set **Execute as: Me**
   and **Who has access: Anyone**. Deploy, then copy the web app URL -
   you'll need it in the next step.
5. **File > New > Html file**, name it exactly `ControlPanel`, and paste
   in this repo's `apps-script/ControlPanel.html`. Reload the spreadsheet -
   a **Tournament Admin** menu should appear.

Don't touch Script Properties / `SHARED_SECRET` yet - the setup script
generates that value, not you; setting it now would just mean redoing it.

## 3. Run the setup script

- **Windows**: double-click `run-setup.bat` (installs Node.js for you if
  it's missing).
- **Mac/Linux**: `npm install`, then `npm run setup`.

Paste your bot token when asked. If the bot isn't in a server yet, it
prints a ready-to-click invite link - click it, invite the bot, then
**while Discord is still open**: Server Settings > Roles, drag the bot's
own role above any team roles it'll create (do this now, it's easy to
forget later). Then come back and answer the rest of the script's
questions (server, registration channel, staff role, Statlocker key) -
including the Apps Script URL, which you already have from step 2.4.

At the end it generates a shared secret and copies it to your clipboard -
you'll paste that in step 4 next.

## 4. Back to the Google Sheet

Switch back to the Apps Script tab you left open in step 2.

1. **Project Settings** (gear icon) > **Script Properties** > add
   `SHARED_SECRET` = paste the value the setup script just copied to your
   clipboard.

## 5. Finish and start

Double-click `start-bot.bat` - it syncs slash commands and starts the bot
in one go, no terminal needed. (Mac/Linux: `npm start`, and run `npm run
deploy-commands` first if this is a fresh setup or you've updated the
bot's commands.)

Run `/register` in your registration channel to confirm it works.

## Something not working?

See the README's "Known gaps / TODO before going live" section, or run a
test registration in a spare server/sheet before opening real signups.
