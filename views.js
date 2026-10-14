/* ==========================================================================
 * Street Light GIS · views.js
 * Section 12: selection, snapping, view helpers and the URL hash
 * Section 13: sidebar views (pole · feeder panel · dark spot · ticket · coverage gap · my reports)
 * ========================================================================== */
'use strict';

// ========================================================================
// 12. Selection, snapping, view helpers, URL hash
// ========================================================================
function updateSelectionRing() {
  if (!layers.selection) return;
  const sel = state.selected;
  let latlng = null;
  let radius = 12;
  if (sel?.type === 'pole') {
    const rec = state.byUid.get(sel.id);
    latlng = rec?.latlng;
    if (rec) radius = poleRadius(rec.feature.properties) + 6;
  } else if (sel?.type === 'panel' && state.analysis.feeder) {
    latlng = state.panels.get(sel.id)?.latlng;
    radius = 19;
  } else if (sel?.type === 'ticket') {
    const t = state.tickets.get(sel.id) ?? state.closed.get(sel.id);
    latlng = t ? ticketLatLng(t) : null;
    radius = 14;
  } else if (sel?.type === 'audit' && auditUid()) {
    const rec = state.byUid.get(auditUid());
    latlng = rec.latlng;
    radius = poleRadius(rec.feature.properties) + 6;
  }
  if (latlng) {
    layers.selectRing.setLatLng(latlng).setRadius(radius);
    if (!layers.selection.hasLayer(layers.selectRing)) layers.selection.addLayer(layers.selectRing);
  } else {
    layers.selection.removeLayer(layers.selectRing);
  }
}

/** Nearest visible pole to a map location, within `maxMeters`. */
function nearestPole(latlng, maxMeters = Infinity) {
  let best = null;
  let bestD = maxMeters;
  for (const rec of state.byUid.values()) {
    if (!state.filters.has(rec.feature.properties.status)) continue;
    const d = latlng.distanceTo(rec.latlng);
    if (d <= bestD) {
      best = rec;
      bestD = d;
    }
  }
  return best ? { rec: best, distance: bestD } : null;
}

/** Nearest visible pole to a screen point, within `tolerancePx` (forgiving click target). */
function poleNearPoint(containerPoint, tolerancePx) {
  let best = null;
  let bestD = tolerancePx;
  for (const rec of state.byUid.values()) {
    if (!layers.poles.hasLayer(rec.marker)) continue;
    const d = map.latLngToContainerPoint(rec.latlng).distanceTo(containerPoint);
    if (d <= bestD) {
      best = rec;
      bestD = d;
    }
  }
  return best;
}

function updateSnap(latlng) {
  const hit = nearestPole(latlng, SNAP_RADIUS_M);
  if (!hit) {
    clearSnap();
    return;
  }
  layers.snapRing.setLatLng(hit.rec.latlng).setRadius(poleRadius(hit.rec.feature.properties) + 8);
  layers.snapLine.setLatLngs([latlng, hit.rec.latlng]);
  if (!layers.selection.hasLayer(layers.snapRing)) layers.selection.addLayer(layers.snapRing).addLayer(layers.snapLine);
}
function clearSnap() {
  layers.selection.removeLayer(layers.snapRing).removeLayer(layers.snapLine);
}

const sidebarInset = () => (document.body.classList.contains('sidebar-open') && window.innerWidth >= 640 ? Math.min(TOKEN.sidebarW, window.innerWidth) : 0);

/** Map padding that keeps fitted content clear of the floating panels. */
function viewPadding() {
  const W = window.innerWidth;
  const right = sidebarInset() || (W >= 900 ? 336 : 0);
  let left = W >= 900 ? 392 : 16;
  if (W - left - right < 360) left = 16;
  return { paddingTopLeft: [left, W < 640 ? 150 : 40], paddingBottomRight: [right + 24, W < 640 ? 96 : 72] };
}

function fitTo(bounds, maxZoom = 18) {
  map.flyToBounds(bounds, { ...viewPadding(), maxZoom, duration: 0.7 });
}

function fitZone(animate = true) {
  const bounds = layers.zone.getLayers().length ? layers.zone.getBounds() : layers.poles.getBounds();
  if (animate) map.flyToBounds(bounds, { ...viewPadding(), duration: 0.8 });
  else map.fitBounds(bounds, { ...viewPadding(), animate: false });
}

/** Fly so the point lands in the middle of the part of the map the sidebar leaves visible. */
function flyToVisible(latlng, zoom = map.getZoom()) {
  const inset = sidebarInset();
  const target = inset ? map.unproject(map.project(latlng, zoom).add([inset / 2, 0]), zoom) : latlng;
  map.flyTo(target, zoom, { duration: 0.6 });
}

function panIntoView(latlng) {
  if (window.innerWidth < 640) return; // the sidebar covers the map on phones
  map.panInside(latlng, { paddingTopLeft: [60, 60], paddingBottomRight: [sidebarInset() + 60, 100] });
}

/**
 * URL hash: the selected pole or panel, then the view when it isn't the default.
 *   #SL-CP-OC-031 · #SL-CP-OC-031&view=field · #view=citizen · #report=SL-CP-OC-031 (QR label link)
 */
function parseHash() {
  const out = { id: null, view: null, report: null, ticket: null };
  for (const part of location.hash.slice(1).split('&').filter(Boolean)) {
    try {
      const eq = part.indexOf('=');
      const key = eq < 0 ? null : part.slice(0, eq);
      if (eq < 0) out.id = decodeURIComponent(part);
      else if (key in out && key !== 'id') out[key] = decodeURIComponent(part.slice(eq + 1));
    } catch { /* a malformed escape: ignore that part */ }
  }
  return out;
}

function writeHash() {
  const sel = state.selected;
  const parts = [];
  if (sel && (sel.type === 'pole' || sel.type === 'panel')) parts.push(encodeURIComponent(sel.id));
  if (sel?.type === 'status') parts.push(`ticket=${encodeURIComponent(sel.id)}`);
  if (state.role !== DEFAULT_ROLE) parts.push(`view=${encodeURIComponent(state.role)}`);
  try {
    history.replaceState(null, '', parts.length ? `#${parts.join('&')}` : location.pathname + location.search);
  } catch { /* replaceState can be blocked in sandboxed previews */ }
}

function openFromHash() {
  const h = parseHash();
  if (h.report) { // a pole's QR label: open the report form for that pole in the Citizen view
    setRole('citizen');
    const rec = state.byUid.get(h.report);
    if (rec) {
      selectPole(rec.uid, { zoom: true });
      beginReport(rec.latlng, rec.uid);
    }
    writeHash(); // drop report= so a reload doesn't reopen the form
    return;
  }
  if (h.ticket) { // a public status link: BASE_URL#ticket=<ID>
    setRole('citizen', { writeUrl: false });
    openStatus(h.ticket);
    return;
  }
  const view = ROLES.some((r) => r.id === h.view) ? h.view : DEFAULT_ROLE;
  if (view !== state.role) setRole(view, { writeUrl: false });
  if (h.id && state.byUid.has(h.id)) selectPole(h.id, { zoom: true });
  else if (h.id && state.panels.has(h.id) && roleAllows('feeder')) openPanel(h.id, { zoom: true });
}

// ========================================================================
// 13. Sidebar views
// ========================================================================
const sidebarEl = $('#sidebar');
const sidebarBody = $('#sidebar-content');
/** List views the sidebar can step back to (Back button, Esc). */
const LIST_VIEWS = {
  queue: () => 'Queue', workorder: () => 'Work order', audit: () => 'Night audit', myreports: () => tr('my_reports'),
  dashboard: () => 'Dashboard', spot: (id) => id, labels: () => 'Pole labels', event: () => 'Event check', monsoon: () => 'Due before monsoon',
};
const VIEWS = {}; // type -> render(id) returning HTML, or null when the thing no longer exists

function showSidebar(html, { keepScroll = false } = {}) {
  const scroll = sidebarBody.scrollTop;
  const open = [...sidebarBody.querySelectorAll('details[data-fold]')].filter((d) => d.open).map((d) => d.dataset.fold);
  sidebarBody.innerHTML = html;
  for (const key of keepScroll ? open : []) { // keep folded sections as the user left them
    const d = sidebarBody.querySelector(`details[data-fold="${CSS.escape(key)}"]`);
    if (d) d.open = true;
  }
  sidebarBody.scrollTop = keepScroll ? scroll : 0;
  sidebarEl.inert = false;
  sidebarEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sidebar-open');
}

function closeSidebar() {
  state.selected = null;
  state.back = null;
  document.body.classList.remove('sidebar-open');
  sidebarEl.setAttribute('aria-hidden', 'true');
  sidebarEl.inert = true;
  updateSelectionRing();
  styleNetwork();
  writeHash();
  syncViewLayers();
}

/** Re-render whatever is selected (after data changes). Closes the sidebar if it no longer exists. */
function renderSelected(opts = {}) {
  const sel = state.selected;
  if (!sel) return;
  const html = VIEWS[sel.type]?.(sel.id);
  if (html) showSidebar(html, opts);
  else closeSidebar();
  syncViewLayers();
}

/**
 * Show something in the sidebar. Opening a detail from inside a list view (queue, work order, ...)
 * remembers the list, so Back and Esc return to it.
 */
function navigate(sel, { fromSidebar = false } = {}) {
  const prev = state.selected;
  if (!fromSidebar) state.back = null;
  else if (prev && LIST_VIEWS[prev.type] && !(prev.type === sel.type && prev.id === sel.id)) state.back = prev;
  if (state.back && state.back.type === sel.type && state.back.id === sel.id) state.back = null;
  state.selected = sel;
  renderSelected();
  updateSelectionRing();
  styleNetwork();
  writeHash();
}

function goBack() {
  const back = state.back;
  if (!back) {
    closeSidebar();
    return;
  }
  state.back = null;
  state.selected = back;
  renderSelected();
  updateSelectionRing();
  styleNetwork();
  writeHash();
  $('#sb-title')?.focus();
}

function selectPole(uid, { zoom = false, focus = false, fromSidebar = false } = {}) {
  const rec = state.byUid.get(uid);
  if (!rec) return;
  if (!state.filters.has(rec.feature.properties.status)) {
    state.filters.add(rec.feature.properties.status); // make sure the selected pole is visible
    refreshPoles();
    renderLegend();
  }
  navigate({ type: 'pole', id: uid }, { fromSidebar });
  if (zoom) flyToVisible(rec.latlng, Math.max(map.getZoom(), 18));
  else panIntoView(rec.latlng);
  if (focus) $('#sb-title')?.focus();
}

function openPanel(id, { zoom = false, fromSidebar = false } = {}) {
  if (!state.panels.has(id) || !roleAllows('feeder')) return;
  if (!state.analysis.feeder) setAnalysis('feeder', true);
  if (state.trace !== id) setTrace(id);
  navigate({ type: 'panel', id }, { fromSidebar });
  if (zoom) fitPanel(id);
  else panIntoView(state.panels.get(id).latlng);
}

function openSpot(id, { fromSidebar = false } = {}) {
  const s = state.darkSpots.find((d) => d.id === id);
  if (!s) return;
  navigate({ type: 'spot', id }, { fromSidebar });
  fitTo(L.latLngBounds(s.line).pad(0.6), 18);
  const el = s.shape?.getElement();
  if (el) {
    el.classList.remove('is-active');
    void el.getBoundingClientRect(); // restart the highlight animation
    el.classList.add('is-active');
  }
}

function openTicket(id, { zoom = false, fromSidebar = false } = {}) {
  const t = state.tickets.get(id) ?? state.closed.get(id);
  if (!t) return;
  if (t.kind === 'pole' && t.pole_uids.length && state.tickets.has(id)) {
    selectPole(t.pole_uids[0], { zoom, fromSidebar });
    return;
  }
  navigate({ type: 'ticket', id }, { fromSidebar });
  const at = ticketLatLng(t);
  if (at && zoom) flyToVisible(at, Math.max(map.getZoom(), 18));
  else if (at) panIntoView(at);
}

function openGap(id, { fromSidebar = false } = {}) {
  const g = state.gaps.find((x) => x.id === id);
  if (!g) return;
  navigate({ type: 'gap', id }, { fromSidebar });
  fitTo(L.latLngBounds([state.byUid.get(g.a).latlng, state.byUid.get(g.b).latlng]).pad(1.2), 18);
}

function openMyReports() {
  navigate({ type: 'myreports', id: 'me' });
}

// ---- shared pieces -------------------------------------------------------------
const closeButtonHtml = () => `<button type="button" class="icon-btn" data-action="close" aria-label="${esc(isCitizen() ? tr('close') : 'Close')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;

function viewHead({ eyebrow, title, sub = '', extra = '' }) {
  const back = state.back
    ? `<button type="button" class="back-btn" data-action="back"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>${esc(LIST_VIEWS[state.back.type](state.back.id))}</button>`
    : '';
  return `<div class="sb-head">${back}
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h2 id="sb-title" class="sb-title" tabindex="-1">${esc(title)}</h2>
        ${sub ? `<p class="sb-sub">${sub}</p>` : ''}
      </div>
      ${closeButtonHtml()}
    </div>${extra}</div>`;
}

const actionButton = (action, icon, label, attrs = '', primary = false) => `<button type="button" class="btn ${primary ? 'btn-primary' : 'btn-ghost'}" data-action="${action}" ${attrs}><i class="fa-solid ${icon}" aria-hidden="true"></i>${esc(label)}</button>`;
const actionsRow = (buttons) => {
  const list = buttons.filter(Boolean);
  return list.length ? `<div class="sb-actions" style="grid-template-columns:repeat(${list.length}, minmax(0, 1fr))">${list.join('')}</div>` : '';
};
const quietCard = (icon, html, tone = 'ok') => `<div class="card card--quiet"><i class="fa-solid ${icon} tone-${tone}" aria-hidden="true"></i><span>${html}</span></div>`;
const poleLink = (uid, label = uid.replace('SL-CP-', '')) => `<button type="button" class="link mono" data-action="select-pole" data-uid="${esc(uid)}">${esc(label)}</button>`;
const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

// ---- pole view ------------------------------------------------------------------
VIEWS.pole = function renderPoleView(uid) {
  const rec = state.byUid.get(uid);
  if (!rec) return null;
  const p = rec.feature.properties;
  if (isCitizen()) return citizenPoleView(p);
  const role = state.role;
  const traced = state.trace === p.feeder_panel;
  const crit = poleCriticality(uid);
  const hold = shutdownOf(p);
  const ratio = energyRatio(p);
  const chips = [
    statusPill(p.status),
    `<span class="chip"><i class="fa-solid fa-bolt" aria-hidden="true"></i>${esc(p.feeder_panel)} · ${esc(p.circuit)} · #${esc(p.circuit_seq)}</span>`,
    crit.level ? `<span class="chip" title="Criticality from nearby landmarks (approximate positions)"><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${esc(crit.level)} · ${esc(lowerFirst(crit.reason))}</span>` : '',
    hold ? `<span class="chip"><i class="fa-solid fa-power-off" aria-hidden="true"></i>Shutdown until ${esc(fmtTime(hold.end))}</span>` : '',
    role !== 'field' && isAnomaly(p) ? `<span class="chip chip--warn"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>Energy ${nf1.format(ratio)}× expected</span>` : '',
  ].join('');
  const actions = actionsRow([
    actionButton('zoom-pole', 'fa-location-crosshairs', 'Zoom to', `data-uid="${esc(uid)}"`),
    roleAllows('feeder') ? actionButton('trace', 'fa-diagram-project', traced ? 'Untrace' : 'Trace feeder', `data-panel="${esc(p.feeder_panel)}" aria-pressed="${traced}"`, traced) : '',
    role === 'operator' ? actionButton('report-pole', 'fa-bullhorn', 'Report', `data-uid="${esc(uid)}"`) : '',
  ]);
  const split = [...state.tickets.values()].filter((t) => t.near_uid === uid && t !== p.ticket);
  return `${viewHead({
    eyebrow: `Streetlight · ${p.road}`, title: p.uid, sub: esc(p.location),
    extra: `<div class="flex flex-wrap items-center gap-2 mt-3">${chips}</div>${actions}`,
  })}
    <div class="sb-body">
      ${p.ticket ? ticketCard(p.ticket, { selfUid: uid }) : quietCard('fa-circle-check', `No open ticket · inspected ${esc(fmtDate(p.last_inspected))}`)}
      ${split.map((t) => quietCard('fa-code-branch', `Also open here: <button type="button" class="link mono" data-action="open-ticket" data-ticket="${esc(t.id)}">${esc(t.id)}</button> · ${esc(t.issue)}`, 'info')).join('')}
      ${fixtureSection(p, rec)}
      ${safetySection(p)}
      ${section('Electrical', 'fa-plug', kv([
        ['Feeder panel', `<button type="button" class="link mono" data-action="open-panel" data-panel="${esc(p.feeder_panel)}">${esc(p.feeder_panel)}</button> <span class="text-ink-3">· ${esc(panelProps(p.feeder_panel)?.name ?? '')}</span>`],
        ['Circuit', `${esc(p.circuit)} · pole ${esc(p.circuit_seq)} of ${circuitLength(p.feeder_panel, p.circuit)}`],
        ['Phase', esc(p.phase)],
        ['Connected load', `${nf0.format(p.wattage * (p.arm_count ?? 1))} W`],
      ]))}
      ${role !== 'field' ? energySection(p) : ''}
      ${role !== 'field' ? contractorSection(p.contractor) : ''}
      ${historySection(p)}
      ${activitySection({ uid })}
    </div>`;
};

function citizenPoleView(p) {
  const hold = shutdownOf(p);
  const note = hold ? quietCard('fa-power-off', esc(tr('pole_shutdown', { time: fmtTime(hold.end) })), 'info')
    : p.ticket ? quietCard('fa-screwdriver-wrench', esc(tr('pole_reported')), 'warn')
      : quietCard('fa-circle-check', esc(tr('pole_ok')));
  return `${viewHead({ eyebrow: tr('pole_eyebrow'), title: p.uid, sub: esc(p.location), extra: `<div class="mt-3">${statusPill(p.status)}</div>` })}
    <div class="sb-body">
      ${note}
      <button type="button" class="btn btn-primary btn-block mt-4" data-action="report-pole" data-uid="${esc(p.uid)}"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i>${esc(tr('report_cta'))}</button>
    </div>`;
}

function fixtureSection(p, rec) {
  const coords = fmtLatLngPlain(rec.latlng);
  const warrantyUntil = warrantyEnd(p);
  return section('Pole & fixture', 'fa-lightbulb', kv([
    ['Pole', `${esc(p.pole_type)} · ${esc(p.pole_height_m)} m`],
    ['Fixture', `${esc(FIXTURE_NAMES[p.fixture_type] ?? p.fixture_type)} · ${esc(p.wattage)} W${p.arm_count > 1 ? ` × ${esc(p.arm_count)} arms` : ''} · ${esc(p.cct_k)} K`],
    ['Make, batch', `${esc(p.fixture_make)} · <span class="mono text-[12.5px]">${esc(p.fixture_batch)}</span>`],
    ['Warranty', warrantyUntil ? `${esc(p.fixture_warranty_years)} years (example) · ${underWarranty(p) ? `until ${esc(fmtDate(warrantyUntil))}` : `ended ${esc(fmtDate(warrantyUntil))}`}` : '–'],
    ['Monitoring', p.ccms_node ? 'CCMS node (remote fault alerts)' : 'None; faults found by night patrol'],
    ['Pole erected', esc(fmtDate(p.install_date))],
    ['Luminaire fitted', esc(fmtDate(p.fixture_installed))],
    ['GIS location', `<span class="mono text-[12.5px]">${coords}</span>
      <button type="button" class="link text-xs ml-1" data-action="copy" data-copy="${coords}">copy</button>
      <span class="block text-[11px] text-ink-3">latitude, longitude · WGS 84</span>`],
  ]));
}

function safetySection(p) {
  return section('Inspection & safety', 'fa-shield-halved', kv([
    ['Last inspected', esc(fmtDate(p.last_inspected))],
    ['Earthing check', esc(fmtDate(p.last_earthing_check))],
    ['Junction box', esc(p.junction_box_condition)],
  ]));
}

// ---- ticket card (pole view and ticket view) ---------------------------------------
const RESOLUTIONS = [ // work-done options offered when a crew closes a job (first pattern matching the issue wins)
  [/panel|breaker|phase/i, ['Replaced phase fuse, re-tightened panel terminations', 'Replaced MCB in feeder panel']],
  [/cable fault|no supply|cable/i, ['Located fault, jointed underground cable', 'Replaced stolen cable, secured junction box']],
  [/driver|flicker|cycling/i, ['Replaced LED driver', 'Replaced driver and module connector']],
  [/surge/i, ['Replaced surge protection device']],
  [/water/i, ['Resealed luminaire, replaced gasket', 'Replaced luminaire']],
  [/stolen|theft/i, ['Replaced stolen cable, secured junction box']],
  [/junction|connection|wires|open box/i, ['Re-terminated cables, replaced connector', 'Insulated and boxed exposed wiring']],
  [/ignitor/i, ['Replaced ignitor']],
  [/ballast/i, ['Replaced ballast']],
  [/burnt|not glowing|not working|lights out/i, ['Replaced lamp', 'Replaced LED driver']],
  [/pole|damaged|leaning/i, ['Replaced pole, re-grouted foundation', 'Straightened and re-grouted pole']],
  [/day|timer|photocell/i, ['Replaced timer contactor', 'Replaced photocell']],
  [/tree|canopy|blocked|hoarding/i, ['Pruned canopy, re-aimed luminaire', 'Hoarding removed']],
  [/shock|sparking/i, ['Insulated and boxed exposed wiring', 'Repaired earthing, replaced damaged cable']],
];

function ticketCard(t, { selfUid = null } = {}) {
  const color = isEmergency(t) ? TOKEN.bad : STATUS[props(selfUid)?.status]?.color ?? TOKEN.accent;
  const others = t.pole_uids.filter((u) => u !== selfUid);
  const [icon, label] = { 'In Progress': ['fa-person-digging', 'In progress'], 'Awaiting dusk check': ['fa-moon', 'Awaiting dusk check'] }[t.status] ?? ['fa-circle-dot', 'Open · not dispatched'];
  const spares = sparesLine(t);
  return `
    <section class="card card--ticket${isEmergency(t) ? ' card--emergency' : ''}" style="--c:${color}" aria-label="Ticket ${esc(t.id)}">
      <div class="flex items-center justify-between gap-2">
        <span class="eyebrow">${isEmergency(t) ? '<i class="fa-solid fa-triangle-exclamation tone-bad" aria-hidden="true"></i> Safety emergency' : 'Active ticket'}</span>
        <span class="flex items-center gap-2">${publicChip(t)}<span class="ticket-status"><i class="fa-solid ${icon}" aria-hidden="true"></i>${label}</span></span>
      </div>
      <div class="flex items-baseline justify-between gap-2 mt-1.5">
        <span class="mono text-[15px] font-semibold">${esc(t.id)}</span>
        <span class="priority priority--${esc(t.priority.toLowerCase())}">${esc(t.priority)} priority</span>
      </div>
      <p class="why"><span class="text-ink-3">Based on:</span> ${esc(t.why)}</p>
      ${confidenceHtml(t)}
      <p class="text-[14px] mt-1.5">${esc(t.issue)}</p>
      ${ticketWarranty(t) ? '<p class="mt-1.5"><span class="badge"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i>Under warranty: claim the fixture from the supplier</span></p>' : ''}
      ${others.length ? `<p class="text-xs text-ink-2 mt-1.5">Same ticket covers ${others.map((u) => poleLink(u)).join(', ')}</p>` : ''}
      <div class="mt-3">${kv([
        ['Raised', `${esc(fmtDateTime(t.raised_at))} <span class="text-ink-3">(${esc(fmtAgo(t.raised_at))}) · ${esc(t.source)}</span>${t.first_raised_at ? `<span class="block text-[11.5px] text-ink-3">Reopened · first raised ${esc(fmtDateTime(t.first_raised_at))}</span>` : ''}`],
        ['Assigned to', esc(assigneeOf(t))],
        ['Service level', slaHtml(t)],
        ['Escalation', escalationHtml(t)],
        ['Crew', t.assigned_crew ? `${esc(t.assigned_crew)}${t.work_started_at ? ` <span class="text-ink-3">· since ${esc(fmtDateTime(t.work_started_at))}</span>` : ''}` : '<span class="text-ink-3">Not dispatched</span>'],
        t.complaints ? ['Reports', reportsHtml(t)] : null,
      ])}</div>
      ${spares ? `<p class="spares"><i class="fa-solid fa-toolbox" aria-hidden="true"></i>${esc(spares)}</p>` : ''}
      ${t.category === 'day_burning' ? '<p class="text-xs mt-2"><button type="button" class="link" data-action="energy-pole" data-uid="' + esc(t.pole_uids[0] ?? '') + '">Show the day-burning analysis</button></p>' : ''}
      ${t.notes ? `<p class="note">${esc(t.notes)}</p>` : ''}
      ${t.status === 'Awaiting dusk check' ? duskCheckHtml(t) : ''}
      ${workflowControls(t)}
    </section>`;
}

function slaHtml(t) {
  const why = `<span class="block text-[11.5px] text-ink-3">${esc(t.sla_hours)} h: ${esc(t.sla_why)}</span>`;
  if (t.status === 'Awaiting dusk check') {
    const met = hoursBetween(t.raised_at, t.closed_at) <= t.sla_hours;
    return `<span class="${met ? 'sla-ok' : 'sla-breached'}"><i class="fa-solid ${met ? 'fa-check' : 'fa-circle-exclamation'}" aria-hidden="true"></i> Work done ${esc(fmtDateTime(t.closed_at))} · ${met ? 'within' : 'outside'} SLA</span>${why}`;
  }
  const leftH = hoursBetween(now(), t.sla_due);
  return (leftH < 0
    ? `<span class="sla-breached"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> Breached ${esc(fmtHours(-leftH))} ago</span>`
    : `<span class="sla-ok"><i class="fa-regular fa-clock" aria-hidden="true"></i> Due in ${esc(fmtHours(leftH))}</span> <span class="text-ink-3">· ${esc(fmtDateTime(t.sla_due))}</span>`) + why;
}

function escalationHtml(t) {
  const e = t.escalation ?? ESCALATION[0];
  return t.escalationIndex > 0
    ? `<span class="escalated"><i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i> ${esc(e.level)} · ${esc(e.title)}</span>`
    : `${esc(e.level)} · ${esc(e.title)}`;
}

function reportsHtml(t) {
  const list = t.reports.map(reportById).filter(Boolean);
  const canSplit = state.role === 'operator' && t.complaints >= 2;
  return `${esc(t.complaints)}${list.length ? `<ul class="report-list">${list.map((r) => `<li>
    <span class="mono">${esc(r.id)}</span> · ${esc(r.source)} · ${esc(fmtDateTime(r.created_at))}${r.category !== t.category ? ` · ${esc(catLabel(r.category, false))}` : ''}
    ${r.photo ? (r.photo.url ? ` · <a class="link" href="${esc(r.photo.url)}" target="_blank" rel="noopener">photo</a>` : ' · photo') : ''}${r.device ? ' · location' : ''}
    ${canSplit ? `<button type="button" class="link" data-action="split" data-report="${esc(r.id)}">Split out</button>` : ''}</li>`).join('')}</ul>` : ''}`;
}

const publicChip = (t) => (t.public && !isCitizen()
  ? `<span class="chip chip--quiet" title="Shared publicly by the reporter, ${esc(fmtDateTime(t.public.shared_at))}"><i class="fa-brands fa-x-twitter" aria-hidden="true"></i>Public</span>` : '');

/** Report confidence (operators): a quiet band label, with the reasons folded away (✓ supports, – neutral, ✗ contradicts). */
function confidenceHtml(t) {
  const c = t.confidence;
  if (!c || c.bypass || isCitizen()) return '';
  const mark = { 1: ['✓', 'pos', 'supports'], 0: ['–', 'neu', 'neutral'], [-1]: ['✗', 'neg', 'contradicts'] };
  const line = (effect, text) => `<li class="sig sig--${mark[effect][1]}"><span aria-hidden="true">${mark[effect][0]}</span><span class="sr-only">${mark[effect][2]}:</span>${esc(text)}</li>`;
  const label = c.final ?? c.band;
  return `<details class="evidence" data-fold="evidence-${esc(t.id)}">
    <summary><span class="band band--${esc((c.band ?? 'final').toLowerCase().replace(/\s+/g, '-'))}">${esc(label)}</span><span class="evidence-why">Why</span><i class="fa-solid fa-chevron-down fold-chevron" aria-hidden="true"></i></summary>
    <ul class="signals">${signalLines(c.signals).map((s) => line(s.effect, s.text)).join('')}${c.notes.map((n) => line(-1, n)).join('')}</ul>
    ${c.count > 1 && c.basis ? `<p class="text-[11px] text-ink-3 mt-1">Best supported of ${c.count} reports: ${esc(c.basis)}</p>` : ''}
  </details>`;
}

/** Evidence the report simply lacks (no photo, no location, …) folds into one neutral line at the end. */
function signalLines(signals) {
  const absent = signals.filter((s) => s.absent);
  if (absent.length < 2) return signals;
  const names = absent.map((s) => s.absent);
  const list = `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return [...signals.filter((s) => !s.absent), { effect: 0, text: `No ${list}` }];
}

/** Dusk check (D3): CCMS confirms by itself after dark; other poles need a night photo from the crew. */
function duskCheckHtml(t) {
  const c = duskCheckFor(t);
  let body;
  if (c.ccms) {
    body = now() < c.confirmAt
      ? `Verify after ${esc(fmtTime(c.confirmAt))}: the CCMS node reports the lamp on after dark.`
      : 'Waiting for the CCMS node to report the lamp on.';
  } else if (t.dusk_photo) {
    body = `<span class="flex items-center gap-3 mt-1"><img class="photo-preview" src="${esc(t.dusk_photo.url)}" alt="Night photo of the repaired lamp">
      <span>Night photo · taken ${esc(fmtDateTime(t.dusk_photo.at))}</span></span>
      ${state.role === 'field' ? `<button type="button" class="btn btn-primary btn-block mt-2" data-action="confirm-dusk" data-ticket="${esc(t.id)}"><i class="fa-solid fa-check" aria-hidden="true"></i>Confirm lamp is lit</button>` : ''}`;
  } else if (!c.photoNow) {
    body = `Verify after ${esc(fmtTime(c.photoFrom))}: night photo of the lit lamp.`;
  } else {
    body = state.role === 'field'
      ? `<label class="btn btn-primary btn-block mt-1 cursor-pointer"><i class="fa-solid fa-camera" aria-hidden="true"></i>Add night photo
          <input type="file" accept="image/*" capture="environment" class="sr-only" data-change="dusk-photo" data-ticket="${esc(t.id)}"></label>
        <p class="privacy">Photo is used only to check this repair.</p>`
      : 'Night photo of the lit lamp needed from the field crew.';
  }
  return `<div class="dusk"><p class="workflow-label"><i class="fa-solid fa-moon" aria-hidden="true"></i>Dusk check</p><div class="text-[12.5px] text-ink-2">${body}</div></div>`;
}

const DEMO_LABEL = '<p class="workflow-label"><i class="fa-solid fa-user-gear" aria-hidden="true"></i>Demo workflow</p>';
const isCrewCheck = (t, crew) => t.status === 'Open' && t.check?.kind === 'crew' && t.check.crew === crew;
const resolutionSelect = (t) => `<select class="input flex-1" data-field="resolution" aria-label="Work carried out">${[...(RESOLUTIONS.find(([re]) => re.test(t.issue ?? ''))?.[1] ?? []), 'Repaired on site (other)']
  .map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
const dispatchRow = (t) => `<div class="flex gap-2">
  <select class="input flex-1" data-field="crew" aria-label="Crew to dispatch">${crewsFor(t).map((c) => `<option>${esc(c)}</option>`).join('')}</select>
  <button type="button" class="btn btn-primary" data-action="dispatch" data-ticket="${esc(t.id)}"><i class="fa-solid fa-truck-fast" aria-hidden="true"></i>Dispatch</button></div>`;

function workflowControls(t) {
  const role = state.role;
  if (role === 'operator' && t.status === 'Open') return needsCheck(t) ? checkHtml(t) : `<div class="workflow">${DEMO_LABEL}${dispatchRow(t)}</div>`;
  if (role === 'field' && (t.status === 'In Progress' || isCrewCheck(t, currentCrew()))) return outcomeHtml(t);
  if (role === 'operator' && t.status === 'In Progress') {
    return `<div class="workflow">${DEMO_LABEL}<div class="flex gap-2">${resolutionSelect(t)}
      <button type="button" class="btn btn-primary" data-action="resolve" data-ticket="${esc(t.id)}"><i class="fa-solid fa-check" aria-hidden="true"></i>Close ticket</button></div></div>`;
  }
  return '';
}

/** Needs check (operators): the cheapest checks first; a dedicated dispatch only when none of them can happen in time. */
function checkHtml(t) {
  const plan = checkPlan(t);
  const steps = plan.steps.map((s, i) => `<li class="${s.done ? 'is-done' : s === plan.next ? 'is-next' : !s.available ? 'is-na' : ''}">
    <span class="step-n" aria-hidden="true">${s.done ? '<i class="fa-solid fa-check"></i>' : i + 1}</span>
    <span>${esc(s.label)}${s.result ? `: ${esc(s.result)}` : ''}${!s.available && !s.done ? ' <span class="text-ink-3">(not possible here)</span>' : ''}</span></li>`).join('');
  return `<div class="workflow"><p class="workflow-label"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>Cheapest check first</p>
    <ol class="check-steps">${steps}</ol>
    ${plan.next ? `<button type="button" class="btn btn-primary btn-block mt-2" data-action="check-${plan.next.key}" data-ticket="${esc(t.id)}">${esc(plan.next.label)}</button>` : ''}
    ${plan.waiting ? `<p class="text-[12px] text-ink-2 mt-2"><i class="fa-regular fa-clock" aria-hidden="true"></i> ${esc(plan.waiting)}</p>` : ''}
    ${plan.dispatch ? `<p class="text-[12px] text-ink-3 mt-2">No cheaper check within ${NEEDS_CHECK_MAX_HOURS} h.</p>${dispatchRow(t)}` : ''}
  </div>`;
}

/** Field crew on site: what they found. Each outcome feeds the reporters' track records. */
function outcomeHtml(t) {
  const visit = t.status === 'Open'; // a check visit: not their job yet
  const lamp = !t.circuit && ['not_working', 'flickering', 'other'].includes(t.category);
  const single = t.pole_uids.length === 1;
  const options = [['confirmed', 'Fault confirmed'], ['no_fault', 'Working, no fault'], lamp && ['obstruction', 'Obstruction'], single && ['different_pole', 'Different pole']].filter(Boolean);
  const panel = (key, html, open = false) => `<div class="mt-2" data-outcome-panel="${key}"${open ? '' : ' hidden'}>${html}</div>`;
  const button = (action, label) => `<button type="button" class="btn btn-primary btn-block" data-action="${action}" data-ticket="${esc(t.id)}">${esc(label)}</button>`;
  return `<div class="workflow" data-outcome-host>
    <p class="workflow-label"><i class="fa-solid fa-clipboard-check" aria-hidden="true"></i>What did you find?</p>
    <div class="outcome-options" role="radiogroup" aria-label="What did you find?">${options.map(([key, label], i) => `<button type="button" class="chip-toggle" role="radio" data-outcome="${key}" aria-checked="${i === 0}">${esc(label)}</button>`).join('')}</div>
    ${panel('confirmed', visit ? button('take-check', 'Take the job')
      : `<div class="flex gap-2">${resolutionSelect(t)}<button type="button" class="btn btn-primary" data-action="resolve" data-ticket="${esc(t.id)}"><i class="fa-solid fa-check" aria-hidden="true"></i>Close ticket</button></div>`, true)}
    ${panel('no_fault', button('no-fault', 'Close: working, no fault'))}
    ${lamp ? panel('obstruction', button('obstruction', 'Send to horticulture / enforcement')) : ''}
    ${single ? panel('different_pole', button('pick-pole', 'Pick the right pole on the map')) : ''}
  </div>`;
}

// ---- energy, contractor, history, activity -------------------------------------------
function energySection(p) {
  const expected = expectedKwh(p);
  const ratio = energyRatio(p);
  const saving = retrofitSavingKwh(p);
  const delta = ratio == null ? null : Math.round((ratio - 1) * 100);
  return section('Energy', 'fa-bolt', `
    <div class="flex items-end justify-between gap-3">
      <div>
        <div class="big-number">${nf1.format(p.energy_kwh)}<span class="unit">kWh</span></div>
        <div class="text-xs text-ink-3 mt-1">${esc(fmtMonth(p.energy_month))} · ≈ ${esc(inr(p.energy_kwh * TARIFF))} at ₹${esc(TARIFF)}/kWh</div>
      </div>
      ${expected ? `<div class="text-right text-xs text-ink-3">Baseline (${nf0.format(nightHoursInMonth(p.energy_month))} h of darkness)<br>
        <span class="text-ink-1 font-medium">${nf1.format(expected)} kWh</span> (${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%)</div>` : ''}
    </div>
    ${sparkline(p)}
    ${isAnomaly(p) ? `<div class="callout callout--warn"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><div>
      <strong>Consumption anomaly:</strong> ${nf1.format(ratio)}× the sunset-to-sunrise baseline. Most likely <strong>day burning</strong>
      (stuck timer or photocell). The lamp still lights, so nobody reports it.
      ${p.ticket || state.role !== 'operator' ? '' : ` <button type="button" class="link" data-action="report-pole" data-uid="${esc(p.uid)}" data-category="day_burning">Raise a ticket</button>`}</div></div>` : ''}
    ${saving > 0 ? `<div class="callout"><i class="fa-solid fa-leaf" aria-hidden="true"></i><div>
      Legacy ${esc((FIXTURE_NAMES[p.fixture_type] ?? p.fixture_type).toLowerCase())} fixture. An LED ${ledEquivalentW(p)} W retrofit would save
      <strong>≈ ${nf0.format(saving)} kWh/month</strong> (≈ ${esc(inr(saving * TARIFF))}).</div></div>` : ''}`);
}

/** 6-month bar sparkline: bars ≤ 24 px, 4 px rounded tops, hover/focus tooltip, table twin. */
function sparkline(p) {
  const series = p.energy_history ?? [];
  if (series.length < 2) return '';
  const W = 300;
  const H = 76;
  const top = 16;
  const bottom = 16;
  const gap = 12;
  const n = series.length;
  const bw = Math.min(24, (W - gap * (n - 1)) / n);
  const x0 = (W - (n * bw + (n - 1) * gap)) / 2;
  const max = Math.max(...series.map((d) => d.kwh), 1);
  const plotH = H - top - bottom;
  const bars = series.map((d, i) => {
    const h = Math.max(1.5, (d.kwh / max) * plotH);
    const x = x0 + i * (bw + gap);
    const y = H - bottom - h;
    const label = `${fmtMonth(d.month)}: ${nf1.format(d.kwh)} kWh`;
    const last = i === n - 1;
    return `<g class="spark-bar${last ? ' is-current' : ''}" tabindex="0" role="img" aria-label="${esc(label)}" data-tip="${esc(label)}">
      <rect x="${x - gap / 2}" y="0" width="${bw + gap}" height="${H}" fill="transparent"></rect>
      <path d="${roundedTopBar(x, y, bw, h, 4)}"></path>
      <text class="spark-axis" x="${x + bw / 2}" y="${H - 3}" text-anchor="middle">${esc(fmtMonthShort(d.month))}</text>
      ${last ? `<text class="spark-value" x="${x + bw / 2}" y="${y - 5}" text-anchor="middle">${nf1.format(d.kwh)}</text>` : ''}
    </g>`;
  }).join('');
  return `<div class="spark" data-spark>
    <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Monthly energy use, last ${n} months">
      <line class="spark-baseline" x1="${x0 - 6}" x2="${W - x0 + 6}" y1="${H - bottom + 0.5}" y2="${H - bottom + 0.5}"></line>${bars}
    </svg>
    <div class="spark-tip" hidden></div>
    <details class="table-view"><summary>View as table</summary>
      <table class="mini-table"><thead><tr><th scope="col">Month</th><th scope="col">kWh</th></tr></thead><tbody>
        ${series.map((d) => `<tr><td>${esc(fmtMonth(d.month))}</td><td>${nf1.format(d.kwh)}</td></tr>`).join('')}
      </tbody></table>
    </details>
  </div>`;
}
function roundedTopBar(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function contractorSection(ctr) {
  if (!ctr) return '';
  return section('Maintenance contractor', 'fa-helmet-safety', `
    <p class="text-[14px] font-medium">${esc(ctr.name)}</p>
    <div class="mt-2">${kv([
      ['Contact', `${esc(ctr.contact_person)} · <span class="mono text-[12.5px]">${esc(ctr.phone)}</span>`],
      ['Email', `<a class="link" href="mailto:${esc(ctr.email)}">${esc(ctr.email)}</a>`],
      ['Contract', `<span class="mono text-[12.5px]">${esc(ctr.contract_ref)}</span>`],
      ['Restore within', `${esc(ctr.sla_hours)} h (standard faults)`],
    ])}</div>`);
}

function historySection(p) {
  const items = [];
  if (p.ticket) {
    const s = STATUS[p.status] ?? STATUS.Faulty;
    items.push(`<li class="tl-item">
      <span class="tl-node tl-node--now" style="--c:${s.color}"><i class="fa-solid ${s.icon}" aria-hidden="true"></i></span>
      <div class="flex items-baseline justify-between gap-2"><span class="tl-title">${esc(p.ticket.issue)}</span><time class="tl-date" datetime="${esc(p.ticket.raised_at)}">${esc(fmtDate(p.ticket.raised_at))}</time></div>
      <p class="tl-action">${{ 'In Progress': 'Work in progress', 'Awaiting dusk check': 'Repaired, awaiting dusk check' }[p.ticket.status] ?? 'Open, awaiting crew'}</p>
      <p class="tl-meta mono">${esc(p.ticket.id)}</p></li>`);
  }
  for (const h of p.repair_history) items.push(historyItem(h));
  return section(`Repair history · ${p.repair_history.length}`, 'fa-clock-rotate-left',
    items.length ? `<ol class="timeline">${items.join('')}</ol>` : '<p class="empty">No repairs recorded.</p>');
}

function historyItem(h) {
  const icon = { Retrofit: 'fa-bolt', Preventive: 'fa-broom', Corrective: 'fa-wrench', Check: 'fa-magnifying-glass' }[h.type] ?? 'fa-wrench';
  const sla = h.type !== 'Corrective' ? ''
    : h.sla_met ? '<span class="ok"><i class="fa-solid fa-check" aria-hidden="true"></i> SLA met</span>'
      : '<span class="miss"><i class="fa-solid fa-xmark" aria-hidden="true"></i> SLA missed</span>';
  const meta = [
    `<span class="mono">${esc(h.ticket_id)}</span>`,
    esc(h.crew),
    h.downtime_h != null ? `${esc(fmtHours(h.downtime_h))} down` : '',
    sla,
    h.cost_inr ? esc(inr(h.cost_inr)) : '',
    h.verified_by ? `verified by ${esc(h.verified_by === 'CCMS' ? 'CCMS' : 'night photo')}` : '',
    h.outcome === 'different_pole' ? `reported on ${esc(h.reported_uid.replace('SL-CP-', ''))}, fault found here` : '',
    h.outcome === 'no_fault' ? 'not confirmed on site' : '',
    h.reopened_at ? `<span class="miss">reopened ${esc(fmtDay(h.reopened_at))}</span>` : '',
  ].filter(Boolean).join(' · ');
  return `<li class="tl-item">
    <span class="tl-node${h.type === 'Retrofit' ? ' tl-node--retrofit' : ''}"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
    <div class="flex items-baseline justify-between gap-2"><span class="tl-title">${esc(h.issue)}</span><time class="tl-date" datetime="${esc(h.resolved_at)}">${esc(fmtDate(h.resolved_at))}</time></div>
    <p class="tl-action">${esc(h.action)}</p>
    <p class="tl-meta">${meta}</p></li>`;
}

/** Activity (E6): every state change in this session for a pole or a ticket, newest first; starts folded. */
function activitySection({ uid = null, ticketId = null }) {
  const ids = new Set([ticketId, ...(uid ? [props(uid)?.ticket?.id] : [])].filter(Boolean));
  const rows = state.activity
    .filter((a) => (uid && a.uids.includes(uid)) || (a.ticket && ids.has(a.ticket)))
    .sort((a, b) => b.at.localeCompare(a.at));
  const body = rows.length
    ? `<ol class="activity">${rows.map((a) => `<li><time datetime="${esc(a.at)}">${esc(fmtDateTime(a.at))}</time>
        <span><span class="text-ink-1">${esc(a.action)}</span>${a.from != null || a.to != null ? ` <span class="text-ink-3">${esc(a.from ?? '–')} → ${esc(a.to ?? '–')}</span>` : ''}
        <span class="block text-ink-3">${esc(a.role)}${a.ticket ? ` · <span class="mono">${esc(a.ticket)}</span>` : ''}</span></span></li>`).join('')}</ol>`
    : '<p class="empty">No changes in this session.</p>';
  return `<details class="sb-section sb-fold" data-fold="activity"><summary class="sb-h"><i class="fa-solid fa-list-check" aria-hidden="true"></i>Activity · ${rows.length}<i class="fa-solid fa-chevron-down fold-chevron" aria-hidden="true"></i></summary>${body}</details>`;
}

// ---- feeder panel view ---------------------------------------------------------------
VIEWS.panel = function renderPanelView(id) {
  const panel = state.panels.get(id);
  if (!panel || !roleAllows('feeder')) return null;
  const pp = panel.feature.properties;
  const list = polesOfPanel(id);
  const s = statsOf(list);
  const load = panelLoad(id);
  const traced = state.trace === id;
  const circuits = [...(panelPoles.get(id) ?? new Map())];
  return `${viewHead({
    eyebrow: `Feeder panel · ${pp.road}`, title: id, sub: `${esc(pp.name)} · ${esc(pp.location)}`,
    extra: `${load.warn ? `<div class="mt-3"><span class="chip chip--warn"><i class="fa-solid fa-gauge-high" aria-hidden="true"></i>Load ${esc(pct(Math.max(load.share, load.peakShare)))} of capacity</span></div>` : ''}
      ${actionsRow([
        actionButton('zoom-panel', 'fa-location-crosshairs', 'Zoom to feeder', `data-panel="${esc(id)}"`),
        actionButton('trace', 'fa-diagram-project', traced ? 'Stop tracing' : 'Trace on map', `data-panel="${esc(id)}" aria-pressed="${traced}"`, traced),
      ])}`,
  })}
    <div class="sb-body">
      <div class="grid grid-cols-3 gap-2 mt-4">
        <div class="stat"><span class="stat-label">Poles</span><span class="stat-value">${s.total}</span><span class="stat-sub">${plural(circuits.length, 'circuit')}</span></div>
        <div class="stat"><span class="stat-label">Dark now</span><span class="stat-value">${s.Faulty}</span><span class="stat-sub">${s['Under Maintenance']} in repair</span></div>
        <div class="stat"><span class="stat-label">Load now</span><span class="stat-value">${nf1.format(load.nowKw)}</span><span class="stat-sub">kW of ${nf1.format(load.capacityKw)} kW</span></div>
      </div>
      <div class="mt-3">${meterHtml(s)}</div>
      ${shutdownSection(id)}
      ${section('Circuits · wiring order', 'fa-diagram-project', circuits.map(([circuit, uids]) => circuitDiagram(id, circuit, uids)).join(''))}
      ${loadSection(id, load)}
      ${section('Panel', 'fa-plug', kv([
        ['Supply', esc(pp.source_dt)],
        ['Capacity', `${esc(pp.capacity_kva)} kVA · ${nf1.format(load.capacityKw)} kW usable at power factor ${PANEL_POWER_FACTOR}`],
        ['Control', esc(pp.controller)],
        ['Commissioned', esc(fmtDate(pp.commissioned))],
        ['Energy', `${nf0.format(s.kwh)} kWh in ${esc(fmtMonth(META.energy_month))} · ≈ ${esc(inr(s.kwh * TARIFF))}`],
        ['GIS location', `<span class="mono text-[12.5px]">${fmtLatLngPlain(panel.latlng)}</span>`],
      ]))}
      ${contractorSection(META.contractors?.[pp.contractor_id])}
    </div>`;
};

/** Load against capacity, with the temporary connections of the festive window (F4). */
function loadSection(id, load) {
  const rows = load.festive.map((c) => {
    const running = c.fromD <= now() && now() < c.toD;
    return `<li class="flex justify-between gap-3"><span>${esc(c.purpose)} <span class="text-ink-3">· ${esc(fmtDay(c.fromD))} – ${esc(fmtDay(c.toD))}${running ? ' · on now' : ''}</span></span><span class="text-ink-1 whitespace-nowrap">${nf1.format(c.kw)} kW</span></li>`;
  }).join('');
  const bar = (share) => `<div class="load-bar${share > PANEL_LOAD_WARN_SHARE ? ' is-warn' : ''}" role="img" aria-label="${esc(pct(share))} of capacity"><span style="width:${Math.min(100, share * 100)}%"></span><i style="left:${PANEL_LOAD_WARN_SHARE * 100}%"></i></div>`;
  return section('Load', 'fa-gauge-high', `
    ${kv([
      ['Lamps', `${nf1.format(load.lampKw)} kW`],
      ['Now', `${nf1.format(load.nowKw)} kW · ${esc(pct(load.share))} of capacity${bar(load.share)}`],
      load.festive.length ? [`${FESTIVE_WINDOW.label} peak`, `${nf1.format(load.peakKw)} kW · ${esc(pct(load.peakShare))} of capacity${bar(load.peakShare)}`] : null,
    ])}
    ${load.festive.length ? `<p class="text-[11.5px] text-ink-3 mt-3">Temporary connections · ${esc(fmtDay(new Date(`${FESTIVE_WINDOW.start}T12:00${IST_OFFSET}`)))} – ${esc(fmtDay(new Date(`${FESTIVE_WINDOW.end}T12:00${IST_OFFSET}`)))} (example window)</p><ul class="text-[12.5px] text-ink-2 mt-1 space-y-1">${rows}</ul>` : ''}
    ${load.warn ? `<div class="callout callout--warn"><i class="fa-solid fa-gauge-high" aria-hidden="true"></i><div>Above ${Math.round(PANEL_LOAD_WARN_SHARE * 100)}% of capacity. Stagger the temporary connections or move some to another panel.</div></div>` : ''}`);
}

/** Planned power shutdowns on this panel (C2), running or still to come. */
function shutdownSection(id) {
  const list = (panelProps(id)?.planned_shutdowns ?? []).filter((s) => new Date(s.end) > now());
  if (!list.length) return '';
  return section('Planned shutdowns', 'fa-power-off', `<ul class="space-y-2 text-[12.5px]">${list.map((s) => {
    const on = new Date(s.start) <= now();
    return `<li><span class="text-ink-1">${on ? `On now, until ${esc(fmtTime(s.end))}` : `${esc(fmtDateTime(s.start))} – ${esc(fmtTime(s.end))}`}</span> · circuits ${esc(s.circuits.join(', '))}<span class="block text-ink-3">${esc(s.reason)}. Dark poles here are not faults and nothing is dispatched.</span></li>`;
  }).join('')}</ul>`);
}

/** Single-line diagram of one circuit: panel -> poles in wiring order, each pole clickable. */
function circuitDiagram(panelId, circuit, uids) {
  const list = uids.map(props);
  const s = statsOf(list);
  const fault = circuitFault(panelId, circuit);
  return `<div class="mb-4">
    <div class="flex items-baseline justify-between text-[12.5px]"><span class="font-medium text-ink-1">Circuit ${esc(circuit)}</span>
      <span class="text-ink-3">${list.length} poles · ${s.Faulty} dark · ${nf1.format(s.watts / 1000)} kW</span></div>
    ${fault ? `<p class="text-[12px] mt-1 text-ink-2"><i class="fa-solid ${DIAGNOSIS_ICONS[fault.kind]} tone-serious" aria-hidden="true"></i> ${esc(fault.short)}</p>` : ''}
    <div class="sld" role="list">
      <div class="sld-node" role="listitem"><span class="sld-panel" aria-label="Feeder panel"><i class="fa-solid fa-bolt" aria-hidden="true"></i></span><span class="sld-label">FP</span></div>
      ${list.map((p) => `<div class="sld-node" role="listitem">
        <button type="button" class="sld-pole" data-action="select-pole" data-uid="${esc(p.uid)}" title="${esc(p.uid)}"
          aria-label="${esc(`${p.uid}, pole ${p.circuit_seq}, ${STATUS[p.status]?.label ?? p.status}`)}">${statusSymbol(p.status, 16)}</button>
        <span class="sld-label">${esc(p.circuit_seq)}</span></div>`).join('')}
    </div></div>`;
}

// ---- dark spot view --------------------------------------------------------------------
VIEWS.spot = function renderSpotView(id) {
  const s = state.darkSpots.find((d) => d.id === id);
  if (!s) return null;
  const ps = s.recs.map((r) => r.feature.properties);
  const tickets = [...new Set(ps.map((p) => p.ticket).filter(Boolean))];
  const ends = [s.beforeUid, s.afterUid].filter(Boolean);
  return `${viewHead({
    eyebrow: `Unlit stretch · ${s.road}`, title: s.id, sub: esc(s.where),
    extra: `<div class="grid grid-cols-3 gap-2 mt-3">
      <div class="stat"><span class="stat-label">Unlit</span><span class="stat-value">${nf0.format(roundTo(s.unlitM, 5))}</span><span class="stat-sub">metres of road</span></div>
      <div class="stat"><span class="stat-label">Dark poles</span><span class="stat-value">${ps.length}</span><span class="stat-sub">in a row</span></div>
      <div class="stat"><span class="stat-label">Lost load</span><span class="stat-value">${nf1.format(s.lostW / 1000)}</span><span class="stat-sub">kW of lighting</span></div>
    </div>`,
  })}
    <div class="sb-body">
      <div class="callout callout--warn mt-4"><i class="fa-solid ${DIAGNOSIS_ICONS[s.diagnosis.kind]}" aria-hidden="true"></i>
        <div><strong>${esc(s.diagnosis.short)}.</strong> ${esc(s.diagnosis.text)}</div></div>
      <p class="text-[12px] text-ink-3 mt-3">Measured along the road${ends.length ? ` between the lit poles ${ends.map((u) => poleLink(u)).join(' and ')}` : ''}.</p>
      ${section('Dark poles', 'fa-lightbulb', `<ul class="insight-list">${ps.map((p) => `<li>
        <button type="button" class="insight-item" data-action="select-pole" data-uid="${esc(p.uid)}">${statusSymbol(p.status, 14)}
          <span class="min-w-0 flex-1"><span class="block mono text-[12px] text-ink-1">${esc(p.uid)}</span>
          <span class="block text-[11.5px] text-ink-3 truncate">${esc(p.feeder_panel)}/${esc(p.circuit)} #${esc(p.circuit_seq)} · ${esc(p.ticket?.issue ?? 'no ticket')}</span></span>
        </button></li>`).join('')}</ul>`)}
      ${tickets.length ? section('Open tickets', 'fa-ticket', `<p class="text-[13px] text-ink-2">${tickets.map((t) => `<span class="mono">${esc(t.id)}</span> <span class="text-ink-3">(${esc(t.priority)})</span>`).join(', ')}</p>`) : ''}
    </div>`;
};

// ---- ticket view (a ticket with no mapped pole) ---------------------------------------------
VIEWS.ticket = function renderTicketView(id) {
  if (isCitizen()) return null;
  const t = state.tickets.get(id) ?? state.closed.get(id);
  if (!t) return null;
  const at = ticketLatLng(t);
  const r = state.reports.find((x) => x.ticket_id === id && !x.simulated);
  return `${viewHead({ eyebrow: t.near_uid ? `Ticket · at ${t.near_uid}` : 'Ticket · no mapped pole', title: t.id, sub: esc(t.issue) })}
    <div class="sb-body">
      ${state.tickets.has(id) ? ticketCard(t) : quietCard('fa-circle-check', `Closed${t.resolution ? `: ${esc(t.resolution)}` : ''}.`)}
      ${section('Location', 'fa-location-dot', kv([
        at ? ['GIS location', `<span class="mono text-[12.5px]">${fmtLatLngPlain(at)}</span>`] : null,
        ['Nearest pole', t.near_uid ? poleLink(t.near_uid, t.near_uid) : `None within ${SNAP_RADIUS_M} m; the survey team checks the spot`],
        r?.note ? ['Note', esc(r.note)] : null,
        r?.name ? ['Reported by', esc(r.name)] : null,
        r?.photo ? ['Photo', esc(r.photo)] : null,
      ]))}
      ${activitySection({ ticketId: id })}
    </div>`;
};

// ---- coverage gap view ------------------------------------------------------------------------
VIEWS.gap = function renderGapView(id) {
  if (isCitizen()) return null;
  const g = state.gaps.find((x) => x.id === id);
  if (!g) return null;
  return `${viewHead({
    eyebrow: `Coverage gap · ${g.road}`, title: g.id, sub: `Between ${poleLink(g.a, g.a)} and ${poleLink(g.b, g.b)}`,
    extra: `<div class="grid grid-cols-3 gap-2 mt-3">
      <div class="stat"><span class="stat-label">Spacing</span><span class="stat-value">${nf0.format(g.spacingM)}</span><span class="stat-sub">metres</span></div>
      <div class="stat"><span class="stat-label">Limit</span><span class="stat-value">${nf1.format(g.limitM)}</span><span class="stat-sub">metres (example)</span></div>
      <div class="stat"><span class="stat-label">Add</span><span class="stat-value">${g.addPoles}</span><span class="stat-sub">${g.addPoles === 1 ? 'pole' : 'poles'}</span></div>
    </div>`,
  })}
    <div class="sb-body">
      <div class="callout callout--design mt-4"><i class="fa-solid fa-plus" aria-hidden="true"></i><div>
        <strong>Not a fault.</strong> Both lamps work, but they stand too far apart for ${nf1.format(g.heightM)} m poles, so the road between them is dim. This stretch needs another pole, not a repair.</div></div>
      <p class="text-[12px] text-ink-3 mt-3">Example design rule: spacing at most ${DESIGN_SPACING_RATIO} × pole height (${nf1.format(g.limitM)} m). Not a standard; set your own in config.js.</p>
    </div>`;
};

// ---- my reports (Citizen view) ---------------------------------------------------------------
/** A report's progress in plain words (B4). */
/** A report's progress in plain words (B4). Citizens see progress only: never a score or a band below "Confirmed". */
function reportStatus(r) {
  if (r.held_until) return { key: 'logged', text: tr('st_logged', { time: fmtTime(r.held_until) }), icon: 'fa-power-off' };
  if (r.resolved_at && r.outcome === 'no_fault') return { key: 'checked', text: tr('st_checked'), icon: 'fa-magnifying-glass' };
  if (r.resolved_at) return { key: 'fixed', text: tr('st_fixed'), icon: 'fa-circle-check' };
  return ticketStatusText(state.tickets.get(r.ticket_id), r.reopened_at);
}
function ticketStatusText(t, reopened = false) {
  const confirmed = t?.confidence?.band === 'Confirmed';
  if (t?.status === 'In Progress') return { key: 'assigned', text: confirmed ? tr('st_confirmed_assigned') : tr('st_assigned'), icon: 'fa-person-digging' };
  if (t?.status === 'Awaiting dusk check') return { key: 'checking', text: tr('st_checking'), icon: 'fa-moon' };
  if (t && confirmed) return { key: 'confirmed', text: tr('st_confirmed'), icon: 'fa-circle-check' };
  return { key: reopened ? 'reopened' : 'received', text: reopened ? tr('st_reopened') : tr('st_received'), icon: 'fa-inbox' };
}

VIEWS.myreports = function renderMyReportsView() {
  if (!isCitizen()) return null;
  const mine = state.reports.filter((r) => r.mine).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const items = mine.map((r) => {
    const s = reportStatus(r);
    const ask = (s.key === 'fixed' || s.key === 'checked') && !r.confirmed
      ? `<div class="fixed-q"><span>${esc(tr(s.key === 'checked' ? 'working_q' : 'fixed_q'))}</span>
          <button type="button" class="btn btn-ghost" data-action="fixed-yes" data-report="${esc(r.id)}">${esc(tr('yes'))}</button>
          <button type="button" class="btn btn-ghost" data-action="fixed-no" data-report="${esc(r.id)}">${esc(tr('no'))}</button></div>`
      : r.confirmed === 'yes' ? `<p class="text-[12px] text-ink-3 mt-1.5">${esc(tr('fixed_thanks'))}</p>` : '';
    return `<li class="report-card">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[13.5px] text-ink-1 font-medium">${esc(catLabel(r.category, true))}</span>
        <time class="text-[11.5px] text-ink-3 whitespace-nowrap" datetime="${esc(r.created_at)}">${esc(fmtDateTime(r.created_at))}</time>
      </div>
      <p class="text-[12px] text-ink-3 mt-0.5">${r.uid ? `<button type="button" class="link mono" data-action="select-pole" data-uid="${esc(r.uid)}">${esc(r.uid)}</button>` : esc(tr('map_location'))}${r.ticket_id ? ` · <span class="mono">${esc(r.ticket_id)}</span>` : ''}</p>
      <p class="report-status report-status--${s.key}"><i class="fa-solid ${s.icon}" aria-hidden="true"></i>${esc(s.text)}</p>
      ${ask}
      ${shareEligible(r) ? `<button type="button" class="link share-link" data-action="open-share" data-report="${esc(r.id)}"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i>${esc(tr('share'))}</button>` : ''}
    </li>`;
  }).join('');
  return `${viewHead({ eyebrow: tr('pole_eyebrow'), title: tr('my_reports') })}
    <div class="sb-body">
      <p class="text-[12px] text-ink-3 mt-4"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> ${esc(tr('my_reports_note'))}</p>
      ${mine.length ? `<ul class="report-cards">${items}</ul>` : `<p class="empty mt-4">${esc(tr('my_reports_empty'))}</p>`}
    </div>`;
};

/** "Fixed? Yes / No" (B4). No reopens the ticket under the same ID, with its history kept. */
function answerFixed(reportId, fixed) {
  const r = state.reports.find((x) => x.id === reportId);
  if (!r || !r.resolved_at) return;
  if (fixed) {
    r.confirmed = 'yes';
    logActivity(`Reporter confirmed the fix (${r.id})`, { uids: r.uid ? [r.uid] : [], role: 'citizen' });
    renderSelected({ keepScroll: true });
    return;
  }
  const t = reopenTicket(r.ticket_id, `reporter says not fixed (${r.id})`, { report: r });
  if (!t) return;
  if (t.id !== r.ticket_id) { // the pole already had a newer ticket: add this report to it
    t.complaints += 1;
    t.reports.push(r.id);
    r.ticket_id = t.id;
  }
  r.resolved_at = null;
  r.confirmed = null;
  r.reopened_at = now().toISOString();
  afterDataChange();
  toast({ tone: 'info', icon: 'fa-rotate-left', title: tr('st_reopened'), body: tr('reopened_toast') });
}

// ---- public escalation: share preview (citizen) and department update (operator) ------------------
function openShare(reportId) {
  navigate({ type: 'share', id: reportId }, { fromSidebar: true });
}
function openDepartmentUpdate(ticketId) {
  navigate({ type: 'share', id: `update:${ticketId}` }, { fromSidebar: true });
}
/** The exact text before anything opens; the post goes out from the person's own account. */
function sharePreview(text, citizen, attrs) {
  const n = weightedLength(text, X_POST);
  const words = citizen ? { count: tr('share_count', { n, max: X_POST.maxWeighted }), note: tr('share_note'), x: tr('share_x'), other: tr('share_other'), copy: tr('share_copy') }
    : { count: `${n} of ${X_POST.maxWeighted} characters`, note: 'Opens X with this text for the department’s own account. Nothing is posted automatically.', x: 'Post on X', other: 'Share…', copy: 'Copy text' };
  return `<div class="post-preview" lang="${citizen ? state.lang : 'en'}">${esc(text)}</div>
    <p class="text-[11.5px] text-ink-3 mt-1">${esc(words.count)}</p>
    <p class="text-[12px] text-ink-2 mt-3">${esc(words.note)}</p>
    <button type="button" class="btn btn-primary btn-block mt-4" data-action="share-x" ${attrs}><i class="fa-brands fa-x-twitter" aria-hidden="true"></i>${esc(words.x)}</button>
    ${typeof navigator.share === 'function'
      ? `<button type="button" class="btn btn-ghost btn-block mt-2" data-action="share-native" ${attrs}><i class="fa-solid fa-share-nodes" aria-hidden="true"></i>${esc(words.other)}</button>`
      : `<button type="button" class="btn btn-ghost btn-block mt-2" data-action="share-copy" ${attrs}><i class="fa-regular fa-copy" aria-hidden="true"></i>${esc(words.copy)}</button>`}`;
}
/** The text a share action uses: a citizen's post, or a department update. */
function shareText(id) {
  if (id.startsWith('update:')) {
    const t = state.closed.get(id.slice(7));
    return t?.public ? departmentUpdate(t) : null;
  }
  const r = reportById(id);
  return shareEligible(r) ? citizenPost(r) : null;
}

VIEWS.share = function renderShareView(id) {
  const text = shareText(id);
  if (!text) return null;
  if (id.startsWith('update:')) {
    if (state.role !== 'operator') return null;
    return `${viewHead({ eyebrow: 'Public update', title: id.slice(7), sub: 'Shared publicly by its reporter; now fixed' })}
      <div class="sb-body mt-4">${sharePreview(text, false, `data-share="${esc(id)}"`)}</div>`;
  }
  if (!isCitizen()) return null;
  return `${viewHead({ eyebrow: reportById(id).ticket_id, title: tr('share_title') })}
    <div class="sb-body mt-4">${sharePreview(text, true, `data-share="${esc(id)}"`)}</div>`;
};

/** Share actions: X's web intent, the device's share sheet, or the clipboard. The person posts it themselves. */
async function shareVia(channel, id) {
  const text = shareText(id);
  if (!text) return;
  const report = id.startsWith('update:') ? null : reportById(id);
  if (channel === 'x') window.open(intentUrl(text, X_POST), '_blank', 'noopener');
  else if (channel === 'native') {
    try {
      await navigator.share({ text });
    } catch {
      return; // cancelled
    }
  } else {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: 'ok', icon: 'fa-copy', title: report ? tr('copied') : 'Copied' });
    } catch {
      toast({ tone: 'warn', icon: 'fa-triangle-exclamation', title: 'Copy failed' });
    }
    return;
  }
  if (report) markShared(report, channel === 'x' ? 'X' : 'share sheet');
  else {
    const t = state.closed.get(id.slice(7));
    t.update_drafted = now().toISOString();
    logActivity('Public update drafted for the department’s account', { ticket: t });
  }
  renderSelected({ keepScroll: true });
}

// ---- public status link (#ticket=<ID>) --------------------------------------------------------------
function openStatus(id) {
  navigate({ type: 'status', id });
  const t = state.tickets.get(id) ?? state.closed.get(id);
  const at = t ? ticketLatLng(t) : null;
  if (at) flyToVisible(at, Math.max(map.getZoom(), 18));
}

VIEWS.status = function renderStatusView(id) {
  if (!isCitizen()) return null;
  let t = state.tickets.get(id) ?? state.closed.get(id);
  while (t?.merged_into) t = state.tickets.get(t.merged_into) ?? state.closed.get(t.merged_into);
  if (!t) return `${viewHead({ eyebrow: tr('status_title'), title: id })}<div class="sb-body"><p class="empty mt-4">${esc(tr('status_missing'))}</p></div>`;
  const s = t.status === 'Closed' ? (t.field_outcome === 'no_fault' ? { key: 'checked', text: tr('st_checked'), icon: 'fa-magnifying-glass' }
    : { key: 'fixed', text: tr('st_fixed'), icon: 'fa-circle-check' }) : ticketStatusText(t);
  const at = ticketLatLng(t);
  const landmark = at ? landmarkNear(at) : null;
  const days = daysOpen(t);
  return `${viewHead({ eyebrow: tr('status_title'), title: t.id, sub: esc(`${catLabel(t.category, true)} · ${ticketRoad(t)}${landmark ? tr('post_near', { landmark }) : ''}`) })}
    <div class="sb-body">
      <p class="report-status report-status--${s.key} mt-4"><i class="fa-solid ${s.icon}" aria-hidden="true"></i>${esc(s.text)}</p>
      ${t.status === 'Closed' ? '' : `<p class="text-[12.5px] text-ink-3 mt-2">${esc(days <= 1 ? tr('post_open_one') : tr('post_open', { days }))}</p>`}
    </div>`;
};

/** Map layers that belong to a sidebar view (work order route, event route) follow the selection. */
function syncViewLayers() {
  if (!layers.route) return;
  syncRoleLayers();
  renderLegend();
}
