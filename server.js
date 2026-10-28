'use strict';
/**
 * File Tracker — who has which physical file, since when.
 *  - Admin dashboard : http://localhost:3000/          (PIN protected)
 *  - Receiver form   : http://<ip>:3000/scan?no=<File No>   (opened by scanning the QR)
 */
const express = require('express');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');

const BUILD = '2026-10-28 · v9.1 (vercel + neon)';
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = String(process.env.ADMIN_PIN || 'admin123');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const USE_PG = !!PG_URL;          // Neon/Postgres mode (Vercel). Otherwise: local JSON file.
const ON_VERCEL = !!process.env.VERCEL;

/* ------------------------------------------------------------------ helpers */
function lanIp() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) found.push(n.address);
    }
  }
  const pref = found.find((a) => /^(192\.168\.|10\.)/.test(a)) || found.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a));
  return pref || found[0] || 'localhost';
}
const detectedUrl = () => (ON_VERCEL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}` : `http://${lanIp()}:${PORT}`);
const nowIso = () => new Date().toISOString();
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const clean = (v, max = 120) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/* ----------------------------------------------------------------------- DB */
let db;
function seed() {
  const mk = (id, dept, name, no, copies) => ({
    id, company: 'HLR', project: 'Gurgaon', department: dept, fileName: name, fileNo: no,
    scanStatus: 'In-Scan', copies, location: 'Gurgaon', createdAt: nowIso(),
  });
  return {
    seq: { file: 3, txn: 0 },
    settings: { baseUrl: '', requireApproval: false },
    files: [
      mk(1, 'Accounts', 'Gst Registration Gurugram', 'HLR/Gurgaon/Accounts/1', 1),
      mk(2, 'Admin', 'Bani Hospitality Services Pvt.Ltd', 'HLR/Gurgaon/Admin/1', 1),
      mk(3, 'Admin', 'Bani Gurugram office Maintanance', 'HLR/Gurgaon/Admin/2', 2),
    ],
    movements: [],
  };
}
function loadDb() {
  if (USE_PG) return;            // loaded per request from Neon
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    db = seed();
    saveDb();
  }
}
let dirty = false;
function saveDb() {
  if (USE_PG) { dirty = true; return; }   // written to Neon before the response is sent
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* ---- Neon / Postgres storage: the whole data set is one JSON row */
let pool = null, pgVer = 0, pgReady = false;
function getPool() {
  if (!pool) { const { Pool } = require('pg'); pool = new Pool({ connectionString: PG_URL, max: 1, ssl: /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false } }); }
  return pool;
}
async function pgLoad() {
  const q = getPool();
  if (!pgReady) { await q.query('CREATE TABLE IF NOT EXISTS kv (id int PRIMARY KEY, data jsonb NOT NULL, ver int NOT NULL DEFAULT 0)'); pgReady = true; }
  let r = await q.query('SELECT data, ver FROM kv WHERE id = 1');
  if (!r.rows.length) {
    await q.query('INSERT INTO kv (id, data, ver) VALUES (1, $1, 0) ON CONFLICT (id) DO NOTHING', [JSON.stringify(seed())]);
    r = await q.query('SELECT data, ver FROM kv WHERE id = 1');
  }
  db = r.rows[0].data; pgVer = r.rows[0].ver; dirty = false;
  ensureDefaults();
}
async function pgSave() {
  const r = await getPool().query('UPDATE kv SET data = $1, ver = ver + 1 WHERE id = 1 AND ver = $2', [JSON.stringify(db), pgVer]);
  if (!r.rowCount) throw new Error('conflict');
  pgVer += 1; dirty = false;
}
loadDb();

/* ---- users (user id + password) */
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function makeUser(username, name, password, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: ++db.seq.user, username: username.toLowerCase(), name, role, salt, hash: hashPw(password, salt), active: true, createdAt: nowIso() };
}
function ensureDefaults() {
  db.seq = db.seq || {};
  db.seq.user = db.seq.user || 0;
  if (!Array.isArray(db.users) || !db.users.length) {
    // first start: create the master admin from ADMIN_PIN (user id: admin)
    db.users = [makeUser('admin', 'Administrator', ADMIN_PIN, 'admin')];
    saveDb();
  }
}
if (!USE_PG) ensureDefaults();
const pubUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt });

const needsApproval = () => db.settings.requireApproval === true;
const baseUrl = () => (db.settings.baseUrl || detectedUrl()).replace(/\/+$/, '');
const scanLink = (fileNo) => `${baseUrl()}/scan?no=${encodeURIComponent(fileNo)}`;

function openMap() {
  const m = new Map();
  for (const t of db.movements) if (t.status === 'requested' || t.status === 'issued') m.set(t.fileNo, t);
  return m;
}
function fileView(f, open) {
  const t = (open || openMap()).get(f.fileNo);
  const custody = t ? t.status : 'available';
  return {
    ...f,
    custody,
    txnId: t ? t.id : null,
    holder: t ? t.person : null,
    requestedAt: t ? t.requestedAt : null,
    issuedAt: t ? t.issuedAt || null : null,
    dueDate: t ? t.dueDate || '' : '',
    overdue: !!(t && t.status === 'issued' && t.dueDate && t.dueDate < todayLocal()),
  };
}
function findFileByNo(no) {
  const key = clean(no, 200).toLowerCase();
  return db.files.find((f) => f.fileNo.toLowerCase() === key);
}
function cleanPerson(p = {}) {
  return {
    name: clean(p.name, 80),
    empId: clean(p.empId, 40),
    department: clean(p.department, 80),
    phone: clean(p.phone, 20),
    purpose: clean(p.purpose, 300),
  };
}
function nextFileNo(company, project, department) {
  const prefix = [company, project, department].map((s) => clean(s, 60)).join('/');
  let n = 1;
  for (const f of db.files) {
    if (f.fileNo.toLowerCase().startsWith(prefix.toLowerCase() + '/')) {
      const k = parseInt(f.fileNo.slice(prefix.length + 1), 10);
      if (!Number.isNaN(k) && k >= n) n = k + 1;
    }
  }
  return `${prefix}/${n}`;
}
function fileFromBody(b, existing) {
  const f = {
    company: clean(b.company, 60),
    project: clean(b.project, 80),
    department: clean(b.department, 80),
    fileName: clean(b.fileName, 200),
    fileNo: clean(b.fileNo, 200),
    scanStatus: clean(b.scanStatus, 40),
    copies: Math.max(0, parseInt(b.copies, 10) || 0),
    location: clean(b.location, 80),
  };
  if (!f.fileName) throw httpError(400, 'File Name is required');
  if (!f.fileNo) {
    if (!f.company || !f.project || !f.department) throw httpError(400, 'Enter File No, or fill Company, Project and Department so it can be generated');
    f.fileNo = nextFileNo(f.company, f.project, f.department);
  }
  const dup = findFileByNo(f.fileNo);
  if (dup && (!existing || dup.id !== existing.id)) throw httpError(409, `File No "${f.fileNo}" already exists`);
  return f;
}
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* --------------------------------------------------------------------- app */
const app = express();
app.disable('x-powered-by');
// never let the browser reuse an old copy of the pages
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.get('/api/version', (req, res) => res.json({ build: BUILD, folder: __dirname, port: PORT }));
app.use(express.json({ limit: '200kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---- Neon mode: one request at a time per instance, load before, save before responding */
if (USE_PG) {
  let chain = Promise.resolve();
  app.use('/api', (req, res, next) => {
    chain = chain.then(() => new Promise((resolve) => {
      let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
      res.on('close', fin); res.on('finish', fin);
      const origEnd = res.end.bind(res);
      res.end = (...a) => {
        if (!dirty) return origEnd(...a);
        pgSave().then(() => origEnd(...a)).catch(() => {
          res.removeHeader('Content-Length'); res.statusCode = 409; res.setHeader('Content-Type', 'application/json');
          origEnd(JSON.stringify({ error: 'Could not save because someone else changed the data at the same moment. Please try again.' }));
        });
        return res;
      };
      pgLoad().then(() => next()).catch((e) => { console.error(e); res.status(500).json({ error: 'Database error: ' + e.message }); });
    }));
  });
}

/* ---- auth (admin only; the scan form is public on purpose) */
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('ft|' + (PG_URL || ADMIN_PIN)).digest('hex');
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function makeToken(userId) { const p = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + 12 * 3600 * 1000 })).toString('base64url'); return p + '.' + sign(p); }
function readToken(t) {
  if (!t || !t.includes('.')) return null;
  const [p, sg] = t.split('.');
  if (sg.length !== sign(p).length || !crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(sign(p)))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() ? o.u : null; } catch { return null; }
}
const cookieFlags = (req) => `HttpOnly; SameSite=Lax; Path=/${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
const attempts = new Map();
function getCookie(req, name) {
  const hit = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
function curUser(req) {
  const id = readToken(getCookie(req, 'adm'));
  const u = id && db.users.find((x) => x.id === id);
  return u && u.active ? u : null;
}
function auth(req, res, next) {
  const u = curUser(req);
  if (u) { req.user = u; return next(); }
  res.status(401).json({ error: 'Login required' });
}
function adminOnly(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Only an Admin can do this' });
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.post('/api/login', (req, res) => {
  const ip = req.socket.remoteAddress;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 60000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  a.n++;
  attempts.set(ip, a);
  const b = req.body || {};
  const u = db.users.find((x) => x.username === String(b.username || '').trim().toLowerCase());
  const ok = u && u.active && safeEqual(hashPw(b.password || '', u.salt), u.hash);
  if (!ok) return res.status(401).json({ error: 'Wrong user id or password' });
  res.setHeader('Set-Cookie', `adm=${makeToken(u.id)}; ${cookieFlags(req)}; Max-Age=${60 * 60 * 12}`);
  res.json({ ok: true, user: pubUser(u) });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `adm=; ${cookieFlags(req)}; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => { const u = curUser(req); res.json({ admin: !!u, user: u ? pubUser(u) : null }); });

/* ---- public: what the QR opens */
app.get('/api/public/file', (req, res) => {
  const f = findFileByNo(req.query.no);
  if (!f) return res.status(404).json({ error: 'No file found for this QR code' });
  const v = fileView(f);
  res.json({
    fileNo: f.fileNo, fileName: f.fileName, company: f.company, project: f.project,
    department: f.department, location: f.location,
    custody: v.custody,
    holderName: v.holder ? v.holder.name : '',
    holderDepartment: v.holder ? v.holder.department : '',
    since: v.issuedAt || v.requestedAt || null,
    dueDate: v.dueDate,
  });
});
app.post('/api/public/request', (req, res) => {
  const f = findFileByNo(req.body && req.body.fileNo);
  if (!f) throw httpError(404, 'File not found');
  if (openMap().has(f.fileNo)) throw httpError(409, 'This file is not available. It is already with someone else.');
  const person = cleanPerson(req.body);
  if (!person.name) throw httpError(400, 'Please enter your name');
  if (!person.empId) throw httpError(400, 'Please enter your Employee ID');
  if (!person.department) throw httpError(400, 'Please enter your department');
  if (!/^[0-9+\-\s]{8,20}$/.test(person.phone)) throw httpError(400, 'Please enter a valid mobile number');
  const due = clean(req.body.dueDate, 10);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw httpError(400, 'Invalid return date');
  const instant = !needsApproval();
  const ts = nowIso();
  const t = {
    id: ++db.seq.txn, fileNo: f.fileNo, status: instant ? 'issued' : 'requested', person,
    requestedAt: ts, dueDate: due, issuedAt: instant ? ts : null, issuedBy: instant ? 'Self (QR scan)' : '',
    returnedAt: null, remarks: '',
  };
  db.movements.push(t);
  saveDb();
  res.json({ ok: true, ref: refOf(t.id), status: t.status, at: ts, fileNo: f.fileNo, fileName: f.fileName });
});
const refOf = (id) => 'R-' + String(id).padStart(4, '0');

/* ---- admin */
const admin = express.Router();
admin.use(auth);

admin.get('/summary', (req, res) => {
  const open = openMap();
  const views = db.files.map((f) => fileView(f, open));
  res.json({
    total: views.length,
    available: views.filter((v) => v.custody === 'available').length,
    requested: views.filter((v) => v.custody === 'requested').length,
    issued: views.filter((v) => v.custody === 'issued').length,
    overdue: views.filter((v) => v.overdue).length,
  });
});
admin.get('/files', (req, res) => {
  const open = openMap();
  res.json(db.files.map((f) => ({ ...fileView(f, open), link: scanLink(f.fileNo) })));
});
admin.post('/files', (req, res) => {
  const data = fileFromBody(req.body || {});
  const f = { id: ++db.seq.file, ...data, createdAt: nowIso() };
  db.files.push(f);
  saveDb();
  res.json(f);
});
admin.put('/files/:id', (req, res) => {
  const f = db.files.find((x) => x.id === Number(req.params.id));
  if (!f) throw httpError(404, 'Not found');
  const data = fileFromBody(req.body || {}, f);
  if (data.fileNo !== f.fileNo && openMap().has(f.fileNo)) throw httpError(409, 'Cannot change File No while the file is requested/issued');
  if (data.fileNo !== f.fileNo) for (const m of db.movements) if (m.fileNo === f.fileNo) m.fileNo = data.fileNo;
  Object.assign(f, data);
  saveDb();
  res.json(f);
});
admin.delete('/files/:id', (req, res) => {
  const i = db.files.findIndex((x) => x.id === Number(req.params.id));
  if (i < 0) throw httpError(404, 'Not found');
  if (openMap().has(db.files[i].fileNo)) throw httpError(409, 'File is requested/issued. Mark it returned first.');
  db.files.splice(i, 1);
  saveDb();
  res.json({ ok: true });
});

admin.get('/movements', (req, res) => {
  const byNo = new Map(db.files.map((f) => [f.fileNo, f]));
  let rows = db.movements.map((m) => ({ ...m, ref: refOf(m.id), fileName: (byNo.get(m.fileNo) || {}).fileName || '' }));
  if (req.query.fileNo) rows = rows.filter((m) => m.fileNo === req.query.fileNo);
  rows.sort((a, b) => b.id - a.id);
  res.json(rows);
});
function txn(id, expect) {
  const t = db.movements.find((m) => m.id === Number(id));
  if (!t) throw httpError(404, 'Request not found');
  if (t.status !== expect) throw httpError(409, `Request is already "${t.status}"`);
  return t;
}
admin.post('/movements/:id/issue', (req, res) => {
  const t = txn(req.params.id, 'requested');
  const due = clean(req.body.dueDate, 10);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw httpError(400, 'Invalid due date');
  Object.assign(t, { status: 'issued', issuedAt: nowIso(), issuedBy: clean(req.body.issuedBy, 60), dueDate: due });
  saveDb();
  res.json(t);
});
admin.post('/movements/:id/reject', (req, res) => {
  const t = txn(req.params.id, 'requested');
  Object.assign(t, { status: 'rejected', returnedAt: nowIso(), remarks: clean(req.body.reason, 200) });
  saveDb();
  res.json(t);
});
admin.post('/movements/:id/return', (req, res) => {
  const t = txn(req.params.id, 'issued');
  Object.assign(t, { status: 'returned', returnedAt: nowIso(), remarks: clean(req.body.remarks, 200) });
  saveDb();
  res.json(t);
});
// Admin hands a file straight to someone (walk-in, no QR scan)
admin.post('/issue', (req, res) => {
  const f = findFileByNo(req.body.fileNo);
  if (!f) throw httpError(404, 'File not found');
  if (openMap().has(f.fileNo)) throw httpError(409, 'File is already requested/issued');
  const person = cleanPerson(req.body);
  if (!person.name) throw httpError(400, 'Name is required');
  const due = clean(req.body.dueDate, 10);
  const t = {
    id: ++db.seq.txn, fileNo: f.fileNo, status: 'issued', person, requestedAt: nowIso(),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '', issuedAt: nowIso(),
    issuedBy: clean(req.body.issuedBy, 60), returnedAt: null, remarks: '',
  };
  db.movements.push(t);
  saveDb();
  res.json(t);
});

admin.get('/settings', (req, res) => res.json({ baseUrl: db.settings.baseUrl, detectedUrl: detectedUrl(), activeUrl: baseUrl(), requireApproval: needsApproval() }));
admin.put('/settings', (req, res) => {
  const u = clean(req.body.baseUrl, 200).replace(/\/+$/, '');
  if (u && !/^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/i.test(u)) throw httpError(400, 'Enter a URL like http://192.168.1.20:3000');
  db.settings.baseUrl = u;
  if (typeof req.body.requireApproval === 'boolean') db.settings.requireApproval = req.body.requireApproval;
  saveDb();
  res.json({ baseUrl: u, detectedUrl: detectedUrl(), activeUrl: baseUrl(), requireApproval: needsApproval() });
});

/* QR image for a file (uses the File No inside the link) */
admin.get('/qr/:id', wrap(async (req, res) => {
  const f = db.files.find((x) => x.id === Number(req.params.id));
  if (!f) throw httpError(404, 'Not found');
  const link = scanLink(f.fileNo);
  const opts = { errorCorrectionLevel: 'M', margin: 1 };
  if (req.query.fmt === 'png') {
    const buf = await QRCode.toBuffer(link, { ...opts, width: 600 });
    res.type('png');
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${f.fileNo.replace(/[^\w.-]+/g, '_')}.png"`);
    return res.send(buf);
  }
  res.type('image/svg+xml').send(await QRCode.toString(link, { ...opts, type: 'svg' }));
}));

/* Excel / CSV import */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function cellText(c) {
  let v = c && c.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.result != null) return String(v.result);
    if (v.text != null) return String(v.text);
    return '';
  }
  return String(v);
}
function mapHeader(h) {
  const k = norm(h);
  if (!k) return null;
  if (k === 'srno' || k === 'sno' || k === 'slno') return null;
  if (k.startsWith('compan') || k.startsWith('comany')) return 'company';
  if (k.startsWith('project')) return 'project';
  if (k.startsWith('depart') || k.startsWith('depat')) return 'department';
  if (k === 'filename') return 'fileName';
  if (k === 'fileno' || k === 'filenumber') return 'fileNo';
  if (k.startsWith('noof') || k === 'copies' || k === 'nooffiles') return 'copies';
  if (k === 'status') return 'scanStatus';
  if (k === 'location') return 'location';
  return null;
}
admin.post('/import', express.raw({ type: '*/*', limit: '25mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'No file received');
  const name = String(req.headers['x-filename'] || '').toLowerCase();
  const wb = new ExcelJS.Workbook();
  try {
    if (name.endsWith('.csv')) await wb.csv.read(Readable.from(req.body));
    else await wb.xlsx.load(req.body);
  } catch (e) {
    throw httpError(400, 'Could not read that file. Use .xlsx or .csv');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw httpError(400, 'The file has no sheet');
  let headerRow = 0;
  let cols = {};
  for (let r = 1; r <= Math.min(ws.rowCount, 15) && !headerRow; r++) {
    const m = {};
    ws.getRow(r).eachCell((c, i) => { const key = mapHeader(cellText(c)); if (key) m[key] = i; });
    if (m.fileName && (m.fileNo || (m.company && m.project && m.department))) { headerRow = r; cols = m; }
  }
  if (!headerRow) throw httpError(400, 'Could not find the header row. Needs at least "File Name" and "File No" (or Company, Project, Department).');
  let added = 0, updated = 0, skipped = 0;
  const problems = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k) => (cols[k] ? cellText(row.getCell(cols[k])) : '');
    const body = {
      company: get('company'), project: get('project'), department: get('department'), fileName: get('fileName'),
      fileNo: get('fileNo'), scanStatus: get('scanStatus'), copies: get('copies'), location: get('location'),
    };
    if (!Object.values(body).some((x) => clean(x))) continue;
    try {
      const existing = body.fileNo ? findFileByNo(body.fileNo) : null;
      const data = fileFromBody(body, existing);
      if (existing) { Object.assign(existing, data); updated++; }
      else { db.files.push({ id: ++db.seq.file, ...data, createdAt: nowIso() }); added++; }
    } catch (e) {
      skipped++;
      if (problems.length < 8) problems.push(`Row ${r}: ${e.message}`);
    }
  }
  saveDb();
  res.json({ added, updated, skipped, problems });
}));

admin.get('/export', wrap(async (req, res) => {
  const open = openMap();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('File Register');
  ws.columns = [
    { header: 'Sr.No', key: 'sr', width: 7 }, { header: 'Company', key: 'company', width: 11 },
    { header: 'Project', key: 'project', width: 16 }, { header: 'Department', key: 'department', width: 16 },
    { header: 'File Name', key: 'fileName', width: 38 }, { header: 'File No', key: 'fileNo', width: 26 },
    { header: 'Scan Status', key: 'scanStatus', width: 12 }, { header: 'No of Files', key: 'copies', width: 11 },
    { header: 'Location', key: 'location', width: 14 }, { header: 'Status', key: 'inout', width: 9 }, { header: 'Custody', key: 'custody', width: 14 },
    { header: 'Currently With', key: 'holder', width: 22 }, { header: 'Since', key: 'since', width: 18 },
    { header: 'Due Date', key: 'due', width: 12 }, { header: 'File Link (QR)', key: 'link', width: 60 },
  ];
  db.files.forEach((f, i) => {
    const v = fileView(f, open);
    ws.addRow({
      sr: i + 1, company: f.company, project: f.project, department: f.department, fileName: f.fileName,
      fileNo: f.fileNo, scanStatus: f.scanStatus, copies: f.copies, location: f.location,
      inout: v.custody === 'available' ? 'In' : 'Out', custody: v.custody === 'available' ? 'Available' : 'Not Available',
      holder: v.holder ? `${v.holder.name} (${v.holder.department})` : '',
      since: v.issuedAt || v.requestedAt ? new Date(v.issuedAt || v.requestedAt).toLocaleString('en-IN') : '',
      due: v.dueDate, link: scanLink(f.fileNo),
    });
  });
  const log = wb.addWorksheet('Movement Log');
  log.columns = [
    { header: 'Ref', key: 'ref', width: 9 }, { header: 'File No', key: 'fileNo', width: 26 },
    { header: 'Person', key: 'name', width: 22 }, { header: 'Emp ID', key: 'empId', width: 12 },
    { header: 'Department', key: 'dept', width: 16 }, { header: 'Phone', key: 'phone', width: 14 },
    { header: 'Purpose', key: 'purpose', width: 32 }, { header: 'Requested', key: 'req', width: 20 },
    { header: 'Issued', key: 'iss', width: 20 }, { header: 'Issued By', key: 'by', width: 14 },
    { header: 'Due', key: 'due', width: 12 }, { header: 'Returned', key: 'ret', width: 20 },
    { header: 'Status', key: 'status', width: 11 }, { header: 'Remarks', key: 'rem', width: 24 },
  ];
  const d = (x) => (x ? new Date(x).toLocaleString('en-IN') : '');
  for (const m of db.movements) {
    log.addRow({
      ref: refOf(m.id), fileNo: m.fileNo, name: m.person.name, empId: m.person.empId, dept: m.person.department,
      phone: m.person.phone, purpose: m.person.purpose, req: d(m.requestedAt), iss: d(m.issuedAt), by: m.issuedBy,
      due: m.dueDate, ret: d(m.returnedAt), status: m.status, rem: m.remarks,
    });
  }
  for (const sheet of [ws, log]) {
    const h = sheet.getRow(1);
    h.height = 22;
    h.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF404040' } };
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'middle', wrapText: true }; });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="File-Register-${todayLocal()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

admin.get('/me', (req, res) => res.json(pubUser(req.user)));
admin.get('/users', adminOnly, (req, res) => res.json(db.users.map(pubUser)));
admin.post('/users', adminOnly, (req, res) => {
  const b = req.body || {};
  const username = clean(b.username, 60).toLowerCase(), name = clean(b.name, 80), pw = String(b.password || '');
  if (!/^[a-z0-9._@+-]{3,60}$/.test(username)) return res.status(400).json({ error: 'User id: 3-60 letters, numbers, . _ - @ (no spaces)' });
  if (!name) return res.status(400).json({ error: 'Enter the full name' });
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users.some((u) => u.username === username)) return res.status(409).json({ error: 'This user id already exists' });
  const u = makeUser(username, name, pw, b.role === 'admin' ? 'admin' : 'staff');
  db.users.push(u); saveDb(); res.json(pubUser(u));
});
admin.put('/users/:id', adminOnly, (req, res) => {
  const u = db.users.find((x) => x.id === Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'User not found' });
  const b = req.body || {};
  const lastAdmin = (x) => x.role === 'admin' && x.active && db.users.filter((y) => y.role === 'admin' && y.active).length === 1;
  if (typeof b.password === 'string' && b.password) {
    if (b.password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(b.password, u.salt);
  }
  if (b.name) u.name = clean(b.name, 80);
  if (b.role && b.role !== u.role) { if (lastAdmin(u)) return res.status(400).json({ error: 'Keep at least one active Admin' }); u.role = b.role === 'admin' ? 'admin' : 'staff'; }
  if (typeof b.active === 'boolean' && b.active !== u.active) {
    if (!b.active && lastAdmin(u)) return res.status(400).json({ error: 'Keep at least one active Admin' });
    u.active = b.active;
  }
  saveDb(); res.json(pubUser(u));
});
admin.delete('/users/:id', adminOnly, (req, res) => {
  const u = db.users.find((x) => x.id === Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  if (u.role === 'admin' && db.users.filter((y) => y.role === 'admin' && y.active).length === 1) return res.status(400).json({ error: 'Keep at least one active Admin' });
  db.users = db.users.filter((x) => x !== u); saveDb(); res.json({ ok: true });
});
app.use('/api/admin', admin);

/* ------------------------------------------------------------------- pages */
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Server error' : err.message });
});

module.exports = app;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  File Tracker is running\n');
  console.log(`  Build               : ${BUILD}`);
  console.log(`  Running from        : ${__dirname}`);
  console.log(`  Dashboard (this PC) : http://localhost:${PORT}`);
  console.log(`  QR links point to   : ${db ? baseUrl() : detectedUrl()}/scan?no=<File No>`);
  console.log(`  Admin login (first start): user id admin, password = ${ADMIN_PIN === 'admin123' ? 'admin123  (change with ADMIN_PIN; only used the very first time)' : '(set via ADMIN_PIN)'}\n`);
});
}
