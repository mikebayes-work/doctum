"""Polite, config-driven crawler. Writes data/raw/phdraw_<id>.json in the same format as the
browser bootstrap crawler, so extract.py doesn't care which one produced the file.

    python -m scraper.crawl                 # all sources
    python -m scraper.crawl cranfield qub   # just these

Sources run in parallel (CRAWLER_JOBS, default 8); each source stays polite to its own site.
Sources marked `mode: auto` need only a domain - see the auto mode section below.
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


_blocked: dict[str, str] = {}   # host -> why the site refused us (shown in the run log and manifest)
DIAG: dict[str, str] = {}       # source id -> first problem seen this run


def allowed(url: str) -> bool:
    """Respect robots.txt. Fetched with our own User-Agent so a firewall block shows up as a block,
    not as a silent "disallow everything" (urllib's robotparser treats 401/403 as disallow-all)."""
    host = urlparse(url).scheme + "://" + urlparse(url).netloc
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser(host + "/robots.txt")
        try:
            r = session.get(host + "/robots.txt", timeout=20)
            if r.status_code in (401, 403, 429) or r.status_code >= 500:
                _blocked[host] = f"site refused the crawler (HTTP {r.status_code} on robots.txt)"
                rp = False
            elif r.status_code >= 400:
                rp = None  # no robots.txt: everything allowed
            else:
                rp.parse(r.text.splitlines())
        except Exception as e:
            _blocked[host] = f"couldn't reach the site ({type(e).__name__})"
            rp = False
        _robots[host] = rp
    rp = _robots[host]
    if rp is False:
        raise PermissionError(_blocked[host])
    return True if rp is None else rp.can_fetch(UA, url)


def get(url: str) -> BeautifulSoup:
    if not allowed(url):
        raise PermissionError(f"robots.txt disallows {url}")
    r = session.get(url, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}")
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
            DIAG.setdefault(cfg["id"], str(e))
            if isinstance(e, PermissionError):
                break  # same answer for every page on this site
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
        if not added and not seen:
            title = clean(doc.title.get_text()) if doc.title else "no title"
            DIAG.setdefault(cfg["id"], f"listing page loaded but no project links matched (page title: {title[:80]})")
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
    pages = [(cfg["_url"], cfg["_doc"])] if cfg.get("_doc") is not None else [(u, None) for u in list_urls(cfg)]
    for lu, d in pages:
        try:
            d = d if d is not None else get(lu)
        except Exception as e:
            print("  list error", lu, e)
            DIAG.setdefault(cfg["id"], str(e))
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
        if cfg.get("_doc") is None:
            time.sleep(cfg.get("delay", 250) / 1000)
    return items




# ------------------------------------------------------------------ auto mode
# For universities without hand-written rules. Given only `domain`, it:
#   1. finds listing pages: explicit `seeds`, else the site's sitemap(s), else a short list of common paths;
#   2. walks those listing pages (pagination plus one level of sub-listings) collecting likely project links;
#   3. fetches each candidate and keeps only pages that read like a PhD advert;
#   4. if a listing page has no project links, tries it as a one-page "headings" listing.
# A page that embeds FindAPhD's widget is skipped and reported, as for Sheffield, Manchester and Edinburgh.
# Once a university's first run shows what its site looks like, give it proper rules and drop `mode: auto`.

LISTING_RE = re.compile(
    r"(phd|doctoral|doctorate|research-degree|postgraduate-research|pgr|research-students?)[^?#]*"
    r"(opportunit|project|studentship|vacanc|position|funded|scholarship|available)"
    r"|(^|/)(funded-)?(phd-)?studentships?(/|$|\.)|funded-phd|phd-funding|phd-projects?(/|$|\.)", re.I)
DETAIL_HINT = re.compile(r"phd|studentship|doctoral|project|scholarship|funded|epsrc|bbsrc|nerc|esrc|ahrc|mrc|ukri|cdt|dtp", re.I)
JUNK_URL = re.compile(
    r"(apply|application-process|how-to|entry-requirements|fees|tuition|contact|news|events?/|blog|staff|people|profiles?/|"
    r"login|signin|search\?|faq|privacy|cookie|accessib|sitemap|terms|policy|policies|alumni|visit|open-day|accommodation|"
    r"undergraduate|international/|clearing|careers?/|jobs/(?!.*studentship)|calendar|feed|rss|/tag/|/category/|share=|print=)"
    r"|\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|svg|mp4)$|^mailto:|^tel:", re.I)
PHD_WORDS = re.compile(r"\b(phd|ph\.d|studentship|doctoral|doctorate|dphil|eng\s?d)\b", re.I)
ADVERT_SIGNALS = [re.compile(x, re.I) for x in (
    r"closing date|application deadline|deadline", r"supervisor|supervisory team|supervised by",
    r"stipend|tax-free|fully funded|funding|fees", r"start date|starting|commenc", r"eligib|entry requirements|applicants? (must|should)",
    r"how to apply|to apply|apply (now|online|here)")]
FINDAPHD_RE = re.compile(r"findaphd\.com/(widget|search|phds/)|powered by findaphd", re.I)
NEXT_RE = re.compile(r"^\s*(next|next page|more|›|»|>|load more)\s*$", re.I)
COMMON_PATHS = [
    "/study/postgraduate-research/phd-opportunities/", "/study/postgraduate-research/funded-phd-opportunities/",
    "/study/postgraduate-research/studentships/", "/postgraduate-research/studentships/", "/research/phd-opportunities/",
    "/research/studentships/", "/phd-studentships/", "/studentships/", "/phd-opportunities/", "/funded-phds/",
    "/graduate-school/studentships/", "/doctoral-college/studentships/", "/research-degrees/studentships/",
    "/study/research-degrees/funded-phd-opportunities/", "/study/postgraduate/research/studentships/",
]
SITEMAP_SKIP = re.compile(r"news|event|blog|staff|people|profile|image|video|media|course|undergrad|press|story|stories", re.I)
REQUEST_BUDGET = int(os.environ.get("CRAWLER_BUDGET", "600"))   # max requests per auto source per run
_counts: dict[str, int] = {}


def _on_domain(url: str, domain: str) -> bool:
    h = urlparse(url).netloc.lower().split(":")[0]
    return h == domain or h.endswith("." + domain)


def _budget(cfg: dict) -> bool:
    _counts[cfg["id"]] = _counts.get(cfg["id"], 0) + 1
    return _counts[cfg["id"]] <= cfg.get("budget", REQUEST_BUDGET)


def _base(cfg: dict) -> str:
    return cfg.get("base") or f"https://www.{cfg['domain']}"


def _raw(url: str, limit: int = 15_000_000) -> bytes | None:
    """Fetch bytes (sitemaps). Respects robots.txt; gives up quietly."""
    try:
        if not allowed(url):
            return None
        r = session.get(url, timeout=30, stream=True)
        if r.status_code >= 400:
            return None
        data = b""
        for chunk in r.iter_content(65536):
            data += chunk
            if len(data) > limit:
                break
        if url.endswith(".gz") or data[:2] == b"\x1f\x8b":
            import gzip
            try:
                data = gzip.decompress(data)
            except OSError:
                return None
        return data
    except Exception:
        return None


def sitemap_urls(cfg: dict, max_files: int = 25) -> list[str]:
    base = _base(cfg)
    starts = []
    try:
        allowed(base + "/")
        r = session.get(base + "/robots.txt", timeout=20)
        starts = [ln.split(":", 1)[1].strip() for ln in r.text.splitlines() if ln.lower().startswith("sitemap:")]
    except Exception:
        pass
    queue = list(dict.fromkeys(starts or [base + "/sitemap.xml"]))
    seen, urls = set(), []
    while queue and len(seen) < max_files and _budget(cfg):
        sm = queue.pop(0)
        if sm in seen:
            continue
        seen.add(sm)
        data = _raw(sm)
        if not data:
            continue
        locs = re.findall(rb"<loc>\s*(.*?)\s*</loc>", data, re.S)
        locs = [html_unescape(x.decode("utf-8", "ignore")) for x in locs]
        if b"<sitemapindex" in data[:2000]:
            # child sitemaps: likely-relevant ones first, obviously irrelevant ones never
            kids = [k for k in locs if not SITEMAP_SKIP.search(urlparse(k).path)]
            kids.sort(key=lambda k: not re.search(r"research|postgrad|study|phd|page|pages|content", k, re.I))
            queue += kids
        else:
            urls += [u for u in locs if _on_domain(u, cfg["domain"])]
    return urls


def html_unescape(s: str) -> str:
    import html as _h
    return _h.unescape(s)


def _path(u: str) -> str:
    return urlparse(u).path.rstrip("/") or "/"


def discover(cfg: dict) -> tuple[list[str], list[str]]:
    """Return (listing pages, detail candidates) for a domain."""
    urls = [u.split("#")[0] for u in sitemap_urls(cfg)]
    hits = [u for u in dict.fromkeys(urls) if LISTING_RE.search(_path(u)) and not JUNK_URL.search(u)]
    by_parent: dict[str, list[str]] = {}
    for u in hits:
        parent = u.rstrip("/").rsplit("/", 1)[0] + "/"
        by_parent.setdefault(parent, []).append(u)
    hit_set = {u.rstrip("/") for u in hits}
    seeds, details = [], []
    # a listing page with 3+ children in the sitemap: the children are the adverts
    for parent, kids in sorted(by_parent.items(), key=lambda kv: -len(kv[1])):
        if len(kids) >= 3 and (LISTING_RE.search(_path(parent)) or parent.rstrip("/") in hit_set):
            seeds.append(parent)
            details += kids
    # listing-looking pages themselves, shallowest first
    tops = sorted((u for u in hits if u not in details), key=lambda u: (_path(u).count("/"), len(u)))
    seeds += tops[:10]
    if not seeds:
        for p in COMMON_PATHS:
            if not _budget(cfg):
                break
            u = _base(cfg) + p
            try:
                if allowed(u):
                    r = session.get(u, timeout=20, allow_redirects=True)
                    if r.status_code < 400 and PHD_WORDS.search(r.text) and _on_domain(r.url, cfg["domain"]):
                        seeds.append(r.url)
            except PermissionError:
                raise
            except Exception:
                pass
            time.sleep(cfg.get("delay", 250) / 1000)
    return list(dict.fromkeys(seeds))[: cfg.get("max_lists", 12)], list(dict.fromkeys(details))


def looks_like_advert(text: str, title: str) -> bool:
    if not PHD_WORDS.search(title + " " + text[:4000]):
        return False
    return sum(bool(r.search(text)) for r in ADVERT_SIGNALS) >= 2


def crawl_auto(cfg: dict) -> list[dict]:
    domain = cfg["domain"].lower()
    ex_re = re.compile(cfg["exclude"], re.I) if cfg.get("exclude") else None
    link_re = re.compile(cfg["link"], re.I) if cfg.get("link") else None
    seeds = list(cfg.get("seeds", []))
    pre_details: list[str] = []
    if not seeds:
        seeds, pre_details = discover(cfg)
    if not seeds and not pre_details:
        DIAG.setdefault(cfg["id"], "no PhD listing page found (sitemap and common paths) - add `seeds:`")
        return []
    cards_sel = cfg.get("card", "li,article,tr,.card,.teaser,.result,.listing-item,.views-row")
    found: dict[str, dict] = {u: {"url": u, "list_title": "", "list_snippet": ""} for u in pre_details}
    queue = [(s, 0) for s in seeds]
    visited, inline_items, findaphd = set(), [], 0
    max_lists = cfg.get("max_lists", 30)
    while queue and len(visited) < max_lists and _budget(cfg):
        lu, depth = queue.pop(0)
        if lu in visited:
            continue
        visited.add(lu)
        try:
            r_doc = get(lu)
        except PermissionError as e:
            DIAG.setdefault(cfg["id"], str(e))
            break
        except Exception as e:
            print(f"  [{cfg['id']}] list error {lu} {e}")
            continue
        page_html = str(r_doc)
        if FINDAPHD_RE.search(page_html):
            findaphd += 1
            print(f"  [{cfg['id']}] FindAPhD widget on {lu} - skipped")
            continue
        root = main_el(r_doc, cfg.get("main"))
        cards = {id(c) for c in r_doc.select(cards_sel)}
        lpath = _path(lu)
        added = 0
        for a in root.select("a[href]"):
            h = urljoin(lu, a["href"]).split("#")[0]
            if not h.startswith("http") or not _on_domain(h, domain) or h.rstrip("/") == lu.rstrip("/"):
                continue
            if JUNK_URL.search(h) or (ex_re and ex_re.search(h)):
                continue
            t = clean(a.get_text(" "))
            hp = _path(h)
            same_path = hp == lpath and urlparse(h).query != urlparse(lu).query
            if (same_path and re.search(r"page|start|offset|p=", urlparse(h).query, re.I)) or (NEXT_RE.match(t) and same_path):
                queue.append((h, depth))  # pagination: same depth
                continue
            under = hp.startswith(lpath + "/") and hp != lpath
            if link_re:
                is_detail = bool(link_re.search(h))
            else:
                is_detail = (under and (len(t) >= 20 or DETAIL_HINT.search(hp))) or \
                            (len(t) >= 25 and DETAIL_HINT.search(t + " " + hp) and not LISTING_RE.search(hp + "/"))
            if not is_detail and LISTING_RE.search(hp) and depth < 2 and hp.count("/") <= lpath.count("/") + 2:
                queue.append((h, depth + 1))  # sub-listing (e.g. per department)
                continue
            if not is_detail:
                continue
            card = next((p for p in a.parents if id(p) in cards), None)
            s = clean(card.get_text("\n")).replace("\n", " | ")[:600] if card else ""
            o = found.setdefault(h, {"url": h, "list_title": "", "list_snippet": ""})
            added += 1
            if len(t) > len(o["list_title"]):
                o["list_title"] = t
            if len(s) > len(o["list_snippet"]):
                o["list_snippet"] = s
        if not added:
            # maybe a one-page listing: one advert per heading
            for head in ("h2", "h3"):
                got = crawl_inline({**cfg, "mode": "headings", "head": head, "lists": [], "_doc": r_doc, "_url": lu})
                got = [g for g in got if len(g["list_title"]) >= 20 and looks_like_advert(g["text"], g["list_title"])]
                if len(got) >= 2:
                    inline_items += got
                    break
        time.sleep(cfg.get("delay", 250) / 1000)
    if findaphd and not found and not inline_items:
        DIAG.setdefault(cfg["id"], "listing pages use the FindAPhD widget - not scraped")
        return []
    items = list(found.values())[: cfg.get("max", 250)]

    def detail(it):
        if not _budget(cfg):
            it["error"] = "request budget used up"
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
        items = list(ex.map(detail, items))
    keep = [it for it in items if it.get("text") and looks_like_advert(it["text"], it.get("h1") or it["list_title"])]
    if not keep and not inline_items:
        DIAG.setdefault(cfg["id"], f"found {len(visited)} listing page(s) and {len(items)} candidate links, "
                                   f"but none read like a PhD advert - needs proper rules")
    return keep + inline_items


# ------------------------------------------------------------------ run
SOURCE_JOBS = int(os.environ.get("CRAWLER_JOBS", "8"))   # universities crawled at the same time (different hosts)


def crawl_one(cfg: dict) -> None:
    if cfg.get("disabled"):
        print(f"[{cfg['id']}] skipped: {cfg['disabled']}")
        return
    print(f"[{cfg['id']}] crawling…")
    t0 = time.time()
    try:
        mode = cfg.get("mode")
        items = crawl_inline(cfg) if mode in ("accordion", "headings") else crawl_auto(cfg) if mode == "auto" else crawl_links(cfg)
    except PermissionError as e:  # robots.txt refusal or site unreachable
        DIAG.setdefault(cfg["id"], str(e))
        items = []
    except Exception as e:  # one broken site must never stop the run
        DIAG.setdefault(cfg["id"], f"crawler error: {type(e).__name__}: {e}"[:300])
        items = []
    out = {"source": cfg, "scraped_at": datetime.now(timezone.utc).isoformat(), "items": items}
    if not items and cfg["id"] in DIAG:
        out["problem"] = DIAG[cfg["id"]]
        print(f"[{cfg['id']}] PROBLEM: {DIAG[cfg['id']]}")
    (RAW / f"phdraw_{cfg['id']}.json").write_text(json.dumps(out, ensure_ascii=False))
    print(f"[{cfg['id']}] {len(items)} items, {sum('text' in i for i in items)} with detail, "
          f"{_counts.get(cfg['id'], 0)} auto requests, {time.time() - t0:.0f}s")


def run(ids: list[str] | None = None):
    RAW.mkdir(parents=True, exist_ok=True)
    todo = [c for c in load_sources() if not ids or c["id"] in ids]
    with ThreadPoolExecutor(SOURCE_JOBS) as ex:
        list(ex.map(crawl_one, todo))


if __name__ == "__main__":
    run(sys.argv[1:] or None)
