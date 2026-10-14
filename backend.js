/* ==========================================================================
 * Street Light GIS · backend.js
 * Section 19: the pilot server. Active only when server/server.js serves the app (SERVER is set);
 * from file:// or GitHub Pages this file does nothing and everything stays in the browser, as before.
 *
 * How it fits: the workflow logic stays in this app. The server stores the state as documents
 * (poles, tickets, reports, reporters, activity, settings). A staff browser loads them, works as
 * before, and after each action sends the documents that changed; when someone else changed the
 * same document first, the server refuses and this browser reloads the latest state. Citizens get
 * a filtered copy and only send reports, "Fixed?" answers and shares, which a staff browser then
 * puts on tickets (the same processReport as in the demo).
 * ========================================================================== */
'use strict';

// ========================================================================
// 19. Pilot server
// ========================================================================
const SYNC = {
  seq: 0,                  // last change sequence seen from the server
  scope: 'public',         // 'staff' (everything) | 'public' (filtered; a citizen's own reports)
  me: { staff: null, citizen: null },
  cache: new Map(),        // 'kind:id' -> { kind, id, rev, doc }: the server's documents as last seen
  synced: new Map(),       // 'kind:id' -> JSON of each document as this browser last loaded or sent it
  lease: { tickets: [], reports: [] },
  paused: false,           // stop talking to the server (tests use it to stage a conflict)
  timer: null,
  online: true,
  clientId: Math.random().toString(36).slice(2, 8),
  n: 0,
};
const docKey = (kind, id) => `${kind}:${id}`;
const DERIVED_TICKET_FIELDS = new Set(['confidence', 'score', 'priority', 'why', 'sla_hours', 'sla_why', 'sla_due', 'escalation', 'escalationIndex', 'latlng', 'band']);
const isEscalationEntry = (e) => e.role === 'System' && /^Escalated to /.test(e.action); // recomputed by every browser, never saved
const PHOTO_LINK = /^\/api\/photos\/[a-f0-9]{32}$/;

async function serverApi(method, path, body) {
  const opts = { method, headers: { 'x-slgis': '1' }, credentials: 'same-origin' };
  if (body instanceof Blob) {
    opts.body = body;
    opts.headers['content-type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${SERVER.api}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ---- 19.1 Boot: who is this, and the state -------------------------------------------------------
async function serverBoot() {
  const [me, st] = await Promise.all([serverApi('GET', '/me'), serverApi('GET', '/state')]);
  SYNC.me = me;
  takeState(st);
  state.role = defaultRoleHere();
  if (me.staff?.crew) state.crew = me.staff.crew;
  if (me.staff) await refillLease();
}
function takeState(st) {
  SYNC.seq = st.seq;
  SYNC.scope = st.scope;
  SYNC.cache = new Map(st.docs.map((d) => [docKey(d.kind, d.id), d]));
}

const staffRoles = () => SYNC.me.staff?.roles ?? [];
/** Server mode: Citizen for everyone; the other views for staff with that role. The demo allows every view. */
const roleAllowedHere = (role) => !SERVER || role === 'citizen' || staffRoles().includes(role);
const defaultRoleHere = () => (!SERVER ? DEFAULT_ROLE : staffRoles().includes('operator') ? 'operator' : staffRoles()[0] ?? 'citizen');

/** indexTickets() in server mode: build the in-memory state from the server's documents. */
function indexFromDocs() {
  const docs = (kind) => [...SYNC.cache.values()].filter((d) => d.kind === kind);
  state.tickets.clear();
  state.closed.clear();
  state.reports.length = 0;
  state.reporters.clear();
  state.activity.length = 0;
  for (const d of docs('ticket')) {
    const { position, closed, band, ...t } = structuredClone(d.doc);
    const team = t.team;
    prepareTicket(t, t.kind ?? 'pole');
    if (team) t.team = team; // re-routed by a crew (e.g. an obstruction to horticulture)
    if (position) t.latlng = toLatLng(position);
    if (band !== undefined && SYNC.scope === 'public') t.band = band; // the public sees the staff's confidence band, not the evidence
    (closed ? state.closed : state.tickets).set(t.id, t);
  }
  for (const f of state.features) {
    const p = f.properties;
    const d = SYNC.cache.get(docKey('pole', p.uid))?.doc;
    if (d) {
      p.status = d.status;
      p.repair_history = structuredClone(d.repair_history ?? []);
      p.last_inspected = d.last_inspected ?? p.last_inspected;
      p.fixture_type = d.fixture_type ?? p.fixture_type;
    }
    p.ticket = d?.ticket_id ? state.tickets.get(d.ticket_id) ?? null : null;
  }
  for (const d of docs('reporter')) state.reporters.set(d.id, { ...d.doc });
  for (const d of docs('report').sort((a, b) => new Date(a.doc.created_at) - new Date(b.doc.created_at))) state.reports.push(reportFromDoc(d.doc));
  for (const d of docs('activity').sort((a, b) => new Date(a.doc.at) - new Date(b.doc.at))) state.activity.push({ ...d.doc, _id: d.id });
  const setting = SYNC.cache.get(docKey('setting', 'main'))?.doc;
  if (setting) {
    state.publicSharing = setting.publicSharing ?? state.publicSharing;
    state.auditRoute = setting.auditRoute ?? null;
  }
  SYNC.synced = new Map([...snapshotDocs()].map(([k, d]) => [k, comparable(d.kind, d.doc)]));
}

/** A stored report as the app uses it: positions back to L.LatLng. */
function reportFromDoc(doc) {
  const r = structuredClone(doc);
  r.latlng = r.uid ? state.byUid.get(r.uid)?.latlng ?? null : r.position ? toLatLng(r.position) : null;
  delete r.position;
  if (r.device?.position) r.device = { latlng: toLatLng(r.device.position), accuracy_m: r.device.accuracy_m };
  r.mine = Boolean(doc.mine);
  if (!r.resolved_at && r.ticket_id && !state.tickets.has(r.ticket_id) && !state.closed.has(r.ticket_id)) { // closed before the server started
    const h = props(r.uid)?.repair_history.find((x) => x.ticket_id === r.ticket_id);
    if (h) {
      r.resolved_at = h.verified_at ?? h.resolved_at;
      r.outcome ??= h.outcome ?? 'confirmed';
    }
  }
  return r;
}

/** The state as documents, the way the server stores them. Derived values (priority, SLA, confidence) are left out. */
function snapshotDocs() {
  const out = new Map();
  const put = (kind, id, doc) => out.set(docKey(kind, id), { kind, id, doc });
  for (const f of state.features) {
    const p = f.properties;
    put('pole', p.uid, { status: p.status, ticket_id: p.ticket?.id ?? null, repair_history: p.repair_history ?? [], last_inspected: p.last_inspected ?? null, fixture_type: p.fixture_type });
  }
  for (const [tickets, closed] of [[state.tickets, false], [state.closed, true]]) {
    for (const t of tickets.values()) {
      const doc = {};
      for (const [k, v] of Object.entries(t)) if (!DERIVED_TICKET_FIELDS.has(k) && v !== undefined) doc[k] = v;
      if (t.kind === 'location' && t.latlng) doc.position = toPosition(t.latlng);
      if (doc.dusk_photo) doc.dusk_photo = { at: doc.dusk_photo.at, url: PHOTO_LINK.test(doc.dusk_photo.url ?? '') ? doc.dusk_photo.url : null };
      doc.closed = closed;
      doc.band = t.confidence?.band ?? null; // so citizens can see "Confirmed" without seeing the evidence
      put('ticket', t.id, doc);
    }
  }
  for (const r of state.reports) {
    const { latlng, device, mine, name, phone, ...doc } = r; // eslint-disable-line no-unused-vars
    doc.position = r.uid || !latlng ? null : toPosition(latlng);
    doc.device = device?.latlng ? { position: toPosition(device.latlng), accuracy_m: device.accuracy_m } : null;
    if (doc.photo) {
      const { url, ready, file, ...photo } = doc.photo; // eslint-disable-line no-unused-vars
      doc.photo = PHOTO_LINK.test(url ?? '') ? { ...photo, url } : photo;
    }
    put('report', r.id, doc);
  }
  for (const r of state.reporters.values()) {
    const { mine, ...doc } = r; // eslint-disable-line no-unused-vars
    put('reporter', r.id, doc);
  }
  for (const e of state.activity) {
    if (isEscalationEntry(e)) continue;
    e._id ??= `${SYNC.clientId}-${Date.now().toString(36)}-${++SYNC.n}`;
    const { _id, ...doc } = e;
    put('activity', _id, doc);
  }
  put('setting', 'main', { publicSharing: state.publicSharing, auditRoute: state.auditRoute ?? null });
  return out;
}

/** Rebuild everything from the cached documents (another browser changed something, or a conflict). */
function rebuildFromCache() {
  indexFromDocs();
  rateAllTickets({ initial: true }); // escalation steps, recomputed from the clock
  afterDataChange();
  renderSessionLine();
  if (SYNC.me.staff) {
    scheduleSync(); // e.g. a circuit fault just collapsed into a new ticket
    processInbox();
  }
}

// ---- 19.2 Staff: send changes, receive other people's ------------------------------------------
// One conversation with the server at a time: a pull never rebuilds the state while a send is on its way.
let serverTurn = Promise.resolve();
function inTurn(fn) {
  const run = serverTurn.then(fn);
  serverTurn = run.catch(() => {});
  return run;
}
const pushChanges = () => inTurn(pushNow);
const pullChanges = () => inTurn(pullNow);

function scheduleSync(delay = SYNC_DEBOUNCE_MS) {
  if (!SERVER || !SYNC.me.staff) return;
  clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(pushChanges, delay);
}

/** What decides whether a document changed. A ticket's band alone is not a change: it follows the evidence and the clock. */
const comparable = (kind, doc) => JSON.stringify(kind === 'ticket' ? { ...doc, band: undefined } : doc);

function localChanges() {
  const changes = [];
  for (const [key, d] of snapshotDocs()) {
    const cmp = comparable(d.kind, d.doc);
    if (SYNC.synced.get(key) !== cmp) changes.push({ ...d, cmp });
  }
  return changes;
}

/**
 * Send what changed, again until nothing is left (more can change while a send is on its way).
 * Returns false after a conflict (the state was reloaded); true otherwise, even if offline (the changes stay).
 */
async function pushNow() {
  if (!SYNC.me.staff || SYNC.paused) return true;
  for (let round = 0; round < 5; round++) {
    const changes = localChanges();
    if (!changes.length) return true;
    try {
      const res = await serverApi('POST', '/sync', { changes: changes.map((c) => ({ kind: c.kind, id: c.id, rev: SYNC.cache.get(docKey(c.kind, c.id))?.rev ?? 0, doc: c.doc })) });
      for (const c of changes) {
        const key = docKey(c.kind, c.id);
        SYNC.cache.set(key, { kind: c.kind, id: c.id, rev: res.revs[key], doc: JSON.parse(JSON.stringify(c.doc)) }); // as the server stores it
        SYNC.synced.set(key, c.cmp);
      }
      setOnline(true);
    } catch (err) {
      if (err.status === 409) {
        const conflicts = err.data?.conflicts ?? [];
        console.warn(`[sync] changed elsewhere first: ${conflicts.map((k) => `${k} (sent rev ${SYNC.cache.get(k)?.rev ?? 0}, server has ${err.data?.current?.[k]})`).join(', ')}; reloading`);
        await reloadAfterConflict(conflicts);
        return false;
      }
      if (err.status === 401) return sessionEnded();
      setOnline(false);
      scheduleSync(SYNC_RETRY_MS);
      return true;
    }
  }
  return true;
}

async function reloadAfterConflict(conflicts) {
  takeState(await serverApi('GET', '/state'));
  rebuildFromCache();
  const ticket = conflicts.map((k) => /^ticket:(.+)$/.exec(k)?.[1]).find(Boolean);
  toast({ tone: 'warn', icon: 'fa-rotate', title: 'Updated by someone else', body: `${ticket ? `${ticket} changed` : 'The same record changed'} on another screen at the same time. This is the latest; check it and redo your last step if it is still needed.` });
}

async function pullNow() {
  if (SYNC.paused) return;
  try {
    if (!SYNC.me.staff) { // citizens and visitors: reload the filtered state when anything changed
      const { seq } = await serverApi('GET', `/changes?since=${SYNC.seq}`);
      if (seq !== SYNC.seq) {
        takeState(await serverApi('GET', '/state'));
        rebuildFromCache();
      }
      setOnline(true);
      return;
    }
    const res = await serverApi('GET', `/changes?since=${SYNC.seq}`);
    const remote = res.docs.filter((d) => (SYNC.cache.get(docKey(d.kind, d.id))?.rev ?? 0) < d.rev);
    setOnline(true);
    if (remote.length) {
      if (!(await pushNow())) return; // ours first; a conflict reloaded everything
      if (localChanges().length) return; // ours could not be sent: keep them, and take these on the next pull
      for (const d of remote) SYNC.cache.set(docKey(d.kind, d.id), d);
      rebuildFromCache();
    }
    SYNC.seq = Math.max(SYNC.seq, res.seq);
  } catch (err) {
    if (err.status === 401 && SYNC.me.staff) sessionEnded();
    else setOnline(false);
  }
}

function startSync() {
  if (!SERVER) return;
  setInterval(pullChanges, SYNC.me.staff ? STAFF_PULL_MS : PUBLIC_PULL_MS);
  if (!SYNC.me.staff) return;
  // Any click, key or form change may have changed the state; actions are debounced into one send.
  for (const type of ['click', 'change', 'submit', 'keyup']) document.addEventListener(type, () => scheduleSync(), true);
  setInterval(() => scheduleSync(0), STAFF_PULL_MS); // changes made by the clock (dusk checks, collapses)
  window.addEventListener('beforeunload', (e) => {
    if (localChanges().length) e.preventDefault(); // unsent changes: let the browser ask
  });
  scheduleSync(0);
  processInbox();
}

function setOnline(on) {
  if (SYNC.online === on) return;
  SYNC.online = on;
  renderSessionLine();
  if (!on) toast({ tone: 'warn', icon: 'fa-plug-circle-xmark', title: 'Server not reachable', body: 'Changes are kept on this screen and sent when the connection is back.' });
}

function sessionEnded() {
  toast({ tone: 'warn', icon: 'fa-user-lock', title: 'Signed out', body: 'Your session ended. Sign in again; unsent changes on this screen are not saved.' });
  setTimeout(() => location.reload(), 2500);
  return false;
}

// ---- 19.3 IDs handed out by the server -----------------------------------------------------------
async function refillLease() {
  const want = { tickets: Math.max(0, ID_LEASE_SIZE - SYNC.lease.tickets.length), reports: Math.max(0, ID_LEASE_SIZE - SYNC.lease.reports.length) };
  if (!want.tickets && !want.reports) return;
  try {
    const got = await serverApi('POST', '/ids', want);
    SYNC.lease.tickets.push(...got.tickets);
    SYNC.lease.reports.push(...got.reports);
  } catch {
    // offline: try again on the next use
  }
}
/** The next ticket or report ID from the ones in hand (topped up in the background). */
function takeLeasedId(kind) {
  const id = SYNC.lease[kind].shift();
  if (SYNC.lease[kind].length < 3) refillLease();
  if (!id) throw new Error('No IDs in hand: the server could not be reached. Try again in a moment.');
  return id;
}

// ---- 19.4 Staff browsers put citizen reports on tickets ---------------------------------------------
const processInbox = () => inTurn(processInboxNow);

/** Citizen reports waiting for a ticket, and "not fixed" answers: claim each (one staff browser does it), then the demo's own logic. */
async function processInboxNow() {
  if (!SYNC.me.staff || SYNC.paused) return;
  const todo = state.reports.filter((r) => (r.pending && !r.review) || r.reopen_requested).map((r) => r.id);
  if (!todo.length) return;
  let changed = false;
  try {
    await refillLease();
    for (const id of todo) {
      const { ok } = await serverApi('POST', '/reports/claim', { id });
      const r = ok ? reportById(id) : null;
      if (!r) continue;
      if (r.reopen_requested) {
        r.reopen_requested = false;
        applyNotFixed(r);
        changed = true;
      } else if (r.pending) {
        r.pending = false;
        processReport(r, 'citizen');
        changed = true;
      }
    }
  } catch {
    // offline or the server restarted: the next pull tries again
  }
  if (changed) {
    afterDataChange();
    await pushNow();
  }
}

// ---- 19.5 Staff sign-in ------------------------------------------------------------------------
function renderSessionLine() {
  const line = $('#session-line');
  if (!SERVER || !line) return;
  line.hidden = false;
  const staff = SYNC.me.staff;
  const offline = SYNC.online ? '' : '<span class="session-offline"><i class="fa-solid fa-plug-circle-xmark" aria-hidden="true"></i> Offline</span>';
  line.innerHTML = staff
    ? `<span class="min-w-0 truncate">Signed in: ${esc(staff.name)}</span>${offline}<button type="button" class="link" data-action="staff-logout">Sign out</button>`
    : `${offline}<button type="button" class="link" data-action="staff-login">${esc(tr('staff_signin'))}</button>`;
  $('#view-switch').setAttribute('aria-label', 'View');
  $('#view-switch').removeAttribute('title');
}

function openStaffLogin() {
  const m = $('#login-modal');
  m.hidden = false;
  $('#lm-error').hidden = true;
  $('#login-form').reset();
  $('#login-form input[name="username"]').focus();
}
function closeStaffLogin() { $('#login-modal').hidden = true; }

async function submitStaffLogin() {
  const fd = new FormData($('#login-form'));
  const err = $('#lm-error');
  try {
    await serverApi('POST', '/login', { username: String(fd.get('username') ?? '').trim(), password: String(fd.get('password') ?? '') });
    restartAt(''); // staff see the full state: start again from it, in their own default view
  } catch (e) {
    err.textContent = e.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : e.status === 401 ? 'Wrong username or password.' : 'The server could not be reached.';
    err.hidden = false;
  }
}
async function staffLogout() {
  if (localChanges().length) await pushChanges();
  await serverApi('POST', '/logout', {}).catch(() => {});
  restartAt('');
}
/** Reload the app at a hash (the view in the old hash may not be open to the new session). */
function restartAt(hash) {
  history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  location.reload();
}

// ---- 19.6 Citizens: verify the phone, send the report ------------------------------------------------
function syncContactMode() {
  if (!SERVER) return;
  $('#rm-contact-demo').hidden = true;
  $('#rm-contact-server').hidden = false;
  $('#rm-contact-optional').hidden = true;
  for (const [id, key] of [['#rm-contact-label', 'form_contact_server'], ['#rm-footnote', 'form_server']]) {
    $(id).dataset.i18n = key;
    $(id).textContent = tr(key);
  }
  const verified = Boolean(SYNC.me.citizen);
  $('#rm-otp-ask').hidden = verified;
  $('#rm-otp-code').hidden = true;
  $('#rm-otp-done').hidden = !verified;
  $('#rm-otp-status').textContent = '';
  $('#rm-contact').open = true; // required on the pilot server; shows "Mobile verified" once done
}

async function otpSend() {
  const status = $('#rm-otp-status');
  const phone = $('#rm-otp-phone').value;
  status.textContent = tr('sending');
  try {
    const res = await serverApi('POST', '/otp/start', { phone });
    const digits = phone.replace(/\D/g, '');
    status.textContent = `${tr('otp_sent', { last4: digits.slice(-4) })}${res.devCode ? ` ${tr('otp_dev', { code: res.devCode })}` : ''}`;
    $('#rm-otp-code').hidden = false;
    $('#rm-otp-input').focus();
  } catch (err) {
    status.textContent = err.status === 400 ? tr('form_mobile_error') : tr('otp_failed');
  }
}

async function otpVerify() {
  const status = $('#rm-otp-status');
  try {
    const res = await serverApi('POST', '/otp/verify', { phone: $('#rm-otp-phone').value, code: $('#rm-otp-input').value });
    SYNC.me.citizen = res.citizen;
    $('#rm-otp-input').value = '';
    syncContactMode();
    takeState(await serverApi('GET', '/state')); // now with this person's own reports
    rebuildFromCache();
  } catch (err) {
    status.textContent = err.status === 401 ? tr('otp_wrong') : tr('otp_expired');
  }
}

/** Citizen report on the pilot server: photo checked and blurred, then the report; a staff browser puts it on a ticket. */
async function submitCitizenReport({ category, draft, photoDraft, noticed, note }) {
  if (!SYNC.me.citizen) {
    $('#rm-contact').open = true;
    $('#rm-otp-status').textContent = tr('otp_needed');
    $('#rm-otp-phone').focus();
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const photo = photoDraft ? await preparePhoto(photoDraft, category) : null;
    const { report } = await serverApi('POST', '/citizen/reports', {
      category, uid: draft.uid, position: draft.uid ? null : toPosition(draft.clickLatLng), note, noticed, photo,
      device: draftDevice ? { position: toPosition(draftDevice.latlng), accuracy_m: draftDevice.accuracy_m } : null,
    });
    state.reports.push(reportFromDoc(report));
    closeReportModal({ restoreFocus: false });
    setReportMode(false);
    afterDataChange();
    openMyReports();
    toast({ tone: 'ok', icon: 'fa-circle-check', title: tr('toast_sent'), body: tr('toast_sent_body', { id: report.id }) });
    setTimeout(pullChanges, 6000); // a staff browser puts it on a ticket within seconds
  } catch (err) {
    if (err.status === 401) {
      SYNC.me.citizen = null;
      syncContactMode();
    }
    toast({ tone: 'warn', icon: 'fa-triangle-exclamation', title: tr('send_failed') });
  } finally {
    button.disabled = false;
  }
}

async function citizenFeedback(reportId, fixed) {
  try {
    const { report } = await serverApi('POST', `/citizen/reports/${encodeURIComponent(reportId)}/feedback`, { fixed });
    const i = state.reports.findIndex((r) => r.id === reportId);
    if (i >= 0) state.reports[i] = reportFromDoc(report);
    renderSelected({ keepScroll: true });
    if (!fixed) toast({ tone: 'info', icon: 'fa-rotate-left', title: tr('st_reopened'), body: tr('reopened_toast') });
  } catch {
    toast({ tone: 'warn', icon: 'fa-triangle-exclamation', title: tr('send_failed') });
  }
}
function citizenShared(reportId, channel) {
  serverApi('POST', `/citizen/reports/${encodeURIComponent(reportId)}/shared`, { channel: channel === 'X' ? 'x' : 'share' }).catch(() => {});
}

// ---- 19.7 Photos: downsize, AI check, blur faces and number plates, upload ---------------------------
/**
 * The photo for a report. Without the AI check nothing is uploaded: only the perceptual hash (for
 * "same photo" matching) leaves the phone, because faces and plates cannot be blurred first.
 */
async function preparePhoto(photoDraft, category) {
  await photoDraft.ready;
  const photo = { kind: photoDraft.kind, hash: photoDraft.hash };
  if (!SERVER.ai || !photoDraft.file) return photo;
  try {
    const jpeg = await downsizeJpeg(photoDraft.file);
    const check = await serverApi('POST', `/photo-check?category=${encodeURIComponent(category)}`, jpeg);
    const safe = await blurBoxes(jpeg, check.redact);
    const { url } = await serverApi('POST', '/photos', safe);
    return { ...photo, url, ai: check.findings };
  } catch {
    return photo; // the report goes without the picture rather than not at all
  }
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not an image'));
    };
    img.src = url;
  });
}
const canvasJpeg = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_JPEG_QUALITY));

/** Longest side to PHOTO_MAX_PX, re-encoded as JPEG (which also drops EXIF, including any GPS position). */
async function downsizeJpeg(file) {
  const img = await loadImage(file);
  const k = Math.min(1, PHOTO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * k);
  canvas.height = Math.round(img.naturalHeight * k);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvasJpeg(canvas);
}

/** Blur each box (fractions of the image), grown by PHOTO_BLUR_PAD on every side. */
async function blurBoxes(jpeg, boxes) {
  if (!boxes?.length) return jpeg;
  const img = await loadImage(jpeg);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  for (const b of boxes) {
    const x = clamp(b.x - b.w * PHOTO_BLUR_PAD, 0, 1) * canvas.width;
    const y = clamp(b.y - b.h * PHOTO_BLUR_PAD, 0, 1) * canvas.height;
    const w = clamp(b.w * (1 + 2 * PHOTO_BLUR_PAD), 0, 1) * canvas.width;
    const h = clamp(b.h * (1 + 2 * PHOTO_BLUR_PAD), 0, 1) * canvas.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = `blur(${PHOTO_BLUR_PX}px)`;
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'; // and darken, in case the browser ignores canvas filters
    ctx.fillRect(x, y, w, h);
  }
  return canvasJpeg(canvas);
}

/** A crew's night photo on the pilot server: blurred and uploaded when the AI check is on; otherwise it stays on this phone. */
async function uploadDuskPhoto(t, file) {
  if (!SERVER?.ai) return;
  try {
    const jpeg = await downsizeJpeg(file);
    const check = await serverApi('POST', '/photo-check?category=other', jpeg);
    const { url } = await serverApi('POST', '/photos', await blurBoxes(jpeg, check.redact));
    if (t.dusk_photo) t.dusk_photo.url = url;
    scheduleSync(0);
  } catch {
    // kept on this phone only
  }
}

// ---- 19.8 CCMS poll through the server -------------------------------------------------------------
/** Live CCMS when the server has an adapter; null means "use the simulation". */
async function serverCcmsPoll(uid) {
  if (!SERVER || SERVER.ccms === 'simulated') return null;
  try {
    const res = await serverApi('POST', '/ccms/poll', { uid });
    return res.simulated ? null : res;
  } catch {
    toast({ tone: 'warn', icon: 'fa-tower-broadcast', title: 'CCMS did not answer', body: 'Try again, or send the pole to the night audit.' });
    return undefined;
  }
}

// ---- 19.9 Events --------------------------------------------------------------------------------------
function bindServerEvents() {
  if (!SERVER) return;
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitStaffLogin();
  });
  for (const el of $$('[data-close-login]')) el.addEventListener('click', closeStaffLogin);
  $('#login-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeStaffLogin();
    }
  });
  $('#rm-contact-server').addEventListener('click', (e) => {
    const b = e.target.closest('[data-otp]');
    if (b?.dataset.otp === 'send') otpSend();
    else if (b?.dataset.otp === 'verify') otpVerify();
  });
  $('#rm-otp-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      otpVerify();
    }
  });
  $('#rm-otp-phone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      otpSend();
    }
  });
  renderSessionLine();
  syncContactMode();
}
