# File Tracker

Know where every physical file is, who took it and when.

1. Every file in the register gets a **QR code** (built from its File No, e.g. `HLR/Gurgaon/Admin/1`).
2. The receiver **scans the QR** on the file, fills in name / department / phone / purpose.
3. The request shows up on the **Admin dashboard**. Admin hands over the file and clicks **Hand over** (time and person are recorded).
4. When the file comes back, Admin clicks **Mark returned**. Full history is kept per file.

## Run

```
npm install
npm start
```
Windows: double-click `start.bat`.

- Dashboard: http://localhost:3000   (default PIN `admin123`)
- Change PIN / port: `ADMIN_PIN=yourpin PORT=3000 npm start`  (Windows PowerShell: `$env:ADMIN_PIN="yourpin"; npm start`)

## QR codes and phones
QR codes must open an address phones can reach, so they use this PC's network IP (shown in the console, e.g. `http://192.168.1.20:3000`),
not `localhost`. Phones must be on the same Wi-Fi/LAN. You can override the address in **Settings**; reprint labels if it changes.
Allow Node.js through Windows Firewall (private network) the first time.

## Excel import
Files tab → **Import Excel/CSV**. Columns recognised: Company, Project, Department, File Name, File No, Status, No of File…, Location.
Blank File No is generated as `Company/Project/Department/<next number>`. Existing File Nos are updated, not duplicated.

Data is stored in `data/db.json` (not committed to git). Back this file up.
