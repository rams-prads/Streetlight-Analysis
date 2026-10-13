# Street Light GIS: Connaught Place pilot (MVP)

A map-first street light management GIS for the Connaught Place pilot zone (NDMC area, New Delhi).
Everything happens on the map: the asset register, citizen fault reporting, maintenance tickets,
and three spatial analyses (dark spots, energy, feeder dependence).

> **Mock data.** Pole positions follow the real Inner, Middle and Outer Circle roads (fitted to
> OpenStreetMap). Every attribute (status, tickets, contractors, energy) is synthetic.

## Run it

Double-click `index.html`. No build step and no server needed (the dataset ships as a script so it
also works from `file://`). An internet connection is required: Leaflet, MapLibre, Tailwind,
Font Awesome and the basemap load from public CDNs.

Optional local server: `python -m http.server 8000`, then open <http://localhost:8000>.

## What you can do

| Feature | How |
|---|---|
| Inspect a pole | Click any marker. A sidebar slides in with pole, fixture, feeder, energy, contractor and the repair-history timeline. |
| Report a fault (citizen) | **Report an issue** → the cursor becomes a crosshair → click a pole or any spot. Clicks snap to the nearest pole within 40 m; otherwise the ticket is raised for that exact location. |
| Work a ticket (operator demo) | In the sidebar: **Dispatch** a crew (pole → *Under maintenance*), then **Close ticket** (pole → *Functional*, repair logged). One outage ticket can cover several poles. |
| Dark-spot heatmap | Heat from the density of *Faulty* poles, plus clusters (DS-1, DS-2, …) with a likely root cause, e.g. "probable cable fault after pole #2". |
| Energy layer | Marker **area** proportional to monthly kWh; fixture-type shares, LED-retrofit savings, and day-burning anomalies (lamps using > 150 % of their dusk-to-dawn baseline). |
| Feeder network | Polylines join poles that share a feeder panel, in wiring order. Hover a line for its circuit; click to **trace** every pole that depends on that panel. |
| Search / filter | Search box (or press `/`) for pole IDs, roads, panels, tickets. Click a status in the legend to hide or show it. `Esc` backs out one step. |
| Share a view | The URL hash follows the selection, e.g. `index.html#SL-CP-OC-031`. |

Status symbols use shape as well as colour, so red/green colour blindness doesn't matter:
**●** functional (lit disc) · **○** faulty (unlit ring) · dashed ring = under maintenance.

## Files

```
├── index.html                 Page shell: map container, floating panels, modal, CDN imports
├── style.css                  Design tokens, Leaflet overrides, map symbology, components
├── app.js                     The application (Leaflet + leaflet.heat + MapLibre basemap)
├── data/
│   ├── streetlights.js        window.SLGIS_DATA: everything below, loadable from file://
│   ├── streetlights.geojson   114 poles: RFC 7946 FeatureCollection (QGIS / geojson.io)
│   └── feeder_panels.geojson  8 feeder pillars
└── tools/
    └── generate_data.py       Rebuilds the dataset (seeded, reproducible)
```

`app.js` is organised in numbered sections (config → utilities → state → map → layers →
analysis → sidebar → ticketing → reporting → panels → events → init).

## Data model (one pole)

| Property | Example |
|---|---|
| `uid`, `road`, `location` | `SL-CP-OC-031`, `Outer Circle`, `Outer Circle, Palika Park side · opp. Jeevan Bharti Building` |
| `pole_type`, `pole_height_m`, `arm_count` | `Octagonal GI`, `9`, `1` |
| `fixture_type`, `wattage`, `cct_k`, `ccms_node` | `LED`, `120`, `4000`, `true` |
| `feeder_panel`, `circuit`, `circuit_seq`, `phase` | `FP-CP-07`, `C1`, `3`, `B` |
| `status` | `Functional` · `Faulty` · `Under Maintenance` |
| `contractor` | name, contact, masked phone, contract ref, SLA hours |
| `ticket` | live ticket (id, status, priority, SLA due, crew, linked `pole_uids`) or `null` |
| `repair_history` | closed tickets, newest first (issue, action, crew, downtime, SLA met, cost) |
| `energy_kwh`, `energy_month`, `energy_history` | last full month, plus 6-month series |

**Coordinates:** GeoJSON stores `[longitude, latitude]`; Leaflet wants `[latitude, longitude]`.
`L.geoJSON` converts automatically, and the only hand-written conversion in `app.js` is
`toLatLng()`, which calls Leaflet's own `L.GeoJSON.coordsToLatLng`. On load the app also warns
in the console if any feature looks swapped or sits outside the pilot zone.

## Regenerate the data

```
python tools/generate_data.py                     # snapshot 13 Oct 2026, 18:00 IST
python tools/generate_data.py --as-of 2026-11-20T18:00
```

Ticket ages and SLA deadlines are measured against the real clock, so for a demo weeks from now,
regenerate with a recent `--as-of` to keep the open tickets fresh.

## Basemap

CARTO now stamps keyless Dark Matter tiles with "API KEY REQUIRED", so the night basemap is
OpenFreeMap's free, keyless **dark** vector style, drawn by MapLibre GL inside Leaflet. If WebGL
is unavailable or the style fails to load, the app falls back to Esri's dark-grey raster tiles.
To use CARTO Dark Matter instead, get a free key at <https://carto.com/basemaps/apikey> and set
`CARTO_API_KEY` at the top of `app.js`. A satellite basemap (Esri World Imagery) is in the layers
panel.

## MVP limits / next steps

- Tickets and reports live in memory for the session; a backend (e.g. PostGIS + REST) would persist them.
- No authentication: citizen and operator views share one screen.
- Tailwind runs from its Play CDN (it logs a "not for production" warning); compile it for production.
- Live CCMS feeds, crew GPS and work-order photos would replace the mock data.
