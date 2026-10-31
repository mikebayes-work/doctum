"""Polite, config-driven crawler. Writes data/raw/phdraw_<id>.json in the same format as the
browser bootstrap crawler, so extract.py doesn't care which one produced the file.

    python -m scraper.crawl                 # all sources
    python -m scraper.crawl cranfield qub   # just these
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
import yaml
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
import os
# Identify the crawler honestly. Set CRAWLER_CONTACT (a GitHub secret) to a real address before going live.
UA = f"DoctumBot/1.0 (+https://doctum.co.uk/about/#sources; contact: {os.environ.get('CRAWLER_CONTACT', 'hello@doctum.co.uk')})"
BLOCK_TAGS = "p,li,h1,h2,h3,h4,h5,h6,div,br,tr,dt,dd,section,td,th".split(",")
DROP_TAGS = ["script", "style", "noscript", "svg", "iframe", "form", "nav", "button"]

session = requests.Session()
session.headers["User-Agent"] = UA
_robots: dict[str, urllib.robotparser.RobotFileParser] = {}


def load_sources() -> list[dict]:
    return yaml.safe_load((ROOT / "scraper" / "sources.yaml").read_text())["sources"]


def allowed(url: str) -> bool:
    host = urlparse(url).scheme + "://" + urlparse(url).netloc
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser(host + "/robots.txt")
        try:
            rp.read()
        except Exception:
            rp = None
        _robots[host] = rp
    rp = _robots[host]
    return True if rp is None else rp.can_fetch(UA, url)


def get(url: str) -> BeautifulSoup:
    if not allowed(url):
        raise PermissionError(f"robots.txt disallows {url}")
    r = session.get(url, timeout=30)
    r.raise_for_status()
    return BeautifulSoup(r.text, "lxml")


def clean(s: str) -> str:
    s = re.sub(r"[ \t ]+", " ", s or "")
    s = re.sub(r"\s*\n\s*", "\n", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def text_of(el) -> str:
    el = BeautifulSoup(str(el), "lxml")
    for t in el(DROP_TAGS):
        t.decompose()
    for t in el.find_all(attrs={"aria-hidden": "true"}):
        t.decompose()
    for t in el.find_all(BLOCK_TAGS):
        t.append("\n")
    return clean(el.get_text())


def main_el(doc: BeautifulSoup, sel: str | None = None):
    return (sel and doc.select_one(sel)) or doc.select_one(
        "main,[role=main],#main-content,#main,article,#content,.content") or doc.body


def list_urls(cfg: dict) -> list[str]:
    urls = list(cfg.get("lists", []))
    if p := cfg.get("pages"):
        urls += [p["url"].replace("{page}", str(i)) for i in range(p["from"], p["to"] + 1)]
    if hub := cfg.get("hub"):  # expand a hub page into more listing pages
        doc = get(hub)
        hub_re = re.compile(cfg["hub_link"])
        urls += [urljoin(hub, a["href"]) for a in doc.select("a[href]") if hub_re.search(urljoin(hub, a["href"]))]
    return list(dict.fromkeys(urls))


def crawl_links(cfg: dict) -> list[dict]:
    link_re, ex_re = re.compile(cfg["link"]), re.compile(cfg["exclude"]) if cfg.get("exclude") else None
    seen: dict[str, dict] = {}
    for lu in list_urls(cfg):
        try:
            doc = get(lu)
        except Exception as e:
            print("  list error", lu, e)
            continue
        added = 0
        cards = {id(c) for c in doc.select(cfg.get("card", "li,article,tr,.card,.teaser,.result"))}
        for a in doc.select((cfg.get("scope", "") + " a[href]").strip()):
            h = urljoin(lu, a["href"]).split("#")[0]
            if not link_re.search(h) or (ex_re and ex_re.search(h)) or h == lu:
                continue
            t = clean(a.get_text(" "))
            card = next((p for p in a.parents if id(p) in cards), None)  # closest(card selector)
            s = clean(card.get_text("\n")).replace("\n", " | ")[:600] if card else ""
            o = seen.setdefault(h, {"url": h, "list_title": "", "list_snippet": ""})
            added += o["list_title"] == "" and o["list_snippet"] == ""
            if len(t) > len(o["list_title"]):
                o["list_title"] = t
            if len(s) > len(o["list_snippet"]):
                o["list_snippet"] = s
        time.sleep(cfg.get("delay", 250) / 1000)
        if cfg.get("stopWhenEmpty") and not added:
            break
    items = list(seen.values())[: cfg.get("max", 400)]
    detail_if = re.compile(cfg["detailIf"], re.I) if cfg.get("detailIf") else None

    def detail(it):
        if cfg.get("detail") is False or (detail_if and not detail_if.search(it["list_snippet"])):
            return it
        try:
            d = get(it["url"])
            it["h1"] = clean(d.h1.get_text(" ")) if d.h1 else ""
            og = d.find("meta", property="og:title")
            it["og_title"] = (og and og.get("content")) or (d.title.string if d.title else "")
            md = d.find("meta", attrs={"name": "description"}) or d.find("meta", property="og:description")
            it["meta"] = (md and md.get("content")) or ""
            it["text"] = text_of(main_el(d, cfg.get("main")))[:9000]
        except Exception as e:
            it["error"] = str(e)
        time.sleep(cfg.get("delay", 250) / 1000)
        return it

    with ThreadPoolExecutor(cfg.get("conc", 3)) as ex:
        return list(ex.map(detail, items))


def slug(s: str) -> str:
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))[:80]


def crawl_inline(cfg: dict) -> list[dict]:
    items = []
    for lu in list_urls(cfg):
        try:
            d = get(lu)
        except Exception as e:
            print("  list error", lu, e)
            continue
        root = main_el(d, cfg.get("main"))
        if cfg["mode"] == "accordion":
            id_re = re.compile(cfg["idRe"])
            for a in root.select('a[href*="#"]'):
                pid = a["href"].split("#", 1)[1]
                p = d.find(id=pid) if pid and id_re.search(pid) else None
                if p:
                    t = clean(a.get_text(" "))
                    items.append({"url": lu.split("#")[0] + "#" + pid, "list_title": t, "h1": t,
                                  "text": t + "\n" + text_of(p)[:9000], "list_snippet": ""})
        else:  # headings
            skip = re.compile(cfg["skip"], re.I) if cfg.get("skip") else None
            for h in root.select(cfg["head"]):
                t = clean(h.get_text(" "))
                if not t or (skip and skip.search(t)):
                    continue
                el = h
                while el.find_next_sibling() is None and el.parent is not None and el.parent is not root:
                    el = el.parent
                body, n = [], el.find_next_sibling()
                while n is not None and not (n.name == cfg["head"] or n.select_one(cfg["head"])):
                    body.append(str(n))
                    n = n.find_next_sibling()
                items.append({"url": lu.split("#")[0] + "#" + slug(t), "list_title": t, "h1": t,
                              "text": t + "\n" + text_of(BeautifulSoup("".join(body), "lxml"))[:9000], "list_snippet": ""})
        time.sleep(cfg.get("delay", 250) / 1000)
    return items


def run(ids: list[str] | None = None):
    RAW.mkdir(parents=True, exist_ok=True)
    for cfg in load_sources():
        if ids and cfg["id"] not in ids:
            continue
        print(f"[{cfg['id']}] crawling…")
        items = crawl_inline(cfg) if cfg.get("mode") in ("accordion", "headings") else crawl_links(cfg)
        out = {"source": cfg, "scraped_at": datetime.now(timezone.utc).isoformat(), "items": items}
        (RAW / f"phdraw_{cfg['id']}.json").write_text(json.dumps(out, ensure_ascii=False))
        print(f"[{cfg['id']}] {len(items)} items, {sum('text' in i for i in items)} with detail")


if __name__ == "__main__":
    run(sys.argv[1:] or None)
