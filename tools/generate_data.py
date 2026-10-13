#!/usr/bin/env python3
"""
Street Light GIS - mock dataset generator
=========================================

Builds the pilot-zone dataset for Connaught Place (NDMC area), New Delhi: street lights on
the Inner, Middle and Outer Circle and Radial Road 1, their feeder pillars (panels), AMC
contractors, live tickets, repair history, monthly energy and lit hours, and three planning
layers (landmarks, excavation permits, waterlogging spots).

Geometry is real, attributes are synthetic
------------------------------------------
* Ring centre and radii were fitted to OpenStreetMap road centrelines
  (c) OpenStreetMap contributors, ODbL:
      Inner Circle   R = 125.6 m      (rms 0.7 m, closed loop)
      Middle Circle  R ~ 235 m        (rms 0.5 m, open across Palika Park ~182-243 deg)
      Outer Circle   R ~ 309-325 m    (irregular -> radius profile sampled every 5 deg)
      Radial Road 1  128 -> 321 m from the centre along bearing ~186 -> 184 deg
* Blocks, radial roads, approach-road junctions and Rajiv Chowk metro gates are
  placed by their OSM bearings, so location labels match the real place.
* Every attribute is MOCK data from a fixed seed, so the output is reproducible.
  Landmarks, excavation permits and waterlogging spots are synthetic AND only
  approximately placed: each carries `approximate: true`.
* Sunset and sunrise come from the NOAA general solar position equations for the zone
  centre (zenith 90.833 deg), so scheduled lamp hours follow the real sky.

Outputs (relative to the project root)
--------------------------------------
  data/streetlights.geojson        poles (RFC 7946 FeatureCollection, opens in QGIS)
  data/feeder_panels.geojson       feeder pillars
  data/landmarks.geojson           metro exits, bus stops, subways, crossings, ATMs, parking
  data/excavation_permits.geojson  third-party digging (line geometry)
  data/waterlogging_spots.geojson  monsoon hotspots
  data/streetlights.js             all of the above, plus location-only tickets and metadata,
                                   as `window.SLGIS_DATA` so index.html runs from file://

Coordinate order: GeoJSON positions are ALWAYS [longitude, latitude].

Usage
-----
  python tools/generate_data.py                       # snapshot 2026-10-13 18:00 IST
  python tools/generate_data.py --as-of 2026-11-20T18:00
  python tools/validate_data.py                       # check the output
"""
from __future__ import annotations

import argparse
import functools
import json
import math
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data"
IST = timezone(timedelta(hours=5, minutes=30))  # India has no daylight saving
SEED = 2406
DEFAULT_AS_OF = "2026-10-13T18:00"

# ---------------------------------------------------------------------------
# 1. Geometry (fitted to OpenStreetMap)
# ---------------------------------------------------------------------------
CENTRE = {"lat": 28.632790, "lng": 77.219705}  # Central Park / Rajiv Chowk
_PHI = math.radians(CENTRE["lat"])
M_PER_DEG_LAT = 111132.954 - 559.822 * math.cos(2 * _PHI) + 1.175 * math.cos(4 * _PHI)
M_PER_DEG_LNG = 111412.84 * math.cos(_PHI) - 93.5 * math.cos(3 * _PHI) + 0.118 * math.cos(5 * _PHI)

INNER_RADIUS_M = 125.6
# Centreline radius (m) every 5 deg of compass bearing, measured on OSM.
MIDDLE_PROFILE = {
    0: 235.0, 5: 235.1, 10: 235.2, 15: 235.1, 20: 235.1, 25: 235.1, 30: 235.2, 35: 235.1,
    40: 235.1, 45: 235.1, 50: 235.1, 55: 235.1, 60: 235.1, 65: 235.1, 70: 235.0, 75: 235.0,
    80: 234.9, 85: 234.9, 90: 234.8, 95: 234.7, 100: 234.6, 105: 234.4, 110: 234.3, 115: 234.2,
    120: 234.0, 125: 234.3, 130: 235.2, 135: 234.7, 140: 234.0, 145: 233.2, 150: 233.1,
    155: 233.0, 160: 232.9, 165: 232.9, 170: 233.0, 175: 232.8, 180: 232.9,
    # 185-240: no Middle Circle (Palika Park)
    245: 234.8, 250: 235.1, 255: 235.3, 260: 235.4, 265: 235.6, 270: 235.6, 275: 235.7,
    280: 235.8, 285: 235.8, 290: 235.9, 295: 235.8, 300: 235.9, 305: 235.6, 310: 235.7,
    315: 235.7, 320: 235.6, 325: 235.6, 330: 235.5, 335: 235.4, 340: 235.4, 345: 235.3,
    350: 235.2, 355: 235.3,
}
OUTER_PROFILE = {
    0: 323.1, 5: 324.7, 10: 319.2, 15: 316.2, 20: 315.6, 25: 317.5, 30: 321.6, 35: 322.0,
    40: 319.0, 45: 317.3, 50: 317.1, 55: 318.1, 60: 318.0, 65: 318.6, 70: 319.6, 75: 320.1,
    80: 320.3, 85: 320.9, 90: 321.5, 95: 321.7, 100: 321.8, 105: 322.1, 110: 321.6, 115: 319.0,
    120: 317.9, 125: 317.4, 130: 318.6, 135: 318.3, 140: 318.2, 145: 319.7, 150: 322.8,
    155: 322.6, 160: 322.7, 165: 322.6, 170: 321.9, 175: 321.6, 180: 322.0, 185: 321.5,
    190: 321.1, 195: 320.9, 200: 320.5, 205: 320.6, 210: 323.2, 215: 323.2, 220: 318.6,
    225: 316.2, 230: 316.3, 235: 319.1, 240: 323.5, 245: 324.2, 250: 320.5, 255: 318.0,
    260: 317.2, 265: 318.0, 270: 321.0, 275: 320.8, 280: 316.9, 285: 312.2, 290: 309.9,
    295: 308.7, 300: 309.0, 305: 310.1, 310: 308.7, 315: 308.9, 320: 311.1, 325: 315.2,
    330: 319.9, 335: 320.8, 340: 321.4, 345: 320.6, 350: 320.3, 355: 320.2,
}
# Radial Road 1 on OSM: from the Inner Circle (128 m, 186.0 deg) to the Outer Circle (321 m, 184.1 deg).
R1_INNER, R1_OUTER = (128.0, 186.0), (321.0, 184.1)
# Pole radii along Radial Road 1. No pole was ever installed near 240 m (Palika Bazaar ramp), which
# leaves one 70 m span: the demo for the "Coverage gaps" layer. No existing pole was moved or removed.
R1_RADII = [145.0, 175.0, 205.0, 275.0, 305.0]
PILOT_ZONE_RADIUS_M = 360.0

# Radial roads cut the rings into sectors; CP blocks sit between them.
RADIAL_ROADS = [("Radial Road 4", 2.3), ("Radial Road 5", 32.0), ("Radial Road 6", 59.2),
                ("Radial Road 7", 123.8), ("Radial Road 1", 185.0), ("Radial Road 2", 242.5),
                ("Radial Road 3", 302.7)]
SECTOR_BLOCKS = {2.3: ("C", "K"), 32.0: ("D", "L"), 59.2: ("E", "M"), 123.8: ("F", "N"),
                 185.0: (None, None), 242.5: ("A", "G"), 302.7: ("B", "H")}
APPROACH_ROADS = [("State Entry Road", 2.8), ("Vivekanand Marg", 33.5), ("Connaught Lane", 76.8),
                  ("Barakhamba Road", 118.8), ("Kasturba Gandhi Marg", 158.6), ("Janpath", 184.1),
                  ("Sansad Marg", 218.8), ("Baba Kharak Singh Marg", 247.7),
                  ("Shaheed Bhagat Singh Marg", 274.3), ("Panchkuian Road", 302.8),
                  ("Chelmsford Road", 328.6)]
METRO_GATES = [("Rajiv Chowk Metro Gate 1", 318.4), ("Rajiv Chowk Metro Gate 2", 345.3),
               ("Rajiv Chowk Metro Gate 3", 47.3), ("Rajiv Chowk Metro Gate 5", 159.1),
               ("Rajiv Chowk Metro Gate 6", 199.0), ("Rajiv Chowk Metro Gate 7", 249.3),
               ("Rajiv Chowk Metro Gate 8", 276.4)]


def destination(bearing_deg: float, radius_m: float) -> tuple[float, float]:
    """Point `radius_m` from the ring centre along compass `bearing_deg` -> (lat, lng)."""
    b = math.radians(bearing_deg)
    return (CENTRE["lat"] + radius_m * math.cos(b) / M_PER_DEG_LAT,
            CENTRE["lng"] + radius_m * math.sin(b) / M_PER_DEG_LNG)


def position(lat: float, lng: float) -> list[float]:
    """One GeoJSON position. RFC 7946 order is [longitude, latitude] - never the other way round."""
    assert 28.60 < lat < 28.66 and 77.19 < lng < 77.25, f"({lat}, {lng}) outside pilot zone"
    return [round(lng, 6), round(lat, 6)]


def point_geometry(lat: float, lng: float) -> dict:
    return {"type": "Point", "coordinates": position(lat, lng)}


def polar_point(bearing: float, radius: float) -> dict:
    return point_geometry(*destination(bearing, radius))


def profile_radius(profile: dict[int, float], bearing: float) -> float:
    b = bearing % 360
    lo = int(b // 5) * 5
    hi = (lo + 5) % 360
    t = (b - lo) / 5
    return profile[lo] * (1 - t) + profile[hi] * t


def outer_r(bearing: float) -> float:
    return profile_radius(OUTER_PROFILE, bearing)


def r1_bearing(radius: float) -> float:
    t = (radius - R1_INNER[0]) / (R1_OUTER[0] - R1_INNER[0])
    return R1_INNER[1] + t * (R1_OUTER[1] - R1_INNER[1])


def angdiff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def nearest(named_bearings, bearing, max_deg):
    best = min(named_bearings, key=lambda nb: angdiff(nb[1], bearing))
    return best[0] if angdiff(best[1], bearing) <= max_deg else None


def sector_blocks(bearing: float):
    starts = sorted(SECTOR_BLOCKS)
    b = bearing % 360
    current = starts[-1]  # bearings below 2.3 deg belong to the B/H sector
    for s in starts:
        if b >= s:
            current = s
    return SECTOR_BLOCKS[current]


def describe_location(road: str, bearing: float, idx: int) -> str:
    inner, outer = sector_blocks(bearing)
    if road == "IC":
        text = f"Inner Circle, facing {inner}-Block" if inner else "Inner Circle, Palika Bazaar side"
        junction = nearest(RADIAL_ROADS, bearing, 4.5)
        gate = nearest(METRO_GATES, bearing, 6.0)
        if junction:
            text += f" · {junction} junction"
        elif gate:
            text += f" · near {gate}"
    elif road == "MC":
        text = f"Middle Circle, between {inner}- & {outer}-Blocks"
        junction = nearest(RADIAL_ROADS, bearing, 4.0)
        if junction:
            text += f" · {junction} junction"
        elif angdiff(bearing, 359.8) <= 4:
            text += " · near PVR Plaza"
    elif road == "OC":
        text = f"Outer Circle, {outer}-Block frontage" if outer else "Outer Circle, Palika Park side"
        junction = nearest(APPROACH_ROADS, bearing, 3.3)
        if junction:
            text += f" · {junction} junction"
        elif angdiff(bearing, 197.5) <= 4:
            text += " · opp. Jeevan Bharti Building"
    else:
        text = "Radial Road 1, beside Palika Bazaar"
        if idx == 0:
            text += " · Inner Circle end"
        elif idx == len(R1_RADII) - 1:
            text += " · Outer Circle end"
    return text


# ---------------------------------------------------------------------------
# 2. Sun: NOAA general solar position equations (sunrise / sunset at the zone centre)
# ---------------------------------------------------------------------------
@functools.lru_cache(maxsize=None)
def sun_times(d: date) -> tuple[datetime, datetime]:
    """(sunrise, sunset) in IST on calendar date `d`, apparent sun with refraction (zenith 90.833 deg)."""
    leap = d.year % 4 == 0 and (d.year % 100 != 0 or d.year % 400 == 0)
    g = 2 * math.pi / (366 if leap else 365) * (d.timetuple().tm_yday - 1)  # fractional year at noon
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                       - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))  # minutes
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    lat = math.radians(CENTRE["lat"])
    hour_angle = math.degrees(math.acos(math.cos(math.radians(90.833)) / (math.cos(lat) * math.cos(decl))
                                        - math.tan(lat) * math.tan(decl)))
    midnight_utc = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    sunrise = midnight_utc + timedelta(minutes=720 - 4 * (CENTRE["lng"] + hour_angle) - eqtime)
    sunset = midnight_utc + timedelta(minutes=720 - 4 * (CENTRE["lng"] - hour_angle) - eqtime)
    return sunrise.astimezone(IST), sunset.astimezone(IST)


def night_of(d: date) -> tuple[datetime, datetime]:
    """The dusk-to-dawn interval that starts on the evening of `d`."""
    return sun_times(d)[1], sun_times(d + timedelta(days=1))[0]


def month_nights(y: int, m: int) -> list[tuple[datetime, datetime]]:
    """Every night that starts in month (y, m)."""
    d = date(y, m, 1)
    out = []
    while d.month == m:
        out.append(night_of(d))
        d += timedelta(days=1)
    return out


def hours(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / 3600


def overlap_hours(a0: datetime, a1: datetime, b0: datetime, b1: datetime) -> float:
    return max(0.0, hours(max(a0, b0), min(a1, b1)))


def night_overlap(a0: datetime, a1: datetime, nights) -> float:
    return sum(overlap_hours(a0, a1, n0, n1) for n0, n1 in nights)


# ---------------------------------------------------------------------------
# 3. Network design: roads -> poles -> feeder pillars -> circuits
# ---------------------------------------------------------------------------
ROADS = {
    "IC": {"name": "Inner Circle", "contractor": "CTR-01"},
    "MC": {"name": "Middle Circle", "contractor": "CTR-02"},
    "OC": {"name": "Outer Circle", "contractor": "CTR-03"},
    "R1": {"name": "Radial Road 1", "contractor": "CTR-01"},
}


def pole_positions() -> dict[str, list[dict]]:
    """Every pole by road, in physical order along the road (uid numbering follows this order)."""
    pos = {
        "IC": [dict(bearing=7.5 + 15 * i, radius=INNER_RADIUS_M - 3.0) for i in range(24)],
        "MC": [dict(bearing=b, radius=profile_radius(MIDDLE_PROFILE, b))
               for b in ((246 + j * 292 / 33) % 360 for j in range(34))],
        "OC": [dict(bearing=b, radius=outer_r(b) + 3.0) for b in (3.2143 + k * 360 / 56 for k in range(56))],
        "R1": [dict(bearing=r1_bearing(r), radius=r) for r in R1_RADII],
    }
    for items in pos.values():
        for it in items:
            it["lat"], it["lng"] = destination(it["bearing"], it["radius"])
    return pos


def ring(road: str, indices) -> list[tuple[str, int]]:
    return [(road, i) for i in indices]


# Each pillar feeds radial circuits; seq 1 is the pole nearest the pillar (wiring order).
PANELS = [
    dict(id="FP-CP-01", road="IC", name="Central Park North", bearing=0.0, radius=108.0,
         where="Central Park north lawn, opposite Radial Road 4",
         circuits={"C1": ring("IC", range(0, 6)), "C2": ring("IC", range(23, 17, -1))},
         kva=6, controller="CCMS panel controller (GSM)", commissioned="2010-08-14", source_dt="DT-CP-01 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-02", road="IC", name="Central Park South", bearing=180.0, radius=108.0,
         where="Central Park south lawn, behind Palika Bazaar Gate 1",
         circuits={"C1": ring("IC", range(12, 18)), "C2": ring("IC", range(11, 5, -1)), "C3": ring("R1", range(0, 5))},
         kva=6, controller="CCMS panel controller (GSM)", commissioned="2010-08-14", source_dt="DT-CP-01 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-03", road="MC", name="Middle Circle North-West", bearing=(246 + 8.5 * 292 / 33) % 360, radius=244.0,
         where="Middle Circle footpath between B- and H-Blocks",
         circuits={"C1": ring("MC", range(9, 17)), "C2": ring("MC", range(8, -1, -1))},
         kva=6, controller="Astronomical timer + contactor", commissioned="2010-09-02", source_dt="DT-CP-02 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-04", road="MC", name="Middle Circle East", bearing=(246 + 25.5 * 292 / 33) % 360, radius=244.0,
         where="Middle Circle footpath between E- and M-Blocks",
         circuits={"C1": ring("MC", range(26, 34)), "C2": ring("MC", range(25, 16, -1))},
         kva=6, controller="Astronomical timer + contactor", commissioned="2010-09-02", source_dt="DT-CP-03 (11 kV/433 V, 990 kVA)"),
    dict(id="FP-CP-05", road="OC", name="Outer Circle North", bearing=0.0, radius=None,
         where="Outer Circle footpath at State Entry Road junction",
         circuits={"C1": ring("OC", range(0, 7)), "C2": ring("OC", range(55, 48, -1))},
         kva=10, controller="CCMS panel controller (GSM)", commissioned="2010-07-21", source_dt="DT-CP-02 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-06", road="OC", name="Outer Circle East", bearing=90.0, radius=None,
         where="Outer Circle footpath, M-Block frontage",
         circuits={"C1": ring("OC", range(14, 21)), "C2": ring("OC", range(13, 6, -1))},
         kva=10, controller="CCMS panel controller (GSM)", commissioned="2010-07-21", source_dt="DT-CP-03 (11 kV/433 V, 990 kVA)"),
    dict(id="FP-CP-07", road="OC", name="Outer Circle South", bearing=180.0, radius=None,
         where="Outer Circle footpath at Janpath junction",
         circuits={"C1": ring("OC", range(28, 35)), "C2": ring("OC", range(27, 20, -1))},
         kva=10, controller="CCMS panel controller (GSM)", commissioned="2010-07-21", source_dt="DT-CP-04 (11 kV/433 V, 990 kVA)"),
    dict(id="FP-CP-08", road="OC", name="Outer Circle West", bearing=270.0, radius=None,
         where="Outer Circle footpath, G-Block frontage",
         circuits={"C1": ring("OC", range(42, 49)), "C2": ring("OC", range(41, 34, -1))},
         kva=10, controller="Astronomical timer + contactor", commissioned="2010-07-21", source_dt="DT-CP-04 (11 kV/433 V, 990 kVA)"),
]

CONTRACTORS = {
    "CTR-01": {"id": "CTR-01", "name": "Prakash Electro Services", "contact_person": "R. K. Verma",
               "phone": "+91 98XXX X4102", "email": "cp-om@prakash-electro.example",
               "contract_ref": "AMC/SL/CP-IC/2025-28", "sla_hours": 48,
               "crews": ["P1 · Ramesh K.", "P2 · Sunil T."]},
    "CTR-02": {"id": "CTR-02", "name": "Jyoti Lighting Co.", "contact_person": "S. Ahmed",
               "phone": "+91 97XXX X2290", "email": "service@jyoti-lighting.example",
               "contract_ref": "AMC/SL/CP-MC/2025-28", "sla_hours": 48,
               "crews": ["J1 · Imran S.", "J2 · Harpreet S."]},
    "CTR-03": {"id": "CTR-03", "name": "Roshni Infra Maintenance", "contact_person": "P. Nair",
               "phone": "+91 99XXX X7315", "email": "cp-ops@roshni-infra.example",
               "contract_ref": "AMC/SL/CP-OC/2025-28", "sla_hours": 48,
               "crews": ["R1 · Anil M.", "R2 · Deepak R.", "R3 · Farhan A."]},
}
# In-house teams the app routes tickets to (lamp tickets go to the AMC contractor's crews).
TEAM_CREWS = {
    "cable": ["EL-1 · Cable jointing", "EL-2 · Panel & supply"],
    "emergency": ["EM-1 · Rapid response"],
    "horticulture": ["HT-1 · Tree pruning", "EN-1 · Hoarding enforcement"],
    "survey": ["SV-1 · Zonal survey"],
}

TARIFF_INR_PER_KWH = 8.0
SYSTEM_LOSS = {"LED": 1.06, "HPS": 1.15, "Metal Halide": 1.12}  # driver / ballast losses
# Fixture warranty in years. EXAMPLE values for the demo, not real supplier terms.
WARRANTY_YEARS_EXAMPLE = {"LED": 5, "HPS": 1, "Metal Halide": 2}

JUNCTION_MASTS = {18: "Barakhamba Road", 28: "Janpath"}  # Outer Circle pole index -> junction
LEGACY_HPS_PANEL = "FP-CP-08"                            # west quadrant: retrofit pending
WEAK_BATCH = "ARB-2203"                                  # LED driver batch with a high failure rate
WEAK_BATCH_MC = range(15, 26)                            # Middle Circle poles fitted from that batch

# ---------------------------------------------------------------------------
# 4. Live situation at the snapshot
#    `ago` = hours before --as-of the ticket was raised; `started_ago` / `closed_ago` likewise.
#    `category` is one of the citizen report categories in config.js; the app derives the team,
#    priority and SLA from it (priority and SLA are not stored here).
# ---------------------------------------------------------------------------
LIVE_TICKETS = [
    # Dark stretch: cable fault on FP-CP-07 / C1 - every pole downstream of #2 is out.
    dict(poles=ring("OC", range(30, 35)), status="Open", category="not_working",
         issue="No supply - poles dark (CCMS: circuit current drop)", source="CCMS auto-alert",
         ago=43.3, complaints=3, notes="Zero current reported downstream on circuit C1. Citizen complaints merged."),
    # Lost phases at FP-CP-03 / C2: poles on phases R and Y are dark, phase B still works.
    # Reported three times; the app's circuit check collapses them into one cable & panel ticket.
    dict(poles=ring("MC", [8, 7]), status="Open", category="not_working", issue="Lamps not glowing",
         source="Night patrol", ago=20.5),
    dict(poles=ring("MC", [5]), status="Open", category="not_working", issue="Light not working",
         source="Citizen app", ago=3.0, complaints=1),
    dict(poles=ring("MC", [4, 2, 1]), status="Open", category="not_working", issue="Street dark near A-Block",
         source="Call centre", ago=1.5, complaints=1),
    # Safety
    dict(poles=ring("IC", [21, 22]), status="Open", category="exposed",
         issue="Junction box open, cable stolen", source="Night patrol", ago=18.8, complaints=1,
         notes="Dark patch near Rajiv Chowk Metro Gate 1. Police complaint filed."),
    dict(poles=ring("OC", [13]), status="Open", category="shock", issue="Sparking at pole base",
         source="Call centre", ago=0.8, complaints=1),
    # Lamp faults
    dict(poles=ring("OC", [45]), status="Open", category="flickering", issue="Lamp cycling on/off", source="Citizen app",
         ago=69.75, complaints=2),
    dict(poles=ring("OC", [2]), status="Open", category="not_working", issue="LED driver failure", source="CCMS auto-alert", ago=11.5),
    dict(poles=ring("OC", [11]), status="Open", category="not_working", issue="Lamp not glowing", source="Call centre",
         ago=20.2, complaints=1),
    # Open past its SLA; its citizen reporter shared it publicly on X (simulated).
    dict(poles=ring("MC", [18]), status="Open", category="not_working", issue="LED driver failure", source="Night patrol",
         ago=93.0, complaints=1, public_ago=30.0, public_report="CR-D11"),
    dict(poles=ring("MC", [19]), status="Open", category="not_working", issue="LED driver failure", source="Citizen app",
         ago=45.5, complaints=1),
    dict(poles=ring("MC", [21]), status="Open", category="not_working", issue="LED driver failure", source="Night patrol", ago=21.0),
    dict(poles=ring("IC", [9]), status="Open", category="not_working", issue="Lamp not glowing", source="Citizen app",
         ago=45.5, complaints=2),
    # Crew R2's work order: five dispatched jobs spread round the Outer Circle
    dict(poles=ring("OC", [8]), status="In Progress", category="not_working", issue="Surge protection device failure",
         source="CCMS auto-alert", ago=12.2, started_ago=5.5, crew="R2 · Deepak R."),
    dict(poles=ring("OC", [18]), status="In Progress", category="not_working", issue="Ballast failure",
         source="CCMS auto-alert", ago=22.3, started_ago=7.0, crew="R2 · Deepak R."),
    dict(poles=ring("OC", [23]), status="In Progress", category="not_working", issue="Lamp not glowing",
         source="CCMS auto-alert", ago=30.0, started_ago=2.0, crew="R2 · Deepak R."),
    dict(poles=ring("OC", [38]), status="In Progress", category="not_working", issue="Lamp burnt out",
         source="Night patrol", ago=22.9, started_ago=1.0, crew="R2 · Deepak R."),
    dict(poles=ring("OC", [46]), status="In Progress", category="not_working", issue="Ignitor failure",
         source="Night patrol", ago=22.0, started_ago=7.75, crew="R2 · Deepak R."),
    # Other work in progress
    dict(poles=ring("OC", [52]), status="In Progress", category="damaged", issue="Pole damaged by vehicle", source="Call centre",
         ago=378.5, started_ago=356.0, crew="R3 · Farhan A.", complaints=1,
         notes="Pole made safe and isolated. Replacement pole on order."),
    dict(poles=ring("MC", [20]), status="In Progress", category="not_working", issue="LED driver failure", source="Night patrol",
         ago=45.0, started_ago=8.3, crew="J1 · Imran S."),
    dict(poles=ring("IC", [14]), status="In Progress", category="not_working", issue="Water ingress in luminaire",
         source="CCMS auto-alert", ago=44.0, started_ago=9.0, crew="P1 · Ramesh K."),
    # Horticulture: the lamp works, a tree blocks it; the pole status does not change.
    dict(poles=ring("MC", [11]), status="In Progress", category="blocked", issue="Light blocked by tree canopy",
         source="Citizen app", ago=70.0, started_ago=6.0, crew="HT-1 · Tree pruning", complaints=1,
         notes="Horticulture team pruning; luminaire to be re-aimed."),
    # Repaired this afternoon, waiting for the after-dusk check (pole stays Under Maintenance until then)
    dict(poles=ring("IC", [3]), status="Awaiting dusk check", category="not_working", issue="Loose connection in junction box",
         source="CCMS auto-alert", ago=21.0, started_ago=6.0, closed_ago=2.5, crew="P2 · Sunil T.",
         resolution="Re-terminated cables, replaced connector"),
    dict(poles=ring("MC", [29]), status="Awaiting dusk check", category="not_working", issue="Loose connection in junction box",
         source="Night patrol", ago=23.5, started_ago=4.0, closed_ago=2.0, crew="J2 · Harpreet S.",
         resolution="Re-terminated cables, replaced connector"),
    # Report confidence: the pole's CCMS node reported the lamp on at its last switch-on time, so this citizen
    # report needs a check. The pole keeps its status until then. (Raised last, so earlier ticket IDs stay put.)
    dict(poles=ring("OC", [15]), status="Open", category="not_working", issue="Light not working", source="Citizen app",
         ago=0.5, complaints=1, keep_status=True),
]
# A citizen ticket at a spot with no mapped pole (Palika Park walkway): bearing, radius from the centre.
LOCATION_TICKETS = [
    dict(bearing=200.0, radius=222.0, status="Open", category="not_working", issue="Walkway lights out, Palika Park",
         source="Citizen app", ago=5.0, complaints=1),
]
# Working lights with a stuck timer/photocell: lit, but burning through the day as well.
# Nobody has reported them - the energy layer is how they get found.
DAY_BURNERS = {("OC", 44): 56, ("MC", 27): 40}  # -> days since day-burning started

# Planned power shutdowns per panel: (start, end) in hours relative to --as-of, circuits, reason.
PLANNED_SHUTDOWNS = {
    "FP-CP-05": [dict(start=-1.0, end=3.0, circuits=["C1", "C2"], reason="Feeder pillar replacement")],
    "FP-CP-02": [dict(start=-61 * 24 + 4.0, end=-61 * 24 + 8.0, circuits=["C1", "C2"], reason="Cable jointing")],
}
# Temporary connections on street-light panels (festive lights, stalls): kW, days relative to --as-of.
TEMP_CONNECTIONS = {
    "FP-CP-07": [dict(purpose="Festive decorative lighting, Janpath market", kw=5.6, start=-3, end=26)],
    "FP-CP-08": [dict(purpose="Temporary puja pandal supply", kw=3.6, start=-1, end=9)],
    "FP-CP-02": [dict(purpose="Food stalls, Palika Park", kw=1.2, start=-2, end=12)],
}
# Metered energy above the lamps' own consumption: (first month index 0-5, extra share).
METER_GAPS = {"FP-CP-03": (3, 0.15), "FP-CP-06": (0, 0.11)}

# Approximate planning layers (synthetic; positions from the fitted road geometry).
LANDMARKS = (
    [("metro_exit", name.replace("Rajiv Chowk Metro Gate", "Rajiv Chowk metro exit"), b, 140.0) for name, b in METRO_GATES]
    + [("bus_stop", "Bus stop · Janpath", 186.0, None), ("bus_stop", "Bus stop · Barakhamba Road", 120.5, None),
       ("bus_stop", "Bus stop · M-Block", 88.0, None), ("bus_stop", "Bus stop · Baba Kharak Singh Marg", 250.0, None),
       ("bus_stop", "Bus stop · Chelmsford Road", 330.5, None)]
    + [("subway", "Subway · Janpath", 181.5, -6.0), ("subway", "Subway · Barakhamba Road", 116.5, -6.0),
       ("subway", "Subway · Panchkuian Road", 300.5, -6.0)]
    + [("crossing", "Crossing · Radial Road 1", 185.0, 126.0), ("crossing", "Crossing · Radial Road 3", 302.7, 126.0),
       ("crossing", "Crossing · Radial Road 5", 32.0, 126.0), ("crossing", "Crossing · Sansad Marg", 218.8, 0.0),
       ("crossing", "Crossing · State Entry Road", 2.8, 0.0), ("crossing", "Crossing · Kasturba Gandhi Marg", 158.6, 0.0)]
    + [("atm", "ATM · A-Block", 272.5, 182.0), ("atm", "ATM · D-Block", 47.5, 196.0),
       ("atm", "ATM · F-Block", 151.0, 180.0), ("atm", "ATM · H-Block", 334.5, 250.0)]
    + [("parking", "Parking · Palika Bazaar", 206.0, 160.0), ("parking", "Parking · M-Block", 95.0, 262.0),
       ("parking", "Parking · G-Block", 268.0, 262.0)]
)  # radius None = bus bay outside the Outer Circle; a negative/zero radius is an offset from the Outer Circle
WATERLOGGING = [
    dict(id="WL-01", name="Outer Circle near Janpath", bearing=186.0, radius=332.0, radius_m=45),
    dict(id="WL-02", name="Middle Circle near F-Block", bearing=150.0, radius=236.0, radius_m=40),
    dict(id="WL-03", name="Inner Circle near metro exit 7", bearing=249.0, radius=124.0, radius_m=35),
]
PERMITS = [  # line along a road edge: (from bearing, to bearing, radius or None for "Outer Circle + 9 m")
    dict(id="EXC-01", agency="City Water Utility", purpose="Water main replacement", start=-6, end=9,
         bearings=(194.0, 214.0), radius=None, offset=9.0),
    dict(id="EXC-02", agency="FibreLink Networks", purpose="Telecom duct laying", start=-40, end=-12,
         bearings=(55.0, 80.0), radius=240.0, offset=0.0),
    dict(id="EXC-03", agency="Urban Gas Distribution", purpose="Gas pipeline", start=4, end=20,
         bearings=(260.0, 280.0), radius=131.0, offset=0.0),
]
# Simulated reporters: an ID and a track record (past reports, and how many were confirmed on site). No names.
REPORTERS = [
    dict(id="RP-2001", past_reports=2, past_confirmed=2, mine=True),  # this device: the Citizen view's reporter
    dict(id="RP-1001", past_reports=14, past_confirmed=13),           # strong track record
    dict(id="RP-1002", past_reports=0, past_confirmed=0),             # first-time reporter
    dict(id="RP-1003", past_reports=5, past_confirmed=4),
    dict(id="RP-1004", past_reports=3, past_confirmed=3),
    dict(id="RP-1005", past_reports=6, past_confirmed=2),
    dict(id="RP-1006", past_reports=0, past_confirmed=0),             # first-time reporter
    dict(id="RP-3001", past_reports=1, past_confirmed=1),             # call-centre callers, known by their mobile
    dict(id="RP-3002", past_reports=0, past_confirmed=0),
    dict(id="RP-3003", past_reports=0, past_confirmed=0),
    dict(id="RP-3004", past_reports=4, past_confirmed=4),
    dict(id="RP-3005", past_reports=0, past_confirmed=0),
]
# Every citizen and call-centre complaint behind the live tickets (simulated). `after` = hours after the ticket was
# raised; photo = (live | upload, perceptual hash); device = "Use my location" fix as (metres, bearing from the pole,
# accuracy in metres). A report on a closed ticket uses `history`. Ticket complaint counts equal these records.
PHOTO_REUSED = "9c3e6a1f0b8d4e27"  # the same picture on two reports (MC-019, then MC-020): the later one is flagged
CITIZEN_REPORTS = [
    # Confirmed by CCMS: IC-010's node reported the lamp off at its last switch-on time.
    dict(id="CR-S01", reporter="RP-2001", pole=("IC", 9), after=0.0, source="Citizen app"),
    dict(id="CR-D01", reporter="RP-1001", pole=("IC", 9), after=20.0, source="Citizen app",
         photo=("live", "e4b1c07a9d2f5836"), device=(14, 60, 9)),
    dict(id="CR-S02", reporter="RP-2001", pole=("IC", 6), history=True, source="Citizen app"),  # fixed yesterday
    # Three independent reporters on the dark Outer Circle stretch.
    dict(id="CR-D02", reporter="RP-1003", pole=("OC", 31), after=1.5, source="Citizen app", device=(1400, 200, 20)),
    dict(id="CR-D03", reporter="RP-1001", pole=("OC", 33), after=5.0, source="Citizen app", photo=("live", "71d0e8b3c5a6f249")),
    dict(id="CR-D04", reporter="RP-3001", pole=("OC", 30), after=22.0, source="Call centre"),
    # Lost phases on the Middle Circle.
    dict(id="CR-D05", reporter="RP-1004", pole=("MC", 5), after=0.0, source="Citizen app"),
    dict(id="CR-D06", reporter="RP-3002", pole=("MC", 4), after=0.0, source="Call centre"),
    # Safety emergencies: never scored, always dispatched.
    dict(id="CR-D07", reporter="RP-1005", pole=("IC", 21), after=2.0, source="Citizen app", photo=("upload", "2f6a9d40e1c7b583")),
    dict(id="CR-D08", reporter="RP-3003", pole=("OC", 13), after=0.0, source="Call centre"),
    # Flickering lamp, open past its SLA: your report can be shared publicly.
    dict(id="CR-S03", reporter="RP-2001", pole=("OC", 45), after=0.0, source="Citizen app"),
    dict(id="CR-D09", reporter="RP-1002", pole=("OC", 45), after=26.0, source="Citizen app"),
    dict(id="CR-D10", reporter="RP-3004", pole=("OC", 11), after=0.0, source="Call centre"),
    # The same photo on two different poles.
    dict(id="CR-D11", reporter="RP-1003", pole=("MC", 18), after=40.0, source="Citizen app", photo=("live", PHOTO_REUSED)),
    dict(id="CR-D12", reporter="RP-1005", pole=("MC", 19), after=0.0, source="Citizen app", photo=("upload", PHOTO_REUSED)),
    # Physical problems: photos count most here.
    dict(id="CR-D13", reporter="RP-3005", pole=("OC", 52), after=0.0, source="Call centre"),
    dict(id="CR-D14", reporter="RP-1004", pole=("MC", 11), after=0.0, source="Citizen app", photo=("live", "c58e2b7d03a1f964"),
         device=(11, 140, 8)),
    # A spot with no mapped pole (Palika Park walkway).
    dict(id="CR-D15", reporter="RP-1004", location=0, after=0.0, source="Citizen app", photo=("live", "4ad79e15b2c08f63"),
         device=(18, 300, 12)),
    # Contradicted by CCMS (the lamp came on at its last switch-on time): Needs check.
    dict(id="CR-D16", reporter="RP-1006", pole=("OC", 15), after=0.0, source="Citizen app", noticed="last_night"),
]
NIGHT_CATEGORIES = {"not_working", "flickering"}  # lamp faults you can only see after dark

ISSUES = {
    "LED": [("LED driver failure", "Replaced LED driver", (2600, 4200)),
            ("Surge protection device failure", "Replaced 10 kV surge protection device", (650, 950)),
            ("Water ingress in luminaire", "Resealed luminaire, replaced gasket", (900, 1500)),
            ("Loose connection in junction box", "Re-terminated cables, replaced connector", (300, 600)),
            ("Flickering", "Replaced LED driver and module connector", (2800, 4400))],
    "HPS": [("Lamp burnt out", "Replaced 250 W HPS lamp", (900, 1400)),
            ("Ignitor failure", "Replaced ignitor", (450, 700)),
            ("Ballast failure", "Replaced ballast", (1600, 2200)),
            ("Capacitor failure", "Replaced power-factor capacitor", (250, 450)),
            ("Lamp cycling on/off", "Replaced end-of-life HPS lamp", (900, 1400))],
    "Metal Halide": [("Lamp burnt out", "Replaced 250 W MH lamp", (1500, 2200)),
                     ("Ballast failure", "Replaced MH ballast", (2200, 3000))],
    "ANY": [("Underground cable fault", "Located fault, jointed cable (heat-shrink kit)", (3500, 6500)),
            ("MCB tripped at feeder pillar", "Reset MCB, insulation-resistance test of circuit", (200, 400)),
            ("Pole damaged by vehicle", "Replaced pole, re-grouted foundation", (18000, 26000)),
            ("Timer/photocell fault (day burning)", "Replaced timer contactor", (1200, 1900)),
            ("Cable theft", "Replaced stolen cable, secured junction box", (4500, 8000))],
}
MAJOR_ISSUES = {"Underground cable fault", "Pole damaged by vehicle", "Cable theft"}
HISTORY_SLA_HOURS = {"High": 24, "Medium": 48, "Low": 72}  # targets recorded on past tickets


# ---------------------------------------------------------------------------
# 5. Helpers
# ---------------------------------------------------------------------------
def iso(t: datetime) -> str:
    return t.astimezone(IST).isoformat(timespec="minutes")


def night_time(rng: random.Random, day: datetime) -> datetime:
    hour = rng.choice([19, 20, 21, 22, 23, 5, 6])
    return day.replace(hour=hour, minute=rng.randrange(0, 60), second=0, microsecond=0)


def random_day(rng: random.Random, start: datetime, end: datetime) -> datetime:
    span = max(1, int((end - start).total_seconds() // 86400))
    return start + timedelta(days=rng.randrange(span))


def months_before(as_of: datetime, n: int) -> list[tuple[int, int]]:
    y, m = as_of.year, as_of.month
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append((y, m))
    return list(reversed(out))


def month_bounds(y: int, m: int) -> tuple[datetime, datetime]:
    start = datetime(y, m, 1, tzinfo=IST)
    end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=IST)
    return start, end


def fixture_spec(road: str, idx: int, panel_id: str, bearing: float, rng: random.Random) -> dict:
    """Pole and luminaire. `make` names are fictional; warranty years are example values."""
    if road == "IC":
        spec = dict(pole_type="Heritage cast-iron (decorative)", pole_height_m=6, arm_count=1,
                    fixture_type="LED", wattage=60, cct_k=3000, ccms_node=True,
                    install_date="2010-08-%02d" % rng.randint(2, 28),
                    fixture_installed=f"2023-0{rng.randint(2, 4)}-{rng.randint(1, 28):02d}", retrofit="heritage",
                    fixture_make="Lumetra", fixture_batch="LUM-2302")
    elif road == "MC":
        at_junction = nearest(RADIAL_ROADS, bearing, 4.0) is not None
        weak = idx in WEAK_BATCH_MC
        spec = dict(pole_type="Swaged tubular GI", pole_height_m=7, arm_count=1,
                    fixture_type="LED", wattage=60 if at_junction else 45, cct_k=4000, ccms_node=False,
                    install_date="2010-09-%02d" % rng.randint(2, 28),
                    fixture_installed=f"2022-0{3 if weak else 6}-{rng.randint(1, 28):02d}", retrofit=None,
                    fixture_make="Arcbeam", fixture_batch=WEAK_BATCH if weak else "ARB-2206")
    elif road == "R1":
        spec = dict(pole_type="Swaged tubular GI", pole_height_m=7, arm_count=1,
                    fixture_type="LED", wattage=45, cct_k=4000, ccms_node=True,
                    install_date="2024-03-%02d" % rng.randint(2, 28),
                    fixture_installed="2024-03-%02d" % rng.randint(2, 28), retrofit=None,
                    fixture_make="Arcbeam", fixture_batch="ARB-2403")
    elif idx in JUNCTION_MASTS:
        spec = dict(pole_type="Junction mast (GI)", pole_height_m=12, arm_count=2,
                    fixture_type="Metal Halide", wattage=250, cct_k=4200, ccms_node=True,
                    install_date="2010-07-%02d" % rng.randint(2, 28),
                    fixture_installed=f"2016-1{rng.randint(0, 2)}-{rng.randint(1, 28):02d}", retrofit=None,
                    fixture_make="Metalux", fixture_batch="MTX-1611")
    elif panel_id == LEGACY_HPS_PANEL:
        year = rng.randint(2013, 2015)
        spec = dict(pole_type="Octagonal GI", pole_height_m=9, arm_count=1,
                    fixture_type="HPS", wattage=250, cct_k=2000, ccms_node=False,
                    install_date="2010-07-%02d" % rng.randint(2, 28),
                    fixture_installed=f"{year}-0{rng.randint(1, 9)}-{rng.randint(1, 28):02d}", retrofit=None,
                    fixture_make="Sodiac", fixture_batch=f"SOD-{year}")
    else:
        year, month = rng.choice([(2023, rng.randint(7, 12)), (2024, rng.randint(1, 2))])
        spec = dict(pole_type="Octagonal GI", pole_height_m=9, arm_count=1,
                    fixture_type="LED", wattage=120, cct_k=4000, ccms_node=True,
                    install_date="2010-07-%02d" % rng.randint(2, 28),
                    fixture_installed=f"{year}-{month:02d}-{rng.randint(1, 28):02d}", retrofit="phase1",
                    fixture_make="Lumetra", fixture_batch="LUM-2307" if year == 2023 else "LUM-2401")
    spec["fixture_warranty_years"] = WARRANTY_YEARS_EXAMPLE[spec["fixture_type"]]
    return spec


# ---------------------------------------------------------------------------
# 6. Build
# ---------------------------------------------------------------------------
def build(as_of: datetime) -> dict:
    rng = random.Random(SEED)
    window_start = as_of - timedelta(days=int(3.75 * 365))
    window_end = as_of - timedelta(days=12)
    energy_months = months_before(as_of, 6)
    at = lambda h: as_of + timedelta(hours=h)  # noqa: E731  hours relative to the snapshot

    # --- wire every pole to its panel / circuit -------------------------------------------
    positions = pole_positions()
    wiring = {}  # (road, idx) -> (panel_id, circuit, seq)
    for p in PANELS:
        for circuit, keys in p["circuits"].items():
            for seq, key in enumerate(keys, start=1):
                assert key not in wiring, f"{key} wired twice"
                wiring[key] = (p["id"], circuit, seq)
    for road, items in positions.items():
        missing = [i for i in range(len(items)) if (road, i) not in wiring]
        assert not missing, f"{road} poles not wired: {missing}"

    # --- planning layers first: poles use them (waterlogging -> junction boxes) -----------------
    waterlogging = []
    for w in WATERLOGGING:
        lat, lng = destination(w["bearing"], w["radius"])
        waterlogging.append(dict(w, lat=lat, lng=lng))

    def near_water(lat: float, lng: float) -> bool:
        for w in waterlogging:
            dy = (lat - w["lat"]) * M_PER_DEG_LAT
            dx = (lng - w["lng"]) * M_PER_DEG_LNG
            if math.hypot(dx, dy) <= w["radius_m"] + 15:
                return True
        return False

    poles = []
    for road, items in positions.items():
        for idx, it in enumerate(items):
            panel_id, circuit, seq = wiring[(road, idx)]
            fx = fixture_spec(road, idx, panel_id, it["bearing"], rng)
            poles.append(dict(key=(road, idx), road=road, idx=idx, bearing=it["bearing"], lat=it["lat"], lng=it["lng"],
                              panel_id=panel_id, circuit=circuit, seq=seq, fx=fx,
                              contractor=CONTRACTORS[ROADS[road]["contractor"]], events=[],
                              wet=near_water(it["lat"], it["lng"])))
    by_key = {p["key"]: p for p in poles}

    # --- repair history ----------------------------------------------------------------------
    all_tickets = []  # every ticket (history + live) for chronological ID assignment

    def add_event(pole, **e):
        pole["events"].append(e)

    for pole in poles:
        fx, ctr = pole["fx"], pole["contractor"]
        fitted = datetime.fromisoformat(fx["fixture_installed"]).replace(tzinfo=IST)
        if fx["retrofit"] and window_start < fitted < window_end:
            before = "CFL 2x36 W heritage lantern" if fx["retrofit"] == "heritage" else "HPS 250 W"
            when = fitted.replace(hour=rng.randint(10, 15), minute=rng.randrange(60))
            hrs = round(rng.uniform(2.5, 5.0), 1)
            add_event(pole, type="Retrofit", issue=f"LED retrofit ({before} → LED {fx['wattage']} W)",
                      action="Replaced luminaire with LED; CCMS node fitted", source="Scheduled (retrofit programme)",
                      raised=when, resolved=when + timedelta(hours=hrs), downtime_h=hrs, priority="Low",
                      crew=rng.choice(ctr["crews"]), contractor=ctr["name"],
                      cost_inr=rng.randint(7200, 8400) if fx["retrofit"] == "heritage" else rng.randint(9800, 11500))
        weights = {"LED": [0, 0, 0, 0, 0, 1, 1, 1, 2], "HPS": [1, 2, 2, 3, 3, 3, 4, 4],
                   "Metal Halide": [2, 2, 3]}[fx["fixture_type"]]
        first_ok = max(window_start, fitted + timedelta(days=30))
        for _ in range(rng.choice(weights)):
            if rng.random() < 0.78:
                issue, action, cost = rng.choice(ISSUES[fx["fixture_type"]])
            else:
                issue, action, cost = rng.choice(ISSUES["ANY"])
            major = issue in MAJOR_ISSUES
            raised = night_time(rng, random_day(rng, first_ok, window_end))
            downtime = round(rng.uniform(30, 110) if major else rng.choice(
                [5.5, 8, 11, 14, 17, 20, 26, 31, 38, 44, 52, 63, 79]) + rng.uniform(0, 3), 1)
            priority = "High" if major else ("Low" if "day burning" in issue else "Medium")
            sources = ["CCMS auto-alert", "CCMS auto-alert", "Night patrol", "Citizen app", "Call centre"] \
                if fx["ccms_node"] else ["Night patrol", "Night patrol", "Citizen app", "Call centre"]
            add_event(pole, type="Corrective", issue=issue, action=action, source=rng.choice(sources),
                      raised=raised, resolved=raised + timedelta(hours=downtime), downtime_h=downtime,
                      priority=priority, crew=rng.choice(ctr["crews"]), contractor=ctr["name"],
                      cost_inr=rng.randint(*cost))
        for _ in range(rng.choice([0, 1, 1, 2])):
            day = random_day(rng, max(window_start, fitted), window_end)
            when = day.replace(hour=rng.randint(10, 15), minute=rng.randrange(60))
            hrs = round(rng.uniform(0.8, 2.0), 1)
            add_event(pole, type="Preventive", issue="Annual preventive maintenance",
                      action="Cleaned luminaire, IR & earth-resistance test, tightened terminations",
                      source="Scheduled (AMC)", raised=when, resolved=when + timedelta(hours=hrs),
                      downtime_h=hrs, priority="Low", crew=rng.choice(ctr["crews"]),
                      contractor=ctr["name"], cost_inr=rng.randint(350, 450))

    def seeded_failure(key, days_ago, hour, issue, action, cost, downtime, source="Night patrol"):
        pole = by_key[key]
        ctr = pole["contractor"]
        raised = (as_of - timedelta(days=days_ago)).replace(hour=hour, minute=rng.randrange(60), second=0, microsecond=0)
        add_event(pole, type="Corrective", issue=issue, action=action, source=source, raised=raised,
                  resolved=raised + timedelta(hours=downtime), downtime_h=downtime, priority="Medium",
                  crew=rng.choice(ctr["crews"]), contractor=ctr["name"], cost_inr=cost)

    # Weak driver batch: extra driver failures on Middle Circle poles fitted from ARB-2203.
    for j, days in [(15, 410), (15, 760), (16, 220), (16, 590), (17, 300), (18, 640), (19, 520), (20, 380),
                    (21, 700), (22, 260), (22, 830), (23, 150), (23, 470), (24, 480), (25, 90), (25, 610)]:
        seeded_failure(("MC", j), days, 21, "LED driver failure", "Replaced LED driver", 3300, 26.5)
    # Chronic pole beside a waterlogging spot: the lamp keeps failing because water gets in.
    for days, downtime in [(300, 31.0), (170, 22.5), (60, 38.0)]:
        seeded_failure(("MC", 30), days, 22, "Water ingress in luminaire", "Resealed luminaire, replaced gasket", 1200, downtime)
    # Repeat failure: an HPS lamp fails again 18 days after it was fixed.
    seeded_failure(("OC", 43), 50, 21, "Lamp burnt out", "Replaced 250 W HPS lamp", 1150, 26.0)
    seeded_failure(("OC", 43), 30, 20, "Ignitor failure", "Replaced ignitor", 560, 15.0)
    # Fixed yesterday after a citizen report (the sample report in My reports asks "Fixed?")
    pole = by_key[("IC", 6)]
    raised = as_of - timedelta(hours=50)
    add_event(pole, type="Corrective", issue="Lamp not glowing", action="Replaced LED driver", source="Citizen app",
              raised=raised, resolved=as_of - timedelta(hours=26), downtime_h=24.0, priority="Medium",
              crew=pole["contractor"]["crews"][0], contractor=pole["contractor"]["name"], cost_inr=3400,
              verified_at=as_of - timedelta(hours=23, minutes=50), verified_by="CCMS", citizen_sample="CR-S02")
    # "Different pole": the most recent past citizen report on the Middle Circle named the pole next door; the crew
    # found and fixed the fault on this pole. Marks an existing event, so IDs and random draws are unchanged.
    corrections = sorted(((e, pole) for pole in poles if pole["road"] == "MC" and pole["idx"] > 0 for e in pole["events"]
                          if e["type"] == "Corrective" and e["source"] == "Citizen app"), key=lambda x: x[0]["raised"])
    if corrections:
        event, pole = corrections[-1]
        event["outcome"] = "different_pole"
        event["reported_key"] = ("MC", pole["idx"] - 1)
    for pole in poles:
        all_tickets.extend(pole["events"])

    # --- live tickets (one ticket can cover several poles) -------------------------------------
    live_tickets = []
    for spec in LIVE_TICKETS:
        first = by_key[spec["poles"][0]]
        ticket = dict(type="Corrective", status=spec["status"], category=spec["category"], issue=spec["issue"],
                      source=spec["source"], raised=at(-spec["ago"]), complaints=spec.get("complaints", 0),
                      notes=spec.get("notes"), crew=spec.get("crew"),
                      started=at(-spec["started_ago"]) if "started_ago" in spec else None,
                      closed=at(-spec["closed_ago"]) if "closed_ago" in spec else None,
                      resolution=spec.get("resolution"), pole_keys=spec["poles"], contractor=first["contractor"]["name"],
                      keep_status=spec.get("keep_status", False),
                      public=dict(shared_at=at(-spec["public_ago"]), report_id=spec["public_report"]) if "public_ago" in spec else None)
        live_tickets.append(ticket)
        all_tickets.append(ticket)
    live_by_pole = {}
    for t in live_tickets:
        for key in t["pole_keys"]:
            assert key not in live_by_pole, f"{key} has two live tickets"
            live_by_pole[key] = t
    location_tickets = []
    for spec in LOCATION_TICKETS:
        ticket = dict(type="Corrective", status=spec["status"], category=spec["category"], issue=spec["issue"],
                      source=spec["source"], raised=at(-spec["ago"]), complaints=spec.get("complaints", 0),
                      lat_lng=destination(spec["bearing"], spec["radius"]))
        location_tickets.append(ticket)
        all_tickets.append(ticket)

    # --- ticket numbers: TKT-<year>-<seq>, chronological per year ------------------------------
    counters = {}
    for t in sorted(all_tickets, key=lambda e: e["raised"]):
        year = t["raised"].year
        counters[year] = counters.get(year, 100) + 1
        t["ticket_id"] = f"TKT-{year}-{counters[year]:04d}"

    # --- shutdowns, temporary connections ------------------------------------------------------
    shutdowns = {pid: [dict(s, start_t=at(s["start"]), end_t=at(s["end"])) for s in items]
                 for pid, items in PLANNED_SHUTDOWNS.items()}

    # --- energy and lit hours: last 6 complete months ----------------------------------------------
    nights_by_month = {ym: month_nights(*ym) for ym in energy_months}

    def monthly(pole) -> list[dict]:
        fx = pole["fx"]
        kw = fx["wattage"] * fx["arm_count"] * SYSTEM_LOSS[fx["fixture_type"]] / 1000
        live = live_by_pole.get(pole["key"])
        burn_since = DAY_BURNERS.get(pole["key"])
        planned = [s for s in shutdowns.get(pole["panel_id"], []) if pole["circuit"] in s["circuits"]]
        series = []
        for (y, m) in energy_months:
            m0, m1 = month_bounds(y, m)
            nights = nights_by_month[(y, m)]
            # Planned shutdowns are not scheduled burning time, so they never count against uptime.
            scheduled = sum(hours(a, b) for a, b in nights) - sum(night_overlap(s["start_t"], s["end_t"], nights) for s in planned)
            outage = sum(night_overlap(e["raised"], e["resolved"], nights) for e in pole["events"] if e["type"] == "Corrective")
            if live and live["category"] != "blocked" and not live["keep_status"]:  # fault already under way that month
                outage += night_overlap(live["raised"], live["closed"] or as_of, nights)
            lit = max(0.0, scheduled - outage)
            day_burn = 0.0
            if burn_since is not None:  # stuck timer: also burning through daylight
                start = as_of - timedelta(days=burn_since)
                day_burn = overlap_hours(start, as_of, m0, m1) - night_overlap(start, as_of, nights)
            kwh = kw * (lit + day_burn) * rng.uniform(0.975, 1.025)
            series.append({"month": f"{y}-{m:02d}", "kwh": round(kwh, 1),
                           "scheduled_h": round(scheduled, 1), "lit_h": round(lit, 1)})
        return series

    # --- earthing and junction boxes -----------------------------------------------------------------
    def earthing(pole) -> str:
        """Last earth-resistance test. Every annual PM visit includes one, so it is never older than the
        latest PM; poles near waterlogging spots are more often overdue."""
        pm = max((e["resolved"] for e in pole["events"] if e["type"] == "Preventive"), default=None)
        if pm and pm > as_of - timedelta(days=365):
            return pm.date().isoformat()
        overdue = rng.random() < (0.6 if pole["wet"] else 0.22)
        months = rng.uniform(13, 30) if overdue else rng.uniform(1, 11)
        test = as_of - timedelta(days=round(30.4 * months))
        return max(test, pm).date().isoformat() if pm else test.date().isoformat()

    def junction_box(pole) -> str:
        weights = [30, 40, 30] if pole["wet"] else [68, 24, 8]
        return rng.choices(["Good", "Fair", "Poor"], weights=weights)[0]

    # --- features --------------------------------------------------------------------------------
    def uid_of(key) -> str:
        return f"SL-CP-{key[0]}-{key[1] + 1:03d}"

    sunrise_today, sunset_today = sun_times(as_of.date())
    switch_on = sunset_today if sunset_today <= as_of else sun_times((as_of - timedelta(days=1)).date())[1]

    def ccms_reading(pole, live, status):
        """What the pole's CCMS node reported at the last scheduled switch-on time (simulated)."""
        if not pole["fx"]["ccms_node"]:
            return None
        held = any(s["start_t"] <= switch_on < s["end_t"] for s in shutdowns.get(pole["panel_id"], [])
                   if pole["circuit"] in s["circuits"])
        if held:
            state = "off"  # no supply: planned shutdown
        elif not live or live["raised"] > switch_on or live["keep_status"] or live["category"] == "blocked":
            state = "on"
        elif status == "Under Maintenance" and live["closed"] and live["closed"] <= switch_on:
            state = "on"   # repaired before dusk
        else:
            state = "abnormal" if live["category"] == "flickering" else "off"
        return {"switch_on_at": iso(switch_on), "state": state, "daylight": "off"}

    features = []
    for pole in poles:
        fx, road = pole["fx"], pole["road"]
        live = live_by_pole.get(pole["key"])
        status = "Functional"
        ticket = None
        if live:
            if live["category"] == "blocked" or live["keep_status"]:
                status = "Functional"  # the lamp works (a tree blocks it), or the report still needs a check
            elif live["status"] == "Open":
                status = "Faulty"
            else:
                status = "Under Maintenance"  # in progress, or repaired and awaiting the dusk check
            ticket = {
                "id": live["ticket_id"], "status": live["status"], "category": live["category"],
                "issue": live["issue"], "source": live["source"], "raised_at": iso(live["raised"]),
                "assigned_crew": live["crew"], "work_started_at": iso(live["started"]) if live["started"] else None,
                "closed_at": iso(live["closed"]) if live["closed"] else None, "resolution": live["resolution"],
                "complaints": live["complaints"], "notes": live["notes"],
                "pole_uids": [uid_of(k) for k in live["pole_keys"]],
                "public": {"shared_at": iso(live["public"]["shared_at"]), "report_id": live["public"]["report_id"]}
                if live["public"] else None,
            }
        history = []
        for e in sorted(pole["events"], key=lambda e: e["raised"], reverse=True):
            item = {
                "ticket_id": e["ticket_id"], "type": e["type"], "issue": e["issue"], "action": e["action"],
                "source": e["source"], "priority": e["priority"], "raised_at": iso(e["raised"]),
                "resolved_at": iso(e["resolved"]), "downtime_h": e["downtime_h"],
                "sla_met": e["downtime_h"] <= HISTORY_SLA_HOURS[e["priority"]] if e["type"] == "Corrective" else True,
                "crew": e["crew"], "contractor": e["contractor"], "cost_inr": e["cost_inr"], "status": "Closed",
            }
            if e.get("verified_at"):
                item["verified_at"] = iso(e["verified_at"])
                item["verified_by"] = e["verified_by"]
            if e.get("outcome"):
                item["outcome"] = e["outcome"]
                item["reported_uid"] = uid_of(e["reported_key"])
            history.append(item)
        series = monthly(pole)
        recent = [datetime.fromisoformat(h["resolved_at"]) for h in history]
        patrol = as_of - timedelta(days=rng.randint(3, 75), hours=rng.randint(0, 12))
        last_inspected = max(recent + [patrol]).date().isoformat()
        uid = uid_of(pole["key"])
        features.append({
            "type": "Feature",
            "id": uid,
            "geometry": point_geometry(pole["lat"], pole["lng"]),
            "properties": {
                "uid": uid,
                "status": status,
                "road": ROADS[road]["name"],
                "location": describe_location(road, pole["bearing"], pole["idx"]),
                "pole_type": fx["pole_type"],
                "pole_height_m": fx["pole_height_m"],
                "arm_count": fx["arm_count"],
                "fixture_type": fx["fixture_type"],
                "wattage": fx["wattage"],
                "cct_k": fx["cct_k"],
                "ccms_node": fx["ccms_node"],
                "ccms_reading": ccms_reading(pole, live, status),
                "install_date": fx["install_date"],
                "fixture_installed": fx["fixture_installed"],
                "fixture_make": fx["fixture_make"],
                "fixture_batch": fx["fixture_batch"],
                "fixture_warranty_years": fx["fixture_warranty_years"],
                "last_inspected": last_inspected,
                "last_earthing_check": earthing(pole),
                "junction_box_condition": junction_box(pole),
                "feeder_panel": pole["panel_id"],
                "circuit": pole["circuit"],
                "circuit_seq": pole["seq"],
                "phase": "RYB"[(pole["seq"] - 1) % 3],
                "energy_kwh": series[-1]["kwh"],
                "energy_month": series[-1]["month"],
                "energy_history": series,
                "contractor": {k: v for k, v in pole["contractor"].items() if k != "crews"},
                "ticket": ticket,
                "repair_history": history,
            },
        })

    # --- feeder panels -------------------------------------------------------------------------
    kwh_by_panel_month = {}
    for f in features:
        p = f["properties"]
        for i, row in enumerate(p["energy_history"]):
            kwh_by_panel_month[(p["feeder_panel"], i)] = kwh_by_panel_month.get((p["feeder_panel"], i), 0.0) + row["kwh"]
    panel_features = []
    for p in PANELS:
        radius = p["radius"] or outer_r(p["bearing"]) + 16
        lat, lng = destination(p["bearing"], radius)
        gap = METER_GAPS.get(p["id"])
        metered = []
        for i, (y, m) in enumerate(energy_months):
            loss = rng.uniform(0.015, 0.03)  # cable losses between meter and lamps
            extra = gap[1] if gap and i >= gap[0] else 0.0
            metered.append({"month": f"{y}-{m:02d}", "kwh": round(kwh_by_panel_month[(p["id"], i)] * (1 + loss + extra), 1)})
        panel_features.append({
            "type": "Feature",
            "id": p["id"],
            "geometry": point_geometry(lat, lng),
            "properties": {
                "panel_id": p["id"], "name": p["name"], "road": ROADS[p["road"]]["name"], "location": p["where"],
                "source_dt": p["source_dt"], "capacity_kva": p["kva"], "controller": p["controller"],
                "commissioned": p["commissioned"], "circuits": list(p["circuits"]),
                "contractor_id": ROADS[p["road"]]["contractor"],
                "metered_kwh_history": metered,
                "temp_connections": [{"purpose": c["purpose"], "kw": c["kw"], "from": iso(at(24 * c["start"])),
                                      "to": iso(at(24 * c["end"]))} for c in TEMP_CONNECTIONS.get(p["id"], [])],
                "planned_shutdowns": [{"start": iso(s["start_t"]), "end": iso(s["end_t"]), "circuits": s["circuits"],
                                       "reason": s["reason"]} for s in shutdowns.get(p["id"], [])],
            },
        })

    # --- planning layers (synthetic, approximate) -------------------------------------------------
    landmark_features = []
    counts = {}
    codes = {"metro_exit": "MX", "bus_stop": "BS", "subway": "SW", "crossing": "PX", "atm": "ATM", "parking": "PK"}
    for kind, name, bearing, radius in LANDMARKS:
        if radius is None:
            radius = outer_r(bearing) + 16      # bus bay outside the Outer Circle
        elif radius <= 0:
            radius = outer_r(bearing) - radius  # offset from the Outer Circle centreline
        counts[kind] = counts.get(kind, 0) + 1
        lid = f"LM-{codes[kind]}-{counts[kind]:02d}"
        landmark_features.append({"type": "Feature", "id": lid, "geometry": polar_point(bearing, radius),
                                  "properties": {"landmark_id": lid, "kind": kind, "name": name, "approximate": True}})
    permit_features = []
    for pm in PERMITS:
        b0, b1 = pm["bearings"]
        coords = []
        steps = max(2, int(abs(b1 - b0) / 2.5) + 1)
        for s in range(steps):
            b = b0 + (b1 - b0) * s / (steps - 1)
            r = pm["radius"] if pm["radius"] is not None else outer_r(b) + pm["offset"]
            coords.append(position(*destination(b, r)))
        permit_features.append({"type": "Feature", "id": pm["id"], "geometry": {"type": "LineString", "coordinates": coords},
                                "properties": {"permit_id": pm["id"], "agency": pm["agency"], "purpose": pm["purpose"],
                                               "start": iso(at(24 * pm["start"])), "end": iso(at(24 * pm["end"])),
                                               "approximate": True}})
    water_features = [{"type": "Feature", "id": w["id"], "geometry": point_geometry(w["lat"], w["lng"]),
                       "properties": {"spot_id": w["id"], "name": w["name"], "radius_m": w["radius_m"], "approximate": True}}
                      for w in waterlogging]
    location_features = []
    for t in location_tickets:
        lat, lng = t["lat_lng"]
        location_features.append({"type": "Feature", "id": t["ticket_id"], "geometry": point_geometry(lat, lng),
                                  "properties": {"id": t["ticket_id"], "status": t["status"], "category": t["category"],
                                                 "issue": t["issue"], "source": t["source"], "raised_at": iso(t["raised"]),
                                                 "complaints": t["complaints"]}})

    # --- citizen reports and reporters (simulated) ---------------------------------------------------
    def is_night(t: datetime) -> bool:
        rise, sset = sun_times(t.date())
        return t < rise or t >= sset

    mine_ids = {r["id"] for r in REPORTERS if r.get("mine")}
    reports = []
    for r in CITIZEN_REPORTS:
        if "location" in r:
            ticket = location_tickets[r["location"]]
            uid, lat, lng = None, *ticket["lat_lng"]
            created = ticket["raised"] + timedelta(hours=r["after"])
        elif r.get("history"):
            ticket = next(e for e in by_key[r["pole"]]["events"] if e.get("citizen_sample") == r["id"])
            uid, lat, lng = uid_of(r["pole"]), by_key[r["pole"]]["lat"], by_key[r["pole"]]["lng"]
            created = ticket["raised"]
        else:
            ticket = live_by_pole[r["pole"]]
            uid, lat, lng = uid_of(r["pole"]), by_key[r["pole"]]["lat"], by_key[r["pole"]]["lng"]
            created = ticket["raised"] + timedelta(hours=r["after"])
        category = ticket.get("category", "not_working")
        noticed = r.get("noticed") or (("just_now" if is_night(created) else "last_night") if category in NIGHT_CATEGORIES else None)
        device = None
        if r.get("device"):
            dist, bearing, accuracy = r["device"]
            b = math.radians(bearing)
            device = {"position": position(lat + dist * math.cos(b) / M_PER_DEG_LAT, lng + dist * math.sin(b) / M_PER_DEG_LNG),
                      "accuracy_m": accuracy}
        reports.append({
            "id": r["id"], "reporter_id": r["reporter"], "ticket_id": ticket["ticket_id"], "uid": uid,
            "spot": position(lat, lng) if uid is None else None, "category": category, "source": r["source"],
            "created_at": iso(created), "noticed": noticed,
            "photo": {"kind": r["photo"][0], "hash": r["photo"][1]} if r.get("photo") else None,
            "device_location": device, "mine": r["reporter"] in mine_ids, "simulated": True,
        })
    reporters = [{"id": r["id"], "past_reports": r["past_reports"], "past_confirmed": r["past_confirmed"],
                  "mine": bool(r.get("mine")), "simulated": True} for r in REPORTERS]

    # --- pilot zone boundary (exterior ring anticlockwise per RFC 7946 right-hand rule) --------
    ring_coords = [position(*destination(step * 5 % 360, PILOT_ZONE_RADIUS_M)) for step in range(72, -1, -1)]
    zone = {"type": "Feature", "id": "ZONE-CP-PILOT",
            "geometry": {"type": "Polygon", "coordinates": [ring_coords]},
            "properties": {"name": "Connaught Place pilot zone", "authority": "NDMC area",
                           "radius_m": PILOT_ZONE_RADIUS_M}}

    sunrise, sunset = sun_times(as_of.date())
    meta = {
        "title": "Street Light GIS — Connaught Place pilot (NDMC area)",
        "as_of": iso(as_of),
        "energy_month": "%d-%02d" % energy_months[-1],
        "energy_months": ["%d-%02d" % ym for ym in energy_months],
        "crs": "EPSG:4326 (WGS 84). GeoJSON positions are [longitude, latitude].",
        "centre": CENTRE,
        "geometry_source": "Ring centrelines fitted to OpenStreetMap (© OpenStreetMap contributors, ODbL)",
        "attribute_source": "Synthetic mock data for demonstration (seed %d)" % SEED,
        "solar_method": "NOAA general solar position equations, zenith 90.833° (refraction), zone centre",
        "snapshot_sun": {"sunrise": iso(sunrise), "sunset": iso(sunset)},
        "night_hours_by_month": {"%d-%02d" % ym: round(sum(hours(a, b) for a, b in nights_by_month[ym]), 1)
                                 for ym in energy_months},
        "tariff_inr_per_kwh": TARIFF_INR_PER_KWH,
        "energy_model": {"system_loss": SYSTEM_LOSS},
        "contractors": CONTRACTORS,
        "team_crews": TEAM_CREWS,
    }
    return {
        "meta": meta,
        "zone": zone,
        "streetlights": {"type": "FeatureCollection", "name": "streetlights", "features": features},
        "feederPanels": {"type": "FeatureCollection", "name": "feeder_panels", "features": panel_features},
        "landmarks": {"type": "FeatureCollection", "name": "landmarks", "features": landmark_features},
        "excavationPermits": {"type": "FeatureCollection", "name": "excavation_permits", "features": permit_features},
        "waterloggingSpots": {"type": "FeatureCollection", "name": "waterlogging_spots", "features": water_features},
        "locationTickets": {"type": "FeatureCollection", "name": "location_tickets", "features": location_features},
        "reporters": reporters,
        "citizenReports": reports,
    }


FILES = {  # data/<file> <- key in SLGIS_DATA
    "streetlights.geojson": "streetlights",
    "feeder_panels.geojson": "feederPanels",
    "landmarks.geojson": "landmarks",
    "excavation_permits.geojson": "excavationPermits",
    "waterlogging_spots.geojson": "waterloggingSpots",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--as-of", default=DEFAULT_AS_OF, help="snapshot time, IST (YYYY-MM-DDTHH:MM)")
    args = ap.parse_args()
    as_of = datetime.fromisoformat(args.as_of).replace(tzinfo=IST)
    data = build(as_of)

    OUT_DIR.mkdir(exist_ok=True)
    # newline="\n": identical bytes on every OS (Windows would otherwise write CRLF)
    write = lambda name, text: (OUT_DIR / name).write_text(text, encoding="utf-8", newline="\n")  # noqa: E731
    for name, key in FILES.items():
        write(name, json.dumps(data[key], indent=1) + "\n")
    banner = ("/* AUTO-GENERATED by tools/generate_data.py - do not edit by hand.\n"
              " * Mock data for the Street Light GIS MVP (Connaught Place pilot, NDMC area).\n"
              " * GeoJSON positions are [longitude, latitude] (RFC 7946); Leaflet converts them.\n */\n")
    write("streetlights.js", banner + "window.SLGIS_DATA = " + json.dumps(data, indent=1) + ";\n")

    feats = data["streetlights"]["features"]
    counts = {}
    for f in feats:
        counts[f["properties"]["status"]] = counts.get(f["properties"]["status"], 0) + 1
    total_kwh = sum(f["properties"]["energy_kwh"] for f in feats)
    sun = data["meta"]["snapshot_sun"]
    print(f"as of {data['meta']['as_of']} (sunrise {sun['sunrise'][11:16]}, sunset {sun['sunset'][11:16]}): "
          f"{len(feats)} poles {counts}, {len(data['feederPanels']['features'])} panels, "
          f"{total_kwh:,.0f} kWh in {data['meta']['energy_month']}")
    print(f"layers: {len(data['landmarks']['features'])} landmarks, {len(data['excavationPermits']['features'])} permits, "
          f"{len(data['waterloggingSpots']['features'])} waterlogging spots, "
          f"{len(data['locationTickets']['features'])} location ticket(s)")
    moved = [(f["id"], h["reported_uid"]) for f in feats for h in f["properties"]["repair_history"] if h.get("outcome")]
    print(f"reports: {len(data['citizenReports'])} citizen reports from {len(data['reporters'])} reporters; "
          f"different-pole correction: {moved}")
    print(f"wrote {OUT_DIR / 'streetlights.js'}")


if __name__ == "__main__":
    main()
