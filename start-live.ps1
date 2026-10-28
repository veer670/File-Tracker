# Homeland File Tracker - LIVE (everyone on the office Wi-Fi/LAN can open it)
Set-Location $PSScriptRoot
$env:PORT = 4100
$env:ADMIN_PIN = "admin123"   # only used the first time, to create user id "admin"
New-NetFirewallRule -DisplayName "File Tracker 4100" -Direction Inbound -Protocol TCP -LocalPort 4100 -Action Allow -ErrorAction SilentlyContinue | Out-Null
node server.js
