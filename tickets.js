/* ==========================================================================
 * Street Light GIS · tickets.js
 * Section 9: ticket model (routing, priority, SLA, escalation, audit trail)
 * Section 10: workflow (dispatch, close, dusk check, reopen, split)
 * Section 11: reporting (report mode, form, duplicate merging, shutdown holds, report pins)
 * ========================================================================== */
'use strict';

// ========================================================================
// 9. Ticket model
// ========================================================================
const CATEGORY = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c.id, c]));
const ROLE_LABEL = Object.fromEntries([...ROLES.map((r) => [r.id, r.label]), ['system', 'System']]);
const round1 = (v) => Math.round(v * 10) / 10;

/** Audit trail (E6): who did what, when, and the value before and after. */
function logActivity(action, { ticket = null, uids = ticket?.pole_uids ?? [], from = null, to = null, role = state.role, at = now() } = {}) {
  state.activity.push({
    at: new Date(at).toISOString(), role: ROLE_LABEL[role] ?? role, action,
    ticket: ticket?.id ?? null, uids: [...uids, ...(ticket?.near_uid ? [ticket.near_uid] : [])], from, to,
  });
}

function noteTicketId(id) {
  const m = /^TKT-(\d{4})-(\d+)$/.exec(id ?? '');
  if (m) state.ticketSeq[m[1]] = Math.max(state.ticketSeq[m[1]] ?? 0, Number(m[2]));
}
function nextTicketId() {
  const year = fmtYear(now());
  state.ticketSeq[year] = (state.ticketSeq[year] ?? 100) + 1;
  return `TKT-${year}-${String(state.ticketSeq[year]).padStart(4, '0')}`;
}
const nextReportId = () => `CR-${String(state.reports.filter((r) => !r.simulated).length + 1).padStart(3, '0')}`;

/** Who a ticket goes to: safety and trees first, then circuit faults, then the pole's contractor (or the survey team). */
function routeTeam(t) {
  const team = CATEGORY[t.category]?.team ?? 'survey';
  if (team === 'emergency' || team === 'horticulture') return team;
  if (t.circuit) return 'cable';
  if (t.kind === 'location' && !t.near_uid) return 'survey';
  return team;
}

function prepareTicket(t, kind) {
  t.kind = kind;                        // 'pole' (on mapped poles) | 'location' (a spot with no mapped pole)
  t.category ??= 'other';
  t.complaints ??= 0;                   // reports merged into this ticket (citizen app, call centre, night audit)
  t.reports ??= [];                     // ids of the session reports behind it (they can be split out again)
  t.pole_uids ??= [];
  t.team = routeTeam(t);
  return t;
}

/** Index the live tickets: share one object between the poles of an outage, add location tickets and sample reports. */
function indexTickets() {
  for (const f of state.features) {
    const p = f.properties;
    p.repair_history ??= [];
    if (p.ticket) {
      const shared = state.tickets.get(p.ticket.id);
      if (shared) {
        p.ticket = shared;
      } else {
        p.ticket.pole_uids ??= [p.uid];
        state.tickets.set(p.ticket.id, prepareTicket(p.ticket, 'pole'));
      }
    }
    for (const t of [p.ticket, ...p.repair_history]) noteTicketId(t?.id ?? t?.ticket_id);
  }
  for (const f of DATA.locationTickets?.features ?? []) {
    const t = prepareTicket({ ...f.properties }, 'location');
    t.latlng = toLatLng(f);
    state.tickets.set(t.id, t);
    noteTicketId(t.id);
  }
  // Two earlier reports from "this citizen", so My reports and "Fixed? Yes / No" can be shown (simulated).
  for (const s of DATA.citizenSamples ?? []) {
    const report = {
      id: s.id, category: s.category, uid: s.uid, latlng: state.byUid.get(s.uid)?.latlng ?? null, note: '', source: 'Citizen app',
      created_at: s.created_at, ticket_id: s.ticket_id, mine: true, simulated: true,
    };
    if (!state.tickets.has(s.ticket_id)) {
      const h = props(s.uid)?.repair_history.find((x) => x.ticket_id === s.ticket_id);
      if (h) report.resolved_at = h.verified_at ?? h.resolved_at;
    }
    state.tickets.get(s.ticket_id)?.reports.push(report.id);
    state.reports.push(report);
  }
}

const ticketPoles = (t) => t.pole_uids.map(props).filter(Boolean);
const ticketLatLng = (t) => t.latlng ?? state.byUid.get(t.pole_uids[0])?.latlng ?? null;
const ticketContractor = (t) => props(t.pole_uids[0] ?? t.near_uid)?.contractor ?? null;
const darkens = (t) => Boolean(t.circuit) || Boolean(CATEGORY[t.category]?.darkens);
const isEmergency = (t) => t.team === 'emergency';
const assigneeOf = (t) => (t.team === 'lamp' ? ticketContractor(t)?.name ?? TEAMS.lamp.label : TEAMS[t.team]?.label ?? t.team);
function crewsFor(t) {
  if (t.team === 'lamp') return META.contractors?.[ticketContractor(t)?.id]?.crews ?? [];
  return META.team_crews?.[t.team] ?? [];
}
const ticketSeverity = (t) => (t.circuit ? CIRCUIT_SEVERITY[t.circuit.kind] : CATEGORY[t.category]?.severity ?? 0);
/** The more critical of the landmarks near the ticket's poles (or its spot). */
function ticketCriticality(t) {
  const options = t.pole_uids.length ? t.pole_uids.map(poleCriticality) : ticketLatLng(t) ? [criticalityAt(ticketLatLng(t))] : [];
  return options.sort((a, b) => b.score - a.score)[0] ?? { level: null, score: 0, reason: null };
}
const ticketUnlitM = (t) => Math.max(0, ...t.pole_uids.map((uid) => darkRunByUid.get(uid)?.unlitM ?? 0));

/**
 * Priority (C3) = category severity + landmark criticality + extra reports (capped) + unlit stretch.
 * SLA = the team's base hours (the contractor's for lamp jobs), cut by the named modifiers.
 * Escalation (C4) = how many SLAs have passed since the ticket was raised.
 */
function rateTicket(t) {
  const crit = ticketCriticality(t);
  const runM = ticketUnlitM(t);
  const reports = Math.max(1, t.complaints ?? 0);
  const factors = [t.circuit ? `${t.circuit.kind} fault` : lowerFirst(catLabel(t.category, false))];
  let score = ticketSeverity(t);
  if (crit.level) {
    score += CRITICALITY_BONUS[crit.level];
    factors.push(lowerFirst(crit.reason));
  }
  const extra = Math.min(REPORT_BONUS_CAP, reports - 1);
  if (extra > 0) {
    score += extra * REPORT_BONUS;
    factors.push(`${reports} reports`);
  }
  const runBonus = DARK_RUN_BONUS.find(([m]) => runM >= m);
  if (runBonus) {
    score += runBonus[1];
    factors.push(`${nf0.format(roundTo(runM, 5))} m unlit`);
  }
  t.score = score;
  t.priority = PRIORITY_THRESHOLDS.find(([, min]) => score >= min)?.[0] ?? 'Low';
  t.why = factors.join(' · ');

  if (isEmergency(t)) {
    t.sla_hours = EMERGENCY_SLA_HOURS;
    t.sla_why = 'emergency target';
  } else {
    const base = t.team === 'lamp' ? ticketContractor(t)?.sla_hours ?? SLA_BASE_HOURS.survey : SLA_BASE_HOURS[t.team] ?? SLA_BASE_HOURS.survey;
    const mods = [];
    if (crit.level === 'High') mods.push(SLA_MODIFIERS.highCriticality);
    else if (crit.level === 'Medium') mods.push(SLA_MODIFIERS.mediumCriticality);
    if (runM >= LONG_DARK_RUN_M) mods.push(SLA_MODIFIERS.longDarkRun);
    if (reports >= MANY_REPORTS) mods.push(SLA_MODIFIERS.manyReports);
    t.sla_hours = Math.max(SLA_MIN_HOURS, Math.round(base * mods.reduce((k, m) => k * m.factor, 1)));
    t.sla_why = `${base} h ${t.team === 'lamp' ? 'contractor SLA' : 'team target'}${mods.length ? `, ${mods.map((m) => m.label).join(', ')}` : ''}`;
  }
  t.sla_due = new Date(new Date(t.raised_at).getTime() + t.sla_hours * 3.6e6).toISOString();

  const end = t.status === 'Awaiting dusk check' && t.closed_at ? new Date(t.closed_at) : now();
  const ratio = hoursBetween(t.raised_at, end) / t.sla_hours;
  const reached = ESCALATION.reduce((best, e, i) => (ratio >= e.at ? i : best), 0);
  t.escalationIndex = Math.max(reached, t.escalationIndex ?? 0); // never steps back down
  t.escalation = ESCALATION[t.escalationIndex];
}

/** Re-rate every open ticket; record each escalation step in the audit trail. Returns true if any ticket escalated. */
function rateAllTickets({ initial = false } = {}) {
  let escalated = false;
  for (const t of state.tickets.values()) {
    const before = initial ? 0 : t.escalationIndex ?? 0;
    rateTicket(t);
    for (let i = before + 1; i <= t.escalationIndex; i++) {
      const e = ESCALATION[i];
      const at = initial ? new Date(new Date(t.raised_at).getTime() + e.at * t.sla_hours * 3.6e6) : now();
      logActivity(`Escalated to ${e.level} (${e.title})`, { ticket: t, from: ESCALATION[i - 1].level, to: e.level, role: 'system', at });
      escalated = true;
    }
  }
  return escalated;
}

/** Queue order (C5): emergencies pinned on top, then priority, then the earliest SLA deadline. */
function ticketOrder(a, b) {
  return Number(isEmergency(b)) - Number(isEmergency(a))
    || PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
    || new Date(a.sla_due) - new Date(b.sla_due);
}
const openTickets = () => [...state.tickets.values()].sort(ticketOrder);
const isBreached = (t) => t.status !== 'Awaiting dusk check' && new Date(t.sla_due) < now();

/** Lamp jobs (D1): the spares a crew should carry, built from the poles' fixtures. Null for other jobs. */
function sparesLine(t) {
  if (t.team !== 'lamp' || !LAMP_CATEGORIES.includes(t.category) || NOT_A_LAMP_JOB.test(t.issue ?? '')) return null;
  const items = mostCommonAll(ticketPoles(t).map((p) => SPARES[p.fixture_type]?.(p)).filter(Boolean));
  return items.length ? `Carry: ${items.map(([item, n]) => (n > 1 ? `${n} × ${item}` : item)).join('; ')}` : null;
}
const mostCommonAll = (values) => [...groupBy(values, (v) => v)].map(([v, list]) => [v, list.length]).sort((a, b) => b[1] - a[1]);

/** End of the fixture's supplier warranty (example periods in the data): install date + warranty years, IST midnight. */
function warrantyEnd(p) {
  if (!p.fixture_installed || !p.fixture_warranty_years) return null;
  const [y, m, d] = p.fixture_installed.split('-').map(Number);
  return new Date(Date.UTC(y + p.fixture_warranty_years, m - 1, d) - 5.5 * 3.6e6);
}
const underWarranty = (p, at = now()) => {
  const end = warrantyEnd(p);
  return Boolean(end) && at < end;
};
const ticketWarranty = (t) => t.team === 'lamp' && !EXTERNAL_CAUSE.test(t.issue ?? '') && !NOT_A_LAMP_JOB.test(t.issue ?? '')
  && ticketPoles(t).some((p) => underWarranty(p));

// ========================================================================
// 10. Workflow: dispatch -> close -> dusk check -> closed (or reopened)
// ========================================================================
function setPoleStatus(p, status, t, opts = {}) {
  if (p.status === status) return;
  logActivity(`Pole status changed (${t ? t.id : 'no ticket'})`, { ticket: t, uids: [p.uid], from: p.status, to: status, ...opts });
  p.status = status;
}

function newTicket({ kind, category, source, uids = [], latlng = null, note = '', nearUid = null, issue = null, circuit = null, at = now(), role = state.role, loggedAt = at }) {
  const t = prepareTicket({
    id: nextTicketId(), status: 'Open', category, issue: issue ?? catLabel(category, false), source,
    raised_at: at.toISOString(), assigned_crew: null, work_started_at: null, closed_at: null, resolution: null,
    complaints: 0, notes: note ? `${source}: “${note}”` : null, pole_uids: [...uids], reports: [], near_uid: nearUid, circuit,
  }, kind);
  if (latlng) t.latlng = latlng;
  state.tickets.set(t.id, t);
  logActivity(`Ticket raised · ${source}`, { ticket: t, to: 'Open', at: loggedAt, role });
  return t;
}

function dispatchTicket(id, crew) {
  const t = state.tickets.get(id);
  if (!t || t.status !== 'Open' || !crew) return;
  t.status = 'In Progress';
  t.assigned_crew = crew;
  t.work_started_at = now().toISOString();
  logActivity(`Dispatched ${crew}`, { ticket: t, from: 'Open', to: 'In Progress' });
  if (darkens(t)) for (const p of ticketPoles(t)) setPoleStatus(p, 'Under Maintenance', t);
  afterDataChange();
  const n = t.pole_uids.length;
  toast({ tone: 'info', icon: 'fa-truck-fast', title: `${crew} dispatched`, body: `${t.id}: ${n && darkens(t) ? `${plural(n, 'pole')} now under maintenance.` : 'crew on the way.'}` });
}

/** The crew's closure starts the dusk check; the ticket only closes for good once the lamp is seen lit after sunset (D3). */
function closeTicket(id, resolution) {
  const t = state.tickets.get(id);
  if (!t || t.status !== 'In Progress' || !resolution) return;
  t.status = 'Awaiting dusk check';
  t.closed_at = now().toISOString();
  t.resolution = resolution;
  logActivity(`Work done: ${resolution}`, { ticket: t, from: 'In Progress', to: 'Awaiting dusk check' });
  processDuskChecks();
  afterDataChange();
  const check = duskCheckFor(t);
  toast({
    tone: 'ok', icon: 'fa-moon', title: `${t.id}: awaiting dusk check`,
    body: check.ccms ? `The CCMS node confirms the lamp after ${fmtTime(check.confirmAt)}.` : `Add a photo of the lit lamp after ${fmtTime(check.photoFrom)}.`,
  });
}

/** How the repair is confirmed: CCMS poles report the lamp on after dark; the rest need a night photo. */
function duskCheckFor(t) {
  const poles = ticketPoles(t);
  const ccms = poles.length > 0 && poles.every((p) => p.ccms_node);
  const dusk = nextDusk(t.closed_at ? new Date(t.closed_at) : now());
  const confirmAt = new Date(dusk.getTime() + CCMS_CONFIRM_DELAY_MIN * 6e4);
  const photoFrom = now() >= dusk ? nextDusk(now()) : dusk; // the next dark moment after the repair
  return { ccms, dusk, confirmAt, photoFrom, photoNow: now() >= dusk && isDark(now()) };
}

/** Simulated CCMS feed: confirm every repaired CCMS lamp once it has been dark long enough. */
function processDuskChecks() {
  let changed = false;
  for (const t of [...state.tickets.values()]) {
    if (t.status !== 'Awaiting dusk check') continue;
    const check = duskCheckFor(t);
    if (check.ccms && now() >= check.confirmAt) {
      finishTicket(t, 'CCMS', check.confirmAt);
      changed = true;
    }
  }
  return changed;
}

/** Night photo for a non-CCMS repair (kept in memory only). */
function attachDuskPhoto(id, file) {
  const t = state.tickets.get(id);
  if (!t || t.status !== 'Awaiting dusk check' || !file) return;
  if (!file.type.startsWith('image/')) {
    toast({ tone: 'warn', icon: 'fa-triangle-exclamation', title: 'Not a photo', body: 'Choose an image file.' });
    return;
  }
  if (!duskCheckFor(t).photoNow) {
    toast({ tone: 'warn', icon: 'fa-sun', title: 'Too early', body: `Take the photo after ${fmtTime(duskCheckFor(t).photoFrom)}, when the lamp should be on.` });
    return;
  }
  if (t.dusk_photo?.url) URL.revokeObjectURL(t.dusk_photo.url);
  t.dusk_photo = { url: URL.createObjectURL(file), name: file.name, at: now().toISOString() };
  logActivity('Night photo added', { ticket: t });
  renderSelected({ keepScroll: true });
}

function confirmDuskPhoto(id) {
  const t = state.tickets.get(id);
  if (!t?.dusk_photo) return;
  finishTicket(t, 'Night photo');
  afterDataChange();
  toast({ tone: 'ok', icon: 'fa-circle-check', title: `${t.id} closed`, body: `Lamp confirmed lit at ${fmtTime(t.dusk_photo.at)}. Repair logged.` });
}

/** Final closure: log the repair on every pole, light them up, tell the reporters (simulated). */
function finishTicket(t, by, at = now()) {
  const verifiedAt = new Date(at).toISOString();
  const downtime = Math.max(0, hoursBetween(t.raised_at, t.closed_at ?? verifiedAt));
  for (const p of ticketPoles(t)) {
    p.repair_history.unshift({
      ticket_id: t.id, type: 'Corrective', issue: t.issue, action: t.resolution ?? 'Repaired', source: t.source, priority: t.priority,
      raised_at: t.raised_at, resolved_at: t.closed_at ?? verifiedAt, downtime_h: round1(downtime), sla_met: downtime <= t.sla_hours,
      crew: t.assigned_crew, contractor: t.team === 'lamp' ? p.contractor?.name ?? null : TEAMS[t.team]?.label ?? null,
      cost_inr: null, status: 'Closed', verified_at: verifiedAt, verified_by: by,
    });
    if (p.ticket === t) p.ticket = null;
    setPoleStatus(p, 'Functional', t, { role: by === 'CCMS' ? 'system' : state.role, at });
    p.last_inspected = istDateKey(at);
  }
  t.status = 'Closed';
  t.verified_at = verifiedAt;
  t.verified_by = by;
  state.tickets.delete(t.id);
  state.closed.set(t.id, t);
  for (const r of state.reports) if (r.ticket_id === t.id) r.resolved_at = verifiedAt;
  logActivity(`Dusk check passed (${by}) · closed`, { ticket: t, from: 'Awaiting dusk check', to: 'Closed', role: by === 'CCMS' ? 'system' : state.role, at });
}

/** A ticket closed earlier in the data (not in this session), rebuilt from its repair record so it can be reopened. */
function ticketFromHistory(id, report) {
  const p = props(report?.uid);
  const h = p?.repair_history.find((x) => x.ticket_id === id);
  if (!h) return null;
  return prepareTicket({
    id, status: 'Closed', category: report.category, issue: h.issue, source: h.source, raised_at: h.raised_at,
    assigned_crew: h.crew, work_started_at: null, closed_at: h.resolved_at, resolution: h.action,
    complaints: 1, notes: null, pole_uids: [p.uid], reports: [report.id],
  }, 'pole');
}

/** Reopen a closed (or awaiting) ticket: same ID, history kept, fresh SLA clock. */
function reopenTicket(id, reason, { report = null } = {}) {
  const t = state.tickets.get(id) ?? state.closed.get(id) ?? ticketFromHistory(id, report);
  if (!t) return null;
  const busy = ticketPoles(t).map((p) => p.ticket).find((other) => other && other !== t);
  if (busy) return busy; // the pole already has a newer open ticket: the report joins that one instead
  const was = t.status;
  if (t.dusk_photo?.url) URL.revokeObjectURL(t.dusk_photo.url);
  Object.assign(t, {
    status: 'Open', first_raised_at: t.first_raised_at ?? t.raised_at, raised_at: now().toISOString(), reopened_at: now().toISOString(),
    assigned_crew: null, work_started_at: null, closed_at: null, resolution: null, verified_at: null, verified_by: null,
    escalationIndex: 0, escalation: ESCALATION[0], dusk_photo: null,
  });
  state.closed.delete(t.id);
  state.tickets.set(t.id, t);
  for (const p of ticketPoles(t)) {
    p.ticket = t;
    if (darkens(t)) setPoleStatus(p, 'Faulty', t);
    const h = p.repair_history.find((x) => x.ticket_id === t.id);
    if (h) h.reopened_at = t.reopened_at;
  }
  logActivity(`Reopened: ${reason}`, { ticket: t, from: was, to: 'Open' });
  return t;
}

/** Operator: a report was merged into the wrong ticket; give it a ticket of its own (B3). */
function splitReport(reportId) {
  const r = state.reports.find((x) => x.id === reportId);
  const from = state.tickets.get(r?.ticket_id);
  if (!r || !from || from.complaints < 2) return;
  from.reports = from.reports.filter((id) => id !== r.id);
  from.complaints = Math.max(1, from.complaints - 1);
  const t = newTicket({
    kind: 'location', category: r.category, source: r.source, latlng: r.latlng ?? ticketLatLng(from),
    note: r.note, nearUid: r.uid, issue: `${catLabel(r.category, false)} (split from ${from.id})`,
  });
  t.reports = [r.id];
  t.complaints = 1;
  r.ticket_id = t.id;
  logActivity(`Report ${r.id} split out`, { ticket: from, from: from.id, to: t.id });
  afterDataChange();
  toast({ tone: 'info', icon: 'fa-code-branch', title: `${r.id} split out`, body: `New ticket ${t.id}; ${from.id} keeps ${plural(from.complaints, 'report')}.` });
}

/** Everything that depends on pole status or tickets, after any change. */
function afterDataChange() {
  refreshDarkRuns();
  collapseCircuitFaults();
  rateAllTickets();
  refreshPoles();
  if (state.analysis.heatmap) {
    refreshHeat();
    renderDarkSpots();
  }
  styleNetwork();
  renderReportPins();
  renderRoleBlock();
  renderLegend();
  renderInsights();
  renderMapChip();
  renderSelected({ keepScroll: true });
}

/**
 * Circuit-level faults (C1): when a circuit section is dark, the cause is the cable or the panel,
 * not the lamps. The open tickets on those poles collapse into one electrical ticket for the cable &
 * panel team (a single ticket that already covers exactly those poles is re-routed instead). Jobs
 * already in progress, or awaiting their dusk check, are left as they are.
 */
function collapseCircuitFaults() {
  for (const [panelId, circuits] of panelPoles) {
    for (const circuit of circuits.keys()) {
      const fault = circuitFault(panelId, circuit);
      if (!fault) continue;
      const poles = fault.uids.map(props).filter((p) => !p.ticket || p.ticket.status === 'Open');
      const tickets = [...new Set(poles.map((p) => p.ticket).filter(Boolean))];
      if (!poles.length || (tickets.length === 1 && tickets[0].circuit && poles.every((p) => p.ticket === tickets[0]))) continue;
      const describe = { kind: fault.kind, panelId, circuit, afterUid: fault.afterUid, short: fault.short, text: fault.text };
      let target = tickets.find((t) => t.circuit?.panelId === panelId && t.circuit.circuit === circuit) ?? null;
      if (!target && tickets.length === 1 && tickets[0].pole_uids.every((u) => fault.uids.includes(u))) {
        target = tickets[0]; // one ticket already covers this dark section: send it to the right team
        const from = assigneeOf(target);
        target.circuit = describe;
        target.team = routeTeam(target);
        logActivity(`Re-routed: ${fault.short}`, { ticket: target, from, to: assigneeOf(target), role: 'system' });
      }
      if (!target) {
        const first = tickets.reduce((a, b) => (a && new Date(a.raised_at) <= new Date(b.raised_at) ? a : b), null);
        const category = tickets.map((t) => t.category).sort((a, b) => (CATEGORY[b]?.severity ?? 0) - (CATEGORY[a]?.severity ?? 0))[0] ?? 'not_working';
        target = newTicket({ // dated from the first report, so the SLA clock does not restart
          kind: 'pole', category, source: 'Circuit analysis', issue: fault.short, circuit: describe, role: 'system',
          at: first ? new Date(first.raised_at) : now(), loggedAt: now(),
        });
      }
      target.circuit = describe;
      target.team = routeTeam(target);
      for (const old of tickets) if (old !== target) mergeTicketInto(old, target, fault.short);
      for (const p of poles) {
        p.ticket = target;
        if (!target.pole_uids.includes(p.uid)) target.pole_uids.push(p.uid);
      }
    }
  }
}

/** Fold one open ticket into another: reports, notes and the earliest start move across; the old ID points to the new one. */
function mergeTicketInto(old, target, reason) {
  target.complaints = (target.complaints ?? 0) + (old.complaints ?? 0);
  target.reports.push(...old.reports);
  target.merged_from = [...(target.merged_from ?? []), old.id];
  if (old.notes) target.notes = [target.notes, old.notes].filter(Boolean).join(' ');
  if (new Date(old.raised_at) < new Date(target.raised_at)) target.raised_at = old.raised_at; // the outage began with the earliest report
  old.status = 'Merged';
  old.merged_into = target.id;
  state.tickets.delete(old.id);
  state.closed.set(old.id, old);
  for (const r of state.reports) if (r.ticket_id === old.id) r.ticket_id = target.id;
  logActivity(`Merged into ${target.id}: ${reason}`, { ticket: old, from: 'Open', to: 'Merged', role: 'system' });
}

// ========================================================================
// 11. Reporting: report mode -> snap -> form -> ticket (or merge, or log)
// ========================================================================
const reportBtn = $('#report-btn');
const modal = $('#report-modal');
const form = $('#report-form');
let lastFocus = null;
let photoUrl = null;

/** The planned shutdown covering this pole (or this spot, for a report with no pole), if any (C2). */
function shutdownAt(uid, latlng, t = now()) {
  if (uid) return shutdownOf(props(uid), t);
  for (const rec of state.byUid.values()) {
    const hold = rec.latlng.distanceTo(latlng) <= SHUTDOWN_AREA_M ? shutdownOf(rec.feature.properties, t) : null;
    if (hold) return hold;
  }
  return null;
}

/** An open location ticket close enough and recent enough to be the same problem (B3). */
function nearbyLocationTicket(latlng, at = now()) {
  return [...state.tickets.values()]
    .filter((t) => t.kind === 'location' && t.latlng && hoursBetween(t.raised_at, at) <= DUPLICATE_WINDOW_HOURS)
    .map((t) => ({ t, d: t.latlng.distanceTo(latlng) }))
    .filter((x) => x.d <= DUPLICATE_RADIUS_M)
    .sort((a, b) => a.d - b.d)[0]?.t ?? null;
}

/**
 * File one report from any source. Returns { report, ticket, outcome } where outcome is
 *   'logged' (planned shutdown: no dispatch), 'merged' (+1 report on an open ticket),
 *   'reopened' (the repaired lamp is still out) or 'new'.
 */
function fileReport({ category, uid = null, latlng, note = '', photo = null, name = '', phone = '', source, role = state.role }) {
  const cat = CATEGORY[category] ?? CATEGORY.other;
  const at = now();
  const report = {
    id: nextReportId(), category: cat.id, uid, latlng, note, photo, name, phone, source,
    created_at: at.toISOString(), mine: role === 'citizen', ticket_id: null,
  };
  state.reports.push(report);
  const hold = SHUTDOWN_HOLDS.includes(cat.id) ? shutdownAt(uid, latlng, at) : null;
  if (hold) {
    report.held_until = hold.end.toISOString();
    logActivity(`Report ${report.id} logged, not dispatched: planned shutdown until ${fmtTime(hold.end)}`, { uids: uid ? [uid] : [], role });
    return { report, ticket: null, outcome: 'logged', hold };
  }
  const p = uid ? props(uid) : null;
  let ticket = p ? p.ticket : nearbyLocationTicket(latlng, at);
  let outcome = 'new';
  if (ticket && ticket.status === 'Awaiting dusk check' && cat.darkens) {
    ticket = reopenTicket(ticket.id, `${source} report ${report.id}: still not working`) ?? ticket;
    outcome = 'reopened';
  } else if (ticket) {
    outcome = 'merged';
  }
  if (ticket) {
    ticket.complaints = (ticket.complaints ?? 0) + 1;
    ticket.reports.push(report.id);
    if (note) ticket.notes = [ticket.notes, `${source}: “${note}”`].filter(Boolean).join(' ');
    logActivity(`+1 report (${report.id}, ${source})`, { ticket, from: String(ticket.complaints - 1), to: String(ticket.complaints), role });
    if (cat.severity > ticketSeverity(ticket) && !ticket.circuit) { // a more serious report upgrades the ticket
      const from = ticket.category;
      ticket.category = cat.id;
      ticket.team = routeTeam(ticket);
      logActivity('Category raised by a report', { ticket, from: catLabel(from, false), to: catLabel(cat.id, false), role });
    }
    if (cat.darkens && p && p.status === 'Functional') setPoleStatus(p, 'Faulty', ticket, { role });
  } else {
    ticket = newTicket({ kind: p ? 'pole' : 'location', category: cat.id, source, uids: p ? [p.uid] : [], latlng: p ? null : latlng, note, at, role });
    ticket.complaints = 1;
    ticket.reports = [report.id];
    if (p) {
      p.ticket = ticket;
      if (cat.darkens && p.status === 'Functional') setPoleStatus(p, 'Faulty', ticket, { role });
    }
  }
  report.ticket_id = ticket.id;
  return { report, ticket, outcome };
}

function setReportMode(on) {
  state.reportMode = on;
  document.body.classList.toggle('is-reporting', on);
  map.getContainer().classList.toggle('is-reporting', on); // crosshair cursor over the whole map
  $('#report-hint').hidden = !on;
  reportBtn.setAttribute('aria-pressed', String(on));
  reportBtn.querySelector('.fab-label').textContent = on ? tr('report_cancel') : tr('report_cta');
  reportBtn.querySelector('.fab-icon i').className = `fa-solid ${on ? 'fa-xmark' : 'fa-bullhorn'}`;
  if (!on) clearSnap();
  renderMapChip();
}

/** Open the report form for a clicked location, snapping to a pole when one is close enough. */
function beginReport(latlng, uid = null, presetCategory = null) {
  let rec = uid ? state.byUid.get(uid) : null;
  let distance = 0;
  if (!rec) {
    const hit = nearestPole(latlng, SNAP_RADIUS_M);
    if (hit) ({ rec, distance } = hit);
  }
  state.draft = { clickLatLng: latlng, latlng: rec ? rec.latlng : latlng, uid: rec?.uid ?? null, distance };
  clearSnap();
  layers.draftPin.setLatLng(state.draft.latlng).addTo(map);
  openReportModal(presetCategory);
}

function draftLocationHtml() {
  const d = state.draft;
  const hold = shutdownAt(d.uid, d.latlng);
  const holdHtml = hold ? `<div class="loc-note"><i class="fa-solid fa-power-off" aria-hidden="true"></i>${esc(tr('shutdown_until', { time: fmtTime(hold.end) }))} ${esc(tr('shutdown_logged'))}</div>` : '';
  if (d.uid) {
    const p = props(d.uid);
    const how = d.distance > 1 ? tr('loc_snapped', { m: Math.round(d.distance) }) : tr('loc_selected');
    const already = p.ticket && !hold ? ` ${tr('loc_already')}` : '';
    return `<div class="loc-card">${statusSymbol(p.status, 16)}<div class="min-w-0">
      <div class="mono text-[13px] font-semibold">${esc(p.uid)} <span class="font-sans font-normal text-ink-3">· ${esc(statusLabel(p.status))}</span></div>
      <div class="text-xs text-ink-2">${esc(p.location)}</div>
      <div class="text-[11.5px] text-ink-3 mt-1">${esc(how + already)}</div>${holdHtml}
    </div></div>`;
  }
  return `<div class="loc-card"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><div class="min-w-0">
    <div class="mono text-[13px] font-semibold">${fmtLatLngPlain(d.latlng)}</div>
    <div class="text-xs text-ink-2">${esc(tr('loc_none', { m: SNAP_RADIUS_M }))}</div>${holdHtml}
  </div></div>`;
}

function renderCategoryChips(selected = null) {
  $('#rm-issues').innerHTML = REPORT_CATEGORIES.map((c) => `<label class="issue-option${c.team === 'emergency' ? ' issue-option--danger' : ''}">
    <input type="radio" name="issue" value="${c.id}"${c.id === selected ? ' checked' : ''}><span><i class="fa-solid ${c.icon}" aria-hidden="true"></i>${esc(catLabel(c.id, true))}</span></label>`).join('');
  syncSafetyNote();
}
function syncSafetyNote() {
  const picked = form.querySelector('input[name="issue"]:checked')?.value;
  $('#rm-safety').hidden = CATEGORY[picked]?.team !== 'emergency';
}

function openReportModal(presetCategory) {
  lastFocus = document.activeElement;
  form.reset();
  clearPhoto();
  applyLanguage();
  $('#rm-issue-error').hidden = true;
  $('#rm-phone-error').hidden = true;
  $('#rm-count').textContent = '0/500';
  $('#rm-contact').open = false;
  $('#rm-location').innerHTML = draftLocationHtml();
  renderCategoryChips(presetCategory);
  modal.hidden = false;
  (form.querySelector('input[name="issue"]:checked') ?? form.querySelector('input[name="issue"]'))?.focus();
}

function closeReportModal({ restoreFocus = true } = {}) {
  modal.hidden = true;
  clearPhoto();
  map.removeLayer(layers.draftPin);
  state.draft = null;
  if (restoreFocus) lastFocus?.focus?.();
}

function clearPhoto() {
  if (photoUrl) URL.revokeObjectURL(photoUrl);
  photoUrl = null;
  const img = $('#rm-photo-preview');
  img.hidden = true;
  img.removeAttribute('src');
  $('#rm-photo-name').textContent = '';
}

/** Form submit: validate, file the report, update the map, say what happened. */
function submitReportForm() {
  const fd = new FormData(form);
  const category = String(fd.get('issue') ?? '');
  const phone = String(fd.get('phone') ?? '').replace(/[\s-]/g, '');
  const phoneOk = !phone || PHONE_PATTERN.test(phone);
  $('#rm-issue-error').hidden = Boolean(CATEGORY[category]);
  $('#rm-phone-error').hidden = phoneOk;
  if (!CATEGORY[category]) {
    form.querySelector('input[name="issue"]').focus();
    return;
  }
  if (!phoneOk) {
    $('#rm-contact').open = true;
    $('#rm-phone').focus();
    return;
  }
  const draft = state.draft;
  if (!draft) return;
  const citizen = isCitizen();
  const { report, ticket, outcome, hold } = fileReport({
    category, uid: draft.uid, latlng: draft.clickLatLng,
    note: String(fd.get('description') ?? '').trim(), name: String(fd.get('name') ?? '').trim(), phone,
    photo: $('#rm-photo').files?.[0]?.name ?? null, source: citizen ? 'Citizen app' : 'Call centre',
  });
  closeReportModal({ restoreFocus: false });
  setReportMode(false);
  afterDataChange();
  if (citizen) openMyReports();
  else if (draft.uid) selectPole(draft.uid);
  else if (ticket) openTicket(ticket.id);
  toast(reportToast(report, ticket, outcome, hold, citizen));
}

function reportToast(report, ticket, outcome, hold, citizen) {
  if (outcome === 'logged') {
    return { tone: 'info', icon: 'fa-power-off', title: citizen ? tr('toast_logged') : `${report.id} logged, not dispatched`, body: tr('shutdown_until', { time: fmtTime(hold.end) }) };
  }
  if (citizen) {
    return outcome === 'new'
      ? { tone: 'ok', icon: 'fa-circle-check', title: tr('toast_sent'), body: tr('toast_sent_body', { id: ticket.id }) }
      : { tone: 'info', icon: 'fa-link', title: tr('toast_merged'), body: tr('toast_merged_body', { n: ticket.complaints }) };
  }
  if (outcome === 'new') {
    return { tone: 'ok', icon: 'fa-circle-check', title: `Ticket ${ticket.id} raised`, body: `${catLabel(ticket.category, false)} → ${assigneeOf(ticket)} · ${ticket.priority} priority · due in ${fmtHours(ticket.sla_hours)}.` };
  }
  return { tone: 'info', icon: 'fa-link', title: `${outcome === 'reopened' ? 'Reopened' : 'Added to'} ${ticket.id}`, body: `${plural(ticket.complaints, 'report')} on this ticket now.` };
}

const reportIcon = (draft = false) => L.divIcon({
  className: `report-pin${draft ? ' is-draft' : ''}`,
  html: '<span class="pin"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i></span>',
  iconSize: [26, 26],
  iconAnchor: [13, 31],
  tooltipAnchor: [0, -28],
});

/**
 * Report pins: the Citizen view shows that citizen's own reports; staff views show every report
 * filed in this session plus the open tickets that have no mapped pole.
 */
function renderReportPins() {
  layers.reports.clearLayers();
  const citizen = isCitizen();
  const pins = [];
  const reports = state.reports.filter((r) => r.latlng && (citizen ? r.mine : !r.simulated));
  for (const r of reports) pins.push({ latlng: r.latlng, report: r, ticket: state.tickets.get(r.ticket_id) ?? null });
  if (!citizen) {
    const pinned = new Set(reports.map((r) => r.ticket_id));
    for (const t of state.tickets.values()) if (t.kind === 'location' && !pinned.has(t.id)) pins.push({ latlng: t.latlng, report: null, ticket: t });
  }
  for (const pin of pins) layers.reports.addLayer(reportMarker(pin, citizen));
  syncReportsLabel();
}

function reportMarker({ latlng, report, ticket }, citizen) {
  const m = L.marker(latlng, { icon: reportIcon(), keyboard: true });
  const title = citizen ? report?.id : ticket?.id ?? report?.id;
  const what = catLabel(report?.category ?? ticket?.category ?? 'other', citizen);
  m.bindTooltip(() => `<div class="tt-value">${esc(title)}</div>
    <div class="tt-row">${esc(what)} · ${esc(fmtDateTime(report?.created_at ?? ticket?.raised_at))}</div>
    <div class="tt-hint">${esc(report?.uid ?? (citizen ? tr('map_location') : 'No mapped pole'))}</div>`, { className: 'sl-tooltip', direction: 'top', opacity: 1 });
  m.on('click', (e) => {
    if (state.reportMode) return beginReport(e.latlng);
    if (citizen) return report?.uid ? selectPole(report.uid) : openMyReports();
    if (report?.uid && !ticket?.near_uid && ticket?.kind !== 'location') return selectPole(report.uid);
    if (ticket && state.tickets.has(ticket.id)) return openTicket(ticket.id);
    return report?.uid ? selectPole(report.uid) : undefined;
  });
  m.on('add', () => m.getElement()?.setAttribute('aria-label', `Report ${title}`));
  return m;
}
