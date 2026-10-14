// End-to-end test of the pilot server: the app served by server/server.js, a citizen verifying their phone
// and reporting, a staff browser signing in, putting the report on a ticket and syncing, another staff
// member's change arriving, and a conflict. The second person is played through the API from Node.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const J = (v) => JSON.stringify(v);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8097;
const BASE = `http://127.0.0.1:${PORT}`;

/** A second person, through the API (keeps its own cookies). */
function apiClient() {
  const jar = new Map();
  return async (method, url, body) => {
    const headers = { 'x-slgis': '1' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      if (v) jar.set(k, v);
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

export default async function run(t, check) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slgis-e2e-server-'));
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), OTP_DEV_ECHO: '1', SMS_PROVIDER: 'console' };
  for (const [user, roles, extra] of [['asha', 'operator,management', ['--name', 'Asha V.']], ['ravi', 'operator', ['--name', 'Ravi K.']]]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'server', 'admin.js'), 'add-user', user, '--roles', roles, ...extra], { env: { ...env, STAFF_PASSWORD: `${user} pilot password` }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`admin.js: ${r.stderr}`);
  }
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  try {
    for (let i = 0; i < 50 && !/server on/.test(serverLog); i++) await t.sleep(100);
    check(/server on/.test(serverLog), 'server starts', serverLog.split('\n')[0]);
    await steps(t, check);
  } finally {
    server.kill();
    if (/\[error\]/.test(serverLog)) console.log(`  server log:\n${serverLog.split('\n').filter((l) => /\[error\]/.test(l)).slice(0, 5).join('\n')}`);
    check(!/\[error\]/.test(serverLog), 'no server errors');
  }
}

async function steps(t, check) {
  const ev = (expr) => t.eval(expr);
  const box = (sel) => ev(`(() => { const el = document.querySelector(${J(sel)}); if (!el || !el.offsetParent) return null;
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clickSel = async (sel, wait = 400) => {
    let b = await box(sel);
    for (let i = 0; i < 20 && b; i++) {
      await t.sleep(80);
      const next = await box(sel);
      if (next && Math.abs(next.x - b.x) < 0.5 && Math.abs(next.y - b.y) < 0.5) break;
      b = next;
    }
    if (!b) throw new Error(`no visible element ${sel}`);
    await t.click(b.x, b.y);
    await t.sleep(wait);
  };
  const waitFor = async (expr, ms = 10000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (await ev(expr).catch(() => false)) return true; // the page may be reloading
      await t.sleep(100);
    }
    return false;
  };
  /** Wait until the sidebar has stopped sliding (a click during the slide-in can miss). */
  const settle = () => waitFor(`document.querySelector('#sidebar').getAnimations({ subtree: true }).length === 0`, 3000);
  const typeInto = async (sel, text) => {
    await clickSel(sel, 100);
    await ev(`document.querySelector(${J(sel)}).select?.()`);
    await t.type(text);
  };

  // ------------------------------------------------------------------ 1. A visitor
  console.log('\n# 1. A visitor opens the pilot');
  await t.viewport(1440, 900);
  await t.goto(`${BASE}/`);
  await waitFor('window.slgis && slgis.state.byUid.size > 0');
  const visitor = await ev(`({ mode: SERVER?.mode, role: slgis.state.role, views: [...document.querySelectorAll('[data-role-switch]')].map(b => b.dataset.roleSwitch),
    line: document.querySelector('#session-line').innerText, poles: slgis.state.byUid.size, tickets: slgis.state.tickets.size, scope: SYNC.scope,
    notes: [...slgis.state.tickets.values()].some(t => t.notes), reports: slgis.state.reports.length })`);
  check(visitor.mode === 'server' && visitor.scope === 'public', 'served by the pilot server, public copy', J(visitor));
  check(visitor.role === 'citizen' && J(visitor.views) === J(['citizen']), 'a visitor gets the Citizen view only');
  check(/Staff sign-in/.test(visitor.line), 'staff sign-in offered', visitor.line);
  check(visitor.poles === 119 && visitor.tickets > 20 && !visitor.notes && visitor.reports === 0, 'poles and tickets, without staff notes or anyone\'s reports');
  await t.shot('srv-01-visitor.png');

  // ------------------------------------------------------------------ 2. The citizen verifies their phone and reports
  console.log('\n# 2. A citizen verifies their phone and reports');
  const uid = await ev(`[...slgis.state.byUid.keys()].find(u => { const p = props(u); return p.status === 'Functional' && !p.ticket && !p.ccms_node && !shutdownOf(p); })`);
  await ev(`beginReport(slgis.state.byUid.get(${J(uid)}).latlng, ${J(uid)})`);
  await t.sleep(400);
  await clickSel('#rm-issues input[value="not_working"] + span', 200);
  const form = await ev(`({ contactOpen: document.querySelector('#rm-contact').open, phone: !!document.querySelector('#rm-otp-phone').offsetParent, demoFields: !!document.querySelector('#rm-contact-demo').offsetParent,
    label: document.querySelector('#rm-contact-label').textContent, foot: document.querySelector('#rm-footnote').textContent })`);
  check(form.contactOpen && form.phone && !form.demoFields && /mobile number/.test(form.label) && /not stored/.test(form.foot), 'the form asks for a mobile number to verify, says it is not stored', J(form));
  await clickSel('#report-form button[type="submit"]', 300);
  check(/Verify your mobile/.test(await ev(`document.querySelector('#rm-otp-status').textContent`)), 'sending before verifying asks for the code first');
  await typeInto('#rm-otp-phone', '98111 22233');
  await clickSel('[data-otp="send"]', 600);
  const sent = await ev(`document.querySelector('#rm-otp-status').textContent`);
  const code = /code is (\d{6})/.exec(sent)?.[1];
  check(Boolean(code) && /\*{6}2233/.test(sent), 'code sent (development server shows it)', sent);
  await typeInto('#rm-otp-input', '000000' === code ? '111111' : '000000');
  await clickSel('[data-otp="verify"]', 500);
  check(/Wrong code/.test(await ev(`document.querySelector('#rm-otp-status').textContent`)), 'a wrong code is refused');
  await typeInto('#rm-otp-input', code);
  await clickSel('[data-otp="verify"]', 800);
  check(await ev(`!document.querySelector('#rm-otp-done').hidden && SYNC.me.citizen?.reporterId?.startsWith('RP-')`), 'mobile verified');
  await t.shot('srv-02-verified.png');
  await clickSel('#report-form button[type="submit"]', 1200);
  const filed = await ev(`(() => { const r = slgis.state.reports.find(x => x.mine && x.uid === ${J(uid)}); return { id: r?.id, pending: r?.pending, view: slgis.state.selected?.type, text: document.querySelector('#sidebar-content').innerText }; })()`);
  check(/^CR-\d{3}$/.test(filed.id ?? '') && filed.pending && filed.view === 'myreports' && /Received/.test(filed.text), 'report sent: My reports shows it as Received', J({ id: filed.id, pending: filed.pending, view: filed.view }));
  const ravi = apiClient();
  await ravi('POST', '/api/login', { username: 'ravi', password: 'ravi pilot password' });
  const docOf = async (kind, id) => (await ravi('GET', '/api/state')).body.docs.find((d) => d.kind === kind && d.id === id);
  const stored = await docOf('report', filed.id);
  check(stored?.doc.pending === true && /^RP-[0-9A-F]{10}$/.test(stored.doc.reporter_id) && !('phone' in stored.doc), 'on the server: waiting for a staff browser; reporter ID, no phone number', J(stored?.doc));

  // ------------------------------------------------------------------ 3. Staff sign in and the report goes on a ticket
  console.log('\n# 3. Staff sign in');
  await clickSel('[data-action="staff-login"]', 300);
  check(await ev(`!document.querySelector('#login-modal').hidden`), 'sign-in dialog opens');
  await typeInto('#login-form input[name="username"]', 'asha');
  await typeInto('#login-form input[name="password"]', 'wrong password');
  await clickSel('#login-form button[type="submit"]', 200);
  await waitFor(`!document.querySelector('#lm-error').hidden`, 5000);
  const refused = await ev(`({ text: document.querySelector('#lm-error').textContent, hidden: document.querySelector('#lm-error').hidden, open: !document.querySelector('#login-modal').hidden })`);
  check(/Wrong username or password/.test(refused.text) && refused.open, 'a wrong password is refused', J(refused));
  await typeInto('#login-form input[name="password"]', 'asha pilot password');
  await clickSel('#login-form button[type="submit"]', 2500);
  await waitFor(`window.slgis && slgis.state.byUid.size > 0 && SYNC.me.staff`);
  const staff = await ev(`({ role: slgis.state.role, scope: SYNC.scope, views: [...document.querySelectorAll('[data-role-switch]')].map(b => b.dataset.roleSwitch), line: document.querySelector('#session-line').innerText })`);
  check(staff.scope === 'staff' && staff.role === 'operator' && J(staff.views) === J(['citizen', 'operator', 'management']), 'signed in: the views this person may open (no Field crew)', J(staff));
  check(/Signed in: Asha V\./.test(staff.line), 'session line names who is signed in', staff.line);
  const processed = await waitFor(`(() => { const r = slgis.state.reports.find(x => x.id === ${J(filed.id)}); return r && !r.pending && r.ticket_id; })()`, 15000);
  const ticketId = await ev(`slgis.state.reports.find(x => x.id === ${J(filed.id)})?.ticket_id`);
  check(processed && /^TKT-\d{4}-\d{4}$/.test(ticketId ?? ''), 'the staff browser puts the citizen report on a ticket', ticketId);
  await t.sleep(1500);
  const onServer = { report: (await docOf('report', filed.id))?.doc, ticket: (await docOf('ticket', ticketId))?.doc, pole: (await docOf('pole', uid))?.doc };
  check(onServer.report?.pending === false && onServer.report?.ticket_id === ticketId && onServer.ticket?.status === 'Open' && onServer.pole?.ticket_id === ticketId && onServer.pole?.status === 'Faulty',
    'saved on the server: report on the ticket, pole Faulty', J({ r: onServer.report?.ticket_id, t: onServer.ticket?.status, p: onServer.pole?.status }));
  check(!('score' in (onServer.ticket ?? {})) && !('sla_due' in (onServer.ticket ?? {})) && onServer.ticket?.band, 'derived values are not stored (only the band, for citizens)', J(Object.keys(onServer.ticket ?? {})));

  // ------------------------------------------------------------------ 4. An operator action is saved
  console.log('\n# 4. Dispatch, saved for everyone');
  await ev(`selectPole(${J(uid)})`);
  await t.sleep(400);
  await settle();
  check(await ev(`!/Demo workflow/.test(document.querySelector('#sidebar-content').innerText)`), 'no "Demo workflow" label on the pilot server');
  await settle();
  await clickSel('[data-action="dispatch"]', 300);
  check(await ev(`slgis.state.tickets.get(${J(ticketId)})?.status === 'In Progress'`), 'Dispatch: the ticket is in progress on this screen');
  await t.sleep(1200);
  await t.sleep(800);
  const dispatched = { ticket: (await docOf('ticket', ticketId))?.doc, pole: (await docOf('pole', uid))?.doc };
  check(dispatched.ticket?.status === 'In Progress' && dispatched.ticket?.assigned_crew && dispatched.pole?.status === 'Under Maintenance', 'Dispatch reaches the server', J({ t: dispatched.ticket?.status, crew: dispatched.ticket?.assigned_crew, p: dispatched.pole?.status }));
  const activity = (await ravi('GET', '/api/state')).body.docs.filter((d) => d.kind === 'activity' && d.doc.ticket === ticketId).map((d) => d.doc.action);
  check(activity.some((a) => /Dispatched|dispatch/i.test(a)) && !activity.some((a) => /^Escalated to/.test(a)), 'the audit trail is saved (escalations are recomputed, not stored)', J(activity));

  // ------------------------------------------------------------------ 5. Someone else's change arrives
  console.log('\n# 5. Another operator\'s change arrives');
  const other = await docOf('ticket', 'TKT-2026-0156');
  const note = 'Ravi: contractor called, crew tomorrow';
  await ravi('POST', '/api/sync', { changes: [{ kind: 'ticket', id: other.id, rev: other.rev, doc: { ...other.doc, notes: note } }] });
  check(await waitFor(`slgis.state.tickets.get('TKT-2026-0156')?.notes === ${J(note)}`, 12000), 'it shows here within seconds, without a reload');

  // ------------------------------------------------------------------ 6. Both change the same ticket: a conflict
  console.log('\n# 6. A conflict');
  await ev('SYNC.paused = true'); // hold this browser's sends and pulls while the other operator acts
  const mine = await docOf('ticket', ticketId);
  const r2 = await ravi('POST', '/api/sync', { changes: [{ kind: 'ticket', id: ticketId, rev: mine.rev, doc: { ...mine.doc, notes: 'Ravi: crew changed' } }] });
  check(r2.status === 200, 'the other operator saves first');
  await ev(`selectPole(${J(uid)})`);
  await t.sleep(300);
  await ev(`(() => { const t = slgis.state.tickets.get(${J(ticketId)}); t.notes = 'Asha: my note'; logActivity('Note added', { ticket: t }); })()`);
  await ev('SYNC.paused = false; pushChanges()');
  await t.sleep(1500);
  const conflict = await ev(`({ notes: slgis.state.tickets.get(${J(ticketId)})?.notes, toast: [...document.querySelectorAll('.toast-title')].map(e => e.textContent) })`);
  check(conflict.toast.includes('Updated by someone else') && conflict.notes === 'Ravi: crew changed', 'refused and reloaded: the other change wins, and this screen says so', J(conflict));
  await t.shot('srv-03-conflict.png');

  // ------------------------------------------------------------------ 7. Reload: everything is still there
  console.log('\n# 7. Saved across a reload');
  await t.goto(`${BASE}/`);
  await waitFor(`window.slgis && slgis.state.byUid.size > 0 && SYNC.me.staff`);
  const after = await ev(`({ t: slgis.state.tickets.get(${J(ticketId)})?.status, p: props(${J(uid)}).status, n: slgis.state.tickets.get('TKT-2026-0156')?.notes })`);
  check(after.t === 'In Progress' && after.p === 'Under Maintenance' && after.n === note, 'after a reload: still dispatched, still noted', J(after));
  await clickSel('[data-action="staff-logout"]', 500);
  const out = await waitFor(`typeof SYNC !== 'undefined' && window.slgis && slgis.state.byUid.size > 0 && !SYNC.me.staff && SYNC.scope === 'public'`, 15000);
  check(out && await ev(`slgis.state.role === 'citizen'`), 'sign out: back to the public view');
}
