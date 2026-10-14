/* ==========================================================================
 * Street Light GIS · tickets.js
 * Section 9: ticket model (routing, priority, SLA, escalation, audit trail); 9.1 report confidence evidence
 * Section 10: workflow (dispatch, close, dusk check, reopen, split); 10.1 checks and on-site outcomes
 * Section 11: reporting (report mode, form, duplicate merging, shutdown holds, report pins); 11.1 public escalation
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
  // Simulated reporters and the citizen reports behind the tickets (photos, locations, when it was noticed).
  for (const r of DATA.reporters ?? []) state.reporters.set(r.id, { ...r });
  for (const s of DATA.citizenReports ?? []) {
    const report = {
      id: s.id, reporter_id: s.reporter_id, category: s.category, uid: s.uid,
      latlng: s.uid ? state.byUid.get(s.uid)?.latlng ?? null : toLatLng(s.spot),
      note: '', source: s.source, created_at: s.created_at, ticket_id: s.ticket_id, noticed: s.noticed,
      photo: s.photo ? { ...s.photo } : null,
      device: s.device_location ? { latlng: toLatLng(s.device_location.position), accuracy_m: s.device_location.accuracy_m } : null,
      mine: s.mine, simulated: true,
    };
    if (!state.tickets.has(s.ticket_id)) { // closed before this session: its repair is in the history
      const h = props(s.uid)?.repair_history.find((x) => x.ticket_id === s.ticket_id);
      if (h) {
        report.resolved_at = h.verified_at ?? h.resolved_at;
        report.outcome = h.outcome ?? 'confirmed';
      }
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
 * Priority (C3) = category severity + landmark criticality + extra reports (capped) + unlit stretch
 * + a small confidence adjustment. Being shared publicly never changes it.
 * SLA = the team's base hours (the contractor's for lamp jobs), cut by the named modifiers.
 * Escalation (C4) = how many SLAs have passed since the ticket was raised.
 */
function rateTicket(t) {
  t.confidence = ticketConfidence(t);
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
  score += CONFIDENCE_PRIORITY[t.confidence.band] ?? 0; // a small nudge; the band label shows it
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
    t.sla_why = `${base} h ${t.team === 'lamp' ? 'contractor SLA' : 'team target'}${mods.length ? ` · ${mods.map((m) => m.label).join(' · ')}` : ''}`;
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
/** A warranty claim only once the fault is likely: not while the report still needs checking. */
const ticketWarranty = (t) => t.team === 'lamp' && !EXTERNAL_CAUSE.test(t.issue ?? '') && !NOT_A_LAMP_JOB.test(t.issue ?? '')
  && t.confidence?.band !== 'Needs check' && ticketPoles(t).some((p) => underWarranty(p));

// ---- 9.1 Report confidence: the evidence confidence.js scores ------------------------
const BAND_RANK = { Confirmed: 3, Likely: 2, 'Needs check': 1 };
const SOURCE_TEXT = { 'CCMS auto-alert': 'a CCMS alert', 'Night patrol': 'the night patrol', 'Night audit': 'the night audit', 'Circuit analysis': 'circuit analysis' };
const reportById = (id) => state.reports.find((r) => r.id === id) ?? null;
const sessionReporterId = () => [...state.reporters.values()].find((r) => r.mine)?.id ?? 'RP-SESSION';

/** The last scheduled switch-on (sunset) at or before `at`. */
function lastSwitchOn(at = now()) {
  const key = istDateKey(at);
  const today = sunTimes(key).sunset;
  return today <= at ? today : sunTimes(addDays(key, -1)).sunset;
}
/** Simulated CCMS feed: a node reports its lamp on when the pole works and has supply. */
const simulatedCcmsState = (p) => (p.status === 'Functional' && !shutdownOf(p) ? 'on' : 'off');

/** What the pole's CCMS node says: a fresh poll (simulated), else its reading at the last switch-on. */
function ccmsEvidence(p, poll = null) {
  if (!p?.ccms_node) return null;
  if (poll) return { night: poll.state, daylight: poll.daylight, poll: true };
  const r = p.ccms_reading;
  if (r && Math.abs(new Date(r.switch_on_at) - lastSwitchOn()) < 3.6e6) return { night: r.state, daylight: r.daylight };
  return { night: simulatedCcmsState(p), daylight: 'off' }; // an evening after the data snapshot: simulated feed
}

/** On a detected circuit or cable fault, or next to a dark pole on the same circuit. */
function circuitEvidence(p) {
  if (circuitFault(p.feeder_panel, p.circuit)?.uids.includes(p.uid)) return 'fault';
  const uids = circuitUids(p.feeder_panel, p.circuit);
  const i = uids.indexOf(p.uid);
  return [uids[i - 1], uids[i + 1]].some((u) => u && isDarkStatus(props(u))) ? 'neighbour' : null;
}

const samePlace = (a, b) => (a.uid || b.uid ? a.uid === b.uid : Boolean(a.latlng && b.latlng) && a.latlng.distanceTo(b.latlng) <= DUPLICATE_RADIUS_M);

/** The earliest other report with a near-identical photo (perceptual hash), if any. */
function photoMatchFor(r) {
  if (!r.photo?.hash) return null;
  const when = (x) => [new Date(x.created_at).getTime(), state.reports.indexOf(x)];
  const [rt, ri] = when(r);
  const earlier = state.reports.filter((x) => {
    if (x === r || !x.photo?.hash || hashDistance(x.photo.hash, r.photo.hash) > PHOTO_MATCH_MAX_BITS) return false;
    const [xt, xi] = when(x);
    return xt < rt || (xt === rt && xi < ri);
  }).sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
  return earlier ? {
    reportId: earlier.id, samePole: samePlace(earlier, r), sameReporter: earlier.reporter_id === r.reporter_id,
    sameDay: istDateKey(earlier.created_at) === istDateKey(r.created_at),
  } : null;
}

/** Everything confidence.js needs about one report, read from the data model. */
function reportEvidence(r, t = state.tickets.get(r.ticket_id) ?? null) {
  const p = r.uid ? props(r.uid) : null;
  const target = p ? state.byUid.get(r.uid).latlng : r.latlng;
  const siblings = (t?.reports ?? [r.id]).map(reportById).filter((x) => x && !x.review);
  const reporters = new Set(siblings.filter((x) => Math.abs(hoursBetween(x.created_at, r.created_at)) <= DUPLICATE_WINDOW_HOURS).map((x) => x.reporter_id));
  const rep = state.reporters.get(r.reporter_id);
  return {
    category: r.category,
    field: t ? t.field_outcome ?? (r.source === 'Night audit' ? 'confirmed' : null) : r.outcome ?? null,
    ccms: p ? ccmsEvidence(p, t?.ccms_poll) : null,
    circuit: p ? circuitEvidence(p) : null,
    reporters: Math.max(1, reporters.size),
    track: rep ? { reports: rep.past_reports, confirmed: rep.past_confirmed } : null,
    photo: r.photo ? { live: r.photo.kind === 'live' } : null,
    photoMatch: photoMatchFor(r),
    location: r.device && target ? { accuracyM: r.device.accuracy_m, distanceM: r.device.latlng.distanceTo(target) } : null,
    timing: { noticed: r.noticed ?? null, darkAtReport: isDark(new Date(r.created_at)) },
    extra: photoCheck(r.photo, r.category, p),
  };
}

/**
 * A ticket's confidence: emergencies are never scored; a field check is final; tickets raised by CCMS,
 * patrols, audits or circuit analysis are confirmed; otherwise its best-supported citizen report decides.
 */
function ticketConfidence(t) {
  const plain = (ev) => ({ ...scoreReport(ev, CONFIDENCE), notes: [], count: 0 });
  if (isEmergency(t)) return plain({ category: CONFIDENCE.emergencyCategories[0] });
  if (t.field_outcome) return plain({ category: t.category, field: t.field_outcome });
  if (SYSTEM_SOURCES.includes(t.source)) {
    return { bypass: false, band: 'Confirmed', final: null, score: null, contradicted: false, notes: [], count: t.reports.length,
      signals: [{ key: 'source', effect: 1, points: 0, text: `Raised by ${SOURCE_TEXT[t.source]}` }] };
  }
  const reports = t.reports.map(reportById).filter((r) => r && !r.review);
  if (!reports.length) return plain({ category: t.category });
  const scored = reports.map((r) => ({ r, res: scoreReport(reportEvidence(r, t), CONFIDENCE) }))
    .sort((a, b) => (BAND_RANK[b.res.band] ?? 0) - (BAND_RANK[a.res.band] ?? 0) || (b.res.score ?? 0) - (a.res.score ?? 0));
  const notes = scored.slice(1).flatMap(({ r, res }) => res.signals.filter((s) => s.key === 'photo-match' && s.effect < 0).map((s) => `${r.id}: ${s.text}`));
  return { ...scored[0].res, basis: scored[0].r.id, count: reports.length, notes };
}

/** A crew already working within NEARBY_CREW_M of a spot, nearest first. */
function nearestCrew(latlng, except = null) {
  let best = null;
  for (const job of state.tickets.values()) {
    const at = job !== except && job.status === 'In Progress' && job.assigned_crew ? ticketLatLng(job) : null;
    const d = at ? at.distanceTo(latlng) : Infinity;
    if (d <= NEARBY_CREW_M && (!best || d < best.d)) best = { crew: job.assigned_crew, d };
  }
  return best;
}

/**
 * Needs check: the cheapest checks first, in order: a CCMS poll (simulated), the next night audit, a crew
 * already nearby. A dedicated dispatch is offered only when none of them can happen within NEEDS_CHECK_MAX_HOURS.
 */
function checkPlan(t) {
  const at = ticketLatLng(t);
  const dusk = nextDusk();
  const crew = at ? nearestCrew(at, t) : null;
  const lampState = [...CONFIDENCE.nightCategories, ...CONFIDENCE.dayCategories].includes(t.category); // what CCMS and audits can see
  const steps = [
    { key: 'ccms', available: lampState && ticketPoles(t).some((p) => p.ccms_node), done: Boolean(t.ccms_poll), label: 'Poll CCMS (simulated)',
      result: t.ccms_poll ? `lamp ${t.ccms_poll.state} at ${fmtTime(t.ccms_poll.at)}` : null },
    { key: 'audit', available: CONFIDENCE.nightCategories.includes(t.category) && t.pole_uids.length > 0 && hoursBetween(now(), dusk) <= NEEDS_CHECK_MAX_HOURS,
      done: t.check?.kind === 'audit', label: `Add to the night audit (${isDark() ? 'tonight' : `from ${fmtTime(dusk)}`})` },
    { key: 'crew', available: Boolean(crew), done: t.check?.kind === 'crew', crew: crew?.crew,
      label: crew ? `Ask ${crew.crew} (${Math.round(crew.d)} m away)` : 'Ask a crew nearby' },
  ];
  const waiting = t.check ? (t.check.kind === 'audit' ? 'Waiting for the night audit' : `Waiting for ${t.check.crew}`) : null;
  const next = waiting ? null : steps.find((s) => s.available && !s.done) ?? null;
  return { steps, next, waiting, dispatch: !waiting && !next };
}
const needsCheck = (t) => t.status === 'Open' && t.confidence?.band === 'Needs check';

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
  if (!t.field_outcome) recordOutcome(t, 'confirmed');
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
      ...(t.reported_uid ? { outcome: 'different_pole', reported_uid: t.reported_uid } : {}),
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
  if (t.field_outcome === 'no_fault') { // the reporter disagrees: their report is counted again once it is checked
    for (const r of t.reports.map(reportById)) {
      const rep = r?.outcome === 'no_fault' ? state.reporters.get(r.reporter_id) : null;
      if (rep) rep.past_reports -= 1;
      if (r?.outcome === 'no_fault') r.outcome = null;
    }
  }
  Object.assign(t, {
    status: 'Open', first_raised_at: t.first_raised_at ?? t.raised_at, raised_at: now().toISOString(), reopened_at: now().toISOString(),
    assigned_crew: null, work_started_at: null, closed_at: null, resolution: null, verified_at: null, verified_by: null,
    escalationIndex: 0, escalation: ESCALATION[0], dusk_photo: null, field_outcome: null, check: null, ccms_poll: null,
  });
  state.closed.delete(t.id);
  state.tickets.set(t.id, t);
  for (const p of ticketPoles(t)) p.ticket = t;
  const checkFirst = ticketConfidence(t).band === 'Needs check'; // e.g. CCMS shows the lamp on: check before darkening it
  for (const p of ticketPoles(t)) {
    if (darkens(t) && !checkFirst) setPoleStatus(p, 'Faulty', t);
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

// ---- 10.1 Checks and on-site outcomes (report confidence) -----------------------------
const OUTCOME_LABEL = { confirmed: 'Fault confirmed', no_fault: 'Working, no fault', obstruction: 'Obstruction', different_pole: 'Different pole' };

/** What the crew found on site. Every outcome updates the track record of the ticket's reporters. */
function recordOutcome(t, outcome) {
  if (t.field_outcome === outcome) return;
  t.field_outcome = outcome;
  for (const r of t.reports.map(reportById)) {
    if (!r || r.outcome) continue;
    r.outcome = outcome;
    const rep = state.reporters.get(r.reporter_id);
    if (rep) {
      rep.past_reports += 1;
      if (countsAsConfirmed(outcome)) rep.past_confirmed += 1;
    }
  }
  logActivity(`On site: ${OUTCOME_LABEL[outcome]}`, { ticket: t, to: OUTCOME_LABEL[outcome] });
}

/** Needs check, cheapest first: poll the pole's CCMS node (simulated). */
function pollCcms(id) {
  const t = state.tickets.get(id);
  const p = t && ticketPoles(t).find((x) => x.ccms_node);
  if (!p) return;
  t.ccms_poll = { at: now().toISOString(), state: simulatedCcmsState(p), daylight: 'off' };
  logActivity(`CCMS polled (simulated): lamp ${t.ccms_poll.state}`, { ticket: t, to: t.ccms_poll.state });
  afterDataChange();
  toast({ tone: 'info', icon: 'fa-tower-broadcast', title: `CCMS (simulated): lamp ${t.ccms_poll.state}`, body: needsCheck(t) ? 'Still needs a check.' : `Now ${t.confidence.band.toLowerCase()}.` });
}

/** Needs check: put the pole on the next night audit, or ask a crew already working nearby to look. */
function sendToCheck(id, kind) {
  const t = state.tickets.get(id);
  const step = t && checkPlan(t).steps.find((s) => s.key === kind && s.available && !s.done);
  if (!step) return;
  t.check = kind === 'audit' ? { kind, at: now().toISOString() } : { kind, crew: step.crew, at: now().toISOString() };
  if (kind === 'audit') addToAuditRoute(t.pole_uids);
  logActivity(kind === 'audit' ? 'Check: added to the night audit' : `Check: asked ${step.crew}`, { ticket: t });
  afterDataChange();
  toast({ tone: 'info', icon: kind === 'audit' ? 'fa-moon' : 'fa-person-walking', title: `${t.id}: check arranged`, body: kind === 'audit' ? 'On the night audit route.' : `In ${step.crew}'s work order.` });
}

/** A crew checking a report confirms the fault: it becomes their job. */
function takeCheckJob(id, crew) {
  const t = state.tickets.get(id);
  if (!t || t.status !== 'Open' || !crew) return;
  recordOutcome(t, 'confirmed');
  Object.assign(t, { check: null, status: 'In Progress', assigned_crew: crew, work_started_at: now().toISOString() });
  logActivity(`${crew} took the job`, { ticket: t, from: 'Open', to: 'In Progress' });
  if (darkens(t)) for (const p of ticketPoles(t)) setPoleStatus(p, 'Under Maintenance', t);
  afterDataChange();
}

/** The night audit saw the lamp dark: confirmed, still to be dispatched. */
function confirmFromAudit(t) {
  recordOutcome(t, 'confirmed');
  t.check = null;
  if (darkens(t)) for (const p of ticketPoles(t)) if (p.status === 'Functional') setPoleStatus(p, 'Faulty', t);
}

/** Working when checked: the ticket closes as "Not confirmed on site". No report is ever called wrong. */
function closeNoFault(id) {
  const t = state.tickets.get(id);
  if (!t) return;
  const was = t.status;
  const at = now().toISOString();
  recordOutcome(t, 'no_fault');
  for (const p of ticketPoles(t)) {
    p.repair_history.unshift({
      ticket_id: t.id, type: 'Check', issue: t.issue, action: 'Checked on site: working, no fault', source: t.source,
      priority: t.priority, raised_at: t.raised_at, resolved_at: at, downtime_h: null, crew: t.assigned_crew ?? t.check?.crew ?? null,
      contractor: null, cost_inr: null, status: 'Closed', outcome: 'no_fault',
    });
    if (p.ticket === t) p.ticket = null;
    setPoleStatus(p, 'Functional', t);
    p.last_inspected = istDateKey(at);
  }
  Object.assign(t, { status: 'Closed', closed_at: at, resolution: 'Not confirmed on site', check: null });
  state.tickets.delete(t.id);
  state.closed.set(t.id, t);
  for (const r of state.reports) if (r.ticket_id === t.id) r.resolved_at = at;
  logActivity('Closed: not confirmed on site', { ticket: t, from: was, to: 'Closed' });
  afterDataChange();
  toast({ tone: 'info', icon: 'fa-circle-check', title: `${t.id} closed`, body: 'Not confirmed on site.' });
}

/** The lamp works but a tree or hoarding blocks it: the ticket goes to horticulture / enforcement. */
function markObstruction(id) {
  const t = state.tickets.get(id);
  if (!t) return;
  recordOutcome(t, 'obstruction');
  const from = assigneeOf(t);
  Object.assign(t, { category: 'blocked', status: 'Open', assigned_crew: null, work_started_at: null, check: null, issue: 'Light blocked by a tree or hoarding (found on site)' });
  t.team = routeTeam(t);
  for (const p of ticketPoles(t)) setPoleStatus(p, 'Functional', t);
  logActivity('Re-routed: light blocked by a tree or hoarding', { ticket: t, from, to: assigneeOf(t) });
  afterDataChange();
  toast({ tone: 'info', icon: 'fa-tree', title: `${t.id} → ${assigneeOf(t)}`, body: 'The lamp works; the obstruction needs clearing.' });
}

/** The fault is on another pole: the ticket moves there (or joins that pole's open ticket). Confirmed for the reporter. */
function moveTicketToPole(id, uid) {
  const t = state.tickets.get(id);
  const to = props(uid);
  const from = t && t.pole_uids.length === 1 ? props(t.pole_uids[0]) : null;
  if (!from || !to || from === to) return false;
  recordOutcome(t, 'different_pole');
  t.reported_uid = from.uid;
  if (from.ticket === t) {
    from.ticket = null;
    setPoleStatus(from, 'Functional', t);
  }
  let target = t;
  if (to.ticket && to.ticket !== t) {
    target = to.ticket;
    mergeTicketInto(t, target, `fault found on ${uid}, not ${from.uid}`);
  } else {
    t.pole_uids = [uid];
    to.ticket = t;
    if (t.status === 'Open' && t.check?.kind === 'crew') { // found on a check visit: the crew there takes the job
      Object.assign(t, { status: 'In Progress', assigned_crew: t.check.crew, work_started_at: now().toISOString(), check: null });
    }
    if (darkens(t)) setPoleStatus(to, t.status === 'In Progress' ? 'Under Maintenance' : 'Faulty', t);
  }
  logActivity(`Moved from ${from.uid} to ${uid}: the fault is there`, { ticket: target, uids: [from.uid, uid], from: from.uid, to: uid });
  afterDataChange();
  toast({ tone: 'ok', icon: 'fa-arrows-left-right', title: `${target.id} moved to ${uid.replace('SL-CP-', '')}`, body: 'Counted as confirmed for the reporter.' });
  return true;
}

/** "Different pole": pick the right pole on the map (Esc cancels). */
function startPolePick(id) {
  if (state.reportMode) setReportMode(false); // one map mode at a time
  if (state.drawing) stopDrawing();
  state.picking = { ticketId: id };
  document.body.classList.add('is-picking');
  map.getContainer().classList.add('is-picking');
  renderMapChip();
}
function stopPolePick() {
  state.picking = null;
  document.body.classList.remove('is-picking');
  map.getContainer().classList.remove('is-picking');
  renderMapChip();
}

/** Operator: accept a report that was held for review; it is then handled like any other. */
function acceptReport(id) {
  const r = reportById(id);
  if (!r?.review) return;
  r.review = false;
  logActivity(`Report ${r.id} accepted after review`, { uids: r.uid ? [r.uid] : [] });
  const { ticket } = processReport(r);
  afterDataChange();
  toast({ tone: 'ok', icon: 'fa-circle-check', title: `${r.id} accepted`, body: ticket ? `On ticket ${ticket.id}.` : 'Logged.' });
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
 * Who filed a report (a simulated identity: no names). The Citizen view is this device's reporter; a
 * call-centre caller is known by their mobile number (hashed), or not at all; a night audit is the crew.
 */
function reporterFor(source, phone = '') {
  if (source === 'Citizen app') return sessionReporterId();
  if (source === 'Night audit') return `crew:${currentCrew()}`;
  if (!phone) return null;
  let h = 2166136261; // FNV-1a: an ID from the number without showing it
  for (const ch of phone) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const id = `RP-C${String(h % 10000).padStart(4, '0')}`;
  if (!state.reporters.has(id)) state.reporters.set(id, { id, past_reports: 0, past_confirmed: 0, mine: false, simulated: true });
  return id;
}
/** More than REPORTS_PER_REPORTER_PER_HOUR from one reporter in the last hour. */
function overHourlyLimit(r) {
  if (!state.reporters.has(r.reporter_id)) return false;
  const since = now().getTime() - 3.6e6;
  return state.reports.filter((x) => x !== r && x.reporter_id === r.reporter_id && new Date(x.created_at).getTime() > since).length >= REPORTS_PER_REPORTER_PER_HOUR;
}

/**
 * File one report from any source. Returns { report, ticket, outcome } where outcome is
 *   'review' (over the hourly limit: logged, held for an operator), 'logged' (planned shutdown: no
 *   dispatch), 'merged' (+1 report on an open ticket), 'reopened' (the repaired lamp is still out) or 'new'.
 * Every report is recorded; confidence only changes the order and the check, never whether it counts.
 */
function fileReport({ category, uid = null, latlng, note = '', photo = null, device = null, noticed = null, name = '', phone = '', source, role = state.role }) {
  const cat = CATEGORY[category] ?? CATEGORY.other;
  const report = {
    id: nextReportId(), reporter_id: reporterFor(source, phone), category: cat.id, uid, latlng, note, photo, device, noticed,
    name, phone, source, created_at: now().toISOString(), mine: role === 'citizen', ticket_id: null,
  };
  report.reporter_id ??= `ANON-${report.id}`;
  state.reports.push(report);
  if (cat.team !== 'emergency' && overHourlyLimit(report)) { // safety reports always go through
    report.review = true;
    logActivity(`Report ${report.id} held for review: more than ${REPORTS_PER_REPORTER_PER_HOUR} in an hour from one reporter`, { uids: uid ? [uid] : [], role });
    return { report, ticket: null, outcome: 'review' };
  }
  return processReport(report, role);
}

/** Put a recorded report on a ticket: shutdown hold, merge into an open ticket, or a new ticket. */
function processReport(report, role = state.role) {
  const cat = CATEGORY[report.category];
  const at = now();
  const { uid, latlng, note, source } = report;
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
  } else {
    ticket = newTicket({ kind: p ? 'pole' : 'location', category: cat.id, source, uids: p ? [p.uid] : [], latlng: p ? null : latlng, note, at, role });
    ticket.complaints = 1;
    ticket.reports = [report.id];
    if (p) p.ticket = ticket;
  }
  report.ticket_id = ticket.id;
  // A lamp report darkens the pole, unless the evidence says to check first (CCMS shows the lamp on).
  if (cat.darkens && p && p.status === 'Functional' && ticketConfidence(ticket).band !== 'Needs check') setPoleStatus(p, 'Faulty', ticket, { role });
  return { report, ticket, outcome };
}

function setReportMode(on) {
  if (on && state.picking) stopPolePick(); // one map mode at a time
  if (on && state.drawing) stopDrawing();
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
  syncNoticed(picked);
}

/** "Noticed: Last night / Earlier today / Just now", for faults only visible after dark; pre-set by the time of day. */
function syncNoticed(category) {
  const show = CONFIDENCE.nightCategories.includes(category);
  $('#rm-noticed').hidden = !show;
  if (show && !form.querySelector('input[name="noticed"]:checked')) {
    form.querySelector(`input[name="noticed"][value="${isDark() ? 'just_now' : 'last_night'}"]`).checked = true;
  }
}

let draftPhoto = null;  // { kind: 'live' | 'upload', name, url, hash, ready }: kept in memory only
let draftDevice = null; // { latlng, accuracy_m } from "Use my location", only when the reporter taps it
let submitting = false;

function openReportModal(presetCategory) {
  lastFocus = document.activeElement;
  form.reset();
  clearPhoto();
  draftDevice = null;
  applyLanguage();
  $('#rm-issue-error').hidden = true;
  $('#rm-phone-error').hidden = true;
  $('#rm-count').textContent = '0/500';
  $('#rm-contact').open = false;
  $('#rm-geo-status').textContent = '';
  $('#rm-location').innerHTML = draftLocationHtml();
  $('#rm-noticed-options').innerHTML = ['last_night', 'earlier_today', 'just_now'].map((k) => `<label class="chip-radio">
    <input type="radio" name="noticed" value="${k}"><span>${esc(tr(`noticed_${k}`))}</span></label>`).join('');
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
  draftPhoto = null;
  const img = $('#rm-photo-preview');
  img.hidden = true;
  img.removeAttribute('src');
  $('#rm-photo-name').textContent = '';
  for (const id of ['#rm-photo-take', '#rm-photo-upload']) $(id).value = '';
}

/** A photo for the report: "Take photo" (the camera) counts as live, "Upload photo" as uploaded. */
function setDraftPhoto(file, kind) {
  clearPhoto();
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    $('#rm-photo-name').textContent = tr('form_photo_not_image');
    return;
  }
  photoUrl = URL.createObjectURL(file);
  const img = $('#rm-photo-preview');
  img.src = photoUrl;
  img.hidden = false;
  $('#rm-photo-name').textContent = file.name;
  const photo = { kind, name: file.name, url: photoUrl, hash: null };
  photo.ready = imageHash(file).then((hash) => { photo.hash = hash; });
  draftPhoto = photo;
}

/**
 * Perceptual hash (dHash, 64 bits) of a picture, computed in the browser: the same picture resized or
 * re-saved gives nearly the same hash. Pictures too dark or plain to compare give null.
 */
function imageHash(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (hash) => {
      URL.revokeObjectURL(url);
      resolve(hash);
    };
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 9;
      canvas.height = 8;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 9, 8);
      const px = ctx.getImageData(0, 0, 9, 8).data;
      const grey = Array.from({ length: 72 }, (_, i) => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
      const mean = sum(grey) / grey.length;
      if (Math.sqrt(sum(grey.map((g) => (g - mean) ** 2)) / grey.length) < PHOTO_HASH_MIN_CONTRAST) return done(null);
      let hex = '';
      for (let y = 0; y < 8; y++) {
        let byte = 0;
        for (let x = 0; x < 8; x++) byte = (byte << 1) | (grey[y * 9 + x] > grey[y * 9 + x + 1] ? 1 : 0);
        hex += byte.toString(16).padStart(2, '0');
      }
      return done(hex);
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

/** "Use my location": asked only when the reporter taps it, never automatically. */
function useMyLocation() {
  const status = $('#rm-geo-status');
  const draft = state.draft;
  if (!navigator.geolocation) {
    status.textContent = tr('location_failed');
    return;
  }
  status.textContent = tr('locating');
  navigator.geolocation.getCurrentPosition((pos) => {
    if (state.draft !== draft) return; // the form was closed meanwhile
    draftDevice = { latlng: toLatLng([pos.coords.longitude, pos.coords.latitude]), accuracy_m: Math.round(pos.coords.accuracy) };
    status.textContent = tr('location_added', { m: draftDevice.accuracy_m });
  }, () => {
    if (state.draft !== draft) return;
    draftDevice = null;
    status.textContent = tr('location_failed');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

/** Form submit: validate, file the report, update the map, say what happened. */
async function submitReportForm() {
  if (submitting) return;
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
  submitting = true;
  const photoDraft = draftPhoto;
  if (photoDraft) await photoDraft.ready; // the perceptual hash takes a moment
  submitting = false;
  if (state.draft !== draft) return;
  const citizen = isCitizen();
  const photo = photoDraft ? { kind: photoDraft.kind, name: photoDraft.name, url: photoDraft.url, hash: photoDraft.hash } : null;
  if (photo) photoUrl = null; // the report keeps the picture, in memory only
  const { report, ticket, outcome, hold } = fileReport({
    category, uid: draft.uid, latlng: draft.clickLatLng, photo, device: draftDevice,
    noticed: CONFIDENCE.nightCategories.includes(category) ? String(fd.get('noticed') || '') || null : null,
    note: String(fd.get('description') ?? '').trim(), name: String(fd.get('name') ?? '').trim(), phone,
    source: citizen ? 'Citizen app' : 'Call centre',
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
  if (outcome === 'review') {
    return citizen
      ? { tone: 'ok', icon: 'fa-circle-check', title: tr('toast_sent'), body: tr('toast_sent_body', { id: report.id }) }
      : { tone: 'info', icon: 'fa-hourglass-half', title: `${report.id} held for review`, body: `More than ${REPORTS_PER_REPORTER_PER_HOUR} reports in an hour from this caller.` };
  }
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

// ---- 11.1 Public escalation on X (citizen-initiated) -----------------------------------------
/** Offered only once earned: still open past its SLA, or the reporter said it was not fixed. Never at report time. */
function shareEligible(r) {
  const t = state.tickets.get(r?.ticket_id);
  return state.publicSharing && Boolean(r?.mine) && Boolean(t) && (isBreached(t) || Boolean(r.reopened_at));
}
const daysOpen = (t) => Math.max(1, Math.round(daysBetween(t.first_raised_at ?? t.raised_at, now())));
const statusUrl = (id) => (BASE_URL ? `${BASE_URL.replace(/#.*$/, '')}#ticket=${encodeURIComponent(id)}` : null);
const departmentHandle = (t) => OFFICIAL_HANDLES[TEAM_DEPARTMENT[t.team]] ?? null;
const handlesArePlaceholders = () => Object.values(OFFICIAL_HANDLES).some(isPlaceholderHandle);
function ticketRoad(t) {
  const p = props(t.pole_uids[0] ?? t.near_uid);
  if (p) return p.road;
  const at = ticketLatLng(t);
  return at ? nearestPole(at)?.rec.feature.properties.road ?? '' : '';
}
function landmarkNear(latlng) {
  const best = landmarkRecs.map((l) => ({ l, d: l.latlng.distanceTo(latlng) })).filter((x) => x.d <= SHARE_LANDMARK_MAX_M).sort((a, b) => a.d - b.d)[0];
  return best?.l.name ?? null;
}

/** The citizen's post, exactly as it opens on X: factual, in their language; no name, number, photo or personal location. */
function citizenPost(r) {
  const t = state.tickets.get(r.ticket_id);
  const at = ticketLatLng(t);
  return buildPost({
    id: t.id, category: catLabel(t.category, true), road: ticketRoad(t), landmark: at ? landmarkNear(at) : null,
    days: daysOpen(t), url: statusUrl(t.id), handle: departmentHandle(t),
  }, tr, X_POST);
}

/** The citizen chose to share: tell operators. Sharing never changes a ticket's priority. */
function markShared(r, channel) {
  const t = state.tickets.get(r.ticket_id);
  if (!t) return;
  t.public ??= { shared_at: now().toISOString(), report_id: r.id };
  logActivity(`Shared publicly by reporter (${channel})`, { ticket: t, role: 'citizen' });
}

/** After a shared ticket closes: a short factual update for the department's own account (operators). */
const departmentUpdate = (t) => buildUpdate({
  id: t.id, category: catLabel(t.category, false), road: ticketRoad(t), date: fmtDate(t.verified_at ?? t.closed_at), url: statusUrl(t.id),
}, X_POST);

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
    if (modeClick(e.latlng)) return undefined;
    if (citizen) return report?.uid ? selectPole(report.uid) : openMyReports();
    if (report?.uid && !ticket?.near_uid && ticket?.kind !== 'location') return selectPole(report.uid);
    if (ticket && state.tickets.has(ticket.id)) return openTicket(ticket.id);
    return report?.uid ? selectPole(report.uid) : undefined;
  });
  m.on('add', () => m.getElement()?.setAttribute('aria-label', `Report ${title}`));
  return m;
}
