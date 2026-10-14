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

Online: <https://rams-prads.github.io/Streetlight-Analysis/> (GitHub Pages, served from the `main` branch).
QR pole labels and public status links point there (`BASE_URL` in `config.js`).

**Pilot server.** `node server/server.js` serves the same app with saved state, staff sign-in, phone
verification for citizens, photo checks and live adapters (SMS, AI, CCMS). See [server/README.md](server/README.md).
Without it, everything runs in the browser as a demo, as before.

**Demo clock.** Add `?now=YYYY-MM-DDTHH:MM` (IST) to start the app's clock at that moment, e.g.
`index.html?now=2026-10-13T19:30` (after sunset on the snapshot day). There is no visible control;
it exists so time-dependent flows (dusk checks, night audit, SLA, shutdowns) can be shown at any hour.

## Views

A switch at the top of the header picks the view. It is a **demo switch, not a login**.

| View | Shows |
|---|---|
| Citizen | Map, search, **Report an issue** (the primary action), **My reports** with progress and, when earned, **Share publicly**, EN / हिन्दी |
| Operator (default) | Everything below plus the ticket queue, report confidence and cheapest checks, dispatch, split reports, reports held for review, pole labels, event check |
| Field crew | Crew picker, work order in suggested order (including check visits), on-site outcomes, dusk checks, night audit |
| Management | Uptime, unlit road, SLA tiles; dashboard with scorecards, chronic poles, energy reconciliation, readiness, report confidence and the public-sharing switch |

## What you can do

| Feature | How |
|---|---|
| Inspect a pole | Click any marker. A sidebar slides in with pole, fixture, feeder, energy, contractor, the repair-history timeline and a folded **Activity** audit trail. |
| Report a fault | **Report an issue** → crosshair → click a pole or any spot. Clicks snap to the nearest pole within 40 m; otherwise the ticket is raised for that exact location. Pick one of 8 category chips (only the category is required). Optional: when it was noticed, a photo (**Take photo** or **Upload photo**), and **Use my location**. |
| Duplicates | A report on a pole with an open ticket adds **+1 report**; a location report within 30 m / 48 h of an open location ticket merges into it. The operator can **Split out** a wrongly merged report. |
| Work a ticket (operator demo) | **Dispatch** a crew (pole → *Under maintenance*), then **Close ticket** → *Awaiting dusk check*. CCMS poles confirm by themselves after dark (simulated); other poles need a night photo from the field crew. Only then does the pole turn *Functional* and the repair get logged. |
| Report confidence | Each citizen report gets a band: **Confirmed**, **Likely** or **Needs check**, shown quietly on the ticket with a folded **Why** list (✓ supports, – neutral, ✗ contradicts). See *How report confidence works*. |
| Cheapest check first | A **Needs check** ticket offers, in order: poll CCMS (simulated), add the pole to the night audit, ask a crew already working nearby. A crew is dispatched only when none of these can happen within 12 h. |
| On-site outcomes (field crew) | **Fault confirmed**, **Working, no fault** (closes as "Not confirmed on site"), **Obstruction** (to horticulture / enforcement) or **Different pole** (pick the right pole on the map; `Esc` cancels). Every outcome updates the reporters' track records. |
| Ticket queue | Click **Open tickets**. Safety emergencies are pinned on top; each ticket shows priority and what it is **based on**, SLA, escalation level (JE → AE → EE), a **Needs check** flag, and a **Public** marker when its reporter shared it. Reports over the hourly limit wait under **Held for review**; **Accept** puts them on a ticket. |
| Dark spots | **Dark spots** switch: heat from *Faulty* poles, plus each unlit stretch (2+ dark poles in a row, measured along the road between lit poles) labelled e.g. "DS-1 · 220 m unlit" with a likely root cause, e.g. "probable cable fault after pole #2". |
| Circuit faults | When most of a circuit (or its far end) is dark, the lamp tickets collapse into one electrical ticket for the cable & panel team; an active excavation permit nearby is named as a possible cause. |
| Planned shutdowns | Poles on a switched-off circuit keep their status but show no light; reports there are logged, not dispatched; citizens see "Planned power shutdown until HH:MM". |
| Energy layer | Marker **area** proportional to monthly kWh; fixture-type shares, LED-retrofit savings, and day-burning anomalies (> 150 % of that month's sunset-to-sunrise baseline). |
| Feeder network | Polylines join poles that share a feeder panel, in wiring order. Hover a line for its circuit; click to **trace** every pole that depends on that panel. The panel view shows load and festive peak against capacity. |
| Overlays (off by default) | Planned shutdowns, landmarks, coverage gaps (spacing too wide: *add a pole*), waterlogging spots, excavation permits. |
| Field crew | Work order grouped into stops and ordered by nearest neighbour (route drawn while open), "Carry: …" spares line on lamp jobs, night audit with large **Lit / Dark** buttons. |
| Management | Uptime per month (zone, road, contractor), contractor scorecard (example payment rule), chronic poles and batch failure rates, warranty claims, energy reconciliation, "Due before monsoon", event check (pick roads or draw a route; printable). |
| Pole labels | Printable QR label sheet; each code opens `BASE_URL#report=<UID>`. Labels use `BASE_URL` from `config.js` (the GitHub Pages address). |
| Share publicly (citizen) | In **My reports**, a quiet **Share publicly** appears only on a complaint past its SLA, or one the citizen said was not fixed. It previews the exact post, then opens X's web intent, the device's share sheet, or copies the text. See *Public escalation on X*. |
| Public status link | `#ticket=<ID>` (e.g. `BASE_URL#ticket=TKT-2026-0156`) opens a plain status card for that complaint in the Citizen view. |
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
├── confidence.js                 9a  Report confidence: a pure scoring function (no DOM, no state)
├── share.js                      9b  Public escalation text: X's weighted count, the post, the intent link
├── tickets.js                    9–11  Ticket model, confidence evidence, workflow, checks and outcomes, reporting
├── views.js                      12–13  Selection, URL hash, sidebar views
├── panels.js                     14  View switch, header, layers, legend, insights, search, toasts
├── roles.js                      15  Queue, work order, night audit, dashboard, labels, event check
├── backend.js                    19  Pilot server only: load, sync, sign-in, phone codes, photo upload
├── main.js                       16–18  Switches, events, init and clock tick
├── server-config.js              `null` here; the pilot server replaces it with its settings
├── server/                       The pilot backend (Node 22.13+, no packages): see server/README.md
│   ├── server.js                 HTTP server: the app, the JSON API, who may see what
│   ├── store.js                  SQLite documents with revisions, seeding from the dataset
│   ├── auth.js                   Staff passwords, sessions, phone OTP, rate limits
│   ├── providers.js              SMS (console, MSG91, Twilio), AI photo check (Claude), CCMS
│   └── admin.js                  Staff accounts from the command line
├── docs/
│   ├── usability-test.md         10-minute sessions per view: tasks, what to watch, results sheet
│   ├── data-request.md           The datasets and accounts needed from NDMC
│   └── data-handling.md          Personal data in the pilot, for a DPDP review
├── data/
│   ├── streetlights.js           window.SLGIS_DATA: everything below, loadable from file://
│   ├── streetlights.geojson      119 poles
│   ├── feeder_panels.geojson     8 feeder pillars
│   ├── landmarks.geojson         28 landmarks (approximate)
│   ├── excavation_permits.geojson 3 permits (approximate)
│   └── waterlogging_spots.geojson 3 spots (approximate)
└── tools/
    ├── generate_data.py          Rebuilds the dataset (seeded, reproducible)
    ├── validate_data.py          Checks structure, [lon, lat] order, cross-references, sync
    ├── test_confidence.js        Unit tests for report confidence (node, no dependencies)
    ├── test_share.js             Unit tests for the post text and X's counting rules
    ├── test_server.js            Integration tests for the pilot server's API
    └── e2e/                      Browser tests in headless Chrome (node, no dependencies)
        ├── run.mjs               Runs the suites; drives Chrome over the DevTools Protocol
        ├── core.mjs              Map, role views, tickets, field crew, management (rounds 1–2)
        ├── confidence.mjs        Report confidence, checks, outcomes, public escalation (round 3)
        ├── server.mjs            The pilot server: phone code, report, staff sign-in, sync, conflict
        └── fixtures/             Test photos
```

All scripts are plain `<script>` files sharing one scope (no modules, so `file://` works).

## Data model (one pole)

| Property | Example |
|---|---|
| `uid`, `road`, `location` | `SL-CP-OC-031`, `Outer Circle`, `Outer Circle, Palika Park side · …` |
| `pole_type`, `pole_height_m`, `arm_count` | `Octagonal GI`, `9`, `1` |
| `fixture_type`, `wattage`, `cct_k`, `ccms_node` | `LED`, `120`, `4000`, `true` |
| `ccms_reading` (CCMS poles only, simulated) | `{switch_on_at, state: on · off · abnormal, daylight: on · off}`: what the node reported at the last scheduled switch-on |
| `fixture_installed`, `fixture_make`, `fixture_batch`, `fixture_warranty_years` | `2023-03-21`, `Lumetra` (fictional), `LUM-2302`, `5` (example) |
| `last_inspected`, `last_earthing_check`, `junction_box_condition` | `2026-08-01`, `2024-09-15`, `Good` |
| `feeder_panel`, `circuit`, `circuit_seq`, `phase` | `FP-CP-07`, `C1`, `3`, `B` |
| `status` | `Functional` · `Faulty` · `Under Maintenance` |
| `contractor` | name, contact, masked phone, contract ref, SLA hours |
| `ticket` | live ticket (id, status, category, issue, source, crew, `pole_uids`, `public`, …) or `null`. Priority, SLA and confidence are computed in the app; `public` = `{shared_at, report_id}` once its reporter shared it. |
| `repair_history` | closed tickets, newest first; `outcome` and `reported_uid` mark a "Different pole" correction |
| `energy_kwh`, `energy_month`, `energy_history` | last month, plus 6 months of `{month, kwh, scheduled_h, lit_h}` |

Feeder panels add `capacity_kva`, `metered_kwh_history`, `temp_connections` and `planned_shutdowns`.
`streetlights.js` also holds `locationTickets`, `reporters` (simulated IDs with their past reports and how many
were confirmed on site; no names) and `citizenReports`: every complaint behind the tickets, with its reporter,
category, time, when it was noticed, an optional photo (`live` or `upload`, plus a perceptual hash) and an
optional "Use my location" fix (`[lon, lat]` and accuracy). A ticket's `complaints` count equals its linked reports.

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
| `BASE_URL` | `https://rams-prads.github.io/Streetlight-Analysis/` | public address for QR labels and status links (`''` turns both off) |
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
| `CONFIDENCE` | neutral 50; Confirmed ≥ 75, Likely ≥ 40; a weight per signal | report confidence scoring |
| `CONFIDENCE_PRIORITY` | Confirmed +6, Likely 0, Needs check −6 | the confidence nudge to priority |
| `LOCATION_MAX_ACCURACY_M`, `LOCATION_MATCH_M` | 50, 30 | "Use my location": too rough to use; close enough to support |
| `PHOTO_MATCH_MAX_BITS`, `PHOTO_HASH_MIN_CONTRAST` | 6, 8 | the same picture (of 64 bits); too dark or plain to compare |
| `REPORTS_PER_REPORTER_PER_HOUR` | 5 | beyond this, reports are logged and held for review |
| `NEEDS_CHECK_MAX_HOURS`, `NEARBY_CREW_M` | 12, 250 | cheap checks must fit in this time; what counts as a crew nearby |
| `PUBLIC_ESCALATION_ENABLED` | `true` | citizens may share overdue complaints on X (Management can switch it off) |
| `OFFICIAL_HANDLES`, `TEAM_DEPARTMENT` | placeholders | department X handles; replace with verified official handles |
| `X_POST`, `SHARE_LANDMARK_MAX_M` | 280, links count 23; 150 | X's limit and counting; landmark named in a post |
| `SYNC_DEBOUNCE_MS`, `SYNC_RETRY_MS` | 400, 10 000 | pilot server: send a staff action this long after the last click; retry after a failed send |
| `STAFF_PULL_MS`, `PUBLIC_PULL_MS` | 5 000, 30 000 | pilot server: how often staff and public browsers look for other people's changes |
| `ID_LEASE_SIZE` | 5 | pilot server: ticket and report IDs a staff browser keeps in hand |
| `PHOTO_MAX_PX`, `PHOTO_JPEG_QUALITY` | 1280, 0.85 | pilot server: photos are downsized and re-encoded before upload (drops EXIF and GPS) |
| `PHOTO_BLUR_PX`, `PHOTO_BLUR_PAD` | 18, 0.25 | pilot server: blur for faces and number plates, and how much each box grows |

Sunrise and sunset are computed (NOAA solar position, zenith 90.833°) for the zone centre, in IST,
in both the generator and the browser; the energy baseline uses each month's real night length.

## How report confidence works

Confidence decides the **order** in which reports are handled and **how** they are checked. It never decides
whether a report counts: every report is recorded, nothing is rejected, and the app never calls a report or a
person fake. Safety emergencies (exposed wires, shock or sparking) skip it entirely and go out at once.

- Every report starts at a neutral 50. With no evidence it stays there, in **Likely**, and is handled as before.
  A first-time reporter is not penalised.
- Evidence moves it up or down:
  - what the pole's CCMS node reported at its last switch-on;
  - a detected cable or panel fault, or a dark neighbour on the same circuit;
  - other people reporting the same pole within 48 h (up to a cap);
  - the reporter's record of reports confirmed on site, once they have one;
  - a photo (taken in the app counts more than uploaded; photos count most for physical problems such as a damaged pole);
  - "Use my location" close to the pole (far away is neutral: people often report later, from home);
  - whether the problem could be seen when they say they noticed it.
- If CCMS shows the lamp working, the report goes to **Needs check**, never to rejection, because CCMS can be wrong.
  The pole keeps its status until the check.
- A picture matching an earlier report's on another pole or another day lowers confidence, and the operator sees
  "Photo matches report <ID>". The same picture resent for the same pole by the same person is neutral.
- A check on site is final. "Different pole" counts as confirmed for the reporter: honest mistakes are common.
- Citizens never see a score, only progress such as "Confirmed. Crew assigned."
- Confidence nudges priority by at most 6 points, less than any other factor, so it never outweighs safety,
  criticality or the length of a dark stretch.

**AI photo check.** `photoCheck(photo, category, pole)` in `confidence.js` turns the AI's findings into signals with
reasons. In the demo it is a labelled, simulated stub: nothing leaves the browser. On the pilot server with
`ANTHROPIC_API_KEY` set, the server asks Claude what the photo shows (lamp on or off, after dark or not, pole
damaged, light blocked) and where the faces and number plates are; the browser blurs those before upload. The
findings move confidence by at most 6 points (`CONFIDENCE.aiPhoto`), and only where a photo can show the
problem (a daytime photo of a lamp that is "not working" proves nothing; flicker cannot be photographed). The
key stays on the server.

## Public escalation on X

- **Citizen-initiated only.** The citizen posts from their own account, by choice, through X's official web intent
  (`https://x.com/intent/tweet?text=…`). No bot, no auto-posting, no X API, no keys.
- **Only when earned:** the complaint is still open past its SLA, or the citizen answered "No" to "Fixed?". Never at
  report time, and no reminders.
- **Factual and private:** complaint ID, category, road and nearby landmark, days open, the public status link
  (`BASE_URL#ticket=<ID>`, left out while `BASE_URL` is empty) and the department's handle. No name, phone number,
  photo or personal location. Written in the citizen's language and fitted to X's 280-character limit with its
  weighted counting (links count as 23).
- **Placeholder handles** (`@OFFICIAL_HANDLE_…`) are left out of posts until replaced with verified official
  handles; the Management view says so. The public demo runs on mock data, so it keeps the placeholders and
  never tags a real account; the pilot server takes the verified handles from `OFFICIAL_HANDLES_JSON`.
- The exact text is previewed first. **Share…** uses the device's share sheet where available (e.g. WhatsApp);
  otherwise **Copy text**.
- Operators see **Public** on the ticket and "Shared publicly by reporter" in its activity. It never raises priority,
  so people who post do not get faster repairs than equally urgent reports from people who don't.
- When a shared ticket is fixed, the queue offers **Draft public update**: a short factual "Fixed" message with the
  complaint ID, for the department's own account, through the same intent.
- Management can switch the feature off (`PUBLIC_ESCALATION_ENABLED`, and a switch in the dashboard).

## Run the tests

```
node tools/test_confidence.js    # report confidence: emergencies, neutral evidence, CCMS, location, reporters, photos, outcomes
node tools/test_share.js         # post text, X's weighted counting, handles, links
node tools/test_server.js        # the pilot server's API: sign-in, sync and conflicts, phone codes, citizen reports, photos
node tools/e2e/run.mjs           # browser tests: every view and flow, through real clicks (about 12 minutes)
```

The browser tests need Google Chrome (set `CHROME` to its path if it is not in the usual place) and an
internet connection for the CDN libraries and map tiles. They open `index.html` from disk at 19:30 on the
snapshot day; screenshots go to the system temp folder (`slgis-e2e`). Run one suite with
`node tools/e2e/run.mjs core.mjs`. The `server.mjs` suite starts its own pilot server on port 8097 with a
throwaway database.

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

- **Real data.** Everything is still synthetic. [docs/data-request.md](docs/data-request.md) lists what to ask NDMC
  for; an importer will be written against the files they send.
- **Before citizens use the pilot:** a real SMS provider with DLT-approved templates, verified X handles, the
  privacy review in [docs/data-handling.md](docs/data-handling.md) (retention, notice wording, erase requests),
  and the 10-minute sessions in [docs/usability-test.md](docs/usability-test.md).
- The Hindi strings were revised for consistency but still **need sign-off by a native speaker**. Data strings
  (locations, issues) stay in English.
- The live CCMS, MSG91 and Twilio adapters follow the published APIs but are untested against the live services;
  the CCMS reply shape is an assumption until the vendor's API is known. Crew GPS and meter readings are not connected.
- Photos are blurred in the browser; server-side blurring needs an image library. Citizen SMS updates ("fixed")
  are not sent yet. Finer per-role write rules for staff are a next step (every write is logged).
- In the demo (no server) tickets, reports and the audit trail live in memory for the session, and the view
  switch is not a login.
- Offline night audits need a service worker (the app is now served over https): a next step.
- A browser cannot prove a photo was taken live; "Take photo" only asks for the camera.
- Landmark, permit and waterlogging positions are approximate synthetic placements; replace them with verified survey data.
- Tailwind runs from its Play CDN (it logs a "not for production" warning); compile it for production.
