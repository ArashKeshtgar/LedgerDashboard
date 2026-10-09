@echo off
rem Starts Ledger Dashboard (if it isn't already running) and opens it in the browser.
curl -s -m 3 http://localhost:4310/api/session >nul 2>&1
if %errorlevel%==0 goto open
start "Ledger Dashboard" /min cmd /c "cd /d "%~dp0server" && node index.js > server.log 2> server.err.log"
timeout /t 5 /nobreak >nul
:open
start "" http://localhost:4310
