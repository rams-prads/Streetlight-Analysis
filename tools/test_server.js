#!/usr/bin/env node
/*
 * Integration tests for the pilot backend (server/): runs the real server on a free port with a
 * throwaway database, and talks to it over HTTP. Outside services are faked (SMS goes to a list,
 * the AI photo check answers from a stub).   node tools/test_server.js
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slgis-server-'));
const smsLog = [];
const realFetch = globalThis.fetch;
let aiCalls = 0;
// The AI photo check calls api.anthropic.com: answer from a stub instead.
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    aiCalls += 1;
    const body = JSON.parse(opts.body);
    assert.equal(opts.headers['x-api-key'], 'test-key');
    assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg');
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Here: {"streetlight_visible": true, "lamp": "off", "pole_damaged": false, "wires_exposed": null, "light_blocked": false, "redact": [{"x": 0.1, "y": 0.2, "w": 0.1, "h": 0.1}, {"x": 2, "y": 0, "w": 0, "h": 0}]}' }] }), { status: 200 });
  }
  return realFetch(url, opts);
};

const { createServer, publicDocs } = require('../server/server');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function start(extraEnv = {}) {
  const env = { DATA_DIR: fs.mkdtempSync(path.join(dataDir, 'run-')), OTP_DEV_ECHO: '1', SMS_PROVIDER: 'console', PORT: '0', ...extraEnv };
  const log = (line) => { if (line.startsWith('[sms:console]')) smsLog.push(line); };
  const s = createServer({ env, log });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => resolve({ ...s, base: `http://127.0.0.1:${s.server.address().port}` })));
}

/** A tiny HTTP client that keeps cookies, like one browser. */
function client(base) {
  const jar = new Map();
  return async function call(method, url, body, { headers = {}, raw = false } = {}) {
    const h = { 'x-slgis': '1', ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (Buffer.isBuffer(body)) {
      payload = body;
      h['content-type'] ??= 'image/jpeg';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await realFetch(base + url, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, v] = kv.split('=');
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    const type = res.headers.get('content-type') ?? '';
    const out = raw ? Buffer.from(await res.arrayBuffer()) : type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: out, headers: res.headers };
  };
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

test('serves the app and a server config; never the server, tools, data folder secrets or dotfiles', async () => {
  const s = await start();
  const c = client(s.base);
  try {
    assert.equal((await c('GET', '/')).status, 200);
    assert.match((await c('GET', '/server-config.js')).body, /"mode":"server"/);
    assert.equal((await c('GET', '/data/streetlights.js')).status, 200);
    for (const p of ['/server/server.js', '/tools/test_server.js', '/.git/config', '/server/data/secret', '/..%2fREADME.md', '/README.md', '/docs/usability-test.md']) {
      assert.equal((await c('GET', p)).status, 404, p);
    }
    const health = await c('GET', '/api/health');
    assert.equal(health.body.ok, true);
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
  } finally { s.server.close(); }
});

test('the public sees poles and tickets, but no notes, crew names, reporters, activity or other people\'s reports', async () => {
  const s = await start();
  const c = client(s.base);
  try {
    const { body } = await c('GET', '/api/state');
    assert.equal(body.scope, 'public');
    const kinds = new Set(body.docs.map((d) => d.kind));
    assert.deepEqual([...kinds].sort(), ['pole', 'setting', 'ticket']);
    const tickets = body.docs.filter((d) => d.kind === 'ticket');
    assert.ok(tickets.length > 20);
    assert.ok(tickets.every((d) => !('notes' in d.doc) && !('source' in d.doc) && (d.doc.assigned_crew === null || d.doc.assigned_crew === 'Crew')));
    assert.ok(tickets.every((d) => d.doc.reports.length === 0));
    assert.ok(body.docs.filter((d) => d.kind === 'pole').every((d) => d.doc.repair_history.length === 0));
    assert.equal((await c('GET', '/api/public/tickets/TKT-2026-0156')).body.id, 'TKT-2026-0156');
    assert.equal((await c('GET', '/api/public/tickets/TKT-1999-0001')).status, 404);
  } finally { s.server.close(); }
});

test('staff sign in; wrong passwords and cross-site requests are refused', async () => {
  const s = await start();
  s.auth.addUser({ username: 'asha', name: 'Asha V.', roles: ['operator', 'management'], password: 'correct horse battery' });
  const c = client(s.base);
  try {
    assert.equal((await c('POST', '/api/login', { username: 'asha', password: 'wrong password!' })).status, 401);
    assert.equal((await c('POST', '/api/login', { username: 'nobody', password: 'wrong password!' })).status, 401);
    assert.equal((await c('POST', '/api/login', { username: 'asha', password: 'correct horse battery' }, { headers: { 'x-slgis': '' } })).status, 403, 'no app header');
    assert.equal((await c('POST', '/api/login', { username: 'asha', password: 'correct horse battery' }, { headers: { origin: 'https://evil.example' } })).status, 403, 'foreign origin');
    const ok = await c('POST', '/api/login', { username: 'asha', password: 'correct horse battery' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.staff.roles, ['operator', 'management']);
    assert.match(ok.headers.getSetCookie()[0], /HttpOnly; SameSite=Strict/);
    const state = await c('GET', '/api/state');
    assert.equal(state.body.scope, 'staff');
    assert.ok(state.body.docs.some((d) => d.kind === 'reporter'));
    await c('POST', '/api/logout', {});
    assert.equal((await c('GET', '/api/state')).body.scope, 'public');
    assert.equal((await c('POST', '/api/sync', { changes: [] })).status, 401);
  } finally { s.server.close(); }
});

test('sync is all or nothing: one stale document refuses the whole batch', async () => {
  const s = await start();
  s.auth.addUser({ username: 'op1', roles: ['operator'], password: 'operator password 1' });
  s.auth.addUser({ username: 'op2', roles: ['operator'], password: 'operator password 2' });
  const a = client(s.base);
  const b = client(s.base);
  try {
    await a('POST', '/api/login', { username: 'op1', password: 'operator password 1' });
    await b('POST', '/api/login', { username: 'op2', password: 'operator password 2' });
    const docs = (await a('GET', '/api/state')).body.docs;
    const t = docs.find((d) => d.kind === 'ticket' && d.id === 'TKT-2026-0156');
    const pole = docs.find((d) => d.kind === 'pole' && d.id === t.doc.pole_uids[0]);
    const first = await a('POST', '/api/sync', { changes: [{ kind: 'ticket', id: t.id, rev: t.rev, doc: { ...t.doc, assigned_crew: 'R1' } }] });
    assert.equal(first.status, 200);
    const since = first.body.seq;
    // b started from the same revision: its batch (pole + ticket) is refused as a whole
    const second = await b('POST', '/api/sync', { changes: [
      { kind: 'pole', id: pole.id, rev: pole.rev, doc: { ...pole.doc, status: 'Under Maintenance' } },
      { kind: 'ticket', id: t.id, rev: t.rev, doc: { ...t.doc, assigned_crew: 'R2' } },
    ] });
    assert.equal(second.status, 409);
    assert.deepEqual(second.body.conflicts, [`ticket:${t.id}`]);
    const after = (await b('GET', '/api/state')).body.docs;
    assert.equal(after.find((d) => d.kind === 'pole' && d.id === pole.id).doc.status, pole.doc.status, 'pole untouched');
    assert.equal(after.find((d) => d.kind === 'ticket' && d.id === t.id).doc.assigned_crew, 'R1');
    // b catches up through /api/changes
    const ch = await b('GET', `/api/changes?since=${since - 1}`);
    assert.ok(ch.body.docs.some((d) => d.id === t.id && d.rev === t.rev + 1));
    assert.equal((await b('POST', '/api/sync', { changes: [{ kind: 'bogus', id: 'x', rev: 0, doc: {} }] })).status, 400);
  } finally { s.server.close(); }
});

test('documents never keep contact details or in-browser picture links', async () => {
  const s = await start();
  s.auth.addUser({ username: 'opr', roles: ['operator'], password: 'operator password' });
  const c = client(s.base);
  try {
    await c('POST', '/api/login', { username: 'opr', password: 'operator password' });
    const r = await c('POST', '/api/sync', { changes: [{ kind: 'report', id: 'CR-901', rev: 0, doc: {
      id: 'CR-901', name: 'Ravi', phone: '9876543210', mine: true, photo: { kind: 'upload', hash: null, url: 'blob:http://x/123' }, category: 'other' } }] });
    assert.equal(r.status, 200);
    const doc = s.store.get('report', 'CR-901').doc;
    assert.ok(!('name' in doc) && !('phone' in doc) && !('mine' in doc) && !('url' in doc.photo), JSON.stringify(doc));
  } finally { s.server.close(); }
});

test('ticket and report IDs are leased: unique across browsers, after the dataset\'s highest', async () => {
  const s = await start();
  s.auth.addUser({ username: 'opr', roles: ['operator'], password: 'operator password' });
  const c = client(s.base);
  try {
    await c('POST', '/api/login', { username: 'opr', password: 'operator password' });
    const one = (await c('POST', '/api/ids', { tickets: 3, reports: 2 })).body;
    const two = (await c('POST', '/api/ids', { tickets: 2 })).body;
    const year = new Date().getFullYear();
    const all = [...one.tickets, ...two.tickets];
    assert.equal(new Set(all).size, 5);
    assert.ok(all.every((id) => id.startsWith(`TKT-${year}-`)));
    if (year === 2026) assert.ok(Number(one.tickets[0].slice(-4)) > 179, one.tickets[0]);
    assert.deepEqual(one.reports, ['CR-001', 'CR-002']);
  } finally { s.server.close(); }
});

test('phone OTP: a code, a reporter ID that hides the number, and nothing stored that reveals it', async () => {
  const s = await start();
  const c = client(s.base);
  try {
    assert.equal((await c('POST', '/api/otp/start', { phone: '12345' })).status, 400);
    const sent = await c('POST', '/api/otp/start', { phone: '+91 98765 43210' });
    assert.equal(sent.status, 200);
    assert.match(sent.body.devCode, /^\d{6}$/);
    assert.ok(smsLog.at(-1).includes('******3210') && !smsLog.at(-1).includes('9876543210'), 'the log masks the number');
    assert.equal((await c('POST', '/api/otp/verify', { phone: '9876543210', code: '000000' === sent.body.devCode ? '111111' : '000000' })).status, 401);
    const ok = await c('POST', '/api/otp/verify', { phone: '09876543210', code: sent.body.devCode });
    assert.equal(ok.status, 200);
    assert.match(ok.body.citizen.reporterId, /^RP-[0-9A-F]{10}$/);
    assert.equal(s.auth.reporterId('9876543210'), ok.body.citizen.reporterId, 'same person, same ID');
    assert.equal((await c('POST', '/api/otp/verify', { phone: '9876543210', code: sent.body.devCode })).status, 410, 'a code works once');
    // the number appears nowhere in the database
    const dump = s.store.db.prepare("SELECT group_concat(body, '|') AS b FROM docs").get().b
      + JSON.stringify(s.store.db.prepare('SELECT * FROM otps').all()) + JSON.stringify(s.store.db.prepare('SELECT * FROM sessions').all());
    assert.ok(!dump.includes('9876543210') && !dump.includes('43210'));
  } finally { s.server.close(); }
});

async function verifiedCitizen(s, phone) {
  const c = client(s.base);
  const { body } = await c('POST', '/api/otp/start', { phone });
  await c('POST', '/api/otp/verify', { phone, code: body.devCode });
  return c;
}

test('citizen reports: checked, waiting for a staff browser, over the hourly limit held, emergencies always through', async () => {
  const s = await start({ ONCALL_PHONE: '9123456780' });
  const anon = client(s.base);
  const c = await verifiedCitizen(s, '9811122233');
  try {
    assert.equal((await anon('POST', '/api/citizen/reports', { category: 'not_working', uid: 'SL-CP-IC-001' })).status, 401);
    assert.equal((await c('POST', '/api/citizen/reports', { category: 'nope', uid: 'SL-CP-IC-001' })).status, 400);
    assert.equal((await c('POST', '/api/citizen/reports', { category: 'not_working', uid: 'SL-NOPE' })).status, 400);
    assert.equal((await c('POST', '/api/citizen/reports', { category: 'not_working' })).status, 400, 'needs a pole or a position');
    const r = await c('POST', '/api/citizen/reports', { category: 'not_working', uid: 'SL-CP-IC-001', note: 'x'.repeat(900), noticed: 'last_night', photo: { kind: 'live', hash: 'e4b1c07a9d2f5836', url: '/api/photos/' + 'a'.repeat(32) } });
    assert.equal(r.status, 201);
    assert.equal(r.body.report.pending, true);
    assert.equal(r.body.report.note.length, 500);
    assert.equal(r.body.report.photo.url, undefined, 'a photo link must be one this reporter uploaded');
    assert.ok(s.store.get('reporter', r.body.report.reporter_id), 'a reporter record for track records');
    for (let i = 0; i < 4; i++) await c('POST', '/api/citizen/reports', { category: 'flickering', position: [77.219, 28.632] });
    const held = await c('POST', '/api/citizen/reports', { category: 'flickering', position: [77.219, 28.632] });
    assert.equal(held.body.report.review, true);
    assert.equal(held.body.report.pending, false);
    assert.ok(s.store.list('activity').some((d) => /held for review/.test(d.doc.action)));
    const before = smsLog.length;
    const emergency = await c('POST', '/api/citizen/reports', { category: 'exposed', uid: 'SL-CP-IC-002' });
    assert.equal(emergency.body.report.review, undefined, 'safety reports are never held');
    await new Promise((r2) => setTimeout(r2, 20));
    assert.ok(smsLog.slice(before).some((l) => /EMERGENCY/.test(l) && l.includes('******6780')), 'on-call alerted');
    // the citizen sees only their own reports
    const mine = (await c('GET', '/api/state')).body.docs.filter((d) => d.kind === 'report');
    assert.equal(mine.length, 7);
    assert.ok(mine.every((d) => d.doc.mine));
    const other = await verifiedCitizen(s, '9811122244');
    assert.equal((await other('GET', '/api/state')).body.docs.filter((d) => d.kind === 'report').length, 0);
    assert.equal((await other('POST', `/api/citizen/reports/${r.body.report.id}/shared`, { channel: 'x' })).status, 404, 'not their report');
  } finally { s.server.close(); }
});

test('citizen "Fixed? No" and "Share publicly" are recorded on the server', async () => {
  const s = await start();
  const c = await verifiedCitizen(s, '9811100011');
  try {
    const { report } = (await c('POST', '/api/citizen/reports', { category: 'flickering', uid: 'SL-CP-OC-031' })).body;
    assert.equal((await c('POST', `/api/citizen/reports/${report.id}/feedback`, { fixed: false })).status, 409, 'not resolved yet');
    // a staff browser puts it on a ticket and resolves it
    const t = s.store.list('ticket').find((d) => !d.doc.closed);
    s.store.tx(() => s.store.writeDocs([{ kind: 'report', id: report.id, doc: { ...s.store.get('report', report.id).doc, pending: false, ticket_id: t.id, resolved_at: new Date().toISOString() } }], 'op'));
    const no = await c('POST', `/api/citizen/reports/${report.id}/feedback`, { fixed: false });
    assert.equal(no.body.report.reopen_requested, true);
    assert.equal(no.body.report.resolved_at, null);
    const shared = await c('POST', `/api/citizen/reports/${report.id}/shared`, { channel: 'x' });
    assert.equal(shared.status, 200);
    assert.equal(s.store.get('ticket', t.id).doc.public.report_id, report.id);
    assert.ok(s.store.list('activity').some((d) => d.doc.action === 'Shared publicly by reporter (X)'));
    // Management switched sharing off
    s.store.tx(() => s.store.writeDocs([{ kind: 'setting', id: 'main', doc: { publicSharing: false, auditRoute: null } }], 'op'));
    assert.equal((await c('POST', `/api/citizen/reports/${report.id}/shared`, { channel: 'x' })).status, 409);
  } finally { s.server.close(); }
});

test('photos: refused without the AI check; with it, findings and blur boxes, owner-only access, deleted on schedule', async () => {
  const off = await start();
  const c0 = await verifiedCitizen(off, '9811100022');
  try {
    assert.equal((await c0('POST', '/api/photos', JPEG)).status, 501);
    assert.equal((await c0('POST', '/api/photo-check?category=not_working', JPEG)).status, 501);
  } finally { off.server.close(); }

  const s = await start({ ANTHROPIC_API_KEY: 'test-key', PHOTO_RETENTION_DAYS: '0' });
  assert.match((await client(s.base)('GET', '/server-config.js')).body, /"ai":true/);
  const c = await verifiedCitizen(s, '9811100033');
  const stranger = await verifiedCitizen(s, '9811100044');
  try {
    assert.equal((await c('POST', '/api/photo-check', Buffer.from('not a jpeg'))).status, 415);
    const check = await c('POST', '/api/photo-check?category=not_working', JPEG);
    assert.equal(check.status, 200);
    assert.equal(check.body.findings.lamp, 'off');
    assert.equal(check.body.redact.length, 1, 'malformed boxes dropped');
    assert.equal(aiCalls, 1);
    const up = await c('POST', '/api/photos', JPEG);
    assert.equal(up.status, 201);
    assert.equal((await c('GET', up.body.url, undefined, { raw: true })).body.length, JPEG.length);
    assert.equal((await stranger('GET', up.body.url)).status, 404);
    const { report } = (await c('POST', '/api/citizen/reports', { category: 'not_working', uid: 'SL-CP-IC-001', photo: { kind: 'live', hash: null, url: up.body.url, ai: check.body.findings } })).body;
    assert.equal(report.photo.url, up.body.url);
    assert.equal(report.photo.ai.lamp, 'off');
    // retention 0 days: the next sweep deletes the file and the link
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.sweep(), 1);
    assert.equal(s.store.get('report', report.id).doc.photo.url, null);
    assert.equal((await c('GET', up.body.url)).status, 404);
  } finally { s.server.close(); }
});

test('claims: one staff browser processes a citizen report; settings need an operator or manager', async () => {
  const s = await start();
  s.auth.addUser({ username: 'opr', roles: ['operator'], password: 'operator password' });
  s.auth.addUser({ username: 'crew', roles: ['field'], crew: 'R2 · Deepak R.', password: 'field crew password' });
  const op = client(s.base);
  const crew = client(s.base);
  try {
    await op('POST', '/api/login', { username: 'opr', password: 'operator password' });
    await crew('POST', '/api/login', { username: 'crew', password: 'field crew password' });
    assert.equal((await op('POST', '/api/reports/claim', { id: 'CR-005' })).body.ok, true);
    assert.equal((await op('POST', '/api/reports/claim', { id: 'CR-005' })).body.ok, true, 'the same browser again');
    assert.equal((await crew('POST', '/api/reports/claim', { id: 'CR-005' })).body.ok, false);
    const setting = s.store.get('setting', 'main');
    assert.equal((await crew('POST', '/api/sync', { changes: [{ kind: 'setting', id: 'main', rev: setting.rev, doc: { ...setting.doc, publicSharing: false } }] })).status, 403);
    assert.equal((await op('POST', '/api/sync', { changes: [{ kind: 'setting', id: 'main', rev: setting.rev, doc: { ...setting.doc, publicSharing: false } }] })).status, 200);
    assert.deepEqual((await op('POST', '/api/ccms/poll', { uid: 'SL-CP-IC-001' })).body, { simulated: true });
  } finally { s.server.close(); }
});

test('sign-in attempts are rate limited', async () => {
  const s = await start();
  const c = client(s.base);
  try {
    let last;
    for (let i = 0; i < 11; i++) last = await c('POST', '/api/login', { username: 'asha', password: `guess number ${i}` });
    assert.equal(last.status, 429);
  } finally { s.server.close(); }
});

test('publicDocs keeps a citizen\'s own repair outcome and nothing else from the history', () => {
  const all = [
    { kind: 'pole', id: 'P1', doc: { status: 'Functional', ticket_id: null, repair_history: [{ ticket_id: 'T1', crew: 'R1 · Name', cost_inr: 500, resolved_at: 'x', status: 'Closed' }, { ticket_id: 'T2', crew: 'R2' }] } },
    { kind: 'report', id: 'CR-1', doc: { reporter_id: 'RP-A', ticket_id: 'T1' } },
  ];
  const out = publicDocs(all, 'RP-A');
  assert.deepEqual(out[0].doc.repair_history, [{ ticket_id: 'T1', status: 'Closed', resolved_at: 'x', verified_at: undefined, outcome: undefined }]);
  assert.equal(out[1].doc.mine, true);
  assert.equal(publicDocs(all, 'RP-B').length, 1);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      console.log(`  FAIL  ${name}\n        ${err.stack.split('\n').slice(0, 4).join('\n        ')}`);
    }
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may hold a file briefly */ }
  console.log(`\n${passed} of ${tests.length} server tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
