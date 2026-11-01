"""Offline test of advert history and widening participation tagging.

    python -m scraper.test_history

Runs three fake scrapes of one source into a throwaway database and checks the events,
the superseded versions, re-advertisement / moved links, closing dates and the WP tag.
Nothing in data/ is touched.
"""
from __future__ import annotations

import json
import tempfile
from datetime import date, timedelta
from pathlib import Path

from . import db

TODAY = date.today()
FUT = (TODAY + timedelta(days=60)).strftime("%d %B %Y")
LATER = (TODAY + timedelta(days=90)).strftime("%d %B %Y")
PAST = (TODAY - timedelta(days=3)).strftime("%d %B %Y")


def advert(url, title, deadline, extra=""):
    text = (f"{title}\n Supervisor: Dr Jane Smith\n Funding: Fully funded studentship covering fees and a stipend of £21,805.\n"
            f" Application deadline: {deadline}\n Start date: October 2027\n Eligibility: open to UK and international applicants.\n"
            f" How to apply: apply online. This PhD project will develop new methods in the field. {extra}")
    return {"url": url, "list_title": title, "h1": title, "text": text, "list_snippet": ""}


A = "Hydrogen embrittlement in additively manufactured aerospace alloys"
B = "Machine learning for tyre degradation prediction in endurance racing"
C = "Low carbon cement replacements from recycled glass waste streams"
WP = ("We are committed to widening participation in postgraduate study. "
      "Therefore, this studentship is only available to applicants who meet at least one of the eligibility criteria.")


def scrape(raw_dir: Path, n: int, items: list[dict]):
    (raw_dir / "phdraw_cranfield.json").write_text(json.dumps(
        {"source": {"id": "cranfield", "institution": "Cranfield University"}, "scraped_at": f"2026-11-0{n}T05:00:00+00:00",
         "items": items}), encoding="utf-8")
    db.build()


def main():
    tmp = Path(tempfile.mkdtemp())
    db.DB, db.RAW, db.RAW_HOME = tmp / "phd.db", tmp / "raw", tmp / "raw-home"
    db.RAW.mkdir()
    db.RAW_HOME.mkdir()
    # timestamps must differ between runs
    import time

    scrape(db.RAW, 1, [advert("https://x/a", A, FUT), advert("https://x/b", B, FUT), advert("https://x/c", C, PAST),
                       advert("https://x/d", "Sustainable aviation fuels from municipal solid waste", FUT, WP)])
    time.sleep(1.1)
    # run 2: A's deadline extended and stipend changed; B moves to a new page; C still closed
    a2 = advert("https://x/a", A, LATER)
    a2["text"] = a2["text"].replace("£21,805", "£23,000")
    scrape(db.RAW, 2, [a2, advert("https://x/b-new", B, FUT), advert("https://x/c", C, PAST),
                       advert("https://x/d", "Sustainable aviation fuels from municipal solid waste", FUT, WP)])
    time.sleep(1.1)
    # run 3: C, which had closed, is advertised again on a new page
    scrape(db.RAW, 3, [a2, advert("https://x/b-new", B, FUT), advert("https://x/c-2027", C + " (2027 entry)", FUT),
                       advert("https://x/d", "Sustainable aviation fuels from municipal solid waste", FUT, WP)])

    con = db.connect()
    # an advert stored before tagging existed (wp NULL) that gets tagged on the next scrape: not a change
    con.execute("UPDATE listings SET wp=NULL WHERE url='https://x/d'")
    con.commit()
    time.sleep(1.1)
    scrape(db.RAW, 4, [a2, advert("https://x/b-new", B, FUT), advert("https://x/c-2027", C + " (2027 entry)", FUT),
                       advert("https://x/d", "Sustainable aviation fuels from municipal solid waste", FUT, WP)])
    con = db.connect()
    by_url = {r["url"]: dict(r) for r in con.execute("SELECT * FROM listings")}
    kinds = lambda url: [r[0] for r in con.execute("SELECT kind FROM listing_events WHERE listing_id=? ORDER BY rowid", (by_url[url]["id"],))]
    checks = []

    def check(name, ok):
        checks.append((name, bool(ok)))

    a = by_url["https://x/a"]
    check("A: deadline extended and stipend change logged", kinds("https://x/a") == ["deadline_extended", "stipend_changed"])
    check("A: old version kept", con.execute("SELECT COUNT(*) FROM listing_history WHERE listing_id=?", (a["id"],)).fetchone()[0] == 1)
    check("A: deadline_first kept, 1 change, 2 versions", a["deadline_first"] < a["deadline"] and a["deadline_changes"] == 1 and a["versions"] == 2)
    b, b2 = by_url["https://x/b"], by_url["https://x/b-new"]
    check("B: old page removed", b["status"] == "gone" and "removed" in kinds("https://x/b"))
    check("B: new page linked as moved, start date carried over",
          b2["previous_id"] == b["id"] and kinds("https://x/b-new") == ["moved"] and b2["advert_since"] == b["advert_since"]
          and b2["readvert_count"] == 0)
    c, c2 = by_url["https://x/c"], by_url["https://x/c-2027"]
    check("C: born closed, so excluded from time on market", c["censored"] == 1 and c["closed_at"])
    check("C: new page after closing = readvertised", c2["previous_id"] == c["id"] and c2["readvert_count"] == 1
          and kinds("https://x/c-2027") == ["readvertised"])
    d = by_url["https://x/d"]
    check("D: ring-fenced widening participation", d["wp"] == "ring-fenced" and "Widening participation" in json.loads(d["wp_groups"]))
    check("A: not widening participation", not a["wp"])
    check("D: first tagging logged no change", kinds("https://x/d") == [] and d["versions"] == 1)
    for name, ok in checks:
        print(("PASS " if ok else "FAIL ") + name)
    if not all(ok for _, ok in checks):
        raise SystemExit(1)
    print(f"all {len(checks)} history checks passed")


if __name__ == "__main__":
    main()
