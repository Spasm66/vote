@echo off
chcp 65001 >nul
title Vote AG
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe. Installez-le avec :  winget install OpenJS.NodeJS.LTS
  echo puis relancez ce fichier.
  pause
  exit /b 1
)
start "" http://localhost:3000/admin
node server.js
pause
