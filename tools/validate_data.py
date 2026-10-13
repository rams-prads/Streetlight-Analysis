#!/usr/bin/env python3
"""
Validate the generated dataset in data/.

Checks
  * RFC 7946 structure: FeatureCollections, Features, Point / LineString / Polygon geometry,
    closed polygon rings wound by the right-hand rule.
  * Coordinate order: every position is [longitude, latitude] inside the pilot zone
    (a swapped [lat, lon] pair is reported as such).
  * Cross-references: poles -> panels and circuits, tickets -> poles, shutdown circuits -> panel
    circuits, monthly series -> the meta month list, citizen reports -> tickets, poles and reporters
    (each ticket's complaint count equals its linked reports), CCMS readings on CCMS poles only.
  * Sync: data/streetlights.js holds exactly the same collections as the .geojson files.
  * Honesty flags: every landmark, permit and waterlogging spot carries `approximate: true`.

Usage:  python tools/validate_data.py      (exit code 1 when anything is wrong)
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
LON, LAT = (77.19, 77.25), (28.60, 28.66)  # pilot zone box, longitude first
STATUSES = {"Functional", "Faulty", "Under Maintenance"}
TICKET_STATUSES = {"Open", "In Progress", "Awaiting dusk check"}
CATEGORIES = {"not_working", "flickering", "day_burning", "damaged", "exposed", "shock", "blocked", "other"}
CCMS_STATES = {"on", "off", "abnormal"}
OUTCOMES = {"confirmed", "no_fault", "obstruction", "different_pole"}
FILES = {"streetlights.geojson": "streetlights", "feeder_panels.geojson": "feederPanels",
         "landmarks.geojson": "landmarks", "excavation_permits.geojson": "excavationPermits",
         "waterlogging_spots.geojson": "waterloggingSpots"}

problems: list[str] = []


def bad(msg: str) -> None:
    problems.append(msg)


def check_position(pos, where: str) -> None:
    if not (isinstance(pos, list) and len(pos) in (2, 3) and all(isinstance(v, (int, float)) for v in pos)):
        bad(f"{where}: position {pos!r} is not [lon, lat]")
        return
    lon, lat = pos[0], pos[1]
    if not (LON[0] < lon < LON[1] and LAT[0] < lat < LAT[1]):
        swapped = LON[0] < lat < LON[1] and LAT[0] < lon < LAT[1]
        bad(f"{where}: {pos} {'looks like [lat, lon]' if swapped else 'is outside the pilot zone'}")


def signed_area(ring) -> float:
    """Shoelace area in lon/lat; positive means anticlockwise."""
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2


def check_geometry(g: dict, where: str) -> None:
    kind, coords = g.get("type"), g.get("coordinates")
    if kind == "Point":
        check_position(coords, where)
    elif kind == "LineString":
        if not isinstance(coords, list) or len(coords) < 2:
            bad(f"{where}: LineString needs at least 2 positions")
            return
        for p in coords:
            check_position(p, where)
    elif kind == "Polygon":
        for k, ring in enumerate(coords or []):
            if len(ring) < 4 or ring[0] != ring[-1]:
                bad(f"{where}: ring {k} is not closed or has fewer than 4 positions")
                continue
            for p in ring:
                check_position(p, where)
            if (k == 0) != (signed_area(ring) > 0):
                bad(f"{where}: ring {k} breaks the right-hand rule (exterior anticlockwise, holes clockwise)")
    else:
        bad(f"{where}: unsupported geometry type {kind!r}")


def check_collection(fc: dict, name: str, id_key: str, required=(), approximate=False) -> dict:
    if fc.get("type") != "FeatureCollection" or not isinstance(fc.get("features"), list):
        bad(f"{name}: not a FeatureCollection")
        return {}
    out = {}
    for i, f in enumerate(fc["features"]):
        props = f.get("properties") or {}
        fid = props.get(id_key)
        where = f"{name}[{i}] {fid}"
        if f.get("type") != "Feature":
            bad(f"{where}: not a Feature")
        if fid is None or fid in out:
            bad(f"{where}: missing or duplicate {id_key}")
        if f.get("id") != fid:
            bad(f"{where}: feature id {f.get('id')!r} differs from {id_key}")
        for k in required:
            if k not in props:
                bad(f"{where}: missing property {k}")
        if approximate and props.get("approximate") is not True:
            bad(f"{where}: `approximate: true` missing")
        check_geometry(f.get("geometry") or {}, where)
        out[fid] = props
    return out


def load_js() -> dict:
    text = (DATA / "streetlights.js").read_text(encoding="utf-8")
    start = text.index("window.SLGIS_DATA = ") + len("window.SLGIS_DATA = ")
    return json.loads(text[start:].rstrip().rstrip(";"))


def main() -> int:
    js = load_js()
    files = {key: json.loads((DATA / name).read_text(encoding="utf-8")) for name, key in FILES.items()}
    for key, content in files.items():
        if js.get(key) != content:
            bad(f"streetlights.js and the .geojson file for {key!r} are out of sync")

    meta = js["meta"]
    months = meta["energy_months"]
    poles = check_collection(js["streetlights"], "streetlights", "uid",
                             ("status", "road", "feeder_panel", "circuit", "circuit_seq", "fixture_type", "wattage",
                              "fixture_make", "fixture_batch", "fixture_warranty_years", "last_earthing_check",
                              "junction_box_condition", "energy_history", "repair_history"))
    panels = check_collection(js["feederPanels"], "feeder_panels", "panel_id",
                              ("capacity_kva", "circuits", "metered_kwh_history", "temp_connections", "planned_shutdowns"))
    check_collection(js["landmarks"], "landmarks", "landmark_id", ("kind", "name"), approximate=True)
    permits = check_collection(js["excavationPermits"], "excavation_permits", "permit_id",
                               ("agency", "purpose", "start", "end"), approximate=True)
    check_collection(js["waterloggingSpots"], "waterlogging_spots", "spot_id", ("name", "radius_m"), approximate=True)
    locations = check_collection(js["locationTickets"], "location_tickets", "id", ("status", "category", "raised_at"))
    check_geometry(js["zone"]["geometry"], "zone")

    # poles -> panels / circuits, wiring order, statuses, monthly series
    seqs: dict[tuple, list[int]] = {}
    tickets: dict[str, dict] = {}
    history_ids = set()
    for uid, p in poles.items():
        if p["status"] not in STATUSES:
            bad(f"{uid}: unknown status {p['status']!r}")
        panel = panels.get(p["feeder_panel"])
        if not panel:
            bad(f"{uid}: feeder panel {p['feeder_panel']} does not exist")
        elif p["circuit"] not in panel["circuits"]:
            bad(f"{uid}: circuit {p['circuit']} is not on {p['feeder_panel']}")
        seqs.setdefault((p["feeder_panel"], p["circuit"]), []).append(p["circuit_seq"])
        if [row["month"] for row in p["energy_history"]] != months:
            bad(f"{uid}: energy months differ from meta.energy_months")
        for row in p["energy_history"]:
            if not 0 <= row["lit_h"] <= row["scheduled_h"] <= meta["night_hours_by_month"][row["month"]] + 0.05:
                bad(f"{uid} {row['month']}: lit {row['lit_h']} h / scheduled {row['scheduled_h']} h out of range")
        t = p.get("ticket")
        if t:
            if t["status"] not in TICKET_STATUSES or t["category"] not in CATEGORIES:
                bad(f"{uid}: ticket {t['id']} has status {t['status']!r} / category {t['category']!r}")
            if uid not in t["pole_uids"]:
                bad(f"{uid}: its ticket {t['id']} does not list it")
            if t["id"] in tickets and tickets[t["id"]] != t:
                bad(f"{t['id']}: copies on different poles disagree")
            tickets[t["id"]] = t
        for h in p["repair_history"]:
            history_ids.add(h["ticket_id"])
    for (panel, circuit), found in seqs.items():
        if sorted(found) != list(range(1, len(found) + 1)):
            bad(f"{panel}/{circuit}: circuit_seq is not 1..n ({sorted(found)})")
    for tid, t in tickets.items():
        for uid in t["pole_uids"]:
            if uid not in poles:
                bad(f"{tid}: pole {uid} does not exist")
            elif (poles[uid].get("ticket") or {}).get("id") != tid:
                bad(f"{tid}: pole {uid} does not point back to it")
    for pid, panel in panels.items():
        if [row["month"] for row in panel["metered_kwh_history"]] != months:
            bad(f"{pid}: metered months differ from meta.energy_months")
        for s in panel["planned_shutdowns"]:
            if not set(s["circuits"]) <= set(panel["circuits"]) or s["start"] >= s["end"]:
                bad(f"{pid}: bad planned shutdown {s}")
        for c in panel["temp_connections"]:
            if c["from"] >= c["to"] or c["kw"] <= 0:
                bad(f"{pid}: bad temporary connection {c}")
    for pid, pm in permits.items():
        if datetime.fromisoformat(pm["start"]) >= datetime.fromisoformat(pm["end"]):
            bad(f"{pid}: permit ends before it starts")

    # CCMS readings, report-confidence fields
    for uid, p in poles.items():
        reading = p.get("ccms_reading")
        if bool(reading) != bool(p["ccms_node"]):
            bad(f"{uid}: ccms_reading must be present exactly when the pole has a CCMS node")
        elif reading and (reading["state"] not in CCMS_STATES or reading["daylight"] not in ("on", "off")):
            bad(f"{uid}: bad ccms_reading {reading}")
        for h in p["repair_history"]:
            if "outcome" in h and (h["outcome"] not in OUTCOMES or h.get("reported_uid") not in poles):
                bad(f"{uid}: history {h['ticket_id']} has outcome {h.get('outcome')!r} / reported_uid {h.get('reported_uid')!r}")
    reporters = {r["id"]: r for r in js["reporters"]}
    if len(reporters) != len(js["reporters"]) or sum(r["mine"] for r in js["reporters"]) != 1:
        bad("reporters: duplicate IDs, or not exactly one `mine` reporter (this device)")
    for r in js["reporters"]:
        if not 0 <= r["past_confirmed"] <= r["past_reports"] or r.get("simulated") is not True:
            bad(f"{r['id']}: bad track record or missing `simulated: true`")
    report_ids = set()
    linked: dict[str, int] = {}
    for r in js["citizenReports"]:
        where = f"report {r['id']}"
        if r["id"] in report_ids:
            bad(f"{where}: duplicate ID")
        report_ids.add(r["id"])
        rep = reporters.get(r["reporter_id"])
        if not rep or rep["mine"] != r["mine"]:
            bad(f"{where}: unknown reporter {r['reporter_id']} or `mine` disagrees with the reporter")
        if r["category"] not in CATEGORIES or r.get("simulated") is not True:
            bad(f"{where}: category {r['category']!r} or missing `simulated: true`")
        if (r["uid"] is None) == (r["spot"] is None) or (r["uid"] and r["uid"] not in poles):
            bad(f"{where}: needs either a known pole uid or a spot")
        if r["spot"]:
            check_position(r["spot"], where)
        if r["device_location"]:
            check_position(r["device_location"]["position"], where)
        if r["photo"] and (r["photo"]["kind"] not in ("live", "upload") or not re.fullmatch(r"[0-9a-f]{16}", r["photo"]["hash"])):
            bad(f"{where}: bad photo {r['photo']}")
        if r["noticed"] not in (None, "last_night", "earlier_today", "just_now"):
            bad(f"{where}: bad noticed {r['noticed']!r}")
        t = tickets.get(r["ticket_id"]) or locations.get(r["ticket_id"])
        if t is None and r["ticket_id"] not in history_ids:
            bad(f"{where}: ticket {r['ticket_id']} not found")
        if t is not None:
            linked[r["ticket_id"]] = linked.get(r["ticket_id"], 0) + 1
            if r["uid"] and r["uid"] not in t.get("pole_uids", []):
                bad(f"{where}: pole {r['uid']} is not on ticket {r['ticket_id']}")
    for tid, t in [*tickets.items(), *locations.items()]:
        if t.get("complaints", 0) != linked.get(tid, 0):
            bad(f"{tid}: {t.get('complaints', 0)} complaints but {linked.get(tid, 0)} linked citizen reports")
        pub = t.get("public")
        if pub and next((r for r in js["citizenReports"] if r["id"] == pub["report_id"] and r["ticket_id"] == tid), None) is None:
            bad(f"{tid}: shared publicly by report {pub['report_id']}, which is not on this ticket")
    every_id = list(tickets) + list(history_ids) + list(locations)
    if len(every_id) != len(set(every_id)):
        bad("ticket ids are not unique across live, history and location tickets")

    if problems:
        print(f"{len(problems)} problem(s):")
        for msg in problems:
            print("  -", msg)
        return 1
    print(f"OK: {len(poles)} poles, {len(panels)} panels, {len(tickets)} live pole tickets, "
          f"{len(locations)} location ticket(s), {len(js['landmarks']['features'])} landmarks, "
          f"{len(permits)} permits, {len(js['waterloggingSpots']['features'])} waterlogging spots; "
          f"all positions [lon, lat] inside the zone; streetlights.js in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
