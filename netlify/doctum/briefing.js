// netlify/doctum/briefing.js — the Opportunity Briefing pipeline (supervisor deep dive).
//
// Productised version of the 4 Oct 2026 MVP (Claude project doc
// supervisor-deep-dive-mvp.md). Server only: nothing here reaches the browser.
//
//   identify(): advert page → supervisor's university profile (ORCID, research
//               interests, listed DOIs) → OpenAlex author → ORCID employment
//               cross-check → confidence high / medium / low.
//   gather():   OpenAlex works (last 10 years) → clean merged records (wrong
//               namesakes) → rank papers against the advert (and CV) → co-supervisor
//               evidence from co-authorship.
//   write():    ONE AI call that may use only the gathered material. Every claim
//               cites a paper id; the server drops citations that don't exist and
//               profile quotes that aren't verbatim.
//
// Pure ESM. Network goes through the injected `fetchFn` so tests run offline.
// Sources: university pages (robots.txt respected, one profile per supervisor,
// cached), OpenAlex (free API, polite pool), ORCID public API. Never Google
// Scholar (no API; its terms forbid scraping).

import { tokenise } from './core.js';

export const UA = 'DoctumBot/1.0 (+https://doctum.co.uk/about/; hello@doctum.co.uk)';
const OA = 'https://api.openalex.org';
const YEARS_BACK = 10;

// ── small helpers ─────────────────────────────────────────────────────
const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cap = (s, n) => { s = clean(s); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const TITLES = /\b(dr|prof|professor|mr|mrs|ms|miss|mx|sir|dame|assoc|associate|assistant|emeritus|reader|lecturer|senior|principal|phd|frs|freng|obe|mbe|cbe)\b\.?/gi;

export function parseName(raw) {
  const s = clean(String(raw || '').replace(/\(.*?\)/g, ' ').replace(/[,;].*$/, '')
    // scraper leftovers such as "Prof Kamalan Jeevaratnam Head" or "Dr X Lead supervisor"
    .replace(/\s+(head|director|lead|chair|dean|deputy|co-?supervisors?|supervisors?|school|department|faculty|email|contact)\b.*$/i, '')
    .replace(TITLES, ' ').replace(/[^\p{L}\s'.-]/gu, ' '));
  const parts = s.split(/\s+/).filter((p) => p.replace(/\./g, '').length > 0);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  const first = parts.length > 1 ? parts[0].replace(/\.$/, '') : '';
  return { full: parts.join(' '), first, last, key: fold(first.slice(0, 1) + ' ' + last) };
}

// Does an author name (OpenAlex display name / alternative) fit the advert's name?
function nameFit(target, cand) {
  const c = fold(cand).replace(/[.-]/g, ' ').split(/\s+/).filter(Boolean);
  const last = fold(target.last).replace(/[.-]/g, ' ').split(/\s+/).filter(Boolean);
  // surname: every surname token must appear (handles "Smith-Jones" and reversed East Asian order)
  if (!last.every((t) => c.includes(t))) return 0;
  if (!target.first) return 1;
  const f = fold(target.first);
  const others = c.filter((t) => !last.includes(t));
  if (others.includes(f)) return 3;
  if (others.some((t) => t[0] === f[0])) return 2;
  return 0;
}

function reconstructAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(' ');
}

const htmlText = (h) => clean(String(h || '')
  .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, '–'));

const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>#?]+/g;
const normDoi = (d) => fold(String(d || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')).replace(/[).,;]+$/, '');
const ORCID_RE = /orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i;

// ── network ───────────────────────────────────────────────────────────
export function makeNet(fetchFn, { mailto = 'hello@doctum.co.uk', openalexKey = '', timeoutMs = 20000 } = {}) {
  const robotsCache = new Map();
  async function get(url, { json = false, accept } = {}) {
    const res = await fetchFn(url, { headers: { 'User-Agent': UA, Accept: accept || (json ? 'application/json' : 'text/html,application/xhtml+xml') }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
    return json ? res.json() : res.text();
  }
  async function allowed(url) {
    let u; try { u = new URL(url); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (!robotsCache.has(u.origin)) {
      let rules = [];
      try {
        const txt = await get(u.origin + '/robots.txt', { accept: 'text/plain' });
        let applies = false;
        for (const line of txt.split(/\r?\n/)) {
          const m = line.replace(/#.*/, '').trim().match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
          if (!m) continue;
          const k = m[1].toLowerCase(), v = m[2].trim();
          if (k === 'user-agent') applies = v === '*' || /doctumbot/i.test(v);
          else if (applies && v) rules.push([k, v]);
        }
      } catch { rules = []; } // no robots.txt = allowed
      robotsCache.set(u.origin, rules);
    }
    const p = u.pathname + u.search;
    let best = null;
    for (const [k, v] of robotsCache.get(u.origin)) {
      const re = new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(p) && (!best || v.length > best[1].length)) best = [k, v];
    }
    return !best || best[0] === 'allow';
  }
  const oa = (path, params = {}) => {
    const q = new URLSearchParams({ ...params, mailto });
    if (openalexKey) q.set('api_key', openalexKey);
    return get(`${OA}${path}?${q}`, { json: true });
  };
  return { get, allowed, oa };
}

// ── 1. university profile (Mike's rule: profile first, it is ground truth) ──
const PROFILE_HINT = /(staff|people|person|persons|profile|profiles|directory|experts?|researchers?|academics?|our-people|team|members?|portal|pure|research\/)/i;

export function findProfileLink(advertHtml, advertUrl, name) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(advertHtml))) {
    const text = htmlText(m[2]);
    let href; try { href = new URL(m[1], advertUrl).href; } catch { continue; }
    if (!/^https?:/i.test(href) || href === advertUrl) continue;
    const hit = nameFit(name, text) || (fold(text).includes(fold(name.last)) && /profile|research profile|view/i.test(text) ? 1 : 0);
    // "Research Profile" links sit right after the name (QUB): look back a little
    const near = !hit && /research profile|staff profile|view profile/i.test(text) && fold(htmlText(advertHtml.slice(Math.max(0, m.index - 300), m.index))).includes(fold(name.last));
    if (!hit && !near) continue;
    out.push({ href, score: (hit || 1) + (PROFILE_HINT.test(href) ? 2 : 0) + (new URL(href).hostname === new URL(advertUrl).hostname ? 1 : 0) });
  }
  out.sort((a, b) => b.score - a.score);
  return out[0]?.href || null;
}

export function parseProfile(html, url, name) {
  const text = htmlText(html);
  if (!fold(text).includes(fold(name.last))) return null;
  const orcid = (html.match(ORCID_RE) || [])[1] || null;
  const dois = [...new Set((html.match(DOI_RE) || []).map(normDoi))].slice(0, 200);
  const title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  // research interests: the text after a heading that mentions research/interests
  let interests = '';
  const hm = text.match(/(research interests?|research overview|research areas?|my research|research)\s*\n([\s\S]{80,2400})/i);
  if (hm) interests = hm[2];
  else {
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || '';
    interests = desc + '\n' + text.slice(Math.max(0, fold(text).indexOf(fold(name.last))), 2400);
  }
  interests = cap(interests.replace(/\n+/g, ' '), 2200);
  return { url, title, orcid, dois, interests };
}

// ── 2. identity ───────────────────────────────────────────────────────
async function institutionId(net, inst) {
  const r = await net.oa('/institutions', { search: inst, filter: 'country_code:GB', 'per-page': '5', select: 'id,display_name,ror' });
  const want = fold(inst).replace(/^the /, '');
  const res = r.results || [];
  return (res.find((x) => fold(x.display_name) === want) || res[0] || null);
}

const AUTHOR_FIELDS = 'id,display_name,display_name_alternatives,orcid,works_count,cited_by_count,last_known_institutions,affiliations,topics';

function topicOverlap(author, advertTokens) {
  const names = (author.topics || []).slice(0, 15).map((t) => [t.display_name, t.subfield?.display_name, t.field?.display_name].join(' ')).join(' ');
  const tt = new Set(tokenise(names).filter((t) => !t.includes(' ')));
  let n = 0; for (const t of advertTokens) if (tt.has(t)) n++;
  return n;
}

function slimAuthor(a) {
  return {
    id: String(a.id || '').replace('https://openalex.org/', ''),
    name: a.display_name, orcid: a.orcid ? String(a.orcid).replace('https://orcid.org/', '') : null,
    works: a.works_count || 0, cites: a.cited_by_count || 0,
    institutions: (a.last_known_institutions || []).map((i) => i.display_name),
    topics: (a.topics || []).slice(0, 6).map((t) => t.display_name),
  };
}

async function orcidEmployers(net, orcid) {
  try {
    const j = await net.get(`https://pub.orcid.org/v3.0/${orcid}/employments`, { json: true });
    const out = [];
    for (const g of j['affiliation-group'] || []) for (const s of g.summaries || []) {
      const e = s['employment-summary']; if (e?.organization?.name) out.push(e.organization.name);
    }
    return out;
  } catch { return []; }
}

const instMatch = (a, b) => { const x = fold(a).replace(/^the /, ''), y = fold(b).replace(/^the /, ''); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

// Returns { name, profile, author?, candidates?, confidence, method, notes[] }
export async function identify(net, listing, supervisorRaw, progress = () => {}) {
  const name = parseName(supervisorRaw);
  if (!name) throw new Error('bad-name');
  const notes = [];
  const advertTokens = new Set(tokenise(`${listing.title} ${listing.summary || ''} ${String(listing.description || '').slice(0, 3000)}`).filter((t) => !t.includes(' ')));

  // a) the advert's own link to the supervisor's profile
  progress('Looking for the supervisor’s university profile');
  let profile = null;
  try {
    if (listing.url && await net.allowed(listing.url)) {
      const advertHtml = await net.get(listing.url);
      const link = findProfileLink(advertHtml, listing.url, name);
      if (link && await net.allowed(link)) {
        profile = parseProfile(await net.get(link), link, name);
        if (profile) notes.push('Found the supervisor’s profile through the advert’s own link.');
      } else if (link) notes.push('The advert links a profile, but the site asks robots not to read it.');
    }
  } catch (e) { console.warn('profile step', e.message); }
  if (!profile) notes.push('No university profile was found from the advert, so identity rests on OpenAlex and ORCID.');

  // b) exact match by ORCID from the profile
  progress('Matching the supervisor to their publication record');
  if (profile?.orcid) {
    try {
      const a = await net.oa(`/authors/orcid:${profile.orcid}`, { select: AUTHOR_FIELDS });
      if (a?.id) return { name, profile, author: slimAuthor(a), confidence: 'high', method: 'ORCID listed on the university profile', notes };
    } catch { notes.push('The ORCID on the profile has no OpenAlex record.'); }
  }

  // c) name + institution search
  const inst = await institutionId(net, listing.institution).catch(() => null);
  const instKey = inst ? String(inst.id).replace('https://openalex.org/', '') : null;
  let res = [];
  if (instKey) res = (await net.oa('/authors', { search: name.full, filter: `affiliations.institution.id:${instKey}`, 'per-page': '10', select: AUTHOR_FIELDS })).results || [];
  let atInst = true;
  if (!res.length) { atInst = false; res = (await net.oa('/authors', { search: name.full, 'per-page': '10', select: AUTHOR_FIELDS })).results || []; }

  const scored = res.map((a) => {
    const nf = Math.max(nameFit(name, a.display_name), ...(a.display_name_alternatives || []).map((x) => nameFit(name, x)));
    const last = (a.last_known_institutions || []).some((i) => instMatch(i.display_name, listing.institution));
    const ever = atInst || (a.affiliations || []).some((x) => instMatch(x.institution?.display_name, listing.institution));
    const topic = topicOverlap(a, advertTokens);
    return { a, nf, last, ever, topic, score: nf * 10 + (last ? 8 : ever ? 4 : 0) + Math.min(topic, 6) + Math.log10(1 + (a.works_count || 0)) };
  }).filter((x) => x.nf > 0 && x.ever).sort((x, y) => y.score - x.score);

  if (!scored.length) {
    return { name, profile, author: null, candidates: [], confidence: profile ? 'low' : 'none', method: profile ? 'University profile only' : 'Not found', notes };
  }
  const best = scored[0];
  const author = slimAuthor(best.a);

  // d) cross-checks: ORCID employment, profile DOIs
  let check = '';
  if (author.orcid) {
    const emps = await orcidEmployers(net, author.orcid);
    if (emps.some((e) => instMatch(e, listing.institution))) check = `ORCID record lists ${listing.institution} as an employer`;
  }
  if (!check && profile?.dois?.length) {
    try {
      const w = await net.oa('/works', { filter: `author.id:${author.id}`, 'per-page': '200', select: 'doi' });
      const mine = new Set((w.results || []).map((x) => normDoi(x.doi)).filter(Boolean));
      const hits = profile.dois.filter((d) => mine.has(d)).length;
      if (hits) check = `${hits} paper${hits > 1 ? 's' : ''} listed on the university profile appear in the OpenAlex record`;
    } catch { /* ignore */ }
  }
  const runnerUp = scored[1];
  const ambiguous = runnerUp && runnerUp.nf >= 2 && runnerUp.last === best.last && best.score - runnerUp.score < 4;
  let confidence;
  if (check) confidence = 'high';
  else if (best.last && best.nf >= 2 && best.topic >= 2 && !ambiguous) confidence = 'medium';
  else confidence = 'low';
  const method = check || (confidence === 'medium' ? `Name, current institution (${listing.institution}) and research topics all match` : 'Name match only');
  if (ambiguous && confidence !== 'high') notes.push('More than one researcher with this name works there.');

  const candidates = confidence === 'low' ? scored.slice(0, 4).map((x) => slimAuthor(x.a)) : [];
  return { name, profile, author, candidates, confidence, method, notes };
}

export async function fetchAuthor(net, id) {
  const a = await net.oa(`/authors/${id}`, { select: AUTHOR_FIELDS });
  return a?.id ? slimAuthor(a) : null;
}

// Three recent titles, so the student can answer "is this the right person?"
export async function sampleTitles(net, authorId) {
  try {
    const w = await net.oa('/works', { filter: `author.id:${authorId}`, sort: 'publication_date:desc', 'per-page': '3', select: 'title,publication_year' });
    return (w.results || []).map((x) => `${x.title} (${x.publication_year})`);
  } catch { return []; }
}

// ── 3. works, cleaning, ranking ───────────────────────────────────────
const WORK_FIELDS = 'id,doi,title,publication_year,publication_date,primary_location,abstract_inverted_index,authorships,primary_topic,cited_by_count,type';

export async function fetchWorks(net, authorId, now = new Date()) {
  const from = `${now.getUTCFullYear() - YEARS_BACK}-01-01`;
  const out = [];
  for (let page = 1; page <= 2; page++) {
    const r = await net.oa('/works', { filter: `author.id:${authorId},from_publication_date:${from}`, sort: 'publication_date:desc', 'per-page': '100', page: String(page), select: WORK_FIELDS });
    out.push(...(r.results || []));
    if ((r.results || []).length < 100) break;
  }
  const me = authorId.toLowerCase();
  return out.filter((w) => w.title && !['erratum', 'retraction', 'paratext'].includes(w.type)).map((w) => {
    const mine = (w.authorships || []).find((a) => String(a.author?.id || '').toLowerCase().endsWith(me));
    return {
      id: String(w.id).replace('https://openalex.org/', ''),
      doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : null,
      title: clean(w.title).replace(/<[^>]+>/g, ''), year: w.publication_year, date: w.publication_date,
      venue: w.primary_location?.source?.display_name || '',
      abstract: cap(reconstructAbstract(w.abstract_inverted_index), 2500),
      field: w.primary_topic?.field?.display_name || 'Unknown',
      topic: w.primary_topic?.display_name || '',
      authors: (w.authorships || []).map((a) => ({ id: String(a.author?.id || '').replace('https://openalex.org/', ''), name: a.author?.display_name || a.raw_author_name || '' })),
      myInsts: (mine?.institutions || []).map((i) => i.display_name),
      cites: w.cited_by_count || 0, type: w.type,
    };
  });
}

// OpenAlex sometimes merges namesakes into one author record (the MVP found a
// landslide engineer inside a materials professor's record). Works are linked
// when they share a co-author or this author's affiliation; the largest linked
// group is the real person. A work is excluded only when it sits outside that
// group AND its field is not one the group works in AND the university profile
// doesn't list its DOI. Excluded works are listed in the briefing.
export function cleanMerged(works, { authorId, profileDois = [] } = {}) {
  if (works.length < 6) return { kept: works, excluded: [] };
  const parent = works.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const seen = new Map();
  works.forEach((w, i) => {
    const keys = [...w.authors.filter((a) => a.id && a.id !== authorId).map((a) => 'a:' + a.id), ...w.myInsts.map((x) => 'i:' + fold(x))];
    for (const k of keys) { if (seen.has(k)) join(i, seen.get(k)); else seen.set(k, i); }
  });
  const size = {};
  works.forEach((_, i) => { const r = find(i); size[r] = (size[r] || 0) + 1; });
  const main = Number(Object.entries(size).sort((a, b) => b[1] - a[1])[0][0]);
  const mainFields = new Set(works.filter((_, i) => find(i) === main).map((w) => w.field));
  const listed = new Set(profileDois.map(normDoi));
  const kept = [], excluded = [];
  works.forEach((w, i) => {
    const suspect = find(i) !== main && !mainFields.has(w.field) && !(w.doi && listed.has(normDoi(w.doi)));
    (suspect ? excluded : kept).push(w);
  });
  return { kept, excluded };
}

export function rankWorks(works, { advert, profileText = '', cv = '', now = new Date() }) {
  const df = new Map();
  const docs = works.map((w) => {
    const tf = new Map();
    for (const [t, k] of [[w.title, 2], [w.abstract, 1], [w.topic, 1]]) for (const x of tokenise(t)) tf.set(x, (tf.get(x) || 0) + k);
    for (const x of tf.keys()) df.set(x, (df.get(x) || 0) + 1);
    return tf;
  });
  const N = works.length || 1;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 0.5));
  const vec = (tf) => { const v = new Map(); let n = 0; for (const [t, c] of tf) { const x = (1 + Math.log(c)) * idf(t); v.set(t, x); n += x * x; } return { v, n: Math.sqrt(n) || 1 }; };
  const q = new Map();
  for (const [t, k] of [[advert, 1], [profileText, 0.4], [String(cv).slice(0, 6000), 0.2]]) for (const x of tokenise(t)) q.set(x, (q.get(x) || 0) + k);
  const qv = vec(q);
  const year = now.getUTCFullYear();
  return works.map((w, i) => {
    const d = vec(docs[i]); let s = 0;
    for (const [t, x] of qv.v) { const y = d.v.get(t); if (y) s += x * y; }
    const sim = s / (qv.n * d.n);
    const recency = Math.max(0, 4 - (year - (w.year || year - 10))) * 0.02;
    return { ...w, rel: sim + recency + Math.min(0.03, Math.log10(1 + w.cites) * 0.01) + (w.abstract ? 0.01 : 0) };
  }).sort((a, b) => b.rel - a.rel);
}

export function coSupervisorEvidence(listing, mainName, works) {
  return (listing.supervisors || []).map(parseName).filter((n) => n && n.key !== mainName.key).slice(0, 4).map((n) => {
    const shared = works.filter((w) => w.authors.some((a) => nameFit(n, a.name) >= 2));
    return { name: n.full, sharedPapers: shared.length, latest: shared.reduce((m, w) => Math.max(m, w.year || 0), 0) || null, examples: shared.slice(0, 3).map((w) => w.title) };
  });
}

// ── 4. the AI write ───────────────────────────────────────────────────
export const BRIEFING_SYSTEM = `You write an "opportunity briefing" for one applicant considering one UK PhD advert. You are a careful senior UK academic.

STRICT RULES
- Use ONLY the material supplied: the advert, the supervisor's university profile excerpt, the numbered papers (P1, P2 … with abstracts; W1, W2 … titles only), the co-supervisor evidence and, if given, the applicant's CV.
- Every factual claim about the supervisor's work must cite paper ids in "refs" (e.g. ["P2","W7"]) or say it comes from the profile or advert. Never cite an id that was not supplied.
- Papers marked W have titles only: never describe their findings, only their topic.
- Do not invent methods, results, collaborators, facilities, grants, student numbers or personal details. If something is not in the material, leave it out or say it is not stated.
- Professional research information only. Nothing about the supervisor's private life.
- "bigPicture" is general sector background. Keep it short and factual. It is labelled as general background on the page.
- This is a study guide, not a script: never write an email or a cover letter for the applicant.
- If no CV is supplied, set every skills "cv" to "" and "status" to "unknown", and write "whyFit" as what a strong applicant would bring.
- Plain British English. Short sentences. No hype.

Return ONLY this JSON (no markdown):
{"atAGlance":{"whyFit":["<=25 words",3 items],"gaps":["<=25 words",2-3 items],"thisWeek":["<=25 words",3 items]},
"supervisorSummary":"<=60 words: what the group works on, from the profile and papers",
"profileQuote":"<a sentence copied EXACTLY from the profile excerpt, or empty string>",
"coSupervisors":[{"name":"","note":"<=30 words, only from the evidence given"}],
"readFirst":[{"ref":"P#","why":"<=60 words: what it found and why it matters for THIS project"}],
"alsoSkim":[{"ref":"P# or W#","why":"<=25 words"}],
"thread":[{"period":"e.g. 2019–21","text":"<=45 words","refs":["P#"]}],
"otherStrands":["<=25 words: a separate strand not related to this project"],
"skills":[{"skill":"","evidence":"<=20 words: where it shows up in their work","refs":["P#"],"cv":"<=20 words: what the CV shows","status":"matched|partial|gap|unknown","action":"<=25 words"}],
"openQuestions":[{"q":"<=30 words","refs":["P#"],"angle":"<=30 words: how to use it in conversation"}],
"interview":{"likely":["<=25 words",4-5 items],"toAsk":["<=25 words",3-4 items]},
"bigPicture":"<=90 words",
"approach":["<=30 words: angle for first contact, not a script",3 items],
"limits":["<=30 words: what this briefing could not check"]}
readFirst: exactly 3 papers, P ids only. thread: 3-6 steps in date order, project-relevant strand only. skills: 6-9 rows. openQuestions: 3-4.`;

export function promptMaterial({ listing, identity, ranked, others, coSup, cv }) {
  const L = [`PHD ADVERT`, `Title: ${listing.title}`, `University: ${listing.institution}`, listing.school && `Department: ${listing.school}`,
    `Funding: ${listing.funding}`, listing.deadline && `Deadline: ${listing.deadline}`, listing.start && `Start: ${listing.start}`,
    (listing.supervisors || []).length && `Supervisors named: ${listing.supervisors.join(', ')}`,
    `Advert text:\n${String(listing.description || listing.summary || '').slice(0, 4000)}`].filter(Boolean);
  L.push('', `LEAD SUPERVISOR: ${identity.name.full}`);
  if (identity.profile?.interests) L.push(`University profile excerpt (${identity.profile.url}):\n${identity.profile.interests}`);
  else L.push('University profile: not found.');
  if (identity.author) L.push(`OpenAlex topics: ${identity.author.topics.join('; ')}`);
  L.push('', 'PAPERS WITH ABSTRACTS (most relevant to the advert first)');
  for (const w of ranked) L.push(`[${w.ref}] ${w.title} (${w.year}${w.venue ? ', ' + w.venue : ''}). Authors: ${w.authors.slice(0, 8).map((a) => a.name).join(', ')}${w.authors.length > 8 ? ' et al.' : ''}.\nAbstract: ${w.abstract ? w.abstract.slice(0, 1100) : '(no abstract available: title only)'}`);
  if (others.length) {
    L.push('', 'OTHER PAPERS (titles only, newest first)');
    for (const w of others) L.push(`[${w.ref}] ${w.year}: ${w.title}${w.venue ? ' (' + w.venue + ')' : ''}`);
  }
  if (coSup.length) {
    L.push('', 'CO-SUPERVISOR EVIDENCE (co-authorship with the lead supervisor in the papers above)');
    for (const c of coSup) L.push(`${c.name}: ${c.sharedPapers ? `${c.sharedPapers} shared paper(s), latest ${c.latest}. e.g. ${c.examples.join(' | ')}` : 'no shared papers found in this record'}`);
  }
  L.push('', cv ? `APPLICANT CV:\n${String(cv).slice(0, 6000)}` : 'APPLICANT CV: not supplied.');
  L.push('', 'Return the JSON.');
  return L.join('\n');
}

const S = (v, n) => (typeof v === 'string' ? cap(v, n) : '');
const A = (v, k) => (Array.isArray(v) ? v.slice(0, k) : []);

// Validate the model's JSON: cap lengths, drop unknown refs, check the quote.
export function validateReport(j, { refs, profileText }) {
  const ok = (r) => typeof r === 'string' && refs.has(r);
  const R = (v) => A(v, 6).filter(ok);
  const quote = S(j?.profileQuote, 400);
  const quoteOk = quote && profileText && clean(profileText).toLowerCase().includes(clean(quote).replace(/[“”"]/g, '').replace(/…$/, '').toLowerCase());
  const STAT = new Set(['matched', 'partial', 'gap', 'unknown']);
  const out = {
    atAGlance: { whyFit: A(j?.atAGlance?.whyFit, 4).map((x) => S(x, 220)), gaps: A(j?.atAGlance?.gaps, 4).map((x) => S(x, 220)), thisWeek: A(j?.atAGlance?.thisWeek, 4).map((x) => S(x, 220)) },
    supervisorSummary: S(j?.supervisorSummary, 500),
    profileQuote: quoteOk ? quote : '',
    coSupervisors: A(j?.coSupervisors, 4).map((c) => ({ name: S(c?.name, 80), note: S(c?.note, 240) })).filter((c) => c.name),
    readFirst: A(j?.readFirst, 3).filter((x) => ok(x?.ref) && x.ref.startsWith('P')).map((x) => ({ ref: x.ref, why: S(x.why, 500) })),
    alsoSkim: A(j?.alsoSkim, 5).filter((x) => ok(x?.ref)).map((x) => ({ ref: x.ref, why: S(x.why, 220) })),
    thread: A(j?.thread, 7).map((t) => ({ period: S(t?.period, 30), text: S(t?.text, 360), refs: R(t?.refs) })).filter((t) => t.text && t.refs.length),
    otherStrands: A(j?.otherStrands, 3).map((x) => S(x, 220)).filter(Boolean),
    skills: A(j?.skills, 10).map((s) => ({ skill: S(s?.skill, 90), evidence: S(s?.evidence, 200), refs: R(s?.refs), cv: S(s?.cv, 200), status: STAT.has(s?.status) ? s.status : 'unknown', action: S(s?.action, 220) })).filter((s) => s.skill),
    openQuestions: A(j?.openQuestions, 5).map((q) => ({ q: S(q?.q, 260), refs: R(q?.refs), angle: S(q?.angle, 260) })).filter((q) => q.q && q.refs.length),
    interview: { likely: A(j?.interview?.likely, 6).map((x) => S(x, 220)), toAsk: A(j?.interview?.toAsk, 5).map((x) => S(x, 220)) },
    bigPicture: S(j?.bigPicture, 800),
    approach: A(j?.approach, 4).map((x) => S(x, 260)),
    limits: A(j?.limits, 5).map((x) => S(x, 260)),
  };
  if (out.readFirst.length < 1 || out.skills.length < 3) throw new Error('report-incomplete');
  return out;
}

export async function callModel(fetchFn, { key, model, system, content, maxTokens = 8000 }) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`model HTTP ${res.status} ${t.slice(0, 200)}`); }
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: j.usage || null };
}

// Gather + write. `identity` comes from identify() (or a confirmed candidate).
export async function buildBriefing({ net, fetchFn, listing, identity, cv = '', key, model, now = new Date(), progress = () => {}, worksCache }) {
  let works = [], excluded = [];
  if (identity.author) {
    progress('Reading their papers from the last ten years');
    works = worksCache ? await worksCache(identity.author.id, () => fetchWorks(net, identity.author.id, now)) : await fetchWorks(net, identity.author.id, now);
    ({ kept: works, excluded } = cleanMerged(works, { authorId: identity.author.id, profileDois: identity.profile?.dois || [] }));
  }
  if (!works.length && !identity.profile) throw new Error('no-material');

  progress('Picking the papers that matter for this project');
  const advert = `${listing.title} ${listing.title} ${listing.summary || ''} ${String(listing.description || '').slice(0, 5000)}`;
  const ranked = rankWorks(works, { advert, profileText: identity.profile?.interests || '', cv, now });
  const withAbs = ranked.filter((w) => w.abstract).slice(0, 12);
  const titlesOnly = ranked.filter((w) => !w.abstract).slice(0, 2);
  const detailed = [...withAbs, ...titlesOnly].map((w, i) => ({ ...w, ref: 'P' + (i + 1) }));
  const used = new Set(detailed.map((w) => w.id));
  const others = works.filter((w) => !used.has(w.id)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 70).map((w, i) => ({ ...w, ref: 'W' + (i + 1) }));
  const coSup = coSupervisorEvidence(listing, identity.name, works);

  progress('Writing your briefing');
  const content = promptMaterial({ listing, identity, ranked: detailed, others, coSup, cv });
  const refs = new Set([...detailed, ...others].map((w) => w.ref));
  let report, usage = null, lastErr;
  for (let attempt = 0; attempt < 2 && !report; attempt++) {
    try {
      const r = await callModel(fetchFn, { key, model, system: BRIEFING_SYSTEM, content });
      usage = r.usage;
      const t = r.text;
      report = validateReport(JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)), { refs, profileText: identity.profile?.interests || '' });
    } catch (e) { lastErr = e; console.warn('briefing write attempt failed', e.message); }
  }
  if (!report) throw lastErr || new Error('write-failed');

  const paper = (w) => ({ ref: w.ref, title: w.title, year: w.year, venue: w.venue, doi: w.doi, url: w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}`, authors: w.authors.slice(0, 6).map((a) => a.name), more: Math.max(0, w.authors.length - 6), hasAbstract: !!w.abstract });
  return {
    version: 1,
    created: now.toISOString(),
    listing: { id: listing.id, path: listing.path, title: listing.title, institution: listing.institution, school: listing.school || '', funding: listing.funding, stipend: listing.stipend || null, deadline: listing.deadline || null, deadline_text: listing.deadline_text || '', start: listing.start || '', eligibility: listing.eligibility || '', url: listing.url, supervisors: listing.supervisors || [] },
    supervisor: { name: identity.name.full, profileUrl: identity.profile?.url || null, orcid: identity.author?.orcid || identity.profile?.orcid || null, openalex: identity.author ? `https://openalex.org/${identity.author.id}` : null, topics: identity.author?.topics || [] },
    identity: { confidence: identity.confidence, method: identity.method, notes: identity.notes, confirmedByUser: !!identity.confirmedByUser },
    stats: { works: works.length + excluded.length, kept: works.length, withAbstracts: works.filter((w) => w.abstract).length, excluded: excluded.length },
    excluded: excluded.slice(0, 30).map((w) => ({ title: w.title, year: w.year, field: w.field })),
    papers: Object.fromEntries([...detailed, ...others].map((w) => [w.ref, paper(w)])),
    hadCv: !!cv,
    model, usage,
    report,
  };
}
