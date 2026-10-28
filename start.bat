@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages, please wait...
  call npm install
)
rem Change the PIN below before using it for real
set ADMIN_PIN=admin123
node server.js
pause
