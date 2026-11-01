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
const instMatch = (a, b) => { const x = fold(a).replace(/^the /, ''), y = fold(b).replace(/^the /, ''); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
async function institutionId(net, inst) {
  const want = fold(inst).replace(/^the /, '');
  for (const filter of ['country_code:GB', null]) {   // UK first; then worldwide (companies, overseas partners)
    const r = await net.oa('/institutions', { search: inst, ...(filter ? { filter } : {}), 'per-page': '5', select: 'id,display_name,ror,type' });
    const res = r.results || [];
    const hit = res.find((x) => fold(x.display_name) === want) || res.find((x) => instMatch(x.display_name, inst)) || (filter ? null : res[0]);
    if (hit) return hit;
  }
  return null;
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


// Returns { name, profile, author?, candidates?, confidence, method, notes[] }
// opts.institution: where this person works if not the advertising university (e.g. an industry
// co-supervisor "at AstraZeneca"); opts.skipProfile: don't look for a university profile link.
export async function identify(net, listing, supervisorRaw, progress = () => {}, opts = {}) {
  const HOME = opts.institution || listing.institution;
  const name = parseName(supervisorRaw);
  if (!name) throw new Error('bad-name');
  const notes = [];
  const advertTokens = new Set(tokenise(`${listing.title} ${listing.summary || ''} ${String(listing.description || '').slice(0, 3000)}`).filter((t) => !t.includes(' ')));

  // a) the advert's own link to the supervisor's profile
  progress('Looking for the supervisor’s university profile');
  let profile = null;
  try {
    if (!opts.skipProfile && listing.url && await net.allowed(listing.url)) {
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
  const inst = await institutionId(net, HOME).catch(() => null);
  const instKey = inst ? String(inst.id).replace('https://openalex.org/', '') : null;
  let res = [];
  if (instKey) res = (await net.oa('/authors', { search: name.full, filter: `affiliations.institution.id:${instKey}`, 'per-page': '10', select: AUTHOR_FIELDS })).results || [];
  let atInst = true;
  if (!res.length) { atInst = false; res = (await net.oa('/authors', { search: name.full, 'per-page': '10', select: AUTHOR_FIELDS })).results || []; }

  const scored = res.map((a) => {
    const nf = Math.max(nameFit(name, a.display_name), ...(a.display_name_alternatives || []).map((x) => nameFit(name, x)));
    const last = (a.last_known_institutions || []).some((i) => instMatch(i.display_name, HOME));
    const ever = atInst || (a.affiliations || []).some((x) => instMatch(x.institution?.display_name, HOME));
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
    if (emps.some((e) => instMatch(e, HOME))) check = `ORCID record lists ${HOME} as an employer`;
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
  const method = check || (confidence === 'medium' ? `Name, current institution (${HOME}) and research topics all match` : 'Name match only');
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
export async function fetchWorks(net, authorId, now = new Date()) {
  const from = `${now.getUTCFullYear() - YEARS_BACK}-01-01`;
  const out = [];
  for (let page = 1; page <= 2; page++) {
    // No `select`: the funding fields have changed names over OpenAlex versions (grants -> funders/awards)
    // and selecting a field that doesn't exist is an error. Read whichever is present.
    const r = await net.oa('/works', { filter: `author.id:${authorId},from_publication_date:${from}`, sort: 'publication_date:desc', 'per-page': '100', page: String(page) });
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
      orgs: [...new Set((w.authorships || []).flatMap((a) => (a.institutions || []).map((i) => i.display_name)).filter(Boolean))].slice(0, 40),
      funders: [...new Set([
        ...(w.grants || []).map((g) => g.funder_display_name || g.funder?.display_name),
        ...(w.funders || []).map((f) => f.display_name || f.funder_display_name),
        ...(w.awards || []).map((g) => g.funder_display_name || g.funder?.display_name),
      ].filter(Boolean))].slice(0, 20),
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

// ── 3b. the team, funders and others named in the advert ─────────────
export function coSupervisorEvidence(listing, mainName, works) {
  return (listing.supervisors || []).map(parseName).filter((n) => n && n.key !== mainName.key).slice(0, 4).map((n) => {
    const shared = works.filter((w) => w.authors.some((a) => nameFit(n, a.name) >= 2));
    return { name: n.full, sharedPapers: shared.length, latest: shared.reduce((m, w) => Math.max(m, w.year || 0), 0) || null, examples: shared.slice(0, 3).map((w) => w.title) };
  });
}

const TITLED = /\b(?:Dr|Prof(?:essor)?|Mr|Ms|Mrs|Miss)\.?\s+[A-Z][A-Za-z'’\-]+(?:\s+(?:[A-Z]\.?\s*)?[A-Z][A-Za-z'’\-]+){0,3}/g;
const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "…Dr James Garnett and Dr Catherine Overed-Sayer at AstraZeneca…" → "AstraZeneca" for both.
// "Dr Jennifer Dickens in CIMR" → null ("in" = a department of the advertising university).
export function affiliationHint(text, raw) {
  const n = parseName(raw); if (!n) return null;
  const t = String(text || '');
  const m0 = new RegExp(`${esc(n.last)}\\b`).exec(t);
  if (!m0) return null;
  const tail = t.slice(m0.index + m0[0].length, m0.index + m0[0].length + 200).split(/(?<!\b(?:Dr|Prof|Mr|Ms|Mrs))\.\s+(?=[A-Z])|\n/)[0];
  const m = tail.match(/^(?:\s*(?:,|and|&)\s*(?:Dr|Prof(?:essor)?|Mr|Ms|Mrs)\.?\s+[A-Z][\w'’\-]+(?:\s+[A-Z][\w'’\-]+){0,2})*\s*[,(]?\s*(?:at|from|of)\s+(?:the\s+)?([A-Z][\w&'’.\-]*(?:\s+(?:of|and|for|&)?\s*[A-Z][\w&'’.\-]*){0,5})/);
  if (!m) return null;
  const org = clean(m[1]).replace(/[),.;:]+$/, '');
  return /^(?:the\s+)?(?:School|Department|Faculty|Centre|Center|Institute|Lab|Laboratory|Group|Division|Unit)\b/i.test(org) ? null : org;
}

// Titled people named in the advert who aren't supervisors (collaborators, contacts).
export function othersInAdvert(text, teamRaw) {
  const t = String(text || '');
  const seen = new Set(teamRaw.map((x) => fold(parseName(x)?.last || '')).filter(Boolean));
  const out = [];
  for (const m of t.matchAll(TITLED)) {
    const n = parseName(m[0]);
    if (!n || !n.first || seen.has(fold(n.last))) continue;
    seen.add(fold(n.last));
    out.push({ name: n.full, context: clean(t.slice(Math.max(0, m.index - 110), m.index + m[0].length + 110)) });
    if (out.length >= 4) break;
  }
  return out;
}

const UKRI = {
  EPSRC: 'Engineering and Physical Sciences Research Council', BBSRC: 'Biotechnology and Biological Sciences Research Council',
  NERC: 'Natural Environment Research Council', ESRC: 'Economic and Social Research Council', AHRC: 'Arts and Humanities Research Council',
  MRC: 'Medical Research Council', STFC: 'Science and Technology Facilities Council', UKRI: 'UK Research and Innovation', 'Innovate UK': 'Innovate UK',
};
const CHARITIES = ['Wellcome', 'Cancer Research UK', 'Leverhulme', 'Royal Society', 'British Heart Foundation', 'BHF', 'Nuffield', 'Royal Academy of Engineering', 'Alzheimer', 'Diabetes UK', 'Versus Arthritis'];
export function funderKind(f) {
  const x = fold(f);
  if (UKRI[f] || /research council|ukri|innovate uk/.test(x)) return 'UK research council (UKRI)';
  if (CHARITIES.some((c) => x.includes(fold(c)))) return 'Charity or foundation';
  if (/nihr|dfe|department for|government|ministry|defra|mod\b|dstl/.test(x)) return 'Government';
  if (/horizon|marie|european|erc\b/.test(x)) return 'European programme';
  if (/university|college/.test(x)) return 'University';
  return 'Industry or other organisation';
}
const funderKeys = (f) => [f, UKRI[f]].filter(Boolean).map((x) => fold(x).replace(/\s*\(.*\)$/, ''));

// Evidence of an existing relationship, straight from OpenAlex: papers that acknowledge the
// funder, and papers with co-authors from the partner organisation.
export function funderEvidence(names, teamWorks) {
  return names.slice(0, 4).map((f) => {
    const keys = funderKeys(f);
    const hit = (str) => { const x = fold(str); return keys.some((k) => k.length > 2 && x.includes(k)); };
    const per = teamWorks.map(({ name, works, org }) => {
      const worksThere = !!org && hit(org);   // their own employer isn't a "collaboration"
      const ack = works.filter((w) => (w.funders || []).some(hit));
      const co = worksThere ? [] : works.filter((w) => (w.orgs || []).some(hit));
      const ex = [...new Map([...ack, ...co].map((w) => [w.id, w])).values()].sort((a, b) => (b.year || 0) - (a.year || 0)).slice(0, 3);
      return { name, worksThere, acknowledged: ack.length, coauthored: co.length, examples: ex.map((w) => ({ title: w.title, year: w.year, url: w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}` })) };
    });
    return { funder: f, kind: funderKind(f), per };
  });
}

// ── 4. the AI write ───────────────────────────────────────────────────
export const BRIEFING_SYSTEM = `You write an "opportunity briefing" for one applicant considering one UK PhD advert. You are a careful senior UK academic.

STRICT RULES
- Use ONLY the material supplied: the advert, the supervisors' profile excerpts and identity notes, the numbered papers (P1, P2 … with abstracts; W1, W2 … titles only), the team overlap, the funder and partner evidence, the other people named in the advert and, if given, the applicant's CV.
- Every factual claim about anyone's research must cite paper ids in "refs" (e.g. ["P2","W7"]) or come from a profile excerpt or the advert. Never cite an id that was not supplied.
- Papers marked W have titles only: never describe their findings, only their topic.
- A supervisor whose publication record is marked NOT CONFIRMED: say only what the advert says about them. Never guess anyone's employer, job title or role beyond the advert and profiles.
- "funder.relationship" must come ONLY from the FUNDER AND PARTNER EVIDENCE section (counts and titles). If that evidence is empty or zero, return "".
- Do not invent methods, results, collaborators, facilities, grants, student numbers or personal details. If something is not in the material, leave it out or say it is not stated.
- Professional research information only. Nothing about anyone's private life.
- "bigPicture" and "funder.summary" are general background. Keep them short and factual. They are labelled as general background on the page.
- This is a study guide, not a script: never write an email or a cover letter for the applicant.
- If no CV is supplied, set every skills "cv" to "" and "status" to "unknown", and write "whyFit" as what a strong applicant would bring.
- Paper ids (P1, W3 …) are for the "ref" and "refs" fields ONLY. Never write an id in any text: the student never sees them. In text, refer to a paper by a short version of its title and its year, e.g. "the 2025 dual spherical harmonics paper".
- Plain British English. Short sentences. No hype.

Return ONLY this JSON (no markdown):
{"atAGlance":{"whyFit":["<=25 words",3 items],"gaps":["<=25 words",2-3 items],"thisWeek":["<=25 words",3 items]},
"team":[{"name":"<exactly as given in TEAM>","summary":"<=50 words: their research focus and what they bring to this project","refs":["P#"]}],
"profileQuote":"<one full sentence (not a list of keywords) copied EXACTLY from the lead supervisor's profile excerpt, or empty string>",
"teamFit":"<=80 words: how the team's expertise combines for this project and what that means day to day; mention shared papers if the overlap section lists any",
"teamFitRefs":["P#"],
"funder":{"summary":"<=60 words: what kind of funder or partner this is and what that usually means for a PhD student","relationship":"<=50 words from the evidence only, or empty","angles":["<=25 words: interview or conversation angle about the funder or partner",2-3 items]},
"others":[{"name":"<exactly as given in OTHERS>","note":"<=25 words: their part in the project, from the advert context only"}],
"readFirst":[{"ref":"P#","why":"<=60 words: what it found and why it matters for THIS project"}],
"alsoSkim":[{"ref":"P# or W#","why":"<=25 words"}],
"thread":[{"period":"e.g. 2019–21","text":"<=45 words","refs":["P#"]}],
"otherStrands":["<=25 words: a separate strand not related to this project"],
"skills":[{"skill":"","evidence":"<=20 words: where it shows up in the team's work","refs":["P#"],"cv":"<=20 words: what the CV shows","status":"matched|partial|gap|unknown","action":"<=25 words"}],
"openQuestions":[{"q":"<=30 words","refs":["P#"],"angle":"<=30 words: how to use it in conversation"}],
"interview":{"likely":["<=25 words",4-5 items],"toAsk":["<=25 words",3-4 items]},
"bigPicture":"<=90 words",
"approach":["<=30 words: angle for first contact, not a script",3 items],
"limits":["<=30 words: what this briefing could not check"]}
team: one entry per TEAM member, in the same order. readFirst: exactly 3 papers, P ids only, chosen across the whole team. thread: 3-6 steps in date order, project-relevant strand only (it may combine team members). skills: 6-9 rows. openQuestions: 3-4. others: one per OTHERS entry, or [] if none.`;

const who = (w, team) => team.filter((m) => m.ids.has(w.id)).map((m) => m.name);

export function promptMaterial({ listing, advertText, team, ranked, others, overlap, funders, people, cv }) {
  const L = [`PHD ADVERT`, `Title: ${listing.title}`, `University: ${listing.institution}`, listing.school && `Department: ${listing.school}`,
    `Funding: ${listing.funding}`, (listing.funders || []).length && `Funders named: ${listing.funders.join(', ')}`,
    listing.deadline && `Deadline: ${listing.deadline}`, listing.start && `Start: ${listing.start}`,
    `Advert text:\n${String(advertText || listing.description || listing.summary || '').slice(0, 8000)}`].filter(Boolean);
  L.push('', 'TEAM (lead first)');
  for (const m of team) {
    L.push(`- ${m.name} | ${m.roleLabel}${m.org ? ` | at ${m.org}` : ''} | publication record: ${m.confirmed ? `confirmed (${m.method})` : 'NOT CONFIRMED'}`);
    if (m.profile?.interests) L.push(`  Profile excerpt (${m.profile.url}): ${m.profile.interests}`);
    if (m.topics?.length) L.push(`  OpenAlex topics: ${m.topics.join('; ')}`);
  }
  L.push('', 'PAPERS WITH ABSTRACTS (most relevant to the advert first)');
  for (const w of ranked) L.push(`[${w.ref}] ${w.title} (${w.year}${w.venue ? ', ' + w.venue : ''}). Team authors: ${who(w, team).join(', ') || 'n/a'}. All authors: ${w.authors.slice(0, 8).map((a) => a.name).join(', ')}${w.authors.length > 8 ? ' et al.' : ''}.\nAbstract: ${w.abstract ? w.abstract.slice(0, 1000) : '(no abstract available: title only)'}`);
  if (others.length) {
    L.push('', 'OTHER PAPERS (titles only, newest first)');
    for (const w of others) L.push(`[${w.ref}] ${w.year}: ${w.title}${w.venue ? ' (' + w.venue + ')' : ''} [${who(w, team).join(', ')}]`);
  }
  if (overlap.length) {
    L.push('', 'TEAM OVERLAP (papers co-authored by team members)');
    for (const o of overlap) L.push(`${o.a} + ${o.b}: ${o.n ? `${o.n} shared paper(s), latest ${o.latest}${o.refs.length ? '; e.g. ' + o.refs.join(', ') : ''}` : 'no shared papers found'}`);
  }
  if (funders.length) {
    L.push('', 'FUNDER AND PARTNER EVIDENCE (from OpenAlex: papers acknowledging the funder, and papers with co-authors from that organisation)');
    for (const f of funders) {
      L.push(`${f.funder} (${f.kind}):`);
      for (const p of f.per) L.push(`  ${p.name}: ${p.worksThere ? 'works there; ' : ''}${p.acknowledged} paper(s) acknowledge it; ${p.worksThere ? '' : `${p.coauthored} co-authored with people there`}${p.examples.length ? `; e.g. ${p.examples.map((e) => `"${e.title}" (${e.year})`).join('; ')}` : ''}`);
    }
  }
  if (people.length) {
    L.push('', 'OTHERS NAMED IN THE ADVERT (not listed as supervisors)');
    for (const o of people) L.push(`- ${o.name}: "…${o.context}…"`);
  }
  L.push('', cv ? `APPLICANT CV:\n${String(cv).slice(0, 6000)}` : 'APPLICANT CV: not supplied.');
  L.push('', 'Return the JSON.');
  return L.join('\n');
}

const A = (v, k) => (Array.isArray(v) ? v.slice(0, k) : []);

// Ids that slip into text become "the 2025 paper “Dual Spherical Harmonics for…”".
export function deRef(text, papers) {
  if (!text || !papers) return text;
  const label = (id) => { const p = papers.get(id); if (!p) return null; const w = p.title.split(/\s+/); return `“${w.slice(0, 6).join(' ')}${w.length > 6 ? '…' : ''}” (${p.year})`; };
  return text
    .replace(/\b(?:papers?\s+)?((?:[PW]\d{1,2})(?:\s*(?:,|and|or|&)\s*[PW]\d{1,2})*)\b/g, (m, list) => {
      const ids = list.split(/\s*(?:,|and|or|&)\s*/);
      const labels = ids.map(label);
      if (labels.some((x) => !x)) return m.replace(/\b[PW]\d{1,2}\b/g, (id) => label(id) || 'one of their papers');
      const joiner = /\bor\b/.test(list) ? ' or ' : ' and ';
      return labels.length > 1 ? labels.slice(0, -1).join(', ') + joiner + labels[labels.length - 1] : labels[0];
    })
    .replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ');
}

// Validate the model's JSON: cap lengths, drop unknown refs and people, check the quote.
export function validateReport(j, { refs, profileText, papers, teamNames = [], otherNames = [], funderEvidenceTotal = 0 }) {
  const ok = (r) => typeof r === 'string' && refs.has(r);
  const R = (v) => A(v, 6).filter(ok);
  const S = (v, n) => (typeof v === 'string' ? cap(deRef(v, papers), n) : '');
  const quote = S(j?.profileQuote, 400);
  const isSentence = quote.split(/\s+/).length >= 8 && (quote.match(/;/g) || []).length < 2;
  const quoteOk = isSentence && profileText && clean(profileText).toLowerCase().includes(clean(quote).replace(/[“”"]/g, '').replace(/…$/, '').toLowerCase());
  const STAT = new Set(['matched', 'partial', 'gap', 'unknown']);
  const known = new Map(teamNames.map((n) => [fold(n), n]));
  const knownOthers = new Map(otherNames.map((n) => [fold(n), n]));
  const out = {
    atAGlance: { whyFit: A(j?.atAGlance?.whyFit, 4).map((x) => S(x, 220)), gaps: A(j?.atAGlance?.gaps, 4).map((x) => S(x, 220)), thisWeek: A(j?.atAGlance?.thisWeek, 4).map((x) => S(x, 220)) },
    team: A(j?.team, 5).map((t) => ({ name: known.get(fold(t?.name)) || '', summary: S(t?.summary, 400), refs: R(t?.refs) })).filter((t) => t.name && t.summary),
    profileQuote: quoteOk ? quote : '',
    teamFit: teamNames.length > 1 ? S(j?.teamFit, 700) : '',
    teamFitRefs: teamNames.length > 1 ? R(j?.teamFitRefs) : [],
    funder: {
      summary: S(j?.funder?.summary, 500),
      relationship: funderEvidenceTotal > 0 ? S(j?.funder?.relationship, 400) : '',
      angles: A(j?.funder?.angles, 3).map((x) => S(x, 220)).filter(Boolean),
    },
    others: A(j?.others, 4).map((o) => ({ name: knownOthers.get(fold(o?.name)) || '', note: S(o?.note, 220) })).filter((o) => o.name && o.note),
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

export async function callModel(fetchFn, { key, model, system, content, maxTokens = 10000 }) {
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`model HTTP ${res.status} ${t.slice(0, 200)}`); }
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: j.usage || null };
}

const CONFIRMED = new Set(['high', 'medium', 'confirmed']);
const ROLE = { lead: 'Lead supervisor', co: 'Co-supervisor', external: 'External co-supervisor' };

// Gather + write. `identity` is the lead supervisor (from identify() or a confirmed candidate).
// Everyone else named on the advert is identified here too (up to 3 more), without a confirm step:
// a co-supervisor we can't confirm is still named, from the advert only, with no papers.
export async function buildBriefing({ net, fetchFn, listing, identity, cv = '', key, model, now = new Date(), progress = () => {}, worksCache, identCache }) {
  // the whole advert, not just the stored excerpt
  let advertText = String(listing.description || listing.summary || '');
  try {
    if (listing.url && await net.allowed(listing.url)) {
      const t = htmlText(await net.get(listing.url));
      const k = t.indexOf(String(listing.title).slice(0, 40));
      const body = (k >= 0 ? t.slice(k) : t).slice(0, 9000);
      if (body.length >= 300) {
        // prefer the live page; keep the stored text too if the page doesn't contain it (JavaScript-built pages)
        const stored = advertText;
        advertText = body + (stored && !fold(body).includes(fold(stored.slice(0, 80))) ? '\n' + stored : '');
      }
    }
  } catch { /* keep the stored text */ }

  // the team
  const team = [{ role: 'lead', raw: identity.name.full, identity, org: null }];
  const leadKey = identity.name.key;
  for (const raw of (listing.supervisors || []).filter((x) => { const n = parseName(x); return n && n.key !== leadKey; }).slice(0, 3)) {
    const org = affiliationHint(advertText, raw);
    const external = org && !instMatch(org, listing.institution) ? org : null;
    progress(`Finding ${parseName(raw).full}`);
    let id = null;
    try {
      const make = () => identify(net, listing, raw, () => {}, { institution: external || listing.institution, skipProfile: !!external });
      id = identCache ? await identCache(raw, external || listing.institution, make) : await make();
    } catch (e) { console.warn('team identify', raw, e.message); }
    team.push({ role: external ? 'external' : 'co', raw, identity: id || { name: parseName(raw), confidence: 'none', method: 'Not found', notes: [] }, org: external });
  }

  // their works
  let excludedAll = [];
  for (const m of team) {
    m.name = m.identity.name.full;
    m.confirmed = CONFIRMED.has(m.identity.confidence) && !!m.identity.author;
    m.works = []; m.ids = new Set();
    if (!m.confirmed) continue;
    progress(m.role === 'lead' ? 'Reading their papers from the last ten years' : `Reading ${m.name}'s papers`);
    const make = () => fetchWorks(net, m.identity.author.id, now);
    const w = worksCache ? await worksCache(m.identity.author.id, make) : await make();
    const c = cleanMerged(w, { authorId: m.identity.author.id, profileDois: m.identity.profile?.dois || [] });
    m.works = c.kept; m.ids = new Set(c.kept.map((x) => x.id));
    excludedAll = excludedAll.concat(c.excluded.map((x) => ({ ...x, member: m.name })));
  }
  const lead = team[0];
  if (!lead.works.length && !lead.identity.profile) throw new Error('no-material');

  progress('Picking the papers that matter for this project');
  const advert = `${listing.title} ${listing.title} ${listing.summary || ''} ${advertText.slice(0, 6000)}`;
  const quota = [10, 5, 4, 3];
  const chosen = new Map();
  team.forEach((m, i) => {
    const ranked = rankWorks(m.works, { advert, profileText: m.identity.profile?.interests || '', cv, now });
    let n = 0;
    for (const w of ranked) { if (n >= quota[i] || chosen.size >= 20) break; if (!w.abstract || chosen.has(w.id)) continue; chosen.set(w.id, w); n++; }
    for (const w of ranked.filter((x) => !x.abstract).slice(0, i ? 0 : 2)) if (!chosen.has(w.id) && chosen.size < 22) chosen.set(w.id, w);
  });
  const detailed = [...chosen.values()].map((w, i) => ({ ...w, ref: 'P' + (i + 1) }));
  const all = new Map(); for (const m of team) for (const w of m.works) if (!all.has(w.id)) all.set(w.id, w);
  const others = [...all.values()].filter((w) => !chosen.has(w.id)).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 70).map((w, i) => ({ ...w, ref: 'W' + (i + 1) }));
  const refOf = new Map([...detailed, ...others].map((w) => [w.id, w.ref]));

  // overlap between team members: shared papers from the records, else name matches in the lead's papers
  const overlap = [];
  for (let i = 0; i < team.length; i++) for (let k = i + 1; k < team.length; k++) {
    const a = team[i], b = team[k];
    let shared = [];
    if (a.confirmed && b.confirmed) shared = a.works.filter((w) => b.ids.has(w.id));
    else if (a.confirmed) { const n = parseName(b.raw); shared = n ? a.works.filter((w) => w.authors.some((x) => nameFit(n, x.name) >= 2)) : []; }
    overlap.push({ a: a.name, b: b.name, n: shared.length, latest: shared.reduce((m, w) => Math.max(m, w.year || 0), 0) || null, refs: shared.map((w) => refOf.get(w.id)).filter(Boolean).slice(0, 4) });
  }

  // funders and partners: those named in the advert listing + organisations external supervisors are at
  const funderNames = [...new Map([...(listing.funders || []), ...team.map((m) => m.org).filter(Boolean)].map((f) => [fold(f), f])).values()];
  const funders = funderEvidence(funderNames, team.filter((m) => m.confirmed).map((m) => ({ name: m.name, works: m.works, org: m.org })));
  const evidenceTotal = funders.reduce((s, f) => s + f.per.reduce((t, p) => t + p.acknowledged + p.coauthored, 0), 0);

  const people = othersInAdvert(advertText, team.map((m) => m.raw));
  const teamView = team.map((m) => ({ name: m.name, roleLabel: ROLE[m.role], org: m.org, confirmed: m.confirmed, method: m.identity.method, profile: m.identity.profile, topics: m.identity.author?.topics || [], ids: m.ids }));

  progress('Writing your briefing');
  const content = promptMaterial({ listing, advertText, team: teamView, ranked: detailed, others, overlap, funders, people, cv });
  const refs = new Set([...detailed, ...others].map((w) => w.ref));
  const titles = new Map([...detailed, ...others].map((w) => [w.ref, { title: w.title, year: w.year }]));
  let report, usage = null, lastErr;
  for (let attempt = 0; attempt < 2 && !report; attempt++) {
    try {
      const r = await callModel(fetchFn, { key, model, system: BRIEFING_SYSTEM, content });
      usage = r.usage;
      const t = r.text;
      report = validateReport(JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)), {
        refs, papers: titles, profileText: lead.identity.profile?.interests || '',
        teamNames: team.map((m) => m.name), otherNames: people.map((p) => p.name), funderEvidenceTotal: evidenceTotal,
      });
    } catch (e) { lastErr = e; console.warn('briefing write attempt failed', e.message); }
  }
  if (!report) throw lastErr || new Error('write-failed');

  const paper = (w) => ({ ref: w.ref, title: w.title, year: w.year, venue: w.venue, doi: w.doi, url: w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}`, authors: w.authors.slice(0, 6).map((a) => a.name), more: Math.max(0, w.authors.length - 6), hasAbstract: !!w.abstract, team: who(w, teamView) });
  const kept = team.reduce((s, m) => s + m.works.length, 0);
  return {
    version: 2,
    created: now.toISOString(),
    listing: { id: listing.id, path: listing.path, title: listing.title, institution: listing.institution, school: listing.school || '', funding: listing.funding, stipend: listing.stipend || null, deadline: listing.deadline || null, deadline_text: listing.deadline_text || '', start: listing.start || '', eligibility: listing.eligibility || '', url: listing.url, supervisors: listing.supervisors || [], funders: listing.funders || [] },
    supervisor: { name: lead.name, profileUrl: lead.identity.profile?.url || null, orcid: lead.identity.author?.orcid || lead.identity.profile?.orcid || null, openalex: lead.identity.author ? `https://openalex.org/${lead.identity.author.id}` : null, topics: lead.identity.author?.topics || [] },
    team: team.map((m) => ({
      name: m.name, role: m.role, roleLabel: ROLE[m.role], org: m.org, confidence: m.confirmed ? m.identity.confidence : (m.identity.confidence === 'low' ? 'unconfirmed' : 'not found'),
      method: m.identity.method, profileUrl: m.identity.profile?.url || null, orcid: m.identity.author?.orcid || m.identity.profile?.orcid || null,
      openalex: m.identity.author && m.confirmed ? `https://openalex.org/${m.identity.author.id}` : null, works: m.works.length,
    })),
    overlap: overlap.map((o) => ({ a: o.a, b: o.b, n: o.n, latest: o.latest })),
    funders: funders.map((f) => ({ funder: f.funder, kind: f.kind, per: f.per })),
    identity: { confidence: lead.identity.confidence, method: lead.identity.method, notes: lead.identity.notes, confirmedByUser: !!lead.identity.confirmedByUser },
    stats: { works: kept + excludedAll.length, kept, withAbstracts: team.reduce((s, m) => s + m.works.filter((w) => w.abstract).length, 0), excluded: excludedAll.length, people: team.length, advertChars: advertText.length },
    excluded: excludedAll.slice(0, 30).map((w) => ({ title: w.title, year: w.year, field: w.field, member: w.member })),
    papers: Object.fromEntries([...detailed, ...others].map((w) => [w.ref, paper(w)])),
    hadCv: !!cv,
    model, usage,
    report,
  };
}
