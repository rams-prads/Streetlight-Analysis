/* ==========================================================================
 * Street Light GIS · panels.js
 * Section 14: floating panels. View switch · header block per view · EN / हिन्दी · layers panel ·
 * legend · insights · map chip · search · toasts.
 * ========================================================================== */
'use strict';

// ========================================================================
// 14. Floating panels
// ========================================================================

// ---- 14.1 Views (a demo switch, not authentication) ---------------------------
const roleAllows = (analysis) => ROLE_ANALYSES[state.role]?.includes(analysis) ?? false;
const roleShowsOverlay = (name) => ROLE_OVERLAYS[state.role]?.includes(name) ?? false;
const roleCanReport = () => state.role === 'citizen' || state.role === 'operator';

function renderViewSwitch() {
  $('#view-switch').innerHTML = ROLES.map((r) => `<button type="button" role="radio" data-role-switch="${r.id}" aria-checked="${r.id === state.role}">${esc(r.label)}</button>`).join('');
}

/** Switch view: each view shows only what that role needs. Layers it lacks are switched off, and return with a view that has them. */
function setRole(role, { writeUrl = true } = {}) {
  if (!ROLES.some((r) => r.id === role)) return;
  state.role = role;
  document.body.dataset.role = role;
  for (const b of $$('[data-role-switch]')) b.setAttribute('aria-checked', String(b.dataset.roleSwitch === role));
  for (const name of Object.keys(state.analysis)) {
    if (state.analysis[name] && !roleAllows(name)) {
      setAnalysis(name, false);
      state.autoOff.add(`analysis:${name}`);
    } else if (!state.analysis[name] && roleAllows(name) && state.autoOff.delete(`analysis:${name}`)) {
      setAnalysis(name, true);
    }
  }
  for (const name of Object.keys(state.overlays)) {
    if (state.overlays[name] && !roleShowsOverlay(name)) {
      setOverlay(name, false);
      state.autoOff.add(`overlay:${name}`);
    } else if (!state.overlays[name] && roleShowsOverlay(name) && state.autoOff.delete(`overlay:${name}`)) {
      setOverlay(name, true);
    }
  }
  if (state.reportMode && !roleCanReport()) setReportMode(false);
  if (state.drawing) stopDrawing();
  if (state.picking) stopPolePick();
  state.highlight = null;
  state.back = null;
  closeSearch();
  applyLanguage();
  renderLayerToggles();
  renderRoleBlock();
  renderReportCta();
  renderLegend();
  renderInsights();
  renderReportPins();
  refreshPoles();
  renderMapChip();
  if (state.selected) renderSelected();
  if (writeUrl) writeHash();
}

function setLang(lang) {
  if (!CITIZEN_TEXT[lang] || state.lang === lang) return;
  state.lang = lang;
  applyLanguage();
  renderRoleBlock();
  renderReportCta();
  renderLayerToggles();
  renderLegend();
  if (!modal.hidden && state.draft) {
    const picked = form.querySelector('input[name="issue"]:checked')?.value ?? null;
    $('#rm-location').innerHTML = draftLocationHtml();
    renderCategoryChips(picked);
  }
  renderSelected({ keepScroll: true });
  $(`[data-lang="${lang}"]`)?.focus();
}

/** Swap every marked string between the staff wording (the HTML's own) and the citizen dictionary. */
function applyLanguage() {
  const citizen = isCitizen();
  document.documentElement.lang = citizen && state.lang === 'hi' ? 'hi' : 'en';
  for (const [attr, store] of [['i18n', null], ['i18nPlaceholder', 'placeholder'], ['i18nAria', 'aria-label'], ['i18nTitle', 'title']]) {
    const sel = `[data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`;
    for (const el of $$(sel)) {
      const key = el.dataset[attr];
      const keep = `staff${attr}`;
      if (!(keep in el.dataset)) el.dataset[keep] = store ? el.getAttribute(store) ?? '' : el.textContent;
      const text = citizen ? tr(key) : el.dataset[keep];
      if (store) el.setAttribute(store, text);
      else el.textContent = text;
    }
  }
}

function renderReportCta() {
  reportBtn.hidden = !roleCanReport();
  reportBtn.classList.toggle('report-cta--quiet', state.role === 'operator');
  reportBtn.querySelector('.fab-label').textContent = state.reportMode ? tr('report_cancel') : tr('report_cta');
}

// ---- 14.2 Header block: what each view needs at a glance -------------------------
let roleBlockHtml = '';
function renderRoleBlock() {
  const host = $('#role-block');
  const html = { citizen: citizenBlock, operator: operatorBlock, field: fieldBlock, management: managementBlock }[state.role]();
  if (html === roleBlockHtml) return; // the clock ticks every 30 s: leave the buttons alone unless something changed
  roleBlockHtml = html;
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  host.innerHTML = html;
  if (focused) host.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
}

function healthHtml(s) {
  return `<div class="health mt-4">
    <div class="flex items-baseline justify-between">
      <span class="eyebrow">Zone health</span>
      <span class="text-[13px] text-ink-2"><span id="health-pct" class="font-semibold text-ink-1">${Math.round((s.Functional / Math.max(1, s.total)) * 100)}%</span> functional</span>
    </div>
    ${meterHtml(s, 'mt-2')}
  </div>`;
}

const tile = ({ label, value, sub, action = null, data = '', id = '' }) => {
  const inner = `<span class="stat-label">${esc(label)}</span><span class="stat-value"${id ? ` id="${id}"` : ''}>${value}</span><span class="stat-sub">${sub}</span>`;
  return action
    ? `<button type="button" class="stat stat--action" data-action="${action}" data-focus-key="${action}${data ? `:${esc(data)}` : ''}" ${data ? `data-section="${esc(data)}"` : ''}>${inner}</button>`
    : `<div class="stat">${inner}</div>`;
};

function citizenBlock() {
  const mine = state.reports.filter((r) => r.mine);
  const updates = mine.filter((r) => r.resolved_at && !r.confirmed).length;
  return `<div class="citizen-row mt-3">
    <button type="button" class="btn btn-ghost" data-action="open-myreports" data-focus-key="myreports">
      <i class="fa-solid fa-list-ul" aria-hidden="true"></i><span>${esc(tr('my_reports'))}</span>
      ${mine.length ? `<span class="count">${mine.length}</span>` : ''}
      ${updates ? `<span class="update-dot" role="img" aria-label="${esc(tr('new_update'))}" title="${esc(tr('new_update'))}"></span>` : ''}
    </button>
    <div class="segmented segmented--sm" role="radiogroup" aria-label="Language / भाषा">
      <button type="button" role="radio" data-lang="en" aria-checked="${state.lang === 'en'}" lang="en">EN</button>
      <button type="button" role="radio" data-lang="hi" aria-checked="${state.lang === 'hi'}" lang="hi">हिन्दी</button>
    </div>
  </div>`;
}

function operatorBlock() {
  const s = statsOf(allProps());
  const open = openTickets();
  const breached = open.filter(isBreached).length;
  const emergencies = open.filter(isEmergency).length;
  const off = allProps().map(shutdownOf).filter(Boolean);
  const sub = emergencies ? plural(emergencies, 'emergency', 'emergencies') : breached ? `${breached} past SLA` : 'all within SLA';
  return `${healthHtml(s)}
    ${off.length ? `<p class="role-note"><i class="fa-solid fa-power-off" aria-hidden="true"></i>${plural(off.length, 'pole')} off for a planned shutdown until ${esc(fmtTime(new Date(Math.max(...off.map((x) => x.end.getTime())))))}</p>` : ''}
    <div class="kpis mt-3 grid grid-cols-3 gap-2">
      ${tile({ label: 'Poles', value: nf0.format(s.total), sub: `${s.Faulty} dark now`, id: 'kpi-poles' })}
      ${tile({ label: 'Open tickets', value: nf0.format(open.length), sub: `<span class="${emergencies ? 'text-ink-1' : ''}">${esc(sub)}</span>`, action: 'open-queue', id: 'kpi-tickets' })}
      ${tile({ label: `Energy · ${fmtMonthShort(META.energy_month)}`, value: nf0.format(s.kwh), sub: `kWh · ≈ ${esc(inrCompact(s.kwh * TARIFF))}`, id: 'kpi-energy' })}
    </div>`;
}

function fieldBlock() {
  const crew = currentCrew();
  const jobs = crewJobs(crew);
  const checks = jobs.filter((t) => t.status === 'Awaiting dusk check');
  const work = jobs.filter((t) => onTheRoute(t, crew));
  const audit = auditPoles();
  const dark = isDark();
  return `<div class="mt-3">
    <label class="crew-row"><span class="eyebrow">Crew</span>
      <select class="input input--sm" data-field="crew-select" aria-label="Crew">${allCrews().map((c) => `<option${c === crew ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <div class="kpis mt-3 grid grid-cols-3 gap-2">
      ${tile({ label: 'Jobs', value: work.length, sub: work.length ? `${plural(workOrderStops(crew).length, 'stop')}` : 'none dispatched', action: 'open-workorder' })}
      ${tile({ label: 'Dusk checks', value: checks.length, sub: checks.length ? (dark ? 'due now' : `after ${esc(fmtTime(nextDusk()))}`) : 'none waiting', action: 'open-workorder', data: 'checks' })}
      ${tile({ label: 'Night audit', value: audit.length, sub: dark ? 'poles to walk' : `from ${esc(fmtTime(nextDusk()))}`, action: 'open-audit' })}
    </div>
  </div>`;
}

function managementBlock() {
  const s = statsOf(allProps());
  const month = META.energy_month;
  const up = uptimeOf(allProps(), month);
  const card = contractorScorecards();
  const met = sum(card.map((c) => c.met)) / Math.max(1, sum(card.map((c) => c.jobs)));
  return `${healthHtml(s)}
    <div class="kpis mt-3 grid grid-cols-3 gap-2">
      ${tile({ label: `Uptime · ${fmtMonthShort(month)}`, value: up == null ? '–' : esc(pct(up)), sub: 'lamp-hours lit', action: 'open-dashboard', data: 'uptime' })}
      ${tile({ label: 'Unlit road', value: `${nf0.format(roundTo(unlitTotalM(), 5))} m`, sub: `${plural(state.darkRuns.length, 'stretch', 'stretches')} now`, action: 'open-dashboard', data: 'unlit' })}
      ${tile({ label: 'SLA met', value: esc(pct(met)), sub: `last ${Math.round(SCORECARD_WINDOW_DAYS / 30.4)} months`, action: 'open-dashboard', data: 'contractors' })}
    </div>`;
}

// ---- 14.3 Layers panel ------------------------------------------------------------
const OVERLAY_DEFS = {
  reports: { icon: 'fa-solid fa-bullhorn', label: () => (isCitizen() ? tr('overlay_reports') : 'Reports'), count: true },
  shutdowns: { icon: 'fa-solid fa-power-off', label: () => 'Planned shutdowns', desc: () => { const n = activeShutdowns().length; return n ? `${n} on now` : 'None on now'; } },
  landmarks: { icon: 'fa-solid fa-location-dot', label: () => 'Landmarks', desc: () => 'Approximate positions' },
  coverage: { icon: 'fa-solid fa-ruler-horizontal', label: () => 'Coverage gaps', desc: () => `${plural(state.gaps.length, 'stretch', 'stretches')} need a pole` },
  water: { icon: 'fa-solid fa-water', label: () => 'Waterlogging spots', desc: () => 'Approximate positions' },
  permits: { icon: 'fa-solid fa-person-digging', label: () => 'Excavation permits', desc: () => 'Approximate routes' },
  zone: { icon: 'fa-regular fa-circle', label: () => (isCitizen() ? tr('overlay_zone') : 'Pilot zone boundary') },
};

function reportsCountHtml() {
  const n = isCitizen() ? state.reports.filter((r) => r.mine).length : layers.reports?.getLayers().length ?? 0;
  return n ? ` <span class="text-ink-3 font-normal">(${n})</span>` : '';
}
/** Keep the Reports toggle's count in step with the pins. */
function syncReportsLabel() {
  const label = $('#lbl-reports');
  if (label) label.innerHTML = `${esc(OVERLAY_DEFS.reports.label())}${reportsCountHtml()}`;
}

function renderLayerToggles() {
  let any = false;
  for (const row of $$('[data-analysis-row]')) {
    const name = row.dataset.analysisRow;
    row.hidden = !roleAllows(name);
    any ||= !row.hidden;
    $(`#insights-${name}`).hidden = row.hidden || !state.analysis[name];
  }
  $('#analysis-heading').hidden = !any;
  const names = (ROLE_OVERLAYS[state.role] ?? []).filter((n) => OVERLAY_DEFS[n] && layers[n]);
  $('#overlay-list').innerHTML = names.map((n) => {
    const d = OVERLAY_DEFS[n];
    const count = d.count ? reportsCountHtml() : '';
    const desc = d.desc?.();
    return `<div class="toggle-row toggle-row--compact">
      <span class="toggle-icon" aria-hidden="true"><i class="${d.icon}"></i></span>
      <span class="min-w-0 flex-1"><span class="toggle-title" id="lbl-${n}">${esc(d.label())}${count}</span>${desc ? `<span class="toggle-desc">${esc(desc)}</span>` : ''}</span>
      <button type="button" class="switch" role="switch" aria-checked="${state.overlays[n]}" data-overlay="${n}" aria-labelledby="lbl-${n}"></button>
    </div>`;
  }).join('');
  $('#overlay-heading').hidden = !names.length;
}

// ---- 14.4 Legend --------------------------------------------------------------------
function renderLegend() {
  const counts = statsOf(allProps());
  $('#legend-status').innerHTML = STATUS_ORDER.map((k) => {
    const on = state.filters.has(k);
    return `<li><button type="button" class="legend-item" data-filter="${esc(k)}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(statusLabel(k).toLowerCase())}">
      ${statusSymbol(k, 16)}<span class="legend-label">${esc(statusLabel(k))}</span>
      <span class="legend-count">${counts[k] ?? 0}</span>
      <i class="fa-solid ${on ? 'fa-eye' : 'fa-eye-slash'} legend-eye" aria-hidden="true"></i></button></li>`;
  }).join('');

  const blocks = [];
  if (state.analysis.energy) {
    blocks.push(`<p class="eyebrow">Monthly energy · ${esc(fmtMonth(META.energy_month))}</p>${energyLegendSvg()}
      <p class="legend-note">Circle <em>area</em> is proportional to kWh. Colour and outline still show status.</p>`);
  }
  if (state.analysis.heatmap) {
    blocks.push(`<p class="eyebrow">Dark spots</p>
      <div class="heat-ramp" style="background:${heatRampCss()}"></div>
      <div class="ramp-labels"><span>Isolated fault</span><span>Clustered faults</span></div>
      <div class="legend-row"><span class="line-key line-key--dark"></span>Unlit stretch: ${MIN_DARK_RUN}+ dark poles in a row</div>`);
  }
  if (state.analysis.feeder) {
    blocks.push(`<p class="eyebrow">Feeder network</p>
      <div class="legend-row"><span class="line-key"></span>Circuit cable, in wiring order</div>
      <div class="legend-row"><span class="sld-panel sld-panel--key"><i class="fa-solid fa-bolt" aria-hidden="true"></i></span>Feeder panel (pillar)</div>
      <div class="legend-row"><span class="line-key line-key--hi"></span>Hovered or traced feeder</div>`);
  }
  const rows = [];
  if (state.overlays.reports && layers.reports?.getLayers().length) {
    rows.push(`<div class="legend-row"><span class="report-pin report-pin--key"><span class="pin"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i></span></span>${esc(isCitizen() ? tr('overlay_reports') : 'Report, or ticket with no mapped pole')}</div>`);
  }
  if (state.overlays.shutdowns) rows.push('<div class="legend-row"><span class="line-key line-key--shutdown"></span>Planned shutdown: lamps off by plan, not faults</div>');
  if (state.overlays.coverage) rows.push('<div class="legend-row"><span class="gap-icon gap-icon--key"><span><i class="fa-solid fa-plus" aria-hidden="true"></i></span></span>Coverage gap: add a pole (example rule)</div>');
  if (state.overlays.landmarks) rows.push('<div class="legend-row"><span class="landmark-icon landmark-icon--key"><span><i class="fa-solid fa-location-dot" aria-hidden="true"></i></span></span>Landmark (approximate)</div>');
  if (state.overlays.water) rows.push('<div class="legend-row"><span class="area-key area-key--water"></span>Waterlogging spot (approximate)</div>');
  if (state.overlays.permits) rows.push('<div class="legend-row"><span class="line-key line-key--permit"></span>Excavation permit (approximate)</div>');
  if (state.selected?.type === 'workorder' && layers.route?.getLayers().length) rows.push('<div class="legend-row"><span class="line-key line-key--route"></span>Suggested order</div>');
  if (rows.length) blocks.push(rows.join(''));
  $('#legend-extra').innerHTML = blocks.map((b) => `<div class="legend-block">${b}</div>`).join('');
}

/** Nested proportional-symbol legend; labels are nudged apart and tied back with leader lines. */
function energyLegendSvg() {
  const values = ENERGY_LEGEND_KWH.filter((v) => v <= energyMax * 1.15);
  const radii = values.map(energyRadius);
  const rMax = Math.max(...radii);
  const cx = rMax + 2;
  const base = rMax * 2 + 4;
  const labelX = cx + rMax + 16;
  let prevY = -Infinity;
  const rows = values.map((v, i) => ({ v, r: radii[i], top: base - 2 * radii[i] }))
    .sort((a, b) => a.top - b.top)
    .map((row) => {
      row.labelY = Math.max(row.top, prevY + 12);
      prevY = row.labelY;
      return row;
    });
  const height = Math.max(base, prevY + 5) + 2;
  const shapes = rows.map(({ v, r, top, labelY }) => `
    <circle cx="${cx}" cy="${base - r}" r="${r}" fill="none" stroke="${TOKEN.ink2}" stroke-opacity=".75" stroke-width="1"></circle>
    <polyline points="${cx},${top} ${cx + rMax + 4},${top} ${labelX - 3},${labelY}" fill="none" stroke="${TOKEN.ink4}" stroke-width="1"></polyline>
    <text x="${labelX}" y="${labelY + 3.5}" font-size="11" fill="${TOKEN.ink2}">${v} kWh</text>`).join('');
  return `<svg class="mt-2" width="100%" height="${height}" viewBox="0 0 230 ${height}" aria-hidden="true">${shapes}</svg>`;
}

// ---- 14.5 Insights under each analysis switch ----------------------------------------
function renderInsights() {
  renderHeatInsights();
  renderEnergyInsights();
  renderFeederInsights();
}

function renderHeatInsights() {
  const el = $('#insights-heatmap');
  el.hidden = !state.analysis.heatmap || !roleAllows('heatmap');
  if (el.hidden) return;
  const spots = state.darkSpots;
  el.innerHTML = `<p class="insight-lead">${spots.length ? `${plural(spots.length, 'unlit stretch', 'unlit stretches')} · ${nf0.format(roundTo(unlitTotalM(), 5))} m of road` : 'No unlit stretches'}</p>
    <p class="mt-0.5">Heat shows ${faultyRecords().length} faulty lamps. A stretch is ${MIN_DARK_RUN}+ dark poles in a row, measured between the lit poles either side.</p>
    ${spots.length ? `<ul class="insight-list">${spots.map((s) => `<li>
      <button type="button" class="insight-item" data-action="open-spot" data-spot="${esc(s.id)}">
        <span class="insight-badge">${esc(s.id)}</span>
        <span class="min-w-0 flex-1"><span class="block text-[12.5px] text-ink-1">${nf0.format(roundTo(s.unlitM, 5))} m unlit · ${esc(s.where)}</span>
        <span class="block text-[11.5px] text-ink-3 clamp-2">${esc(s.diagnosis.short)}</span></span>
      </button></li>`).join('')}</ul>` : ''}`;
}

function renderEnergyInsights() {
  const el = $('#insights-energy');
  el.hidden = !state.analysis.energy || !roleAllows('energy');
  if (el.hidden) return;
  const list = allProps();
  const total = sum(list.map((p) => p.energy_kwh || 0)) || 1;
  const types = [...groupBy(list, (p) => p.fixture_type)]
    .map(([type, ps]) => ({ type, poles: ps.length, kwh: sum(ps.map((p) => p.energy_kwh || 0)) }))
    .sort((a, b) => b.kwh - a.kwh);
  const legacy = list.filter((p) => p.fixture_type !== 'LED');
  const saving = sum(legacy.map(retrofitSavingKwh));
  const anomalies = list.filter(isAnomaly).sort((a, b) => energyRatio(b) - energyRatio(a));
  el.innerHTML = `<p class="insight-lead">${nf0.format(total)} kWh in ${esc(fmtMonth(META.energy_month))} <span class="text-ink-3 font-normal">· ≈ ${esc(inrCompact(total * TARIFF))}</span></p>
    <p class="mt-0.5 text-[11px] text-ink-3">Baseline: ${nf0.format(nightHoursInMonth(META.energy_month))} h from sunset to sunrise that month</p>
    <p class="mt-2 text-[11px] text-ink-3">Share of energy · poles per fixture type</p>
    ${types.map((t) => `<div class="share-row">
      <span class="truncate">${esc(FIXTURE_NAMES[t.type] ?? t.type)} <span class="text-ink-3">· ${t.poles}</span></span>
      <span class="share-track"><span class="share-fill" style="display:block;width:${(t.kwh / total) * 100}%"></span></span>
      <span class="text-right text-ink-1">${Math.round((t.kwh / total) * 100)}%</span></div>`).join('')}
    ${saving > 0 ? `<p class="mt-2.5"><i class="fa-solid fa-leaf tone-accent" aria-hidden="true"></i>
      LED retrofit of the ${legacy.length} legacy fixtures saves <span class="text-ink-1 font-medium">≈ ${nf0.format(saving)} kWh/month</span> (${esc(inrCompact(saving * TARIFF))}).</p>` : ''}
    ${anomalies.length ? `<p class="mt-2.5 text-ink-1 font-medium"><i class="fa-solid fa-circle-exclamation tone-serious" aria-hidden="true"></i>
      ${anomalies.length} consumption anomal${anomalies.length === 1 ? 'y' : 'ies'}</p>
      <ul class="insight-list">${anomalies.map((p) => `<li>
        <button type="button" class="insight-item" data-action="select-pole" data-uid="${esc(p.uid)}" data-zoom="1">
          <span class="insight-badge">${nf1.format(energyRatio(p))}×</span>
          <span class="min-w-0 flex-1"><span class="block mono text-[12px] text-ink-1">${esc(p.uid)}</span>
          <span class="block text-[11.5px] text-ink-3 truncate">${nf1.format(p.energy_kwh)} kWh · likely day burning</span></span>
        </button></li>`).join('')}</ul>` : ''}`;
}

function renderFeederInsights() {
  const el = $('#insights-feeder');
  el.hidden = !state.analysis.feeder || !roleAllows('feeder');
  if (el.hidden) return;
  const rows = [...state.panels.values()]
    .map(({ id, feature }) => ({ id, name: feature.properties.name, s: statsOf(polesOfPanel(id)), load: panelLoad(id) }))
    .sort((a, b) => b.s.Faulty - a.s.Faulty || b.s['Under Maintenance'] - a.s['Under Maintenance'] || a.id.localeCompare(b.id));
  const circuitCount = sum(rows.map((r) => panelPoles.get(r.id)?.size ?? 0));
  const heavy = rows.filter((r) => r.load.warn).length;
  el.innerHTML = `<p class="insight-lead">${rows.length} feeder panels · ${circuitCount} circuits</p>
    <p class="mt-0.5">Hover a line to inspect a circuit; click it to trace every pole that depends on the panel.${heavy ? ` <span class="text-ink-1">${plural(heavy, 'panel')} above ${Math.round(PANEL_LOAD_WARN_SHARE * 100)}% load.</span>` : ''}</p>
    ${state.trace ? `<button type="button" class="btn btn-ghost btn-block mt-2" data-action="untrace"><i class="fa-solid fa-xmark" aria-hidden="true"></i>Stop tracing ${esc(state.trace)}</button>` : ''}
    <ul class="insight-list">${rows.map((r) => `<li>
      <button type="button" class="insight-item" data-action="open-panel" data-panel="${esc(r.id)}" aria-pressed="${state.trace === r.id}">
        <span class="min-w-0 flex-1">
          <span class="flex items-baseline justify-between gap-2"><span class="mono text-[12px] text-ink-1">${esc(r.id)}</span>
            <span class="text-[11px] ${r.s.Faulty ? 'text-ink-1' : 'text-ink-3'}">${r.s.Faulty ? `${r.s.Faulty} of ${r.s.total} dark` : `${r.s.total} poles · no faults`}</span></span>
          <span class="block text-[11.5px] text-ink-3 truncate">${esc(r.name)}${r.load.warn ? ` · <span class="text-ink-1"><i class="fa-solid fa-gauge-high tone-serious" aria-hidden="true"></i> load ${esc(pct(Math.max(r.load.share, r.load.peakShare)))}</span>` : ''}</span>
          <span class="block mt-1.5">${meterHtml(r.s, 'meter--sm')}</span>
        </span>
      </button></li>`).join('')}</ul>`;
}

// ---- 14.6 Map chip: what the map is filtered to (feeder trace, a list picked out) ----------
function renderMapChip() {
  const host = $('#map-chip');
  const rows = [];
  if (state.picking) {
    rows.push(`<i class="fa-solid fa-crosshairs tone-accent" aria-hidden="true"></i>
      <span>Click the pole where the fault is</span><kbd>Esc</kbd>
      <button type="button" class="icon-btn icon-btn--sm" data-action="cancel-pick" aria-label="Cancel"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`);
  } else if (!state.reportMode && !state.drawing) {
    if (state.highlight) {
      rows.push(`<i class="fa-solid fa-filter tone-accent" aria-hidden="true"></i>
        <span>Showing ${plural(state.highlight.uids.size, 'pole')}: ${esc(state.highlight.label)}</span>
        <button type="button" class="icon-btn icon-btn--sm" data-action="clear-highlight" aria-label="Show all poles"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`);
    } else if (state.trace) {
      const s = statsOf(polesOfPanel(state.trace));
      rows.push(`<i class="fa-solid fa-diagram-project tone-accent" aria-hidden="true"></i>
        <span>Tracing <span class="mono font-semibold">${esc(state.trace)}</span> · ${s.total} poles depend on it${s.Faulty ? ` · ${s.Faulty} dark` : ''}</span>
        <button type="button" class="icon-btn icon-btn--sm" data-action="untrace" aria-label="Stop tracing"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`);
    }
  }
  host.hidden = !rows.length;
  host.innerHTML = rows.join('');
}

/** Pick out a list of poles on the map (dims the rest); a chip says what is shown and clears it. */
function setHighlight(label, uids) {
  state.highlight = uids?.length ? { label, uids: new Set(uids) } : null;
  refreshPoles();
  renderMapChip();
  if (state.highlight) fitTo(L.latLngBounds(uids.map((u) => state.byUid.get(u).latlng)).pad(0.2), 18);
}

// ---- 14.7 Search -------------------------------------------------------------------
const searchInput = $('#search');
const searchList = $('#search-results');
let searchResults = [];
let searchActive = -1;

function searchCandidates() {
  const items = [];
  const citizen = isCitizen();
  for (const { feature } of state.byUid.values()) {
    const p = feature.properties;
    items.push({
      type: 'pole', id: p.uid, title: p.uid, sub: p.location, status: p.status,
      hay: `${p.uid} ${p.location} ${p.road} ${citizen ? '' : `${p.feeder_panel} ${p.ticket?.id ?? ''} ${p.fixture_type}`}`.toLowerCase(),
    });
  }
  if (citizen) return items;
  if (roleAllows('feeder')) {
    for (const { id, feature } of state.panels.values()) {
      const pp = feature.properties;
      items.push({ type: 'panel', id, title: id, sub: `Feeder panel · ${pp.name}`, hay: `${id} ${pp.name} ${pp.location} ${pp.road} feeder panel`.toLowerCase() });
    }
  }
  for (const t of state.tickets.values()) {
    if (t.kind === 'location') items.push({ type: 'ticket', id: t.id, title: t.id, sub: `Ticket · ${t.issue}`, hay: `${t.id} ${t.issue} ${t.source} ticket`.toLowerCase() });
  }
  for (const r of state.reports) {
    if (!r.simulated) items.push({ type: 'report', id: r.id, title: r.id, sub: `Report · ${catLabel(r.category, false)} · ${r.ticket_id ?? 'logged'}`, hay: `${r.id} ${r.ticket_id ?? ''} ${catLabel(r.category, false)} report`.toLowerCase() });
  }
  return items;
}

function runSearch(query) {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const rank = (it) => (it.title.toLowerCase() === tokens.join(' ') ? 0 : it.title.toLowerCase().includes(tokens[0]) ? 1 : 2) + (it.type === 'pole' ? 0.5 : 0);
  return searchCandidates()
    .filter((it) => tokens.every((t) => it.hay.includes(t)))
    .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
    .slice(0, 8);
}

function renderSearch() {
  const q = searchInput.value;
  if (!q.trim()) {
    closeSearch();
    return;
  }
  searchResults = runSearch(q);
  searchActive = searchResults.length ? 0 : -1;
  const glyph = { panel: 'fa-bolt', ticket: 'fa-ticket', report: 'fa-bullhorn' };
  searchList.innerHTML = searchResults.length
    ? searchResults.map((it, i) => `<li role="option" id="sr-${i}" data-index="${i}" aria-selected="false">
        <span class="sr-glyph">${it.type === 'pole' ? statusSymbol(it.status, 14) : `<i class="fa-solid ${glyph[it.type]}" aria-hidden="true"></i>`}</span>
        <span class="min-w-0"><span class="sr-title block">${esc(it.title)}</span><span class="sr-sub block">${esc(it.sub)}</span></span></li>`).join('')
    : `<li class="sr-empty" aria-disabled="true">${esc(tr('search_empty', { q: q.trim() }))}</li>`;
  searchList.hidden = false;
  searchInput.setAttribute('aria-expanded', 'true');
  updateSearchActive();
}

function updateSearchActive() {
  for (const li of $$('li[data-index]', searchList)) li.setAttribute('aria-selected', String(Number(li.dataset.index) === searchActive));
  if (searchActive >= 0) {
    searchInput.setAttribute('aria-activedescendant', `sr-${searchActive}`);
    $(`#sr-${searchActive}`)?.scrollIntoView({ block: 'nearest' });
  } else {
    searchInput.removeAttribute('aria-activedescendant');
  }
}

function closeSearch() {
  searchList.hidden = true;
  searchResults = [];
  searchActive = -1;
  searchInput.setAttribute('aria-expanded', 'false');
  searchInput.removeAttribute('aria-activedescendant');
}

function chooseResult(item) {
  if (!item) return;
  closeSearch();
  searchInput.value = '';
  if (item.type === 'pole') selectPole(item.id, { zoom: true, focus: true });
  else if (item.type === 'panel') openPanel(item.id, { zoom: true });
  else if (item.type === 'ticket') openTicket(item.id, { zoom: true });
  else {
    const r = state.reports.find((x) => x.id === item.id);
    if (r?.ticket_id && state.tickets.has(r.ticket_id)) openTicket(r.ticket_id, { zoom: true });
    else if (r?.uid) selectPole(r.uid, { zoom: true });
    else if (r?.latlng) flyToVisible(r.latlng, Math.max(map.getZoom(), 18));
  }
}

// ---- 14.8 Toasts and clipboard --------------------------------------------------------
function toast({ title, body = '', tone = 'info', icon = 'fa-circle-info', timeout = 6500 }) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast--${tone}`;
  el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>
    <div class="min-w-0 flex-1"><div class="toast-title"></div><div class="toast-body"></div></div>
    <button type="button" class="icon-btn icon-btn--sm" aria-label="${esc(isCitizen() ? tr('close') : 'Dismiss')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
  el.querySelector('.toast-title').textContent = title;
  el.querySelector('.toast-body').textContent = body;
  const dismiss = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('button').addEventListener('click', dismiss);
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(dismiss, timeout);
}

async function copyText(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    el.textContent = 'copied';
  } catch {
    el.textContent = 'copy failed';
  }
  setTimeout(() => { el.textContent = 'copy'; }, 1400);
}
