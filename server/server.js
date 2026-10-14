#!/usr/bin/env node
/* ==========================================================================
 * Street Light GIS · server/server.js
 * The pilot backend: serves the app and a small JSON API on the same address, so no key or
 * secret ever reaches the browser. Node 22.13+ only; no packages, no build step.
 *
 *   node server/server.js                         (http://localhost:8080)
 *   node server/admin.js add-user ...             (create staff accounts first)
 *
 * Settings come from environment variables; see server/README.md.
 * ========================================================================== */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { openStore, checkChange, sanitizeDoc, loadDataset, seedStore } = require('./store');
const { Auth, loadSecret, normalizePhone, STAFF_SESSION_HOURS, CITIZEN_SESSION_DAYS } = require('./auth');
const { smsProvider, aiProvider, ccmsProvider } = require('./providers');

const ROOT = path.join(__dirname, '..');
const JSON_LIMIT = 2 * 1024 * 1024;       // a sync batch (normally a few KB)
const PHOTO_LIMIT = 3 * 1024 * 1024;      // a downsized, re-encoded JPEG is ~200 KB
const CLAIM_SECONDS = 60;                 // a staff browser has this long to process a citizen report it claimed
const SWEEP_MS = 60 * 60e3;               // photo retention and expired sessions, hourly

// The app's own constants (categories, limits), read from config.js so there is one source of truth.
function loadAppConfig() {
  const src = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  return vm.runInNewContext(`${src}\n;({ REPORT_CATEGORIES, CONFIDENCE, REPORTS_PER_REPORTER_PER_HOUR, PUBLIC_ESCALATION_ENABLED, OFFICIAL_HANDLES })`,
    { window: {} }, { filename: 'config.js', timeout: 5000 });
}

function settingsFrom(env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || '127.0.0.1',
    dataDir,
    dbFile: env.DB_FILE || path.join(dataDir, 'streetlight.db'),
    photoDir: path.join(dataDir, 'photos'),
    trustProxy: env.TRUST_PROXY === '1',
    demoClock: env.DEMO_CLOCK === '1',
    otpDevEcho: env.OTP_DEV_ECHO === '1' && (env.SMS_PROVIDER || 'console') === 'console',
    photoRetentionDays: Number(env.PHOTO_RETENTION_DAYS || 90),
    oncallPhone: env.ONCALL_PHONE ? normalizePhone(env.ONCALL_PHONE) : null,
    baseUrl: env.PUBLIC_BASE_URL || null,
    handles: env.OFFICIAL_HANDLES_JSON ? JSON.parse(env.OFFICIAL_HANDLES_JSON) : null,
  };
}

// ---- what each audience may see -----------------------------------------------------------------
const PUBLIC_TICKET_FIELDS = ['id', 'kind', 'status', 'category', 'issue', 'raised_at', 'first_raised_at', 'closed_at', 'verified_at',
  'work_started_at', 'field_outcome', 'merged_into', 'public', 'complaints', 'band', 'team', 'circuit', 'pole_uids', 'position', 'near_uid'];

/**
 * The public (and citizen) view of the state: poles and tickets without staff notes, crew names or other
 * people's reports; a verified citizen also gets their own reports. No reporters, no activity.
 */
function publicDocs(all, reporterId = null) {
  const mine = all.filter((d) => d.kind === 'report' && reporterId && d.doc.reporter_id === reporterId);
  const myTickets = new Set(mine.map((d) => d.doc.ticket_id));
  const out = [];
  for (const d of all) {
    if (d.kind === 'pole') {
      out.push({ ...d, doc: {
        status: d.doc.status, ticket_id: d.doc.ticket_id, fixture_type: d.doc.fixture_type, last_inspected: d.doc.last_inspected,
        repair_history: (d.doc.repair_history ?? []).filter((h) => myTickets.has(h.ticket_id))
          .map((h) => ({ ticket_id: h.ticket_id, status: h.status, resolved_at: h.resolved_at, verified_at: h.verified_at, outcome: h.outcome })),
      } });
    } else if (d.kind === 'ticket') {
      const t = Object.fromEntries(PUBLIC_TICKET_FIELDS.filter((k) => k in d.doc).map((k) => [k, d.doc[k]]));
      t.assigned_crew = d.doc.assigned_crew ? 'Crew' : null;
      t.reports = (d.doc.reports ?? []).filter((id) => mine.some((r) => r.id === id));
      t.closed = d.doc.closed;
      out.push({ ...d, doc: t });
    } else if (d.kind === 'setting') {
      out.push({ ...d, doc: { publicSharing: d.doc.publicSharing } });
    }
  }
  for (const d of mine) out.push({ ...d, doc: { ...d.doc, mine: true } });
  return out;
}

// ---- the server ------------------------------------------------------------------------------------
function createServer({ env = process.env, log = console.log } = {}) {
  const cfg = settingsFrom(env);
  const app = loadAppConfig();
  const store = openStore(cfg.dbFile);
  const auth = new Auth(store, loadSecret(env, cfg.dataDir));
  const sms = smsProvider(env, log);
  const ai = aiProvider(env);
  const ccms = ccmsProvider(env);
  const categories = new Map(app.REPORT_CATEGORIES.map((c) => [c.id, c]));
  fs.mkdirSync(cfg.photoDir, { recursive: true });
  if (seedStore(store, loadDataset(path.join(ROOT, 'data', 'streetlights.js')), { publicSharing: app.PUBLIC_ESCALATION_ENABLED })) {
    log('[store] seeded from data/streetlights.js');
  }

  const clientConfig = {
    mode: 'server', api: '/api', demoClock: cfg.demoClock, ai: ai.configured, ccms: ccms.kind, sms: sms.kind,
    otpDevEcho: cfg.otpDevEcho, photoRetentionDays: cfg.photoRetentionDays, baseUrl: cfg.baseUrl, handles: cfg.handles,
    staffSessionHours: STAFF_SESSION_HOURS,
  };

  // ---- helpers ----
  const ipOf = (req) => (cfg.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
  const isHttps = (req) => Boolean(req.socket.encrypted) || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k, v]) => k && v).map(([k, v]) => [k, decodeURIComponent(v)]));
  const setCookie = (req, res, name, value, maxAgeS) => {
    const prev = res.getHeader('set-cookie') ?? [];
    res.setHeader('set-cookie', [...prev, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`]);
  };
  const staffOf = (req) => { const w = auth.whoIs(cookies(req).slgis_staff); return w?.kind === 'staff' ? w.user : null; };
  const citizenOf = (req) => { const w = auth.whoIs(cookies(req).slgis_citizen); return w?.kind === 'citizen' ? w.reporterId : null; };

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store', ...headers,
    });
    res.end(data);
  }
  const fail = (res, status, error) => send(res, status, { error });

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req, limit = 64 * 1024) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('expected JSON'), { status: 415 });
    try {
      return JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');
    } catch (err) {
      throw err.status ? err : Object.assign(new Error('bad JSON'), { status: 400 });
    }
  }
  /** State-changing requests must come from this app: a custom header (needs CORS, which we never grant) and, if sent, our Origin. */
  function sameOrigin(req) {
    if (req.headers['x-slgis'] !== '1') return false;
    const origin = req.headers.origin;
    return !origin || origin === `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  }

  /** Server-side writes (citizen actions): documents plus an activity entry, in one transaction. */
  function serverWrite(changes, by, activity = null) {
    const all = activity ? [...changes, { kind: 'activity', id: `srv-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, doc: activity }] : changes;
    return store.tx(() => store.writeDocs(all, by));
  }
  const activityEntry = (action, { ticket = null, uids = [], role = 'Citizen' } = {}) => ({ at: new Date().toISOString(), role, action, ticket, uids, from: null, to: null });

  // ---- photos ----
  const photoPath = (id) => path.join(cfg.photoDir, `${id}.jpg`);
  const isJpeg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const photoOwner = store.db.prepare('SELECT owner FROM photos WHERE id = ?');
  const addPhoto = store.db.prepare('INSERT INTO photos (id, owner, bytes, created_at, delete_after) VALUES (?, ?, ?, ?, ?)');
  const expiredPhotos = store.db.prepare('SELECT id FROM photos WHERE delete_after < ?');
  const dropPhoto = store.db.prepare('DELETE FROM photos WHERE id = ?');
  const getClaim = store.db.prepare('SELECT by, until FROM claims WHERE report_id = ?');
  const putClaim = store.db.prepare('INSERT INTO claims (report_id, by, until) VALUES (?, ?, ?) ON CONFLICT (report_id) DO UPDATE SET by = excluded.by, until = excluded.until');

  /** Retention: delete photos past their date, and take their links out of reports and tickets. */
  function sweep() {
    auth.purge();
    const gone = new Set(expiredPhotos.all(Date.now()).map((r) => r.id));
    if (!gone.size) return 0;
    const changes = [];
    for (const kind of ['report', 'ticket']) {
      for (const d of store.list(kind)) {
        const field = kind === 'report' ? 'photo' : 'dusk_photo';
        const m = /\/api\/photos\/([a-f0-9]{32})$/.exec(d.doc[field]?.url ?? '');
        if (m && gone.has(m[1])) changes.push({ kind, id: d.id, doc: { ...d.doc, [field]: { ...d.doc[field], url: null, deleted_at: new Date().toISOString() } } });
      }
    }
    store.tx(() => {
      if (changes.length) store.writeDocs(changes, 'retention');
      for (const id of gone) dropPhoto.run(id);
    });
    for (const id of gone) fs.rmSync(photoPath(id), { force: true });
    return gone.size;
  }

  // ---- citizen report checks ----
  const isPos = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  function citizenReportDoc(body, reporterId) {
    const cat = categories.get(body.category);
    if (!cat) return { error: 'unknown category' };
    const uid = body.uid == null ? null : String(body.uid);
    if (uid && !store.get('pole', uid)) return { error: 'unknown pole' };
    const position = body.position == null ? null : body.position;
    if (!uid && !isPos(position)) return { error: 'a pole or a position is needed' };
    if (position !== null && !isPos(position)) return { error: 'bad position' };
    const note = String(body.note ?? '').trim().slice(0, 500);
    const noticed = ['last_night', 'earlier_today', 'just_now'].includes(body.noticed) ? body.noticed : null;
    let photo = null;
    if (body.photo) {
      const kind = body.photo.kind === 'live' ? 'live' : 'upload';
      const hash = /^[0-9a-f]{16}$/.test(body.photo.hash ?? '') ? body.photo.hash : null;
      const m = /^\/api\/photos\/([a-f0-9]{32})$/.exec(body.photo.url ?? '');
      const url = m && photoOwner.get(m[1])?.owner === reporterId ? body.photo.url : null;
      photo = { kind, hash, ...(url ? { url } : {}), ...(body.photo.ai ? { ai: cleanFindings(body.photo.ai) } : {}) };
    }
    const device = body.device && isPos(body.device.position) && Number.isFinite(body.device.accuracy_m)
      ? { position: body.device.position, accuracy_m: Math.round(body.device.accuracy_m) } : null;
    return { cat, doc: { reporter_id: reporterId, category: cat.id, uid, position: uid ? null : position, note, source: 'Citizen app', noticed, photo, device } };
  }
  const tri = (v) => (v === true || v === false ? v : null);
  const cleanFindings = (f) => ({
    streetlight_visible: tri(f.streetlight_visible), lamp: ['on', 'off', 'unclear'].includes(f.lamp) ? f.lamp : 'unclear',
    dark_scene: tri(f.dark_scene), pole_damaged: tri(f.pole_damaged), wires_exposed: tri(f.wires_exposed), light_blocked: tri(f.light_blocked),
  });

  // ---- routes ----
  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && !sameOrigin(req)) return fail(res, 403, 'cross-site request refused');
    const staff = staffOf(req);
    const citizen = citizenOf(req);
    const ip = ipOf(req);

    if (route === 'GET /api/health') return send(res, 200, { ok: true, seq: store.seq() });
    if (route === 'GET /api/me') return send(res, 200, { staff, citizen: citizen ? { reporterId: citizen } : null });

    if (route === 'GET /api/state') {
      const all = store.all();
      return send(res, 200, { seq: store.seq(), scope: staff ? 'staff' : 'public', docs: staff ? all : publicDocs(all, citizen) });
    }
    if (route === 'GET /api/changes') {
      const since = Number(url.searchParams.get('since') ?? 0);
      if (!staff) return send(res, 200, { seq: store.seq() });
      return send(res, 200, { seq: store.seq(), docs: store.since(Number.isFinite(since) ? since : 0) });
    }
    const pub = /^GET \/api\/public\/tickets\/([A-Za-z0-9-]{1,40})$/.exec(route);
    if (pub) {
      const d = store.get('ticket', pub[1]);
      if (!d) return fail(res, 404, 'no such ticket');
      return send(res, 200, publicDocs([d])[0].doc);
    }

    // ---- staff sign-in ----
    if (route === 'POST /api/login') {
      const body = await readJson(req);
      const username = String(body.username ?? '').toLowerCase().slice(0, 32);
      if (!auth.allow('loginPerIp', ip) || !auth.allow('loginPerUser', username)) return fail(res, 429, 'too many attempts; try again in 15 minutes');
      const user = auth.login(username, body.password);
      if (!user) return fail(res, 401, 'wrong username or password');
      setCookie(req, res, 'slgis_staff', auth.staffSession(user.username), STAFF_SESSION_HOURS * 3600);
      return send(res, 200, { staff: user });
    }
    if (route === 'POST /api/logout') {
      auth.endSession(cookies(req).slgis_staff);
      setCookie(req, res, 'slgis_staff', '', 0);
      return send(res, 200, { ok: true });
    }

    // ---- citizen phone verification ----
    if (route === 'POST /api/otp/start') {
      const body = await readJson(req);
      const phone = normalizePhone(body.phone);
      if (!phone) return fail(res, 400, 'enter a 10-digit Indian mobile number');
      if (!auth.allow('otpPerIp', ip) || !auth.allow('otpPerPhone', auth.keyed('phone', phone))) return fail(res, 429, 'too many codes; try again later');
      const code = auth.newOtp(phone);
      try {
        await sms.send(phone, `${code} is your Street Light complaint code. It expires in 5 minutes. Do not share it.`, { otp: code });
      } catch (err) {
        log(`[sms] ${err.message}`);
        return fail(res, 502, 'could not send the code; try again');
      }
      return send(res, 200, { sent: true, ...(cfg.otpDevEcho ? { devCode: code } : {}) });
    }
    if (route === 'POST /api/otp/verify') {
      const body = await readJson(req);
      const phone = normalizePhone(body.phone);
      if (!phone) return fail(res, 400, 'enter a 10-digit Indian mobile number');
      const result = auth.checkOtp(phone, body.code);
      if (result !== 'ok') return fail(res, result === 'wrong' ? 401 : 410, result === 'wrong' ? 'wrong code' : 'code expired; send a new one');
      const reporterId = auth.reporterId(phone);
      setCookie(req, res, 'slgis_citizen', auth.citizenSession(reporterId), CITIZEN_SESSION_DAYS * 86400);
      return send(res, 200, { citizen: { reporterId } });
    }

    // ---- photos (blurred in the browser first) and the AI check ----
    if (route === 'POST /api/photo-check') {
      if (!staff && !citizen) return fail(res, 401, 'verify your phone first');
      if (!ai.configured) return fail(res, 501, 'no AI photo check configured');
      if (!auth.allow('citizenWritePerIp', ip)) return fail(res, 429, 'too many requests');
      const buf = await readBody(req, PHOTO_LIMIT);
      if (!isJpeg(buf)) return fail(res, 415, 'expected a JPEG');
      const cat = categories.get(url.searchParams.get('category')) ?? categories.get('other');
      try {
        return send(res, 200, await ai.check(buf, cat.label));
      } catch (err) {
        log(`[ai] ${err.message}`);
        return fail(res, 502, 'photo check unavailable');
      }
    }
    if (route === 'POST /api/photos') {
      const owner = staff?.username ?? citizen;
      if (!owner) return fail(res, 401, 'verify your phone first');
      if (!ai.configured) return fail(res, 501, 'photos are not stored without the AI check (faces and number plates must be blurred first)');
      if (!auth.allow('citizenWritePerIp', ip)) return fail(res, 429, 'too many requests');
      const buf = await readBody(req, PHOTO_LIMIT);
      if (!isJpeg(buf)) return fail(res, 415, 'expected a JPEG');
      const id = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(photoPath(id), buf);
      addPhoto.run(id, owner, buf.length, Date.now(), Date.now() + cfg.photoRetentionDays * 864e5);
      return send(res, 201, { id, url: `/api/photos/${id}` });
    }
    const photo = /^GET \/api\/photos\/([a-f0-9]{32})$/.exec(route);
    if (photo) {
      const row = photoOwner.get(photo[1]);
      if (!row || !(staff || row.owner === citizen)) return fail(res, 404, 'no such photo');
      return send(res, 200, fs.readFileSync(photoPath(photo[1])), { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' });
    }

    // ---- citizens: report, answer "Fixed?", share ----
    if (route === 'POST /api/citizen/reports') {
      if (!citizen) return fail(res, 401, 'verify your phone first');
      if (!auth.allow('citizenWritePerIp', ip)) return fail(res, 429, 'too many requests');
      const { error, cat, doc } = citizenReportDoc(await readJson(req), citizen);
      if (error) return fail(res, 400, error);
      const [id] = store.leaseIds('report', 1);
      const hourAgo = Date.now() - 3.6e6;
      const recent = store.list('report').filter((d) => d.doc.reporter_id === citizen && new Date(d.doc.created_at).getTime() > hourAgo).length;
      const emergency = app.CONFIDENCE.emergencyCategories.includes(cat.id);
      const review = !emergency && recent >= app.REPORTS_PER_REPORTER_PER_HOUR; // safety reports always go through
      const report = { id, ...doc, created_at: new Date().toISOString(), ticket_id: null, pending: !review, ...(review ? { review: true } : {}) };
      const changes = [{ kind: 'report', id, doc: report }];
      if (!store.get('reporter', citizen)) changes.push({ kind: 'reporter', id: citizen, doc: { id: citizen, past_reports: 0, past_confirmed: 0 } });
      serverWrite(changes, `citizen:${citizen}`, review
        ? activityEntry(`Report ${id} held for review: more than ${app.REPORTS_PER_REPORTER_PER_HOUR} in an hour from one reporter`, { uids: doc.uid ? [doc.uid] : [] })
        : null);
      if (emergency && cfg.oncallPhone) {
        const where = doc.uid ?? `${doc.position[1].toFixed(5)},${doc.position[0].toFixed(5)}`;
        sms.send(cfg.oncallPhone, `Street light EMERGENCY ${id}: ${cat.label} at ${where}. Open the operator view now.`)
          .catch((err) => log(`[sms] on-call alert failed: ${err.message}`));
      }
      return send(res, 201, { report: { ...report, mine: true } });
    }
    const fb = /^POST \/api\/citizen\/reports\/([A-Za-z0-9-]{1,40})\/(feedback|shared)$/.exec(route);
    if (fb) {
      if (!citizen) return fail(res, 401, 'verify your phone first');
      const d = store.get('report', fb[1]);
      if (!d || d.doc.reporter_id !== citizen) return fail(res, 404, 'no such report');
      const body = await readJson(req);
      const r = { ...d.doc };
      if (fb[2] === 'feedback') {
        if (!r.resolved_at) return fail(res, 409, 'this report is not resolved');
        if (body.fixed === true) {
          r.confirmed = 'yes';
          serverWrite([{ kind: 'report', id: r.id, doc: r }], `citizen:${citizen}`, activityEntry(`Reporter confirmed the fix (${r.id})`, { uids: r.uid ? [r.uid] : [] }));
        } else {
          Object.assign(r, { reopen_requested: true, resolved_at: null, confirmed: null, reopened_at: new Date().toISOString() });
          serverWrite([{ kind: 'report', id: r.id, doc: r }], `citizen:${citizen}`);
        }
        return send(res, 200, { report: { ...r, mine: true } });
      }
      const setting = store.get('setting', 'main');
      if (setting && setting.doc.publicSharing === false) return fail(res, 409, 'public sharing is switched off');
      const t = store.get('ticket', r.ticket_id);
      if (!t || t.doc.closed) return fail(res, 409, 'this complaint is not open');
      const channel = ['x', 'share', 'copy'].includes(body.channel) ? body.channel : 'x';
      const changes = [];
      if (!t.doc.public) changes.push({ kind: 'ticket', id: t.id, doc: { ...t.doc, public: { shared_at: new Date().toISOString(), report_id: r.id } } });
      serverWrite(changes, `citizen:${citizen}`, activityEntry(`Shared publicly by reporter (${channel === 'x' ? 'X' : channel === 'share' ? 'share sheet' : 'copied text'})`, { ticket: t.id, uids: t.doc.pole_uids ?? [] }));
      return send(res, 200, { ok: true });
    }

    // ---- staff only from here ----
    if (!staff) return fail(res, 401, 'sign in first');
    if (route === 'POST /api/sync') {
      const body = await readJson(req, JSON_LIMIT);
      const changes = Array.isArray(body.changes) ? body.changes : null;
      if (!changes || changes.length > 2000) return fail(res, 400, 'changes: a list of up to 2000 documents');
      for (const c of changes) {
        const err = checkChange(c);
        if (err) return fail(res, 400, err);
        if (c.kind === 'setting' && !staff.roles.some((r) => r === 'operator' || r === 'management')) return fail(res, 403, 'settings: operators and management only');
      }
      const result = store.sync(changes.map((c) => ({ ...c, doc: sanitizeDoc(c.kind, c.doc) })), staff.username);
      return send(res, result.ok ? 200 : 409, result);
    }
    if (route === 'POST /api/ids') {
      const body = await readJson(req);
      const n = (v) => Math.max(0, Math.min(10, Number(v) || 0));
      return send(res, 200, { tickets: n(body.tickets) ? store.leaseIds('ticket', n(body.tickets)) : [], reports: n(body.reports) ? store.leaseIds('report', n(body.reports)) : [] });
    }
    if (route === 'POST /api/reports/claim') {
      const { id } = await readJson(req);
      const ok = store.tx(() => {
        const c = getClaim.get(String(id));
        if (c && c.until > Date.now() && c.by !== staff.username) return false;
        putClaim.run(String(id), staff.username, Date.now() + CLAIM_SECONDS * 1000);
        return true;
      });
      return send(res, 200, { ok });
    }
    if (route === 'POST /api/ccms/poll') {
      const { uid } = await readJson(req);
      if (!store.get('pole', String(uid))) return fail(res, 404, 'no such pole');
      try {
        return send(res, 200, await ccms.poll(String(uid)));
      } catch (err) {
        log(`[ccms] ${err.message}`);
        return fail(res, 502, 'CCMS did not answer');
      }
    }
    return fail(res, 404, 'not found');
  }

  // ---- static files: only the app itself (never server/, tools/ or dotfiles) ----
  const STATIC = /^\/(index\.html|[a-z]+\.js|style\.css|data\/[a-z_]+\.(?:js|geojson))$/;
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.geojson': 'application/geo+json' };
  function staticFile(req, res, url) {
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p === '/server-config.js') {
      return send(res, 200, `window.SLGIS_SERVER = ${JSON.stringify(clientConfig)};\n`, { 'content-type': 'text/javascript; charset=utf-8' });
    }
    if (!STATIC.test(p)) return fail(res, 404, 'not found');
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return fail(res, 404, 'not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('permissions-policy', 'camera=(self), geolocation=(self), microphone=()');
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      return fail(res, 400, 'bad URL');
    }
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') staticFile(req, res, url);
      else fail(res, 405, 'method not allowed');
    } catch (err) {
      if (!err.status) log(`[error] ${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
      if (!res.headersSent) fail(res, err.status ?? 500, err.status ? err.message : 'server error');
    }
  });

  const timer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      log(`[sweep] ${err.message}`);
    }
  }, SWEEP_MS);
  timer.unref();
  server.on('close', () => {
    clearInterval(timer);
    store.db.close();
  });
  return { server, store, auth, cfg, sweep, clientConfig };
}

if (require.main === module) {
  const { server, cfg, clientConfig } = createServer();
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Street Light GIS server on http://${cfg.host}:${cfg.port}  (SMS: ${clientConfig.sms}, AI photo check: ${clientConfig.ai ? 'on' : 'off'}, CCMS: ${clientConfig.ccms})`);
    if (clientConfig.sms === 'console') console.log('  SMS go to this log only (SMS_PROVIDER=console): fine for development, not for the pilot.');
  });
}

module.exports = { createServer, publicDocs };
