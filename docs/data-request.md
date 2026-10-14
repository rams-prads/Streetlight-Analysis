# Data needed from NDMC for the pilot

The pilot runs on synthetic data today. These are the datasets that would replace it, in priority
order. Any common format is fine (CSV, Excel, GeoJSON, Shapefile, KML); positions in WGS 84
(longitude/latitude, EPSG:4326), or say which coordinate system is used. Once the files arrive, an
importer will be written against their actual columns.

## 1. Street light poles (essential)

One row per pole in the Connaught Place pilot area (Inner, Middle and Outer Circle and the radial roads).

| Field | Example | Notes |
|---|---|---|
| Pole number, as painted on the pole | `CP/MC/014` | the ID crews and citizens see |
| Position | `77.21871, 28.63195` | GPS survey, ±3 m or better |
| Road / segment | Middle Circle, A-Block | |
| Pole type, height, arms | Octagonal, 9 m, 2 | |
| Fixture type, wattage, colour temperature | LED, 120 W, 4000 K | |
| Fixture make and batch, installed on, warranty | | for warranty claims and batch failure analysis |
| CCMS node ID | | blank if none |
| Feeder panel, circuit, phase | FP-CP-03, C2, R | |
| Order along the circuit | 9 | or a list of which pole feeds which |
| Maintenance contractor / AMC zone | | |
| Last inspection, last earthing test | dates | |

## 2. Feeder panels (essential)

Panel ID, position, capacity (kVA), circuits, energy meter number, and the **monthly metered kWh for
the last 12 months**. Temporary connections (festive, events) with dates and load, if recorded.

## 3. CCMS (essential for confirmation without a site visit)

- The CCMS vendor and their **API documentation** (or a sample export), with test credentials.
- The node-to-pole mapping and the switch-on/off schedule.
- One sample day of node readings (on / off / fault, with times).

## 4. Complaint and repair history (for priorities and contractor scorecards)

Last 12 months of street-light complaints: complaint ID, pole or location, category, received,
assigned, resolved, crew, contractor, resolution. **Without** complainants' names or phone numbers.

## 5. Contracts and teams

SLA hours per contractor and complaint type, AMC zones, crews and their phone-free identifiers,
and the escalation ladder (JE → AE → EE) with designations.

## 6. Planning layers (nice to have)

Planned power shutdowns, excavation / road-cutting permits, known waterlogging spots. Each with its
source, so the map can say how reliable it is.

## 7. Accounts and approvals (before citizens use it)

- **Verified X handles** for the electrical, horticulture and emergency teams, and who replies.
- **SMS**: the DLT entity ID and approved templates (OTP code; on-call emergency alert), and the SMS
  provider account (MSG91, Twilio or NDMC's existing one).
- A named owner for citizen data, and sign-off of the privacy notice (see `data-handling.md`).
