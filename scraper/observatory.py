"""Doctum Observatory: a dated snapshot of the UK PhD market, taken after every scrape.

    python -m scraper.observatory        # append today's snapshot to data/observatory.json

Run by .github/workflows/phd-scrape.yml after `scraper.db export`. scripts/pages.js reads
data/observatory.json at build time to draw /observatory/ (the trend lines and the "this week"
movement). Like listings.json, the file is committed but never published.

"New" means new to the university's website, not new to Doctum: an advert only counts
once its source has been tracked for at least one earlier run, so adding a university
never shows up as a jump in new PhDs.
"""
from __future__ import annotations

import json
import sqlite3
import statistics
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "phd.db"
LISTINGS = ROOT / "data" / "listings.json"
OUT = ROOT / "data" / "observatory.json"
KEEP = 400  # snapshots kept (about 4 years at two scrapes a week)


def snapshot(started: str) -> dict:
    today = date.today()
    now = datetime.now(timezone.utc)
    d7 = (now - timedelta(days=7)).isoformat()
    d30 = (now - timedelta(days=30)).isoformat()
    rows = [r for r in json.loads(LISTINGS.read_text(encoding="utf-8"))["listings"] if r.get("status") == "open"]
    stipends = [r["stipend"] for r in rows if r.get("stipend") and 12000 <= r["stipend"] <= 45000]

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    # Runs per source, oldest first. A run counts as a "coverage change" (crawler fixed, seeds
    # added, a university added) when it is the source's first productive run, or when it
    # finds far more new adverts than the source normally holds. Adverts first seen in such a
    # run were already on the university's site, so they are not counted as new.
    runs: dict[str, list] = {}
    for r in con.execute("SELECT source_id, run_at, n_kept, n_new FROM scrape_runs ORDER BY run_at"):
        runs.setdefault(r["source_id"], []).append(dict(r))
    coverage: dict[str, list] = {}
    for sid, rs in runs.items():
        prev_kept = 0
        for r in rs:
            if r["n_kept"] and (prev_kept == 0 or r["n_new"] > max(10, 0.4 * prev_kept)):
                coverage.setdefault(sid, []).append(r["run_at"][:16])
            prev_kept = max(prev_kept, r["n_kept"] or 0)

    def genuine(r) -> bool:
        if r["first_seen"][:10] < started:
            return False
        fs = r["first_seen"][:16]
        # the run that first saw it is the latest run of that source at or before first_seen
        mine = [x["run_at"][:16] for x in runs.get(r["source_id"], []) if x["run_at"][:16] <= fs]
        return bool(mine) and mine[-1] not in coverage.get(r["source_id"], [])

    open_ids = {r["id"] for r in rows}
    seen = [dict(r) for r in con.execute("SELECT id, source_id, first_seen, last_changed, status, deadline, last_seen FROM listings")]
    new7 = [r for r in seen if r["first_seen"] >= d7 and genuine(r)]
    new30 = [r for r in seen if r["first_seen"] >= d30 and genuine(r)]
    changed7 = [r for r in seen if (r["last_changed"] or "") >= d7 and r["first_seen"] < d7 and r["id"] in open_ids]
    t, w = today.isoformat(), (today - timedelta(days=7)).isoformat()
    closed7 = [r for r in seen if (r["status"] == "closed" or (r["deadline"] and r["deadline"] < t)) and r["deadline"] and w <= r["deadline"] < t]
    removed7 = [r for r in seen if r["status"] == "gone" and (r["last_seen"] or "") >= d7]

    return {
        "date": t,
        "open": len(rows),
        "funded": sum(r.get("funding") == "Fully funded" for r in rows),
        "intl": sum(r.get("eligibility") == "UK & International" and r.get("funding") != "Self-funded" for r in rows),
        "universities": len({r["institution"] for r in rows}),
        "median_stipend": round(statistics.median(stipends)) if stipends else None,
        "new_7d": len(new7),
        "new_30d": len(new30),
        "changed_7d": len(changed7),
        "closed_7d": len(closed7),
        "removed_7d": len(removed7),
        "new_ids": sorted(r["id"] for r in new7 if r["id"] in open_ids),
    }


def main():
    doc = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"started": date.today().isoformat(), "snapshots": []}
    s = snapshot(doc["started"])
    snaps = [x for x in doc["snapshots"] if x["date"] != s["date"]]
    for x in snaps:
        x.pop("new_ids", None)  # only the latest snapshot needs the id list
    doc["snapshots"] = (snaps + [s])[-KEEP:]
    OUT.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    print(f"observatory {s['date']}: {s['open']} open, {s['funded']} fully funded, {s['new_7d']} new this week, "
          f"{s['closed_7d']} closed, {len(doc['snapshots'])} snapshots")


if __name__ == "__main__":
    main()
