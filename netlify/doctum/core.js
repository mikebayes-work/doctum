// netlify/doctum/core.js — Doctum server-side core (search, facets, CV match).
//
// Pattern carried over from The Grid (netlify/cie/core.js, 2026-10-02): the
// database, the ranking logic and any prompts live here and in the edge
// functions that import this file. NOTHING in this file is sent to the browser.
// Pure JS, no Deno/Node APIs, so the same code runs in Netlify Edge Functions
// and in Node for local tests (scripts/test-api.mjs).

// ── Text helpers ──────────────────────────────────────────────────────
const STOP = new Set(("a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours " +
  "phd project projects research researcher researchers student students studentship studentships university universities applicant applicants candidate candidates apply application applications " +
  "work working experience skills skill degree degrees team teams opportunity opportunities fund funded funding fee fees stipend stipends tuition home international year years month months " +
  "deadline supervisor supervisors supervision school department faculty doctoral training programme program please contact email enquiries information details detail including include includes " +
  "within using use used new high strong good excellent well able successful will may must should would also based across key area areas field fields provide provides providing support supports supported " +
  "available start date dates full time part one two three four first second such other related relevant particular particularly understanding develop development developing result results led lead leads " +
  "study studies role roles requirement requirements required essential desirable knowledge level levels approach approaches aim aims enable range wide variety number way ways make making " +
  "help world leading group groups centre center institute uk british england scotland wales ireland london " +
  "dr prof professor mr ms mrs cv curriculum vitae name address phone mobile linkedin github references reference upon request internship internships intern supplier suppliers honours class meng beng msc bsc mres mphil mphys msci final undergraduate postgraduate graduate gpa").split(/\s+/));

const stem = (w) => w.length > 6 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 6 && w.endsWith('ing') ? w.slice(0, -3)
  : w.length > 5 && w.endsWith('ed') ? w.slice(0, -2)
  : w.length > 4 && w.endsWith('s') && !/(ss|is|us)$/.test(w) ? w.slice(0, -1) : w;

export function tokenise(text, surface) {
  const out = [];
  let prev = null;
  for (const raw of String(text || '').toLowerCase().replace(/[^a-z0-9+#\- ]+/g, ' ').split(/\s+/)) {
    const w = raw.replace(/^-+|-+$/g, '');
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) { prev = null; continue; }
    const s = stem(w);
    if (surface && (!surface.has(s) || w.length < surface.get(s).length)) surface.set(s, w);
    out.push(s);
    if (prev) {
      const b = prev + ' ' + s;
      out.push(b);
      if (surface && !surface.has(b)) surface.set(b, (surface.get(prev) || prev) + ' ' + w);
    }
    prev = s;
  }
  return out;
}

const daysBetween = (iso, today) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);

export const ELIG_LABEL = {
  'UK & International': 'Open to international',
  'UK/Home only': 'UK / Home fee status only',
  'Open to all (self-funded)': 'Anyone (self-funded)',
  'Not stated': 'Not stated',
};

// ── Index (built once per edge isolate) ──────────────────────────────
export function buildIndex(db) {
  const surface = new Map();
  const rows = db.rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const df = new Map();
  const docs = rows.map((r) => {
    const tf = new Map();
    const add = (t, w) => { for (const k of tokenise(t, surface)) tf.set(k, (tf.get(k) || 0) + w); };
    add(r.title, 3); add(r.summary, 1); add(r.description, 1); add(r.school, 1); add((r.disciplines || []).join(' '), 1);
    for (const k of tf.keys()) df.set(k, (df.get(k) || 0) + 1);
    return tf;
  });
  const N = rows.length;
  const idf = new Map();
  for (const [t, n] of df) if (n <= N * 0.35 && (n >= 2 || !t.includes(' '))) idf.set(t, Math.log((N + 1) / (n + 0.5)));
  const vec = (tf) => {
    const v = new Map(); let norm = 0;
    for (const [t, c] of tf) { const w = idf.get(t); if (!w) continue; const x = (1 + Math.log(c)) * w; v.set(t, x); norm += x * x; }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const vecs = docs.map(vec);
  const names = new Set();
  for (const r of rows) for (const n of r.supervisors || []) for (const t of tokenise(String(n).replace(/\b(dr|prof|professor)\b\.?/gi, ''))) if (!t.includes(' ')) names.add(t);
  // lower-cased blobs for keyword search
  const blobs = rows.map((r) => ({
    t: (r.title || '').toLowerCase(),
    b: [r.summary, r.school, (r.supervisors || []).join(' '), r.institution, (r.funders || []).join(' '), (r.disciplines || []).join(' '), r.description].join(' ').toLowerCase(),
  }));
  return { rows, byId, df, idf, vecs, vec, surface, names, blobs, N, builtAt: db.builtAt };
}

const show = (I, t) => I.surface.get(t) || t;
function dot(a, b) {
  let x = 0; const [s, l] = a.v.size < b.v.size ? [a, b] : [b, a];
  for (const [t, w] of s.v) { const o = l.v.get(t); if (o) x += w * o; }
  return x / (a.norm * b.norm);
}

// ── Public shapes: what the browser may see ───────────────────────────
// Card = what a search result shows. No full advert text, no history, no
// internal fields. Full text only comes from detail(), one listing at a time.
export function card(r) {
  return {
    id: r.id, path: r.path, title: r.title, institution: r.institution, school: r.school || '',
    funding: r.funding, stipend: r.stipend || null, deadline: r.deadline || null, deadline_text: r.deadline_text || '',
    start: r.start || '', eligibility: ELIG_LABEL[r.eligibility] || 'Not stated', degree: r.degree || 'PhD',
    programme: r.programme || '', disciplines: r.disciplines || [], supervisors: (r.supervisors || []).slice(0, 3),
    funders: (r.funders || []).slice(0, 3),
    summary: r.summary || '', url: r.url, status: r.status,
  };
}
export function detail(r) {
  return { ...card(r), description: r.description || '', funders: r.funders || [], last_checked: r.last_seen || null };
}

// ── Search ────────────────────────────────────────────────────────────
const FUNDING_ORDER = ['Fully funded', 'Competition funded', 'Partially funded', 'Self-funded', 'Unknown'];
export const PAGE_SIZE = 20;
export const MAX_PAGE = 25; // 500 results deep at most: narrow the search beyond that

export function search(I, q, today) {
  const terms = String(q.q || '').toLowerCase().split(/\s+/).filter((t) => t.length >= 2).slice(0, 8);
  const set = (k) => new Set([].concat(q[k] || []).filter(Boolean).slice(0, 20));
  const f = { funding: set('funding'), disc: set('disc'), elig: set('elig'), inst: set('inst') };
  const quick = set('quick');
  // status is set at export; the deadline check also drops adverts that closed since the last scrape
  let base = I.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'open' && (!r.deadline || r.deadline >= today));
  if (terms.length) {
    base = base.map((x) => {
      let s = 0;
      for (const t of terms) {
        const inT = I.blobs[x.i].t.includes(t), inB = I.blobs[x.i].b.includes(t);
        if (!inT && !inB) return null;
        s += (inT ? 5 : 0) + (inB ? 1 : 0);
      }
      return { ...x, s };
    }).filter(Boolean);
  }
  const elig = (r) => ELIG_LABEL[r.eligibility] || 'Not stated';
  const get = { funding: (r) => [r.funding], disc: (r) => r.disciplines || [], elig: (r) => [elig(r)], inst: (r) => [r.institution] };
  const passes = (r, skip) => {
    for (const k of Object.keys(f)) if (k !== skip && f[k].size && !get[k](r).some((v) => f[k].has(v))) return false;
    if (quick.has('funded') && r.funding !== 'Fully funded') return false;
    if (quick.has('intl') && !['Open to international', 'Anyone (self-funded)'].includes(elig(r))) return false;
    if (quick.has('soon') && !(r.deadline && daysBetween(r.deadline, today) <= 30)) return false;
    return true;
  };
  const facets = {};
  for (const k of Object.keys(f)) {
    const c = {};
    for (const { r } of base) if (passes(r, k)) for (const v of new Set(get[k](r))) c[v] = (c[v] || 0) + 1;
    facets[k] = Object.entries(c).sort((a, b) => k === 'funding' ? FUNDING_ORDER.indexOf(a[0]) - FUNDING_ORDER.indexOf(b[0]) : b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  let list = base.filter(({ r }) => passes(r));
  const dl = (r) => r.deadline || '9999';
  const sorters = {
    deadline: (a, b) => dl(a.r).localeCompare(dl(b.r)) || (b.r.funding === 'Fully funded') - (a.r.funding === 'Fully funded'),
    relevance: (a, b) => (b.s || 0) - (a.s || 0) || dl(a.r).localeCompare(dl(b.r)),
    stipend: (a, b) => (b.r.stipend || 0) - (a.r.stipend || 0) || dl(a.r).localeCompare(dl(b.r)),
    newest: (a, b) => (b.r.first_seen || '').localeCompare(a.r.first_seen || ''),
  };
  list.sort(sorters[q.sort] || (terms.length ? sorters.relevance : sorters.deadline));
  const total = list.length;
  const pages = Math.max(1, Math.min(MAX_PAGE, Math.ceil(total / PAGE_SIZE)));
  const page = Math.min(Math.max(1, parseInt(q.page, 10) || 1), pages);
  return {
    total, page, pages, capped: total > MAX_PAGE * PAGE_SIZE,
    fullyFunded: list.filter((x) => x.r.funding === 'Fully funded').length,
    results: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((x) => card(x.r)),
    facets,
  };
}

export function stats(I) {
  const open = I.rows.filter((r) => r.status === 'open');
  return {
    open: open.length,
    fullyFunded: open.filter((r) => r.funding === 'Fully funded').length,
    institutions: new Set(open.map((r) => r.institution)).size,
    updated: I.builtAt,
  };
}

// ── CV match ─────────────────────────────────────────────────────────
// Same flow as the prototype (web/cvmatch.js) but on the server: hard gates
// in code (open, eligible, chosen subjects and funding), TF-IDF overlap
// between the CV and each advert, then an explanation per match.
const GAP_SKIP = new Set(tokenise('ukri epsrc bbsrc nerc esrc ahrc mrc stfc grant grants award awards scholarship scholarships cdt dtp dla landscape bursary salary interview shortlisted').filter((t) => !t.includes(' ')));

function cvBody(text) {
  const lines = String(text).slice(0, 30000).split(/\n/);
  let k = 0;
  while (k < Math.min(4, lines.length) && lines[k].trim().split(/\s+/).length <= 5 && !/\b(msc|bsc|meng|beng|phd|degree|university)\b/i.test(lines[k])) k++;
  return lines.slice(k).join('\n');
}
function cvVector(I, text) {
  const tf = new Map();
  for (const t of tokenise(cvBody(text))) tf.set(t, (tf.get(t) || 0) + 1);
  return I.vec(tf);
}

export function readProfile(I, text) {
  const s = String(text).toLowerCase();
  const degrees = [['PhD', /\bph\.?d\b|doctorate/], ["Master's", /\b(msc|mres|meng|mphys|mchem|msci|mmath|mphil|ma|mba|llm)\b|master'?s/], ["Bachelor's", /\b(bsc|beng|ba|llb|bmus)\b|bachelor/]];
  const degree = (degrees.find(([, r]) => r.test(s)) || [''])[0];
  const hasMasters = degrees[1][1].test(s);
  const cls = /first[- ]class|\b1st\b|first class honours/.test(s) ? 'First' : /\b2[:.]1\b|upper second/.test(s) ? '2:1'
    : /\b2[:.]2\b|lower second/.test(s) ? '2:2' : /distinction/.test(s) ? 'Distinction' : /\bmerit\b/.test(s) ? 'Merit' : '';
  const cv = cvVector(I, text);
  const terms = [];
  for (const [t] of [...cv.v.entries()].filter(([t]) => !t.includes(' ') || I.df.get(t) >= 2).sort((a, b) => b[1] - a[1])) {
    const w = show(I, t); if (terms.some((x) => x.includes(w) || w.includes(x))) continue; terms.push(w); if (terms.length >= 10) break;
  }
  const sims = I.vecs.map((d, i) => [i, dot(cv, d)]).sort((a, b) => b[1] - a[1]).slice(0, 25);
  const w = new Map();
  for (const [i, sim] of sims) (I.rows[i].disciplines || []).forEach((x, k) => w.set(x, (w.get(x) || 0) + sim * (k ? 0.5 : 1)));
  const subjects = [...w.entries()].filter(([x]) => !/^Other/.test(x)).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([x]) => x);
  return { degree, hasMasters, cls, terms, subjects, cv };
}

const FUND = { full: ['Fully funded'], any: ['Fully funded', 'Competition funded', 'Partially funded'], all: null };

function flags(r, p, fee) {
  const t = ((r.description || '') + ' ' + (r.summary || '')).toLowerCase(), f = [];
  if (/first[- ]class/.test(t) && p.cls && p.cls !== 'First') f.push('Asks for a First');
  else if (/\b2[:.]1\b|upper second/.test(t) && p.cls === '2:2') f.push('Asks for a 2:1 or above');
  if (/(master'?s|msc|mres)[^.]{0,40}(required|essential|must)|(require|must have)[^.]{0,30}(master'?s|msc)/.test(t) && !p.hasMasters) f.push("May require a Master's");
  if (fee === 'intl' && (ELIG_LABEL[r.eligibility] || 'Not stated') === 'Not stated') f.push('Eligibility not stated: check the advert');
  return f;
}

export function match(I, { cv, disc, fee, funding, today, limit = 12 }) {
  const p = readProfile(I, cv);
  const discs = new Set(disc);
  const fund = FUND[funding] === undefined ? FUND.full : FUND[funding];
  const pool = I.rows.map((r, i) => [r, i]).filter(([r]) =>
    r.status === 'open' &&
    (r.disciplines || []).some((x) => discs.has(x)) &&
    (!fund || fund.includes(r.funding)) &&
    !(fee === 'intl' && r.eligibility === 'UK/Home only') &&
    (!r.deadline || daysBetween(r.deadline, today) >= 0));
  const scored = pool.map(([r, i]) => {
    const dv = I.vecs[i], shared = [];
    for (const [t, w] of p.cv.v) { const o = dv.v.get(t); if (o) shared.push([t, w * o]); }
    shared.sort((a, b) => b[1] - a[1]);
    const sim = dot(p.cv, dv);
    const gaps = [...dv.v.entries()].filter(([t]) => !p.cv.v.has(t) && !t.includes(' ') && I.df.get(t) >= 2 && !I.names.has(t) && !/\d/.test(t) && !GAP_SKIP.has(t))
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => show(I, t));
    const seen = [], why = [];
    for (const [t] of shared) { const s = show(I, t); if (seen.some((x) => x.includes(s) || s.includes(x))) continue; seen.push(s); why.push(s); if (why.length >= 7) break; }
    return { r, sim, why, gaps, flags: flags(r, p, fee) };
  }).filter((x) => x.why.length >= 2).sort((a, b) => b.sim - a.sim);
  return {
    profile: { degree: p.degree, cls: p.cls, hasMasters: p.hasMasters, terms: p.terms, subjects: p.subjects },
    considered: pool.length,
    matches: scored.slice(0, limit).map((x) => ({
      ...card(x.r),
      score: Math.max(5, Math.min(99, Math.round(100 * (1 - Math.exp(-x.sim / 0.11))))),
      why: x.why, gaps: x.gaps, flags: x.flags,
    })),
  };
}

// ── Optional AI analysis (only if ANTHROPIC_API_KEY is set) ───────────
// Fixed prompt, fixed model, capped inputs. The browser sends only its own
// CV text and a listing id: never a prompt. Same rules as The Grid's /api/qlap.
export const ANALYSE_SYSTEM = `You are a senior UK academic who supervises PhD students, advising one applicant on one specific PhD advert.
Use ONLY the CV and the advert text provided. Never invent facts about the project, the supervisor, the funding or the applicant.
If something is not stated, say it is not stated. Be honest: 70 = a strong fit, 85+ = near-perfect. Do not inflate.

Return ONLY this JSON, no markdown, short strings (max 18 words each):
{"fitScore":<0-100>,"verdict":"<20 words>",
"dimensions":{"subject":<0-100>,"methods":<0-100>,"readiness":<0-100>,"requirements":<0-100>},
"requirements":[{"r":"<stated requirement>","s":"met|partial|missing|unclear","w":"<why, 10 words>"}],
"strengths":["...","...","..."],
"gaps":[{"g":"<gap>","a":"<what to do about it>"}],
"supervisorQuestions":["<question to ask the supervisor>","...","..."],
"statementAngles":["<angle for the personal statement>","..."]}
Weights: subject fit 35%, methods and skills 25%, research readiness 20%, entry requirements and eligibility 20%.`;
export function analyseRequest(cvText, r) {
  const advert = [`Title: ${r.title}`, `University: ${r.institution}`, r.school && `Department: ${r.school}`,
    `Funding: ${r.funding}`, r.eligibility && `Eligibility: ${r.eligibility}`, r.deadline && `Deadline: ${r.deadline}`,
    `Advert text:\n${String(r.description || r.summary || '').slice(0, 3500)}`].filter(Boolean).join('\n');
  return { system: ANALYSE_SYSTEM, max_tokens: 1800, content: `APPLICANT CV:\n${String(cvText).slice(0, 6000)}\n\nPHD ADVERT:\n${advert}\n\nReturn the JSON.` };
}
