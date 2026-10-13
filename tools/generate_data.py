#!/usr/bin/env python3
"""
Street Light GIS - mock dataset generator
=========================================

Builds the pilot-zone dataset for Connaught Place (NDMC area), New Delhi:
Inner, Middle and Outer Circle street lights, their feeder pillars (panels),
AMC contractors, live tickets, repair history and monthly energy use.

Geometry is real, attributes are synthetic
------------------------------------------
* Ring centre and radii were fitted to OpenStreetMap road centrelines
  (c) OpenStreetMap contributors, ODbL:
      Inner Circle   R = 125.6 m      (rms 0.7 m, closed loop)
      Middle Circle  R ~ 235 m        (rms 0.5 m, open across Palika Park ~182-243 deg)
      Outer Circle   R ~ 309-325 m    (irregular -> radius profile sampled every 5 deg)
* Blocks, radial roads, approach-road junctions and Rajiv Chowk metro gates are
  placed by their OSM bearings, so location labels match the real place.
* Every attribute (status, tickets, contractors, history, energy) is MOCK data
  generated from a fixed seed, so the output is reproducible.

Outputs (relative to the project root)
--------------------------------------
  data/streetlights.geojson   RFC 7946 FeatureCollection of poles (QGIS / geojson.io)
  data/feeder_panels.geojson  RFC 7946 FeatureCollection of feeder pillars
  data/streetlights.js        all of the above + metadata as `window.SLGIS_DATA`,
                              so index.html runs straight from file:// (no server)

Coordinate order: GeoJSON positions are ALWAYS [longitude, latitude].

Usage
-----
  python tools/generate_data.py                       # snapshot 2026-10-13 18:00 IST
  python tools/generate_data.py --as-of 2026-11-20T18:00
"""
from __future__ import annotations

import argparse
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data"
IST = timezone(timedelta(hours=5, minutes=30))
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


def point_geometry(lat: float, lng: float) -> dict:
    """GeoJSON Point. RFC 7946 order is [longitude, latitude] - never the other way round."""
    assert 28.60 < lat < 28.66 and 77.19 < lng < 77.25, f"({lat}, {lng}) outside pilot zone"
    return {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]}


def profile_radius(profile: dict[int, float], bearing: float) -> float:
    b = bearing % 360
    lo = int(b // 5) * 5
    hi = (lo + 5) % 360
    t = (b - lo) / 5
    return profile[lo] * (1 - t) + profile[hi] * t


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


def describe_location(ring: str, bearing: float) -> str:
    inner, outer = sector_blocks(bearing)
    if ring == "IC":
        text = f"Inner Circle, facing {inner}-Block" if inner else "Inner Circle, Palika Bazaar side"
        road = nearest(RADIAL_ROADS, bearing, 4.5)
        gate = nearest(METRO_GATES, bearing, 6.0)
        if road:
            text += f" · {road} junction"
        elif gate:
            text += f" · near {gate}"
    elif ring == "MC":
        text = f"Middle Circle, between {inner}- & {outer}-Blocks"
        road = nearest(RADIAL_ROADS, bearing, 4.0)
        if road:
            text += f" · {road} junction"
        elif angdiff(bearing, 359.8) <= 4:
            text += " · near PVR Plaza"
    else:
        text = f"Outer Circle, {outer}-Block frontage" if outer else "Outer Circle, Palika Park side"
        road = nearest(APPROACH_ROADS, bearing, 3.3)
        if road:
            text += f" · {road} junction"
        elif angdiff(bearing, 197.5) <= 4:
            text += " · opp. Jeevan Bharti Building"
    return text


# ---------------------------------------------------------------------------
# 2. Network design: rings -> poles -> feeder pillars -> circuits
# ---------------------------------------------------------------------------
RINGS = {
    "IC": {"name": "Inner Circle", "contractor": "CTR-01", "offset_m": -3.0,
           "bearings": [7.5 + 15 * i for i in range(24)]},
    "MC": {"name": "Middle Circle", "contractor": "CTR-02", "offset_m": 0.0,
           "bearings": [(246 + j * 292 / 33) % 360 for j in range(34)]},
    "OC": {"name": "Outer Circle", "contractor": "CTR-03", "offset_m": 3.0,
           "bearings": [3.2143 + k * 360 / 56 for k in range(56)]},
}

# Each pillar sits mid-arc and feeds two radial circuits: C1 runs clockwise, C2 anticlockwise.
# Circuit lists are pole indices in wiring order (seq 1 = nearest the pillar).
PANELS = [
    dict(id="FP-CP-01", ring="IC", name="Central Park North", bearing=0.0, radius=108.0,
         where="Central Park north lawn, opposite Radial Road 4",
         C1=list(range(0, 6)), C2=list(range(23, 17, -1)),
         kva=6, controller="CCMS panel controller (GSM)", commissioned="2010-08-14", source_dt="DT-CP-01 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-02", ring="IC", name="Central Park South", bearing=180.0, radius=108.0,
         where="Central Park south lawn, behind Palika Bazaar Gate 1",
         C1=list(range(12, 18)), C2=list(range(11, 5, -1)),
         kva=6, controller="CCMS panel controller (GSM)", commissioned="2010-08-14", source_dt="DT-CP-01 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-03", ring="MC", name="Middle Circle North-West", bearing=(246 + 8.5 * 292 / 33) % 360, radius=244.0,
         where="Middle Circle footpath between B- and H-Blocks",
         C1=list(range(9, 17)), C2=list(range(8, -1, -1)),
         kva=6, controller="Astronomical timer + contactor", commissioned="2010-09-02", source_dt="DT-CP-02 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-04", ring="MC", name="Middle Circle East", bearing=(246 + 25.5 * 292 / 33) % 360, radius=244.0,
         where="Middle Circle footpath between E- and M-Blocks",
         C1=list(range(26, 34)), C2=list(range(25, 16, -1)),
         kva=6, controller="Astronomical timer + contactor", commissioned="2010-09-02", source_dt="DT-CP-03 (11 kV/433 V, 990 kVA)"),
    dict(id="FP-CP-05", ring="OC", name="Outer Circle North", bearing=0.0, radius=None,
         where="Outer Circle footpath at State Entry Road junction",
         C1=list(range(0, 7)), C2=list(range(55, 48, -1)),
         kva=10, controller="CCMS panel controller (GSM)", commissioned="2010-07-21", source_dt="DT-CP-02 (11 kV/433 V, 630 kVA)"),
    dict(id="FP-CP-06", ring="OC", name="Outer Circle East", bearing=90.0, radius=None,
         where="Outer Circle footpath, M-Block frontage",
         C1=list(range(14, 21)), C2=list(range(13, 6, -1)),
         kva=10, controller="CCMS panel controller (GSM)", commissioned="2010-07-21", source_dt="DT-CP-03 (11 kV/433 V, 990 kVA)"),
    dict(id="FP-CP-07", ring="OC", name="Outer Circle South", bearing=180.0, radius=None,
         where="Outer Circle footpath at Janpath junction",
         C1=list(range(28, 35)), C2=list(range(27, 20, -1)),
         kva=10, controller="CCMS panel controller (GSM)", commissioned="2010-07-21", source_dt="DT-CP-04 (11 kV/433 V, 990 kVA)"),
    dict(id="FP-CP-08", ring="OC", name="Outer Circle West", bearing=270.0, radius=None,
         where="Outer Circle footpath, G-Block frontage",
         C1=list(range(42, 49)), C2=list(range(41, 34, -1)),
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

SLA_HOURS = {"Critical": 4, "High": 24, "Medium": 48, "Low": 72}
TARIFF_INR_PER_KWH = 8.0
SYSTEM_LOSS = {"LED": 1.06, "HPS": 1.15, "Metal Halide": 1.12}  # driver / ballast losses
# Average dusk-to-dawn burning hours per night in Delhi, by calendar month.
BURN_HOURS = {1: 13.4, 2: 12.6, 3: 12.0, 4: 11.1, 5: 10.5, 6: 10.0,
              7: 10.4, 8: 11.0, 9: 11.6, 10: 12.5, 11: 13.3, 12: 13.6}

JUNCTION_MASTS = {18: "Barakhamba Road", 28: "Janpath"}  # Outer Circle pole index -> junction
LEGACY_HPS_PANEL = "FP-CP-08"                            # west quadrant: retrofit pending

# Live situation at the snapshot. `ago` / `started_ago` are hours before --as-of.
LIVE_TICKETS = [
    # Dark stretch: cable fault on FP-CP-07 / C1 - every pole downstream of #2 is out.
    dict(poles=[("OC", k) for k in range(30, 35)], status="Open", priority="High",
         issue="No supply - poles dark (CCMS: circuit current drop)", source="CCMS auto-alert",
         ago=43.3, complaints=3, notes="Zero current reported downstream on circuit C1. Citizen complaints merged."),
    dict(poles=[("OC", 38)], status="Open", priority="Medium", issue="Lamp burnt out", source="Night patrol", ago=22.9),
    dict(poles=[("OC", 45)], status="Open", priority="Medium", issue="Lamp cycling on/off", source="Citizen app", ago=69.75, complaints=2),
    dict(poles=[("OC", 2)], status="Open", priority="Medium", issue="LED driver failure", source="CCMS auto-alert", ago=11.5),
    dict(poles=[("OC", 11)], status="Open", priority="Medium", issue="Lamp not glowing", source="Call centre", ago=20.2),
    dict(poles=[("MC", 18)], status="Open", priority="Medium", issue="LED driver failure", source="Night patrol", ago=93.0),
    dict(poles=[("MC", 19)], status="Open", priority="Medium", issue="LED driver failure", source="Citizen app", ago=45.5, complaints=1),
    dict(poles=[("MC", 21)], status="Open", priority="Medium", issue="LED driver failure", source="Night patrol", ago=21.0),
    dict(poles=[("MC", 5)], status="Open", priority="Medium", issue="Flickering", source="Citizen app", ago=10.25, complaints=1),
    dict(poles=[("IC", 21), ("IC", 22)], status="Open", priority="High",
         issue="Junction box vandalised - cable stolen", source="Night patrol", ago=18.8, complaints=1,
         notes="Dark patch near Rajiv Chowk Metro Gate 1. Police complaint filed."),
    dict(poles=[("IC", 9)], status="Open", priority="Medium", issue="Lamp not glowing", source="Citizen app", ago=45.5, complaints=2),
    # Works in progress (pole status "Under Maintenance")
    dict(poles=[("OC", 46)], status="In Progress", priority="Medium", issue="Ignitor failure", source="Night patrol", ago=22.0, started_ago=7.75),
    dict(poles=[("OC", 52)], status="In Progress", priority="High", issue="Pole damaged by vehicle", source="Call centre",
         ago=378.5, started_ago=356.0, notes="Pole made safe and isolated. Replacement pole on order."),
    dict(poles=[("OC", 18)], status="In Progress", priority="Medium", issue="Ballast failure", source="CCMS auto-alert", ago=22.3, started_ago=7.0),
    dict(poles=[("OC", 8)], status="In Progress", priority="Medium", issue="Surge protection device failure", source="CCMS auto-alert", ago=12.2, started_ago=5.5),
    dict(poles=[("MC", 20)], status="In Progress", priority="Medium", issue="LED driver failure", source="Night patrol", ago=45.0, started_ago=8.3),
    dict(poles=[("MC", 29)], status="In Progress", priority="Low", issue="Loose connection in junction box", source="Night patrol", ago=23.5, started_ago=4.0),
    dict(poles=[("MC", 11)], status="In Progress", priority="Low", issue="Light blocked by tree canopy", source="Citizen app",
         ago=70.0, started_ago=6.0, notes="Horticulture team pruning; luminaire to be re-aimed."),
    dict(poles=[("IC", 14)], status="In Progress", priority="Medium", issue="Water ingress in luminaire", source="CCMS auto-alert", ago=44.0, started_ago=9.0),
    dict(poles=[("IC", 3)], status="In Progress", priority="Low", issue="Loose connection in junction box", source="CCMS auto-alert", ago=21.0, started_ago=6.0),
]
# Working lights with a stuck timer/photocell: lit, but burning through the day as well.
# Nobody has reported them - the energy layer is how they get found.
DAY_BURNERS = {("OC", 44): 56, ("MC", 27): 40}  # -> days since day-burning started

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


# ---------------------------------------------------------------------------
# 3. Helpers
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


def overlap_hours(a0: datetime, a1: datetime, b0: datetime, b1: datetime) -> float:
    return max(0.0, (min(a1, b1) - max(a0, b0)).total_seconds() / 3600)


def fixture_spec(ring: str, idx: int, panel_id: str, bearing: float, rng: random.Random) -> dict:
    if ring == "IC":
        return dict(pole_type="Heritage cast-iron (decorative)", pole_height_m=6, arm_count=1,
                    fixture_type="LED", wattage=60, cct_k=3000, ccms_node=True,
                    install_date="2010-08-%02d" % rng.randint(2, 28),
                    fixture_installed=f"2023-0{rng.randint(2, 4)}-{rng.randint(1, 28):02d}", retrofit="heritage")
    if ring == "MC":
        at_junction = nearest(RADIAL_ROADS, bearing, 4.0) is not None
        return dict(pole_type="Swaged tubular GI", pole_height_m=7, arm_count=1,
                    fixture_type="LED", wattage=60 if at_junction else 45, cct_k=4000, ccms_node=False,
                    install_date="2010-09-%02d" % rng.randint(2, 28),
                    fixture_installed=f"2022-0{rng.randint(3, 6)}-{rng.randint(1, 28):02d}", retrofit=None)
    if idx in JUNCTION_MASTS:
        return dict(pole_type="Junction mast (GI)", pole_height_m=12, arm_count=2,
                    fixture_type="Metal Halide", wattage=250, cct_k=4200, ccms_node=True,
                    install_date="2010-07-%02d" % rng.randint(2, 28),
                    fixture_installed=f"2016-1{rng.randint(0, 2)}-{rng.randint(1, 28):02d}", retrofit=None)
    if panel_id == LEGACY_HPS_PANEL:
        return dict(pole_type="Octagonal GI", pole_height_m=9, arm_count=1,
                    fixture_type="HPS", wattage=250, cct_k=2000, ccms_node=False,
                    install_date="2010-07-%02d" % rng.randint(2, 28),
                    fixture_installed=f"201{rng.randint(3, 5)}-0{rng.randint(1, 9)}-{rng.randint(1, 28):02d}", retrofit=None)
    year, month = rng.choice([(2023, rng.randint(7, 12)), (2024, rng.randint(1, 2))])
    return dict(pole_type="Octagonal GI", pole_height_m=9, arm_count=1,
                fixture_type="LED", wattage=120, cct_k=4000, ccms_node=True,
                install_date="2010-07-%02d" % rng.randint(2, 28),
                fixture_installed=f"{year}-{month:02d}-{rng.randint(1, 28):02d}", retrofit="phase1")


# ---------------------------------------------------------------------------
# 4. Build
# ---------------------------------------------------------------------------
def build(as_of: datetime) -> dict:
    rng = random.Random(SEED)
    window_start = as_of - timedelta(days=int(3.75 * 365))
    window_end = as_of - timedelta(days=12)
    energy_months = months_before(as_of, 6)

    # --- wire every pole to its panel / circuit -------------------------------------------
    wiring = {}  # (ring, idx) -> (panel_id, circuit, seq)
    for p in PANELS:
        for circuit in ("C1", "C2"):
            for seq, idx in enumerate(p[circuit], start=1):
                wiring[(p["ring"], idx)] = (p["id"], circuit, seq)
    for ring, spec in RINGS.items():
        missing = [i for i in range(len(spec["bearings"])) if (ring, i) not in wiring]
        assert not missing, f"{ring} poles not wired: {missing}"

    poles = []  # working records, turned into GeoJSON features at the end
    for ring, spec in RINGS.items():
        for idx, bearing in enumerate(spec["bearings"]):
            if ring == "IC":
                radius = INNER_RADIUS_M
            elif ring == "MC":
                radius = profile_radius(MIDDLE_PROFILE, bearing)
            else:
                radius = profile_radius(OUTER_PROFILE, bearing)
            lat, lng = destination(bearing, radius + spec["offset_m"])
            panel_id, circuit, seq = wiring[(ring, idx)]
            fx = fixture_spec(ring, idx, panel_id, bearing, rng)
            poles.append(dict(key=(ring, idx), ring=ring, idx=idx, bearing=bearing, lat=lat, lng=lng,
                              panel_id=panel_id, circuit=circuit, seq=seq, fx=fx,
                              contractor=CONTRACTORS[spec["contractor"]], events=[]))

    # --- repair history ----------------------------------------------------------------------
    all_tickets = []  # every ticket (history + live) for chronological ID assignment
    for pole in poles:
        fx, ctr = pole["fx"], pole["contractor"]
        fitted = datetime.fromisoformat(fx["fixture_installed"]).replace(tzinfo=IST)
        if fx["retrofit"] and window_start < fitted < window_end:
            before = "CFL 2x36 W heritage lantern" if fx["retrofit"] == "heritage" else "HPS 250 W"
            when = fitted.replace(hour=rng.randint(10, 15), minute=rng.randrange(60))
            hours = round(rng.uniform(2.5, 5.0), 1)
            pole["events"].append(dict(
                type="Retrofit", issue=f"LED retrofit ({before} → LED {fx['wattage']} W)",
                action="Replaced luminaire with LED; CCMS node fitted", source="Scheduled (retrofit programme)",
                raised=when, resolved=when + timedelta(hours=hours), downtime_h=hours, priority="Low",
                crew=rng.choice(ctr["crews"]), contractor=ctr["name"],
                cost_inr=rng.randint(7200, 8400) if fx["retrofit"] == "heritage" else rng.randint(9800, 11500)))
        weights = {"LED": [0, 0, 0, 1, 1, 1, 1, 2, 2, 3], "HPS": [1, 2, 2, 3, 3, 3, 4, 4],
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
            pole["events"].append(dict(
                type="Corrective", issue=issue, action=action, source=rng.choice(sources),
                raised=raised, resolved=raised + timedelta(hours=downtime), downtime_h=downtime,
                priority=priority, crew=rng.choice(ctr["crews"]), contractor=ctr["name"],
                cost_inr=rng.randint(*cost)))
        for _ in range(rng.choice([0, 1, 1, 2])):
            day = random_day(rng, max(window_start, fitted), window_end)
            when = day.replace(hour=rng.randint(10, 15), minute=rng.randrange(60))
            hours = round(rng.uniform(0.8, 2.0), 1)
            pole["events"].append(dict(
                type="Preventive", issue="Annual preventive maintenance",
                action="Cleaned luminaire, IR & earth-resistance test, tightened terminations",
                source="Scheduled (AMC)", raised=when, resolved=when + timedelta(hours=hours),
                downtime_h=hours, priority="Low", crew=rng.choice(ctr["crews"]),
                contractor=ctr["name"], cost_inr=rng.randint(350, 450)))
        all_tickets.extend(pole["events"])

    # --- live tickets (one ticket can cover several poles) -------------------------------------
    by_key = {p["key"]: p for p in poles}
    live_tickets = []
    for spec in LIVE_TICKETS:
        first = by_key[spec["poles"][0]]
        ctr = first["contractor"]
        raised = as_of - timedelta(hours=spec["ago"])
        ticket = dict(type="Corrective", status=spec["status"], priority=spec["priority"],
                      issue=spec["issue"], source=spec["source"], raised=raised,
                      sla_hours=SLA_HOURS[spec["priority"]], complaints=spec.get("complaints", 0),
                      notes=spec.get("notes"), contractor=ctr["name"], crew=None, started=None,
                      pole_keys=spec["poles"])
        if spec["status"] == "In Progress":
            ticket["crew"] = rng.choice(ctr["crews"])
            ticket["started"] = as_of - timedelta(hours=spec["started_ago"])
        live_tickets.append(ticket)
        all_tickets.append(ticket)
    live_by_pole = {key: t for t in live_tickets for key in t["pole_keys"]}

    # --- ticket numbers: TKT-<year>-<seq>, chronological per year ------------------------------
    counters = {}
    for t in sorted(all_tickets, key=lambda e: e["raised"]):
        year = t["raised"].year
        counters[year] = counters.get(year, 100) + 1
        t["ticket_id"] = f"TKT-{year}-{counters[year]:04d}"

    # --- energy: last 6 complete months --------------------------------------------------------
    def monthly_energy(pole) -> list[dict]:
        fx = pole["fx"]
        kw = fx["wattage"] * fx["arm_count"] * SYSTEM_LOSS[fx["fixture_type"]] / 1000
        live = live_by_pole.get(pole["key"])
        burn_since = DAY_BURNERS.get(pole["key"])
        series = []
        for (y, m) in energy_months:
            m0, m1 = month_bounds(y, m)
            burn_h = BURN_HOURS[m]
            kwh = kw * burn_h * (m1 - m0).days * rng.uniform(0.975, 1.025)
            night_share = burn_h / 24
            for e in pole["events"]:  # outages from the repair history
                if e["type"] == "Corrective":
                    kwh -= kw * night_share * overlap_hours(e["raised"], e["resolved"], m0, m1)
            if live:  # current fault / works already under way in that month
                kwh -= kw * night_share * overlap_hours(live["raised"], as_of, m0, m1)
            if burn_since is not None:  # day burning adds the daylight hours
                start = as_of - timedelta(days=burn_since)
                kwh += kw * (24 - burn_h) * overlap_hours(start, as_of, m0, m1) / 24
            series.append({"month": f"{y}-{m:02d}", "kwh": round(max(kwh, 0.0), 1)})
        return series

    # --- features --------------------------------------------------------------------------------
    features = []
    for pole in poles:
        fx, ring = pole["fx"], pole["ring"]
        live = live_by_pole.get(pole["key"])
        status = "Functional"
        ticket = None
        if live:
            status = "Faulty" if live["status"] == "Open" else "Under Maintenance"
            ticket = {
                "id": live["ticket_id"], "status": live["status"], "priority": live["priority"],
                "issue": live["issue"], "source": live["source"], "raised_at": iso(live["raised"]),
                "sla_hours": live["sla_hours"], "sla_due": iso(live["raised"] + timedelta(hours=live["sla_hours"])),
                "assigned_crew": live["crew"], "work_started_at": iso(live["started"]) if live["started"] else None,
                "complaints": live["complaints"], "notes": live["notes"],
                "pole_uids": [f"SL-CP-{k[0]}-{k[1] + 1:03d}" for k in live["pole_keys"]],
            }
        history = []
        for e in sorted(pole["events"], key=lambda e: e["raised"], reverse=True):
            history.append({
                "ticket_id": e["ticket_id"], "type": e["type"], "issue": e["issue"], "action": e["action"],
                "source": e["source"], "priority": e["priority"], "raised_at": iso(e["raised"]),
                "resolved_at": iso(e["resolved"]), "downtime_h": e["downtime_h"],
                "sla_met": e["downtime_h"] <= SLA_HOURS[e["priority"]] if e["type"] == "Corrective" else True,
                "crew": e["crew"], "contractor": e["contractor"], "cost_inr": e["cost_inr"], "status": "Closed",
            })
        energy = monthly_energy(pole)
        recent = [datetime.fromisoformat(h["resolved_at"]) for h in history]
        patrol = as_of - timedelta(days=rng.randint(3, 75), hours=rng.randint(0, 12))
        last_inspected = max(recent + [patrol]).date().isoformat()
        uid = f"SL-CP-{ring}-{pole['idx'] + 1:03d}"
        ctr = pole["contractor"]
        features.append({
            "type": "Feature",
            "id": uid,
            "geometry": point_geometry(pole["lat"], pole["lng"]),
            "properties": {
                "uid": uid,
                "status": status,
                "road": RINGS[ring]["name"],
                "location": describe_location(ring, pole["bearing"]),
                "pole_type": fx["pole_type"],
                "pole_height_m": fx["pole_height_m"],
                "arm_count": fx["arm_count"],
                "fixture_type": fx["fixture_type"],
                "wattage": fx["wattage"],
                "cct_k": fx["cct_k"],
                "ccms_node": fx["ccms_node"],
                "install_date": fx["install_date"],
                "fixture_installed": fx["fixture_installed"],
                "last_inspected": last_inspected,
                "feeder_panel": pole["panel_id"],
                "circuit": pole["circuit"],
                "circuit_seq": pole["seq"],
                "phase": "RYB"[(pole["seq"] - 1) % 3],
                "energy_kwh": energy[-1]["kwh"],
                "energy_month": energy[-1]["month"],
                "energy_history": energy,
                "contractor": {k: v for k, v in ctr.items() if k != "crews"},
                "ticket": ticket,
                "repair_history": history,
            },
        })

    # --- feeder panels -------------------------------------------------------------------------
    panel_features = []
    for p in PANELS:
        radius = p["radius"] or profile_radius(OUTER_PROFILE, p["bearing"]) + 16
        lat, lng = destination(p["bearing"], radius)
        ring = p["ring"]
        panel_features.append({
            "type": "Feature",
            "id": p["id"],
            "geometry": point_geometry(lat, lng),
            "properties": {
                "panel_id": p["id"], "name": p["name"], "road": RINGS[ring]["name"], "location": p["where"],
                "source_dt": p["source_dt"], "capacity_kva": p["kva"], "controller": p["controller"],
                "commissioned": p["commissioned"], "circuits": ["C1", "C2"],
                "contractor_id": RINGS[ring]["contractor"],
            },
        })

    # --- pilot zone boundary (exterior ring anticlockwise per RFC 7946 right-hand rule) --------
    ring_coords = []
    for step in range(72, -1, -1):
        lat, lng = destination(step * 5 % 360, PILOT_ZONE_RADIUS_M)
        ring_coords.append([round(lng, 6), round(lat, 6)])
    zone = {"type": "Feature", "id": "ZONE-CP-PILOT",
            "geometry": {"type": "Polygon", "coordinates": [ring_coords]},
            "properties": {"name": "Connaught Place pilot zone", "authority": "NDMC area",
                           "radius_m": PILOT_ZONE_RADIUS_M}}

    meta = {
        "title": "Street Light GIS — Connaught Place pilot (NDMC area)",
        "as_of": iso(as_of),
        "energy_month": "%d-%02d" % energy_months[-1],
        "crs": "EPSG:4326 (WGS 84). GeoJSON positions are [longitude, latitude].",
        "centre": CENTRE,
        "geometry_source": "Ring centrelines fitted to OpenStreetMap (© OpenStreetMap contributors, ODbL)",
        "attribute_source": "Synthetic mock data for demonstration (seed %d)" % SEED,
        "tariff_inr_per_kwh": TARIFF_INR_PER_KWH,
        "sla_hours_by_priority": SLA_HOURS,
        "energy_model": {"system_loss": SYSTEM_LOSS,
                         "burn_hours_by_month": {str(k): v for k, v in BURN_HOURS.items()}},
        "contractors": CONTRACTORS,
    }
    return {
        "meta": meta,
        "zone": zone,
        "streetlights": {"type": "FeatureCollection", "name": "streetlights", "features": features},
        "feederPanels": {"type": "FeatureCollection", "name": "feeder_panels", "features": panel_features},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--as-of", default=DEFAULT_AS_OF, help="snapshot time, IST (YYYY-MM-DDTHH:MM)")
    args = ap.parse_args()
    as_of = datetime.fromisoformat(args.as_of).replace(tzinfo=IST)
    data = build(as_of)

    OUT_DIR.mkdir(exist_ok=True)
    # newline="\n": identical bytes on every OS (Windows would otherwise write CRLF)
    write = lambda name, text: (OUT_DIR / name).write_text(text, encoding="utf-8", newline="\n")
    write("streetlights.geojson", json.dumps(data["streetlights"], indent=1) + "\n")
    write("feeder_panels.geojson", json.dumps(data["feederPanels"], indent=1) + "\n")
    banner = ("/* AUTO-GENERATED by tools/generate_data.py - do not edit by hand.\n"
              " * Mock data for the Street Light GIS MVP (Connaught Place pilot, NDMC area).\n"
              " * GeoJSON positions are [longitude, latitude] (RFC 7946); Leaflet converts them.\n */\n")
    write("streetlights.js", banner + "window.SLGIS_DATA = " + json.dumps(data, indent=1) + ";\n")

    feats = data["streetlights"]["features"]
    counts = {}
    for f in feats:
        counts[f["properties"]["status"]] = counts.get(f["properties"]["status"], 0) + 1
    total_kwh = sum(f["properties"]["energy_kwh"] for f in feats)
    print(f"as of {data['meta']['as_of']}: {len(feats)} poles {counts}, "
          f"{len(data['feederPanels']['features'])} feeder panels, {total_kwh:,.0f} kWh in {data['meta']['energy_month']}")
    print(f"wrote {OUT_DIR / 'streetlights.js'}")


if __name__ == "__main__":
    main()
