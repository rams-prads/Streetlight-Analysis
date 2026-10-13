/* ==========================================================================
 * Street Light GIS · app.js
 * Map-first MVP for the Connaught Place pilot zone (NDMC area, New Delhi).
 * Leaflet 1.9.4 + leaflet.heat 0.2.0 (+ MapLibre GL 4.7 for the vector basemap)
 * Data: data/streetlights.js (window.SLGIS_DATA)
 *
 * COORDINATE CONVENTION, read before editing
 *   GeoJSON (RFC 7946) stores positions as [longitude, latitude].
 *   Leaflet (L.latLng, setView, L.polyline, L.heatLayer, ...) expects [latitude, longitude].
 *   - L.geoJSON() converts for us: pointToLayer(feature, latlng) already receives an L.LatLng.
 *   - Anywhere else a raw GeoJSON position goes through toLatLng(), which delegates to
 *     Leaflet's own L.GeoJSON.coordsToLatLng(). No other code indexes
 *     geometry.coordinates by hand, so the two orders can never be mixed up.
 *   - Everything downstream (heatmap points, feeder polylines, distances) is built
 *     from L.LatLng objects, never from raw arrays.
 * ========================================================================== */
(() => {
  'use strict';

  // ========================================================================
  // 0. Boot guards
  // ========================================================================
  function fatal(message) {
    const box = document.createElement('div');
    box.className = 'fatal panel';
    box.setAttribute('role', 'alert');
    box.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><div><strong>The map could not start</strong><p></p></div>';
    box.querySelector('p').textContent = message;
    document.body.append(box);
    console.error('[Street Light GIS]', message);
  }

  const DATA = window.SLGIS_DATA;
  if (typeof window.L === 'undefined') {
    fatal('Leaflet could not be loaded. This MVP pulls its map engine, icons and basemap tiles from public CDNs, so it needs an internet connection.');
    return;
  }
  if (!DATA?.streetlights?.features?.length) {
    fatal('Dataset not found. Keep data/streetlights.js next to index.html (regenerate it with: python tools/generate_data.py).');
    return;
  }

  // ========================================================================
  // 1. Configuration & symbology
  // ========================================================================
  // Optional: a free CARTO Basemaps key (https://carto.com/basemaps/apikey) switches the night map to
  // CARTO Dark Matter. Keyless CARTO tiles now come back stamped "API KEY REQUIRED", so without a key
  // the night map is OpenFreeMap's "dark" vector style (free, no key) drawn by MapLibre GL in Leaflet.
  const CARTO_API_KEY = '';

  const META = DATA.meta ?? {};
  const TZ = 'Asia/Kolkata';

  const CONFIG = {
    centre: [META.centre?.lat ?? 28.63279, META.centre?.lng ?? 77.219705], // [lat, lng]: Leaflet order
    zoom: { min: 14, max: 20, start: 16 },
    snapRadiusM: 40,        // report mode: a click snaps to the nearest pole within this distance
    hitTolerancePx: 14,     // forgiving selection: a click this close to a pole selects it
    darkSpotLinkM: 80,      // faulty poles on the same road closer than this chain into one dark spot
    haloRadiusM: 16,        // light pool drawn around a working lamp
    heat: {
      radiusM: 38,          // ground radius of each faulty light's influence
      intensity: 0.5,
      // Semantic heat: one warm family whose lightness grows with failure density.
      gradient: { 0.2: '#3b0d0d', 0.4: '#7a1a1a', 0.55: '#b32626', 0.7: '#d03b3b', 0.85: '#ec835a', 1: '#ffd7c2' },
    },
    energy: { maxRadiusPx: 17, minRadiusPx: 3.5, legendValues: [25, 50, 100, 200] },
    anomalyRatio: 1.5,      // above 150 % of the modelled dusk-to-dawn baseline = consumption anomaly
    tariff: META.tariff_inr_per_kwh ?? 8,
    sla: META.sla_hours_by_priority ?? { Critical: 4, High: 24, Medium: 48, Low: 72 },
  };

  // Status colours are reserved for status, and every status also has its own form,
  // so the map never relies on red-vs-green alone.
  const STATUS = {
    Functional: { key: 'ok', label: 'Functional', color: '#0ca30c', icon: 'fa-circle-check' },
    Faulty: { key: 'fault', label: 'Faulty', color: '#d03b3b', icon: 'fa-triangle-exclamation' },
    'Under Maintenance': { key: 'maint', label: 'Under maintenance', color: '#fab219', icon: 'fa-screwdriver-wrench' },
  };
  const STATUS_ORDER = ['Functional', 'Faulty', 'Under Maintenance'];
  const METER_ORDER = ['Functional', 'Under Maintenance', 'Faulty'];
  const SURFACE_RING = '#0b0b0a';
  const NET = { line: '#3987e5', hi: '#86b6ef' };
  const PRIORITY_RANK = { Low: 0, Medium: 1, High: 2, Critical: 3 };
  const FIXTURE_NAMES = { LED: 'LED', HPS: 'High-pressure sodium', 'Metal Halide': 'Metal halide' };
  const LED_EQUIVALENT_W = { HPS: { 150: 70, 250: 120 }, 'Metal Halide': { 250: 150, 400: 200 } };

  const ISSUE_TYPES = [
    { id: 'out', label: 'Light not working', icon: 'fa-lightbulb', priority: 'Medium', faulty: true },
    { id: 'flicker', label: 'Flickering', icon: 'fa-bolt-lightning', priority: 'Medium', faulty: true },
    { id: 'day', label: 'On during the day', icon: 'fa-sun', priority: 'Low', faulty: true },
    { id: 'damaged', label: 'Damaged or leaning pole', icon: 'fa-triangle-exclamation', priority: 'High', faulty: true },
    { id: 'wiring', label: 'Exposed wiring / shock risk', icon: 'fa-plug-circle-exclamation', priority: 'Critical', faulty: true },
    { id: 'other', label: 'Something else', icon: 'fa-comment-dots', priority: 'Low', faulty: false },
  ];

  // Work-done options offered when a ticket is closed (first pattern matching the issue wins).
  const RESOLUTIONS = [
    [/driver|flicker/i, ['Replaced LED driver', 'Replaced driver and module connector']],
    [/surge/i, ['Replaced surge protection device']],
    [/water/i, ['Resealed luminaire, replaced gasket', 'Replaced luminaire']],
    [/cable|supply|stolen|theft/i, ['Located fault, jointed underground cable', 'Replaced stolen cable, secured junction box']],
    [/junction|connection/i, ['Re-terminated cables, replaced connector']],
    [/ignitor/i, ['Replaced ignitor']],
    [/ballast/i, ['Replaced ballast']],
    [/burnt|cycling|not glowing|not working/i, ['Replaced lamp', 'Replaced LED driver']],
    [/pole|damaged|leaning/i, ['Replaced pole, re-grouted foundation', 'Straightened and re-grouted pole']],
    [/day|timer|photocell/i, ['Replaced timer contactor', 'Replaced photocell']],
    [/tree|canopy|blocked/i, ['Pruned canopy, re-aimed luminaire']],
    [/wiring|shock/i, ['Insulated and boxed exposed wiring']],
  ];

  const ATTRIBUTION = {
    osm: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    openfreemap: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>',
    carto: '&copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    esriGray: 'Tiles &copy; Esri, HERE, Garmin',
    esriImagery: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  };

  // ========================================================================
  // 2. Utilities
  // ========================================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** Escape text (dataset strings, citizen input) before it enters an HTML template. */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const groupBy = (arr, keyFn) => arr.reduce((m, x) => {
    const k = keyFn(x);
    (m.get(k) ?? m.set(k, []).get(k)).push(x);
    return m;
  }, new Map());
  function mostCommon(values) {
    let best = null;
    for (const [value, items] of groupBy(values, (v) => v)) {
      if (!best || items.length > best.count) best = { value, count: items.length };
    }
    return best;
  }

  const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const formatter = (opts) => {
    const f = new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: TZ });
    return (v) => {
      const d = v instanceof Date ? v : new Date(v);
      return v == null || Number.isNaN(d.getTime()) ? '–' : f.format(d);
    };
  };
  const fmtDate = formatter({ day: 'numeric', month: 'short', year: 'numeric' });
  const fmtDateTime = formatter({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const fmtYear = formatter({ year: 'numeric' });
  const monthDate = (ym) => (ym ? new Date(`${ym}-15T12:00:00+05:30`) : null); // mid-month: no timezone edge cases
  const fmtMonthYear = formatter({ month: 'short', year: 'numeric' });
  const fmtMonthOnly = formatter({ month: 'short' });
  const fmtMonth = (ym) => fmtMonthYear(monthDate(ym));
  const fmtMonthShort = (ym) => fmtMonthOnly(monthDate(ym));
  const inr = (v) => `₹${nf0.format(Math.round(v))}`;
  const inrCompact = (v) => (v >= 1e5 ? `₹${nf1.format(v / 1e5)} lakh` : v >= 1e3 ? `₹${nf1.format(v / 1e3)}k` : inr(v));
  function fmtHours(h) {
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
    if (h < 48) return `${Math.round(h)} h`;
    return `${Math.round(h / 24)} d`;
  }
  const fmtAgo = (v) => {
    const h = (Date.now() - new Date(v).getTime()) / 3.6e6;
    return h < 1 / 60 ? 'just now' : `${fmtHours(h)} ago`;
  };
  const fmtLatLng = (ll) => `${Math.abs(ll.lat).toFixed(5)}° ${ll.lat >= 0 ? 'N' : 'S'}, ${Math.abs(ll.lng).toFixed(5)}° ${ll.lng >= 0 ? 'E' : 'W'}`;
  const fmtLatLngPlain = (ll) => `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;

  /** The ONE place a raw GeoJSON position is read: [lng, lat] -> L.LatLng(lat, lng). */
  const toLatLng = (feature) => L.GeoJSON.coordsToLatLng(feature.geometry.coordinates);

  /** Ground metres per screen pixel at the current zoom (Web Mercator). */
  const metersPerPixel = () => (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);

  /** Inline SVG matching the map symbol of a status (legend, pills, lists). */
  function statusSymbol(status, size = 14) {
    const s = STATUS[status] ?? STATUS.Functional;
    const c = size / 2;
    const r = size / 2 - 2;
    const paint = {
      ok: `fill="${s.color}" stroke="${SURFACE_RING}" stroke-width="2"`,
      fault: `fill="#160707" stroke="${s.color}" stroke-width="2.4"`,
      maint: `fill="${s.color}" fill-opacity=".28" stroke="${s.color}" stroke-width="2" stroke-dasharray="3 2.5"`,
    }[s.key];
    return `<svg class="sym" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" ${paint}/></svg>`;
  }
  const statusPill = (status) => `<span class="status-pill">${statusSymbol(status, 14)}${esc(STATUS[status]?.label ?? status)}</span>`;
  const section = (title, icon, body) => `<section class="sb-section"><h3 class="sb-h"><i class="fa-solid ${icon}" aria-hidden="true"></i>${esc(title)}</h3>${body}</section>`;
  const closeButton = '<button type="button" class="icon-btn" data-action="close" aria-label="Close details"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>';

  function meterHtml(stats, cls = '') {
    const label = METER_ORDER.map((k) => `${stats[k] ?? 0} ${STATUS[k].label.toLowerCase()}`).join(', ');
    const segments = METER_ORDER.filter((k) => stats[k] > 0)
      .map((k) => `<span style="flex:${stats[k]};background:${STATUS[k].color}"></span>`).join('');
    return `<div class="meter ${cls}" role="img" aria-label="${esc(label)}">${segments}</div>`;
  }

  // ========================================================================
  // 3. State & data model helpers
  // ========================================================================
  const state = {
    features: DATA.streetlights.features, // source of truth; the ticket workflow mutates it in-session
    byUid: new Map(),                     // uid -> { uid, feature, marker, halo, latlng }
    panels: new Map(),                    // panel id -> { id, feature, marker, latlng }
    tickets: new Map(),                   // ticket id -> ticket (one ticket can cover several poles)
    ticketSeq: {},                        // year -> last ticket number used
    filters: new Set(STATUS_ORDER),
    analysis: { heatmap: false, energy: false, feeder: false },
    overlays: { reports: true, zone: true },
    basemap: 'night',
    selected: null,                       // { type: 'pole' | 'panel' | 'spot' | 'report', id }
    trace: null,                          // feeder panel id being traced
    hoverFeeder: null,
    darkSpots: [],
    reportMode: false,
    draft: null,                          // pending citizen report: location + snapped pole
    reports: [],                          // citizen reports filed in this session
  };
  const layers = {};                      // Leaflet layers, created in init()
  const panelPoles = new Map();           // panel id -> Map(circuit -> [uid in wiring order])
  let energyMax = 1;

  const props = (uid) => state.byUid.get(uid)?.feature.properties;
  const allProps = () => state.features.map((f) => f.properties);
  const polesOfPanel = (id) => [...(panelPoles.get(id)?.values() ?? [])].flat().map(props);
  const circuitLength = (panelId, circuit) => panelPoles.get(panelId)?.get(circuit)?.length ?? 0;
  const faultyRecords = () => [...state.byUid.values()].filter((r) => r.feature.properties.status === 'Faulty');

  function statsOf(list) {
    const s = { total: list.length, Functional: 0, Faulty: 0, 'Under Maintenance': 0, watts: 0, kwh: 0 };
    for (const p of list) {
      s[p.status] = (s[p.status] ?? 0) + 1;
      s.watts += p.wattage * (p.arm_count ?? 1);
      s.kwh += p.energy_kwh || 0;
    }
    return s;
  }

  /** Merge duplicated ticket objects (one outage ticket can cover several poles) and find the ticket counters. */
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
          if (!p.ticket.priority) { // interim defaults from the category (replaced by the priority rules)
            const byCategory = { exposed: 'Critical', shock: 'Critical', damaged: 'High', not_working: 'Medium', flickering: 'Medium' };
            p.ticket.priority = byCategory[p.ticket.category] ?? 'Low';
            p.ticket.sla_hours = CONFIG.sla[p.ticket.priority];
            p.ticket.sla_due = new Date(new Date(p.ticket.raised_at).getTime() + p.ticket.sla_hours * 3.6e6).toISOString();
          }
          state.tickets.set(p.ticket.id, p.ticket);
        }
      }
      for (const t of [p.ticket, ...p.repair_history]) {
        const m = /^TKT-(\d{4})-(\d+)$/.exec(t?.id ?? t?.ticket_id ?? '');
        if (m) state.ticketSeq[m[1]] = Math.max(state.ticketSeq[m[1]] ?? 0, Number(m[2]));
      }
    }
  }
  function nextTicketId() {
    const year = fmtYear(new Date());
    state.ticketSeq[year] = (state.ticketSeq[year] ?? 100) + 1;
    return `TKT-${year}-${String(state.ticketSeq[year]).padStart(4, '0')}`;
  }

  /** Build the wiring order of every circuit from feeder_panel / circuit / circuit_seq. */
  function indexTopology() {
    for (const f of state.features) {
      const p = f.properties;
      const circuit = p.circuit ?? 'C1';
      const circuits = panelPoles.get(p.feeder_panel) ?? panelPoles.set(p.feeder_panel, new Map()).get(p.feeder_panel);
      (circuits.get(circuit) ?? circuits.set(circuit, []).get(circuit)).push(p.uid);
    }
    for (const circuits of panelPoles.values()) {
      for (const uids of circuits.values()) uids.sort((a, b) => (props(a).circuit_seq ?? 0) - (props(b).circuit_seq ?? 0));
    }
  }

  /** Warn loudly about missing, out-of-zone, or [lat, lng]-swapped coordinates. */
  function validateCoordinates(collection, idKey) {
    const centre = L.latLng(CONFIG.centre);
    const problems = [];
    for (const f of collection?.features ?? []) {
      const c = f.geometry?.coordinates;
      const id = f.properties?.[idKey] ?? '(no id)';
      if (f.geometry?.type !== 'Point' || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
        problems.push(`${id}: invalid Point geometry`);
        continue;
      }
      const offBy = toLatLng(f).distanceTo(centre);
      if (offBy > 50_000) {
        const swapped = Math.abs(c[0]) <= 90 && L.latLng(c[0], c[1]).distanceTo(centre) < 50_000;
        problems.push(swapped ? `${id}: looks like [lat, lng]; GeoJSON needs [lng, lat]` : `${id}: ${Math.round(offBy / 1000)} km outside the pilot zone`);
      }
    }
    if (problems.length) console.warn(`[Street Light GIS] ${problems.length} feature(s) need attention:`, problems);
    return problems.length === 0;
  }

  // Energy model: rated watts × arms × driver/ballast loss × dusk-to-dawn hours (meta.energy_model)
  function expectedKwh(p, ym = p.energy_month ?? META.energy_month) {
    const model = META.energy_model;
    const nightHours = META.night_hours_by_month?.[ym];
    if (!model || !nightHours || !p.wattage) return null;
    const loss = model.system_loss?.[p.fixture_type] ?? 1.1;
    return (p.wattage * (p.arm_count ?? 1) * loss * nightHours) / 1000;
  }
  const ledEquivalentW = (p) => LED_EQUIVALENT_W[p.fixture_type]?.[p.wattage] ?? Math.round(p.wattage * 0.5);
  function retrofitSavingKwh(p) {
    if (p.fixture_type === 'LED') return 0;
    const now = expectedKwh(p);
    const led = expectedKwh({ ...p, fixture_type: 'LED', wattage: ledEquivalentW(p) });
    return now && led ? Math.max(0, now - led) : 0;
  }
  const energyRatio = (p) => {
    const e = expectedKwh(p);
    return e ? p.energy_kwh / e : null;
  };
  const isAnomaly = (p) => (energyRatio(p) ?? 0) >= CONFIG.anomalyRatio;

  // ========================================================================
  // 4. Map, panes, basemaps & controls
  // ========================================================================
  const map = L.map('map', {
    zoomControl: false,
    minZoom: CONFIG.zoom.min,
    maxZoom: CONFIG.zoom.max,
    maxBounds: L.latLng(CONFIG.centre).toBounds(8000), // 8 km box around the pilot zone
    maxBoundsViscosity: 0.8,
  }).setView(CONFIG.centre, CONFIG.zoom.start);

  // Custom panes fix the drawing order. leaflet.heat always draws into overlayPane (z 400).
  for (const [name, z, interactive] of [
    ['zonePane', 350, false],
    ['glowPane', 410, false],
    ['darkSpotPane', 415, false],
    ['networkPane', 420, true],
    ['polesPane', 450, true],
    ['selectionPane', 460, false],
  ]) {
    const pane = map.createPane(name);
    pane.style.zIndex = String(z);
    if (!interactive) pane.style.pointerEvents = 'none';
  }

  /**
   * Night basemap, in order of preference:
   *   1. CARTO Dark Matter raster, when CARTO_API_KEY is set.
   *   2. OpenFreeMap "dark" vector style via MapLibre GL: keyless, sharp at every zoom.
   *   3. Esri World Dark Gray Canvas raster (native to z16) when WebGL or MapLibre is unavailable,
   *      or when the vector style fails to load.
   */
  function createNightBasemap() {
    if (CARTO_API_KEY) {
      return L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(CARTO_API_KEY)}`, {
        maxZoom: 20, attribution: `${ATTRIBUTION.osm} ${ATTRIBUTION.carto}`,
      });
    }
    if (typeof L.maplibreGL === 'function' && webglAvailable()) {
      const layer = L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/dark', attribution: `${ATTRIBUTION.openfreemap} ${ATTRIBUTION.osm}` });
      layer.on('add', () => watchVectorBasemap(layer)); // the binding builds a fresh MapLibre map on every add
      return layer;
    }
    return createDarkGrayRaster();
  }

  const createDarkGrayRaster = () => L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 16, attribution: `${ATTRIBUTION.esriGray}, ${ATTRIBUTION.osm}`,
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, maxNativeZoom: 16,
    }),
  ]);

  const createSatelliteBasemap = () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, maxNativeZoom: 19, attribution: ATTRIBUTION.esriImagery,
  });

  function webglAvailable() {
    try {
      const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
      gl?.getExtension('WEBGL_lose_context')?.loseContext(); // only probing; give the context back
      return Boolean(gl);
    } catch {
      return false;
    }
  }

  /** Hook the MapLibre map: silence missing sprite images, fall back to raster if the style never loads. */
  function watchVectorBasemap(layer) {
    const gl = layer.getMaplibreMap();
    if (!gl) return;
    gl.on('styleimagemissing', (e) => { // the style names a few sprite images it doesn't ship
      if (!gl.hasImage(e.id)) gl.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    // Only a style that fails or never arrives switches to the raster fallback; slow tiles or a slow
    // first frame (software WebGL) are fine, so the timer checks the real state when it fires.
    let done = false;
    const fallback = (reason) => {
      if (done || basemaps.night !== layer) return;
      done = true;
      console.warn(`[Street Light GIS] Vector basemap unavailable (${reason}); using the Esri dark raster instead.`);
      const active = map.hasLayer(layer);
      if (active) map.removeLayer(layer);
      basemaps.night = createDarkGrayRaster();
      if (active) basemaps.night.addTo(map);
    };
    const timer = setTimeout(() => { if (!gl.isStyleLoaded()) fallback('style did not load within 20 s'); }, 20000);
    layer.once('remove', () => clearTimeout(timer));
    gl.on('error', (e) => { // a failed style request (offline, server down); a single missing tile is not fatal
      const url = e?.error?.url ?? '';
      if (!gl.isStyleLoaded() && (!url || url.includes('/styles/'))) fallback(e?.error?.message ?? 'style request failed');
    });
  }

  const basemaps = { night: createNightBasemap(), satellite: createSatelliteBasemap() };
  basemaps.night.addTo(map);

  // Scale bar and attribution live in the bottom status bar; Leaflet keeps updating them there.
  const scaleControl = L.control.scale({ imperial: false, maxWidth: 96 }).addTo(map);
  $('#sb-scale').append(scaleControl.getContainer());
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  $('#sb-attrib').append(map.attributionControl.getContainer());

  // ========================================================================
  // 5. Streetlight layer: L.geoJSON · pointToLayer · onEachFeature
  // ========================================================================
  const zoomFactor = () => clamp(1.25 ** (map.getZoom() - 16), 0.62, 1.6);
  const baseRadius = () => 6 * zoomFactor();
  /** Proportional symbol: circle AREA scales with kWh (radius ∝ √kWh). */
  const energyRadius = (kwh) => Math.max(CONFIG.energy.minRadiusPx, CONFIG.energy.maxRadiusPx * Math.sqrt(Math.max(0, kwh) / energyMax) * zoomFactor());
  const poleRadius = (p) => (state.analysis.energy ? energyRadius(p.energy_kwh) : baseRadius());
  const isDimmed = (p) => Boolean(state.trace) && p.feeder_panel !== state.trace;
  const poleClassName = (p) => `pole pole--${(STATUS[p.status] ?? STATUS.Functional).key}`;
  const POLE_STATUS_CLASSES = ['pole--ok', 'pole--fault', 'pole--maint'];

  /**
   * Status symbology: Functional = lit disc · Faulty = unlit (hollow) ring · Under maintenance = dashed ring.
   * Form carries status as well as colour, so it survives red/green colour blindness.
   */
  function poleStyle(p) {
    const s = STATUS[p.status] ?? STATUS.Functional;
    const k = isDimmed(p) ? 0.16 : 1;
    const energy = state.analysis.energy;
    const base = { radius: poleRadius(p), opacity: k, dashArray: null };
    if (s.key === 'fault') return { ...base, color: s.color, weight: 2.4, fillColor: '#160707', fillOpacity: (energy ? 0.55 : 0.92) * k };
    if (s.key === 'maint') return { ...base, color: s.color, weight: 2, fillColor: s.color, fillOpacity: (energy ? 0.18 : 0.28) * k, dashArray: '3 2.5' };
    return { ...base, color: SURFACE_RING, weight: 2, fillColor: s.color, fillOpacity: (energy ? 0.62 : 1) * k };
  }

  function createPoleLayer() {
    return L.geoJSON(DATA.streetlights, {
      // `latlng` arrives already converted from GeoJSON [lng, lat] by Leaflet.
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        pane: 'polesPane',
        bubblingMouseEvents: false, // a pole click must not also fire a map click
        className: poleClassName(feature.properties),
        ...poleStyle(feature.properties),
      }),
      onEachFeature: registerPole,
    });
  }

  function registerPole(feature, marker) {
    const p = feature.properties;
    const latlng = marker.getLatLng();
    const halo = L.circle(latlng, {
      pane: 'glowPane', radius: CONFIG.haloRadiusM, stroke: false,
      fillColor: '#fff4d6', fillOpacity: 1, interactive: false, className: 'halo',
    });
    state.byUid.set(p.uid, { uid: p.uid, feature, marker, halo, latlng });
    marker.bindTooltip(() => poleTooltip(feature.properties), { className: 'sl-tooltip', direction: 'top', offset: [0, -10], opacity: 1 });
    marker.on('click', () => onPoleClick(p.uid));
  }

  function poleTooltip(p) {
    const s = STATUS[p.status] ?? STATUS.Functional;
    const energy = state.analysis.energy
      ? `<div class="tt-row">${nf1.format(p.energy_kwh)} kWh in ${esc(fmtMonth(p.energy_month))}${isAnomaly(p) ? ' · <i class="fa-solid fa-circle-exclamation" style="color:var(--serious)"></i> anomaly' : ''}</div>`
      : '';
    return `<div class="tt-value">${esc(p.uid)}</div>
      <div class="tt-row">${statusSymbol(p.status, 12)} ${esc(s.label)} · ${esc(p.fixture_type)} ${esc(p.wattage)} W${p.arm_count > 1 ? ` ×${p.arm_count}` : ''}</div>${energy}`;
  }

  /** Re-apply class, style, tooltip offset and light pool for one pole. */
  function applyPoleSymbology(rec) {
    const p = rec.feature.properties;
    const style = poleStyle(p);
    const cls = poleClassName(p);
    rec.marker.options.className = cls; // used again if the path is re-created (status filter)
    const el = rec.marker.getElement();
    if (el) {
      el.classList.remove(...POLE_STATUS_CLASSES);
      el.classList.add(...cls.split(' '));
    }
    rec.marker.setStyle(style);
    const tip = rec.marker.getTooltip();
    if (tip) tip.options.offset = [0, -(style.radius + 4)];
    const glow = p.status === 'Functional' && state.filters.has('Functional') && !state.analysis.energy && !isDimmed(p);
    if (glow !== layers.halo.hasLayer(rec.halo)) glow ? layers.halo.addLayer(rec.halo) : layers.halo.removeLayer(rec.halo);
  }

  /** Apply the status filter and symbology to every pole. */
  function refreshPoles() {
    for (const rec of state.byUid.values()) {
      const visible = state.filters.has(rec.feature.properties.status);
      if (visible !== layers.poles.hasLayer(rec.marker)) visible ? layers.poles.addLayer(rec.marker) : layers.poles.removeLayer(rec.marker);
      applyPoleSymbology(rec);
    }
    updateSelectionRing();
  }

  // ========================================================================
  // 6. Feeder panels & feeder network
  // ========================================================================
  const panelIcon = (id) => L.divIcon({
    className: 'panel-icon',
    html: `<span class="panel-glyph"><i class="fa-solid fa-bolt" aria-hidden="true"></i></span><span class="panel-tag">${esc(id)}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    tooltipAnchor: [0, -6],
  });

  function createPanelLayer() {
    return L.geoJSON(DATA.feederPanels ?? { type: 'FeatureCollection', features: [] }, {
      pointToLayer: (feature, latlng) => L.marker(latlng, { icon: panelIcon(feature.properties.panel_id), keyboard: true, riseOnHover: true }),
      onEachFeature: (feature, marker) => {
        const id = feature.properties.panel_id;
        state.panels.set(id, { id, feature, marker, latlng: marker.getLatLng() });
        marker.bindTooltip(() => panelTooltip(id), { className: 'sl-tooltip', direction: 'top', opacity: 1 });
        marker.on('click', (e) => onPanelClick(id, e));
        marker.on('add', () => {
          const el = marker.getElement();
          el?.setAttribute('aria-label', `Feeder panel ${id}`);
          syncPanelIcon(id);
        });
      },
    });
  }

  function panelTooltip(id) {
    const pp = state.panels.get(id).feature.properties;
    const s = statsOf(polesOfPanel(id));
    return `<div class="tt-value">${esc(id)}</div>
      <div class="tt-row">${esc(pp.name)} · ${s.total} poles${s.Faulty ? ` · ${s.Faulty} dark` : ''}</div>
      <div class="tt-hint">Click for panel details</div>`;
  }

  function circuitTooltip(panelId, circuit) {
    const s = statsOf((panelPoles.get(panelId)?.get(circuit) ?? []).map(props));
    return `<div class="tt-value">${esc(panelId)} · ${esc(circuit)}</div>
      <div class="tt-row">${s.total} poles · ${s.Faulty} dark · ${nf1.format(s.watts / 1000)} kW connected</div>
      <div class="tt-hint">Click to trace this feeder</div>`;
  }

  const feederLines = new Map(); // panel id -> [{ circuit, visible, flow, hit }]

  /**
   * One polyline per circuit, in wiring order: feeder panel -> pole #1 -> pole #2 ...
   * Poles are grouped by their shared `feeder_panel` property; every vertex is an L.LatLng.
   */
  function buildNetwork() {
    for (const [panelId, circuits] of panelPoles) {
      const panel = state.panels.get(panelId);
      const entries = [];
      for (const [circuit, uids] of circuits) {
        const path = [...(panel ? [panel.latlng] : []), ...uids.map((uid) => state.byUid.get(uid).latlng)];
        const visible = L.polyline(path, { pane: 'networkPane', color: NET.line, weight: 2, opacity: 0.7, lineCap: 'round', lineJoin: 'round', interactive: false });
        const flow = L.polyline(path, { pane: 'networkPane', color: '#e8f1fd', weight: 2.5, opacity: 0, dashArray: '1 9', lineCap: 'round', interactive: false, className: 'feeder-flow' });
        // Invisible 16 px stroke: an easy hover/click target for a 2 px line
        const hit = L.polyline(path, { pane: 'networkPane', color: '#000', weight: 16, opacity: 0, bubblingMouseEvents: false });
        hit.bindTooltip(() => circuitTooltip(panelId, circuit), { className: 'sl-tooltip', sticky: true, direction: 'top', offset: [0, -10], opacity: 1 });
        hit.on('mouseover', () => setHoverFeeder(panelId));
        hit.on('mouseout', () => setHoverFeeder(null));
        hit.on('click', (e) => onFeederLineClick(panelId, e));
        layers.network.addLayer(visible).addLayer(flow).addLayer(hit);
        entries.push({ circuit, visible, flow, hit });
      }
      feederLines.set(panelId, entries);
    }
  }

  function styleNetwork() {
    for (const [panelId, entries] of feederLines) {
      const traced = state.trace === panelId;
      const hot = traced || state.hoverFeeder === panelId;
      const dim = Boolean(state.trace) && !traced;
      for (const e of entries) {
        e.visible.setStyle({ color: hot ? NET.hi : NET.line, weight: hot ? 3 : 2, opacity: dim ? 0.14 : hot ? 0.95 : 0.7 });
        e.flow.setStyle({ opacity: traced ? 0.9 : 0 });
      }
    }
    for (const id of state.panels.keys()) syncPanelIcon(id);
  }

  function syncPanelIcon(id) {
    const el = state.panels.get(id)?.marker.getElement();
    if (!el) return;
    el.classList.toggle('has-outage', statsOf(polesOfPanel(id)).Faulty > 0);
    el.classList.toggle('is-dim', Boolean(state.trace) && state.trace !== id);
    el.classList.toggle('is-active', state.trace === id || (state.selected?.type === 'panel' && state.selected.id === id));
  }

  function setHoverFeeder(id) {
    if (state.hoverFeeder === id) return;
    state.hoverFeeder = id;
    styleNetwork();
  }

  /** Trace a feeder: highlight its circuits and the poles that depend on it, dim everything else. */
  function setTrace(id, { fit = false } = {}) {
    state.trace = id;
    if (id && !state.analysis.feeder) setAnalysis('feeder', true);
    refreshPoles();
    styleNetwork();
    renderTraceChip();
    renderInsights();
    if (id && fit) fitPanel(id);
  }

  function fitPanel(id) {
    const panel = state.panels.get(id);
    if (!panel) return;
    fitTo(L.latLngBounds([panel.latlng, ...polesOfPanel(id).map((p) => state.byUid.get(p.uid).latlng)]));
  }

  function renderTraceChip() {
    let chip = $('#trace-chip');
    if (!state.trace || state.reportMode) {
      chip?.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'trace-chip';
      chip.className = 'panel report-hint';
      chip.setAttribute('role', 'status');
      document.body.append(chip);
    }
    const s = statsOf(polesOfPanel(state.trace));
    chip.innerHTML = `<i class="fa-solid fa-diagram-project" style="color:var(--accent-hi)" aria-hidden="true"></i>
      <span>Tracing <span class="mono font-semibold">${esc(state.trace)}</span> · ${s.total} poles depend on it${s.Faulty ? ` · ${s.Faulty} dark` : ''}</span>
      <button type="button" class="icon-btn" aria-label="Stop tracing" style="width:26px;height:26px"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
    chip.querySelector('button').addEventListener('click', () => {
      setTrace(null);
      renderSelected({ keepScroll: true });
    });
  }

  // ========================================================================
  // 7. Spatial analysis: dark-spot heatmap · energy · anomalies
  // ========================================================================
  /** Heat radius in pixels for a fixed ground radius, so a dark spot means the same area at any zoom. */
  function heatRadiusPx() {
    const radius = clamp(CONFIG.heat.radiusM / metersPerPixel(), 8, 90);
    return { radius, blur: radius * 0.8 };
  }

  function refreshHeat() {
    // leaflet.heat's redraw() dereferences its map, so it throws once the layer has been removed: only touch it while it's on the map.
    if (!layers.heat || !map.hasLayer(layers.heat)) return;
    // [lat, lng, intensity] built from L.LatLng objects, never from raw GeoJSON arrays
    layers.heat.setLatLngs(faultyRecords().map(({ latlng }) => [latlng.lat, latlng.lng, CONFIG.heat.intensity]));
  }

  /**
   * Failure analysis: single-linkage clustering of faulty poles (union-find; n is small, O(n²) is fine).
   * Only poles on the same road are linked: a dark spot is a dark stretch of street, and two rings
   * separated by a building block are different stretches (often different contractors, too).
   */
  function computeDarkSpots() {
    const faulty = faultyRecords();
    const parent = faulty.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < faulty.length; i++) {
      for (let j = i + 1; j < faulty.length; j++) {
        const sameRoad = faulty[i].feature.properties.road === faulty[j].feature.properties.road;
        if (sameRoad && faulty[i].latlng.distanceTo(faulty[j].latlng) <= CONFIG.darkSpotLinkM) parent[find(i)] = find(j);
      }
    }
    const clusters = [...groupBy(faulty, (r) => find(faulty.indexOf(r))).values()]
      .filter((recs) => recs.length >= 2)
      .map(describeSpot)
      .sort((a, b) => b.recs.length - a.recs.length || b.lostW - a.lostW);
    clusters.forEach((s, i) => { s.id = `DS-${i + 1}`; });
    return clusters;
  }

  function describeSpot(recs) {
    const centre = L.latLng(sum(recs.map((r) => r.latlng.lat)) / recs.length, sum(recs.map((r) => r.latlng.lng)) / recs.length);
    const ps = recs.map((r) => r.feature.properties);
    let spanM = 0;
    for (const a of recs) for (const b of recs) spanM = Math.max(spanM, a.latlng.distanceTo(b.latlng));
    return {
      recs,
      centre,
      spanM,
      radiusM: Math.max(...recs.map((r) => centre.distanceTo(r.latlng))) + 28,
      lostW: sum(ps.map((p) => p.wattage * (p.arm_count ?? 1))),
      where: mostCommon(ps.map((p) => p.location.split(' · ')[0]))?.value ?? '',
      diagnosis: diagnose(ps),
    };
  }

  /** Likely root cause of a cluster, read from the feeder topology and the open tickets. */
  function diagnose(ps) {
    const circuits = new Set(ps.map((p) => `${p.feeder_panel}/${p.circuit}`));
    if (circuits.size === 1) {
      const { feeder_panel: panel, circuit } = ps[0];
      const seqs = ps.map((p) => p.circuit_seq).sort((a, b) => a - b);
      const first = seqs[0];
      const last = seqs[seqs.length - 1];
      const unbroken = seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1);
      if (unbroken && last === circuitLength(panel, circuit) && seqs.length >= 3) {
        return first === 1
          ? { kind: 'circuit', short: 'Whole circuit dark', text: `Every pole on ${panel}/${circuit} is out. Check the MCB and contactor inside feeder panel ${panel}.` }
          : { kind: 'circuit', short: `Probable cable fault after pole #${first - 1}`, text: `Poles #${first} to #${last} on ${panel}/${circuit} are out while pole #${first - 1} still works, so the fault is most likely in the cable between them. Send a cable-fault locator, not a lamp crew.` };
      }
      if (unbroken) {
        return { kind: 'local', short: `Adjacent poles #${first}–#${last} on ${panel}/${circuit}`, text: 'Neighbouring poles on one circuit share a junction box and cable section. Inspect those before replacing lamps.' };
      }
    }
    const common = mostCommon(ps.map((p) => p.ticket?.issue).filter(Boolean));
    if (common && common.count >= 2) {
      return { kind: 'pattern', short: `${common.count}× “${common.value}”`, text: `${common.count} nearby poles report “${common.value}”. Check surge protection and the fixture batch before swapping parts one by one.` };
    }
    return { kind: 'independent', short: 'Independent lamp failures', text: 'Unrelated failures close together. Bundle them into one crew visit.' };
  }

  function renderDarkSpots() {
    layers.darkSpots.clearLayers();
    state.darkSpots = computeDarkSpots();
    for (const s of state.darkSpots) {
      s.ring = L.circle(s.centre, {
        pane: 'darkSpotPane', radius: s.radiusM, interactive: false, fill: false,
        color: '#ec835a', weight: 1.5, opacity: 0.9, dashArray: '5 5', className: 'dark-spot',
      }).addTo(layers.darkSpots);
      const north = L.latLng(s.centre.lat + s.radiusM / 111_320, s.centre.lng); // label on the ring's north edge
      L.tooltip({ permanent: true, direction: 'top', className: 'ds-label', offset: [0, -2] })
        .setLatLng(north)
        .setContent(`${s.id} · ${s.recs.length} out`)
        .addTo(layers.darkSpots);
    }
  }

  function heatRampCss() {
    // Sort numerically: object keys like "1" would otherwise come before "0.2".
    const stops = Object.entries(CONFIG.heat.gradient).sort((a, b) => Number(a[0]) - Number(b[0]));
    return `linear-gradient(90deg, ${stops.map(([stop, c]) => `${c} ${Math.round(Number(stop) * 100)}%`).join(', ')})`;
  }

  // ========================================================================
  // 8. Selection, snapping & view helpers
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
    const hit = nearestPole(latlng, CONFIG.snapRadiusM);
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

  const sidebarInset = () => (document.body.classList.contains('sidebar-open') && window.innerWidth >= 640 ? Math.min(420, window.innerWidth) : 0);

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
    if (window.innerWidth < 640) return; // sidebar covers the map on phones
    map.panInside(latlng, { paddingTopLeft: [60, 60], paddingBottomRight: [sidebarInset() + 60, 100] });
  }

  function setHash(id) {
    try {
      history.replaceState(null, '', id ? `#${encodeURIComponent(id)}` : location.pathname + location.search);
    } catch { /* replaceState can be blocked in sandboxed previews */ }
  }

  // ========================================================================
  // 9. Sidebar views: pole · feeder panel · dark spot · citizen report
  // ========================================================================
  const sidebarEl = $('#sidebar');
  const sidebarBody = $('#sidebar-content');

  function showSidebar(html, { keepScroll = false } = {}) {
    const scroll = sidebarBody.scrollTop;
    sidebarBody.innerHTML = html;
    sidebarBody.scrollTop = keepScroll ? scroll : 0;
    sidebarEl.inert = false;
    sidebarEl.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sidebar-open');
  }

  function closeSidebar() {
    state.selected = null;
    document.body.classList.remove('sidebar-open');
    sidebarEl.setAttribute('aria-hidden', 'true');
    sidebarEl.inert = true;
    updateSelectionRing();
    styleNetwork();
    setHash(null);
  }

  /** Re-render whatever is selected (after data changes). Closes the sidebar if it no longer exists. */
  function renderSelected(opts = {}) {
    const sel = state.selected;
    if (!sel) return;
    const view = { pole: renderPoleView, panel: renderPanelView, spot: renderSpotView, report: renderReportView }[sel.type];
    const html = view?.(sel.id);
    if (html) showSidebar(html, opts);
    else closeSidebar();
  }

  function selectPole(uid, { zoom = false, focus = false } = {}) {
    const rec = state.byUid.get(uid);
    if (!rec) return;
    if (!state.filters.has(rec.feature.properties.status)) {
      state.filters.add(rec.feature.properties.status); // make sure the selected pole is visible
      refreshPoles();
      renderLegend();
    }
    state.selected = { type: 'pole', id: uid };
    renderSelected();
    updateSelectionRing();
    styleNetwork();
    if (zoom) flyToVisible(rec.latlng, Math.max(map.getZoom(), 18));
    else panIntoView(rec.latlng);
    setHash(uid);
    if (focus) $('#sb-title')?.focus();
  }

  function openPanel(id, { zoom = false } = {}) {
    if (!state.panels.has(id)) return;
    if (!state.analysis.feeder) setAnalysis('feeder', true);
    state.selected = { type: 'panel', id };
    if (state.trace !== id) setTrace(id);
    renderSelected();
    updateSelectionRing();
    styleNetwork();
    if (zoom) fitPanel(id);
    else panIntoView(state.panels.get(id).latlng);
    setHash(id);
  }

  function openSpot(id) {
    const s = state.darkSpots.find((d) => d.id === id);
    if (!s) return;
    state.selected = { type: 'spot', id };
    renderSelected();
    updateSelectionRing();
    fitTo(L.latLngBounds(s.recs.map((r) => r.latlng)).pad(0.8), 18);
    const el = s.ring?.getElement();
    if (el) {
      el.classList.remove('is-active');
      void el.getBoundingClientRect(); // restart the highlight animation
      el.classList.add('is-active');
    }
  }

  function openReport(id, { zoom = false } = {}) {
    const r = state.reports.find((x) => x.id === id);
    if (!r) return;
    state.selected = { type: 'report', id };
    renderSelected();
    updateSelectionRing();
    if (zoom) flyToVisible(r.latlng, Math.max(map.getZoom(), 18));
    else panIntoView(r.latlng);
  }

  // ---- pole view ----------------------------------------------------------
  function renderPoleView(uid) {
    const rec = state.byUid.get(uid);
    if (!rec) return null;
    const p = rec.feature.properties;
    const panel = state.panels.get(p.feeder_panel)?.feature.properties;
    const traced = state.trace === p.feeder_panel;
    const ratio = energyRatio(p);
    const coords = fmtLatLngPlain(rec.latlng);
    return `
      <div class="sb-head">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="eyebrow">Streetlight · ${esc(p.road)}</p>
            <h2 id="sb-title" class="sb-title" tabindex="-1">${esc(p.uid)}</h2>
            <p class="text-[13px] text-ink-2 mt-1 leading-snug">${esc(p.location)}</p>
          </div>
          ${closeButton}
        </div>
        <div class="flex flex-wrap items-center gap-2 mt-3">
          ${statusPill(p.status)}
          <span class="chip"><i class="fa-solid fa-bolt" aria-hidden="true"></i>${esc(p.feeder_panel)} · ${esc(p.circuit)} · #${esc(p.circuit_seq)}</span>
          ${isAnomaly(p) ? `<span class="chip chip--warn"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>Energy ${nf1.format(ratio)}× expected</span>` : ''}
        </div>
        <div class="sb-actions">
          <button type="button" class="btn btn-ghost" data-action="zoom-pole" data-uid="${esc(uid)}"><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>Zoom to</button>
          <button type="button" class="btn ${traced ? 'btn-primary' : 'btn-ghost'}" data-action="trace" data-panel="${esc(p.feeder_panel)}" aria-pressed="${traced}"><i class="fa-solid fa-diagram-project" aria-hidden="true"></i>${traced ? 'Untrace' : 'Trace feeder'}</button>
          <button type="button" class="btn btn-ghost" data-action="report-pole" data-uid="${esc(uid)}"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i>Report</button>
        </div>
      </div>
      <div class="sb-body">
        ${p.ticket ? ticketCard(p.ticket, { color: STATUS[p.status]?.color, contractor: p.contractor, selfUid: p.uid }) : `
          <div class="card card--quiet"><i class="fa-solid fa-circle-check" style="color:var(--ok)" aria-hidden="true"></i>
            <span>No open ticket. Last inspected ${esc(fmtDate(p.last_inspected))}.</span></div>`}
        ${section('Pole & fixture', 'fa-lightbulb', `<dl class="kv">
          <dt>Pole</dt><dd>${esc(p.pole_type)} · ${esc(p.pole_height_m)} m</dd>
          <dt>Fixture</dt><dd>${esc(FIXTURE_NAMES[p.fixture_type] ?? p.fixture_type)} · ${esc(p.wattage)} W${p.arm_count > 1 ? ` × ${esc(p.arm_count)} arms` : ''}</dd>
          <dt>Colour temp.</dt><dd>${esc(p.cct_k)} K</dd>
          <dt>Monitoring</dt><dd>${p.ccms_node ? 'CCMS node (remote fault alerts)' : 'None; faults found by night patrol'}</dd>
          <dt>Pole erected</dt><dd>${esc(fmtDate(p.install_date))}</dd>
          <dt>Luminaire fitted</dt><dd>${esc(fmtDate(p.fixture_installed))}</dd>
          <dt>Last inspected</dt><dd>${esc(fmtDate(p.last_inspected))}</dd>
          <dt>GIS location</dt><dd><span class="mono text-[12.5px]">${coords}</span>
            <button type="button" class="link text-xs ml-1" data-action="copy" data-copy="${coords}">copy</button>
            <span class="block text-[11px] text-ink-3">latitude, longitude · WGS 84</span></dd>
        </dl>`)}
        ${section('Electrical', 'fa-plug', `<dl class="kv">
          <dt>Feeder panel</dt><dd><button type="button" class="link mono" data-action="open-panel" data-panel="${esc(p.feeder_panel)}">${esc(p.feeder_panel)}</button>${panel ? ` <span class="text-ink-3">· ${esc(panel.name)}</span>` : ''}</dd>
          <dt>Circuit</dt><dd>${esc(p.circuit)} · pole ${esc(p.circuit_seq)} of ${circuitLength(p.feeder_panel, p.circuit)}</dd>
          <dt>Phase</dt><dd>${esc(p.phase)}</dd>
          <dt>Connected load</dt><dd>${nf0.format(p.wattage * (p.arm_count ?? 1))} W</dd>
        </dl>`)}
        ${energySection(p)}
        ${contractorSection(p.contractor)}
        ${historySection(p)}
      </div>`;
  }

  /** Active ticket card, shared by the pole view and the citizen-report view. */
  function ticketCard(t, { color = STATUS.Faulty.color, contractor = null, selfUid = null } = {}) {
    const others = (t.pole_uids ?? []).filter((u) => u !== selfUid);
    const statusLine = t.status === 'In Progress'
      ? '<span class="ticket-status"><i class="fa-solid fa-person-digging" aria-hidden="true"></i>In progress</span>'
      : t.status === 'Awaiting dusk check'
        ? '<span class="ticket-status"><i class="fa-solid fa-moon" aria-hidden="true"></i>Awaiting dusk check</span>'
        : '<span class="ticket-status"><i class="fa-solid fa-circle-dot" aria-hidden="true"></i>Open · awaiting crew</span>';
    return `
      <section class="card card--ticket" style="--c:${color}" aria-label="Active ticket">
        <div class="flex items-center justify-between gap-2">
          <span class="eyebrow">Active ticket</span>${statusLine}
        </div>
        <div class="flex items-baseline justify-between gap-2 mt-1.5">
          <span class="mono text-[15px] font-semibold">${esc(t.id)}</span>
          <span class="priority priority--${esc(String(t.priority).toLowerCase())}">${esc(t.priority)} priority</span>
        </div>
        <p class="text-[14px] mt-1">${esc(t.issue)}</p>
        ${others.length ? `<p class="text-xs text-ink-2 mt-1">Same ticket covers ${others.map((u) => `<button type="button" class="link mono" data-action="select-pole" data-uid="${esc(u)}">${esc(u.replace('SL-CP-', ''))}</button>`).join(', ')}</p>` : ''}
        <dl class="kv mt-3">
          <dt>Raised</dt><dd>${esc(fmtDateTime(t.raised_at))} <span class="text-ink-3">(${esc(fmtAgo(t.raised_at))}) · ${esc(t.source)}</span></dd>
          <dt>Service level</dt><dd>${slaHtml(t)}</dd>
          <dt>Contractor</dt><dd>${esc(contractor?.name ?? 'Zonal survey team')}</dd>
          <dt>Crew</dt><dd>${t.assigned_crew ? `${esc(t.assigned_crew)}${t.work_started_at ? ` <span class="text-ink-3">· on site since ${esc(fmtDateTime(t.work_started_at))}</span>` : ''}` : '<span class="text-ink-3">Not assigned yet</span>'}</dd>
          ${t.complaints ? `<dt>Citizen reports</dt><dd>${esc(t.complaints)} merged into this ticket</dd>` : ''}
        </dl>
        ${t.notes ? `<p class="note">${esc(t.notes)}</p>` : ''}
        ${workflowControls(t, contractor)}
      </section>`;
  }

  function slaHtml(t) {
    const leftH = (new Date(t.sla_due).getTime() - Date.now()) / 3.6e6;
    return leftH < 0
      ? `<span class="sla-breached"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> Breached ${esc(fmtHours(-leftH))} ago</span> <span class="text-ink-3">· ${esc(t.sla_hours)} h target</span>`
      : `<span class="sla-ok"><i class="fa-regular fa-clock" aria-hidden="true"></i> Due in ${esc(fmtHours(leftH))}</span> <span class="text-ink-3">· ${esc(fmtDateTime(t.sla_due))}</span>`;
  }

  function workflowControls(t, contractor) {
    const crews = META.contractors?.[contractor?.id]?.crews ?? ['Survey crew S1', 'Survey crew S2'];
    const label = '<p class="workflow-label"><i class="fa-solid fa-user-gear" aria-hidden="true"></i>Operator action (demo workflow)</p>';
    if (t.status === 'Open') {
      return `<div class="workflow">${label}<div class="flex gap-2">
        <select class="input flex-1" data-role="crew" aria-label="Crew to dispatch">${crews.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
        <button type="button" class="btn btn-primary" data-action="dispatch" data-ticket="${esc(t.id)}"><i class="fa-solid fa-truck-fast" aria-hidden="true"></i>Dispatch</button>
      </div></div>`;
    }
    if (t.status === 'In Progress') {
      const options = [...(RESOLUTIONS.find(([re]) => re.test(t.issue ?? ''))?.[1] ?? []), 'Repaired on site (other)'];
      return `<div class="workflow">${label}<div class="flex gap-2">
        <select class="input flex-1" data-role="resolution" aria-label="Work carried out">${options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>
        <button type="button" class="btn btn-primary" data-action="resolve" data-ticket="${esc(t.id)}"><i class="fa-solid fa-check" aria-hidden="true"></i>Close ticket</button>
      </div></div>`;
    }
    return '';
  }

  function energySection(p) {
    const expected = expectedKwh(p);
    const ratio = energyRatio(p);
    const saving = retrofitSavingKwh(p);
    const delta = ratio == null ? null : Math.round((ratio - 1) * 100);
    return section('Energy', 'fa-bolt', `
      <div class="flex items-end justify-between gap-3">
        <div>
          <div class="big-number">${nf1.format(p.energy_kwh)}<span class="unit">kWh</span></div>
          <div class="text-xs text-ink-3 mt-1">${esc(fmtMonth(p.energy_month))} · ≈ ${esc(inr(p.energy_kwh * CONFIG.tariff))} at ₹${esc(CONFIG.tariff)}/kWh</div>
        </div>
        ${expected ? `<div class="text-right text-xs text-ink-3">Modelled baseline<br>
          <span class="text-ink-1 font-medium">${nf1.format(expected)} kWh</span> (${delta >= 0 ? '+' : '−'}${Math.abs(delta)}%)</div>` : ''}
      </div>
      ${sparkline(p)}
      ${isAnomaly(p) ? `<div class="callout callout--warn"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><div>
        <strong>Consumption anomaly:</strong> ${nf1.format(ratio)}× the dusk-to-dawn baseline. Most likely <strong>day burning</strong>
        (stuck timer or photocell). The lamp still lights, so nobody reports it.
        ${p.ticket ? '' : ` <button type="button" class="link" data-action="report-pole" data-uid="${esc(p.uid)}" data-issue="day">Raise a ticket</button>`}</div></div>` : ''}
      ${saving > 0 ? `<div class="callout"><i class="fa-solid fa-leaf" aria-hidden="true"></i><div>
        Legacy ${esc((FIXTURE_NAMES[p.fixture_type] ?? p.fixture_type).toLowerCase())} fixture. An LED ${ledEquivalentW(p)} W retrofit would save
        <strong>≈ ${nf0.format(saving)} kWh/month</strong> (≈ ${esc(inr(saving * CONFIG.tariff))}).</div></div>` : ''}`);
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
      <dl class="kv mt-2">
        <dt>Contact</dt><dd>${esc(ctr.contact_person)} · <span class="mono text-[12.5px]">${esc(ctr.phone)}</span></dd>
        <dt>Email</dt><dd><a class="link" href="mailto:${esc(ctr.email)}">${esc(ctr.email)}</a></dd>
        <dt>Contract</dt><dd class="mono text-[12.5px]">${esc(ctr.contract_ref)}</dd>
        <dt>Restore within</dt><dd>${esc(ctr.sla_hours)} h (standard faults)</dd>
      </dl>`);
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
    const icon = { Retrofit: 'fa-bolt', Preventive: 'fa-broom', Corrective: 'fa-wrench' }[h.type] ?? 'fa-wrench';
    const sla = h.type !== 'Corrective' ? ''
      : h.sla_met ? '<span class="ok"><i class="fa-solid fa-check" aria-hidden="true"></i> SLA met</span>'
        : '<span class="miss"><i class="fa-solid fa-xmark" aria-hidden="true"></i> SLA missed</span>';
    const meta = [
      `<span class="mono">${esc(h.ticket_id)}</span>`,
      esc(h.crew),
      h.downtime_h != null ? `${esc(fmtHours(h.downtime_h))} down` : '',
      sla,
      h.cost_inr ? esc(inr(h.cost_inr)) : '',
    ].filter(Boolean).join(' · ');
    return `<li class="tl-item">
      <span class="tl-node${h.type === 'Retrofit' ? ' tl-node--retrofit' : ''}"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
      <div class="flex items-baseline justify-between gap-2"><span class="tl-title">${esc(h.issue)}</span><time class="tl-date" datetime="${esc(h.resolved_at)}">${esc(fmtDate(h.resolved_at))}</time></div>
      <p class="tl-action">${esc(h.action)}</p>
      <p class="tl-meta">${meta}</p></li>`;
  }

  // ---- feeder panel view ------------------------------------------------------
  function renderPanelView(id) {
    const panel = state.panels.get(id);
    if (!panel) return null;
    const pp = panel.feature.properties;
    const list = polesOfPanel(id);
    const s = statsOf(list);
    const loss = META.energy_model?.system_loss ?? {};
    const loadKw = sum(list.map((p) => (p.wattage * (p.arm_count ?? 1) * (loss[p.fixture_type] ?? 1.1)) / 1000));
    const capacityKw = (pp.capacity_kva ?? 0) * 0.9; // assumed power factor 0.9
    const traced = state.trace === id;
    const circuits = [...(panelPoles.get(id) ?? new Map())];
    return `
      <div class="sb-head">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="eyebrow">Feeder panel · ${esc(pp.road)}</p>
            <h2 id="sb-title" class="sb-title" tabindex="-1">${esc(id)}</h2>
            <p class="text-[13px] text-ink-2 mt-1 leading-snug">${esc(pp.name)} · ${esc(pp.location)}</p>
          </div>
          ${closeButton}
        </div>
        <div class="sb-actions" style="grid-template-columns:1fr 1fr">
          <button type="button" class="btn btn-ghost" data-action="zoom-panel" data-panel="${esc(id)}"><i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>Zoom to feeder</button>
          <button type="button" class="btn ${traced ? 'btn-primary' : 'btn-ghost'}" data-action="trace" data-panel="${esc(id)}" aria-pressed="${traced}"><i class="fa-solid fa-diagram-project" aria-hidden="true"></i>${traced ? 'Stop tracing' : 'Trace on map'}</button>
        </div>
      </div>
      <div class="sb-body">
        <div class="grid grid-cols-3 gap-2 mt-4">
          <div class="stat"><span class="stat-label">Poles</span><span class="stat-value">${s.total}</span><span class="stat-sub">${circuits.length} circuits</span></div>
          <div class="stat"><span class="stat-label">Dark now</span><span class="stat-value">${s.Faulty}</span><span class="stat-sub">${s['Under Maintenance']} in repair</span></div>
          <div class="stat"><span class="stat-label">Load</span><span class="stat-value">${nf1.format(loadKw)}</span><span class="stat-sub">kW of ${nf1.format(capacityKw)} kW</span></div>
        </div>
        <div class="mt-3">${meterHtml(s)}</div>
        ${section('Circuits · wiring order', 'fa-diagram-project', circuits.map(([circuit, uids]) => circuitDiagram(circuit, uids)).join(''))}
        ${section('Panel', 'fa-plug', `<dl class="kv">
          <dt>Supply</dt><dd>${esc(pp.source_dt)}</dd>
          <dt>Capacity</dt><dd>${esc(pp.capacity_kva)} kVA</dd>
          <dt>Control</dt><dd>${esc(pp.controller)}</dd>
          <dt>Commissioned</dt><dd>${esc(fmtDate(pp.commissioned))}</dd>
          <dt>Energy</dt><dd>${nf0.format(s.kwh)} kWh in ${esc(fmtMonth(META.energy_month))} · ≈ ${esc(inr(s.kwh * CONFIG.tariff))}</dd>
          <dt>GIS location</dt><dd class="mono text-[12.5px]">${fmtLatLngPlain(panel.latlng)}</dd>
        </dl>`)}
        ${contractorSection(META.contractors?.[pp.contractor_id])}
      </div>`;
  }

  /** Single-line diagram of one circuit: panel -> poles in wiring order, each pole clickable. */
  function circuitDiagram(circuit, uids) {
    const list = uids.map(props);
    const s = statsOf(list);
    return `<div class="mb-4">
      <div class="flex items-baseline justify-between text-[12.5px]"><span class="font-medium text-ink-1">Circuit ${esc(circuit)}</span>
        <span class="text-ink-3">${list.length} poles · ${s.Faulty} dark · ${nf1.format(s.watts / 1000)} kW</span></div>
      <div class="sld" role="list">
        <div class="sld-node" role="listitem"><span class="sld-panel" aria-label="Feeder panel"><i class="fa-solid fa-bolt" aria-hidden="true"></i></span><span class="sld-label">FP</span></div>
        ${list.map((p) => `<div class="sld-node" role="listitem">
          <button type="button" class="sld-pole" data-action="select-pole" data-uid="${esc(p.uid)}" title="${esc(p.uid)}"
            aria-label="${esc(`${p.uid}, pole ${p.circuit_seq}, ${STATUS[p.status]?.label ?? p.status}`)}">${statusSymbol(p.status, 16)}</button>
          <span class="sld-label">${esc(p.circuit_seq)}</span></div>`).join('')}
      </div></div>`;
  }

  // ---- dark spot view -----------------------------------------------------------
  function renderSpotView(id) {
    const s = state.darkSpots.find((d) => d.id === id);
    if (!s) return null;
    const ps = s.recs.map((r) => r.feature.properties);
    const tickets = [...new Set(ps.map((p) => p.ticket?.id).filter(Boolean))];
    const icon = { circuit: 'fa-bolt', local: 'fa-box-open', pattern: 'fa-layer-group', independent: 'fa-list-check' }[s.diagnosis.kind];
    return `
      <div class="sb-head">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="eyebrow">Dark spot · failure analysis</p>
            <h2 id="sb-title" class="sb-title" tabindex="-1">${esc(s.id)}</h2>
            <p class="text-[13px] text-ink-2 mt-1">${esc(s.where)}</p>
          </div>
          ${closeButton}
        </div>
        <div class="grid grid-cols-3 gap-2 mt-3">
          <div class="stat"><span class="stat-label">Lights out</span><span class="stat-value">${ps.length}</span><span class="stat-sub">faulty poles</span></div>
          <div class="stat"><span class="stat-label">Lost load</span><span class="stat-value">${nf1.format(s.lostW / 1000)}</span><span class="stat-sub">kW of lighting</span></div>
          <div class="stat"><span class="stat-label">Dark stretch</span><span class="stat-value">≈ ${nf0.format(Math.round(s.spanM / 5) * 5)}</span><span class="stat-sub">metres</span></div>
        </div>
      </div>
      <div class="sb-body">
        <div class="callout callout--warn" style="margin-top:16px"><i class="fa-solid ${icon}" aria-hidden="true"></i>
          <div><strong>${esc(s.diagnosis.short)}.</strong> ${esc(s.diagnosis.text)}</div></div>
        ${section('Affected poles', 'fa-lightbulb', `<ul class="insight-list">${ps.map((p) => `<li>
          <button type="button" class="insight-item" data-action="select-pole" data-uid="${esc(p.uid)}">${statusSymbol(p.status, 14)}
            <span class="min-w-0 flex-1"><span class="block mono text-[12px] text-ink-1">${esc(p.uid)}</span>
            <span class="block text-[11.5px] text-ink-3 truncate">${esc(p.feeder_panel)}/${esc(p.circuit)} #${esc(p.circuit_seq)} · ${esc(p.ticket?.issue ?? 'no ticket')}</span></span>
          </button></li>`).join('')}</ul>`)}
        ${tickets.length ? section('Open tickets', 'fa-ticket', `<p class="text-[13px] text-ink-2">${tickets.map((t) => `<span class="mono">${esc(t)}</span>`).join(', ')}</p>`) : ''}
      </div>`;
  }

  // ---- citizen report view (location with no mapped pole) -----------------------
  function renderReportView(id) {
    const r = state.reports.find((x) => x.id === id);
    if (!r) return null;
    const t = state.tickets.get(r.ticket_id);
    return `
      <div class="sb-head">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="eyebrow">Citizen report · unmapped location</p>
            <h2 id="sb-title" class="sb-title" tabindex="-1">${esc(r.ticket_id)}</h2>
            <p class="text-[13px] text-ink-2 mt-1">${esc(r.issue)}</p>
          </div>
          ${closeButton}
        </div>
      </div>
      <div class="sb-body">
        ${t ? ticketCard(t, {}) : `<div class="card card--quiet"><i class="fa-solid fa-circle-check" style="color:var(--ok)" aria-hidden="true"></i><span>Ticket closed${r.resolution ? `: ${esc(r.resolution)}` : ''}.</span></div>`}
        ${section('Report', 'fa-bullhorn', `<dl class="kv">
          <dt>Filed</dt><dd>${esc(fmtDateTime(r.created_at))}</dd>
          <dt>GIS location</dt><dd class="mono text-[12.5px]">${fmtLatLngPlain(r.latlng)}</dd>
          <dt>Nearest pole</dt><dd>None within ${CONFIG.snapRadiusM} m; a survey crew will verify the spot</dd>
          ${r.description ? `<dt>Details</dt><dd>${esc(r.description)}</dd>` : ''}
          ${r.name ? `<dt>Reported by</dt><dd>${esc(r.name)}</dd>` : ''}
          ${r.photo ? `<dt>Photo</dt><dd>${esc(r.photo)}</dd>` : ''}
        </dl>`)}
      </div>`;
  }

  // ========================================================================
  // 10. Ticket workflow (operator demo): dispatch -> resolve
  // ========================================================================
  function dispatchTicket(id, crew) {
    const t = state.tickets.get(id);
    if (!t || t.status !== 'Open' || !crew) return;
    t.status = 'In Progress';
    t.assigned_crew = crew;
    t.work_started_at = new Date().toISOString();
    for (const uid of t.pole_uids ?? []) {
      const p = props(uid);
      if (p) p.status = 'Under Maintenance';
    }
    afterDataChange();
    const n = t.pole_uids?.length ?? 0;
    toast({ tone: 'info', icon: 'fa-truck-fast', title: `${crew} dispatched`, body: `${t.id}: ${n ? `${n} pole${n === 1 ? ' is' : 's are'} now under maintenance.` : 'Survey crew on the way.'}` });
  }

  function resolveTicket(id, action) {
    const t = state.tickets.get(id);
    if (!t || t.status !== 'In Progress') return;
    const now = new Date();
    const downtime = Math.max(0, (now - new Date(t.raised_at)) / 3.6e6);
    for (const uid of t.pole_uids ?? []) {
      const p = props(uid);
      if (!p) continue;
      p.repair_history.unshift({
        ticket_id: t.id, type: 'Corrective', issue: t.issue, action, source: t.source, priority: t.priority,
        raised_at: t.raised_at, resolved_at: now.toISOString(), downtime_h: Math.round(downtime * 10) / 10,
        sla_met: downtime <= t.sla_hours, crew: t.assigned_crew, contractor: p.contractor?.name ?? null,
        cost_inr: null, status: 'Closed',
      });
      p.ticket = null;
      p.status = 'Functional';
      p.last_inspected = now.toISOString().slice(0, 10);
    }
    t.status = 'Resolved';
    state.tickets.delete(t.id);
    for (const r of state.reports) if (r.ticket_id === t.id) r.resolution = action;
    afterDataChange();
    const n = t.pole_uids?.length ?? 0;
    toast({ tone: 'ok', icon: 'fa-circle-check', title: `${t.id} closed`, body: `${action}.${n ? ` ${n} pole${n === 1 ? ' is' : 's are'} lit again.` : ''}` });
  }

  /** Everything that depends on pole status, after any change. */
  function afterDataChange() {
    refreshPoles();
    if (state.analysis.heatmap) {
      refreshHeat();
      renderDarkSpots();
    }
    styleNetwork();
    renderKpis();
    renderLegend();
    renderInsights();
    renderTraceChip();
    renderSelected({ keepScroll: true });
    updateSelectionRing();
  }

  // ========================================================================
  // 11. Citizen fault reporting: report mode -> snap -> modal -> mock ticket
  // ========================================================================
  const reportBtn = $('#report-btn');
  const modal = $('#report-modal');
  const form = $('#report-form');
  let lastFocus = null;
  let photoUrl = null;

  function setReportMode(on) {
    state.reportMode = on;
    document.body.classList.toggle('is-reporting', on);
    map.getContainer().classList.toggle('is-reporting', on); // crosshair cursor over the whole map
    $('#report-hint').hidden = !on;
    reportBtn.setAttribute('aria-pressed', String(on));
    reportBtn.querySelector('.fab-label').textContent = on ? 'Cancel reporting' : 'Report an issue';
    reportBtn.querySelector('.fab-icon i').className = `fa-solid ${on ? 'fa-xmark' : 'fa-bullhorn'}`;
    if (!on) clearSnap();
    renderTraceChip();
  }

  /** Open the report form for a clicked location, snapping to a pole when one is close enough. */
  function beginReport(latlng, uid = null, presetIssue = null) {
    let rec = uid ? state.byUid.get(uid) : null;
    let distance = 0;
    if (!rec) {
      const hit = nearestPole(latlng, CONFIG.snapRadiusM);
      if (hit) ({ rec, distance } = hit);
    }
    state.draft = { clickLatLng: latlng, latlng: rec ? rec.latlng : latlng, uid: rec?.uid ?? null, distance };
    clearSnap();
    layers.draftPin.setLatLng(state.draft.latlng).addTo(map);
    openReportModal(presetIssue);
  }

  function draftLocationHtml() {
    const d = state.draft;
    if (d.uid) {
      const p = props(d.uid);
      const how = d.distance > 1 ? `Snapped to the nearest pole, ${Math.round(d.distance)} m from your click.` : 'Pole selected on the map.';
      return `<div class="loc-card">${statusSymbol(p.status, 16)}<div class="min-w-0">
        <div class="mono text-[13px] font-semibold">${esc(p.uid)} <span class="font-sans font-normal text-ink-3">· ${esc(STATUS[p.status]?.label)}</span></div>
        <div class="text-xs text-ink-2">${esc(p.location)}</div>
        <div class="text-[11.5px] text-ink-3 mt-1">${how}${p.ticket ? ` It already has ticket <span class="mono">${esc(p.ticket.id)}</span>; your report will be added to it.` : ''}</div>
      </div></div>`;
    }
    return `<div class="loc-card"><i class="fa-solid fa-location-dot" aria-hidden="true"></i><div class="min-w-0">
      <div class="mono text-[13px] font-semibold">${fmtLatLngPlain(d.latlng)}</div>
      <div class="text-xs text-ink-2">No mapped pole within ${CONFIG.snapRadiusM} m. The ticket will be raised for this exact spot and a survey crew will verify it.</div>
    </div></div>`;
  }

  function openReportModal(presetIssue) {
    lastFocus = document.activeElement;
    form.reset();
    clearPhoto();
    $('#rm-issue-error').hidden = true;
    $('#rm-phone-error').hidden = true;
    $('#rm-count').textContent = '0/500';
    $('#rm-location').innerHTML = draftLocationHtml();
    const radio = form.querySelector(`input[name="issue"][value="${presetIssue ?? 'out'}"]`);
    if (radio) radio.checked = true;
    modal.hidden = false;
    radio?.focus();
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

  /** Create (or merge into) a mock ticket, update the map, and show the result. */
  function submitReport({ issue, description, name, phone, photo }) {
    const draft = state.draft;
    if (!draft) return;
    const now = new Date();
    const p = draft.uid ? props(draft.uid) : null;
    let ticket = p?.ticket ?? null;
    let merged = false;
    if (ticket) {
      merged = true;
      ticket.complaints = (ticket.complaints ?? 0) + 1;
      if (description) ticket.notes = [ticket.notes, `Citizen: “${description}”`].filter(Boolean).join(' ');
      if (PRIORITY_RANK[issue.priority] > PRIORITY_RANK[ticket.priority]) { // a more serious report escalates the ticket
        ticket.priority = issue.priority;
        ticket.sla_hours = CONFIG.sla[issue.priority];
        ticket.sla_due = new Date(now.getTime() + ticket.sla_hours * 3.6e6).toISOString();
      }
    } else {
      const slaHours = CONFIG.sla[issue.priority];
      ticket = {
        id: nextTicketId(), status: 'Open', priority: issue.priority, issue: issue.label,
        source: 'Citizen report (web)', raised_at: now.toISOString(), sla_hours: slaHours,
        sla_due: new Date(now.getTime() + slaHours * 3.6e6).toISOString(),
        assigned_crew: null, work_started_at: null, complaints: 1,
        notes: description ? `Citizen: “${description}”` : null, pole_uids: p ? [p.uid] : [],
      };
      state.tickets.set(ticket.id, ticket);
      if (p) {
        p.ticket = ticket;
        if (issue.faulty && p.status === 'Functional') p.status = 'Faulty';
      }
    }
    const report = {
      id: `CR-${String(state.reports.length + 1).padStart(3, '0')}`, ticket_id: ticket.id, uid: p?.uid ?? null,
      latlng: draft.clickLatLng, issue: issue.label, description, name, phone, photo, created_at: now.toISOString(),
    };
    state.reports.push(report);
    addReportPin(report);
    closeReportModal({ restoreFocus: false });
    setReportMode(false);
    afterDataChange();
    if (p) selectPole(p.uid);
    else openReport(report.id);
    toast(merged
      ? { tone: 'info', icon: 'fa-link', title: `Added to ticket ${ticket.id}`, body: `${p.uid} already had an open ticket. ${ticket.complaints} citizen reports are now merged into it.` }
      : { tone: 'ok', icon: 'fa-circle-check', title: `Ticket ${ticket.id} raised`,
        body: p ? `${issue.label} at ${p.uid}. ${p.contractor?.name ?? 'The contractor'} has ${ticket.sla_hours} h to respond.`
          : `${issue.label} at an unmapped spot. A survey crew will verify it within ${ticket.sla_hours} h.` });
  }

  const reportIcon = (draft = false) => L.divIcon({
    className: `report-pin${draft ? ' is-draft' : ''}`,
    html: '<span class="pin"><i class="fa-solid fa-bullhorn" aria-hidden="true"></i></span>',
    iconSize: [26, 26],
    iconAnchor: [13, 31],
    tooltipAnchor: [0, -28],
  });

  function addReportPin(r) {
    const m = L.marker(r.latlng, { icon: reportIcon(), keyboard: true });
    m.bindTooltip(() => `<div class="tt-value">${esc(r.ticket_id)}</div>
      <div class="tt-row">${esc(r.issue)} · ${esc(fmtDateTime(r.created_at))}</div>
      <div class="tt-hint">${r.uid ? esc(r.uid) : 'Unmapped location'}</div>`, { className: 'sl-tooltip', direction: 'top', opacity: 1 });
    m.on('click', (e) => {
      if (state.reportMode) return beginReport(e.latlng);
      if (r.uid) selectPole(r.uid);
      else openReport(r.id);
    });
    m.on('add', () => m.getElement()?.setAttribute('aria-label', `Citizen report ${r.ticket_id}`));
    layers.reports.addLayer(m);
    $('#reports-count').textContent = `(${state.reports.length})`;
  }

  // ========================================================================
  // 12. Floating panels: KPIs · legend · insights · search · toasts
  // ========================================================================
  function renderKpis() {
    const s = statsOf(allProps());
    $('#health-pct').textContent = `${Math.round((s.Functional / Math.max(1, s.total)) * 100)}%`;
    const meter = $('#health-meter');
    meter.innerHTML = METER_ORDER.filter((k) => s[k] > 0)
      .map((k) => `<span style="flex:${s[k]};background:${STATUS[k].color}" title="${s[k]} ${esc(STATUS[k].label.toLowerCase())}"></span>`).join('');
    meter.setAttribute('aria-label', METER_ORDER.map((k) => `${s[k]} ${STATUS[k].label.toLowerCase()}`).join(', '));
    $('#kpi-poles').textContent = nf0.format(s.total);
    $('#kpi-poles-sub').textContent = `${s.Faulty} dark now`;
    const open = [...state.tickets.values()].filter((t) => t.status !== 'Resolved');
    const breached = open.filter((t) => new Date(t.sla_due).getTime() < Date.now()).length;
    $('#kpi-tickets').textContent = nf0.format(open.length);
    $('#kpi-tickets-sub').innerHTML = breached
      ? `<i class="fa-solid fa-circle-exclamation" style="color:var(--bad)" aria-hidden="true"></i>${breached} past SLA`
      : 'all within SLA';
    $('#kpi-energy-label').textContent = `Energy · ${fmtMonthShort(META.energy_month)}`;
    $('#kpi-energy').textContent = nf0.format(s.kwh);
    $('#kpi-energy-sub').textContent = `kWh · ≈ ${inrCompact(s.kwh * CONFIG.tariff)}`;
  }

  function renderLegend() {
    const counts = statsOf(allProps());
    $('#legend-status').innerHTML = STATUS_ORDER.map((k) => {
      const on = state.filters.has(k);
      return `<li><button type="button" class="legend-item" data-filter="${esc(k)}" aria-pressed="${on}" title="${on ? 'Hide' : 'Show'} ${esc(STATUS[k].label.toLowerCase())} poles">
        ${statusSymbol(k, 16)}<span class="legend-label">${esc(STATUS[k].label)}</span>
        <span class="legend-count">${counts[k] ?? 0}</span>
        <i class="fa-solid ${on ? 'fa-eye' : 'fa-eye-slash'} legend-eye" aria-hidden="true"></i></button></li>`;
    }).join('');

    const energy = $('#legend-energy');
    energy.hidden = !state.analysis.energy;
    if (!energy.hidden) {
      energy.innerHTML = `<p class="eyebrow">Monthly energy · ${esc(fmtMonth(META.energy_month))}</p>${energyLegendSvg()}
        <p class="legend-note">Circle <em>area</em> is proportional to kWh. Colour and outline still show status.</p>`;
    }
    const heat = $('#legend-heatmap');
    heat.hidden = !state.analysis.heatmap;
    if (!heat.hidden) {
      heat.innerHTML = `<p class="eyebrow">Dark-spot intensity</p>
        <div class="heat-ramp" style="background:${heatRampCss()}"></div>
        <div class="ramp-labels"><span>Isolated fault</span><span>Clustered faults</span></div>
        <div class="legend-row"><span class="ring-key"></span>Dark-spot cluster (2+ faulty within ${CONFIG.darkSpotLinkM} m on one road)</div>`;
    }
    const feeder = $('#legend-feeder');
    feeder.hidden = !state.analysis.feeder;
    if (!feeder.hidden) {
      feeder.innerHTML = `<p class="eyebrow">Feeder network</p>
        <div class="legend-row"><span class="line-key"></span>Circuit cable, in wiring order</div>
        <div class="legend-row"><span class="sld-panel" style="width:16px;height:16px;font-size:8px;flex:none"><i class="fa-solid fa-bolt" aria-hidden="true"></i></span>Feeder panel (pillar)</div>
        <div class="legend-row"><span class="line-key line-key--hi"></span>Hovered or traced feeder</div>`;
    }
    const reports = $('#legend-reports');
    reports.hidden = !(state.overlays.reports && state.reports.length);
    if (!reports.hidden) {
      reports.innerHTML = `<div class="legend-row"><span class="report-pin" style="position:relative;display:inline-grid;width:18px;height:20px;flex:none"><span class="pin" style="width:15px;height:15px"><i class="fa-solid fa-bullhorn" style="font-size:7px" aria-hidden="true"></i></span></span>Citizen report (this session)</div>`;
    }
  }

  /** Nested proportional-symbol legend; labels are nudged apart and tied back with leader lines. */
  function energyLegendSvg() {
    const values = CONFIG.energy.legendValues.filter((v) => v <= energyMax * 1.15);
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
      <circle cx="${cx}" cy="${base - r}" r="${r}" fill="none" stroke="#c3c2b7" stroke-opacity=".75" stroke-width="1"></circle>
      <polyline points="${cx},${top} ${cx + rMax + 4},${top} ${labelX - 3},${labelY}" fill="none" stroke="#55544f" stroke-width="1"></polyline>
      <text x="${labelX}" y="${labelY + 3.5}" font-size="11" fill="#c3c2b7">${v} kWh</text>`).join('');
    return `<svg class="mt-2" width="100%" height="${height}" viewBox="0 0 230 ${height}" aria-hidden="true">${shapes}</svg>`;
  }

  function renderInsights() {
    renderHeatInsights();
    renderEnergyInsights();
    renderFeederInsights();
  }

  function renderHeatInsights() {
    const el = $('#insights-heatmap');
    el.hidden = !state.analysis.heatmap;
    if (el.hidden) return;
    const spots = state.darkSpots;
    el.innerHTML = `<p class="insight-lead">${spots.length ? `${spots.length} dark spot${spots.length === 1 ? '' : 's'} detected` : 'No dark-spot clusters'}</p>
      <p class="mt-0.5">${faultyRecords().length} faulty lights analysed. Faults within ${CONFIG.darkSpotLinkM} m of each other on the same road form one spot.</p>
      ${spots.length ? `<ul class="insight-list">${spots.map((s) => `<li>
        <button type="button" class="insight-item" data-action="open-spot" data-spot="${esc(s.id)}">
          <span class="insight-badge">${esc(s.id)}</span>
          <span class="min-w-0 flex-1"><span class="block text-[12.5px] text-ink-1">${s.recs.length} lights out · ${esc(s.where)}</span>
          <span class="block text-[11.5px] text-ink-3 clamp-2">${esc(s.diagnosis.short)}</span></span>
        </button></li>`).join('')}</ul>` : ''}`;
  }

  function renderEnergyInsights() {
    const el = $('#insights-energy');
    el.hidden = !state.analysis.energy;
    if (el.hidden) return;
    const list = allProps();
    const total = sum(list.map((p) => p.energy_kwh || 0)) || 1;
    const types = [...groupBy(list, (p) => p.fixture_type)]
      .map(([type, ps]) => ({ type, poles: ps.length, kwh: sum(ps.map((p) => p.energy_kwh || 0)) }))
      .sort((a, b) => b.kwh - a.kwh);
    const legacy = list.filter((p) => p.fixture_type !== 'LED');
    const saving = sum(legacy.map(retrofitSavingKwh));
    const anomalies = list.filter(isAnomaly).sort((a, b) => energyRatio(b) - energyRatio(a));
    el.innerHTML = `<p class="insight-lead">${nf0.format(total)} kWh in ${esc(fmtMonth(META.energy_month))} <span class="text-ink-3 font-normal">· ≈ ${esc(inrCompact(total * CONFIG.tariff))}</span></p>
      <p class="mt-2 text-[11px] text-ink-3">Share of energy · poles per fixture type</p>
      ${types.map((t) => `<div class="share-row" style="grid-template-columns:104px 1fr 34px">
        <span class="truncate">${esc(FIXTURE_NAMES[t.type] ?? t.type)} <span class="text-ink-3">· ${t.poles}</span></span>
        <span class="share-track"><span class="share-fill" style="display:block;width:${(t.kwh / total) * 100}%"></span></span>
        <span class="text-right text-ink-1">${Math.round((t.kwh / total) * 100)}%</span></div>`).join('')}
      ${saving > 0 ? `<p class="mt-2.5"><i class="fa-solid fa-leaf" style="color:var(--accent-hi)" aria-hidden="true"></i>
        LED retrofit of the ${legacy.length} legacy fixtures saves <span class="text-ink-1 font-medium">≈ ${nf0.format(saving)} kWh/month</span> (${esc(inrCompact(saving * CONFIG.tariff))}).</p>` : ''}
      ${anomalies.length ? `<p class="mt-2.5 text-ink-1 font-medium"><i class="fa-solid fa-circle-exclamation" style="color:var(--serious)" aria-hidden="true"></i>
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
    el.hidden = !state.analysis.feeder;
    if (el.hidden) return;
    const rows = [...state.panels.values()]
      .map(({ id, feature }) => ({ id, name: feature.properties.name, s: statsOf(polesOfPanel(id)) }))
      .sort((a, b) => b.s.Faulty - a.s.Faulty || b.s['Under Maintenance'] - a.s['Under Maintenance'] || a.id.localeCompare(b.id));
    const circuitCount = sum(rows.map((r) => panelPoles.get(r.id)?.size ?? 0));
    el.innerHTML = `<p class="insight-lead">${rows.length} feeder panels · ${circuitCount} circuits</p>
      <p class="mt-0.5">Hover a line to inspect a circuit; click it to trace every pole that depends on the panel.</p>
      ${state.trace ? `<button type="button" class="btn btn-ghost btn-block mt-2" data-action="untrace"><i class="fa-solid fa-xmark" aria-hidden="true"></i>Stop tracing ${esc(state.trace)}</button>` : ''}
      <ul class="insight-list">${rows.map((r) => `<li>
        <button type="button" class="insight-item" data-action="open-panel" data-panel="${esc(r.id)}" aria-pressed="${state.trace === r.id}">
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline justify-between gap-2"><span class="mono text-[12px] text-ink-1">${esc(r.id)}</span>
              <span class="text-[11px] ${r.s.Faulty ? 'text-ink-1' : 'text-ink-3'}">${r.s.Faulty ? `${r.s.Faulty} of ${r.s.total} dark` : `${r.s.total} poles · no faults`}</span></span>
            <span class="block text-[11.5px] text-ink-3 truncate">${esc(r.name)}</span>
            <span class="block mt-1.5">${meterHtml(r.s, 'meter--sm')}</span>
          </span>
        </button></li>`).join('')}</ul>`;
  }

  // ---- search ---------------------------------------------------------------------
  const searchInput = $('#search');
  const searchList = $('#search-results');
  let searchResults = [];
  let searchActive = -1;

  function searchCandidates() {
    const items = [];
    for (const { feature } of state.byUid.values()) {
      const p = feature.properties;
      items.push({ type: 'pole', id: p.uid, title: p.uid, sub: p.location, status: p.status,
        hay: `${p.uid} ${p.location} ${p.road} ${p.feeder_panel} ${p.ticket?.id ?? ''} ${p.fixture_type}`.toLowerCase() });
    }
    for (const { id, feature } of state.panels.values()) {
      const pp = feature.properties;
      items.push({ type: 'panel', id, title: id, sub: `Feeder panel · ${pp.name}`, hay: `${id} ${pp.name} ${pp.location} ${pp.road} feeder panel`.toLowerCase() });
    }
    for (const r of state.reports) {
      if (!r.uid) items.push({ type: 'report', id: r.id, title: r.ticket_id, sub: `Citizen report · ${r.issue}`, hay: `${r.ticket_id} ${r.issue} citizen report`.toLowerCase() });
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
    searchList.innerHTML = searchResults.length
      ? searchResults.map((it, i) => `<li role="option" id="sr-${i}" data-index="${i}" aria-selected="false">
          <span class="sr-glyph">${it.type === 'pole' ? statusSymbol(it.status, 14) : `<i class="fa-solid ${it.type === 'panel' ? 'fa-bolt' : 'fa-bullhorn'}" aria-hidden="true"></i>`}</span>
          <span class="min-w-0"><span class="sr-title block">${esc(it.title)}</span><span class="sr-sub block">${esc(it.sub)}</span></span></li>`).join('')
      : `<li class="sr-empty" aria-disabled="true">No matches for “${esc(q.trim())}”</li>`;
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
    else openReport(item.id, { zoom: true });
  }

  // ---- toasts -------------------------------------------------------------------
  function toast({ title, body = '', tone = 'info', icon = 'fa-circle-info', timeout = 6500 }) {
    const host = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast toast--${tone}`;
    el.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>
      <div class="min-w-0 flex-1"><div class="toast-title"></div><div class="toast-body"></div></div>
      <button type="button" class="icon-btn" aria-label="Dismiss" style="width:26px;height:26px"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
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

  // ========================================================================
  // 13. Analysis toggles, overlays, basemap
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
    state.overlays[name] = on;
    const layer = name === 'reports' ? layers.reports : layers.zone;
    if (on) layer.addTo(map);
    else map.removeLayer(layer);
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

  // ========================================================================
  // 14. Events
  // ========================================================================
  function onPoleClick(uid) {
    if (state.reportMode) {
      beginReport(state.byUid.get(uid).latlng, uid);
      return;
    }
    selectPole(uid);
  }

  function onPanelClick(id, e) {
    if (state.reportMode) {
      beginReport(e.latlng);
      return;
    }
    openPanel(id);
  }

  function onFeederLineClick(panelId, e) {
    if (state.reportMode) {
      beginReport(e.latlng);
      return;
    }
    const near = poleNearPoint(e.containerPoint, CONFIG.hitTolerancePx); // poles sit on the lines
    if (near) selectPole(near.uid);
    else openPanel(panelId);
  }

  function bindEvents() {
    // Map
    map.on('click', (e) => {
      if (state.reportMode) {
        beginReport(e.latlng);
        return;
      }
      const near = poleNearPoint(e.containerPoint, CONFIG.hitTolerancePx);
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
      if (state.analysis.energy) renderLegend(); // proportional legend follows the same scale
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
      if (!act) return undefined;
      if (act.dataset.action === 'open-spot') openSpot(act.dataset.spot);
      else if (act.dataset.action === 'select-pole') selectPole(act.dataset.uid, { zoom: act.dataset.zoom === '1' });
      else if (act.dataset.action === 'open-panel') openPanel(act.dataset.panel, { zoom: true });
      else if (act.dataset.action === 'untrace') {
        setTrace(null);
        renderSelected({ keepScroll: true });
      }
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

    // Map controls
    $('#zoom-in').addEventListener('click', () => map.zoomIn());
    $('#zoom-out').addEventListener('click', () => map.zoomOut());
    $('#zoom-home').addEventListener('click', () => fitZone(true));

    // Sidebar actions (event delegation; views are re-rendered often)
    sidebarEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const { action } = el.dataset;
      if (action === 'close') closeSidebar();
      else if (action === 'zoom-pole') flyToVisible(state.byUid.get(el.dataset.uid).latlng, Math.max(map.getZoom(), 18));
      else if (action === 'select-pole') selectPole(el.dataset.uid, { zoom: true });
      else if (action === 'open-panel') openPanel(el.dataset.panel, { zoom: true });
      else if (action === 'zoom-panel') fitPanel(el.dataset.panel);
      else if (action === 'trace') {
        const next = state.trace === el.dataset.panel ? null : el.dataset.panel;
        setTrace(next, { fit: Boolean(next) });
        renderSelected({ keepScroll: true });
      } else if (action === 'report-pole') beginReport(state.byUid.get(el.dataset.uid).latlng, el.dataset.uid, el.dataset.issue ?? null);
      else if (action === 'dispatch') dispatchTicket(el.dataset.ticket, el.closest('.workflow')?.querySelector('[data-role="crew"]')?.value);
      else if (action === 'resolve') resolveTicket(el.dataset.ticket, el.closest('.workflow')?.querySelector('[data-role="resolution"]')?.value);
      else if (action === 'copy') copyText(el.dataset.copy, el);
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

    // Report button
    reportBtn.addEventListener('click', () => setReportMode(!state.reportMode));

    // Report modal
    $('#rm-issues').innerHTML = ISSUE_TYPES.map((t) => `<label class="issue-option">
      <input type="radio" name="issue" value="${t.id}"><span><i class="fa-solid ${t.icon}" aria-hidden="true"></i>${esc(t.label)}</span></label>`).join('');
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeReportModal();
    });
    modal.addEventListener('keydown', (e) => { // keep keyboard focus inside the dialog
      if (e.key !== 'Tab') return;
      const focusables = $$('button, input, select, textarea, [href]', form).filter((el) => !el.disabled && el.getClientRects().length);
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
    $('#rm-description').addEventListener('input', (e) => { $('#rm-count').textContent = `${e.target.value.length}/500`; });
    $('#rm-photo').addEventListener('change', (e) => {
      clearPhoto();
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        e.target.value = '';
        $('#rm-photo-name').textContent = 'Please choose an image file';
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
      const fd = new FormData(form);
      const issue = ISSUE_TYPES.find((t) => t.id === fd.get('issue'));
      const phone = String(fd.get('phone') ?? '').replace(/[\s-]/g, '');
      const phoneOk = !phone || /^(\+?91)?[6-9]\d{9}$/.test(phone);
      $('#rm-issue-error').hidden = Boolean(issue);
      $('#rm-phone-error').hidden = phoneOk;
      if (!issue) {
        form.querySelector('input[name="issue"]').focus();
        return;
      }
      if (!phoneOk) {
        $('#rm-phone').focus();
        return;
      }
      submitReport({
        issue,
        description: String(fd.get('description') ?? '').trim(),
        name: String(fd.get('name') ?? '').trim(),
        phone,
        photo: $('#rm-photo').files?.[0]?.name ?? null,
      });
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

    // Keyboard: Esc backs out one step at a time; "/" focuses search
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!modal.hidden) closeReportModal();
        else if (state.reportMode) setReportMode(false);
        else if (state.trace) {
          setTrace(null);
          renderSelected({ keepScroll: true });
        } else if (state.selected) closeSidebar();
        return;
      }
      const t = document.activeElement;
      const typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchInput.focus();
      }
    });

    window.addEventListener('hashchange', openFromHash);
  }

  function openFromHash() {
    const id = decodeURIComponent(location.hash.slice(1));
    if (state.byUid.has(id)) selectPole(id, { zoom: true });
    else if (state.panels.has(id)) openPanel(id, { zoom: true });
  }

  // ========================================================================
  // 15. Init
  // ========================================================================
  function init() {
    indexTickets();
    const coordsOk = [validateCoordinates(DATA.streetlights, 'uid'), validateCoordinates(DATA.feederPanels, 'panel_id')].every(Boolean);
    energyMax = Math.max(1, ...state.features.map((f) => f.properties.energy_kwh || 0));

    layers.zone = L.geoJSON(DATA.zone ?? { type: 'FeatureCollection', features: [] }, {
      pane: 'zonePane',
      interactive: false,
      style: { color: '#c3c2b7', weight: 1.2, opacity: 0.5, dashArray: '6 6', fillColor: '#c3c2b7', fillOpacity: 0.025 },
    }).addTo(map);
    layers.halo = L.layerGroup().addTo(map);
    layers.poles = createPoleLayer().addTo(map);
    layers.panels = createPanelLayer(); // shown with the feeder network
    layers.network = L.layerGroup();
    layers.darkSpots = L.layerGroup();
    layers.reports = L.layerGroup().addTo(map);
    layers.selection = L.layerGroup().addTo(map);
    // `maxZoom` = the map's minimum zoom keeps heat intensity constant: leaflet.heat halves
    // point intensity for every zoom level below its maxZoom option.
    layers.heat = typeof L.heatLayer === 'function'
      ? L.heatLayer([], { maxZoom: CONFIG.zoom.min, max: 1, radius: 20, blur: 16, gradient: CONFIG.heat.gradient })
      : null;
    if (!layers.heat) $('[data-analysis="heatmap"]').disabled = true;

    layers.selectRing = L.circleMarker(CONFIG.centre, { pane: 'selectionPane', interactive: false, radius: 12, color: '#f0efec', weight: 2, opacity: 0.95, fill: false, dashArray: '4 4', className: 'select-ring' });
    layers.snapRing = L.circleMarker(CONFIG.centre, { pane: 'selectionPane', interactive: false, radius: 14, color: NET.hi, weight: 2, fill: false, className: 'snap-ring' });
    layers.snapLine = L.polyline([], { pane: 'selectionPane', interactive: false, color: '#f0efec', weight: 1.5, opacity: 0.85, dashArray: '3 5' });
    layers.draftPin = L.marker(CONFIG.centre, { icon: reportIcon(true), interactive: false, keyboard: false, zIndexOffset: 1000 });

    indexTopology();
    buildNetwork();
    bindEvents();
    refreshPoles();
    renderKpis();
    renderLegend();
    renderInsights();
    fitZone(false);
    $('#sb-zoom').textContent = `z${map.getZoom()}`;
    openFromHash();
    setInterval(renderKpis, 60_000); // SLA clocks keep ticking

    console.info(`[Street Light GIS] ${state.byUid.size} poles · ${state.panels.size} feeder panels · ${state.tickets.size} open tickets · coordinates ${coordsOk ? 'OK' : 'need attention (see warning)'} · data as of ${META.as_of ?? 'n/a'}`);
    // Handy for console experiments: slgis.selectPole('SL-CP-OC-031'), slgis.setAnalysis('heatmap', true)
    window.slgis = { map, state, layers, basemaps, selectPole, openPanel, setAnalysis, setTrace };
  }

  init();
})();
