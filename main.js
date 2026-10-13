/* ==========================================================================
 * Street Light GIS · main.js
 * Section 16: analysis switches, overlays, basemap
 * Section 17: events
 * Section 18: init and the clock tick
 * ========================================================================== */
'use strict';

// ========================================================================
// 16. Analysis switches, overlays, basemap
// ========================================================================
function setAnalysis(name, on) {
  if (state.analysis[name] === on) return;
  if (name === 'heatmap' && on && !layers.heat) {
    toast({ tone: 'warn', icon: 'fa-triangle-exclamation', title: 'Heatmap unavailable', body: 'The leaflet.heat plugin did not load from the CDN.' });
    return;
  }
  state.analysis[name] = on;
  if (name === 'heatmap') {
    if (on) {
      layers.heat.addTo(map);
      layers.heat.setOptions(heatRadiusPx());
      refreshHeat();
      renderDarkSpots();
      layers.darkSpots.addTo(map);
    } else {
      map.removeLayer(layers.heat);
      map.removeLayer(layers.darkSpots);
      if (state.selected?.type === 'spot') closeSidebar();
    }
  } else if (name === 'energy') {
    refreshPoles();
  } else if (name === 'feeder') {
    if (on) {
      layers.network.addTo(map);
      layers.panels.addTo(map);
      styleNetwork();
    } else {
      if (state.trace) setTrace(null);
      map.removeLayer(layers.network);
      map.removeLayer(layers.panels);
      if (state.selected?.type === 'panel') closeSidebar();
    }
  }
  $(`[data-analysis="${name}"]`)?.setAttribute('aria-checked', String(on));
  updateSelectionRing();
  renderLegend();
  renderInsights();
}

function setOverlay(name, on) {
  if (!layers[name]) return;
  state.overlays[name] = on;
  if (on) layers[name].addTo(map);
  else map.removeLayer(layers[name]);
  $(`[data-overlay="${name}"]`)?.setAttribute('aria-checked', String(on));
  renderLegend();
}

function setBasemap(key) {
  if (!basemaps[key] || state.basemap === key) return;
  map.removeLayer(basemaps[state.basemap]);
  basemaps[key].addTo(map);
  state.basemap = key;
  for (const b of $$('[data-basemap]')) b.setAttribute('aria-checked', String(b.dataset.basemap === key));
}

/** Planned shutdowns (C2): a subtle dotted band along each switched-off circuit. Not a pole status. */
function renderShutdownLayer() {
  layers.shutdowns.clearLayers();
  for (const s of activeShutdowns()) {
    for (const circuit of s.circuits) {
      const path = circuitPath(s.panelId, circuit);
      if (path.length > 1) L.polyline(path, { pane: 'overlayLinePane', interactive: false, color: TOKEN.ink3, weight: 8, opacity: 0.4, dashArray: '1 9', lineCap: 'round' }).addTo(layers.shutdowns);
    }
  }
}

/** Waterlogging hotspots (F1): approximate areas from the mock data. */
function createWaterLayer() {
  const group = L.layerGroup();
  for (const w of waterRecs) {
    L.circle(w.latlng, { pane: 'waterPane', radius: w.radius_m, color: TOKEN.water, weight: 1.5, opacity: 0.8, fillColor: TOKEN.water, fillOpacity: 0.14, dashArray: '4 4' })
      .bindTooltip(`<div class="tt-value">${esc(w.name)}</div><div class="tt-row">Waterlogging spot · about ${esc(w.radius_m)} m across</div>
        <div class="tt-hint">Approximate area (synthetic)</div>`, { className: 'sl-tooltip', sticky: true, direction: 'top', opacity: 1 })
      .addTo(group);
  }
  return group;
}

/** Third-party excavation permits (F3): approximate routes from the mock data; inactive ones are faded. */
function createPermitLayer() {
  const group = L.layerGroup();
  for (const pm of permitRecs) {
    L.polyline(pm.line, { pane: 'overlayLinePane', color: TOKEN.permit, weight: 4, opacity: permitActive(pm) ? 0.9 : 0.35, dashArray: '8 6', lineCap: 'butt' })
      .bindTooltip(() => `<div class="tt-value">${esc(pm.id)} · ${esc(pm.agency)}</div><div class="tt-row">${esc(pm.purpose)}</div>
        <div class="tt-row">${esc(fmtDay(pm.start))} – ${esc(fmtDay(pm.end))}${permitActive(pm) ? ' · active now' : ''}</div>
        <div class="tt-hint">Approximate route (synthetic)</div>`, { className: 'sl-tooltip', sticky: true, direction: 'top', opacity: 1 })
      .addTo(group);
  }
  return group;
}

// ========================================================================
// 17. Events
// ========================================================================
/** Clicks while drawing a route or choosing a report spot belong to that mode, whatever was clicked. */
function modeClick(latlng) {
  if (state.drawing) {
    addDrawPoint(latlng);
    return true;
  }
  if (state.reportMode) {
    beginReport(latlng);
    return true;
  }
  return false;
}

function onPoleClick(uid) {
  const rec = state.byUid.get(uid);
  if (state.drawing) return addDrawPoint(rec.latlng);
  if (state.reportMode) return beginReport(rec.latlng, uid);
  return selectPole(uid);
}

function onPanelClick(id, e) {
  if (!modeClick(e.latlng)) openPanel(id);
}

function onFeederLineClick(panelId, e) {
  if (modeClick(e.latlng)) return;
  const near = poleNearPoint(e.containerPoint, HIT_TOLERANCE_PX); // poles sit on the lines
  if (near) selectPole(near.uid);
  else openPanel(panelId);
}

/** Every [data-action] button in the header, layers panel, sidebar and map chips ends up here. */
function handleAction(el, { fromSidebar = false } = {}) {
  const d = el.dataset;
  const keep = () => renderSelected({ keepScroll: true });
  switch (d.action) {
    case 'close': closeSidebar(); break;
    case 'back': goBack(); break;
    case 'zoom-pole': flyToVisible(state.byUid.get(d.uid).latlng, Math.max(map.getZoom(), 18)); break;
    case 'select-pole': selectPole(d.uid, { zoom: fromSidebar || d.zoom === '1', fromSidebar }); break;
    case 'open-panel': openPanel(d.panel, { zoom: true, fromSidebar }); break;
    case 'zoom-panel': fitPanel(d.panel); break;
    case 'trace': {
      const next = state.trace === d.panel ? null : d.panel;
      setTrace(next, { fit: Boolean(next) });
      keep();
      break;
    }
    case 'untrace': setTrace(null); keep(); break;
    case 'open-spot': openSpot(d.spot, { fromSidebar }); break;
    case 'open-run': {
      if (!state.analysis.heatmap) setAnalysis('heatmap', true);
      const spot = state.darkSpots.find((s) => s.uids.includes(d.uid));
      if (spot) openSpot(spot.id, { fromSidebar });
      break;
    }
    case 'open-ticket': openTicket(d.ticket, { zoom: true, fromSidebar }); break;
    case 'report-pole': beginReport(state.byUid.get(d.uid).latlng, d.uid, d.category ?? null); break;
    case 'dispatch': dispatchTicket(d.ticket, el.closest('.workflow')?.querySelector('[data-field="crew"]')?.value); break;
    case 'resolve': closeTicket(d.ticket, el.closest('.workflow')?.querySelector('[data-field="resolution"]')?.value); break;
    case 'confirm-dusk': confirmDuskPhoto(d.ticket); break;
    case 'split': splitReport(d.report); break;
    case 'fixed-yes': answerFixed(d.report, true); break;
    case 'fixed-no': answerFixed(d.report, false); break;
    case 'copy': copyText(d.copy, el); break;
    case 'energy-pole':
      if (roleAllows('energy') && !state.analysis.energy) setAnalysis('energy', true);
      if (d.uid) selectPole(d.uid, { zoom: true, fromSidebar });
      break;
    case 'open-queue': openQueue(); break;
    case 'open-workorder': openWorkOrder(d.section === 'checks' ? 'checks' : 'jobs'); break;
    case 'open-audit': openAudit(); break;
    case 'audit-lit': auditMark('lit'); break;
    case 'audit-dark': auditMark('dark'); break;
    case 'audit-skip':
    case 'audit-prev':
      state.audit.index = clamp(state.audit.index + (d.action === 'audit-skip' ? 1 : -1), 0, auditPoles().length);
      renderSelected();
      focusAuditPole();
      break;
    case 'audit-restart':
      state.audit = { index: 0, results: {}, tickets: [] };
      renderSelected();
      focusAuditPole();
      break;
    case 'open-dashboard': openDashboard(d.section ?? 'uptime'); break;
    case 'open-myreports': openMyReports(); break;
    case 'open-monsoon': openMonsoon(); break;
    case 'highlight-monsoon': highlightMonsoon(); break;
    case 'clear-highlight': setHighlight(null, null); break;
    case 'open-labels': openLabels(); break;
    case 'print-labels': printLabels(); break;
    case 'open-event': openEvent(); break;
    case 'event-road': {
      const roads = new Set(state.event.roads);
      if (roads.has(d.road)) roads.delete(d.road);
      else roads.add(d.road);
      state.event.roads = [...roads];
      keep();
      break;
    }
    case 'event-draw': startDrawing(); break;
    case 'event-clear-line': state.event.line = null; keep(); break;
    case 'event-print': printEvent(); break;
    case 'event-highlight': setHighlight('not working on the event route', eventCheck(state.event).notWorking.map((p) => p.uid)); break;
    case 'draw-finish': finishDrawing(); break;
    default: break;
  }
}

function bindEvents() {
  // Map
  map.on('click', (e) => {
    if (modeClick(e.latlng)) return;
    const near = poleNearPoint(e.containerPoint, HIT_TOLERANCE_PX);
    if (near) selectPole(near.uid);
  });
  map.on('mousemove', (e) => {
    $('#sb-coords').textContent = fmtLatLng(e.latlng);
    if (state.reportMode && modal.hidden) updateSnap(e.latlng);
  });
  map.on('mouseout', () => {
    $('#sb-coords').textContent = '–';
    clearSnap();
  });
  map.on('zoomend', () => {
    $('#sb-zoom').textContent = `z${map.getZoom()}`;
    refreshPoles(); // marker radii follow zoom
    if (state.analysis.heatmap && map.hasLayer(layers.heat)) layers.heat.setOptions(heatRadiusPx());
    if (state.analysis.energy) renderLegend(); // the proportional legend follows the same scale
  });

  // Header: view switch, language, crew, role tiles
  $('#command').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-role-switch]');
    if (sw) return setRole(sw.dataset.roleSwitch);
    const lang = e.target.closest('[data-lang]');
    if (lang) return setLang(lang.dataset.lang);
    const act = e.target.closest('[data-action]');
    if (act) handleAction(act);
    return undefined;
  });
  $('#command').addEventListener('change', (e) => {
    if (!e.target.matches('[data-field="crew-select"]')) return;
    state.crew = e.target.value;
    renderRoleBlock();
    renderSelected({ keepScroll: true });
    $('[data-field="crew-select"]')?.focus();
  });

  // Layers panel: analysis switches, overlays, basemap, insight actions
  $('#layers').addEventListener('click', (e) => {
    const sw = e.target.closest('[data-analysis]');
    if (sw) return setAnalysis(sw.dataset.analysis, sw.getAttribute('aria-checked') !== 'true');
    const ov = e.target.closest('[data-overlay]');
    if (ov) return setOverlay(ov.dataset.overlay, ov.getAttribute('aria-checked') !== 'true');
    const bm = e.target.closest('[data-basemap]');
    if (bm) return setBasemap(bm.dataset.basemap);
    const act = e.target.closest('[data-action]');
    if (act) handleAction(act);
    return undefined;
  });

  // Collapsible panels
  for (const [btnId, panelId] of [['layers-toggle', 'layers'], ['legend-toggle', 'legend']]) {
    const btn = $(`#${btnId}`);
    const body = $(`#${btn.getAttribute('aria-controls')}`);
    const setOpen = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      $(`#${panelId}`).dataset.collapsed = String(!open);
    };
    btn.addEventListener('click', () => setOpen(btn.getAttribute('aria-expanded') !== 'true'));
    if (window.matchMedia('(max-width: 640px)').matches) setOpen(false); // phones start collapsed
  }

  // Legend: click a status to show / hide it
  $('#legend-status').addEventListener('click', (e) => {
    const item = e.target.closest('[data-filter]');
    if (!item) return;
    const key = item.dataset.filter;
    if (state.filters.has(key)) state.filters.delete(key);
    else state.filters.add(key);
    refreshPoles();
    renderLegend();
    $(`[data-filter="${CSS.escape(key)}"]`)?.focus();
  });

  // Map controls and map chips
  $('#zoom-in').addEventListener('click', () => map.zoomIn());
  $('#zoom-out').addEventListener('click', () => map.zoomOut());
  $('#zoom-home').addEventListener('click', () => fitZone(true));
  for (const id of ['#map-chip', '#draw-chip']) {
    $(id).addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]');
      if (act) handleAction(act);
    });
  }

  // Sidebar actions (event delegation; views are re-rendered often)
  sidebarEl.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && !el.disabled) handleAction(el, { fromSidebar: true });
  });
  sidebarEl.addEventListener('change', (e) => {
    const input = e.target.closest('[data-change="dusk-photo"]');
    if (input) attachDuskPhoto(input.dataset.ticket, input.files?.[0]);
  });

  // Sparkline tooltip (hover and keyboard focus show the same thing)
  const showSparkTip = (e) => {
    const bar = e.target.closest?.('.spark-bar');
    if (!bar) return;
    const wrap = bar.closest('[data-spark]');
    const tip = wrap.querySelector('.spark-tip');
    const wr = wrap.getBoundingClientRect();
    const br = bar.querySelector('path').getBoundingClientRect();
    tip.textContent = bar.dataset.tip;
    tip.style.left = `${br.left + br.width / 2 - wr.left}px`;
    tip.style.top = `${br.top - wr.top - 8}px`;
    tip.hidden = false;
  };
  const hideSparkTip = (e) => {
    const bar = e.target.closest?.('.spark-bar');
    if (bar) bar.closest('[data-spark]').querySelector('.spark-tip').hidden = true;
  };
  sidebarEl.addEventListener('pointerover', showSparkTip);
  sidebarEl.addEventListener('focusin', showSparkTip);
  sidebarEl.addEventListener('pointerout', hideSparkTip);
  sidebarEl.addEventListener('focusout', hideSparkTip);

  // Report button and form
  reportBtn.addEventListener('click', () => {
    if (roleCanReport()) setReportMode(!state.reportMode);
  });
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeReportModal();
  });
  modal.addEventListener('keydown', (e) => { // keep keyboard focus inside the dialog
    if (e.key !== 'Tab') return;
    const focusables = $$('button, input, select, textarea, summary, [href]', form).filter((el) => !el.disabled && el.getClientRects().length);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'issue') {
      syncSafetyNote();
      $('#rm-issue-error').hidden = true;
    }
  });
  $('#rm-description').addEventListener('input', (e) => { $('#rm-count').textContent = `${e.target.value.length}/500`; });
  $('#rm-photo').addEventListener('change', (e) => {
    clearPhoto();
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      e.target.value = '';
      $('#rm-photo-name').textContent = tr('form_photo_not_image');
      return;
    }
    photoUrl = URL.createObjectURL(file);
    const img = $('#rm-photo-preview');
    img.src = photoUrl;
    img.hidden = false;
    $('#rm-photo-name').textContent = file.name;
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitReportForm();
  });

  // Search
  searchInput.addEventListener('input', renderSearch);
  searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) renderSearch(); });
  searchInput.addEventListener('blur', () => setTimeout(closeSearch, 150));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!searchResults.length) return;
      e.preventDefault();
      searchActive = (searchActive + (e.key === 'ArrowDown' ? 1 : -1) + searchResults.length) % searchResults.length;
      updateSearchActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      chooseResult(searchResults[searchActive]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (!searchList.hidden) closeSearch();
      else searchInput.blur();
    }
  });
  searchList.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  searchList.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-index]');
    if (li) chooseResult(searchResults[Number(li.dataset.index)]);
  });

  // Keyboard: Esc backs out one step at a time; "/" focuses search; Enter finishes a drawn route
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modal.hidden) closeReportModal();
      else if (state.drawing) stopDrawing();
      else if (state.reportMode) setReportMode(false);
      else if (state.highlight) setHighlight(null, null);
      else if (state.trace) {
        setTrace(null);
        renderSelected({ keepScroll: true });
      } else if (state.selected) goBack();
      return;
    }
    const t = document.activeElement;
    const typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
    if (e.key === 'Enter' && state.drawing && !typing && state.drawing.points.length >= 2) {
      e.preventDefault();
      finishDrawing();
    } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  window.addEventListener('hashchange', openFromHash);
}

// ========================================================================
// 18. Init and the clock tick
// ========================================================================
let lastShutdowns = '';
let lastDark = null;

/** Time moves on: CCMS confirmations, shutdowns starting or ending, dusk, SLA clocks and escalation. */
function tick() {
  const verified = processDuskChecks();
  const shutdowns = activeShutdowns().map((s) => `${s.panelId}@${s.end.getTime()}`).join('|');
  const dark = isDark();
  const shutdownChanged = shutdowns !== lastShutdowns;
  const duskChanged = dark !== lastDark;
  lastShutdowns = shutdowns;
  lastDark = dark;
  if (shutdownChanged) renderShutdownLayer();
  if (verified || shutdownChanged) {
    afterDataChange();
    return;
  }
  const escalated = rateAllTickets();
  renderRoleBlock();
  if (escalated || duskChanged) renderSelected({ keepScroll: true });
}

function init() {
  readTokens();
  initMap();
  const none = { type: 'FeatureCollection', features: [] };

  layers.zone = L.geoJSON(DATA.zone ?? none, {
    pane: 'zonePane',
    interactive: false,
    style: { color: TOKEN.ink2, weight: 1.2, opacity: 0.5, dashArray: '6 6', fillColor: TOKEN.ink2, fillOpacity: 0.025 },
  });
  layers.halo = L.layerGroup().addTo(map);
  layers.poles = createPoleLayer().addTo(map);
  layers.panels = createPanelLayer(); // shown with the feeder network
  layers.network = L.layerGroup();
  layers.darkSpots = L.layerGroup();
  layers.reports = L.layerGroup();
  layers.shutdowns = L.layerGroup();
  layers.selection = L.layerGroup().addTo(map);
  layers.route = L.layerGroup().addTo(map);
  layers.eventRoute = L.layerGroup().addTo(map);
  // `maxZoom` = the map's minimum zoom keeps heat intensity constant: leaflet.heat halves
  // point intensity for every zoom level below its maxZoom option.
  layers.heat = typeof L.heatLayer === 'function'
    ? L.heatLayer([], { maxZoom: MAP_MIN_ZOOM, max: 1, radius: 20, blur: 16, gradient: TOKEN.heat })
    : null;
  if (!layers.heat) $('[data-analysis="heatmap"]').disabled = true;

  layers.selectRing = L.circleMarker(CENTRE_LATLNG, { pane: 'selectionPane', interactive: false, radius: 12, color: TOKEN.ink1, weight: 2, opacity: 0.95, fill: false, dashArray: '4 4', className: 'select-ring' });
  layers.snapRing = L.circleMarker(CENTRE_LATLNG, { pane: 'selectionPane', interactive: false, radius: 14, color: TOKEN.accentHi, weight: 2, fill: false, className: 'snap-ring' });
  layers.snapLine = L.polyline([], { pane: 'selectionPane', interactive: false, color: TOKEN.ink1, weight: 1.5, opacity: 0.85, dashArray: '3 5' });
  layers.draftPin = L.marker(CENTRE_LATLNG, { icon: reportIcon(true), interactive: false, keyboard: false, zIndexOffset: 1000 });
  energyMax = Math.max(1, ...state.features.map((f) => f.properties.energy_kwh || 0));

  // The data model, the analyses that only depend on positions, and the ticket triage
  indexTopology();
  indexTickets();
  indexLandmarks();
  indexPermits();
  indexWaterlogging();
  computeRoadOrder();
  state.gaps = computeCoverageGaps();
  layers.coverage = createCoverageLayer();
  layers.landmarks = createLandmarkLayer();
  layers.water = createWaterLayer();
  layers.permits = createPermitLayer();
  renderShutdownLayer();
  lastShutdowns = activeShutdowns().map((s) => `${s.panelId}@${s.end.getTime()}`).join('|');
  lastDark = isDark();
  [
    [DATA.streetlights, 'pole'], [DATA.feederPanels, 'panel'], [DATA.landmarks, 'landmark'], [DATA.excavationPermits, 'permit'],
    [DATA.waterloggingSpots, 'waterlogging spot'], [DATA.locationTickets, 'location ticket'], [DATA.zone, 'zone'],
  ].forEach(([collection, name]) => validateCoordinates(collection, name));
  processDuskChecks(); // CCMS confirmations that came in before the app opened
  refreshDarkRuns();
  collapseCircuitFaults();
  rateAllTickets({ initial: true });

  renderViewSwitch();
  bindEvents();
  for (const name of Object.keys(state.overlays)) if (state.overlays[name]) layers[name]?.addTo(map);
  setRole(state.role, { writeUrl: false });
  fitZone(false);
  $('#sb-zoom').textContent = `z${map.getZoom()}`;
  openFromHash();
  setInterval(tick, CLOCK_TICK_MS);
  // Handy for console experiments: slgis.selectPole('SL-CP-OC-031'), slgis.setRole('field')
  window.slgis = { map, state, layers, basemaps, selectPole, openPanel, setAnalysis, setTrace, setRole, now, sunTimes };
}

if (BOOT_ERROR) fatal(BOOT_ERROR);
else init();
