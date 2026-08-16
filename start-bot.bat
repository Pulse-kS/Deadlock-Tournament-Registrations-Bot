@echo off
REM start-bot.bat version: 1.1
cd /d "%~dp0"

REM Syncs slash commands once per launch (not on every auto-restart below -
REM see MAX_FAST_CRASHES loop) so updating to a new bot version never
REM requires anyone to open a terminal or know `npm run deploy-commands`
REM exists. Deliberately doesn't block startup on failure: deploy-commands.js
REM shares config.js's env validation with the bot itself, so a real config
REM problem will fail npm start moments later with a clearer error anyway -
REM and a transient Discord hiccup here shouldn't stop an already-working
REM bot from running with its last-known command set.
echo Syncing slash commands...
call npm run deploy-commands
if not "%ERRORLEVEL%"=="0" (
  echo.
  echo Command sync failed - continuing anyway, see npm start below for details.
  echo.
)

REM Auto-restarts the bot if it exits with an error, rather than just
REM leaving a dead window until someone notices. Caps how many times it'll
REM retry in a row (MAX_FAST_CRASHES) so a genuinely broken config doesn't
REM loop forever burning CPU/network - but that counter resets whenever the
REM bot managed a solid run first (MIN_HEALTHY_RUN_SECONDS), so an
REM occasional hiccup after hours of uptime doesn't count against it the
REM same way a crash 5 seconds after startup would.
set MAX_FAST_CRASHES=5
set MIN_HEALTHY_RUN_SECONDS=120
set fast_crash_count=0

:run
for /f %%T in ('powershell -NoProfile -Command "[int][double]::Parse((Get-Date -UFormat %%s))"') do set START_EPOCH=%%T

echo Starting tournament-registration-bot...
call npm start
set EXIT_CODE=%ERRORLEVEL%

if "%EXIT_CODE%"=="0" (
  echo.
  echo Bot exited cleanly. Press any key to close this window.
  pause >nul
  exit /b 0
)

for /f %%T in ('powershell -NoProfile -Command "[int][double]::Parse((Get-Date -UFormat %%s))"') do set END_EPOCH=%%T
set /a RUN_SECONDS=END_EPOCH-START_EPOCH

if %RUN_SECONDS% GEQ %MIN_HEALTHY_RUN_SECONDS% (
  set fast_crash_count=0
) else (
  set /a fast_crash_count+=1
)

echo.
echo Bot exited with an error after %RUN_SECONDS% second(s) (exit code %EXIT_CODE%).

if %fast_crash_count% GEQ %MAX_FAST_CRASHES% (
  echo Crashed %fast_crash_count% times in a row shortly after starting - stopping auto-restart
  echo rather than looping forever. Check the error above, fix it, then re-run this script.
  echo Press any key to close this window.
  pause >nul
  exit /b 1
)

echo Restarting in 10 seconds... close this window to cancel.
timeout /t 10
goto run
