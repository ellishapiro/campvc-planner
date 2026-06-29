#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Help decide which no-registration activities are actually BOOKABLE (off-app /
third-party) vs genuine turn-up drop-ins.

    python review_dropins.py [path-to-campvc-schedule]

It lists every activity Guidebook has with NO in-app registration, shows its
paid/free category, a guessed verdict from the description wording, whether it's
already in build_schedule.py's EXTERNAL_BOOKABLE list, and the snippet that hints
at booking. Skim the BOOKABLE? column; add any it got wrong to EXTERNAL_BOOKABLE.
"""
import json
import os
import re
import sys

# import the override list + helpers from the build script
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_schedule as B

# Strong signals that an activity is a booked/arranged trip (often via an
# external operator), not a turn-up. Deliberately specific to avoid noise from
# words like "book" appearing in unrelated text.
BOOK_HINTS = [
    "operated by", "expert team from", "paid-for activity", "small groups",
    "small group", "shuttle", "pre-book", "pre book", "book your place",
    "book a slot", "limited space", "limited place", "spaces are limited",
    "places are limited", "booking is essential", "must be booked", "book in advance",
]
# Explicit turn-up phrasing - if present, it's a drop-in even if paid.
TURNUP_HINTS = [
    "walk-up", "walk up", "swing by", "drop in", "drop-in", "no need to book",
    "no booking", "just turn up", "come along", "pop in", "head to", "join us",
]


def main():
    sched_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else os.path.join("..", "campvc-schedule")
    with open(os.path.join(sched_dir, "bundle.json"), encoding="utf-8") as f:
        bundle = json.load(f)

    seen = {}
    for e in bundle.get("guidebook_event", []):
        if e.get("registration_start_date"):
            continue  # has in-app booking already - not our problem
        name = (e.get("name") or "").strip()
        if not name or norm_dupe(name, seen):
            continue
        desc = B.clean_html(e.get("description") or "")
        cats = []
        if e.get("links"):
            try:
                cats = [g.get("categoryTitle") for g in json.loads(e["links"])]
            except Exception:
                cats = []
        paid = any("Paid" in (c or "") for c in cats)
        low = desc.lower()
        book_hit = next((h for h in BOOK_HINTS if h in low), None)
        turnup_hit = any(h in low for h in TURNUP_HINTS)
        already = B.is_external_bookable(name)
        # verdict: bookable if a booking hint and not an explicit turn-up phrase
        if turnup_hit and not book_hit:
            verdict = "turn-up"
        elif book_hit or paid:
            verdict = "BOOKABLE?"
        else:
            verdict = "turn-up"
        seen[name] = {"paid": paid, "verdict": verdict, "already": already,
                      "hint": book_hit or ("paid-category" if paid else ""), "desc": desc}

    rows = sorted(seen.items(), key=lambda kv: (kv[1]["verdict"] != "BOOKABLE?", kv[0].lower()))
    print(f"{'verdict':10s} {'in-list':8s} {'P/F':4s} name")
    print("-" * 80)
    for name, info in rows:
        flag = "YES" if info["already"] else ""
        pf = "Paid" if info["paid"] else "Free"
        print(f"{info['verdict']:10s} {flag:8s} {pf:4s} {name}")
        if info["hint"]:
            print(f"           hint: \"{info['hint']}\"  | {info['desc'][:110]}")
    print()
    print("Legend: 'BOOKABLE?' = description/category suggests you must book/pay.")
    print("        'in-list YES' = already in EXTERNAL_BOOKABLE (treated as bookable).")
    print("Action: for any BOOKABLE? not marked YES that you confirm needs booking,")
    print("        add its name (lowercase prefix) to EXTERNAL_BOOKABLE in build_schedule.py.")


def norm_dupe(name, seen):
    return name in seen


if __name__ == "__main__":
    main()
