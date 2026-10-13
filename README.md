# Street Light GIS: Connaught Place pilot (MVP)

A map-first street light management GIS for the Connaught Place pilot zone (NDMC area, New Delhi).
Everything happens on the map: the asset register, citizen fault reporting, maintenance tickets,
field work orders, management reports and spatial analysis.

> **Mock data.** Pole positions follow the real Inner, Middle and Outer Circle roads (fitted to
> OpenStreetMap). Every attribute (status, tickets, contractors, energy) is synthetic. Landmarks,
> excavation permits and waterlogging spots are **approximate** (`approximate: true` in the data,
> and the map tooltips say so).

## Run it

Double-click `index.html`. No build step and no server needed (the dataset ships as a script so it
also works from `file://`). An internet connection is required: Leaflet, MapLibre, Tailwind,
Font Awesome, the QR library and the basemap load from public CDNs.

Optional local server: `python -m http.server 8000`, then open <http://localhost:8000>.

**Demo clock.** Add `?now=YYYY-MM-DDTHH:MM` (IST) to start the app's clock at that moment, e.g.
`index.html?now=2026-10-13T19:30` (after sunset on the snapshot day). There is no visible control;
it exists so time-dependent flows (dusk checks, night audit, SLA, shutdowns) can be shown at any hour.

## Views

A switch at the top of the header picks the view. It is a **demo switch, not a login**.

| View | Shows |
|---|---|
| Citizen | Map, search, **Report an issue** (the primary action), **My reports**, EN / हिन्दी |
| Operator (default) | Everything below plus the ticket queue, dispatch, split reports, pole labels, event check |
| Field crew | Crew picker, work order in suggested order, dusk checks, night audit |
| Management | Uptime, unlit road, SLA tiles; dashboard with scorecards, chronic poles, energy reconciliation, readiness |

## What you can do

| Feature | How |
|---|---|
| Inspect a pole | Click any marker. A sidebar slides in with pole, fixture, feeder, energy, contractor, the repair-history timeline and a folded **Activity** audit trail. |
| Report a fault | **Report an issue** → crosshair → click a pole or any spot. Clicks snap to the nearest pole within 40 m; otherwise the ticket is raised for that exact location. Pick one of 8 category chips (only the category is required). |
| Duplicates | A report on a pole with an open ticket adds **+1 report**; a location report within 30 m / 48 h of an open location ticket merges into it. The operator can **Split out** a wrongly merged report. |
| Work a ticket (operator demo) | **Dispatch** a crew (pole → *Under maintenance*), then **Close ticket** → *Awaiting dusk check*. CCMS poles confirm by themselves after dark (simulated); other poles need a night photo from the field crew. Only then does the pole turn *Functional* and the repair get logged. |
| Ticket queue | Click **Open tickets**. Safety emergencies are pinned on top; each ticket shows priority, a one-line *why*, SLA and escalation level (JE → AE → EE). |
| Dark spots | **Dark spots** switch: heat from *Faulty* poles, plus each unlit stretch (2+ dark poles in a row, measured along the road between lit poles) labelled e.g. "DS-1 · 220 m unlit" with a likely root cause, e.g. "probable cable fault after pole #2". |
| Circuit faults | When most of a circuit (or its far end) is dark, the lamp tickets collapse into one electrical ticket for the cable & panel team; an active excavation permit nearby is named as a possible cause. |
| Planned shutdowns | Poles on a switched-off circuit keep their status but show no light; reports there are logged, not dispatched; citizens see "Planned power shutdown until HH:MM". |
| Energy layer | Marker **area** proportional to monthly kWh; fixture-type shares, LED-retrofit savings, and day-burning anomalies (> 150 % of that month's sunset-to-sunrise baseline). |
| Feeder network | Polylines join poles that share a feeder panel, in wiring order. Hover a line for its circuit; click to **trace** every pole that depends on that panel. The panel view shows load and festive peak against capacity. |
| Overlays (off by default) | Planned shutdowns, landmarks, coverage gaps (spacing too wide: *add a pole*), waterlogging spots, excavation permits. |
| Field crew | Work order grouped into stops and ordered by nearest neighbour (route drawn while open), "Carry: …" spares line on lamp jobs, night audit with large **Lit / Dark** buttons. |
| Management | Uptime per month (zone, road, contractor), contractor scorecard (example payment rule), chronic poles and batch failure rates, warranty claims, energy reconciliation, "Due before monsoon", event check (pick roads or draw a route; printable). |
| Pole labels | Printable QR label sheet; each code opens `BASE_URL#report=<UID>`. Set `BASE_URL` in `config.js` first. |
| Search / filter | Search box (or press `/`). Click a status in the legend to hide or show it. `Esc` backs out one step (form, drawing, report mode, highlight, trace, sidebar, back to a list). |
| Share a view | The URL hash follows the selection and view, e.g. `#SL-CP-OC-031`, `#SL-CP-OC-031&view=field`, `#view=citizen`. |

Status symbols use shape as well as colour, so red/green colour blindness doesn't matter:
**●** functional (lit disc) · **○** faulty (unlit ring) · dashed ring = under maintenance.

## Files

```
├── index.html                    Page shell, CDN imports, script order
├── style.css                     Design tokens, layout, Leaflet overrides, symbology, print
├── config.js                     1  Every threshold, rule, example value and the citizen EN / हिन्दी text
├── app.js                        0, 2–7  Boot, utilities, clock & sun, data model, map, poles, feeders
├── analysis.js                   8  Heatmap, road order, unlit stretches, root cause, coverage, criticality,
│                                    load, uptime, scorecard, chronic, reconciliation, monsoon, event check
├── tickets.js                    9–11  Ticket model, workflow, reporting
├── views.js                      12–13  Selection, URL hash, sidebar views
├── panels.js                     14  View switch, header, layers, legend, insights, search, toasts
├── roles.js                      15  Queue, work order, night audit, dashboard, labels, event check
├── main.js                       16–18  Switches, events, init and clock tick
├── data/
│   ├── streetlights.js           window.SLGIS_DATA: everything below, loadable from file://
│   ├── streetlights.geojson      119 poles
│   ├── feeder_panels.geojson     8 feeder pillars
│   ├── landmarks.geojson         28 landmarks (approximate)
│   ├── excavation_permits.geojson 3 permits (approximate)
│   └── waterlogging_spots.geojson 3 spots (approximate)
└── tools/
    ├── generate_data.py          Rebuilds the dataset (seeded, reproducible)
    └── validate_data.py          Checks structure, [lon, lat] order, cross-references, sync
```

All scripts are plain `<script>` files sharing one scope (no modules, so `file://` works).

## Data model (one pole)

| Property | Example |
|---|---|
| `uid`, `road`, `location` | `SL-CP-OC-031`, `Outer Circle`, `Outer Circle, Palika Park side · …` |
| `pole_type`, `pole_height_m`, `arm_count` | `Octagonal GI`, `9`, `1` |
| `fixture_type`, `wattage`, `cct_k`, `ccms_node` | `LED`, `120`, `4000`, `true` |
| `fixture_installed`, `fixture_make`, `fixture_batch`, `fixture_warranty_years` | `2023-03-21`, `Lumetra` (fictional), `LUM-2302`, `5` (example) |
| `last_inspected`, `last_earthing_check`, `junction_box_condition` | `2026-08-01`, `2024-09-15`, `Good` |
| `feeder_panel`, `circuit`, `circuit_seq`, `phase` | `FP-CP-07`, `C1`, `3`, `B` |
| `status` | `Functional` · `Faulty` · `Under Maintenance` |
| `contractor` | name, contact, masked phone, contract ref, SLA hours |
| `ticket` | live ticket (id, status, category, issue, source, crew, `pole_uids`, …) or `null`. Priority and SLA are computed in the app. |
| `repair_history` | closed tickets, newest first |
| `energy_kwh`, `energy_month`, `energy_history` | last month, plus 6 months of `{month, kwh, scheduled_h, lit_h}` |

Feeder panels add `capacity_kva`, `metered_kwh_history`, `temp_connections` and `planned_shutdowns`.
`locationTickets` and `citizenSamples` (two simulated earlier reports) are in `streetlights.js`.

**Coordinates:** GeoJSON stores `[longitude, latitude]`; Leaflet wants `[latitude, longitude]`.
`L.geoJSON` converts automatically, and the only hand-written conversion is `toLatLng()` (and
`toLatLngs()`, which calls it), using Leaflet's own `L.GeoJSON.coordsToLatLng`. On load the app warns
in the console if any feature in any layer looks swapped or sits outside the pilot zone.

## Configuration (`config.js`)

Every threshold is a named constant with a one-line comment. Values marked **EXAMPLE** are
illustrative, not real regulations, contract terms, penalty rates or warranty periods. The main ones:

| Constant | Default | Meaning |
|---|---|---|
| `MIN_DARK_RUN` | 2 | dark poles in a row that make an unlit stretch |
| `DESIGN_SPACING_RATIO` | 5.5 (example) | spacing above this × pole height = coverage gap |
| `CRITICALITY_RADIUS_M` | 40 | landmarks this close raise criticality |
| `BASE_URL` | `''` | public address for QR labels |
| `DUPLICATE_RADIUS_M`, `DUPLICATE_WINDOW_HOURS` | 30, 48 | location-report merging |
| `CIRCUIT_FAULT_SHARE`, `MIN_CABLE_FAULT_RUN` | 0.6, 3 | panel vs cable fault |
| `EMERGENCY_SLA_HOURS`, `SLA_BASE_HOURS`, `SLA_MODIFIERS` | 4, … (examples) | service levels |
| `ESCALATION` | JE at 0×, AE at 1×, EE at 2× SLA (example) | escalation levels |
| `CCMS_CONFIRM_DELAY_MIN`, `WORK_ORDER_GROUP_M` | 10, 60 | dusk check, work-order stops |
| `REPEAT_WINDOW_DAYS`, `CHRONIC_FAILURES`, `CHRONIC_WINDOW_DAYS` | 30, 3, 365 | repeat and chronic failures |
| `EXAMPLE_DEDUCTION_PER_BREACH_INR` | 500 (example) | scorecard payment rule |
| `RECONCILIATION_GAP_SHARE` | 0.08 | unexplained consumption |
| `EARTHING_CHECK_MAX_MONTHS`, `MONSOON_START` | 12, 2027-06-25 (examples) | pre-monsoon checks |
| `PERMIT_PROXIMITY_M`, `EVENT_ROUTE_BUFFER_M` | 30, 25 | permits near faults, event routes |
| `PANEL_LOAD_WARN_SHARE`, `FESTIVE_WINDOW` | 0.8, 10 Oct – 15 Nov (example) | festive load |

Sunrise and sunset are computed (NOAA solar position, zenith 90.833°) for the zone centre, in IST,
in both the generator and the browser; the energy baseline uses each month's real night length.

## Regenerate the data

```
python tools/generate_data.py                     # snapshot 13 Oct 2026, 18:00 IST
python tools/generate_data.py --as-of 2026-11-20T18:00
python tools/validate_data.py                     # exit code 1 on any problem
```

Ticket ages and SLA deadlines are measured against the app's clock. For a demo weeks from now,
regenerate with a recent `--as-of`, or use `?now=`.

## Basemap

CARTO stamps keyless Dark Matter tiles with "API KEY REQUIRED", so the night basemap is
OpenFreeMap's free **dark** vector style, drawn by MapLibre GL inside Leaflet, falling back to Esri's
dark-grey raster tiles. To use CARTO Dark Matter, set `CARTO_API_KEY` in `config.js`.

## MVP limits / next steps

- Tickets, reports, photos and the audit trail live in memory for the session; a backend (e.g. PostGIS + REST) would persist them.
- No authentication: the view switch is a demo. Real role-based login is a next step.
- Notifications are simulated in **My reports**; real SMS / WhatsApp updates need a backend.
- Offline night audits need a service worker, which only works over http(s): add one once the app is hosted.
- Set `BASE_URL` once hosted, so the QR pole labels work.
- The Hindi strings in `config.js` are a first draft and **need review by a native speaker**. Data strings (locations, issues) stay in English.
- Landmark, permit and waterlogging positions are approximate synthetic placements; replace them with verified survey data.
- The CCMS feed is simulated; live CCMS, crew GPS and meter readings would replace the mock data.
- Tailwind runs from its Play CDN (it logs a "not for production" warning); compile it for production.
