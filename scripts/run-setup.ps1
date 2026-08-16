$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Fail($message) {
    Write-Host ""
    Write-Host $message -ForegroundColor Red
    Write-Host ""
    Write-Host "Press Enter to close this window."
    Read-Host | Out-Null
    exit 1
}

Write-Host "=== Tournament Registration Bot - Setup ===" -ForegroundColor Cyan
Write-Host ""

# --- Check for Node.js, offer to install it if missing ---
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js isn't installed yet - this is needed to run the bot." -ForegroundColor Yellow
    Write-Host ""
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        $choice = Read-Host "Install it automatically now? (Y/n)"
        if ($choice -eq '' -or $choice -match '^[Yy]') {
            Write-Host ""
            Write-Host "Installing Node.js (this can take a minute or two)..."
            winget install OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
            Write-Host ""
            Write-Host "Node.js is installed. Windows needs a fresh window to see it -" -ForegroundColor Yellow
            Write-Host "please close this window, then double-click run-setup.bat again." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Press Enter to close this window."
            Read-Host | Out-Null
            exit 0
        }
    }
    Write-Host "Opening the Node.js download page - install the LTS version, then run"
    Write-Host "run-setup.bat again."
    Start-Process "https://nodejs.org"
    Fail "Waiting on Node.js - nothing else to do here yet."
}

Write-Host "Found Node.js $(node --version)"
Write-Host ""

# --- Install dependencies ---
Write-Host "Installing what the bot needs (only happens once, may take a minute)..."
npm install
if ($LASTEXITCODE -ne 0) {
    Fail "That last step failed - see the messages above for what went wrong."
}

# --- Run the interactive setup ---
Write-Host ""
node scripts/setup.js
if ($LASTEXITCODE -ne 0) {
    Fail "Setup did not finish - see the messages above. You can just double-click run-setup.bat again to retry; it's safe to re-run."
}

Write-Host ""
Write-Host "Press Enter to close this window."
Read-Host | Out-Null
