@echo off
chcp 65001 >nul
title Vote AG (avec tunnel Cloudflare)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Installez-le avec :  winget install OpenJS.NodeJS.LTS
  echo puis relancez ce fichier.
  pause
  exit /b 1
)
rem Empeche le PC de se mettre en veille tant qu'il est branche sur secteur
powercfg /change standby-timeout-ac 0 >nul 2>nul
start "" http://localhost:3000/admin
node server.js --tunnel
pause
