@echo off
chcp 65001 >nul
title Vote AG - voteagst.space
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installé. Installez-le avec :  winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared n'est pas installé. Installez-le avec :  winget install --id Cloudflare.cloudflared
  pause
  exit /b 1
)
rem Empêche le PC de se mettre en veille tant qu'il est branché sur secteur
powercfg /change standby-timeout-ac 0 >nul 2>nul
start "" http://localhost:3000/admin
rem Adresse fixe : le serveur lance lui-même le tunnel nommé indiqué dans donnees\config.json
node server.js --tunnel
pause
