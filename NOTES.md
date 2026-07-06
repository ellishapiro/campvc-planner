# Camp VC Planner - developer notes

Personal project (not work). A static group session-planner for Camp VC 2026
(Fri-Sun 24-26 July 2026): friends mark interest in festival activities, the tool
matchmakes them onto shared instances, avoids clashes, and produces per-person,
priority-ordered booking lists for the two booking phases (Paid, then Free a week
later). No own server - it must run as a static site.

This file is the source of truth for how the thing is built and the non-obvious
decisions behind it. Read it before changing the engine or the data pipeline.

## Architecture (3 parts)

1. **Build step** - `build_schedule.py` reads `../campvc-schedule/rows.json` +
   `bundle.json` (Guidebook export) and writes `data/schedule.json`,
   `data/schedule.js` (`window.SCHEDULE`), `data/migrations.js`
   (`window.MIGRATIONS`), and `CHANGES.md`. Re-run whenever the schedule changes.
2. **Static site** - vanilla HTML/CSS/JS, no framework, no build. Deploys to
   GitHub Pages. Pages: `index.html` (picks), `results.html` (calendar + booking
   lists + together + adjust), `booking.html` (phase checklist).
3. **Backend** - a Google Apps Script web app + a Google Sheet (`Picks` / `Knobs`
   tabs). Reads via JSONP (`getPicks`/`getKnobs`), writes via `text/plain` POST
   (`savePicks`/`saveKnobs`) to dodge CORS preflight. `store.js` wraps this and
   falls back to localStorage ("local mode") when no URL is configured.

Data flow: friends save picks -> Sheet. Anyone opens `results.html` -> it pulls
all picks + knobs, runs `engine.js` **in the browser**, renders live. No publish
step, no admin page. Deterministic engine = consistent, testable results; **no
runtime LLM** (any LLM use is build-time/advisory only - see "Decisions").

## Accounts / deploy

- **Personal** GitHub: `github.com/ellishapiro/campvc-planner`, branch `master`,
  served at `https://ellishapiro.github.io/campvc-planner/`. NOT the King internal
  instance, NOT a work Google account.
- Deploy = commit + `git push origin master`. GitHub Pages rebuilds in ~1 min.
- Apps Script URL lives in `config.js` (`appsScriptUrl`).

## Activity classification (the subtle part)

Each source row is classified on three independent axes, kept consistent:
- **needs_booking** - must be booked at all.
- **external** - that booking happens off-app (third-party partner link).
- **scheduled** - sits at a fixed time (placed + clash-aware) vs an open window
  (drop-in / appointment).

Decision order in `build_schedule.py` (triangulation, because no single field is
reliable):
1. `no_booking_required(desc)` text ("no booking required/needed", "just rock up",
   etc.) -> not booked; scheduled iff it has a real fixed time. This **overrides**
   a registration date (some turn-up activities still carry one).
2. else registration date present -> booked; external iff the description has a
   partner booking link; scheduled.
3. else partner link or curated `dropin_overrides.json == "bookable"` -> booked,
   external, scheduled.
4. else not booked; scheduled iff not an open window.

Other rules:
- **Off-site** = blank venue in the source (`loc == ""`), NOT a literal
  "(off-site)" string. Off-site activities get `offsiteBufferMinutes` around them.
- registration_start_date 4 Jul -> Paid/phase 1; 11 Jul -> Free/phase 2.
- **Merge** same-name activities (case-insensitive `norm(name)`) into one activity
  with multiple instances. Stable ids = `slugify(name)` so saved picks survive
  rebuilds.
- **Fungible per-day events**: `NAME_ALIASES` in `build_schedule.py` maps e.g.
  "Friday Roller Disco"/"Saturday Roller Disco" -> "Roller Disco" so they merge
  into one repeating activity. Add to that map for any similar case.
- **Garbled upstream times**: `time_overrides.json` corrects bad source times
  (e.g. Camp VC entered the Welsh class as Sun 23:15->Mon 12:05, an AM/PM typo for
  11:15-12:05). Each entry matches on `(name, full start datetime)` and sets a new
  Start/End. Applied every build; if an override stops matching (Guidebook fixed
  the row) the build prints a STALE warning so we know to remove it. This is the
  right home for the recurring "impossible time" glitches (also seen with Intro to
  Motorsport, which Guidebook later fixed themselves).

## Pick migration (don't lose friends' data)

When ids change across a rebuild, `build_migrations()` writes old-id -> new-id into
`data/migrations.js`. `store.getPicks` applies `window.MIGRATIONS` on read; on a
collision (two old ids map to one new id) it **keeps the higher priority**.
migrations.json accumulates across rebuilds so no id is ever orphaned. Always
verify migrations after any change that alters ids.

## Engine (`engine.js`)

`window.Engine.compute(schedule, picksByName, knobs, config)`.

- **Per-person exact scheduler.** For each person, branch-and-bound over their
  must+want picks: choose <=1 instance per activity, no time overlaps (incl.
  buffers), maximise total priority weight. So a higher priority is never crowded
  out by a lower one and no fittable pick is dropped. If-free picks are then
  greedily slotted into the gaps. (Replaced the old greedy engine, which left
  higher-priority picks unscheduled - see benchmark.)
- **Tiered weights** `covWeight`: must=10000, want=10, iffree=1. The huge gap
  means a **must is never traded** for togetherness or for wants; wants remain
  tradeable against each other and against togetherness.
- **Togetherness** is a soft objective, not a hard pass. A per-activity group
  "consensus" instance is rewarded; the dial (`together`, default 1) scales it.
  At default it only co-locates when free. The consensus loop can oscillate, so we
  run a few rounds and **keep the best-scoring round** (`globalScore`).
- **Three states per person, per activity.** (1) *Interest* = the pick
  (must/want/iffree). (2) *Scheduled* = engine placement; *Pinned* steers it. (3)
  *Booked* = a real external reservation the user records - the app never books, it
  only records the fact. Booked = `knobs.booked[id][person] = instanceKey` (shared).
  In `solve()` booked items are **hard pre-placements**: placed at exactly that
  instance, excluded from the B&B, never moved or dropped; must/want/if-free
  schedule around them. A must that clashes a booking yields (shown in couldn't-fit,
  not silently gone); two booked items that clash are both kept and flagged
  (`placement.conflict`). Calendar renders booked blocks **white + tick**; tapping
  any scheduled block opens an action sheet (Pin / Mark booked, per person). The
  booking-list page's tick writes the same shared `knobs.booked` (no more device-
  local `campvc_booked`), so calendar and checklist always agree.
- **Could-not-book (sold-out / missed), per person.** `knobs.couldNotBook[id][person]`
  = `"*"` (whole activity unbookable → dropped, listed under "Couldn't book") or
  `[instanceKey,...]` (specific sessions sold-out → `candInsts` drops them and the
  person reschedules to another session; only if none fits does it drop to the list).
  Engine reports it in `byPerson[n].couldNotBook`, kept distinct from `dropped`
  (couldn't-fit = ran out of clash-free time). Set from the calendar tap sheet
  (only on `booking:true` items); every mark is listed with a **Restore** in the
  "Couldn't book" section (results page) - the sole, always-reversible home for it.
- **Alternatives popover.** The block action sheet also lists other activities that
  person is interested in running at the same time, each with a one-tap **Pin** -
  the fine-tuning tool for the free-booking phase. Tapping an **empty slot** opens
  the same idea for a free gap (`openSlotMenu`): scheduled activities around then
  (pin to the instance) and drop-ins whose window covers it (pin here).
- **Window activities (appointments / drop-ins) support book / could-not-book / pin.**
  Booked window → `solve` synthesises a fixed block from the timeKey (white, others
  schedule around it); pinned window → earmarked at the chosen time
  (`placePinnedDropin`); could-not-book on a window = whole thing unavailable. Turn-up
  drop-ins (booking:false) get pin only. Any block type is now tappable.
- **SWR dirty-guard.** Once the user saves a knob edit this session (`state.dirty`),
  the in-flight background refresh no longer applies - it was silently clobbering
  just-made pins/bookings with the pre-edit server copy.
- **Pins are per-person, per-instance.** `knobs.pins[id] = { <person>: instanceKey }`
  - so people can pin the same activity to the SAME time (together) or DIFFERENT
  times (solo). Read forward via `pinMap()`: a string form pins
  `config.legacyLockPeople`; a `{key,people}` form pins each listed person to that
  key. Engine uses `pinKeyFor()`/`lockedFor()`, `candInsts(a, n)` is person-aware,
  `consensusPinKey()` seeds togetherness, `byActivity[id].lock` = the per-person map.
  Two entry points, both writing the same map: the "Do these together?" panel (set
  a shared time for the ticked people) and the calendar tap "Pin this time for X"
  (touches ONLY X - so re-pinning solo automatically drops X from a shared group
  time). Padlock shows only in a pinned person's column.
- **Explicit togetherness UX**: per-activity "Do these together?" in `results.js`
  (`renderShared`, a collapsed `details`), which pins an instance via `knobs.pins`.
  A LOCKED activity is **force-placed** for the locked people: in `solve()` its
  item weight becomes `LOCK_W` (5000) - above any want, below a must (10000) - so
  the solver drops lower/equal picks and relocates flexible ones to fit it, but
  never gives up a real must. Locked if-free picks are pulled into the B&B too (not
  the greedy fill). Status + per-instance "who's on it" come from exact placements
  (`byActivity[id].instances[].here`, `.notPlaced`); if someone still can't make a
  locked time it's because a must of theirs clashes, and the row warns and lets you
  try another instance. The abstract global dial was removed (unintuitive);
  `config.togetherness` remains the implicit baseline for un-locked co-location.
- **Knobs**: `breakMinutes`, `pins` (activity -> instanceKey), `gaps` (forced gap),
  `togetherness`. Knobs are a generic blob saved to the Sheet, shared by everyone.
- **Drop-ins** (window activities) are earmarked into free gaps within open hours
  (festival hours grey-out) - calendar only, never in booking lists.
- Output: `byPerson` (paid/free/turnup/dropins/ifTime/dropped, with who-with +
  backups + couldn't-fit reasons) and `byActivity` (group view).

## Gotchas (things that cost real time - don't reintroduce)

- **00:00 placeholder rows** and on-site blocks >=240min are junk/long windows, not
  slots (`real_slot` filter). Over-filtering once dropped Massage's windows - send
  non-slots to `windows`, don't drop them.
- **Midnight-crossing** sessions (end <= start, e.g. DJ sets) gave negative
  durations. Cap end at 24:00 for layout, keep the real end in the label; they
  still schedule as sessions.
- **dayIndex** only exists on placements, not raw instances - derive it with a
  day->index map (`dayIdx`) or sorting clusters everything on one day.
- **var-before-assignment** bugs (drop-in earliest, festival hours) silently
  produced NaN and broke drop-in earmarking. Reference config directly.
- **must-dropped-for-togetherness**: an earlier dial implementation traded away a
  must. Fixed by the tiered weights - keep must >> everything.
- **GitHub Pages caches HTML** (max-age 600), not just assets. `stamp_version.py`
  adds `?v=<timestamp>` to JS/CSS links; `sw.js` is a network-first service
  worker. Friends may need one hard refresh after a deploy.

## Commands

```bash
# Rebuild data (after schedule change). Orchestrated check+regen+build+stamp:
powershell ./update_schedule.ps1
# or just the build from existing inputs:
python build_schedule.py

# Tests
node tests/engine.test.node.js                       # 16 unit tests (vm sandbox)
node tests/e2e.mjs                                    # 25 browser tests (CDP -> Chrome), writes tests/_shots/
node tests/live-readcheck.mjs                         # read-only live sheet check
PICKS_JSON=path/to/picks.json node tests/benchmark.mjs  # engine vs exact optimum

# Cache-bust stamp (also run by update_schedule.ps1)
python stamp_version.py

# Deploy
git add -A && git commit -m "..." && git push origin master
```

To benchmark against live picks: fetch `?action=getPicks` from the Apps Script URL
into a json file, pass it as `PICKS_JSON`.

## Open decisions / parked

- Togetherness UX: now per-activity "lock shared time" (done). The numeric dial was
  removed. `config.togetherness` is the implicit baseline (1 = co-locate when free).
- LLM use, if ever: build-time/advisory only (suggest fungible merges, summarise a
  person's plan in prose). Never in the runtime scheduling path - it would break the
  accuracy + determinism guarantees that are the whole point.
- Deferred from v1: phase-two reconciliation (recompute free phase around what was
  actually booked), on-site distance zones, drag-drop calendar editing.
