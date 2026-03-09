@echo off
title SpeakNote Launcher
cd /d "%~dp0"

echo [SpeakNote] Starting Next.js on port 3001...
start /B cmd /c "npx next dev -p 3001 > nul 2>&1"

echo [SpeakNote] Waiting for Next.js...
:wait
timeout /t 1 /nobreak > nul
curl -s -o nul http://localhost:3001/ 2>nul
if errorlevel 1 goto wait

echo [SpeakNote] Next.js ready. Launching Electron...
set SPEAKNOTE_PORT=3001
npx electron .
