// End-to-end test of round 3: report confidence and citizen-initiated public escalation.
// Run through run.mjs, which opens the app at 19:30 on the snapshot day.
import { fileURLToPath } from 'node:url';

const J = (v) => JSON.stringify(v);
const FIX = fileURLToPath(new URL('./fixtures', import.meta.url));

export default async function run(t, check) {
  const ev = (expr) => t.eval(expr);
  const box = (sel) => ev(`(() => { const el = document.querySelector(${J(sel)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const clickSel = async (sel, wait = 400) => {
    let b = await box(sel);
    for (let i = 0; i < 20 && b; i++) {
      await t.sleep(80);
      const next = await box(sel);
      if (next && Math.abs(next.x - b.x) < 0.5 && Math.abs(next.y - b.y) < 0.5) break;
      b = next;
    }
    if (!b) throw new Error(`no element ${sel}`);
    await t.click(b.x, b.y);
    await t.sleep(wait);
  };
  const exists = (sel) => ev(`!!document.querySelector(${J(sel)})`);
  const text = (sel = '#sidebar-content') => ev(`document.querySelector(${J(sel)})?.innerText ?? ''`);
  const role = async (r) => clickSel(`[data-role-switch="${r}"]`, 600);
  const closeSb = async () => { await ev('closeSidebar()'); await t.sleep(450); };
  const setFile = async (selector, file) => {
    const { root } = await t.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await t.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    await t.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await t.sleep(500);
  };
  const clickPole = async (uid) => {
    await ev(`void slgis.map.setView(slgis.state.byUid.get(${J(uid)}).latlng, 18, { animate: false })`);
    await ev('void slgis.map.panBy([320, 0], { animate: false })'); // clear of panels that slide beside an open sidebar
    await t.sleep(300);
    const p = await ev(`(() => { const p = slgis.map.latLngToContainerPoint(slgis.state.byUid.get(${J(uid)}).latlng); return { x: p.x, y: p.y }; })()`);
    await t.click(p.x, p.y);
    await t.sleep(600);
  };
  const conf = (id) => ev(`(() => { const t = slgis.state.tickets.get(${J(id)}) ?? slgis.state.closed.get(${J(id)}); if (!t) return null; const c = t.confidence ?? {};
    return { band: c.bypass ? 'bypass' : c.final ?? c.band, signals: (c.signals ?? []).map(s => (s.effect > 0 ? '+' : s.effect < 0 ? '-' : '0') + s.text), notes: c.notes ?? [], why: t.why, score: t.score, status: t.status }; })()`);

  await t.viewport(1440, 900);
  await t.goto();
  for (let i = 0; i < 40 && !(await ev('!!window.slgis')); i++) await t.sleep(250);
  await ev(`window.print = () => {}; window.__opened = []; window.open = (url) => { window.__opened.push(url); return null; }`);
  await t.sleep(1500);

  // ------------------------------------------------------------------ 1. Bands from the demo data
  console.log('\n# 1. Report confidence on the demo data (Operator)');
  const c159 = await conf('TKT-2026-0159');
  check(c159.band === 'Confirmed' && c159.signals.some((s) => s === '+CCMS: lamp off at its last switch-on'), 'IC-010: confirmed by CCMS', J(c159.signals.slice(0, 3)));
  const c162 = await conf('TKT-2026-0162');
  check(c162.band === 'Confirmed' && /Raised by a CCMS alert/.test(c162.signals.join()), 'OC-031–035: raised by CCMS, confirmed', c162.signals[0]);
  const c156 = await conf('TKT-2026-0156');
  check(c156.signals.includes('+2 independent reporters'), 'OC-046: two independent reporters add support', `${c156.band}: ${c156.signals.join(' | ')}`);
  const c179 = await conf('TKT-2026-0179');
  check(c179.band === 'Needs check' && c179.signals.includes('-CCMS: lamp on at its last switch-on (CCMS can be wrong)') && await ev(`props('SL-CP-OC-016').status === 'Functional'`),
    'OC-016: contradicted by CCMS → Needs check, the pole keeps its status', J(c179.signals.slice(0, 2)));
  check(c179.score === 24 && c159.score === 40, 'confidence nudges priority a little (Needs check −6, Confirmed +6)', `${c179.score} (${c179.why}) / ${c159.score} (${c159.why})`);
  const c158 = await conf('TKT-2026-0158');
  check(c158.signals.concat(c158.notes).some((s) => /Photo matches report CR-D11/.test(s)), 'MC-020: the reused photo is flagged "Photo matches report CR-D11"', J(c158.signals.concat(c158.notes).filter((s) => /Photo/.test(s))));
  check((await conf('TKT-2026-0172')).band === 'bypass', 'safety emergencies are not scored');
  check(await ev(`(() => { const r = ['CR-D16'].map(id => slgis.state.reporters.get(slgis.state.reports.find(x => x.id === id).reporter_id))[0]; return r.past_reports === 0; })()`), 'first-time reporter (OC-016) starts neutral');
  const hist = await ev(`props('SL-CP-MC-004').repair_history.find(h => h.outcome === 'different_pole')?.reported_uid`);
  check(hist === 'SL-CP-MC-003', 'a "Different pole" correction sits in MC-004\'s history', hist);
  await clickSel('#role-block [data-action="open-queue"]', 700);
  const queue = await ev(`({ bands: document.querySelectorAll('.queue-item .band').length, public: [...document.querySelectorAll('.queue-item')].filter(b => /Public/.test(b.innerText)).map(b => b.querySelector('.mono').textContent) })`);
  check(queue.bands === 1 && J(queue.public) === J(['TKT-2026-0154']), 'queue rows flag "Needs check"; the shared ticket is marked "Public"', J(queue));
  await t.shot('r3-01-queue.png');

  // ------------------------------------------------------------------ 2. Cheapest check first
  console.log('\n# 2. Needs check: cheapest check first');
  await ev(`selectPole('SL-CP-OC-016')`);
  await t.sleep(500);
  await ev(`document.querySelector('details.evidence').open = true`);
  const card = await text();
  check(/Needs check/.test(card) && /✗CCMS: lamp on at its last switch-on/.test(card.replace(/\s+/g, ' ').replace(/✗ contradicts: /g, '✗')) && !(await exists('[data-action="dispatch"]')), 'ticket card: band, folded "Why" with ✓ / – / ✗, no dispatch offered', card.match(/Needs check[\s\S]{0,140}/)?.[0].replace(/\n/g, ' | '));
  await t.shot('r3-02-needs-check.png');
  check((await ev(`document.querySelector('[data-action^="check-"]')?.textContent.trim()`)) === 'Poll CCMS (simulated)', 'first step: poll CCMS (simulated)');
  await clickSel('[data-action="check-ccms"]', 700);
  const after = await ev(`({ poll: slgis.state.tickets.get('TKT-2026-0179').ccms_poll?.state, band: slgis.state.tickets.get('TKT-2026-0179').confidence.band, next: document.querySelector('[data-action^="check-"]')?.textContent.trim() })`);
  check(after.poll === 'on' && after.band === 'Needs check' && /night audit/.test(after.next ?? ''), 'CCMS poll says on: still Needs check; next, the night audit', J(after));
  await clickSel('[data-action="check-audit"]', 700);
  check(/Waiting for the night audit/.test(await text()), 'added to the night audit; the ticket waits for it');
  await role('field');
  await clickSel('#role-block [data-action="open-audit"]', 800);
  const audit = await ev(`({ n: auditPoles().length, i: auditPoles().indexOf('SL-CP-OC-016') })`);
  check(audit.n === 49 && audit.i >= 0, 'the night audit route now includes OC-016', J(audit));
  await ev(`slgis.state.audit.index = ${audit.i}; renderSelected(); focusAuditPole()`);
  await t.sleep(700);
  check(/Check for TKT-2026-0179/.test(await text()), 'the audit card says why this pole is on the route');
  await clickSel('.audit-btn--lit', 900);
  const settled = await ev(`(() => { const t = slgis.state.closed.get('TKT-2026-0179'); const r = slgis.state.reporters.get('RP-1006'); const h = props('SL-CP-OC-016').repair_history[0];
    return { status: t?.status, outcome: t?.field_outcome, rep: [r.past_reports, r.past_confirmed], h: h.type + ':' + h.outcome }; })()`);
  check(settled.status === 'Closed' && settled.outcome === 'no_fault' && J(settled.rep) === '[1,0]' && settled.h === 'Check:no_fault', 'lit on the audit: closed as "Not confirmed on site"; the reporter\'s record updated, nothing rejected', J(settled));
  await closeSb();

  // ------------------------------------------------------------------ 3. A crew nearby, and "Different pole"
  console.log('\n# 3. A crew nearby checks; "Different pole"');
  await role('operator');
  const filed = await ev(`(() => { const r = fileReport({ category: 'damaged', uid: 'SL-CP-OC-020', latlng: slgis.state.byUid.get('SL-CP-OC-020').latlng, photo: { kind: 'upload', hash: '9c3e6a1f0b8d4e27' },
    source: 'Call centre', phone: '9812345678', role: 'operator' }); afterDataChange(); return { id: r.ticket.id, outcome: r.outcome, reporter: r.report.reporter_id }; })()`);
  const cDamaged = await conf(filed.id);
  check(cDamaged.band === 'Needs check' && cDamaged.signals.some((s) => /Photo matches report CR-D11/.test(s)), 'a damaged-pole report with a reused photo needs a check', `${filed.id} ${cDamaged.band} ${cDamaged.score}`);
  await ev(`selectPole('SL-CP-OC-020')`);
  await t.sleep(500);
  const next = await ev(`document.querySelector('[data-action^="check-"]')?.textContent.trim()`);
  check(/^Ask R2 · Deepak R\. \(\d+ m away\)$/.test(next ?? ''), 'no CCMS or audit for a damaged pole: ask the crew already nearby', next);
  await clickSel('[data-action="check-crew"]', 700);
  await role('field');
  await clickSel('#role-block [data-action="open-workorder"]', 900);
  const wo = await ev(`({ stops: document.querySelectorAll('.stop').length, check: [...document.querySelectorAll('.job')].some(j => /Check visit/.test(j.innerText) && j.innerText.includes(${J(filed.id)})) })`);
  check(wo.check && wo.stops >= 5, 'the check appears in R2\'s work order as a check visit', J(wo));
  await t.shot('r3-03-workorder-check.png');
  const jobSel = `.job:has([data-ticket="${filed.id}"])`;
  await clickSel(`${jobSel} [data-outcome="different_pole"]`, 300);
  await clickSel(`${jobSel} [data-action="pick-pole"]`, 500);
  check(await ev(`!!slgis.state.picking && /Click the pole where the fault is/.test(document.querySelector('#map-chip').innerText)`), '"Different pole": pick the pole on the map');
  await t.key('Escape', 'Escape', 27);
  await t.sleep(300);
  check(await ev(`!slgis.state.picking`), 'Esc cancels picking');
  await clickSel(`${jobSel} [data-outcome="different_pole"]`, 300);
  await clickSel(`${jobSel} [data-action="pick-pole"]`, 500);
  await clickPole('SL-CP-OC-021');
  const moved = await ev(`(() => { const t = slgis.state.tickets.get(${J(filed.id)}); const r = slgis.state.reporters.get(${J(filed.reporter)});
    return { poles: t?.pole_uids, from: props('SL-CP-OC-020').status, to: props('SL-CP-OC-021').status, outcome: t?.field_outcome, rep: [r.past_reports, r.past_confirmed], band: t?.confidence.band }; })()`);
  check(J(moved.poles) === '["SL-CP-OC-021"]' && moved.outcome === 'different_pole' && J(moved.rep) === '[1,1]' && moved.band === 'Confirmed',
    'the ticket moves to the right pole and counts as confirmed for the reporter', J(moved));
  // "Working, no fault" and "Obstruction" on dispatched jobs
  await ev(`selectPole('SL-CP-OC-024')`);
  await t.sleep(500);
  await clickSel('[data-outcome="no_fault"]', 300);
  await clickSel('[data-action="no-fault"]', 700);
  check(await ev(`slgis.state.closed.get('TKT-2026-0163')?.field_outcome === 'no_fault' && props('SL-CP-OC-024').status === 'Functional'`), '"Working, no fault" closes the job as not confirmed on site');
  await ev(`selectPole('SL-CP-OC-009')`);
  await t.sleep(500);
  await clickSel('[data-outcome="obstruction"]', 300);
  await clickSel('[data-action="obstruction"]', 700);
  check(await ev(`(() => { const t = slgis.state.tickets.get('TKT-2026-0173'); return t.category === 'blocked' && t.team === 'horticulture' && t.status === 'Open' && props('SL-CP-OC-009').status === 'Functional'; })()`), '"Obstruction" sends the ticket to horticulture / enforcement');
  await closeSb();

  // ------------------------------------------------------------------ 4. Citizen evidence: noticed, photo, location
  console.log('\n# 4. Citizen report: noticed, photo, location');
  await role('citizen');
  const mc14 = await ev(`(() => { const ll = slgis.state.byUid.get('SL-CP-MC-014').latlng; return { lat: ll.lat, lng: ll.lng }; })()`);
  await t.send('Browser.grantPermissions', { permissions: ['geolocation'] });
  await t.send('Emulation.setGeolocationOverride', { latitude: mc14.lat + 0.00007, longitude: mc14.lng, accuracy: 8 });
  await clickSel('#report-btn');
  await clickPole('SL-CP-MC-014');
  check(await ev(`document.querySelector('#rm-noticed').hidden`), 'the "Noticed" row stays hidden until a lamp fault is picked');
  await clickSel('#rm-issues input[value="not_working"] + span', 300);
  const noticed = await ev(`({ shown: !document.querySelector('#rm-noticed').hidden, picked: document.querySelector('input[name="noticed"]:checked')?.value, privacy: document.querySelector('#report-form .privacy').innerText })`);
  check(noticed.shown && noticed.picked === 'just_now' && /used only to check this report/.test(noticed.privacy), '"Noticed: Last night / Earlier today / Just now", pre-set to "Just now" after dark; privacy line shown', J(noticed));
  await setFile('#rm-photo-take', `${FIX}/pole-a.png`);
  await t.sleep(400);
  await ev(`document.querySelector('#rm-geo').click()`);
  await t.sleep(1200);
  check(/Location added \(±8 m\)/.test(await text('#rm-geo-status')), '"Use my location" only when tapped', await text('#rm-geo-status'));
  await t.shot('r3-04-form.png');
  await clickSel('#report-form button[type="submit"]', 1200);
  const rep1 = await ev(`(() => { const r = slgis.state.reports.at(-1); return { id: r.id, kind: r.photo?.kind, hash: r.photo?.hash, dist: r.device && Math.round(r.device.latlng.distanceTo(slgis.state.byUid.get('SL-CP-MC-014').latlng)), noticed: r.noticed, status: props('SL-CP-MC-014').status, band: slgis.state.tickets.get(r.ticket_id).confidence.band }; })()`);
  check(rep1.kind === 'live' && /^[0-9a-f]{16}$/.test(rep1.hash ?? '') && rep1.dist <= 10 && rep1.noticed === 'just_now', 'the report keeps a live photo (hashed in the browser), the location and when it was noticed', J(rep1));
  check(rep1.band === 'Likely' && rep1.status === 'Faulty', 'no CCMS on this pole: Likely, and the pole is marked Faulty as before', J(rep1));
  await clickSel('#report-btn');
  await clickPole('SL-CP-MC-016');
  await clickSel('#rm-issues input[value="not_working"] + span', 300);
  await setFile('#rm-photo-upload', `${FIX}/pole-a.png`);
  await clickSel('#report-form button[type="submit"]', 1200);
  const rep2 = await ev(`(() => { const r = slgis.state.reports.at(-1); const t = slgis.state.tickets.get(r.ticket_id); return { kind: r.photo?.kind, signals: t.confidence.signals.map(s => s.text) }; })()`);
  check(rep2.kind === 'upload' && rep2.signals.includes(`Photo matches report ${rep1.id}`), 'the same picture on another pole: "Photo matches report <ID>" for the operator', J(rep2.signals.filter((s) => /Photo/.test(s))));

  // ------------------------------------------------------------------ 5. Sharing (citizen-initiated)
  console.log('\n# 5. Public escalation on X');
  const mine = await text();
  check(/Confirmed/.test(mine) || /Received/.test(mine), 'My reports shows progress only (no scores)', mine.split('\n').slice(0, 4).join(' | '));
  const shareable = await ev(`[...document.querySelectorAll('[data-action="open-share"]')].map(b => b.dataset.report)`);
  check(shareable.includes('CR-S03') && !shareable.includes(rep1.id), 'sharing is offered on the overdue ticket, never at report time', J(shareable));
  const before = await ev(`slgis.state.tickets.get('TKT-2026-0156').score`);
  await clickSel('[data-action="open-share"][data-report="CR-S03"]', 600);
  const preview = await ev(`({ text: document.querySelector('.post-preview')?.textContent, count: document.querySelector('.post-preview + p')?.textContent })`);
  const base = await ev('BASE_URL');
  check(/TKT-2026-0156/.test(preview.text) && /Flickering/.test(preview.text) && /Outer Circle/.test(preview.text) && /Open for \d+ days?\./.test(preview.text) && !/@/.test(preview.text)
    && (base ? preview.text.includes(`${base}#ticket=TKT-2026-0156`) : !/http/.test(preview.text)),
    `preview: complaint ID, category, road, days open; no handle while it is a placeholder; ${base ? 'the status link' : 'no link while BASE_URL is empty'}`, preview.text);
  check(/of 280 characters/.test(preview.count ?? ''), 'weighted count shown', preview.count);
  await t.shot('r3-05-share.png');
  await clickSel('[data-action="share-x"]', 600);
  const opened = await ev(`({ url: window.__opened.at(-1), pub: !!slgis.state.tickets.get('TKT-2026-0156').public, score: slgis.state.tickets.get('TKT-2026-0156').score,
    log: slgis.state.activity.some(a => a.ticket === 'TKT-2026-0156' && /Shared publicly by reporter/.test(a.action)) })`);
  check(opened.url?.startsWith('https://x.com/intent/tweet?text=') && decodeURIComponent(opened.url.split('text=')[1]) === preview.text, 'Post on X opens X\'s web intent with exactly the previewed text');
  check(opened.pub && opened.log && opened.score === before, 'operators see "Shared publicly by reporter"; priority unchanged (no queue-jumping)', `${before} → ${opened.score}`);
  await clickSel('[data-lang="hi"]', 500);
  check(/स्ट्रीटलाइट शिकायत/.test(await ev(`document.querySelector('.post-preview')?.textContent ?? ''`)), 'the post is written in the citizen\'s language');
  await clickSel('[data-lang="en"]', 400);
  await t.key('Escape', 'Escape', 27);
  await t.sleep(400);
  check(await ev(`slgis.state.selected?.type === 'myreports'`), 'Esc steps back to My reports');
  await closeSb();
  await ev(`location.hash = '#ticket=TKT-2026-0156'`);
  await t.sleep(900);
  const status = await ev(`({ type: slgis.state.selected?.type, role: slgis.state.role, text: document.querySelector('#sidebar-content').innerText, hash: location.hash })`);
  check(status.type === 'status' && status.role === 'citizen' && /TKT-2026-0156/.test(status.text) && /Flickering/.test(status.text) && !/Likely|Confirmed|score|TKT-2026-0156 ·/.test(status.text.split('\n').slice(3).join(' ')),
    '#ticket=<ID> opens a plain public status card', status.text.replace(/\n+/g, ' | ').slice(0, 120));
  await closeSb();

  // ------------------------------------------------------------------ 6. Management switch
  console.log('\n# 6. Management: confidence summary and the public-sharing switch');
  await role('management');
  await ev(`openDashboard('reports')`);
  await t.sleep(600);
  const dash = await ev(`document.querySelector('details[data-fold="reports"]').innerText`);
  check(/Needs check/.test(dash) && /placeholders/.test(dash), 'Citizen reports section: counts by band, notice about placeholder handles', dash.split('\n').slice(0, 3).join(' | '));
  await clickSel('[data-action="toggle-public"]', 500);
  check(await ev(`slgis.state.publicSharing === false`), 'Management can switch public sharing off');
  await role('citizen');
  await ev(`openMyReports()`);
  await t.sleep(500);
  check(!(await exists('[data-action="open-share"]')), 'with sharing off, no share action is offered');
  await role('management');
  await ev(`openDashboard('reports')`);
  await t.sleep(400);
  await clickSel('[data-action="toggle-public"]', 400);

  // ------------------------------------------------------------------ 7. Hourly limit
  console.log('\n# 7. Abuse limit');
  await role('citizen');
  const limit = await ev(`(() => { const out = []; const ll = (u) => slgis.state.byUid.get(u).latlng;
    for (const u of ['SL-CP-OC-041', 'SL-CP-IC-017', 'SL-CP-R1-002', 'SL-CP-OC-026']) out.push(fileReport({ category: 'flickering', uid: u, latlng: ll(u), source: 'Citizen app', role: 'citizen' }).outcome);
    out.push(fileReport({ category: 'shock', uid: 'SL-CP-OC-028', latlng: ll('SL-CP-OC-028'), source: 'Citizen app', role: 'citizen' }).outcome);
    afterDataChange(); return out; })()`);
  check(J(limit) === J(['new', 'new', 'new', 'review', 'new']), `more than ${5} an hour from one reporter: logged and held for review; a safety report still goes through`, J(limit));
  await role('operator');
  await clickSel('#role-block [data-action="open-queue"]', 700);
  check(/Held for review · 1/i.test(await text()), 'the operator sees "Held for review"');
  await clickSel('[data-action="accept-report"]', 700);
  check(await ev(`(() => { const r = slgis.state.reports.find(x => x.uid === 'SL-CP-OC-026'); return !r.review && !!slgis.state.tickets.get(r.ticket_id); })()`), 'Accept puts the held report on a ticket (nothing is ever rejected)');

  // ------------------------------------------------------------------ 8. Draft public update after the shared ticket is fixed
  console.log('\n# 8. Closing the loop');
  await ev(`(() => { const t = slgis.state.tickets.get('TKT-2026-0154'); t.status = 'Awaiting dusk check'; t.closed_at = now().toISOString(); t.resolution = 'Replaced LED driver'; finishTicket(t, 'Night photo'); afterDataChange(); openQueue(); })()`);
  await t.sleep(600);
  check(/Shared publicly, now fixed · 1/i.test(await text()), 'queue lists the shared ticket once it is fixed');
  await clickSel('[data-action="draft-update"]', 600);
  const upd = await ev(`document.querySelector('.post-preview')?.textContent ?? ''`);
  check(/^Fixed: streetlight complaint TKT-2026-0154/.test(upd), '"Draft public update": a short factual "Fixed" message with the complaint ID', upd);
  await clickSel('[data-action="share-x"]', 500);
  check(await ev(`decodeURIComponent(window.__opened.at(-1).split('text=')[1]).startsWith('Fixed: streetlight complaint TKT-2026-0154') && !!slgis.state.closed.get('TKT-2026-0154').update_drafted`), 'it opens the same X intent for the department\'s account');
  await closeSb();

  // ------------------------------------------------------------------ 9. Phone width
  console.log('\n# 9. Phone width');
  await t.viewport(390, 844, true);
  await t.sleep(500);
  await role('citizen');
  await ev(`openMyReports()`);
  await t.sleep(500);
  const sh = await ev(`[...document.querySelectorAll('[data-action="open-share"]')].map(b => b.dataset.report)[0]`);
  if (sh) await clickSel(`[data-action="open-share"][data-report="${sh}"]`, 600);
  for (let i = 0; i < 30 && (await ev(`Math.round(document.querySelector('#sidebar').getBoundingClientRect().left)`)) !== 0; i++) await t.sleep(100);
  const phone = await ev(`({ scrollW: document.scrollingElement.scrollWidth, preview: document.querySelector('.post-preview')?.getBoundingClientRect().right, button: document.querySelector('[data-action="share-x"]')?.getBoundingClientRect().height })`);
  check(sh && phone.scrollW <= 390 && phone.preview <= 390 && phone.button >= 30, 'share preview fits at 390 px', J(phone));
  await t.shot('r3-06-phone-share.png');
  await closeSb();
  await role('field');
  await clickSel('#role-block [data-action="open-workorder"]', 800);
  for (let i = 0; i < 30 && (await ev(`Math.round(document.querySelector('#sidebar').getBoundingClientRect().left)`)) !== 0; i++) await t.sleep(100); // let the slide-in finish
  const out = await ev(`(() => { const o = document.querySelector('.outcome-options'); return o ? { w: Math.round(o.getBoundingClientRect().width), right: Math.round(o.getBoundingClientRect().right) } : null; })()`);
  check(out && out.right <= 390, 'on-site outcome choices fit at 390 px', J(out));
  await t.shot('r3-07-phone-outcome.png');
  await t.viewport(1440, 900);
}
