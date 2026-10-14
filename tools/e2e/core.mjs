// End-to-end test of the map, role views and operational features (rounds 1–2), driven through real
// mouse/keyboard events where it matters. Run through run.mjs, which opens the app at 19:30 on the snapshot day.
import { fileURLToPath } from 'node:url';

const J = (v) => JSON.stringify(v);
const PHOTO = fileURLToPath(new URL('./fixtures/night.png', import.meta.url));

export default async function run(t, check) {
  const ev = (expr) => t.eval(expr);
  const box = (sel) => ev(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  const clickSel = async (sel, wait = 300) => {
    let b = await box(sel);
    for (let i = 0; i < 20 && b; i++) { // wait until the element stops moving (panels slide with the sidebar)
      await t.sleep(80);
      const next = await box(sel);
      if (next && Math.abs(next.x - b.x) < 0.5 && Math.abs(next.y - b.y) < 0.5) break;
      b = next;
    }
    if (!b) throw new Error(`no element ${sel}`);
    await t.click(b.x, b.y);
    await t.sleep(wait);
  };
  const waitFor = async (expr, ms = 8000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (await ev(expr)) return true;
      await t.sleep(100);
    }
    return false;
  };
  const centrePole = async (uid, zoom = 18) => {
    await ev(`void slgis.map.setView(slgis.state.byUid.get(${J(uid)}).latlng, ${zoom}, { animate: false })`);
    await t.sleep(250);
    return ev(`(() => { const p = slgis.map.latLngToContainerPoint(slgis.state.byUid.get(${J(uid)}).latlng); return { x: p.x, y: p.y }; })()`);
  };
  const clickPole = async (uid) => {
    const p = await centrePole(uid);
    await t.click(p.x, p.y);
    await t.sleep(500);
  };
  const sidebarText = () => ev(`document.querySelector('#sidebar-content').innerText`);
  const setFile = async (selector, file) => {
    const { root } = await t.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await t.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`no file input ${selector}`);
    await t.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await t.sleep(400);
  };
  const closeSb = async () => { await ev('closeSidebar()'); await t.sleep(450); };
  const role = async (r) => {
    await clickSel(`[data-role-switch="${r}"]`, 500);
  };

  await t.viewport(1440, 900);
  await t.goto();
  check(await waitFor('!!window.slgis', 10000), 'app boots');
  await ev('window.print = () => { window.__printed = (window.__printed || 0) + 1; }');

  // ------------------------------------------------------------------ 1. Boot, clock, sun, coordinates
  console.log('\n# 1. Boot, clock, sun, coordinates');
  const boot = await ev(`(() => ({
    markers: document.querySelectorAll('#map path.pole').length, role: document.body.dataset.role,
    views: [...document.querySelectorAll('[data-role-switch]')].map(b => b.textContent.trim()),
    switchTitle: document.querySelector('#view-switch').title,
    analysis: slgis.state.analysis, overlays: slgis.state.overlays,
    clockMin: Math.round((now().getTime() - new Date('2026-10-13T19:30+05:30').getTime()) / 60000),
    sun: [fmtTime(sunTimes('2026-10-13').sunrise), fmtTime(sunTimes('2026-10-13').sunset)], snap: META.snapshot_sun,
    nightsOk: Object.entries(META.night_hours_by_month).every(([m, h]) => Math.abs(nightHoursInMonth(m) - h) < 0.06),
  }))()`);
  check(boot.markers === 119 && boot.role === 'operator', 'boots in the Operator view with 119 pole markers', J([boot.markers, boot.role]));
  check(J(boot.views) === J(['Citizen', 'Operator', 'Field crew', 'Management']) && /not a login/i.test(boot.switchTitle), 'view switch: four views, tooltip says it is a demo switch', J(boot.views));
  check(Object.values(boot.analysis).every((v) => !v), 'all analyses off by default');
  check(boot.overlays.reports && boot.overlays.zone && ['shutdowns', 'landmarks', 'coverage', 'water', 'permits'].every((k) => !boot.overlays[k]), 'new overlays off by default (reports and zone as before)', J(boot.overlays));
  check(Math.abs(boot.clockMin) <= 2, '?now= demo clock: the app time starts at 19:30 IST', `${boot.clockMin} min off`);
  check(boot.sun[0] === boot.snap.sunrise.slice(11, 16) && boot.sun[1] === boot.snap.sunset.slice(11, 16), 'browser NOAA sunrise/sunset equal the generator (06:19 / 17:54)', J(boot.sun));
  check(boot.nightsOk, 'night hours per month match meta.night_hours_by_month (seasonal baseline)');
  const coords = await ev(`(() => {
    const same = (ll, c) => ll.lat === c[1] && ll.lng === c[0];
    let bad = 0;
    for (const r of slgis.state.byUid.values()) if (!same(r.latlng, r.feature.geometry.coordinates)) bad++;
    for (const l of landmarkRecs) if (!same(l.latlng, DATA.landmarks.features.find(f => f.properties.landmark_id === l.id).geometry.coordinates)) bad++;
    for (const w of waterRecs) if (!same(w.latlng, DATA.waterloggingSpots.features.find(f => f.properties.spot_id === w.id).geometry.coordinates)) bad++;
    for (const p of permitRecs) { const c = DATA.excavationPermits.features.find(f => f.properties.permit_id === p.id).geometry.coordinates; if (p.line.some((ll, i) => !same(ll, c[i]))) bad++; }
    const lt = slgis.state.tickets.get('TKT-2026-0175'); if (!same(lt.latlng, DATA.locationTickets.features[0].geometry.coordinates)) bad++;
    return bad;
  })()`);
  check(coords === 0, 'every pole, landmark, waterlogging spot, permit vertex and location ticket sits at its GeoJSON [lng, lat]', `${coords} mismatches`);
  const order = await ev(`[...roadOrder.values()].every(r => { const n = r.uids.map(u => +u.slice(-3)); return n.every((v, i) => i === 0 || v === n[i-1] + 1 || (r.closed && n[i-1] === n.length && v === 1)); })`);
  check(order, 'road order derived from geometry matches the generator\'s pole numbering (rings wrap around)');
  await t.sleep(6000);
  await t.shot('r2-01-operator.png');

  // ------------------------------------------------------------------ 2. README rows (Operator view)
  console.log('\n# 2. README rows still true (Operator view)');
  await clickPole('SL-CP-OC-031');
  const sb = await ev(`(() => ({ title: document.querySelector('#sb-title')?.textContent, covers: document.querySelectorAll('.card--ticket [data-action="select-pole"]').length,
    sections: [...document.querySelectorAll('.sb-h')].map(h => h.textContent.trim()), hash: location.hash, popups: document.querySelectorAll('.leaflet-popup').length,
    why: document.querySelector('.why')?.textContent, assigned: [...document.querySelectorAll('.card--ticket .kv dd')][1]?.textContent }))()`);
  check(sb.title === 'SL-CP-OC-031' && sb.popups === 0 && sb.hash === '#SL-CP-OC-031', 'click a pole: sidebar (not a popup), hash follows the selection', J([sb.title, sb.hash]));
  check(['Pole & fixture', 'Electrical', 'Energy', 'Maintenance contractor'].every((s) => sb.sections.some((x) => x.startsWith(s))) && sb.sections.some((x) => x.startsWith('Repair history')), 'pole, fixture, feeder, energy, contractor and repair history shown', J(sb.sections));
  check(sb.covers === 4, 'outage ticket covers the 4 other dark poles');
  check(/cable fault/.test(sb.why ?? '') && /cable & panel/.test(sb.assigned ?? ''), 'C1: cable fault routed to the cable & panel team, with a why line', `${sb.why} | ${sb.assigned}`);
  await t.shot('r2-02-pole.png');

  // report a fault on a working pole, snapping from a nearby click
  await closeSb();
  await clickSel('#report-btn');
  const crosshair = await ev(`document.querySelector('#map').classList.contains('is-reporting') && !document.querySelector('#report-hint').hidden`);
  check(crosshair, 'Report an issue: crosshair cursor and hint');
  const p2 = await centrePole('SL-CP-IC-002');
  await t.click(p2.x + 22, p2.y + 6); // a few metres off the pole
  await t.sleep(500);
  const modal = await ev(`(() => ({ open: !document.querySelector('#report-modal').hidden, chips: document.querySelectorAll('#rm-issues input').length,
    loc: document.querySelector('#rm-location').innerText, labels: [...document.querySelectorAll('#rm-issues label')].map(l => l.innerText.trim()) }))()`);
  check(modal.open && /SL-CP-IC-002/.test(modal.loc) && /Nearest light/.test(modal.loc), 'click near a pole snaps to it and opens the form', modal.loc.replace(/\n/g, ' '));
  check(modal.chips === 8, 'B2: categories shown as 8 tappable chips', J(modal.labels));
  await clickSel('#report-form button[type="submit"]');
  check(await ev(`!document.querySelector('#rm-issue-error').hidden`), 'only the category is required: submitting without one asks for it');
  await clickSel('#rm-issues input[value="flickering"] + span');
  await clickSel('#report-form button[type="submit"]', 700);
  const filed = await ev(`(() => { const p = props('SL-CP-IC-002'); return { status: p.status, t: p.ticket && { id: p.ticket.id, cat: p.ticket.category, team: p.ticket.team, prio: p.ticket.priority, src: p.ticket.source }, toast: document.querySelector('.toast-title')?.textContent }; })()`);
  check(filed.t && filed.t.cat === 'flickering' && filed.t.team === 'lamp' && filed.t.src === 'Call centre', 'report raises a lamp ticket', J(filed));
  const band = await ev(`props('SL-CP-IC-002').ticket.confidence.band`);
  check(band === 'Needs check' && filed.status === 'Functional' && await ev(`!document.querySelector('[data-action="dispatch"]') && !!document.querySelector('.check-steps')`),
    'its CCMS node shows the lamp on: Needs check, cheapest check first, pole status unchanged', `${band}, ${filed.status}`);

  // dispatch -> close -> awaiting dusk check -> CCMS confirms -> functional (OC-012: CCMS reported the lamp off)
  const newId = await ev(`props('SL-CP-OC-012').ticket.id`);
  await ev(`selectPole('SL-CP-OC-012')`);
  await t.sleep(300);
  await clickSel('[data-action="dispatch"]', 500);
  check(await ev(`props('SL-CP-OC-012').status === 'Under Maintenance' && props('SL-CP-OC-012').ticket.status === 'In Progress'`), 'Dispatch: pole under maintenance');
  await clickSel('[data-action="resolve"]', 500);
  const awaiting = await ev(`(() => { const p = props('SL-CP-OC-012'); return { status: p.status, t: p.ticket?.status, text: document.querySelector('.dusk')?.innerText }; })()`);
  check(awaiting.t === 'Awaiting dusk check' && awaiting.status === 'Under Maintenance', 'D3: closing puts the ticket in "Awaiting dusk check"; the pole stays under maintenance', J(awaiting));
  check(/CCMS/.test(awaiting.text ?? ''), 'CCMS pole: the node confirms after dark', awaiting.text);
  await ev(`(() => { const t = props('SL-CP-OC-012').ticket; t.closed_at = new Date(now().getTime() - 20 * 60000).toISOString(); tick(); })()`);
  const done = await ev(`(() => { const p = props('SL-CP-OC-012'); return { status: p.status, ticket: p.ticket, last: p.repair_history[0] }; })()`);
  check(done.status === 'Functional' && !done.ticket && done.last.ticket_id === newId && done.last.verified_by === 'CCMS', 'after the simulated CCMS confirmation: Functional, repair logged', J({ s: done.status, h: done.last.ticket_id, v: done.last.verified_by }));

  // heatmap + dark spots
  await closeSb();
  await t.sleep(600);
  await clickSel('[data-analysis="heatmap"]', 900);
  const heat = await ev(`(() => ({ canvas: !!document.querySelector('canvas.leaflet-heatmap-layer'), pts: slgis.layers.heat._latlngs.length,
    labels: [...document.querySelectorAll('.ds-label')].map(e => e.textContent), lead: document.querySelector('#insights-heatmap .insight-lead')?.textContent,
    spots: slgis.state.darkSpots.map(s => s.id + ':' + s.diagnosis.short) }))()`);
  check(heat.canvas && heat.pts === 20, 'heatmap from the faulty poles (21 in the data, less OC-012 just repaired)', J([heat.canvas, heat.pts]));
  check(heat.labels.length === 7 && heat.labels.every((l) => /^DS-\d+ · \d+ m unlit$/.test(l)), 'A1: each dark spot labelled with its unlit length', J(heat.labels));
  check(/7 unlit stretches/.test(heat.lead ?? ''), 'insights give the count and total unlit road', heat.lead);
  check(heat.spots[0] === 'DS-1:Probable cable fault after pole #2', 'README: "probable cable fault after pole #2"', heat.spots[0]);
  await clickSel('[data-action="open-spot"][data-spot="DS-1"]', 800);
  const spotTxt = await sidebarText();
  check(/218|220/.test(spotTxt) && /City Water Utility/.test(spotTxt), 'F3: DS-1 root cause names the active excavation nearby', spotTxt.match(/Active excavation[^.]*\./)?.[0]);
  await t.shot('r2-03-darkspots.png');
  await clickSel('[data-analysis="heatmap"]', 400);

  // energy layer
  await clickSel('[data-analysis="energy"]', 700);
  const energy = await ev(`(() => { const r = [...slgis.state.byUid.values()].map(x => x.marker.getRadius()); return { min: Math.min(...r), max: Math.max(...r),
    anomalies: document.querySelectorAll('#insights-energy [data-action="select-pole"]').length, baseline: document.querySelector('#insights-energy')?.innerText.match(/Baseline[^\\n]*/)?.[0] }; })()`);
  check(energy.max > energy.min * 2 && energy.anomalies >= 2, 'energy layer: proportional symbols, day-burning anomalies listed', J(energy));
  check(/sunset to sunrise/.test(energy.baseline ?? ''), 'E5: baseline is that month\'s sunset-to-sunrise hours', energy.baseline);
  await clickSel('[data-analysis="energy"]', 400);

  // feeder network + trace + festive load
  await clickSel('[data-analysis="feeder"]', 700);
  await clickSel('#insights-feeder [data-panel="FP-CP-07"]', 900);
  const panel = await ev(`(() => ({ title: document.querySelector('#sb-title')?.textContent, chip: document.querySelector('#map-chip')?.innerText, text: document.querySelector('#sidebar-content').innerText }))()`);
  check(panel.title === 'FP-CP-07' && /Tracing/.test(panel.chip ?? ''), 'feeder panel opens and traces its poles', panel.chip);
  check(/Festive season peak/.test(panel.text) && /Above 80% of capacity/.test(panel.text), 'F4: festive load against capacity, warning above 80%', panel.text.match(/Festive season peak[^\n]*\n?[^\n]*/)?.[0]);
  await t.shot('r2-04-feeder.png');
  await t.key('Escape', 'Escape', 27);
  await t.sleep(300);
  check(await ev(`!slgis.state.trace`), 'Esc stops the trace first');
  await t.key('Escape', 'Escape', 27);
  await t.sleep(300);
  check(await ev(`!document.body.classList.contains('sidebar-open')`), 'next Esc closes the sidebar');
  await clickSel('[data-analysis="feeder"]', 400);

  // search + legend filter
  await t.key('/', 'Slash', 191);
  await t.type('OC-046');
  await t.sleep(300);
  await t.key('Enter', 'Enter', 13);
  await t.sleep(700);
  check(await ev(`document.querySelector('#sb-title')?.textContent === 'SL-CP-OC-046'`), '"/" then type and Enter selects a pole');
  await closeSb();
  await clickSel('[data-filter="Faulty"]', 300);
  check(await ev(`document.querySelectorAll('#map path.pole--fault').length === 0`), 'legend click hides faulty poles');
  await clickSel('[data-filter="Faulty"]', 300);

  // hash links
  await ev(`location.hash = '#SL-CP-MC-019'`);
  await t.sleep(700);
  check(await ev(`document.querySelector('#sb-title')?.textContent === 'SL-CP-MC-019' && slgis.state.role === 'operator'`), 'existing #UID link opens the pole in the Operator view');
  await ev(`location.hash = '#FP-CP-02'`);
  await t.sleep(700);
  check(await ev(`document.querySelector('#sb-title')?.textContent === 'FP-CP-02'`), '#FP-CP-02 opens the feeder panel');
  await ev(`setAnalysis('feeder', false); closeSidebar()`);

  // ------------------------------------------------------------------ 3. Operator triage
  console.log('\n# 3. Operator triage (C1–C5)');
  await clickSel('#role-block [data-action="open-queue"]', 600);
  const queue = await ev(`(() => ({ groups: [...document.querySelectorAll('.queue-h')].map(h => h.textContent), first: [...document.querySelectorAll('.queue-item')].slice(0, 2).map(b => b.querySelector('.mono').textContent),
    shutdown: document.querySelector('#sidebar-content .callout')?.innerText, why: document.querySelector('.queue-item')?.innerText }))()`);
  check(/^Safety emergencies · 2$/.test(queue.groups[0]) && J(queue.first) === J(['TKT-2026-0172', 'TKT-2026-0178']), 'C5: emergencies pinned on top of the queue', J(queue));
  check(/Planned shutdown until 21:00/.test(queue.shutdown ?? ''), 'C2: queue says which planned shutdown is on', queue.shutdown);
  check(await ev(`(() => { const t = [...slgis.state.tickets.values()].find(x => x.circuit?.panelId === 'FP-CP-03'); return !!t && t.team === 'cable' && ['TKT-2026-0170', 'TKT-2026-0176', 'TKT-2026-0177'].every(id => !slgis.state.tickets.has(id) && t.merged_from.includes(id)); })()`), 'C1: three lamp tickets on FP-CP-03/C2 collapsed into one electrical ticket');
  const esc = await ev(`(() => { const t = slgis.state.tickets.get('TKT-2026-0172'); return t.escalation.level + ' ' + t.sla_hours + 'h ' + t.priority; })()`);
  check(esc === 'EE 4h Critical', 'C4: emergency past 2× its 4 h SLA is with the EE', esc);
  await t.sleep(500); await clickSel('.queue-item[data-ticket="TKT-2026-0172"]', 900);
  const back = await ev(`({ title: document.querySelector('#sb-title')?.textContent, back: document.querySelector('.back-btn')?.textContent.trim() })`);
  check(back.title === 'SL-CP-IC-022' && back.back === 'Queue', 'queue item opens the pole with a Back button', J(back));
  await t.key('Escape', 'Escape', 27);
  await t.sleep(400);
  check(await ev(`document.querySelector('#sb-title')?.textContent === 'Ticket queue'`), 'Esc steps back to the queue');
  await t.shot('r2-05-queue.png');
  // shutdown overlay and halos
  const held = await ev(`(() => { const r = slgis.state.byUid.get('SL-CP-OC-001'); return { halo: slgis.layers.halo.hasLayer(r.halo), status: r.feature.properties.status }; })()`);
  check(held.status === 'Functional' && !held.halo, 'C2: poles in the planned shutdown keep their status but show no light', J(held));
  await ev(`setOverlay('shutdowns', true)`);
  check(await ev(`slgis.layers.shutdowns.getLayers().length === 2`), 'shutdown overlay marks the two switched-off circuits');
  await ev(`setOverlay('shutdowns', false); closeSidebar()`);

  // ------------------------------------------------------------------ 4. Citizen view (B2–B5)
  console.log('\n# 4. Citizen view');
  await role('citizen');
  const cit = await ev(`(() => ({ hash: location.hash, kpis: !!document.querySelector('#role-block .kpis'), myReports: !!document.querySelector('[data-action="open-myreports"]'),
    cta: !document.querySelector('#report-btn').hidden && !document.querySelector('#report-btn').classList.contains('report-cta--quiet'),
    analyses: [...document.querySelectorAll('[data-analysis-row]')].filter(r => !r.hidden).length, overlays: [...document.querySelectorAll('#overlay-list [data-overlay]')].map(b => b.dataset.overlay),
    placeholder: document.querySelector('#search').placeholder }))()`);
  check(cit.hash === '#view=citizen' && !cit.kpis && cit.myReports && cit.cta, 'Citizen: no KPIs, My reports, report button is the primary action, hash #view=citizen', J(cit));
  check(cit.analyses === 0 && J(cit.overlays) === J(['reports', 'zone']), 'Citizen: no analysis layers, no internal overlays', J(cit.overlays));
  await clickPole('SL-CP-OC-031');
  const citPole = await sidebarText();
  check(/Already reported/.test(citPole) && !/TKT-|contractor|kWh|Escalation|Crew/i.test(citPole), 'citizen pole view: plain status, no ticket internals, energy or contractor data', citPole.replace(/\n/g, ' | '));
  await closeSb();
  // Hindi
  await clickSel('[data-lang="hi"]', 400);
  const hi = await ev(`({ lang: document.documentElement.lang, cta: document.querySelector('.fab-label').textContent, ph: document.querySelector('#search').placeholder, legend: document.querySelector('#legend-status').innerText })`);
  check(hi.lang === 'hi' && hi.cta === 'शिकायत दर्ज करें' && /बत्ती/.test(hi.ph) && /चालू/.test(hi.legend), 'B5: हिन्दी switches the citizen strings (button, search, legend)', J(hi));
  // report on a pole in the planned shutdown -> logged, not dispatched
  await clickSel('#report-btn');
  const p3 = await centrePole('SL-CP-OC-005');
  await t.click(p3.x, p3.y);
  await t.sleep(500);
  const holdTxt = await ev(`document.querySelector('#rm-location').innerText`);
  check(/21:00/.test(holdTxt) && /नियोजित/.test(holdTxt), 'C2: citizen sees "planned power shutdown until 21:00" (in Hindi here)', holdTxt.replace(/\n/g, ' '));
  await clickSel('#rm-issues input[value="not_working"] + span');
  await clickSel('#report-form button[type="submit"]', 700);
  const logged = await ev(`(() => { const r = slgis.state.reports.at(-1); return { held: !!r.held_until, ticket: r.ticket_id, poleTicket: props('SL-CP-OC-005').ticket, view: slgis.state.selected?.type }; })()`);
  check(logged.held && !logged.ticket && !logged.poleTicket && logged.view === 'myreports', 'report during a shutdown is logged, not dispatched; My reports opens', J(logged));
  await clickSel('[data-lang="en"]', 300);
  // duplicate: pole with an open ticket
  const before = await ev(`slgis.state.tickets.get('TKT-2026-0159').complaints`);
  await closeSb();
  await clickSel('#report-btn');
  const p4 = await centrePole('SL-CP-IC-010');
  await t.click(p4.x, p4.y);
  await t.sleep(400);
  const already = await ev(`document.querySelector('#rm-location').innerText`);
  await clickSel('#rm-issues input[value="not_working"] + span');
  await clickSel('#report-form button[type="submit"]', 700);
  const after = await ev(`({ n: slgis.state.tickets.get('TKT-2026-0159').complaints, toast: document.querySelector('.toast:last-child .toast-title')?.textContent })`);
  check(/Already reported/.test(already) && after.n === before + 1, 'B3: a report on a pole with an open ticket adds +1 report', `${before} -> ${after.n}; ${after.toast}`);
  // duplicate: location-only report within 30 m of the open location ticket
  await closeSb();
  await clickSel('#report-btn');
  const loc = await ev(`(() => { const ll = slgis.state.tickets.get('TKT-2026-0175').latlng; void slgis.map.setView(ll, 19, { animate: false }); const p = slgis.map.latLngToContainerPoint(ll); return { x: p.x, y: p.y }; })()`);
  await t.sleep(300);
  await t.click(loc.x + 30, loc.y + 10);
  await t.sleep(400);
  const locTxt = await ev(`document.querySelector('#rm-location').innerText`);
  await clickSel('#rm-issues input[value="not_working"] + span');
  await clickSel('#report-form button[type="submit"]', 700);
  const merged = await ev(`({ n: slgis.state.tickets.get('TKT-2026-0175').complaints, r: slgis.state.reports.at(-1).ticket_id })`);
  check(/No light within/.test(locTxt) && merged.r === 'TKT-2026-0175' && merged.n === 2, 'B3: a location-only report near an open location ticket merges into it', J(merged));
  // my reports + fixed? no -> reopen
  await closeSb();
  await clickSel('[data-action="open-myreports"]', 500);
  const mine = await sidebarText();
  check(/Simulated/.test(mine) && /Fixed\?/.test(mine) && /Logged · planned shutdown until 21:00/.test(mine), 'B4: My reports lists the reports, asks "Fixed?" and says it is simulated', mine.split('\n').slice(0, 6).join(' | '));
  await clickSel('[data-action="fixed-no"][data-report="CR-S02"]', 700);
  const reopened = await ev(`(() => { const p = props('SL-CP-IC-007'); return { status: p.status, ticket: p.ticket?.id, tStatus: p.ticket?.status, hist: p.repair_history.find(h => h.ticket_id === 'TKT-2026-0157')?.reopened_at ? 'linked' : 'missing' }; })()`);
  const reBand = await ev(`props('SL-CP-IC-007').ticket?.confidence.band`);
  check(reopened.ticket === 'TKT-2026-0157' && reopened.tStatus === 'Open' && reopened.hist === 'linked', 'answering "No" reopens the same ticket, history kept', J(reopened));
  check(reBand === 'Needs check' && reopened.status === 'Functional', 'its CCMS node shows the lamp on, so the reopened ticket needs a check first', `${reBand}, ${reopened.status}`);
  await t.shot('r2-06-myreports.png');
  // deep link from a QR label
  await closeSb();
  await ev(`location.hash = '#report=SL-CP-MC-014'`);
  await t.sleep(900);
  const deep = await ev(`({ role: slgis.state.role, modal: !document.querySelector('#report-modal').hidden, loc: document.querySelector('#rm-location').innerText, hash: location.hash })`);
  check(deep.role === 'citizen' && deep.modal && /SL-CP-MC-014/.test(deep.loc) && !/report=/.test(deep.hash), 'B1: #report=<UID> opens the report form for that pole', J({ ...deep, loc: deep.loc.slice(0, 30) }));
  await t.key('Escape', 'Escape', 27);
  await t.sleep(300);
  check(await ev(`document.querySelector('#report-modal').hidden`), 'Esc closes the form');

  // ------------------------------------------------------------------ 5. Operator: split a merged report, labels
  console.log('\n# 5. Operator: split, labels');
  await role('operator');
  await ev(`openTicket('TKT-2026-0175')`);
  await t.sleep(500);
  const splitBtn = await ev(`!!document.querySelector('[data-action="split"]')`);
  check(splitBtn, 'merged reports can be split out by the operator');
  if (splitBtn) {
    const sessionReport = await ev(`slgis.state.reports.at(-1).id`);
    await clickSel(`[data-action="split"][data-report="${sessionReport}"]`, 600);
    const split = await ev(`(() => { const r = slgis.state.reports.at(-1); const t = slgis.state.tickets.get(r.ticket_id); return { id: r.ticket_id, kind: t?.kind, old: slgis.state.tickets.get('TKT-2026-0175').complaints }; })()`);
    check(split.id !== 'TKT-2026-0175' && split.kind === 'location' && split.old === 1, 'split gives the report its own ticket', J(split));
  }
  await ev(`openLabels()`);
  await t.sleep(400);
  const labels = await ev(`({ text: document.querySelector('#sidebar-content').innerText, disabled: document.querySelector('[data-action="print-labels"]').disabled })`);
  if (await ev('BASE_URL')) check(!/Set a hosting URL first/.test(labels.text) && !labels.disabled, 'B1: with BASE_URL set the label sheet is ready to print', labels.text.split('\n').slice(2, 4).join(' '));
  else check(/Set a hosting URL first/.test(labels.text) && labels.disabled, 'B1: with BASE_URL empty the label sheet says a hosting URL is needed', labels.text.split('\n').slice(2, 4).join(' '));
  await closeSb();

  // ------------------------------------------------------------------ 6. Field crew (D1–D4)
  console.log('\n# 6. Field crew');
  await role('field');
  const fieldHead = await ev(`({ crew: document.querySelector('[data-field="crew-select"]')?.value, tiles: [...document.querySelectorAll('#role-block .stat-label')].map(e => e.textContent), cta: document.querySelector('#report-btn').hidden, hash: location.hash })`);
  check(fieldHead.crew === 'R2 · Deepak R.' && fieldHead.cta && fieldHead.hash === '#view=field', 'Field crew: crew picker, job tiles, no report button', J(fieldHead));
  await clickSel('#role-block [data-action="open-workorder"]', 900);
  const wo = await ev(`({ stops: document.querySelectorAll('.stop').length, label: [...document.querySelectorAll('.sb-h')].map(h => h.textContent).join('|'), spares: [...document.querySelectorAll('.job .spares')].map(e => e.textContent),
    route: slgis.layers.route.getLayers().length, legend: /Suggested order/.test(document.querySelector('#legend-extra').innerText) })`);
  check(wo.stops === 5 && /Suggested order/.test(wo.label), 'D2: work order in suggested order (5 stops)', J(wo.label));
  check(wo.route === 6 && wo.legend, 'route drawn on the map while the work order is open', `${wo.route} layers`);
  check(wo.spares.length >= 4 && wo.spares.every((s) => /^Carry: /.test(s)), 'D1: lamp jobs show what to carry', J(wo.spares.slice(0, 2)));
  await t.shot('r2-07-workorder.png');
  // close OC-039 (HPS, no CCMS) and verify with a night photo
  await ev(`(() => { const btn = [...document.querySelectorAll('.job')].find(j => /SL-CP-OC-039|OC-039/.test(j.innerText))?.querySelector('[data-action="resolve"]'); btn.scrollIntoView({ block: 'center' }); })()`);
  await t.sleep(200);
  const resolveBox = await ev(`(() => { const b = [...document.querySelectorAll('.job')].find(j => /OC-039/.test(j.innerText)).querySelector('[data-action="resolve"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await t.click(resolveBox.x, resolveBox.y);
  await t.sleep(700);
  const oc39 = await ev(`(() => { const t = slgis.state.tickets.get('TKT-2026-0165'); return { status: t.status, input: !!document.querySelector('input[data-change="dusk-photo"][data-ticket="TKT-2026-0165"]') }; })()`);
  check(oc39.status === 'Awaiting dusk check' && oc39.input, 'non-CCMS repair asks for a night photo after dark', J(oc39));
  await setFile('input[data-change="dusk-photo"][data-ticket="TKT-2026-0165"]', PHOTO);
  const photo = await ev(`({ img: !!document.querySelector('.dusk img.photo-preview'), at: slgis.state.tickets.get('TKT-2026-0165')?.dusk_photo?.at, text: [...document.querySelectorAll('.dusk')].map(d => d.innerText).join(' ') })`);
  check(photo.img && photo.at && /taken/.test(photo.text), 'photo kept in memory with its time shown', photo.text.slice(0, 80));
  await clickSel('[data-action="confirm-dusk"][data-ticket="TKT-2026-0165"]', 700);
  const oc39b = await ev(`({ status: props('SL-CP-OC-039').status, open: slgis.state.tickets.has('TKT-2026-0165'), h: props('SL-CP-OC-039').repair_history[0].verified_by })`);
  check(oc39b.status === 'Functional' && !oc39b.open && oc39b.h === 'Night photo', 'confirmed lit: ticket closes for good, pole Functional', J(oc39b));
  // night audit
  await closeSb();
  await clickSel('#role-block [data-action="open-audit"]', 800);
  const audit1 = await ev(`({ text: document.querySelector('#sidebar-content').innerText, lit: document.querySelector('.audit-btn--lit')?.getBoundingClientRect().height })`);
  check(/Pole 1 of 48/i.test(audit1.text) && audit1.lit >= 60, 'D4: night audit walks the 48 non-CCMS poles with large Lit / Dark buttons', audit1.text.match(/Pole \d+ of \d+/)?.[0]);
  await t.sleep(900);
  await clickSel('.audit-btn--lit', 700);
  const auditPole = await ev(`auditUid()`);
  const hadTicket = await ev(`!!props(auditUid()).ticket`);
  await clickSel('.audit-btn--dark', 700);
  const audit2 = await ev(`({ results: slgis.state.audit.results, tickets: slgis.state.audit.tickets, text: document.querySelector('#sidebar-content').innerText.match(/\\d+ of 48 checked[^\\n]*/)?.[0] })`);
  check(Object.keys(audit2.results).length === 2 && audit2.tickets.length === 1, '"Dark" files a report through the same duplicate merging', `${auditPole} (had ticket: ${hadTicket}) -> ${audit2.tickets[0]?.text}; ${audit2.text}`);
  await t.shot('r2-08-audit.png');
  await closeSb();

  // ------------------------------------------------------------------ 7. Management (A1, E1–E4, F1, F2)
  console.log('\n# 7. Management');
  await role('management');
  const mg = await ev(`({ tiles: [...document.querySelectorAll('#role-block .stat')].map(e => e.innerText.replace(/\\n/g, ' ')), cta: document.querySelector('#report-btn').hidden })`);
  check(mg.tiles.length === 3 && /Uptime/.test(mg.tiles[0]) && /Unlit road/.test(mg.tiles[1]) && /SLA met/.test(mg.tiles[2]) && mg.cta, 'Management: uptime, unlit road and SLA tiles; no report button', J(mg.tiles));
  await clickSel('#role-block [data-section="unlit"]', 800);
  const dash = await ev(`({ sections: [...document.querySelectorAll('.sb-fold summary')].map(s => s.textContent.trim()), open: document.querySelector('details[data-fold="unlit"]').open,
    text: document.querySelector('#sidebar-content').innerText })`);
  check(dash.open && /Road length between lit poles/.test(dash.text), 'A1: zone total of unlit road in the Management view', dash.text.match(/\d+\s*m\s*\n/)?.[0]);
  check(J(dash.sections) === J(['Uptime', 'Unlit road', 'Contractor scorecard', 'Chronic poles and batches', 'Energy reconciliation', 'Readiness', 'Citizen reports']), 'dashboard sections, folded except the one asked for', J(dash.sections));
  await ev(`document.querySelectorAll('.sb-fold').forEach(d => d.open = true)`);
  await t.sleep(300);
  const full = await sidebarText();
  check(/By road/i.test(full) && /By contractor/i.test(full) && /Pilot zone/.test(full), 'E1: uptime per month for the zone, roads and contractors');
  check(/SLA met/.test(full) && /Mean time to repair/.test(full) && /Repeat failures/.test(full) && /Example deduction/.test(full) && /example rule/i.test(full), 'E2: contractor scorecard with an example payment rule, labelled');
  check(/Check cable, voltage or water ingress, not the lamp/.test(full) && /ARB-2203/.test(full) && /under the supplier warranty/.test(full), 'E3: chronic poles, batch failure rates, warranty');
  check(/Unexplained consumption/.test(full) && /FP-CP-03/.test(full) && /illegal tapping, leakage to earth, or a meter fault/.test(full), 'E4: unexplained consumption flagged with neutral causes');
  await t.shot('r2-09-dashboard.png');
  await clickSel('[data-action="highlight-monsoon"]', 900);
  const hl = await ev(`({ chip: document.querySelector('#map-chip').innerText, n: slgis.state.highlight?.uids.size, water: slgis.state.overlays.water })`);
  check(hl.n === 21 && /due before monsoon/.test(hl.chip) && hl.water, 'F1: "Due before monsoon" picks out 21 poles and shows waterlogging spots', J(hl));
  await t.key('Escape', 'Escape', 27);
  await t.sleep(300);
  check(await ev(`!slgis.state.highlight`), 'Esc clears the highlight');
  await ev(`openEvent()`);
  await t.sleep(400);
  await clickSel('[data-action="event-road"][data-road="Outer Circle"]', 500);
  const evRes = await ev(`({ text: document.querySelector('#sidebar-content').innerText.match(/Poles\\n\\d+[\\s\\S]*?Tickets\\n\\d+/)?.[0].replace(/\\n/g, ' '), items: document.querySelectorAll('#sidebar-content .insight-item').length })`);
  check(evRes.items >= 5, 'F2: pick a road, get its non-functional poles and open tickets', evRes.text);
  await clickSel('[data-action="event-print"]', 400);
  check(await ev(`window.__printed === 1 && /Event check/.test(document.querySelector('#print-sheet').innerText)`), 'event list is printable');
  // draw a route
  await clickSel('[data-action="event-road"][data-road="Outer Circle"]', 300);
  await clickSel('[data-action="event-draw"]', 300);
  await centrePole('SL-CP-IC-020', 17); await ev('void slgis.map.panBy([260, 0], { animate: false })'); await t.sleep(300);
  const a = await ev(`(() => { const p = slgis.map.latLngToContainerPoint(slgis.state.byUid.get('SL-CP-IC-020').latlng); return { x: p.x, y: p.y }; })()`);
  const b2 = await ev(`(() => { const p = slgis.map.latLngToContainerPoint(slgis.state.byUid.get('SL-CP-IC-023').latlng); return { x: p.x, y: p.y }; })()`);
  await t.click(a.x, a.y);
  await t.sleep(200);
  await t.click(b2.x, b2.y);
  await t.sleep(200);
  console.log('  drawing:', JSON.stringify(await ev(`({ d: slgis.state.drawing?.points.length, a: document.elementFromPoint(${a.x}, ${a.y})?.getAttribute('class'), sel: slgis.state.selected })`)));
  await clickSel('[data-action="draw-finish"]', 600);
  const drawn = await ev(`({ line: slgis.state.event.line?.length, nw: eventCheck(slgis.state.event).notWorking.map(p => p.uid.slice(-6)), layer: slgis.layers.eventRoute.getLayers().length })`);
  check(drawn.line === 2 && drawn.nw.includes('IC-022') && drawn.layer === 1, 'F2: draw a line on the map; poles along it are checked', J(drawn));
  await closeSb();
  // overlays: coverage gap, landmarks, water, permits
  await ev(`setOverlay('coverage', true); setOverlay('landmarks', true); setOverlay('permits', true)`);
  const ov = await ev(`({ gap: document.querySelectorAll('#map .gap-icon').length, lm: document.querySelectorAll('#map .landmark-icon').length, permits: slgis.layers.permits.getLayers().length })`);
  check(ov.gap === 1 && ov.lm === 28 && ov.permits === 3, 'A2/A3/F3 overlays: 1 coverage gap, 28 landmarks, 3 permits', J(ov));
  await ev(`void slgis.map.setView(slgis.state.byUid.get('SL-CP-R1-003').latlng, 18, { animate: false })`);
  await t.sleep(300);
  const gapAt = await ev(`(() => { const r = document.querySelector('#map .gap-icon').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await t.click(gapAt.x, gapAt.y);
  await t.sleep(700);
  const gap = await sidebarText();
  check(/Not a fault/.test(gap) && /70/.test(gap) && /example/i.test(gap), 'A2: coverage gap means "add a pole", example rule labelled', gap.split('\n').slice(0, 3).join(' | '));
  await t.shot('r2-10-gap.png');
  const lmTip = await ev(`(() => { const m = slgis.layers.landmarks.getLayers()[0]; m.openTooltip(); return document.querySelector('.leaflet-tooltip').innerText; })()`);
  check(/Approximate/.test(lmTip), 'landmark tooltip says the position is approximate', lmTip.replace(/\n/g, ' | '));
  await ev(`setOverlay('coverage', false); setOverlay('landmarks', false); setOverlay('permits', false); closeSidebar()`);

  // ------------------------------------------------------------------ 8. Operator pole view details and activity
  console.log('\n# 8. Pole details, warranty, activity');
  await role('operator');
  await ev(`selectPole('SL-CP-MC-019')`);
  await t.sleep(400);
  const mc19 = await sidebarText();
  check(/Under warranty/.test(mc19) && /Carry: 45 W LED fixture\/driver, 4000 K/.test(mc19), 'warranty badge and spares on a lamp ticket', mc19.match(/Carry:[^\n]*/)?.[0]);
  check(/Earthing check/.test(mc19) && /Junction box/.test(mc19) && /Make, batch/.test(mc19), 'new pole fields shown (make, batch, warranty, earthing, junction box)');
  await ev(`selectPole('SL-CP-IC-007')`);
  await t.sleep(300);
  await ev(`document.querySelector('details[data-fold="activity"]').open = true`);
  const act = await ev(`document.querySelector('details[data-fold="activity"]').innerText`);
  check(/Reopened/.test(act) && /Citizen/.test(act) && /Closed → Open|Closed\s*→\s*Open/.test(act.replace(/\n/g, ' ')), 'E6: Activity shows role, time, action and before → after', act.split('\n').slice(0, 4).join(' | '));
  await closeSb();

  // ------------------------------------------------------------------ 9. Phone width
  console.log('\n# 9. Phone width (390 × 844)');
  await t.viewport(390, 844, true);
  await t.sleep(500);
  await role('citizen');
  const ph = await ev(`(() => { const h = document.querySelector('#command').getBoundingClientRect(); const c = document.querySelector('#report-btn').getBoundingClientRect();
    return { headerH: Math.round(h.height), headerW: Math.round(h.width), cta: [Math.round(c.left), Math.round(c.right)], scrollW: document.scrollingElement.scrollWidth }; })()`);
  check(ph.headerW <= 366 && ph.cta[0] >= 0 && ph.cta[1] <= 390 && ph.scrollW <= 390, 'Citizen at 390 px: header fits, report button on screen, no sideways scroll', J(ph));
  await t.shot('r2-11-phone-citizen.png');
  await role('field');
  await clickSel('#role-block [data-action="open-workorder"]', 800);
  const sbw = await ev(`Math.round(document.querySelector('#sidebar').getBoundingClientRect().width)`);
  check(sbw === 390, 'Field crew at 390 px: the work order fills the screen', `${sbw}px`);
  await t.shot('r2-12-phone-workorder.png');
  await closeSb();
  await clickSel('#role-block [data-action="open-audit"]', 800);
  for (let i = 0; i < 30 && (await ev(`Math.round(document.querySelector('#sidebar').getBoundingClientRect().left)`)) !== 0; i++) await t.sleep(100); // let the slide-in finish
  const auditPh = await ev(`(() => { const b = document.querySelector('.audit-btn--dark').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; })()`);
  check(auditPh.h >= 60 && auditPh.w >= 150 && auditPh.right <= 390, 'night audit buttons are large and on screen at phone width', J(auditPh));
  await t.shot('r2-13-phone-audit.png');
  await closeSb();
  await role('operator');
  await t.shot('r2-14-phone-operator.png');
  await t.viewport(1440, 900);
  await t.sleep(400);
}
