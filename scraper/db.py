"""SQLite store with change tracking + full-text search.

    python -m scraper.db build     # extract every data/raw/*.json into data/phd.db
    python -m scraper.db export    # write data/listings.json (SERVER-ONLY data the site is built from)
    python -m scraper.db stats
"""
from __future__ import annotations

import json
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .extract import extract

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "phd.db"
RAW = ROOT / "data" / "raw"

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
"""
JSON_COLS = ("supervisors", "funders", "disciplines")
REGISTRY = {s["id"]: s for s in yaml.safe_load((ROOT / "scraper" / "sources.yaml").read_text())["sources"]}


def connect() -> sqlite3.Connection:
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def build():
    con = connect()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for f in sorted(RAW.glob("phdraw_*.json")):
        raw = json.loads(f.read_text())
        sid = f.stem.removeprefix("phdraw_")
        src = {**raw.get("source", {}), **REGISTRY.get(sid, {}), "id": sid}
        src.setdefault("institution", sid.title())
        seen, new, changed, kept = set(), 0, 0, 0
        for item in raw["items"]:
            rec = extract(item, src)
            if not rec or rec["url"] in seen:
                continue
            seen.add(rec["url"])
            kept += 1
            row = {k: (json.dumps(v) if k in JSON_COLS else v) for k, v in rec.items() if k != "is_open"}
            row["status"] = "open" if rec["is_open"] else "closed"
            old = con.execute("SELECT content_hash, first_seen, last_changed FROM listings WHERE url=?", (rec["url"],)).fetchone()
            row["first_seen"] = old["first_seen"] if old else now
            row["last_seen"] = now
            row["last_changed"] = now if not old or old["content_hash"] != rec["content_hash"] else old["last_changed"]
            new += not old
            changed += bool(old and old["content_hash"] != rec["content_hash"])
            cols = ",".join(row)
            con.execute(f"INSERT INTO listings ({cols}) VALUES ({','.join('?' * len(row))}) "
                        f"ON CONFLICT(url) DO UPDATE SET {','.join(f'{c}=excluded.{c}' for c in row if c not in ('url', 'first_seen'))}",
                        list(row.values()))
        # anything from this source we did not see this run has been taken down —
        # unless the crawl looks broken (0 items, or under half of what was live),
        # in which case keep the previous listings and let the manifest alert fire.
        live_before = con.execute("SELECT COUNT(*) FROM listings WHERE source_id=? AND status!='gone'", (src["id"],)).fetchone()[0]
        if kept == 0 or (live_before >= 10 and kept < live_before * 0.5):
            print(f"{src['id']:<14} SUSPECT CRAWL: kept {kept} vs {live_before} live before; not marking any as gone")
            gone = 0
        else:
            gone = con.execute(
                f"UPDATE listings SET status='gone' WHERE source_id=? AND status!='gone' AND url NOT IN ({','.join('?' * len(seen)) or 'NULL'})",
                [src["id"], *seen]).rowcount
        con.execute("INSERT INTO scrape_runs VALUES (?,?,?,?,?,?,?,?)",
                    (src["id"], now, raw.get("scraped_at"), len(raw["items"]), kept, new, changed, gone))
        print(f"{src['id']:<14} raw {len(raw['items']):>5}  kept {kept:>5}  new {new:>5}  changed {changed:>4}  gone {gone:>4}")
    con.commit()


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
    keep = ("id", "source_id", "institution", "region", "url", "title", "summary", "description", "school", "deadline",
            "deadline_text", "start", "funding", "stipend", "eligibility", "supervisors", "funders", "programme",
            "degree", "disciplines", "first_seen", "last_seen", "last_changed")
    out = []
    for r in rows(status=("open", "closed")):
        status = "closed" if r["deadline"] and r["deadline"] < today else r["status"]
        if status == "closed" and not (r["deadline"] and r["deadline"] >= cutoff):
            continue
        d = {k: r[k] for k in keep if r[k] not in (None, "", [])}
        d["status"] = status
        out.append(d)
    out.sort(key=lambda d: (d["status"] != "open", d.get("deadline") or "9999"))
    n_open = sum(d["status"] == "open" for d in out)
    meta = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "open": n_open,
            "closed_recent": len(out) - n_open,
            "institutions": len({d["institution"] for d in out if d["status"] == "open"})}
    path.write_text(json.dumps({"meta": meta, "listings": out}, ensure_ascii=False, indent=0))
    print(f"exported {n_open} open + {len(out) - n_open} recently closed -> {path} ({path.stat().st_size // 1024} KB)")


def manifest(path: Path | None = None):
    """Write _scrape_manifest.json from the latest scrape_runs, flagging broken sources.

    A source is flagged when it returns 0 adverts, or its kept count falls by more than half
    compared with its previous run (the same idea as The Grid's intelligence manifest).
    """
    path = path or ROOT / "_scrape_manifest.json"
    con = connect()
    out, alerts = {}, []
    for (sid,) in con.execute("SELECT DISTINCT source_id FROM scrape_runs"):
        runs = con.execute("SELECT * FROM scrape_runs WHERE source_id=? ORDER BY run_at DESC LIMIT 2", (sid,)).fetchall()
        cur = dict(runs[0]); prev = dict(runs[1]) if len(runs) > 1 else None
        open_now = con.execute("SELECT COUNT(*) FROM listings WHERE source_id=? AND status='open'", (sid,)).fetchone()[0]
        out[sid] = {"scraped": cur["n_raw"], "kept": cur["n_kept"], "open": open_now, "new": cur["n_new"],
                    "changed": cur["n_changed"], "gone": cur["n_gone"], "scraped_at": cur["scraped_at"]}
        if cur["n_raw"] == 0:
            alerts.append(f"{sid}: returned 0 adverts")
        elif prev and prev["n_kept"] and cur["n_kept"] < prev["n_kept"] * 0.5:
            alerts.append(f"{sid}: dropped from {prev['n_kept']} to {cur['n_kept']}")
    doc = {"run_date": datetime.now(timezone.utc).date().isoformat(), "alerts": alerts, "sources": out}
    path.write_text(json.dumps(doc, indent=2))
    print(f"manifest: {len(out)} sources, {len(alerts)} alerts")
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


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"build": build, "export": export, "stats": stats, "manifest": manifest}.get(cmd, lambda: print(search(" ".join(sys.argv[2:]))))()
