/* ==========================================================================
 * Street Light GIS · roles.js
 * Section 15: what each role works through in the sidebar.
 *   Operator: ticket queue · Field crew: work order, night audit · Management: dashboard
 *   Operator and Management: pole labels (QR), event check
 * ========================================================================== */
'use strict';

// ========================================================================
// 15. Role views
// ========================================================================
const shortUid = (uid) => uid.replace('SL-CP-', '');
const whereText = (t) => (t.pole_uids.length
  ? `${t.pole_uids.slice(0, 3).map(shortUid).join(', ')}${t.pole_uids.length > 3 ? ` +${t.pole_uids.length - 3}` : ''}`
  : t.near_uid ? `at ${shortUid(t.near_uid)}` : 'No mapped pole');
const priorityBadge = (t) => `<span class="priority priority--${esc(t.priority.toLowerCase())}">${esc(t.priority)}</span>`;
const toolButton = (action, icon, label, attrs = '') => `<button type="button" class="btn btn-ghost btn-sm" data-action="${action}" ${attrs}><i class="fa-solid ${icon}" aria-hidden="true"></i>${esc(label)}</button>`;

function dueText(t) {
  if (t.status === 'Awaiting dusk check') return 'awaiting dusk check';
  const left = hoursBetween(now(), t.sla_due);
  return left < 0 ? `<span class="sla-breached"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> ${esc(fmtHours(-left))} past SLA</span>` : `due in ${esc(fmtHours(left))}`;
}

// ---- 15.1 Operator: ticket queue (C3–C5) ------------------------------------------
function openQueue() {
  navigate({ type: 'queue', id: 'all' });
}

VIEWS.queue = function renderQueueView() {
  if (state.role !== 'operator') return null;
  const list = openTickets();
  const awaiting = list.filter((t) => t.status === 'Awaiting dusk check');
  const live = list.filter((t) => t.status !== 'Awaiting dusk check');
  const emergencies = live.filter(isEmergency);
  const rest = live.filter((t) => !isEmergency(t));
  const breached = live.filter(isBreached).length;
  const shutdowns = activeShutdowns();
  const group = (title, items, cls = '') => (items.length ? `<h3 class="queue-h${cls}">${esc(title)} · ${items.length}</h3><ul class="queue">${items.map(queueRow).join('')}</ul>` : '');
  return `${viewHead({ eyebrow: 'Operator', title: 'Ticket queue', sub: `${plural(live.length, 'open ticket')} · ${breached} past SLA` })}
    <div class="sb-body">
      ${shutdowns.map((s) => `<div class="callout mt-4"><i class="fa-solid fa-power-off" aria-hidden="true"></i><div>
        <strong>Planned shutdown until ${esc(fmtTime(s.end))}:</strong> ${esc(s.panelId)} circuits ${esc(s.circuits.join(', '))} (${esc(s.reason)}).
        Lamp-out reports there are logged, not dispatched.</div></div>`).join('')}
      ${group('Safety emergencies', emergencies, ' queue-h--emergency')}
      ${group('Open and in progress', rest)}
      ${group('Awaiting dusk check', awaiting)}
      ${list.length ? '' : `<div class="mt-4">${quietCard('fa-circle-check', 'No open tickets.')}</div>`}
      <div class="tools">
        <p class="eyebrow">Tools</p>
        <div class="flex flex-wrap gap-2 mt-2">
          ${toolButton('open-labels', 'fa-qrcode', 'Pole labels')}
          ${toolButton('open-event', 'fa-route', 'Event check')}
          ${toolButton('open-monsoon', 'fa-cloud-rain', 'Due before monsoon')}
        </div>
      </div>
    </div>`;
};

function queueRow(t) {
  const esc2 = t.escalationIndex > 0 ? ` · <span class="escalated"><i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i> ${esc(t.escalation.level)}</span>` : '';
  const status = { 'In Progress': `with ${esc(t.assigned_crew ?? 'crew')}`, 'Awaiting dusk check': 'repaired' }[t.status] ?? 'not dispatched';
  return `<li><button type="button" class="queue-item${isEmergency(t) ? ' is-emergency' : ''}" data-action="open-ticket" data-ticket="${esc(t.id)}">
    <span class="flex items-baseline justify-between gap-2"><span class="mono text-[12.5px] text-ink-1">${esc(t.id)}</span>${priorityBadge(t)}</span>
    <span class="block text-[13px] text-ink-1 mt-0.5 truncate">${esc(t.issue)}</span>
    <span class="block text-[11.5px] text-ink-3 truncate">${esc(whereText(t))} · ${esc(assigneeOf(t))}</span>
    <span class="block text-[11.5px] text-ink-3 truncate">Why: ${esc(t.why)}</span>
    <span class="block text-[11.5px] text-ink-2 mt-0.5">${status} · ${dueText(t)}${esc2}</span>
  </button></li>`;
}

// ---- 15.2 Field crew: work order (D1, D2) --------------------------------------------
function allCrews() {
  return [...new Set([...Object.values(META.contractors ?? {}).flatMap((c) => c.crews ?? []), ...Object.values(META.team_crews ?? {}).flat()])];
}
/** The crew this Field crew view belongs to (demo: pick one); by default the crew with the most jobs. */
function currentCrew() {
  if (state.crew && allCrews().includes(state.crew)) return state.crew;
  const busiest = mostCommonAll(openTickets().filter((t) => t.status === 'In Progress' && t.assigned_crew).map((t) => t.assigned_crew))[0]?.[0];
  return busiest ?? allCrews()[0];
}
const crewJobs = (crew) => openTickets().filter((t) => t.assigned_crew === crew && (t.status === 'In Progress' || t.status === 'Awaiting dusk check'));

function ticketCentre(t) {
  const lls = t.pole_uids.map((u) => state.byUid.get(u)?.latlng).filter(Boolean);
  return lls.length ? L.latLng(sum(lls.map((l) => l.lat)) / lls.length, sum(lls.map((l) => l.lng)) / lls.length) : ticketLatLng(t);
}

/**
 * Suggested order: jobs within WORK_ORDER_GROUP_M of each other are one stop; the route starts at
 * the most urgent stop and always goes to the nearest stop not yet visited (nearest neighbour).
 */
function workOrderStops(crew) {
  const jobs = crewJobs(crew).filter((t) => t.status === 'In Progress').map((t) => ({ t, at: ticketCentre(t) })).filter((j) => j.at);
  const parent = jobs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < jobs.length; i++) {
    for (let j = i + 1; j < jobs.length; j++) if (jobs[i].at.distanceTo(jobs[j].at) <= WORK_ORDER_GROUP_M) parent[find(i)] = find(j);
  }
  const stops = [...groupBy(jobs.map((j, i) => ({ ...j, root: find(i) })), (j) => j.root).values()].map((group) => ({
    jobs: group.map((g) => g.t).sort(ticketOrder),
    at: L.latLng(sum(group.map((g) => g.at.lat)) / group.length, sum(group.map((g) => g.at.lng)) / group.length),
  }));
  stops.sort((a, b) => ticketOrder(a.jobs[0], b.jobs[0]));
  const route = [];
  let next = stops.shift();
  while (next) {
    route.push(next);
    const from = next.at;
    stops.sort((a, b) => from.distanceTo(a.at) - from.distanceTo(b.at));
    next = stops.shift();
  }
  return route;
}

function openWorkOrder(section = 'jobs') {
  navigate({ type: 'workorder', id: section });
  if (section === 'checks') $('#wo-checks')?.scrollIntoView({ block: 'start' });
  const stops = workOrderStops(currentCrew());
  if (stops.length) fitTo(L.latLngBounds(stops.map((s) => s.at)).pad(0.25), 18);
}

VIEWS.workorder = function renderWorkOrderView() {
  if (state.role !== 'field') return null;
  const crew = currentCrew();
  const stops = workOrderStops(crew);
  const checks = crewJobs(crew).filter((t) => t.status === 'Awaiting dusk check');
  const jobs = sum(stops.map((s) => s.jobs.length));
  return `${viewHead({ eyebrow: `Field crew · ${crew}`, title: 'Work order', sub: `${plural(jobs, 'job')} · ${plural(stops.length, 'stop')}` })}
    <div class="sb-body">
      ${stops.length ? section('Suggested order', 'fa-route', `<ol class="stops">${stops.map((s, i) => `<li class="stop">
          <span class="stop-n" aria-label="Stop ${i + 1}">${i + 1}</span>
          <div class="min-w-0 flex-1 space-y-2">${s.jobs.map(jobCard).join('')}</div></li>`).join('')}</ol>
        <p class="text-[11.5px] text-ink-3 mt-3">Most urgent stop first, then always the nearest. Jobs within ${WORK_ORDER_GROUP_M} m are one stop.</p>`)
        : `<div class="mt-4">${quietCard('fa-circle-check', 'No jobs dispatched to this crew.')}</div>`}
      <div id="wo-checks">${checks.length ? section('Dusk checks', 'fa-moon', `<div class="space-y-2">${checks.map(jobCard).join('')}</div>`) : ''}</div>
    </div>`;
};

/** A job in the work order: what, where, what to carry, and the close or dusk-check controls. */
function jobCard(t) {
  const spares = sparesLine(t);
  const poles = t.pole_uids.length ? t.pole_uids.map((u) => poleLink(u)).join(', ') : esc(whereText(t));
  return `<div class="job${isEmergency(t) ? ' is-emergency' : ''}">
    <div class="flex items-baseline justify-between gap-2">
      <button type="button" class="link mono text-[12.5px]" data-action="open-ticket" data-ticket="${esc(t.id)}">${esc(t.id)}</button>${priorityBadge(t)}</div>
    <p class="text-[13px] text-ink-1 mt-0.5">${esc(t.issue)}</p>
    <p class="text-[11.5px] text-ink-3">${poles} · ${dueText(t)}</p>
    ${spares ? `<p class="spares"><i class="fa-solid fa-toolbox" aria-hidden="true"></i>${esc(spares)}</p>` : ''}
    ${ticketWarranty(t) ? '<p class="mt-1.5"><span class="badge"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i>Under warranty</span></p>' : ''}
    ${t.status === 'Awaiting dusk check' ? duskCheckHtml(t) : workflowControls(t)}
  </div>`;
}

/** Route drawn lightly on the map only while the work order is open. */
function renderRouteLayer() {
  layers.route.clearLayers();
  if (state.selected?.type !== 'workorder' || state.role !== 'field') return;
  const stops = workOrderStops(currentCrew());
  if (stops.length > 1) {
    L.polyline(stops.map((s) => s.at), { pane: 'overlayLinePane', interactive: false, color: TOKEN.ink1, weight: 2, opacity: 0.55, dashArray: '1 7', lineCap: 'round' }).addTo(layers.route);
  }
  stops.forEach((s, i) => L.marker(s.at, {
    pane: 'landmarkPane', interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'stop-icon', html: `<span>${i + 1}</span>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
  }).addTo(layers.route));
}

// ---- 15.3 Field crew: night audit (D4) -------------------------------------------------
let auditOrderCache = null;
/** Poles without a CCMS node, in walking order: start at the first along the roads, then always the nearest. */
function auditPoles() {
  if (auditOrderCache) return auditOrderCache;
  const ordered = [...roadOrder.values()].flatMap((r) => r.uids).filter((uid) => !props(uid).ccms_node);
  const rest = new Set(ordered.slice(1));
  const order = ordered.length ? [ordered[0]] : [];
  while (rest.size) {
    const from = state.byUid.get(order[order.length - 1]).latlng;
    let best = null;
    for (const uid of rest) if (!best || from.distanceTo(state.byUid.get(uid).latlng) < from.distanceTo(state.byUid.get(best).latlng)) best = uid;
    order.push(best);
    rest.delete(best);
  }
  auditOrderCache = order;
  return order;
}

function openAudit() {
  state.audit ??= { index: 0, results: {}, tickets: [] };
  navigate({ type: 'audit', id: 'night' });
  focusAuditPole();
}
const auditUid = () => auditPoles()[state.audit?.index ?? 0] ?? null;
function focusAuditPole() {
  const uid = auditUid();
  if (uid && state.selected?.type === 'audit') flyToVisible(state.byUid.get(uid).latlng, Math.max(map.getZoom(), 18));
  updateSelectionRing();
}

VIEWS.audit = function renderAuditView() {
  if (state.role !== 'field' || !state.audit) return null;
  const order = auditPoles();
  const a = state.audit;
  const checked = Object.keys(a.results).length;
  const dark = Object.values(a.results).filter((v) => v === 'dark').length;
  const progress = `<div class="audit-progress" role="img" aria-label="${checked} of ${order.length} checked"><span style="width:${(checked / Math.max(1, order.length)) * 100}%"></span></div>
    <p class="text-[12px] text-ink-3 mt-1.5">${checked} of ${order.length} checked · ${dark} dark · ${plural(a.tickets.length, 'new ticket')}</p>`;
  const head = viewHead({ eyebrow: 'Field crew', title: 'Night audit', sub: 'Poles without CCMS, in walking order' });
  if (!isDark()) {
    return `${head}<div class="sb-body">${progress}
      <div class="mt-4">${quietCard('fa-sun', `Lamps switch on at ${esc(fmtTime(nextDusk()))}. Start the audit after dark.`, 'info')}</div></div>`;
  }
  if (a.index >= order.length) {
    return `${head}<div class="sb-body">${progress}
      <div class="mt-4">${quietCard('fa-flag-checkered', `Audit complete: ${dark} dark of ${checked} checked.`)}</div>
      ${a.tickets.length ? section('Raised or updated', 'fa-ticket', `<ul class="text-[12.5px] space-y-1">${a.tickets.map((x) => `<li><span class="mono">${esc(shortUid(x.uid))}</span> · ${esc(x.text)}</li>`).join('')}</ul>`) : ''}
      <button type="button" class="btn btn-ghost btn-block mt-4" data-action="audit-restart"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i>Start again</button></div>`;
  }
  const p = props(order[a.index]);
  const hold = shutdownOf(p);
  const before = a.results[p.uid];
  return `${head}<div class="sb-body">${progress}
    <div class="audit-card">
      <p class="eyebrow">Pole ${a.index + 1} of ${order.length}</p>
      <p class="mono text-[20px] font-semibold mt-1">${esc(p.uid)}</p>
      <p class="text-[13px] text-ink-2 mt-0.5">${esc(p.location)}</p>
      <p class="text-[12px] text-ink-3 mt-2">${statusSymbol(p.status, 12)} ${esc(STATUS[p.status]?.label)}${p.ticket ? ` · open ticket <span class="mono">${esc(p.ticket.id)}</span>` : ''}${before ? ` · marked ${esc(before)}` : ''}</p>
      ${hold ? `<p class="text-[12px] text-ink-2 mt-1"><i class="fa-solid fa-power-off" aria-hidden="true"></i> Planned shutdown until ${esc(fmtTime(hold.end))}: a dark lamp here is logged, not dispatched.</p>` : ''}
    </div>
    <div class="audit-buttons">
      <button type="button" class="btn audit-btn audit-btn--lit" data-action="audit-lit"><i class="fa-solid fa-lightbulb" aria-hidden="true"></i>Lit</button>
      <button type="button" class="btn audit-btn audit-btn--dark" data-action="audit-dark"><i class="fa-regular fa-lightbulb" aria-hidden="true"></i>Dark</button>
    </div>
    <div class="flex justify-between mt-3">
      <button type="button" class="btn btn-ghost btn-sm" data-action="audit-prev" ${a.index ? '' : 'disabled'}><i class="fa-solid fa-arrow-left" aria-hidden="true"></i>Previous</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="audit-skip">Skip<i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
    </div></div>`;
};

/** Record one pole: Dark files a report (duplicate merging and shutdown holds apply), Lit just moves on. */
function auditMark(result) {
  const a = state.audit;
  const uid = auditUid();
  if (!a || !uid || !isDark()) return;
  if (result === 'dark' && a.results[uid] !== 'dark') {
    const { ticket, outcome, hold } = fileReport({ category: 'not_working', uid, latlng: state.byUid.get(uid).latlng, source: 'Night audit', role: 'field' });
    const text = outcome === 'logged' ? `logged: planned shutdown until ${fmtTime(hold.end)}`
      : outcome === 'new' ? `new ticket ${ticket.id}` : `${outcome === 'reopened' ? 'reopened' : '+1 report on'} ${ticket.id}`;
    a.tickets.push({ uid, text });
    toast({ tone: 'info', icon: 'fa-moon', title: `${shortUid(uid)} dark`, body: text[0].toUpperCase() + text.slice(1) });
  }
  a.results[uid] = result;
  a.index += 1;
  afterDataChange();
  focusAuditPole();
}

// ---- 15.4 Management dashboard (A1 total, E1–E4, F1) -----------------------------------------
function openDashboard(sectionKey = 'uptime') {
  navigate({ type: 'dashboard', id: sectionKey });
  $(`[data-fold="${CSS.escape(sectionKey)}"]`)?.scrollIntoView({ block: 'start' });
}

const dashFold = (key, title, icon, body, open) => `<details class="sb-section sb-fold" data-fold="${key}"${open ? ' open' : ''}><summary class="sb-h"><i class="fa-solid ${icon}" aria-hidden="true"></i>${esc(title)}<i class="fa-solid fa-chevron-down fold-chevron" aria-hidden="true"></i></summary>${body}</details>`;

VIEWS.dashboard = function renderDashboardView(openKey) {
  if (state.role !== 'management') return null;
  return `${viewHead({ eyebrow: 'Management', title: 'Dashboard', sub: `Data as of ${esc(fmtDateTime(META.as_of))} · energy to ${esc(fmtMonth(META.energy_month))}` })}
    <div class="sb-body">
      ${dashFold('uptime', 'Uptime', 'fa-chart-line', uptimeHtml(), openKey === 'uptime')}
      ${dashFold('unlit', 'Unlit road', 'fa-road', unlitHtml(), openKey === 'unlit')}
      ${dashFold('contractors', 'Contractor scorecard', 'fa-helmet-safety', scorecardHtml(), openKey === 'contractors')}
      ${dashFold('assets', 'Chronic poles and batches', 'fa-layer-group', assetsHtml(), openKey === 'assets')}
      ${dashFold('energy', 'Energy reconciliation', 'fa-scale-unbalanced', reconciliationHtml(), openKey === 'energy')}
      ${dashFold('readiness', 'Readiness', 'fa-clipboard-check', readinessHtml(), openKey === 'readiness')}
    </div>`;
};

function uptimeHtml() {
  const u = uptimeTable();
  const last = u.months[u.months.length - 1];
  const cell = (v) => `<td>${v == null ? '–' : nf1.format(v * 100)}</td>`;
  const rows = (title, list) => `<tr class="mini-sub"><th scope="rowgroup" colspan="${u.months.length + 1}">${esc(title)}</th></tr>
    ${list.map((r) => `<tr><th scope="row">${esc(r.label)}</th>${r.months.map(cell).join('')}</tr>`).join('')}`;
  return `<div class="flex items-end justify-between gap-3">
      <div><div class="big-number">${u.zone.months.at(-1) == null ? '–' : esc(pct(u.zone.months.at(-1)))}</div>
        <div class="text-xs text-ink-3 mt-1">Pilot zone · ${esc(fmtMonth(last))}</div></div>
      <p class="text-right text-[11.5px] text-ink-3 max-w-[190px]">Lamp-hours lit ÷ lamp-hours scheduled (sunset to sunrise, less planned shutdowns)</p>
    </div>
    <div class="table-scroll mt-3"><table class="mini-table mini-table--grid">
      <thead><tr><th scope="col">%</th>${u.months.map((m) => `<th scope="col">${esc(fmtMonthShort(m))}</th>`).join('')}</tr></thead>
      <tbody><tr><th scope="row">${esc(u.zone.label)}</th>${u.zone.months.map(cell).join('')}</tr>
        ${rows('By road', u.roads)}${rows('By contractor', u.contractors)}</tbody></table></div>`;
}

function unlitHtml() {
  const runs = [...state.darkRuns].sort((a, b) => b.unlitM - a.unlitM);
  return `<div class="big-number">${nf0.format(roundTo(unlitTotalM(), 5))}<span class="unit">m</span></div>
    <p class="text-xs text-ink-3 mt-1">Road length between lit poles across ${plural(runs.length, 'stretch', 'stretches')} of ${MIN_DARK_RUN}+ dark poles, now</p>
    ${runs.length ? `<ul class="insight-list">${runs.map((r) => `<li><button type="button" class="insight-item" data-action="open-run" data-uid="${esc(r.uids[0])}">
      <span class="insight-badge">${nf0.format(roundTo(r.unlitM, 5))} m</span>
      <span class="min-w-0 flex-1"><span class="block text-[12.5px] text-ink-1">${esc(r.road)} · ${plural(r.uids.length, 'pole')}</span>
      <span class="block text-[11.5px] text-ink-3 truncate">${esc(r.uids.map(shortUid).join(', '))}</span></span></button></li>`).join('')}</ul>` : ''}`;
}

function scorecardHtml() {
  const cards = contractorScorecards();
  return `${cards.map((c) => `<div class="score-card">
      <div class="flex items-baseline justify-between gap-2"><span class="text-[13.5px] font-medium text-ink-1">${esc(c.name)}</span>
        <span class="text-[12px] ${c.compliance != null && c.compliance < 0.8 ? 'text-ink-1' : 'text-ink-3'}">${c.compliance == null ? '–' : esc(pct(c.compliance))} SLA met</span></div>
      ${kv([
        ['Jobs closed', `${c.jobs} · ${c.breaches} breached`],
        ['Mean time to repair', c.mttrH == null ? '–' : esc(fmtHours(c.mttrH))],
        ['Cost', esc(inr(c.cost))],
        ['Repeat failures', `${c.repeats} <span class="text-ink-3">(failed again within ${REPEAT_WINDOW_DAYS} days)</span>`],
        ['Example deduction', `${esc(inr(c.exampleDeduction))} <span class="text-ink-3">(example rule)</span>`],
      ])}</div>`).join('')}
    <p class="text-[11.5px] text-ink-3 mt-3">Last ${SCORECARD_WINDOW_DAYS} days of closed corrective jobs. Example payment rule only, not a contract term:
      ${esc(inr(EXAMPLE_DEDUCTION_PER_BREACH_INR))} per SLA breach. Set real terms in config.js.</p>`;
}

function assetsHtml() {
  const chronic = chronicPoles();
  const { zoneRate, rows } = batchFailureRates();
  const claimable = openTickets().filter(ticketWarranty);
  const maxRate = Math.max(...rows.map((r) => r.rate), 0.0001);
  return `<p class="text-[12.5px] text-ink-1 font-medium">${plural(chronic.length, 'chronic pole')} <span class="text-ink-3 font-normal">· ${CHRONIC_FAILURES}+ failures in ${CHRONIC_WINDOW_DAYS} days</span></p>
    ${chronic.length ? `<ul class="insight-list">${chronic.map(({ p, failures }) => `<li><button type="button" class="insight-item" data-action="select-pole" data-uid="${esc(p.uid)}" data-zoom="1">
      <span class="insight-badge">${failures}×</span>
      <span class="min-w-0 flex-1"><span class="block mono text-[12px] text-ink-1">${esc(p.uid)}</span>
      <span class="block text-[11.5px] text-ink-3">Check cable, voltage or water ingress, not the lamp</span></span></button></li>`).join('')}</ul>` : ''}
    <p class="text-[12.5px] text-ink-1 font-medium mt-4">Failure rate by fixture batch <span class="text-ink-3 font-normal">· last ${CHRONIC_WINDOW_DAYS} days</span></p>
    <ul class="mt-2 space-y-1.5">${rows.map((r) => `<li class="batch-row${r.weak ? ' is-weak' : ''}">
      <span class="min-w-0"><span class="mono text-[12px] text-ink-1">${esc(r.batch)}</span> <span class="text-[11.5px] text-ink-3">${esc(r.make)} · ${r.fixtures} fixtures</span></span>
      <span class="share-track"><span class="share-fill" style="display:block;width:${(r.rate / maxRate) * 100}%"></span></span>
      <span class="text-[11.5px] text-right ${r.weak ? 'text-ink-1' : 'text-ink-3'}">${r.failures} · ${nf1.format(r.ratio)}×</span></li>`).join('')}</ul>
    <p class="text-[11.5px] text-ink-3 mt-2">Failures per fixture against the zone rate (${nf1.format(zoneRate * 100)} per 100 fixtures). Cable theft, vehicle damage and MCB trips are not counted. Batches at ${WEAK_BATCH_RATIO}× or more are marked.</p>
    <p class="text-[12.5px] text-ink-1 font-medium mt-4">Under warranty</p>
    <p class="text-[12px] text-ink-2 mt-1">${plural(allProps().filter((p) => underWarranty(p)).length, 'fixture')} still under the supplier warranty (example periods).
      ${claimable.length ? `Open fixture tickets to claim: ${claimable.map((t) => `<button type="button" class="link mono" data-action="open-ticket" data-ticket="${esc(t.id)}">${esc(t.id)}</button>`).join(', ')}.` : ''}</p>`;
}

function reconciliationHtml() {
  const month = META.energy_month;
  const rows = reconciliation(month);
  const flagged = rows.filter((r) => r.flag);
  return `<p class="text-[12px] text-ink-3">${esc(fmtMonth(month))}: metered kWh at each feeder panel against the sum of its lamps' own use (gap over ${Math.round(RECONCILIATION_GAP_SHARE * 100)}% flagged)</p>
    <div class="table-scroll mt-2"><table class="mini-table mini-table--grid">
      <thead><tr><th scope="col">Panel</th><th scope="col">Metered</th><th scope="col">Lamps</th><th scope="col">Gap</th></tr></thead>
      <tbody>${rows.map((r) => `<tr${r.flag ? ' class="is-flag"' : ''}><th scope="row"><button type="button" class="link mono" data-action="open-panel" data-panel="${esc(r.id)}">${esc(r.id)}</button></th>
        <td>${r.metered == null ? '–' : nf0.format(r.metered)}</td><td>${nf0.format(r.lamps)}</td>
        <td>${r.share == null ? '–' : `${r.share >= 0 ? '+' : '−'}${nf1.format(Math.abs(r.share) * 100)}%`}${r.flag ? ' <i class="fa-solid fa-circle-exclamation tone-serious" aria-hidden="true"></i>' : ''}</td></tr>`).join('')}</tbody></table></div>
    ${flagged.length ? `<div class="callout callout--warn"><i class="fa-solid fa-scale-unbalanced" aria-hidden="true"></i><div>
      <strong>Unexplained consumption</strong> at ${flagged.map((r) => esc(r.id)).join(', ')}. Possible causes to check: illegal tapping, leakage to earth, or a meter fault.</div></div>` : ''}`;
}

function readinessHtml() {
  const due = monsoonDue();
  return `<p class="text-[12.5px] text-ink-1 font-medium">Due before monsoon <span class="text-ink-3 font-normal">· by ${esc(fmtDate(new Date(`${MONSOON_START}T12:00${IST_OFFSET}`)))} (example date)</span></p>
    <p class="text-[12px] text-ink-2 mt-1">${plural(due.length, 'pole')} with an earthing check older than ${EARTHING_CHECK_MAX_MONTHS} months${due.some((x) => x.water) ? `, ${due.filter((x) => x.water).length} near a waterlogging spot (listed first)` : ''}.</p>
    <div class="flex flex-wrap gap-2 mt-2">${toolButton('open-monsoon', 'fa-list', 'Open list')}${toolButton('highlight-monsoon', 'fa-filter', 'Show on map')}</div>
    <p class="text-[12.5px] text-ink-1 font-medium mt-4">Events and labels</p>
    <div class="flex flex-wrap gap-2 mt-2">${toolButton('open-event', 'fa-route', 'Event check')}${toolButton('open-labels', 'fa-qrcode', 'Pole labels')}</div>`;
}

// ---- 15.5 Due before monsoon (F1) ----------------------------------------------------------
function openMonsoon() {
  navigate({ type: 'monsoon', id: 'due' }, { fromSidebar: state.selected?.type === 'dashboard' || state.selected?.type === 'queue' });
}

VIEWS.monsoon = function renderMonsoonView() {
  if (state.role !== 'operator' && state.role !== 'management') return null;
  const due = monsoonDue();
  return `${viewHead({ eyebrow: 'Readiness', title: 'Due before monsoon', sub: `Earthing checks older than ${EARTHING_CHECK_MAX_MONTHS} months · monsoon from ${esc(fmtDate(new Date(`${MONSOON_START}T12:00${IST_OFFSET}`)))} (example)` })}
    <div class="sb-body">
      <div class="flex flex-wrap gap-2 mt-4">${toolButton('highlight-monsoon', 'fa-filter', `Show ${due.length} on map`)}</div>
      <ul class="insight-list">${due.map(({ p, age, water }) => `<li><button type="button" class="insight-item" data-action="select-pole" data-uid="${esc(p.uid)}" data-zoom="1">
        ${statusSymbol(p.status, 14)}
        <span class="min-w-0 flex-1"><span class="flex justify-between gap-2"><span class="mono text-[12px] text-ink-1">${esc(p.uid)}</span><span class="text-[11.5px] text-ink-3">${age} months</span></span>
        <span class="block text-[11.5px] text-ink-3">Earthing ${esc(fmtDate(p.last_earthing_check))} · box ${esc(p.junction_box_condition.toLowerCase())}${water ? ` · <span class="text-ink-1"><i class="fa-solid fa-water tone-water" aria-hidden="true"></i> near ${esc(water.name)}</span>` : ''}</span></span>
      </button></li>`).join('')}</ul>
      <p class="text-[11.5px] text-ink-3 mt-3">Waterlogging spots are approximate. Example threshold and date; set your own in config.js.</p>
    </div>`;
};

function highlightMonsoon() {
  setHighlight('earthing check due before monsoon', monsoonDue().map((x) => x.p.uid));
  if (!state.overlays.water && roleShowsOverlay('water')) setOverlay('water', true);
}

// ---- 15.6 Pole labels with QR codes (B1) ------------------------------------------------------
function openLabels() {
  navigate({ type: 'labels', id: 'all' }, { fromSidebar: ['dashboard', 'queue'].includes(state.selected?.type) });
}
const labelUrl = (uid) => `${BASE_URL.replace(/#.*$/, '')}#report=${encodeURIComponent(uid)}`;

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return null;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

VIEWS.labels = function renderLabelsView() {
  if (state.role !== 'operator' && state.role !== 'management') return null;
  const ready = Boolean(BASE_URL);
  const lib = typeof window.qrcode === 'function';
  return `${viewHead({ eyebrow: 'Citizen reporting', title: 'Pole labels', sub: `One QR label per pole · ${state.byUid.size} poles` })}
    <div class="sb-body">
      ${ready ? '' : `<div class="callout callout--warn mt-4"><i class="fa-solid fa-link" aria-hidden="true"></i><div>
        <strong>Set a hosting URL first.</strong> The QR codes must open the public address of this app. Set <span class="mono">BASE_URL</span> in config.js
        (for example <span class="mono">https://lights.example.org/</span>); each label then links to <span class="mono">BASE_URL#report=&lt;pole ID&gt;</span>.</div></div>`}
      ${ready && !lib ? '<div class="callout callout--warn mt-4"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><div>The QR code library did not load from the CDN.</div></div>' : ''}
      <p class="text-[12.5px] text-ink-2 mt-4">Scanning a label opens the report form for that pole, already filled in.</p>
      ${ready && lib ? `<div class="label-preview">${labelHtml(state.byUid.keys().next().value)}</div>` : ''}
      <button type="button" class="btn btn-primary btn-block mt-4" data-action="print-labels" ${ready && lib ? '' : 'disabled'}><i class="fa-solid fa-print" aria-hidden="true"></i>Print ${state.byUid.size} labels</button>
    </div>`;
};

function labelHtml(uid) {
  return `<div class="qr-label"><div class="qr" role="img" aria-label="QR code for ${esc(uid)}">${qrSvg(labelUrl(uid)) ?? ''}</div>
    <div class="qr-text"><span class="qr-uid">${esc(uid)}</span><span class="qr-call">Light out? Scan to report.</span></div></div>`;
}

function printSheet(html) {
  const sheet = $('#print-sheet');
  sheet.innerHTML = html;
  window.print();
}

function printLabels() {
  if (!BASE_URL || typeof window.qrcode !== 'function') return;
  const uids = [...roadOrder.values()].flatMap((r) => r.uids);
  printSheet(`<div class="print-labels">${uids.map(labelHtml).join('')}</div>`);
}

// ---- 15.7 Event check (F2) ---------------------------------------------------------------------
function openEvent() {
  state.event ??= { roads: [], line: null };
  navigate({ type: 'event', id: 'check' }, { fromSidebar: ['dashboard', 'queue'].includes(state.selected?.type) });
}

VIEWS.event = function renderEventView() {
  if ((state.role !== 'operator' && state.role !== 'management') || !state.event) return null;
  const ev = state.event;
  const roads = [...roadOrder.keys()];
  const has = ev.roads.length || ev.line;
  const res = has ? eventCheck(ev) : null;
  return `${viewHead({ eyebrow: 'Readiness', title: 'Event check', sub: 'Lights along an event route' })}
    <div class="sb-body">
      <p class="field-label mt-4">Roads</p>
      <div class="flex flex-wrap gap-2 mt-2">${roads.map((r) => `<button type="button" class="chip-toggle" data-action="event-road" data-road="${esc(r)}" aria-pressed="${ev.roads.includes(r)}">${esc(r)}</button>`).join('')}</div>
      <p class="field-label mt-4">Or a route</p>
      <div class="flex flex-wrap gap-2 mt-2">
        ${toolButton('event-draw', 'fa-pen', ev.line ? 'Redraw route' : 'Draw on map')}
        ${ev.line ? toolButton('event-clear-line', 'fa-xmark', 'Clear route') : ''}
      </div>
      ${res ? `
        <div class="grid grid-cols-3 gap-2 mt-4">
          <div class="stat"><span class="stat-label">Poles</span><span class="stat-value">${res.poles.length}</span><span class="stat-sub">on the route</span></div>
          <div class="stat"><span class="stat-label">Not working</span><span class="stat-value">${res.notWorking.length}</span><span class="stat-sub">faulty or in repair</span></div>
          <div class="stat"><span class="stat-label">Tickets</span><span class="stat-value">${res.tickets.length}</span><span class="stat-sub">open</span></div>
        </div>
        ${eventListHtml(res)}
        <div class="flex flex-wrap gap-2 mt-4">
          ${toolButton('event-print', 'fa-print', 'Print')}
          ${res.notWorking.length ? toolButton('event-highlight', 'fa-filter', 'Show on map') : ''}
        </div>` : '<p class="empty mt-4">Pick roads or draw the route to see which lights need attention.</p>'}
    </div>`;
};

function eventListHtml(res) {
  return `${res.notWorking.length ? `<ul class="insight-list">${res.notWorking.map((p) => `<li><button type="button" class="insight-item" data-action="select-pole" data-uid="${esc(p.uid)}" data-zoom="1">
      ${statusSymbol(p.status, 14)}<span class="min-w-0 flex-1"><span class="block mono text-[12px] text-ink-1">${esc(p.uid)}</span>
      <span class="block text-[11.5px] text-ink-3 truncate">${esc(STATUS[p.status]?.label)} · ${esc(p.ticket ? `${p.ticket.id} · ${p.ticket.status}` : 'no ticket')}</span></span></button></li>`).join('')}</ul>`
    : `<div class="mt-3">${quietCard('fa-circle-check', 'Every light on this route works.')}</div>`}
    ${res.tickets.length ? `<p class="text-[12px] text-ink-3 mt-3">Open tickets: ${res.tickets.map((t) => `<button type="button" class="link mono" data-action="open-ticket" data-ticket="${esc(t.id)}">${esc(t.id)}</button> (${esc(t.priority)})`).join(', ')}</p>` : ''}`;
}

function printEvent() {
  const ev = state.event;
  if (!ev) return;
  const res = eventCheck(ev);
  const route = [ev.roads.join(', '), ev.line ? 'drawn route' : ''].filter(Boolean).join(' + ');
  const rows = res.notWorking.map((p) => `<tr><td>${esc(p.uid)}</td><td>${esc(p.location)}</td><td>${esc(STATUS[p.status]?.label)}</td><td>${esc(p.ticket?.id ?? '–')}</td><td>${esc(p.ticket?.status ?? '')}</td></tr>`).join('');
  printSheet(`<div class="print-report"><h1>Event check · ${esc(route)}</h1>
    <p>${esc(fmtDateTime(now()))} · ${res.poles.length} poles on the route · ${res.notWorking.length} not working · ${res.tickets.length} open tickets · mock data</p>
    <table><thead><tr><th>Pole</th><th>Location</th><th>Status</th><th>Ticket</th><th>Ticket status</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Every light on this route works.</td></tr>'}</tbody></table></div>`);
}

// Drawing a route: clicks add points, Finish (or Enter) ends it, Esc cancels.
function startDrawing() {
  state.drawing = { points: [] };
  map.doubleClickZoom.disable();
  map.getContainer().classList.add('is-drawing');
  layers.eventRoute.clearLayers();
  renderDrawChip();
  renderMapChip();
}
function addDrawPoint(latlng) {
  state.drawing.points.push(latlng);
  layers.eventRoute.clearLayers();
  L.polyline(state.drawing.points, { pane: 'overlayLinePane', interactive: false, color: TOKEN.accentHi, weight: 3, dashArray: '6 6', opacity: 0.95 }).addTo(layers.eventRoute);
  for (const ll of state.drawing.points) L.circleMarker(ll, { pane: 'selectionPane', interactive: false, radius: 3.5, color: TOKEN.accentHi, fillColor: TOKEN.accentHi, fillOpacity: 1, weight: 1 }).addTo(layers.eventRoute);
  renderDrawChip();
}
function finishDrawing() {
  const pts = state.drawing?.points ?? [];
  if (pts.length >= 2) state.event.line = pts;
  stopDrawing();
  renderSelected({ keepScroll: true });
}
function stopDrawing() {
  state.drawing = null;
  map.doubleClickZoom.enable();
  map.getContainer().classList.remove('is-drawing');
  $('#draw-chip').hidden = true;
  syncViewLayers();
  renderMapChip();
}
function renderDrawChip() {
  const chip = $('#draw-chip');
  const n = state.drawing?.points.length ?? 0;
  chip.hidden = !state.drawing;
  chip.innerHTML = `<i class="fa-solid fa-pen tone-accent" aria-hidden="true"></i>
    <span>${n ? `${plural(n, 'point')}. Keep clicking along the route.` : 'Click along the route.'}</span>
    <button type="button" class="btn btn-primary btn-sm" data-action="draw-finish" ${n >= 2 ? '' : 'disabled'}>Finish</button>
    <kbd>Esc</kbd>`;
}

function renderEventLayer() {
  if (state.drawing) return;
  layers.eventRoute.clearLayers();
  if (state.selected?.type !== 'event' || !state.event?.line) return;
  L.polyline(state.event.line, { pane: 'overlayLinePane', interactive: false, color: TOKEN.accentHi, weight: 3, dashArray: '6 6', opacity: 0.9 }).addTo(layers.eventRoute);
}

// ---- 15.8 Layers that belong to a sidebar view follow the selection ----------------------------
function syncRoleLayers() {
  renderRouteLayer();
  renderEventLayer();
}
