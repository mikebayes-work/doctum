"""Turn raw crawled pages into clean, structured PhD listings.

Everything here is heuristic and source-agnostic: labelled fields first ("Application deadline",
"Funding", "Supervisor"), then free-text patterns. Per-source quirks go in SOURCE_HINTS.
"""
from __future__ import annotations

import hashlib
import html
import re
from datetime import date, datetime

from dateutil import parser as dparser

TODAY = date.today()

# ---------------------------------------------------------------- helpers
MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*"
DATE_RE = re.compile(
    rf"\b(\d{{1,2}}(?:st|nd|rd|th)?\s+{MONTHS},?\s+\d{{4}}"          # 31 October 2026
    rf"|{MONTHS}\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"              # October 31, 2026
    rf"|\d{{1,2}}/\d{{1,2}}/\d{{4}}"                                    # 31/10/2026
    rf"|\d{{4}}-\d{{2}}-\d{{2}})\b", re.I)
MONTH_YEAR_RE = re.compile(rf"\b({MONTHS}\s+\d{{4}})\b", re.I)


def norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def strip_tags(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", " ", s or ""))


def parse_date(s: str) -> date | None:
    m = DATE_RE.search(s or "")
    if not m:
        return None
    try:
        iso = re.fullmatch(r"\d{4}-\d{2}-\d{2}", m.group(1))
        return dparser.parse(m.group(1), dayfirst=not iso, fuzzy=True).date()
    except (ValueError, OverflowError):
        return None


def labelled(text: str, labels: str, span: int = 3) -> str | None:
    """Value after a label: same line ('Closing date: 1 Dec') or the next few lines."""
    lines = text.split("\n")
    lab = re.compile(rf"^\s*(?:{labels})\b\s*[:\-–]?\s*(.*)$", re.I)
    for i, ln in enumerate(lines):
        m = lab.match(ln)
        if m:
            rest = m.group(1).strip()
            if rest:
                return rest
            nxt = [l.strip() for l in lines[i + 1:i + 1 + span] if l.strip() and l.strip() != "|"]
            if nxt:
                return " ".join(nxt[:span])
    return None


# ---------------------------------------------------------------- fields
DEADLINE_LABELS = r"application deadline|closing date|deadline for applications?|deadline for application|deadline|applications? close|apply by"
START_LABELS = r"start date|project start dates?|project start date|expected start date|start"
SUPERVISOR_LABELS = (r"supervisors?|supervised by|potential supervisors?|lead supervisors?|principal supervisors?|supervisory team|primary supervisors?|"
                     r"main supervisors?|first supervisors?|second supervisors?|additional supervisors?|co-?supervisors?|supervisor\(s\)|project supervisors?")


def get_deadline(text: str, snippet: str) -> tuple[date | None, str]:
    for src in (snippet, text):
        v = labelled(src.replace(" | ", "\n"), DEADLINE_LABELS, span=1)
        if v and re.match(r"none specified|not specified|n/?a\b|tbc|tbd", v, re.I):
            return None, ""
        if v:
            if re.search(r"until filled|rolling|ongoing|open", v, re.I) and not parse_date(v):
                return None, "Rolling / until filled"
            d = parse_date(v)
            if d:
                return d, DATE_RE.search(v).group(1)
    m = re.search(rf"(?:deadline|closing date|close[sd]? on|apply by|applications? (?:by|before))[^.\n]{{0,40}}?{DATE_RE.pattern}", text, re.I)
    if m:
        d = parse_date(m.group(0))
        if d:
            return d, m.group(0)[:80]
    if re.search(r"open until filled|until the position is filled|rolling basis|applications? (?:are )?accepted all year", text, re.I):
        return None, "Rolling / until filled"
    return None, ""


def get_start(text: str) -> str:
    v = labelled(text, START_LABELS, span=1)
    if v and re.match(r"none specified|n/?a|tbc|tbd", v, re.I):
        return ""
    if v:
        m = DATE_RE.search(v) or MONTH_YEAR_RE.search(v)
        if m:
            return m.group(1).title() if m.re is MONTH_YEAR_RE else m.group(1)
        if len(v) < 40:
            return v
    m = re.search(rf"(?:start(?:ing)?(?: date)?|commenc\w+)[^.\n]{{0,30}}?({MONTH_YEAR_RE.pattern}|{DATE_RE.pattern})", text, re.I)
    return m.group(1) if m else ""


FUNDING_ORDER = ["Fully funded", "Competition funded", "Partially funded", "Self-funded"]


def get_funding(text: str, snippet: str, title: str) -> str:
    head = " ".join([title, snippet, labelled(text, r"funding|funding type|funding status|funding information", 2) or ""]).lower()
    body = text.lower()

    def classify(s: str) -> str | None:
        if re.search(r"\bnon-funded\b|\bunfunded\b|not funded|self[- ]funded|no funding (?:is )?(?:attached|available)|privately funded|need to (?:secure|find|arrange) (?:your own )?funding", s):
            return "Self-funded"
        if re.search(r"competition[- ]funded|competitively funded|competitive funding|funding competition|compete for funding", s):
            return "Competition funded"
        if re.search(r"part(?:ial(?:ly)?|ly)?[- ]funded|fees[- ]only|partial (?:studentship|scholarship|funding)", s):
            return "Partially funded"
        if re.search(r"fully[- ]funded|full studentship|full scholarship|\bstipend\b|maintenance (?:grant|allowance)|tax[- ]free|ukri (?:standard |minimum )?rate|\bfunded\b|studentship covers|scholarship covers", s):
            return "Fully funded"
        return None

    return classify(head) or classify(body[:4000]) or "Unknown"


STIPEND_RE = re.compile(r"£\s?(\d{2}),?(\d{3})")


def get_stipend(text: str) -> int | None:
    best = None
    for m in STIPEND_RE.finditer(text):
        ctx = text[max(0, m.start() - 160): m.end() + 60].lower()
        v = int(m.group(1) + m.group(2))
        if 14000 <= v <= 45000 and re.search(r"stipend|maintenance|living|salary|bursary|per annum|p\.a\.|tax[- ]free|annual", ctx) \
                and not re.search(r"tuition|fees? (?:of|at|for)|international fee", text[max(0, m.start() - 40): m.start()].lower()):
            best = max(best or 0, v)
    return best


def get_eligibility(text: str, snippet: str, funding: str = "") -> str:
    if funding == "Self-funded":
        return "Open to all (self-funded)"
    s = (snippet + "\n" + text).lower()
    if re.search(r"(?:uk|home)(?: fee)?[- ](?:eligible )?(?:applicants|students|candidates)? ?only|only (?:open|available) to (?:uk|home)|restricted to (?:uk|home)|uk only|home fee status only|home students only", s):
        return "UK/Home only"
    if re.search(r"open to (?:both )?(?:uk|home) and international|international (?:students|applicants|candidates) (?:are )?(?:also )?(?:welcome|eligible)|open to all nationalities|any nationality|international fee waiver|uk or international fees|eligibility\s*:?\s*\n?[^\n]*(?:rest of world|international|overseas)", s):
        return "UK & International"
    return "Not stated"


NAME_RE = re.compile(r"\b(?:Dr|Prof(?:essor)?|Professor|Mr|Ms|Mrs|Assoc\.? Prof\.?)\.?\s+[A-Z][A-Za-z'’\-]+(?:\s+(?:[A-Z]\.?\s*)?[A-Z][A-Za-z'’\-]+){0,3}")


# A plain name with no title, e.g. Swansea lists "Supervisors:" then one name per bullet.
_W = r"(?:[A-Z][a-z]*['’][A-Z][a-z]+|[A-Z][a-z'’]+(?:-[A-Z]?[a-z'’]+)*|[A-Z]\.)"  # Smith, O'Neill, Jean-Yves, J.
PLAIN_NAME_RE = re.compile(rf"^{_W}(?:\s+(?:(?:van|von|de|del|der|den|da|di|du|le|la|bin|al)\s+){{0,2}}{_W}){{1,3}}$")
NOT_A_NAME = re.compile(r"\b(University|School|Department|Faculty|Centre|Center|Institute|College|Campus|Programme|Program|Physics|Engineering|"
                        r"Science|Sciences|Research|Group|Laboratory|Lab|Project|Funding|Study|Studies|Mode|Place|Full|Part|Time|Contact|"
                        r"Email|Apply|Application|Deadline|Closing|Start|Date|Open|Key|Information|Overview|Details|Team|Supervisor|Supervisors|PhD|Doctor|"
                        r"Entry|Requirements?|Fees?|Find|How|Home|News|Events?|About|Students?|Staff|Alumni|International|Postgraduate|"
                        r"Undergraduate|Scholarships?|Library|Search|Menu|Accessibility|Support|Wellbeing|Business|Our|Your|More|Read|View|"
                        r"Profile|Website|Page|Policy|Privacy|Cookies?|Terms|Award|Studentship|Funded|Stipend|Eligibility|Location)\b")


def plain_names(lines: list[str]) -> list[str]:
    """Names on the lines straight after a 'Supervisors:' label (or after the colon on the
    same line), stopping at the next 'Label:' line. Only short Title-Case lines count."""
    out = []
    for raw in lines[:8]:
        ln = norm_ws(re.sub(r"^[\s•·\-–*]+", "", raw))
        if not ln:
            continue
        if re.match(r"^[A-Z][\w ()/&'’\-]{1,40}:\s*\S", ln) or (out and ln.endswith(":")):
            break  # next field, e.g. "Aligned programme of study: Physics, PhD"
        for part in re.split(r"\s*(?:,|;|\band\b|&)\s*", ln):
            part = part.strip(" .")
            if PLAIN_NAME_RE.match(part) and not NOT_A_NAME.search(part) and part not in out:
                out.append(part)
    return out


# Supervisors named in running text: "…jointly supervised by Dr Jennifer Dickens in CIMR and Dr James
# Garnett and Dr Catherine Overed-Sayer at AstraZeneca…" (Cambridge, Nov 2026). Only titled names count.
PROSE_SUP = re.compile(r"(?:(?:jointly|co-?)\s*)?supervised\s+(?:jointly\s+)?by|under\s+the\s+(?:joint\s+)?supervision\s+of|"
                       r"supervisory\s+team\s+(?:comprises|includes|consists\s+of|of)|supervisors?\s+(?:will\s+be|are|is|include)\b|"
                       r"(?:lead|main|primary|principal)\s+supervisor\s+(?:will\s+be|is)\b", re.I)


def prose_supervisors(text: str) -> list[str]:
    out = []
    for m in PROSE_SUP.finditer(text or ""):
        tail = text[m.end():m.end() + 300]
        # end of sentence = ". " + capital, but not after a title such as "Dr." or "Prof."
        stop = re.search(r"(?<!\bDr)(?<!\bProf)(?<!\bMr)(?<!\bMs)(?<!\bMrs)\.\s+(?=[A-Z])|\n", tail)
        out += [n for n in NAME_RE.findall(tail[:stop.start()] if stop else tail) if n not in out]
    return out


def get_supervisors(text: str, snippet: str) -> list[str]:
    block = ""
    lines = text.split("\n")
    lab = re.compile(rf"^\s*(?:{SUPERVISOR_LABELS})\b", re.I)
    plain = []
    for i, ln in enumerate(lines):
        if lab.match(ln):
            block += " ; ".join(lines[i:i + 8]) + " ; "  # ';' stops a name running into the next line's
            after = re.sub(rf"^\s*(?:{SUPERVISOR_LABELS})\b\s*(?:\(s\))?\s*:?", "", ln, flags=re.I)
            plain += plain_names(([after] if after.strip() else []) + lines[i + 1:i + 9])
    if not block:  # "…the project. Supervisor: Dr Jane Smith. Deadline…" inside running text
        m = re.search(rf"\b(?:{SUPERVISOR_LABELS})\s*(?:\(s\))?\s*[:\-–]\s*(.{{0,200}})", text, re.I)
        if m:
            block = re.split(r"\.\s+(?=[A-Z][a-z])", m.group(1))[0]
    names = NAME_RE.findall(block) or NAME_RE.findall(snippet.split("|")[-1] if snippet else "") or prose_supervisors(text)
    if not names and plain:
        return plain[:4]
    out = []
    for n in names:
        n = norm_ws(re.sub(r"^(Dr|Prof|Mr|Ms|Mrs)\.", r"\1", n.replace("Professor", "Prof")))
        n = re.sub(r"\s+(Lecturer|Senior|Reader|Associate|School|Department|More|Research|Email|Profile|Applications?|Contact|"
                   r"PhD|Prof|Dr|Professor|The|This|Faculty|University|Centre|Institute|Co|Second|Primary|Entry|Deadline|Please|Funding|Start|Closing|Tel|Website|Group|Lab|Supervisor|Supervisors|And|Project|Overview|Eligibility|Department|Additional|Schools?|Co-supervisors?|Secondary)\b.*$", "", n)
        n = re.sub(r"(\s+[A-Z]{2,5}\b)+$", "", n)  # post-nominals: BM, FRS, FREng
        if len(n.split()) < 2 or re.fullmatch(r"(Dr|Prof|Mr|Ms|Mrs)\.?(\s+(Dr|Prof))*", n):
            continue
        if n not in out and len(n) < 50:
            out.append(n)
    return out[:4]


FUNDERS = ["EPSRC", "BBSRC", "NERC", "ESRC", "AHRC", "MRC", "STFC", "UKRI", "Leverhulme", "Wellcome",
           "Cancer Research UK", "Royal Society", "DfE", "CSC", "Horizon Europe", "Marie Sk", "Faraday Institution",
           "AstraZeneca", "GSK", "Rolls-Royce", "BAE Systems", "Jaguar Land Rover", "Airbus", "Shell", "BP", "Innovate UK"]


def get_funders(text: str) -> list[str]:
    found = []
    for f in FUNDERS:
        if re.search(rf"\b{re.escape(f)}", text):
            found.append("Marie Skłodowska-Curie" if f == "Marie Sk" else f)
    return found[:5]


def get_programme(title: str, text: str) -> str:
    s = (title + " " + text[:1500]).lower()
    if re.search(r"\bcdt\b|centre for doctoral training", s):
        return "CDT"
    if re.search(r"\bdtp\b|doctoral training partnership|doctoral landscape award|\bdla\b", s):
        return "DTP / DLA"
    if re.search(r"industrial (?:doctorate|case)|\bicase\b|\bcase studentship|\bengd\b", s):
        return "Industry partnered"
    return ""


def get_degree(title: str, text: str) -> str:
    s = (title + " " + text[:2500]).lower()
    if re.search(r"mres\s*\+\s*phd|1\s*\+\s*3|mres/phd", s):
        return "MRes + PhD"
    if re.search(r"\bengd\b", s):
        return "EngD"
    if re.search(r"msc by research|master'?s by research|\bmres\b", s) and not re.search(r"\bphd\b|doctor", s):
        return "MSc by Research"
    if re.search(r"\bmd\b|\bdclinpsy\b", s) and not re.search(r"\bphd\b", s):
        return "Professional doctorate"
    return "PhD"


# Discipline taxonomy — kept close to how students search. First match by weighted score.
DISCIPLINES = {
    "Engineering": r"engineer|mechanic|aerospace|aeronaut|aircraft|civil|structural|manufactur|additive|tribolog|robot|automotive|vehicle|turbine|combustion|fluid|thermo|heat transfer|cfd|composite|fatigue|corrosion|welding|propulsion|nuclear|fusion|offshore|wind|battery|power electronic|electric(al)? motor|electrical|electronic|photonic|semiconductor|control system|autonomous|drone|uav|space|satellite|infrastructure|concrete|geotechn|hydrogen|energy",
    "Computer Science & AI": r"computer science|computing|machine learning|deep learning|artificial intelligence|\bai\b|neural network|data science|software|algorithm|cyber|security|privacy|federated|vision|nlp|natural language|large language|llm|human-computer|hci|quantum comput|digital twin|big data|blockchain|cloud",
    "Physics & Astronomy": r"physics|quantum|astro|cosmolog|galax|black hole|particle|laser|optic|spectroscop|condensed matter|plasma|superconduct|magnet|spintronic|photon|terahertz|muon|gravitational",
    "Chemistry": r"chemistry|chemical|catalys|synthes|molecul|polymer|electrochem|organic|inorganic|crystal|spectrometr|nmr|zeolite|metal-organic|peptide",
    "Materials Science": r"material|alloy|ceramic|nanomaterial|thin film|coating|microstructur|metallurg|piezoelectric",
    "Mathematics & Statistics": r"mathemat|statistic|probabilit|stochastic|algebra|topolog|geometr|number theory|differential equation|\bpde\b|optimi[sz]ation|numerical analysis|random matri|bayesian",
    "Biological Sciences": r"biolog|bioscien|cell|gene|genom|protein|enzyme|microb|bacteri|virus|viral|immun|plant|ecolog|evolution|organism|crispr|molecular bio|biochem|neurosci|zoolog|insect|mosquito|marine bio|biodiversity",
    "Medicine & Health": r"medic|clinical|health|patient|disease|cancer|tumou?r|cardio|heart|diabetes|nursing|midwif|pharma|drug|therap|surgery|surgical|dental|dentist|hospital|nhs|epidemiol|public health|mental health|dementia|stroke|obesity|nutrition|ageing|aging|rehabilita",
    "Environment & Earth Sciences": r"environment|climate|ocean|marine|sea level|atmospher|geolog|geophys|earth|soil|water|river|hydrolog|carbon|net zero|sustainab|pollution|ecosystem|biodiversity|forest|glacier|volcan|coastal|flood|agricultur|food security",
    "Psychology": r"psycholog|cognitive|cognition|behaviou?r|perception|emotion|autis|adhd|developmental|wellbeing|well-being",
    "Social Sciences": r"social|sociolog|politic|policy|criminolog|anthropolog|geograph|international relations|migration|inequalit|education|teacher|pedagog|community|gender|urban|housing|welfare",
    "Business & Economics": r"business|management|economic|finance|financial|accounting|marketing|supply chain|logistic|entrepreneur|innovation management|organi[sz]ation|banking|strategy",
    "Arts & Humanities": r"histor|literatur|philosoph|linguist|language|languages|music|art\b|arts\b|theatre|film|media|cultur|religio|theolog|archaeolog|classics|creative writing|heritage|morpholog|inflection|syntax|morphosyntax",
    "Law": r"\blaw\b|legal|jurisprud|regulation|human rights|court|justice",
}
DISC_RE = {k: re.compile(v, re.I) for k, v in DISCIPLINES.items()}
SCHOOL_HINTS = [  # school/department names are the strongest signal when present
    (r"school of (?:mathematics|mathematical)", "Mathematics & Statistics"), (r"physics", "Physics & Astronomy"),
    (r"chemistry", "Chemistry"), (r"engineering", "Engineering"), (r"computer|computing|eeecs|electronics", "Computer Science & AI"),
    (r"medicine|medical|dentistry|pharmacy|nursing|health", "Medicine & Health"), (r"biolog|biosci", "Biological Sciences"),
    (r"psycholog", "Psychology"), (r"law", "Law"), (r"management|business|economics", "Business & Economics"),
    (r"history|arts|english|languages|philosophy|music|theology", "Arts & Humanities"),
    (r"social|politic|education|criminolog|geography", "Social Sciences"), (r"natural and built environment|environment", "Environment & Earth Sciences"),
]


def get_disciplines(title: str, text: str, school: str) -> list[str]:
    scores = {}
    for k, rx in DISC_RE.items():
        scores[k] = 3 * len(rx.findall(title)) + len(rx.findall(text[:3000])) * 0.5
    for pat, k in SCHOOL_HINTS:
        if school and re.search(pat, school, re.I):
            scores[k] = scores.get(k, 0) + 6
            break
    ranked = [k for k, v in sorted(scores.items(), key=lambda kv: -kv[1]) if v >= 1.5]
    return ranked[:2] or ["Other / Interdisciplinary"]


def get_school(snippet: str, text: str) -> str:
    m = re.search(r"((?:School|Faculty|Department|Institute|Centre) (?:of|for) [A-Z][^|\n]{3,80}?)(?:\s*\||\n|$)", snippet + "\n" + text[:2500])
    return norm_ws(m.group(1)) if m else ""


# ---------------------------------------------------------------- quality filters
JUNK_TITLE = re.compile(r"^(frequently asked|faqs?|how to apply|entry requirements|finding a supervisor|making your application|"
                        r"after you have applied|when to apply|funding and scholarships|research groups|centres? for doctoral training|"
                        r"key links|projects and studentships|contact|i am |i have |what |who |when |the selection process|share|"
                        r"skf utc|research opportunities$|apply|overview$|phd positions first cohort)", re.I)


def is_listing(title: str, text: str) -> bool:
    if not title or len(title) < 12 or JUNK_TITLE.search(title):
        return False
    return bool(re.search(r"phd|studentship|doctoral|project|scholarship|research|supervisor", title + " " + text[:3000], re.I))


SUMMARY_SKIP = re.compile(r"^(\*|share|in exceptional circumstances|facebook|twitter|linkedin|email|funding|type of degree|entry requirements|closing date|"
                          r"application deadline|start date|reference|key facts|overview|about the project|project details|"
                          r"apply|view|potential supervisors|fees and funding|how to apply|contact us|qualification|location|area|"
                          r"subject area|full-time|part-time|uk:|international:|\d)", re.I)


def make_description(title: str, text: str) -> tuple[str, str]:
    """Return (summary ~ 300 chars, description ~ 2500 chars) starting at the real prose."""
    paras = [p.strip() for p in text.split("\n") if p.strip()]
    prose = [p for p in paras if len(p) > 120 and not SUMMARY_SKIP.match(p) and p != title]
    desc = "\n\n".join(prose)[:2500]
    summ = prose[0] if prose else ""
    if len(summ) > 320:
        summ = summ[:320].rsplit(" ", 1)[0] + "…"
    return summ, desc


# ---------------------------------------------------------------- main
GLUED_LABELS = re.compile(r"(Application deadline|Closing [Dd]ate|Start date|Award type\(s\)|Duration of award|Eligibility|"
                          r"Reference number|Supervisors?|Funding|Location)(?=[A-Z0-9])")


def extract(item: dict, source: dict) -> dict | None:
    text = GLUED_LABELS.sub(r"\1\n", strip_tags(item.get("text") or ""))
    snippet = item.get("list_snippet") or ""
    title = item.get("list_title") or ""
    h1 = item.get("h1") or ""
    generic = re.compile(r"^(research opportunities|phd opportunities|studentships?|find out more|read more|see details|view|"
                         + re.escape(source.get("institution", "-")) + r")$", re.I)
    if h1 and len(h1) >= 12 and not generic.search(h1):
        title = h1  # the detail page's own heading is the most reliable title
    title = re.sub(r"\s+PhD$", "", norm_ws(title))           # Cranfield appends " PhD"
    title = re.sub(r"\s*\((?:Fixed Term)\)$", "", title)       # Cambridge jobs suffix
    # Trim nav chrome: start body at the title if it appears (Southampton menus etc.)
    i = text.find(title[:60])
    body = text[i:] if i > 0 else text
    if not body:
        body = snippet.replace(" | ", "\n")
    if not is_listing(title, body + " " + snippet):
        return None

    deadline, deadline_text = get_deadline(body, snippet)
    school = get_school(snippet, body)
    summary, description = make_description(title, body)
    if not summary and item.get("meta"):
        summary = item["meta"][:320]
    if not summary and snippet:
        parts = [p.strip() for p in snippet.split("|") if len(p.strip()) > 60]
        summary = parts[0][:320] if parts else ""
    rec = {
        "id": hashlib.sha1(item["url"].encode()).hexdigest()[:12],
        "source_id": source["id"],
        "institution": source["institution"],
        "region": source.get("region", ""),
        "url": item["url"],
        "title": title,
        "summary": summary,
        "description": description,
        "school": school,
        "deadline": deadline.isoformat() if deadline else None,
        "deadline_text": deadline_text,
        "start": get_start(body),
        "funding": (funding := get_funding(body, snippet, title)),
        "stipend": get_stipend(body),
        "eligibility": get_eligibility(body, snippet, funding),
        "supervisors": get_supervisors(body, snippet),
        "funders": get_funders(body),
        "programme": get_programme(title, body),
        "degree": get_degree(title, body),
        "disciplines": get_disciplines(title, body, school),
        "has_detail": bool(item.get("text")),
    }
    rec["content_hash"] = hashlib.sha1((rec["title"] + rec["description"] + str(rec["deadline"])).encode()).hexdigest()[:16]
    rec["is_open"] = rec["deadline"] is None or rec["deadline"] >= TODAY.isoformat()
    return rec
