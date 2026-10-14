/* ==========================================================================
 * Street Light GIS · app.js (core)
 * Map-first MVP for the Connaught Place pilot zone (NDMC area, New Delhi).
 * Leaflet 1.9.4 + leaflet.heat 0.2.0 (+ MapLibre GL 4.7 for the vector basemap).
 *
 * Plain scripts that share one global scope (no modules, so file:// works), loaded in this order:
 *   data/streetlights.js · server-config.js · config.js (1) · app.js (0, 2–7) · analysis.js (8)
 *   · confidence.js (9a) · share.js (9b) · tickets.js (9–11) · views.js (12–13) · panels.js (14)
 *   · roles.js (15) · backend.js (19, pilot server only) · main.js (16–18)
 *
 * COORDINATE CONVENTION, read before editing
 *   GeoJSON (RFC 7946) stores positions as [longitude, latitude].
 *   Leaflet (L.latLng, setView, L.polyline, L.heatLayer, ...) expects [latitude, longitude].
 *   - L.geoJSON() converts for us: pointToLayer(feature, latlng) already receives an L.LatLng.
 *   - Anywhere else a raw GeoJSON position goes through toLatLng() (toLatLngs() calls it per vertex),
 *     which delegates to Leaflet's own L.GeoJSON.coordsToLatLng(). No other code indexes
 *     geometry.coordinates by hand, so the two orders can never be mixed up.
 *   - Everything downstream (heatmap points, polylines, distances) is built from L.LatLng objects.
 * ========================================================================== */
'use strict';

// ========================================================================
// 0. Boot guard
// ========================================================================
const DATA = window.SLGIS_DATA;
const BOOT_ERROR = typeof window.L === 'undefined'
  ? 'Leaflet could not be loaded. This MVP pulls its map engine, icons and basemap tiles from public CDNs, so it needs an internet connection.'
  : !DATA?.streetlights?.features?.length
    ? 'Dataset not found. Keep data/streetlights.js next to index.html (regenerate it with: python tools/generate_data.py).'
    : null;

function fatal(message) {
  const box = document.createElement('div');
  box.className = 'fatal panel';
  box.setAttribute('role', 'alert');
  box.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><div><strong>The map could not start</strong><p></p></div>';
  box.querySelector('p').textContent = message;
  document.body.append(box);
  console.error('[Street Light GIS]', message);
}

const META = DATA?.meta ?? {};
const CENTRE = META.centre ?? { lat: 28.63279, lng: 77.219705 };
const CENTRE_LATLNG = [CENTRE.lat, CENTRE.lng]; // [lat, lng]: Leaflet order
const TARIFF = META.tariff_inr_per_kwh ?? TARIFF_FALLBACK_INR;
const FIXTURE_NAMES = { LED: 'LED', HPS: 'High-pressure sodium', 'Metal Halide': 'Metal halide' };
const LED_EQUIVALENT_W = { HPS: { 150: 70, 250: 120 }, 'Metal Halide': { 250: 150, 400: 200 } };

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
const pad2 = (n) => String(n).padStart(2, '0');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
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
  const f = new Intl.DateTimeFormat('en-IN', { ...opts, timeZone: TIME_ZONE });
  return (v) => {
    const d = v instanceof Date ? v : new Date(v);
    return v == null || Number.isNaN(d.getTime()) ? '–' : f.format(d);
  };
};
const fmtDate = formatter({ day: 'numeric', month: 'short', year: 'numeric' });
const fmtDay = formatter({ day: 'numeric', month: 'short' });
const fmtDateTime = formatter({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtTime = formatter({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // HH:MM, 24-hour
const fmtYear = formatter({ year: 'numeric' });
const monthDate = (ym) => (ym ? new Date(`${ym}-15T12:00:00${IST_OFFSET}`) : null); // mid-month: no timezone edge cases
const fmtMonthYear = formatter({ month: 'short', year: 'numeric' });
const fmtMonthOnly = formatter({ month: 'short' });
const fmtMonth = (ym) => fmtMonthYear(monthDate(ym));
const fmtMonthShort = (ym) => fmtMonthOnly(monthDate(ym));
const inr = (v) => `₹${nf0.format(Math.round(v))}`;
const inrCompact = (v) => (v >= 1e5 ? `₹${nf1.format(v / 1e5)} lakh` : v >= 1e3 ? `₹${nf1.format(v / 1e3)}k` : inr(v));
const pct = (share) => `${nf1.format(share * 100)}%`;
function fmtHours(h) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}
const hoursBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3.6e6;
const fmtAgo = (v) => {
  const h = hoursBetween(v, now());
  return h < 1 / 60 ? 'just now' : `${fmtHours(h)} ago`;
};
const fmtLatLng = (ll) => `${Math.abs(ll.lat).toFixed(5)}° ${ll.lat >= 0 ? 'N' : 'S'}, ${Math.abs(ll.lng).toFixed(5)}° ${ll.lng >= 0 ? 'E' : 'W'}`;
const fmtLatLngPlain = (ll) => `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
const roundTo = (v, step) => Math.round(v / step) * step;

/** Citizen-facing text (CITIZEN_TEXT, config.js): the chosen language in the Citizen view, English elsewhere. */
function tr(key, vars = {}) {
  const lang = state.role === 'citizen' ? state.lang : 'en';
  const text = CITIZEN_TEXT[lang]?.[key] ?? CITIZEN_TEXT.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}
const isCitizen = () => state.role === 'citizen';
/** Status words: plain citizen wording in the Citizen view, the asset-register labels elsewhere. */
const statusLabel = (status) => (isCitizen() ? tr(`status_${status}`) : STATUS[status]?.label ?? status);
/** Report category label; staff views always read English. */
const catLabel = (id, citizen = isCitizen()) => (citizen ? tr(`cat_${id}`) : CITIZEN_TEXT.en[`cat_${id}`] ?? id);

/** The ONE place a raw GeoJSON position becomes an L.LatLng: [lng, lat] -> L.LatLng(lat, lng). */
function toLatLng(featureOrPosition) {
  const position = Array.isArray(featureOrPosition) ? featureOrPosition : featureOrPosition.geometry.coordinates;
  return L.GeoJSON.coordsToLatLng(position);
}
/** The reverse, for saving: an L.LatLng back to a GeoJSON [longitude, latitude] position (Leaflet's own converter). */
const toPosition = (latlng) => L.GeoJSON.latLngToCoords(latlng);
/** Every vertex of a LineString (or a Polygon's outer ring), each converted by toLatLng(). */
function toLatLngs(feature) {
  const g = feature.geometry;
  const positions = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'LineString' ? g.coordinates : [g.coordinates];
  return positions.map(toLatLng);
}

/** Shortest distance in metres from a point to a polyline (local flat projection; fine at street scale). */
function distanceToLine(latlng, line) {
  if (line.length === 1) return latlng.distanceTo(line[0]);
  const k = Math.cos((latlng.lat * Math.PI) / 180);
  const xy = (ll) => [ll.lng * 111_320 * k, ll.lat * 110_574];
  const [px, py] = xy(latlng);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = xy(line[i]);
    const [bx, by] = xy(line[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/** Ground metres per screen pixel at the current zoom (Web Mercator). */
const metersPerPixel = () => (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);

// Colours drawn by Leaflet (SVG attributes) are read once from the design tokens in style.css.
const TOKEN = {};
const TOKEN_NAMES = {
  ok: '--ok', bad: '--bad', warn: '--warn', serious: '--serious', accent: '--accent', accentHi: '--accent-hi',
  ink1: '--ink-1', ink2: '--ink-2', ink3: '--ink-3', ink4: '--ink-4', ring: '--ring', faultFill: '--fault-fill',
  flow: '--flow', lamp: '--lamp', design: '--design', permit: '--permit', water: '--water',
};
function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const read = (name) => css.getPropertyValue(name).trim();
  for (const [key, name] of Object.entries(TOKEN_NAMES)) TOKEN[key] = read(name);
  for (const s of Object.values(STATUS)) s.color = read(s.token);
  TOKEN.heat = Object.fromEntries(HEAT_STOPS.map((stop, i) => [stop, read(`--heat-${i + 1}`)]));
  TOKEN.sidebarW = parseFloat(read('--sidebar-w')) || 420;
}

/** Inline SVG matching the map symbol of a status (legend, pills, lists). */
function statusSymbol(status, size = 14) {
  const s = STATUS[status] ?? STATUS.Functional;
  const c = size / 2;
  const r = size / 2 - 2;
  const paint = {
    ok: `fill="${s.color}" stroke="${TOKEN.ring}" stroke-width="2"`,
    fault: `fill="${TOKEN.faultFill}" stroke="${s.color}" stroke-width="2.4"`,
    maint: `fill="${s.color}" fill-opacity=".28" stroke="${s.color}" stroke-width="2" stroke-dasharray="3 2.5"`,
  }[s.key];
  return `<svg class="sym" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" ${paint}/></svg>`;
}
const statusPill = (status) => `<span class="status-pill">${statusSymbol(status, 14)}${esc(statusLabel(status))}</span>`;
const section = (title, icon, body) => `<section class="sb-section"><h3 class="sb-h"><i class="fa-solid ${icon}" aria-hidden="true"></i>${esc(title)}</h3>${body}</section>`;
/** A section that starts collapsed (progressive disclosure). */
const foldSection = (title, icon, body, open = false) => `<details class="sb-section sb-fold"${open ? ' open' : ''}><summary class="sb-h"><i class="fa-solid ${icon}" aria-hidden="true"></i>${esc(title)}<i class="fa-solid fa-chevron-down fold-chevron" aria-hidden="true"></i></summary>${body}</details>`;

function meterHtml(stats, cls = '') {
  const label = METER_ORDER.map((k) => `${stats[k] ?? 0} ${STATUS[k].label.toLowerCase()}`).join(', ');
  const segments = METER_ORDER.filter((k) => stats[k] > 0)
    .map((k) => `<span style="flex:${stats[k]};background:${STATUS[k].color}"></span>`).join('');
  return `<div class="meter ${cls}" role="img" aria-label="${esc(label)}">${segments}</div>`;
}

// ========================================================================
// 3. Clock and sun
// ========================================================================
/** Demo only: ?now=YYYY-MM-DDTHH:MM (IST) starts the app's clock at that moment; it keeps running from there. */
const CLOCK_OFFSET_MS = (() => {
  const raw = new URLSearchParams(location.search).get(DEMO_CLOCK_PARAM);
  if (!raw || (SERVER && !SERVER.demoClock)) return 0; // a pilot server runs on real time unless DEMO_CLOCK=1
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00` : raw;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(withTime);
  const t = new Date(hasZone ? withTime : `${withTime}${IST_OFFSET}`).getTime();
  if (Number.isNaN(t)) {
    console.warn(`[Street Light GIS] Ignoring ?${DEMO_CLOCK_PARAM}=${raw}. Use YYYY-MM-DDTHH:MM (IST).`);
    return 0;
  }
  return t - Date.now();
})();

/** The app's single notion of "now". Every time comparison goes through it. */
const now = () => new Date(Date.now() + CLOCK_OFFSET_MS);

/** IST calendar date of a moment, as 'YYYY-MM-DD'. */
function istDateKey(d) {
  const t = new Date(new Date(d).getTime() + 5.5 * 3.6e6);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}
const istMonthKey = (d) => istDateKey(d).slice(0, 7);
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const sunCache = new Map();
/**
 * Sunrise and sunset on an IST calendar date ('YYYY-MM-DD') at the zone centre: NOAA general solar
 * position equations, standard 90.833° zenith (refraction). Same maths as tools/generate_data.py.
 */
function sunTimes(key) {
  if (sunCache.has(key)) return sunCache.get(key);
  const [y, m, d] = key.split('-').map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dayOfYear = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5) + 1;
  const g = ((2 * Math.PI) / (leap ? 366 : 365)) * (dayOfYear - 1); // fractional year at noon
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g)); // minutes
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const lat = (CENTRE.lat * Math.PI) / 180;
  const hourAngle = (Math.acos(Math.cos((SUN_ZENITH_DEG * Math.PI) / 180) / (Math.cos(lat) * Math.cos(decl))
    - Math.tan(lat) * Math.tan(decl)) * 180) / Math.PI;
  const midnightUtc = Date.UTC(y, m - 1, d);
  const times = {
    sunrise: new Date(midnightUtc + (720 - 4 * (CENTRE.lng + hourAngle) - eqtime) * 6e4),
    sunset: new Date(midnightUtc + (720 - 4 * (CENTRE.lng - hourAngle) - eqtime) * 6e4),
  };
  sunCache.set(key, times);
  return times;
}

/** True between sunset and sunrise, when the lamps should be on. */
function isDark(t = now()) {
  const { sunrise, sunset } = sunTimes(istDateKey(t));
  return t < sunrise || t >= sunset;
}
/** The first dark moment at or after `t`: `t` itself after sunset or before sunrise, otherwise that day's sunset. */
const nextDusk = (t = now()) => {
  const d = new Date(t);
  return isDark(d) ? d : sunTimes(istDateKey(d)).sunset;
};
/** Sunset-to-sunrise hours of every night that starts in month 'YYYY-MM'. */
function nightHoursInMonth(ym) {
  let key = `${ym}-01`;
  let total = 0;
  while (key.startsWith(ym)) {
    total += hoursBetween(sunTimes(key).sunset, sunTimes(addDays(key, 1)).sunrise);
    key = addDays(key, 1);
  }
  return total;
}

// ========================================================================
// 4. State and data model
// ========================================================================
const state = {
  features: DATA?.streetlights?.features ?? [], // source of truth; workflows mutate it in-session
  byUid: new Map(),                     // uid -> { uid, feature, marker, halo, latlng }
  panels: new Map(),                    // panel id -> { id, feature, marker, latlng }
  tickets: new Map(),                   // open ticket id -> ticket (pole tickets can cover several poles)
  closed: new Map(),                    // tickets closed in this session (kept so they can be reopened)
  ticketSeq: {},                        // year -> last ticket number used
  activity: [],                         // audit trail of every state change in this session
  role: DEFAULT_ROLE,
  lang: 'en',                           // Citizen view language: 'en' | 'hi'
  filters: new Set(STATUS_ORDER),
  analysis: { heatmap: false, energy: false, feeder: false },
  overlays: { reports: true, zone: true, shutdowns: false, landmarks: false, coverage: false, water: false, permits: false },
  basemap: 'night',
  selected: null,                       // { type, id } of what the sidebar shows
  back: null,                           // the list view the sidebar returns to (Back / Esc)
  trace: null,                          // feeder panel id being traced
  highlight: null,                      // { label, uids: Set } poles picked out on the map by a list
  hoverFeeder: null,
  darkRuns: [],                         // unlit stretches along the roads (analysis.js)
  darkSpots: [],                        // the same stretches as numbered dark spots, with root cause
  gaps: [],                             // coverage gaps: poles too far apart for their height
  autoOff: new Set(),                   // layers a view switch turned off, restored on return to a view that has them
  reportMode: false,
  draft: null,                          // pending report: location + snapped pole
  reports: [],                          // citizen reports: the simulated ones in the data, then this session's
  reporters: new Map(),                 // simulated reporter identities and their track records
  publicSharing: PUBLIC_ESCALATION_ENABLED, // Management can switch citizen sharing on X off
  picking: null,                        // { ticketId } while a crew picks the right pole on the map
};
const layers = {};                      // Leaflet layers, created in init()
const panelPoles = new Map();           // panel id -> Map(circuit -> [uid in wiring order])
let map = null;
let basemaps = null;
let energyMax = 1;

const props = (uid) => state.byUid.get(uid)?.feature.properties;
const allProps = () => state.features.map((f) => f.properties);
const panelProps = (id) => state.panels.get(id)?.feature.properties;
const polesOfPanel = (id) => [...(panelPoles.get(id)?.values() ?? [])].flat().map(props);
const circuitUids = (panelId, circuit) => panelPoles.get(panelId)?.get(circuit) ?? [];
const circuitLength = (panelId, circuit) => circuitUids(panelId, circuit).length;
const faultyRecords = () => [...state.byUid.values()].filter((r) => r.feature.properties.status === 'Faulty');
const isDarkStatus = (p) => p.status === 'Faulty' || p.status === 'Under Maintenance';

function statsOf(list) {
  const s = { total: list.length, Functional: 0, Faulty: 0, 'Under Maintenance': 0, watts: 0, kwh: 0 };
  for (const p of list) {
    s[p.status] = (s[p.status] ?? 0) + 1;
    s.watts += p.wattage * (p.arm_count ?? 1);
    s.kwh += p.energy_kwh || 0;
  }
  return s;
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

/** Planned power shutdowns running at `t` (mock data: feeder panel, circuits, start, end, reason). */
function activeShutdowns(t = now()) {
  const out = [];
  for (const { id, feature } of state.panels.values()) {
    for (const s of feature.properties.planned_shutdowns ?? []) {
      if (new Date(s.start) <= t && t < new Date(s.end)) out.push({ panelId: id, ...s, end: new Date(s.end), start: new Date(s.start) });
    }
  }
  return out;
}
/** The active shutdown that switches this pole off, if any. */
const shutdownOf = (p, t = now()) => activeShutdowns(t).find((s) => s.panelId === p.feeder_panel && s.circuits.includes(p.circuit)) ?? null;

/** Warn loudly about missing, out-of-zone, or [lat, lng]-swapped coordinates in any layer. */
function validateCoordinates(collection, name) {
  const centre = L.latLng(CENTRE_LATLNG);
  const problems = [];
  const features = collection?.type === 'Feature' ? [collection] : collection?.features ?? [];
  for (const f of features) {
    const id = f.id ?? f.properties?.uid ?? '(no id)';
    const g = f.geometry;
    const positions = g?.type === 'Point' ? [g.coordinates] : g?.type === 'LineString' ? g.coordinates
      : g?.type === 'Polygon' ? g.coordinates.flat() : null;
    if (!positions?.length || positions.some((c) => !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) {
      problems.push(`${name} ${id}: invalid ${g?.type ?? 'missing'} geometry`);
      continue;
    }
    for (const c of positions) {
      const offBy = toLatLng(c).distanceTo(centre);
      if (offBy > 50_000) {
        const swapped = Math.abs(c[0]) <= 90 && L.latLng(c[0], c[1]).distanceTo(centre) < 50_000;
        problems.push(swapped ? `${name} ${id}: looks like [lat, lng]; GeoJSON needs [lng, lat]` : `${name} ${id}: ${Math.round(offBy / 1000)} km outside the pilot zone`);
        break;
      }
    }
  }
  if (problems.length) console.warn(`[Street Light GIS] ${problems.length} feature(s) need attention:`, problems);
  return problems.length === 0;
}

// Energy model: rated watts × arms × driver/ballast loss × that month's sunset-to-sunrise hours.
const systemLoss = (p) => META.energy_model?.system_loss?.[p.fixture_type] ?? 1.1;
function expectedKwh(p, ym = p.energy_month ?? META.energy_month) {
  if (!ym || !p.wattage) return null;
  return (p.wattage * (p.arm_count ?? 1) * systemLoss(p) * nightHoursInMonth(ym)) / 1000;
}
const ledEquivalentW = (p) => LED_EQUIVALENT_W[p.fixture_type]?.[p.wattage] ?? Math.round(p.wattage * 0.5);
function retrofitSavingKwh(p) {
  if (p.fixture_type === 'LED') return 0;
  const current = expectedKwh(p);
  const led = expectedKwh({ ...p, fixture_type: 'LED', wattage: ledEquivalentW(p) });
  return current && led ? Math.max(0, current - led) : 0;
}
const energyRatio = (p) => {
  const e = expectedKwh(p);
  return e ? p.energy_kwh / e : null;
};
const isAnomaly = (p) => (energyRatio(p) ?? 0) >= ANOMALY_RATIO;

// ========================================================================
// 5. Map, panes, basemaps and controls
// ========================================================================
const ATTRIBUTION = {
  osm: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  openfreemap: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>',
  carto: '&copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  esriGray: 'Tiles &copy; Esri, HERE, Garmin',
  esriImagery: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
};

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    minZoom: MAP_MIN_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    maxBounds: L.latLng(CENTRE_LATLNG).toBounds(8000), // 8 km box around the pilot zone
    maxBoundsViscosity: 0.8,
  }).setView(CENTRE_LATLNG, MAP_START_ZOOM);

  // Custom panes fix the drawing order. leaflet.heat always draws into overlayPane (z 400).
  for (const [name, z, interactive] of [
    ['zonePane', 350, false],
    ['waterPane', 360, true],
    ['glowPane', 410, false],
    ['darkSpotPane', 415, false],
    ['networkPane', 420, true],
    ['overlayLinePane', 430, true],
    ['landmarkPane', 440, true],
    ['polesPane', 450, true],
    ['selectionPane', 460, false],
  ]) {
    const pane = map.createPane(name);
    pane.style.zIndex = String(z);
    if (!interactive) pane.style.pointerEvents = 'none';
  }

  basemaps = { night: createNightBasemap(), satellite: createSatelliteBasemap() };
  basemaps.night.addTo(map);

  // Scale bar and attribution live in the bottom status bar; Leaflet keeps updating them there.
  const scaleControl = L.control.scale({ imperial: false, maxWidth: 96 }).addTo(map);
  $('#sb-scale').append(scaleControl.getContainer());
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  $('#sb-attrib').append(map.attributionControl.getContainer());
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

// ========================================================================
// 6. Streetlight layer: L.geoJSON · pointToLayer · onEachFeature
// ========================================================================
const zoomFactor = () => clamp(1.25 ** (map.getZoom() - 16), 0.62, 1.6);
const baseRadius = () => 6 * zoomFactor();
/** Proportional symbol: circle AREA scales with kWh (radius ∝ √kWh). */
const energyRadius = (kwh) => Math.max(ENERGY_MIN_RADIUS_PX, ENERGY_MAX_RADIUS_PX * Math.sqrt(Math.max(0, kwh) / energyMax) * zoomFactor());
const poleRadius = (p) => (state.analysis.energy ? energyRadius(p.energy_kwh) : baseRadius());
/** Poles outside a traced feeder, or outside a list picked out on the map, step back. */
const isDimmed = (p) => (Boolean(state.trace) && p.feeder_panel !== state.trace) || (Boolean(state.highlight) && !state.highlight.uids.has(p.uid));
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
  if (s.key === 'fault') return { ...base, color: s.color, weight: 2.4, fillColor: TOKEN.faultFill, fillOpacity: (energy ? 0.55 : 0.92) * k };
  if (s.key === 'maint') return { ...base, color: s.color, weight: 2, fillColor: s.color, fillOpacity: (energy ? 0.18 : 0.28) * k, dashArray: '3 2.5' };
  return { ...base, color: TOKEN.ring, weight: 2, fillColor: s.color, fillOpacity: (energy ? 0.62 : 1) * k };
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
    pane: 'glowPane', radius: HALO_RADIUS_M, stroke: false,
    fillColor: TOKEN.lamp, fillOpacity: 1, interactive: false, className: 'halo',
  });
  state.byUid.set(p.uid, { uid: p.uid, feature, marker, halo, latlng });
  marker.bindTooltip(() => poleTooltip(feature.properties), { className: 'sl-tooltip', direction: 'top', offset: [0, -10], opacity: 1 });
  marker.on('click', () => onPoleClick(p.uid));
}

function poleTooltip(p) {
  const hold = shutdownOf(p);
  const head = `<div class="tt-value">${esc(p.uid)}</div>`;
  if (isCitizen()) {
    return `${head}<div class="tt-row">${statusSymbol(p.status, 12)} ${esc(statusLabel(p.status))}</div>
      ${hold ? `<div class="tt-hint">${esc(tr('pole_shutdown', { time: fmtTime(hold.end) }))}</div>` : ''}`;
  }
  const energy = state.analysis.energy
    ? `<div class="tt-row">${nf1.format(p.energy_kwh)} kWh in ${esc(fmtMonth(p.energy_month))}${isAnomaly(p) ? ' · <i class="fa-solid fa-circle-exclamation tt-warn" aria-hidden="true"></i> anomaly' : ''}</div>`
    : '';
  return `${head}<div class="tt-row">${statusSymbol(p.status, 12)} ${esc(STATUS[p.status]?.label ?? p.status)} · ${esc(p.fixture_type)} ${esc(p.wattage)} W${p.arm_count > 1 ? ` ×${p.arm_count}` : ''}</div>${energy}
    ${hold ? `<div class="tt-hint">Off: planned shutdown until ${esc(fmtTime(hold.end))}</div>` : ''}`;
}

/** Whether a pole's lamp glows on the map right now: working, and not switched off by a planned shutdown. */
const isLit = (p) => p.status === 'Functional' && !shutdownOf(p);

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
  const glow = isLit(p) && state.filters.has('Functional') && !state.analysis.energy && !isDimmed(p);
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
// 7. Feeder panels and feeder network
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
  const pp = panelProps(id);
  const s = statsOf(polesOfPanel(id));
  const load = panelLoad(id);
  return `<div class="tt-value">${esc(id)}</div>
    <div class="tt-row">${esc(pp.name)} · ${s.total} poles${s.Faulty ? ` · ${s.Faulty} dark` : ''}</div>
    ${load.warn ? `<div class="tt-row"><i class="fa-solid fa-gauge-high tt-warn" aria-hidden="true"></i>Load ${esc(pct(load.peakShare))} of capacity</div>` : ''}
    <div class="tt-hint">Click for panel details</div>`;
}

function circuitTooltip(panelId, circuit) {
  const s = statsOf(circuitUids(panelId, circuit).map(props));
  const hold = activeShutdowns().find((x) => x.panelId === panelId && x.circuits.includes(circuit));
  return `<div class="tt-value">${esc(panelId)} · ${esc(circuit)}</div>
    <div class="tt-row">${s.total} poles · ${s.Faulty} dark · ${nf1.format(s.watts / 1000)} kW connected</div>
    ${hold ? `<div class="tt-row"><i class="fa-solid fa-power-off" aria-hidden="true"></i>Planned shutdown until ${esc(fmtTime(hold.end))}</div>` : ''}
    <div class="tt-hint">Click to trace this feeder</div>`;
}

const feederLines = new Map(); // panel id -> [{ circuit, visible, flow, hit }]

/** The panel, then every pole in wiring order: the path of one circuit's cable (L.LatLng only). */
function circuitPath(panelId, circuit) {
  const panel = state.panels.get(panelId);
  return [...(panel ? [panel.latlng] : []), ...circuitUids(panelId, circuit).map((uid) => state.byUid.get(uid).latlng)];
}

/**
 * One polyline per circuit, in wiring order: feeder panel -> pole #1 -> pole #2 ...
 * Poles are grouped by their shared `feeder_panel` property; every vertex is an L.LatLng.
 */
function buildNetwork() {
  for (const [panelId, circuits] of panelPoles) {
    const entries = [];
    for (const circuit of circuits.keys()) {
      const path = circuitPath(panelId, circuit);
      const visible = L.polyline(path, { pane: 'networkPane', color: TOKEN.accent, weight: 2, opacity: 0.7, lineCap: 'round', lineJoin: 'round', interactive: false });
      const flow = L.polyline(path, { pane: 'networkPane', color: TOKEN.flow, weight: 2.5, opacity: 0, dashArray: '1 9', lineCap: 'round', interactive: false, className: 'feeder-flow' });
      // Invisible 16 px stroke: an easy hover/click target for a 2 px line
      const hit = L.polyline(path, { pane: 'networkPane', color: TOKEN.ink1, weight: 16, opacity: 0, bubblingMouseEvents: false });
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
      e.visible.setStyle({ color: hot ? TOKEN.accentHi : TOKEN.accent, weight: hot ? 3 : 2, opacity: dim ? 0.14 : hot ? 0.95 : 0.7 });
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
  renderMapChip();
  renderInsights();
  if (id && fit) fitPanel(id);
}

function fitPanel(id) {
  const panel = state.panels.get(id);
  if (!panel) return;
  fitTo(L.latLngBounds([panel.latlng, ...polesOfPanel(id).map((p) => state.byUid.get(p.uid).latlng)]));
}
