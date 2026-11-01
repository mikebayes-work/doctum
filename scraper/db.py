"""SQLite store with change tracking + full-text search.

    python -m scraper.db build     # extract every data/raw/*.json into data/phd.db
    python -m scraper.db export    # write data/listings.json (SERVER-ONLY data the site is built from)
    python -m scraper.db stats
    python -m scraper.db history   # advert history so far: changes, re-advertisements, time on market
"""
from __future__ import annotations

import json
import sqlite3
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

import yaml

from .extract import extract

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "phd.db"
RAW = ROOT / "data" / "raw"
RAW_HOME = ROOT / "data" / "raw-home"
STALE_DAYS = 21  # drop listings not re-checked for this long

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY, source_id TEXT, institution TEXT, region TEXT, url TEXT UNIQUE,
  title TEXT, summary TEXT, description TEXT, school TEXT,
  deadline TEXT, deadline_text TEXT, start TEXT, funding TEXT, stipend INTEGER, eligibility TEXT,
  supervisors TEXT, funders TEXT, programme TEXT, degree TEXT, disciplines TEXT,
  has_detail INTEGER, content_hash TEXT,
  first_seen TEXT, last_seen TEXT, last_changed TEXT,
  status TEXT  -- open | closed (deadline passed) | gone (removed from source)
);
CREATE INDEX IF NOT EXISTS ix_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS ix_listings_deadline ON listings(deadline);
CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(
  title, summary, description, school, supervisors, institution, content='listings', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS listings_ai AFTER INSERT ON listings BEGIN
  INSERT INTO listings_fts(rowid,title,summary,description,school,supervisors,institution)
  VALUES (new.rowid,new.title,new.summary,new.description,new.school,new.supervisors,new.institution); END;
CREATE TRIGGER IF NOT EXISTS listings_au AFTER UPDATE ON listings BEGIN
  INSERT INTO listings_fts(listings_fts,rowid,title,summary,description,school,supervisors,institution)
  VALUES ('delete',old.rowid,old.title,old.summary,old.description,old.school,old.supervisors,old.institution);
  INSERT INTO listings_fts(rowid,title,summary,description,school,supervisors,institution)
  VALUES (new.rowid,new.title,new.summary,new.description,new.school,new.supervisors,new.institution); END;
CREATE TABLE IF NOT EXISTS scrape_runs (
  source_id TEXT, run_at TEXT, scraped_at TEXT, n_raw INTEGER, n_kept INTEGER, n_new INTEGER, n_changed INTEGER, n_gone INTEGER);
-- Advert history (added 1 Nov 2026). The current state of an advert lives in listings; when its
-- content changes, the state it replaces is copied here first, so nothing is ever overwritten.
CREATE TABLE IF NOT EXISTS listing_history (
  listing_id TEXT, valid_from TEXT, valid_to TEXT, content_hash TEXT, title TEXT, deadline TEXT, funding TEXT,
  stipend INTEGER, eligibility TEXT, supervisors TEXT, wp TEXT, description TEXT);
CREATE INDEX IF NOT EXISTS ix_history_listing ON listing_history(listing_id);
-- One row per thing that happened to an advert after it was first seen:
--   deadline_extended | deadline_brought_forward | deadline_added | deadline_removed | funding_changed |
--   stipend_changed | eligibility_changed | supervisors_changed | title_changed | wp_changed | text_changed |
--   closed (deadline passed) | removed (taken off the site) | returned (back after removal) |
--   reopened (same page, new later deadline after closing) | readvertised (same project, new page, after
--   the earlier advert ended) | moved (same project, new page, earlier page vanished while still open)
CREATE TABLE IF NOT EXISTS listing_events (listing_id TEXT, at TEXT, kind TEXT, old TEXT, new TEXT);
CREATE INDEX IF NOT EXISTS ix_events_listing ON listing_events(listing_id);
CREATE INDEX IF NOT EXISTS ix_events_kind ON listing_events(kind, at);
"""
# Columns added after the first release. connect() adds any that are missing, then backfills once.
#   wp, wp_groups, wp_text   widening participation: "ring-fenced" | "encouraged" | "", groups, advert sentence
#   project_key              normalised institution + title, to recognise the same project advertised again
#   deadline_first           the deadline when Doctum first saw the advert
#   deadline_changes         how many times the deadline has moved
#   closed_at / gone_at      date the deadline passed / date the advert was taken down
#   advert_since             when this project was first advertised (carried across "moved" pages)
#   censored                 1 = already on the site when Doctum started tracking that source, so the
#                            true start date is unknown (excluded from time-on-market figures)
#   previous_id              the earlier advert for the same project (readvertised or moved)
#   readvert_count           how many times this project has been advertised again after ending
#   returned_count           how many times the page came back after being taken down
#   versions                 number of distinct content versions seen (1 = never changed)
EXTRA_COLS = {
    "wp": "TEXT", "wp_groups": "TEXT", "wp_text": "TEXT", "project_key": "TEXT",
    "deadline_first": "TEXT", "deadline_changes": "INTEGER DEFAULT 0", "closed_at": "TEXT", "gone_at": "TEXT",
    "advert_since": "TEXT", "censored": "INTEGER DEFAULT 0", "previous_id": "TEXT",
    "readvert_count": "INTEGER DEFAULT 0", "returned_count": "INTEGER DEFAULT 0", "versions": "INTEGER DEFAULT 1",
}
INSERT_ONLY = ("url", "first_seen", "deadline_first", "advert_since", "censored", "previous_id")
JSON_COLS = ("supervisors", "funders", "disciplines", "wp_groups")
REGISTRY = {s["id"]: s for s in yaml.safe_load((ROOT / "scraper" / "sources.yaml").read_text(encoding="utf-8"))["sources"]}


def connect() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    have = {r[1] for r in con.execute("PRAGMA table_info(listings)")}
    missing = [c for c in EXTRA_COLS if c not in have]
    for c in missing:
        con.execute(f"ALTER TABLE listings ADD COLUMN {c} {EXTRA_COLS[c]}")
    con.execute("CREATE INDEX IF NOT EXISTS ix_listings_project ON listings(project_key)")
    if "project_key" in missing and con.execute("SELECT COUNT(*) FROM listings").fetchone()[0]:
        backfill(con)
    return con


def build():
    con = connect()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    files = sorted(RAW.glob("phdraw_*.json"))
    # sources crawled from Mike's PC (runner: home) are committed to data/raw-home/. Use them only while
    # fresh, so a PC that was off doesn't keep re-applying an old crawl. Same-named files in raw/ win.
    cutoff = datetime.now(timezone.utc).timestamp() - 4 * 86400
    have = {f.name for f in files}
    for f in sorted(RAW_HOME.glob("phdraw_*.json")):
        if f.name in have:
            continue
        try:
            at = datetime.fromisoformat(json.loads(f.read_text(encoding="utf-8")).get("scraped_at", "")).timestamp()
        except ValueError:
            at = 0
        if at >= cutoff:
            files.append(f)
        else:
            print(f"{f.stem.removeprefix('phdraw_'):<14} skipped: home crawl is more than 4 days old")
    today = date.today().isoformat()
    for f in files:
        raw = json.loads(f.read_text(encoding="utf-8"))
        sid = f.stem.removeprefix("phdraw_")
        src = {**raw.get("source", {}), **REGISTRY.get(sid, {}), "id": sid}
        src.setdefault("institution", sid.title())
        prior_best = con.execute("SELECT MAX(n_kept) FROM scrape_runs WHERE source_id=?", (sid,)).fetchone()[0] or 0
        seen, new, changed, kept = set(), 0, 0, 0
        for item in raw["items"]:
            rec = extract(item, src)
            if not rec or rec["url"] in seen:
                continue
            seen.add(rec["url"])
            kept += 1
            row = {k: (json.dumps(v) if k in JSON_COLS else v) for k, v in rec.items() if k != "is_open"}
            row["status"] = "open" if rec["is_open"] else "closed"
            old = con.execute("SELECT * FROM listings WHERE url=?", (rec["url"],)).fetchone()
            row["first_seen"] = old["first_seen"] if old else now
            row["last_seen"] = now
            row["last_changed"] = now if not old or old["content_hash"] != rec["content_hash"] else old["last_changed"]
            track(con, old and dict(old), rec, row, now, today)
            new += not old
            changed += bool(old and old["content_hash"] != rec["content_hash"])
            cols = ",".join(row)
            con.execute(f"INSERT INTO listings ({cols}) VALUES ({','.join('?' * len(row))}) "
                        f"ON CONFLICT(url) DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in row if c not in INSERT_ONLY)}",
                        list(row.values()))
        # anything from this source we did not see this run has been taken down —
        # unless the crawl looks broken (0 items, or under half of what was live),
        # in which case keep the previous listings and let the manifest alert fire.
        live_before = con.execute("SELECT COUNT(*) FROM listings WHERE source_id=? AND status!='gone'", (src["id"],)).fetchone()[0]
        if kept == 0 or (live_before >= 10 and kept < live_before * 0.5):
            if live_before:  # a source that has never worked isn't suspect, just not tuned yet
                print(f"{src['id']:<14} SUSPECT CRAWL: kept {kept} vs {live_before} live before; not marking any as gone")
            gone = 0
        else:
            ph = ",".join("?" * len(seen)) or "NULL"
            ids = [r[0] for r in con.execute(
                f"SELECT id FROM listings WHERE source_id=? AND status!='gone' AND url NOT IN ({ph})", [src["id"], *seen])]
            for lid in ids:
                con.execute("UPDATE listings SET status='gone', gone_at=?, closed_at=COALESCE(closed_at, ?) WHERE id=?",
                            (now, now[:10], lid))
                con.execute("INSERT INTO listing_events VALUES (?,?,?,?,?)", (lid, now, "removed", None, None))
            gone = len(ids)
        # Adverts found in a coverage change (the source's first productive run, a fixed crawler, new
        # seeds) were already on the university's site: their real start date is unknown.
        if new and (prior_best == 0 or new > max(10, 0.4 * prior_best)):
            con.execute("UPDATE listings SET censored=1 WHERE source_id=? AND first_seen=? AND previous_id IS NULL", (sid, now))
        con.execute("INSERT INTO scrape_runs VALUES (?,?,?,?,?,?,?,?)",
                    (src["id"], now, raw.get("scraped_at"), len(raw["items"]), kept, new, changed, gone))
        print(f"{src['id']:<14} raw {len(raw['items']):>5}  kept {kept:>5}  new {new:>5}  changed {changed:>4}  gone {gone:>4}")
    close_passed(con, today)
    n_re = link_readverts(con, since=now)
    if n_re:
        print(f"re-advertised or moved projects found this run: {n_re}")
    con.commit()


# ---------------------------------------------------------------- history
TRACKED = ("title", "deadline", "funding", "stipend", "eligibility", "supervisors", "wp")


def _event(con, lid, at, kind, old=None, new=None):
    con.execute("INSERT INTO listing_events VALUES (?,?,?,?,?)",
                (lid, at, kind, None if old is None else str(old), None if new is None else str(new)))


def track(con, old: dict | None, rec: dict, row: dict, now: str, today: str):
    """Fill the history columns of `row` and log what changed since `old` (the stored row, or None)."""
    lid = rec["id"]
    if not old:
        # an advert that is already past its deadline when first seen (old pages left up, sitemap
        # finds) tells us nothing about how long adverts stay open
        row.update(deadline_first=rec["deadline"], advert_since=now, censored=0 if rec["is_open"] else 1, deadline_changes=0, versions=1,
                   readvert_count=0, returned_count=0, closed_at=None if rec["is_open"] else (rec["deadline"] or today),
                   gone_at=None)
        return
    for k in ("deadline_changes", "versions", "readvert_count", "returned_count"):
        row[k] = old.get(k) or 0
    row["versions"] = row["versions"] or 1
    row["closed_at"], row["gone_at"] = old.get("closed_at"), old.get("gone_at")
    # Back after being taken down?
    if old["status"] == "gone":
        _event(con, lid, now, "returned")
        row["returned_count"] += 1
        row["gone_at"] = None
        row["closed_at"] = None if rec["is_open"] else row["closed_at"]
    # wp is NULL until an advert has been tagged from its full page (rows stored before 1 Nov 2026):
    # filling it in for the first time is not a change to the advert.
    wp_changed = old.get("wp") is not None and (old.get("wp") or "") != (rec["wp"] or "")
    if old["content_hash"] != rec["content_hash"] or wp_changed:
        # keep the state being replaced
        con.execute("INSERT INTO listing_history VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (lid, old["last_changed"], now, old["content_hash"], old["title"], old["deadline"], old["funding"],
                     old["stipend"], old["eligibility"], old["supervisors"], old.get("wp"), old["description"]))
        row["versions"] += 1
        logged = False
        od, nd = old["deadline"], rec["deadline"]
        if od != nd:
            logged = True
            row["deadline_changes"] += 1
            kind = ("deadline_added" if not od else "deadline_removed" if not nd
                    else "deadline_extended" if nd > od else "deadline_brought_forward")
            closed_before = od and od < today
            if kind == "deadline_extended" and closed_before and rec["is_open"]:
                kind = "reopened"  # the same page, advertised again with a new deadline
                row["readvert_count"] += 1
                row["closed_at"] = None
            _event(con, lid, now, kind, od, nd)
        for k in ("funding", "stipend", "eligibility", "title", "wp"):
            if k == "wp" and not wp_changed:
                continue
            if (old.get(k) or "") != (rec[k] or ""):
                logged = True
                _event(con, lid, now, f"{k}_changed", old.get(k), rec[k])
        if json.loads(old["supervisors"] or "[]") != rec["supervisors"]:
            logged = True
            _event(con, lid, now, "supervisors_changed", old["supervisors"], json.dumps(rec["supervisors"]))
        if not logged:
            _event(con, lid, now, "text_changed")
    if rec["is_open"]:
        row["closed_at"] = None  # open now (a closed episode, if any, is in listing_events)
    elif not row["closed_at"]:
        row["closed_at"] = rec["deadline"] or today
        _event(con, lid, row["closed_at"], "closed")


def close_passed(con, today: str):
    """Adverts whose deadline has passed since they were last read (the page may not be re-crawled)."""
    for r in con.execute("SELECT id, deadline FROM listings WHERE closed_at IS NULL AND deadline IS NOT NULL AND deadline < ?",
                         (today,)).fetchall():
        con.execute("UPDATE listings SET closed_at=? WHERE id=?", (r["deadline"], r["id"]))
        _event(con, r["id"], r["deadline"], "closed")


def link_readverts(con, since: str | None = None) -> int:
    """Link adverts to an earlier advert for the same project (same institution and title key).

    readvertised: the earlier advert had ended (deadline passed or taken down) before this one appeared.
    moved:        the earlier page vanished in the same run this one appeared, while still open
                  (a site reorganisation, not a new round), so the advert's start date carries over.
    """
    q = "SELECT * FROM listings WHERE project_key IS NOT NULL AND previous_id IS NULL"
    args = []
    if since:
        q += " AND first_seen>=?"
        args.append(since)
    found = 0
    for r in con.execute(q + " ORDER BY first_seen", args).fetchall():
        if r["deadline"] and r["deadline"] < r["first_seen"][:10]:
            continue  # an old, already-closed page: not a new round of advertising
        e = con.execute(
            "SELECT * FROM listings WHERE project_key=? AND id!=? AND first_seen<? "
            "AND (closed_at IS NOT NULL OR gone_at IS NOT NULL) ORDER BY first_seen DESC LIMIT 1",
            (r["project_key"], r["id"], r["first_seen"])).fetchone()
        if not e:
            continue
        ended = min(x for x in (e["closed_at"], e["gone_at"] and e["gone_at"][:10]) if x)
        if ended > r["first_seen"][:10]:
            continue  # the earlier one was still running when this one appeared: a duplicate, not a re-run
        gone_same_time = e["gone_at"] and abs((datetime.fromisoformat(r["first_seen"]) - datetime.fromisoformat(e["gone_at"])).days) <= 1
        moved = bool(gone_same_time and (not e["deadline"] or e["deadline"] >= r["first_seen"][:10]))
        if moved:
            con.execute("UPDATE listings SET previous_id=?, readvert_count=?, advert_since=?, censored=? WHERE id=?",
                        (e["id"], e["readvert_count"] or 0, e["advert_since"] or e["first_seen"], e["censored"] or 0, r["id"]))
            _event(con, r["id"], r["first_seen"], "moved", e["id"], r["id"])
        else:
            con.execute("UPDATE listings SET previous_id=?, readvert_count=?, censored=0 WHERE id=?",
                        (e["id"], (e["readvert_count"] or 0) + 1, r["id"]))
            _event(con, r["id"], r["first_seen"], "readvertised", e["id"], r["id"])
        found += 1
    return found


def backfill(con):
    """One-off: fill the history columns for adverts stored before they existed (1 Nov 2026)."""
    from .extract import project_key
    today = date.today().isoformat()
    print("backfilling advert history columns...")
    rows_ = con.execute("SELECT id, title, institution, summary, description, deadline, first_seen, last_seen, status, source_id FROM listings").fetchall()
    # the run that first saw each advert, and whether that run was a coverage change (same rule as build())
    runs: dict[str, list] = {}
    for r in con.execute("SELECT source_id, run_at, n_kept, n_new FROM scrape_runs ORDER BY run_at"):
        runs.setdefault(r["source_id"], []).append(dict(r))
    coverage: dict[str, set] = {}
    for sid, rs in runs.items():
        best = 0
        for r in rs:
            if r["n_new"] and (best == 0 or r["n_new"] > max(10, 0.4 * best)):
                coverage.setdefault(sid, set()).add(r["run_at"])
            best = max(best, r["n_kept"] or 0)
    for r in rows_:
        mine = [x["run_at"] for x in runs.get(r["source_id"], []) if x["run_at"] <= r["first_seen"]]
        born_closed = bool(r["deadline"] and r["deadline"] < r["first_seen"][:10])
        censored = 1 if born_closed or not mine or mine[-1] in coverage.get(r["source_id"], set()) else 0
        closed = r["deadline"] if r["deadline"] and r["deadline"] < today else None
        gone_at = r["last_seen"] if r["status"] == "gone" else None
        if gone_at and not closed:
            closed = gone_at[:10]
        # wp is left NULL: the next scrape tags it from the full advert page (the stored text is only an excerpt)
        con.execute("UPDATE listings SET project_key=?, deadline_first=deadline, deadline_changes=0, "
                    "closed_at=?, gone_at=?, advert_since=first_seen, censored=?, readvert_count=0, returned_count=0, versions=1 WHERE id=?",
                    (project_key(r["title"] or "", r["institution"] or ""), closed, gone_at, censored, r["id"]))
    n = link_readverts(con)
    con.commit()
    print(f"backfilled {len(rows_)} adverts; {n} linked to an earlier advert for the same project")


def rows(status=("open",)):
    con = connect()
    q = f"SELECT * FROM listings WHERE status IN ({','.join('?' * len(status))}) ORDER BY deadline IS NULL, deadline"
    for r in con.execute(q, status):
        d = dict(r)
        for c in JSON_COLS:
            d[c] = json.loads(d[c] or "[]")
        yield d


def export(path: Path | None = None):
    """Write data/listings.json: open listings plus ones closed in the last 60 days.

    This file is committed to the repo but NEVER published: scripts/build.js turns it into
    a server-only module for the edge functions and builds public pages from an allowlist
    of fields. Status is recomputed against today's date so adverts whose deadline passed
    since the last scrape drop out even before the next scrape.
    """
    from datetime import date, timedelta
    path = path or ROOT / "data" / "listings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    cutoff = (date.today() - timedelta(days=60)).isoformat()
    # A listing we haven't been able to re-check for STALE_DAYS (its source is blocked or broken)
    # is left out of the site rather than shown as open on old information.
    stale = (datetime.now(timezone.utc) - timedelta(days=STALE_DAYS)).isoformat()
    keep = ("id", "source_id", "institution", "region", "url", "title", "summary", "description", "school", "deadline",
            "deadline_text", "start", "funding", "stipend", "eligibility", "supervisors", "funders", "programme",
            "degree", "disciplines", "first_seen", "last_seen", "last_changed",
            # widening participation (public: shown on listing pages and the hub)
            "wp", "wp_groups", "wp_text",
            # history (server only: the Observatory shows sector totals, never per-advert history)
            "advert_since", "closed_at", "deadline_first", "deadline_changes", "readvert_count", "previous_id", "censored", "versions")
    out = []
    for r in rows(status=("open", "closed")):
        status = "closed" if r["deadline"] and r["deadline"] < today else r["status"]
        if status == "closed" and not (r["deadline"] and r["deadline"] >= cutoff):
            continue
        if (r["last_seen"] or "") < stale:
            continue
        d = {k: r[k] for k in keep if r.get(k) not in (None, "", [], 0)}
        d["status"] = status
        out.append(d)
    out.sort(key=lambda d: (d["status"] != "open", d.get("deadline") or "9999"))
    n_open = sum(d["status"] == "open" for d in out)
    meta = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "open": n_open,
            "closed_recent": len(out) - n_open,
            "institutions": len({d["institution"] for d in out if d["status"] == "open"})}
    path.write_text(json.dumps({"meta": meta, "listings": out}, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"exported {n_open} open + {len(out) - n_open} recently closed -> {path} ({path.stat().st_size // 1024} KB)")
    if path == ROOT / "data" / "listings.json":
        export_history()


def export_history(path: Path | None = None):
    """Write data/history.json: every tracked advert's history, for the private university reports.

    Committed like listings.json but NEVER published (build.js only copies an allowlist). One compact
    row per advert, all statuses, with the events that matter for reports. Field names are short to
    keep the file small: see HISTORY_FIELDS.
    """
    path = path or ROOT / "data" / "history.json"
    con = connect()
    ev: dict[str, list] = {}
    for r in con.execute("SELECT listing_id, at, kind FROM listing_events WHERE kind IN "
                         "('deadline_extended','deadline_brought_forward','readvertised','reopened','moved','removed',"
                         "'returned','funding_changed','stipend_changed','eligibility_changed') ORDER BY at"):
        ev.setdefault(r["listing_id"], []).append([r["kind"], r["at"][:10]])
    out = []
    for r in con.execute("SELECT * FROM listings ORDER BY first_seen"):
        d = dict(r)
        if d["deadline"] and d["deadline"] < (d["first_seen"] or "")[:10]:
            continue  # an old page already past its deadline when found: never a live advert while tracked
        disc = json.loads(d.get("disciplines") or "[]")
        out.append({
            "id": d["id"], "inst": d["institution"], "title": d["title"], "funding": d["funding"],
            "disc": disc[0] if disc else "", "status": d["status"],
            "since": (d.get("advert_since") or d["first_seen"] or "")[:10], "first_seen": (d["first_seen"] or "")[:10],
            "last_seen": (d["last_seen"] or "")[:10], "closed": d.get("closed_at"), "gone": (d.get("gone_at") or "")[:10] or None,
            "deadline": d["deadline"], "deadline_first": d.get("deadline_first"), "dl_changes": d.get("deadline_changes") or 0,
            "censored": d.get("censored") or 0, "prev": d.get("previous_id"), "readverts": d.get("readvert_count") or 0,
            "versions": d.get("versions") or 1, "wp": d.get("wp") or "", "events": ev.get(d["id"], []),
        })
        # leave out empty and default values (the report treats a missing field as empty/0)
        out[-1] = {k: v for k, v in out[-1].items() if v not in (None, "", [], 0) and not (k == "versions" and v == 1)}
    meta = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tracking_from": "2026-11-01",
            "adverts": len(out)}
    path.write_text(json.dumps({"meta": meta, "adverts": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"history: {len(out)} adverts -> {path} ({path.stat().st_size // 1024} KB)")


def manifest(path: Path | None = None):
    """Write _scrape_manifest.json from the latest scrape_runs, flagging broken sources.

    A source is flagged when it returns 0 adverts, or its kept count falls by more than half
    compared with its previous run (the same idea as The Grid's intelligence manifest).
    """
    path = path or ROOT / "_scrape_manifest.json"
    con = connect()
    out, alerts, pending = {}, [], {}
    for (sid,) in con.execute("SELECT DISTINCT source_id FROM scrape_runs"):
        runs = con.execute("SELECT * FROM scrape_runs WHERE source_id=? ORDER BY run_at DESC LIMIT 2", (sid,)).fetchall()
        cur = dict(runs[0]); prev = dict(runs[1]) if len(runs) > 1 else None
        open_now = con.execute("SELECT COUNT(*) FROM listings WHERE source_id=? AND status='open'", (sid,)).fetchone()[0]
        out[sid] = {"scraped": cur["n_raw"], "kept": cur["n_kept"], "open": open_now, "new": cur["n_new"],
                    "changed": cur["n_changed"], "gone": cur["n_gone"], "scraped_at": cur["scraped_at"]}
        ever = con.execute("SELECT MAX(n_kept) FROM scrape_runs WHERE source_id=?", (sid,)).fetchone()[0] or 0
        why = ""
        f = RAW / f"phdraw_{sid}.json"
        if not f.exists():
            f = RAW_HOME / f"phdraw_{sid}.json"
        if f.exists():
            why = json.loads(f.read_text(encoding="utf-8")).get("problem", "")
        if ever == 0:
            # never produced a listing: a new source still to be tuned, not a breakage
            pending[sid] = why or "crawled, but no page read like a PhD advert"
        elif cur["n_raw"] == 0:
            alerts.append(f"{sid}: returned 0 adverts" + (f" ({why})" if why else ""))
        elif prev and prev["n_kept"] and cur["n_kept"] < prev["n_kept"] * 0.5:
            alerts.append(f"{sid}: dropped from {prev['n_kept']} to {cur['n_kept']}")
    for sid in [s for s in out if s in pending]:
        del out[sid]
    skipped = {sid: s["disabled"] for sid, s in REGISTRY.items() if s.get("disabled")}
    doc = {"run_date": datetime.now(timezone.utc).date().isoformat(), "alerts": alerts, "sources": out,
           "not_working_yet": pending, "skipped": skipped}
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"manifest: {len(out)} working sources, {len(pending)} not working yet, {len(skipped)} skipped, {len(alerts)} alerts")
    for a in alerts:
        print("ALERT", a)
    return alerts


def search(q: str, limit=10):
    con = connect()
    return [dict(r) for r in con.execute(
        "SELECT l.title, l.institution, l.funding, l.deadline FROM listings_fts f JOIN listings l ON l.rowid=f.rowid "
        "WHERE listings_fts MATCH ? AND l.status='open' ORDER BY rank LIMIT ?", (q, limit))]


def stats():
    data = list(rows())
    print("open listings:", len(data))
    for k in ("institution", "funding", "eligibility", "degree", "programme"):
        print(f"\n{k}:", Counter(d[k] for d in data).most_common(15))
    print("\ndisciplines:", Counter(x for d in data for x in d["disciplines"][:1]).most_common())
    print("\nwith deadline:", sum(bool(d["deadline"]) for d in data), " stipend:", sum(bool(d["stipend"]) for d in data),
          " supervisors:", sum(bool(d["supervisors"]) for d in data), " start:", sum(bool(d["start"]) for d in data),
          " summary:", sum(bool(d["summary"]) for d in data))


def history():
    """Print what the history tables say so far."""
    con = connect()
    print("events:", dict(con.execute("SELECT kind, COUNT(*) FROM listing_events GROUP BY kind ORDER BY 2 DESC").fetchall()))
    print("superseded versions stored:", con.execute("SELECT COUNT(*) FROM listing_history").fetchone()[0])
    print("adverts linked to an earlier one:", dict(con.execute(
        "SELECT e.kind, COUNT(*) FROM listing_events e WHERE kind IN ('readvertised','moved','reopened') GROUP BY kind").fetchall()))
    print("widening participation (open):", dict(con.execute(
        "SELECT wp, COUNT(*) FROM listings WHERE status='open' AND wp!='' GROUP BY wp").fetchall()))
    days = [r[0] for r in con.execute(
        "SELECT julianday(closed_at) - julianday(substr(advert_since,1,10)) FROM listings "
        "WHERE closed_at IS NOT NULL AND censored=0 AND advert_since IS NOT NULL AND first_seen!=last_seen")]
    days = sorted(d for d in days if d is not None and d >= 0)
    print(f"time on market (closed, start date known): n={len(days)}"
          + (f", median {days[len(days) // 2]:.0f} days" if days else ""))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"build": build, "export": export, "stats": stats, "manifest": manifest, "history": history}.get(cmd, lambda: print(search(" ".join(sys.argv[2:]))))()
