/* ==========================================================================
 * Street Light GIS · analysis.js
 * Section 8: spatial analysis. Heatmap · road order · unlit stretches (dark spots) · root cause ·
 * coverage gaps · landmarks and criticality · feeder panel load.
 * ========================================================================== */
'use strict';

// ========================================================================
// 8. Spatial analysis
// ========================================================================

// ---- 8.1 Dark-spot heatmap -------------------------------------------------
/** Heat radius in pixels for a fixed ground radius, so a dark spot means the same area at any zoom. */
function heatRadiusPx() {
  const radius = clamp(HEAT_RADIUS_M / metersPerPixel(), 8, 90);
  return { radius, blur: radius * 0.8 };
}

function refreshHeat() {
  // leaflet.heat's redraw() dereferences its map, so it throws once the layer has been removed: only touch it while it's on the map.
  if (!layers.heat || !map.hasLayer(layers.heat)) return;
  // [lat, lng, intensity] built from L.LatLng objects, never from raw GeoJSON arrays
  layers.heat.setLatLngs(faultyRecords().map(({ latlng }) => [latlng.lat, latlng.lng, HEAT_INTENSITY]));
}

function heatRampCss() {
  const stops = Object.entries(TOKEN.heat).sort((a, b) => Number(a[0]) - Number(b[0])); // "1" would sort before "0.2"
  return `linear-gradient(90deg, ${stops.map(([stop, c]) => `${c} ${Math.round(Number(stop) * 100)}%`).join(', ')})`;
}

// ---- 8.2 Physical order of the poles along each road ------------------------
// Derived from the geometry, not from the IDs. Ring roads are ordered by bearing around the zone
// centre; a ring with one gap much wider than the usual spacing is an open road that ends there
// (Middle Circle). A road that does not wrap around the centre (Radial Road 1) is ordered along
// its main direction, starting from the end nearest the centre.
const roadOrder = new Map(); // road name -> { name, uids: [...in order], closed, spans: [metres from i to i+1] }

function computeRoadOrder() {
  const centre = L.latLng(CENTRE_LATLNG);
  const kx = 111_320 * Math.cos((CENTRE.lat * Math.PI) / 180);
  const xy = (ll) => [(ll.lng - CENTRE.lng) * kx, (ll.lat - CENTRE.lat) * 110_574]; // local metres, east and north
  for (const [name, recs] of groupBy([...state.byUid.values()], (r) => r.feature.properties.road)) {
    const pts = recs.map((r) => {
      const [x, y] = xy(r.latlng);
      return { r, x, y, bearing: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 };
    });
    let ordered;
    let closed = false;
    pts.sort((a, b) => a.bearing - b.bearing);
    const steps = pts.map((p, i) => (pts[(i + 1) % pts.length].bearing - p.bearing + 360) % 360);
    const widest = Math.max(...steps);
    if (pts.length >= 3 && 360 - widest > 180) { // wraps around the centre: a ring road
      const median = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)];
      closed = widest <= OPEN_ROAD_GAP_FACTOR * median;
      const at = steps.indexOf(widest);
      ordered = [...pts.slice(at + 1), ...pts.slice(0, at + 1)]; // open road: starts just after its widest gap
    } else { // a straight or radial road: sort along the principal axis
      const mx = sum(pts.map((p) => p.x)) / pts.length;
      const my = sum(pts.map((p) => p.y)) / pts.length;
      const sxx = sum(pts.map((p) => (p.x - mx) ** 2));
      const syy = sum(pts.map((p) => (p.y - my) ** 2));
      const sxy = sum(pts.map((p) => (p.x - mx) * (p.y - my)));
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const along = (p) => (p.x - mx) * Math.cos(theta) + (p.y - my) * Math.sin(theta);
      ordered = [...pts].sort((a, b) => along(a) - along(b));
      if (ordered[0].r.latlng.distanceTo(centre) > ordered[ordered.length - 1].r.latlng.distanceTo(centre)) ordered.reverse();
    }
    const uids = ordered.map((p) => p.r.uid);
    const spans = uids.map((uid, i) => (closed || i < uids.length - 1
      ? state.byUid.get(uid).latlng.distanceTo(state.byUid.get(uids[(i + 1) % uids.length]).latlng)
      : 0));
    roadOrder.set(name, { name, uids, closed, spans });
  }
}

// ---- 8.3 Unlit stretches (A1) -------------------------------------------------
// Walk each road in physical order. A run of MIN_DARK_RUN or more consecutive dark poles (Faulty or
// Under maintenance) is an unlit stretch; a single dark pole between two lit ones is mostly covered
// by its neighbours. Its length is the distance along the road between the lit poles either side
// (at an open road's end, up to the last pole).
function computeDarkRuns() {
  const runs = [];
  for (const road of roadOrder.values()) {
    const n = road.uids.length;
    const dark = road.uids.map((uid) => isDarkStatus(props(uid)));
    if (!dark.some(Boolean)) continue;
    if (dark.every(Boolean)) {
      if (n >= MIN_DARK_RUN) runs.push(measureRun(road, road.uids.map((_, i) => i)));
      continue;
    }
    const start = road.closed ? dark.indexOf(false) : 0; // on a ring, start at a lit pole so no run straddles the start
    let run = [];
    const flush = () => {
      if (run.length >= MIN_DARK_RUN) runs.push(measureRun(road, run));
      run = [];
    };
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (dark[i]) run.push(i);
      else flush();
    }
    flush();
  }
  return runs;
}

function measureRun(road, idx) {
  const { uids, closed, spans } = road;
  const n = uids.length;
  const first = idx[0];
  const last = idx[idx.length - 1];
  const whole = idx.length === n;
  const before = !whole && (closed || first > 0) ? (first - 1 + n) % n : null; // lit pole before the run
  const after = !whole && (closed || last < n - 1) ? (last + 1) % n : null;    // lit pole after it
  let unlitM = 0;
  if (whole) unlitM = sum(closed ? spans : spans.slice(0, n - 1));
  else if (before !== null && before === after) unlitM = sum(spans); // a ring with a single lit pole
  else for (let i = before ?? first; i !== (after ?? last); i = (i + 1) % n) unlitM += spans[i];
  const path = [...(before !== null ? [uids[before]] : []), ...idx.map((i) => uids[i]), ...(after !== null ? [uids[after]] : [])];
  return { road: road.name, uids: idx.map((i) => uids[i]), beforeUid: before !== null ? uids[before] : null, afterUid: after !== null ? uids[after] : null, path, unlitM };
}

/** Recompute the unlit stretches and index them by pole (feeds priority, dark spots and the KPIs). */
let darkRunByUid = new Map();
function refreshDarkRuns() {
  state.darkRuns = computeDarkRuns();
  darkRunByUid = new Map(state.darkRuns.flatMap((run) => run.uids.map((uid) => [uid, run])));
}
const unlitTotalM = () => sum((state.darkRuns ?? []).map((r) => r.unlitM));

// ---- 8.4 Dark spots: each unlit stretch, with its likely root cause --------------
function computeDarkSpots() {
  const spots = (state.darkRuns ?? []).map(describeSpot)
    .sort((a, b) => b.unlitM - a.unlitM || b.recs.length - a.recs.length);
  spots.forEach((s, i) => { s.id = `DS-${i + 1}`; });
  return spots;
}

function describeSpot(run) {
  const recs = run.uids.map((uid) => state.byUid.get(uid));
  const ps = recs.map((r) => r.feature.properties);
  return {
    ...run,
    recs,
    line: run.path.map((uid) => state.byUid.get(uid).latlng),
    lostW: sum(ps.map((p) => p.wattage * (p.arm_count ?? 1))),
    where: mostCommon(ps.map((p) => p.location.split(' · ')[0]))?.value ?? run.road,
    diagnosis: diagnose(ps),
  };
}

function renderDarkSpots() {
  layers.darkSpots.clearLayers();
  state.darkSpots = computeDarkSpots();
  for (const s of state.darkSpots) {
    s.shape = L.polyline(s.line, {
      pane: 'darkSpotPane', interactive: false, color: TOKEN.serious, weight: 5, opacity: 0.85,
      dashArray: '2 7', lineCap: 'round', lineJoin: 'round', className: 'dark-spot',
    }).addTo(layers.darkSpots);
    L.tooltip({ permanent: true, direction: 'top', className: 'ds-label', offset: [0, -8] })
      .setLatLng(s.line[Math.floor(s.line.length / 2)])
      .setContent(`${s.id} · ${nf0.format(roundTo(s.unlitM, 5))} m unlit`)
      .addTo(layers.darkSpots);
  }
}

// ---- 8.5 Root cause --------------------------------------------------------------
/**
 * Circuit-level fault on one circuit (C1), read from circuit_seq:
 *   - cable: every pole from #k to the end of the circuit is dark while #k−1 works, so the cable
 *     after pole #k−1 is the likely cause (needs MIN_CABLE_FAULT_RUN dark poles; takes precedence,
 *     because a working pole upstream rules out the panel's breaker);
 *   - panel: CIRCUIT_FAULT_SHARE or more of the circuit's poles are dark, so the panel or breaker.
 * Circuits switched off by a planned shutdown are never a fault.
 */
function circuitFault(panelId, circuit, t = now()) {
  const ps = circuitUids(panelId, circuit).map(props);
  if (!ps.length || activeShutdowns(t).some((s) => s.panelId === panelId && s.circuits.includes(circuit))) return null;
  const dark = ps.filter(isDarkStatus);
  if (!dark.length) return null;
  let k = ps.length; // poles k+1..n (1-based) are dark from the far end inwards
  while (k > 0 && isDarkStatus(ps[k - 1])) k -= 1;
  const tail = ps.length - k;
  const where = `${panelId}/${circuit}`;
  if (k > 0 && tail >= MIN_CABLE_FAULT_RUN) {
    const lit = ps[k - 1];
    const affected = ps.slice(k);
    const permit = permitNear(affected.map((p) => state.byUid.get(p.uid).latlng).concat(state.byUid.get(lit.uid).latlng), t);
    return {
      kind: 'cable', panelId, circuit, uids: affected.map((p) => p.uid), afterUid: lit.uid, permit,
      short: `Probable cable fault after pole #${lit.circuit_seq}`,
      text: `Poles #${k + 1} to #${ps.length} on ${where} are dark while pole #${lit.circuit_seq} (${lit.uid}) works, so the cable after it is the likely fault. Send the cable team with a fault locator, not a lamp crew.${permitText(permit)}`,
    };
  }
  if (dark.length / ps.length >= CIRCUIT_FAULT_SHARE) {
    const permit = permitNear(dark.map((p) => state.byUid.get(p.uid).latlng), t);
    const whole = dark.length === ps.length;
    return {
      kind: 'panel', panelId, circuit, uids: dark.map((p) => p.uid), afterUid: null, permit,
      short: whole ? 'Whole circuit dark' : `Panel or breaker fault (${dark.length} of ${ps.length} dark)`,
      text: `${whole ? 'Every pole' : `${dark.length} of ${ps.length} poles`} on ${where} ${whole ? 'is' : 'are'} dark, so the panel or breaker is the likely cause. Check the MCB, contactor and phase fuses in ${panelId}.${phaseNote(ps)}${permitText(permit)}`,
    };
  }
  return null;
}

/** When every working pole sits on one set of phases and every dark pole on another, say so. */
function phaseNote(ps) {
  const lit = new Set(ps.filter((p) => !isDarkStatus(p)).map((p) => p.phase).filter(Boolean));
  const dark = new Set(ps.filter(isDarkStatus).map((p) => p.phase).filter(Boolean));
  if (!lit.size || !dark.size || [...dark].some((ph) => lit.has(ph))) return '';
  const list = (set) => [...set].sort().join(' and ');
  return ` Poles on phase ${list(lit)} still work while every pole on phase ${list(dark)} is dark: suspect a blown fuse or loose connection on ${dark.size > 1 ? 'those phases' : 'that phase'}.`;
}

/** Likely root cause of a set of dark poles, from the feeder topology and the open tickets. */
function diagnose(ps) {
  const circuits = new Set(ps.map((p) => `${p.feeder_panel}/${p.circuit}`));
  if (circuits.size === 1) {
    const fault = circuitFault(ps[0].feeder_panel, ps[0].circuit);
    if (fault && ps.every((p) => fault.uids.includes(p.uid))) return { kind: fault.kind, short: fault.short, text: fault.text };
  }
  const tickets = [...new Set(ps.map((p) => p.ticket).filter(Boolean))];
  const common = mostCommon(tickets.map((t) => t.issue).filter(Boolean));
  if (common && common.count >= 2) {
    const batch = mostCommon(ps.map((p) => p.fixture_batch));
    const sameBatch = batch && batch.count === ps.length;
    return {
      kind: 'pattern', short: `${common.count}× “${common.value}”`,
      text: `${common.count} poles in a row report “${common.value}”.${sameBatch ? ` All are fixture batch ${batch.value}: check the batch and the surge protection` : ' Check the surge protection and the fixture batch'} before swapping parts one by one.`,
    };
  }
  if (circuits.size === 1) {
    const seqs = ps.map((p) => p.circuit_seq).sort((a, b) => a - b);
    if (seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1)) {
      const { feeder_panel: panel, circuit } = ps[0];
      return { kind: 'local', short: `Adjacent poles #${seqs[0]}–#${seqs[seqs.length - 1]} on ${panel}/${circuit}`, text: 'Neighbouring poles on one circuit share a junction box and cable section. Inspect those before replacing lamps.' };
    }
  }
  return { kind: 'independent', short: 'Independent lamp failures', text: 'Unrelated failures close together. Bundle them into one crew visit.' };
}
const DIAGNOSIS_ICONS = { cable: 'fa-bolt', panel: 'fa-plug-circle-xmark', local: 'fa-box-open', pattern: 'fa-layer-group', independent: 'fa-list-check' };

// ---- 8.6 Coverage gaps (A2): spacing too wide for the pole height ------------------
// Not a failure: these stretches need another pole, not a repair.
function computeCoverageGaps() {
  const gaps = [];
  for (const road of roadOrder.values()) {
    const n = road.uids.length;
    for (let i = 0; i < (road.closed ? n : n - 1); i++) {
      const a = props(road.uids[i]);
      const b = props(road.uids[(i + 1) % n]);
      const heightM = (a.pole_height_m + b.pole_height_m) / 2;
      const limitM = DESIGN_SPACING_RATIO * heightM;
      const spacingM = road.spans[i];
      if (spacingM > limitM) {
        gaps.push({ id: `CG-${gaps.length + 1}`, road: road.name, a: a.uid, b: b.uid, spacingM, limitM, heightM, addPoles: Math.ceil(spacingM / limitM) - 1 });
      }
    }
  }
  return gaps;
}

function createCoverageLayer() {
  const group = L.layerGroup();
  for (const g of state.gaps) {
    const a = state.byUid.get(g.a).latlng;
    const b = state.byUid.get(g.b).latlng;
    const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    const tip = () => `<div class="tt-value">${esc(g.id)} · coverage gap</div>
      <div class="tt-row">${nf0.format(g.spacingM)} m between poles · add ${plural(g.addPoles, 'pole')}</div>`;
    L.polyline([a, b], { pane: 'overlayLinePane', color: TOKEN.design, weight: 3, opacity: 0.9, dashArray: '2 6', lineCap: 'round', interactive: false }).addTo(group);
    L.marker(mid, {
      pane: 'landmarkPane', keyboard: true,
      icon: L.divIcon({ className: 'gap-icon', html: '<span><i class="fa-solid fa-plus" aria-hidden="true"></i></span>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    }).bindTooltip(tip, { className: 'sl-tooltip', direction: 'top', offset: [0, -8], opacity: 1 })
      .on('click', () => openGap(g.id))
      .on('add', (e) => e.target.getElement()?.setAttribute('aria-label', `Coverage gap ${g.id}, ${Math.round(g.spacingM)} metres`))
      .addTo(group);
  }
  return group;
}

// ---- 8.7 Landmarks and criticality (A3) --------------------------------------------
let landmarkRecs = [];
const criticalityCache = new Map();
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s); // "Metro exit" -> "metro exit", "ATM" stays

function indexLandmarks() {
  landmarkRecs = (DATA.landmarks?.features ?? []).map((f) => ({ ...f.properties, id: f.properties.landmark_id, latlng: toLatLng(f) }));
}

/** Criticality of a spot from the landmarks within CRITICALITY_RADIUS_M: { level: 'High' | 'Medium' | null, score, reason }. */
function criticalityAt(latlng) {
  const near = landmarkRecs
    .map((l) => ({ ...l, d: latlng.distanceTo(l.latlng), w: LANDMARK_KINDS[l.kind]?.weight ?? 0 }))
    .filter((l) => l.d <= CRITICALITY_RADIUS_M)
    .sort((a, b) => b.w - a.w || a.d - b.d);
  const score = sum(near.map((l) => l.w));
  const level = score >= CRITICALITY_HIGH ? 'High' : score >= CRITICALITY_MEDIUM ? 'Medium' : null;
  const kinds = [...new Set(near.map((l) => l.kind))].map((k) => lowerFirst(LANDMARK_KINDS[k]?.label ?? k));
  const reason = kinds.length ? `Near ${kinds.slice(0, 2).join(' and ')}${kinds.length > 2 ? ` +${kinds.length - 2}` : ''}` : null;
  return { level, score, reason, near };
}
/** A pole's criticality (landmarks never move, so it is worked out once). */
function poleCriticality(uid) {
  if (!criticalityCache.has(uid)) criticalityCache.set(uid, criticalityAt(state.byUid.get(uid).latlng));
  return criticalityCache.get(uid);
}

function createLandmarkLayer() {
  const group = L.layerGroup();
  for (const l of landmarkRecs) {
    const kind = LANDMARK_KINDS[l.kind] ?? { label: l.kind, icon: 'fa-location-dot' };
    L.marker(l.latlng, {
      pane: 'landmarkPane', keyboard: false,
      icon: L.divIcon({ className: 'landmark-icon', html: `<span><i class="fa-solid ${kind.icon}" aria-hidden="true"></i></span>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
    }).bindTooltip(`<div class="tt-value">${esc(l.name)}</div><div class="tt-row">${esc(kind.label)}</div>
      <div class="tt-hint">Approximate position (synthetic)</div>`, { className: 'sl-tooltip', direction: 'top', offset: [0, -8], opacity: 1 })
      .addTo(group);
  }
  return group;
}

// ---- 8.8 Feeder panel load (F4) -------------------------------------------------------
/**
 * Lamp load plus temporary connections, against the panel's usable capacity (kVA × power factor).
 * `now` counts the temporary connections running at `t`; `peak` adds the most temporary load
 * connected at once during the festive window.
 */
function panelLoad(id, t = now()) {
  const pp = panelProps(id) ?? {};
  const lampKw = sum(polesOfPanel(id).map((p) => p.wattage * (p.arm_count ?? 1) * systemLoss(p))) / 1000;
  const capacityKw = (pp.capacity_kva ?? 0) * PANEL_POWER_FACTOR;
  const temps = (pp.temp_connections ?? []).map((c) => ({ ...c, fromD: new Date(c.from), toD: new Date(c.to) }));
  const running = temps.filter((c) => c.fromD <= t && t < c.toD);
  const winStart = new Date(`${FESTIVE_WINDOW.start}T00:00${IST_OFFSET}`);
  const winEnd = new Date(`${addDays(FESTIVE_WINDOW.end, 1)}T00:00${IST_OFFSET}`);
  const festive = temps.filter((c) => c.fromD < winEnd && c.toD > winStart);
  let peakTempKw = 0;
  for (const c of festive) { // concurrent load is highest at the start of one of the connections
    const at = c.fromD > winStart ? c.fromD : winStart;
    peakTempKw = Math.max(peakTempKw, sum(festive.filter((x) => x.fromD <= at && at < x.toD).map((x) => x.kw)));
  }
  const nowKw = lampKw + sum(running.map((c) => c.kw));
  const peakKw = lampKw + peakTempKw;
  const share = capacityKw ? nowKw / capacityKw : 0;
  const peakShare = capacityKw ? peakKw / capacityKw : 0;
  return { lampKw, capacityKw, running, festive, nowKw, peakKw, share, peakShare, warn: Math.max(share, peakShare) > PANEL_LOAD_WARN_SHARE };
}

// ---- 8.9 Excavation permits near a fault (F3) --------------------------------------
let permitRecs = [];
function indexPermits() {
  permitRecs = (DATA.excavationPermits?.features ?? []).map((f) => ({ ...f.properties, id: f.properties.permit_id, line: toLatLngs(f) }));
}
const permitActive = (pm, t = now()) => new Date(pm.start) <= t && t < new Date(pm.end);
/** The active permit within PERMIT_PROXIMITY_M of any of these points, if any. */
function permitNear(latlngs, t = now()) {
  return permitRecs.find((pm) => permitActive(pm, t) && latlngs.some((ll) => distanceToLine(ll, pm.line) <= PERMIT_PROXIMITY_M)) ?? null;
}
const permitText = (pm) => (pm ? ` Active excavation by ${pm.agency} nearby. Possible third-party damage.` : '');

// ---- 8.10 Uptime (E1) ------------------------------------------------------------------
/** Lamp-hours lit ÷ lamp-hours scheduled (sunset to sunrise, minus planned shutdowns) in one month. */
function uptimeOf(list, month) {
  let lit = 0;
  let scheduled = 0;
  for (const p of list) {
    const row = p.energy_history?.find((r) => r.month === month);
    if (!row) continue;
    const lamps = p.arm_count ?? 1;
    lit += row.lit_h * lamps;
    scheduled += row.scheduled_h * lamps;
  }
  return scheduled ? lit / scheduled : null;
}

/** Uptime rows for the zone, each road and each contractor, over the months in the data. */
function uptimeTable() {
  const months = META.energy_months ?? [];
  const list = allProps();
  const row = (label, ps) => ({ label, poles: ps.length, months: months.map((m) => uptimeOf(ps, m)) });
  return {
    months,
    zone: row('Pilot zone', list),
    roads: [...groupBy(list, (p) => p.road)].map(([road, ps]) => row(road, ps)),
    contractors: [...groupBy(list, (p) => p.contractor?.name ?? '–')].map(([name, ps]) => row(name, ps)),
  };
}

// ---- 8.11 Contractor scorecard (E2) -------------------------------------------------------
const daysBetween = (a, b) => hoursBetween(a, b) / 24;

/** Corrective repairs in the scorecard window, one job per ticket, per contractor. */
function contractorScorecards(at = now()) {
  const jobs = new Map();    // ticket id -> { contractor, sla_met, downtime_h, cost }
  const repeats = new Map(); // contractor -> failures soon after one of their repairs
  for (const p of allProps()) {
    const corrective = p.repair_history.filter((h) => h.type === 'Corrective').sort((a, b) => new Date(a.raised_at) - new Date(b.raised_at));
    for (const h of corrective) {
      if (daysBetween(h.resolved_at, at) > SCORECARD_WINDOW_DAYS) continue;
      const job = jobs.get(h.ticket_id) ?? { contractor: h.contractor, sla_met: h.sla_met, downtime_h: h.downtime_h, cost: 0 };
      job.cost += h.cost_inr ?? 0;
      jobs.set(h.ticket_id, job);
    }
    // a failure within REPEAT_WINDOW_DAYS of the previous repair on the same pole counts against that repair
    const failures = [...corrective.map((h) => h.raised_at), ...(p.ticket ? [p.ticket.raised_at] : [])];
    corrective.forEach((h, i) => {
      const next = failures[i + 1];
      if (next && daysBetween(h.resolved_at, next) <= REPEAT_WINDOW_DAYS && daysBetween(next, at) <= SCORECARD_WINDOW_DAYS) {
        repeats.set(h.contractor, (repeats.get(h.contractor) ?? 0) + 1);
      }
    });
  }
  return Object.values(META.contractors ?? {}).map((c) => {
    const list = [...jobs.values()].filter((j) => j.contractor === c.name);
    const met = list.filter((j) => j.sla_met).length;
    return {
      id: c.id, name: c.name, jobs: list.length, met, breaches: list.length - met,
      compliance: list.length ? met / list.length : null,
      mttrH: list.length ? sum(list.map((j) => j.downtime_h ?? 0)) / list.length : null,
      cost: sum(list.map((j) => j.cost)), repeats: repeats.get(c.name) ?? 0,
      exampleDeduction: (list.length - met) * EXAMPLE_DEDUCTION_PER_BREACH_INR,
    };
  });
}

// ---- 8.12 Chronic poles and fixture batches (E3) ---------------------------------------------
/** Poles with CHRONIC_FAILURES or more failures (closed or open) in the last CHRONIC_WINDOW_DAYS. */
function chronicPoles(at = now()) {
  return allProps().map((p) => {
    const failures = [...p.repair_history.filter((h) => h.type === 'Corrective').map((h) => h.raised_at), ...(p.ticket ? [p.ticket.raised_at] : [])]
      .filter((t) => daysBetween(t, at) <= CHRONIC_WINDOW_DAYS);
    return { p, failures: failures.length };
  }).filter((x) => x.failures >= CHRONIC_FAILURES).sort((a, b) => b.failures - a.failures);
}

/** Fixture failures per batch in the last year (external causes such as cable theft or vehicles excluded). */
function batchFailureRates(at = now()) {
  const list = allProps();
  const fixtureFailure = (h) => h.type === 'Corrective' && !EXTERNAL_CAUSE.test(h.issue ?? '') && daysBetween(h.raised_at, at) <= CHRONIC_WINDOW_DAYS;
  const openFailure = (p) => Boolean(p.ticket) && p.ticket.team === 'lamp' && !EXTERNAL_CAUSE.test(p.ticket.issue ?? '');
  const rows = [...groupBy(list, (p) => p.fixture_batch)].map(([batch, ps]) => ({
    batch, make: ps[0].fixture_make, fixtures: ps.length,
    failures: sum(ps.map((p) => p.repair_history.filter(fixtureFailure).length + Number(openFailure(p)))),
  }));
  const zoneRate = sum(rows.map((r) => r.failures)) / Math.max(1, list.length);
  for (const r of rows) {
    r.rate = r.failures / r.fixtures;
    r.ratio = zoneRate ? r.rate / zoneRate : 0;
    r.weak = r.ratio >= WEAK_BATCH_RATIO && r.failures >= WEAK_BATCH_MIN_FAILURES;
  }
  return { zoneRate, rows: rows.sort((a, b) => b.rate - a.rate) };
}

// ---- 8.13 Energy reconciliation (E4) ------------------------------------------------------
/** Metered kWh at each feeder panel against the sum of its lamps' own consumption. */
function reconciliation(month = META.energy_month) {
  return [...state.panels.values()].map(({ id, feature }) => {
    const metered = feature.properties.metered_kwh_history?.find((r) => r.month === month)?.kwh ?? null;
    const lamps = sum(polesOfPanel(id).map((p) => p.energy_history?.find((r) => r.month === month)?.kwh ?? 0));
    const gap = metered == null ? null : metered - lamps;
    const share = metered == null || !lamps ? null : gap / lamps;
    return { id, name: feature.properties.name, metered, lamps, gap, share, flag: share != null && share > RECONCILIATION_GAP_SHARE };
  }).sort((a, b) => (b.share ?? -1) - (a.share ?? -1));
}

// ---- 8.14 Pre-monsoon safety (F1) -----------------------------------------------------------
let waterRecs = [];
function indexWaterlogging() {
  waterRecs = (DATA.waterloggingSpots?.features ?? []).map((f) => ({ ...f.properties, id: f.properties.spot_id, latlng: toLatLng(f) }));
}
const waterNear = (latlng) => waterRecs.find((w) => latlng.distanceTo(w.latlng) <= w.radius_m + WATERLOGGING_NEAR_M) ?? null;
/** Whole months from an IST date ('YYYY-MM-DD') to `at`. */
function monthsSince(dateKey, at = now()) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [ny, nm, nd] = istDateKey(at).split('-').map(Number);
  return (ny - y) * 12 + (nm - m) - (nd < d ? 1 : 0);
}

/** Earthing checks older than EARTHING_CHECK_MAX_MONTHS: poles near waterlogging spots first, then poor junction boxes, then the oldest. */
function monsoonDue(at = now()) {
  const box = { Poor: 0, Fair: 1, Good: 2 };
  return [...state.byUid.values()]
    .map(({ feature, latlng }) => ({ p: feature.properties, age: monthsSince(feature.properties.last_earthing_check, at), water: waterNear(latlng) }))
    .filter((x) => x.age >= EARTHING_CHECK_MAX_MONTHS)
    .sort((a, b) => Number(Boolean(b.water)) - Number(Boolean(a.water))
      || (box[a.p.junction_box_condition] ?? 3) - (box[b.p.junction_box_condition] ?? 3) || b.age - a.age);
}

// ---- 8.15 Event readiness (F2) ---------------------------------------------------------------
/** Poles on the chosen roads, or within EVENT_ROUTE_BUFFER_M of a drawn route, that are not working, plus their open tickets. */
function eventCheck({ roads = [], line = null }) {
  const onLine = (latlng) => line?.length >= 2 && distanceToLine(latlng, line) <= EVENT_ROUTE_BUFFER_M;
  const poles = [...state.byUid.values()].filter(({ feature, latlng }) => roads.includes(feature.properties.road) || onLine(latlng))
    .map((r) => r.feature.properties);
  const uids = new Set(poles.map((p) => p.uid));
  const tickets = [...state.tickets.values()]
    .filter((t) => t.pole_uids.some((u) => uids.has(u)) || (t.kind === 'location' && ticketLatLng(t) && onLine(ticketLatLng(t))))
    .sort(ticketOrder);
  return { poles, notWorking: poles.filter((p) => p.status !== 'Functional'), tickets };
}
