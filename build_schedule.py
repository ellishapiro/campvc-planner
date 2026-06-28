#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build data/schedule.json from the Camp VC festival xlsx.

Re-run this whenever the source spreadsheet changes:

    python build_schedule.py [path/to/CampVC_2026_Full_Schedule.xlsx]

It groups the 681 raw rows into ~195 activities (keyed by name+location, with a
stable id so saved picks survive a rebuild), parses times to minutes, classifies
each instance as a bookable slot or a drop-in window, and writes a compact JSON
the static site loads.

Classification (decided against the real data):
- Off-site activities (the long climbing/rafting/canoeing trips) are ALWAYS
  bookable, never drop-in, even though they run 3-4h.
- Otherwise an instance is a drop-in window if it is "All day", starts at 00:00,
  has a blank end, carries the "DROP-IN ACTIVITIES" category tag, or is a long
  on-site window (>= 180 min) - these are the lounges/studios/spaces you wander
  into, not booked sessions.
- An activity's kind comes from its bookable slots: 2+ -> repeating, 1 -> oneoff,
  0 -> dropin.
"""

import json
import os
import re
import sys
import unicodedata
from collections import OrderedDict

import openpyxl

DAYS = ["Friday", "Saturday", "Sunday"]
DAY_INDEX = {d: i for i, d in enumerate(DAYS)}
OFFSITE_LOCATION = "(off-site / no venue listed)"
DROPIN_TAG = "DROP-IN ACTIVITIES"
LONG_WINDOW_MIN = 180  # on-site windows this long or longer are treated as drop-in


def to_minutes(value):
    """'13:30' -> 810 (minutes from midnight). Non-HH:MM -> None."""
    if value is None:
        return None
    s = str(value).strip()
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def fmt_time(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def split_tags(value):
    if not value:
        return []
    return [t.strip() for t in str(value).split(";") if t.strip()]


def slugify(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or "x"


def is_offsite(location):
    return (location or "").strip().lower() == OFFSITE_LOCATION


def instance_is_dropin(start_raw, end_raw, start_min, end_min, tags, offsite):
    """True if this row is a walk-up/open window rather than a bookable slot."""
    if offsite:
        return False  # off-site trips are bookable however long they run
    s = str(start_raw).strip()
    if s.lower() == "all day":
        return True
    if s == "00:00":
        return True
    if end_raw is None or str(end_raw).strip() == "":
        return True
    if DROPIN_TAG in tags:
        return True
    if start_min is not None and end_min is not None and (end_min - start_min) >= LONG_WINDOW_MIN:
        return True
    return False


def load_rows(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Schedule"]
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    expected = ["Day", "Start time", "End time", "Event name", "Location",
                "Category tags", "Paid/free"]
    if [str(h).strip() for h in header[:7]] != expected:
        raise SystemExit(f"Unexpected header: {header}")
    return rows[1:]


def build(path):
    rows = load_rows(path)
    # Preserve first-seen order so output is deterministic and id collisions are stable.
    activities = OrderedDict()  # key (name, location) -> dict
    used_ids = {}

    raw_count = 0
    for r in rows:
        day, start_raw, end_raw, name, location, cat_raw, paidfree = r[:7]
        if not name:
            continue
        raw_count += 1
        name = str(name).strip()
        location = (str(location).strip() if location else "")
        tags = split_tags(cat_raw)
        offsite = is_offsite(location)
        start_min = to_minutes(start_raw)
        end_min = to_minutes(end_raw)
        dropin = instance_is_dropin(start_raw, end_raw, start_min, end_min, tags, offsite)

        key = (name, location)
        if key not in activities:
            slug = slugify(f"{name}-{location}") if location else slugify(name)
            if slug in used_ids and used_ids[slug] != key:
                slug = f"{slug}-{len(activities)}"
            used_ids[slug] = key
            activities[key] = {
                "id": slug,
                "name": name,
                "location": location,
                "offsite": offsite,
                "paid": str(paidfree).strip().lower() == "paid",
                "categories": [],
                "slots": [],      # bookable instances
                "windows": [],    # drop-in/open windows
            }
        act = activities[key]
        for t in tags:
            if t not in act["categories"]:
                act["categories"].append(t)

        day_label = str(day).strip()
        if dropin:
            act["windows"].append({
                "day": day_label,
                "start": str(start_raw).strip(),
                "end": (str(end_raw).strip() if end_raw else ""),
            })
        else:
            # Bookable slot - must have a real start time.
            if start_min is None:
                # Defensive: a non-drop-in row without a parseable start; skip the slot.
                continue
            act["slots"].append({
                "day": day_label,
                "day_index": DAY_INDEX.get(day_label, 9),
                "start_min": start_min,
                "end_min": end_min if end_min is not None else start_min + 50,
                "label": f"{day_label} {fmt_time(start_min)}"
                         + (f"-{fmt_time(end_min)}" if end_min is not None else ""),
            })

    out = []
    counts = {"repeating": 0, "oneoff": 0, "dropin": 0}
    for act in activities.values():
        slots = sorted(act["slots"], key=lambda s: (s["day_index"], s["start_min"]))
        if len(slots) >= 2:
            kind = "repeating"
        elif len(slots) == 1:
            kind = "oneoff"
        else:
            kind = "dropin"
        counts[kind] += 1
        out.append({
            "id": act["id"],
            "name": act["name"],
            "location": act["location"],
            "offsite": act["offsite"],
            "paid": act["paid"],
            "categories": act["categories"],
            "kind": kind,
            "instances": [
                {"day": s["day"], "start_min": s["start_min"],
                 "end_min": s["end_min"], "label": s["label"]}
                for s in slots
            ],
            "windows": act["windows"],
        })

    return out, raw_count, counts


SCHEDULE_JSON = "data/schedule.json"


def load_existing(path=SCHEDULE_JSON):
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def label_set(act):
    return set(i["label"] for i in act.get("instances", []))


def window_set(act):
    return set(w["day"] + " " + w["start"] + "-" + w["end"] for w in act.get("windows", []))


def diff_schedules(old_payload, new_acts):
    """Categorise what changed between the previous build and this one."""
    old = {a["id"]: a for a in (old_payload.get("activities", []) if old_payload else [])}
    new = {a["id"]: a for a in new_acts}
    added = [new[i] for i in new if i not in old]
    removed = [old[i] for i in old if i not in new]
    retimed = []   # (activity, added_times, removed_times)
    paid_changes = []  # (activity, old_paid, new_paid)
    for i, a in new.items():
        if i not in old:
            continue
        o = old[i]
        add_t = sorted(label_set(a) - label_set(o))
        rem_t = sorted(label_set(o) - label_set(a))
        # drop-in window changes count as timing changes too
        add_w = sorted(window_set(a) - window_set(o))
        rem_w = sorted(window_set(o) - window_set(a))
        if add_t or rem_t or add_w or rem_w:
            retimed.append((a, add_t + add_w, rem_t + rem_w))
        if bool(a["paid"]) != bool(o.get("paid")):
            paid_changes.append((a, o.get("paid"), a["paid"]))
    return added, removed, retimed, paid_changes


def days_short(a):
    seen = []
    for i in (a.get("instances") or a.get("windows") or []):
        d = (i.get("day") or "")[:3]
        if d and d not in seen:
            seen.append(d)
    return ",".join(seen)


def format_changes(old_payload, added, removed, retimed, paid_changes):
    if old_payload is None:
        return "No previous schedule on disk - this is the first build (nothing to compare).", False
    any_change = bool(added or removed or retimed or paid_changes)
    L = []
    L.append("SCHEDULE CHANGES (vs last build)")
    L.append("=" * 34)
    if not any_change:
        L.append("No changes - the schedule is identical to the last build.")
        return "\n".join(L), False

    L.append("")
    L.append(f"NEW EVENTS ({len(added)}):")
    for a in sorted(added, key=lambda x: x["name"]):
        n = len(a["instances"]) or len(a["windows"])
        L.append(f"  + {a['name']}" + (f" @ {a['location']}" if a['location'] else "")
                 + f" - {n} session(s) ({days_short(a)}), {'Paid' if a['paid'] else 'Free'}"
                 + (" [OFF-SITE]" if a['offsite'] else ""))
    if not added:
        L.append("  (none)")

    L.append("")
    L.append(f"REMOVED EVENTS ({len(removed)}):")
    for a in sorted(removed, key=lambda x: x["name"]):
        n = len(a["instances"]) or len(a["windows"])
        L.append(f"  - {a['name']}" + (f" @ {a['location']}" if a['location'] else "")
                 + f" (was {n} session(s), {days_short(a)})")
    if not removed:
        L.append("  (none)")

    L.append("")
    L.append(f"TIMING CHANGES ({len(retimed)}):")
    for a, add_t, rem_t in sorted(retimed, key=lambda x: x[0]["name"]):
        L.append(f"  ~ {a['name']}" + (f" @ {a['location']}" if a['location'] else "") + ":")
        for t in rem_t:
            L.append(f"      removed: {t}")
        for t in add_t:
            L.append(f"      added:   {t}")
    if not retimed:
        L.append("  (none)")

    if paid_changes:
        L.append("")
        L.append(f"PAID/FREE CHANGES ({len(paid_changes)}):")
        for a, was, now in paid_changes:
            L.append(f"  ~ {a['name']}: {'Paid' if was else 'Free'} -> {'Paid' if now else 'Free'}")

    return "\n".join(L), True


def print_summary(activities, raw_count, counts):
    total_instances = sum(len(a["instances"]) for a in activities)
    total_windows = sum(len(a["windows"]) for a in activities)
    offsite = [a["name"] for a in activities if a["offsite"]]
    print(f"Source rows:         {raw_count}")
    print(f"Activities:          {len(activities)}")
    print(f"  repeating:         {counts['repeating']}")
    print(f"  one-off:           {counts['oneoff']}")
    print(f"  drop-in:           {counts['dropin']}")
    print(f"Bookable instances:  {total_instances}")
    print(f"Drop-in windows:     {total_windows}")
    print(f"Off-site (buffered): {len(offsite)} -> {', '.join(sorted(set(offsite)))}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    flags = [a for a in sys.argv[1:] if a.startswith("-")]
    check_only = "--check" in flags
    path = args[0] if args else "CampVC_2026_Full_Schedule.xlsx"

    activities, raw_count, counts = build(path)
    old_payload = load_existing()
    added, removed, retimed, paid_changes = diff_schedules(old_payload, activities)
    report, changed = format_changes(old_payload, added, removed, retimed, paid_changes)

    if check_only:
        # Report only; write nothing. Exit 1 if the schedule changed.
        print_summary(activities, raw_count, counts)
        print()
        print(report)
        sys.exit(1 if changed else 0)

    os.makedirs("data", exist_ok=True)
    payload = {"days": DAYS, "generatedFrom": os.path.basename(path), "activities": activities}
    # Archive the previous build so a diff is always reproducible.
    if old_payload is not None:
        with open("data/schedule.prev.json", "w", encoding="utf-8") as f:
            json.dump(old_payload, f, ensure_ascii=False, indent=1)
    with open(SCHEDULE_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    # Also emit a JS global so the pages work even when opened as file:// (no fetch).
    with open("data/schedule.js", "w", encoding="utf-8") as f:
        f.write("window.SCHEDULE = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    with open("data/CHANGES.md", "w", encoding="utf-8") as f:
        f.write("# Schedule change report\n\n```\n" + report + "\n```\n")

    print_summary(activities, raw_count, counts)
    print("Wrote data/schedule.json, data/schedule.js, data/CHANGES.md")
    print()
    print(report)


if __name__ == "__main__":
    main()
