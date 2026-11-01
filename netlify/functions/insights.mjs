// /api/insights — private reports on what applicants look for. Admin only.
//
//   GET /api/insights?report=<name>&from=2026-W45&to=2026-W52[&dims=a,b][&inst=…][&format=csv]
//   header  x-doctum-admin: <INSIGHTS_ADMIN_KEY>     (404 when the key isn't set)
//
// Reports (all built from the weekly counts written by insights-rollup):
//   summary     events per week by type
//   terms       most-searched phrases, and phrases that found nothing (unmet demand)
//   filters     how often each filter / form option is chosen
//   demand      per subject: searches + CV matches vs open adverts → demand per advert,
//               plus the share of CV matches from international applicants
//   applicants  crosstab of opted-in CV-match profiles; dims from: d fee fund c lvl cls ug fdc pub proj ind
//   skills      per subject: share of opted-in applicants with each skill group vs share
//               of open adverts in that subject asking for it (the skills gap)
//   listings    per university (or per advert with inst=…): times in CV match results, views,
//               full-advert reads, apply clicks, saves, preparation packs, vs the median advert
//   sources     how visitors reached advert pages (Doctum search, CV match, Google, AI assistant…), optionally inst=…
//   matched     who an institution's adverts matched in CV matching (inst=…, dims from fee lvl ug fdc c)
//   search      crosstab of searches; dims from: q f d e i k o r c
//
// Every figure about applicants under K_MIN (10) is shown as "<10" and left out of
// totals, so no small group can be singled out. Listing counts (views of an advert)
// are about adverts, not people, and are shown as they are.
import crypto from 'node:crypto';
import DB from '../doctum/listings.generated.js';
import { env } from '../doctum/http.js';
import { insightsStore, K_MIN, LISTING_ACTIONS, SOURCES } from '../doctum/insights.js';
import { skillsIn, SKILLS, COUNTRIES } from '../doctum/facets.js';

const WEEK = /^\d{4}-W\d{2}$/;
const CNAME = Object.fromEntries(COUNTRIES);
const LABEL = {
  d: 'PhD subject', fee: 'Fee status', fund: 'Funding wanted', c: 'Country (connection)', lvl: 'Highest degree', cls: 'Degree class',
  ug: 'First-degree subject', fdc: 'Country of first degree', pub: 'Has publications', proj: 'Research project or dissertation',
  ind: 'Industry experience', q: 'Search words', f: 'Funding filter', e: 'Eligibility filter', i: 'University filter', k: 'Quick filter',
  o: 'Sort', r: 'Results found',
};
const APPLICANT_DIMS = new Set(['d', 'fee', 'fund', 'c', 'lvl', 'cls', 'ug', 'fdc', 'pub', 'proj', 'ind']);
const SEARCH_DIMS = new Set(['q', 'f', 'd', 'e', 'i', 'k', 'o', 'r', 'c']);

const sameKey = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const show = (dim, v) => (v === 1 ? 'yes' : v === 0 ? 'no' : dim === 'fdc' || dim === 'c' ? (CNAME[v] || (v === 'OTHER' ? 'Other' : v === 'XX' ? 'Unknown' : v)) : v);
const supp = (n) => (n >= K_MIN ? n : `<${K_MIN}`);

// Expand a tuple into one row per combination of array values (an applicant who
// picked two subjects counts once in each).
function expand(o, dims) {
  let rows = [[]];
  for (const d of dims) {
    const vals = Array.isArray(o[d]) ? (o[d].length ? o[d] : ['(none)']) : [o[d] === undefined ? '(none)' : o[d]];
    rows = rows.flatMap((r) => vals.map((v) => [...r, show(d, v)]));
  }
  return rows;
}
function crosstab(table, dims, filter = () => true) {
  const out = new Map();
  for (const [k, n] of Object.entries(table)) {
    const o = JSON.parse(k);
    if (!filter(o)) continue;
    for (const r of expand(o, dims)) { const key = JSON.stringify(r); out.set(key, (out.get(key) || 0) + n); }
  }
  return [...out].map(([k, n]) => [...JSON.parse(k), n]).sort((a, b) => b[b.length - 1] - a[a.length - 1]);
}
const merge = (weeks, t) => {
  const m = {};
  for (const w of weeks) for (const [k, n] of Object.entries(w[t] || {})) m[k] = (m[k] || 0) + n;
  return m;
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

export function buildReport(report, weeks, q) {
  const open = DB.rows.filter((r) => r.status === 'open');
  const S = merge(weeks, 's'), M = merge(weeks, 'm'), L = merge(weeks, 'l');
  const optIn = (o) => o.opt === 1;

  if (report === 'summary') {
    return { columns: ['Week', 'Searches', 'CV matches', 'of which opted in', 'Listing signals', 'Days counted'],
      rows: weeks.map((w) => [w.week, sum(w.s), sum(w.m), Object.entries(w.m || {}).reduce((a, [k, n]) => a + (JSON.parse(k).opt === 1 ? n : 0), 0), sum(w.l), Object.keys(w.days || {}).length]) };
  }
  if (report === 'terms') {
    const all = crosstab(S, ['q'], (o) => o.q), none = crosstab(S, ['q'], (o) => o.q && o.r === '0');
    const zero = new Map(none.map(([t, n]) => [t, n]));
    return { columns: ['Search words', 'Searches', 'Of which found nothing'],
      rows: all.filter(([, n]) => n >= K_MIN).map(([t, n]) => [t, n, supp(zero.get(t) || 0)]),
      note: `Phrases searched fewer than ${K_MIN} times are not shown.` };
  }
  if (report === 'filters') {
    const rows = [];
    for (const d of ['f', 'd', 'e', 'i', 'k', 'o']) for (const [v, n] of crosstab(S, [d], (o) => o[d] !== undefined)) rows.push(['Search', LABEL[d], v, supp(n)]);
    for (const d of ['d', 'fee', 'fund']) for (const [v, n] of crosstab(M, [d])) rows.push(['CV match', LABEL[d], v, supp(n)]);
    return { columns: ['Where', 'Option', 'Value', 'Times chosen'], rows };
  }
  if (report === 'demand') {
    const discs = [...new Set(open.flatMap((r) => r.disciplines || []))].sort();
    const s = new Map(crosstab(S, ['d'], (o) => o.d).map(([d, n]) => [d, n]));
    const m = new Map(crosstab(M, ['d']).map(([d, n]) => [d, n]));
    const intl = new Map(crosstab(M, ['d'], (o) => o.fee === 'intl').map(([d, n]) => [d, n]));
    const rows = discs.map((d) => {
      const ads = open.filter((r) => (r.disciplines || []).includes(d)), ff = ads.filter((r) => r.funding === 'Fully funded').length;
      const dem = (s.get(d) || 0) + (m.get(d) || 0), mm = m.get(d) || 0;
      return [d, supp(s.get(d) || 0), supp(mm), ads.length, ff, ads.length ? +(dem / ads.length).toFixed(2) : null, mm >= K_MIN ? Math.round((100 * (intl.get(d) || 0)) / mm) + '%' : `n<${K_MIN}`];
    }).sort((a, b) => (b[5] || 0) - (a[5] || 0));
    return { columns: ['PhD subject', 'Searches filtered to it', 'CV matches in it', 'Open adverts', 'Fully funded adverts', 'Demand per open advert', 'International share of CV matches'], rows,
      note: 'Demand per advert = (searches filtered to the subject + CV matches in it) / open adverts in it. A high figure means many applicants chasing few adverts.' };
  }
  if (report === 'applicants') {
    const dims = String(q.get('dims') || 'd,ug').split(',').filter((d) => APPLICANT_DIMS.has(d)).slice(0, 3);
    if (!dims.length) return { error: 'dims must be from ' + [...APPLICANT_DIMS].join(' ') };
    const rows = crosstab(M, dims, optIn).map((r) => [...r.slice(0, -1), supp(r[r.length - 1])]);
    return { columns: [...dims.map((d) => LABEL[d]), 'Applicants (opted in)'], rows: rows.filter((r) => r[r.length - 1] !== `<${K_MIN}`),
      suppressed: rows.filter((r) => r[r.length - 1] === `<${K_MIN}`).length,
      note: `Opted-in CV matches only. ${rows.filter((r) => r[r.length - 1] === `<${K_MIN}`).length} groups smaller than ${K_MIN} are hidden.` };
  }
  if (report === 'skills') {
    const rows = [];
    const discs = [...new Set(open.flatMap((r) => r.disciplines || []))].sort();
    for (const d of discs) {
      const ap = crosstab(M, ['sk'], (o) => optIn(o) && (o.d || []).includes(d));
      const nAp = Object.entries(M).reduce((a, [k, n]) => { const o = JSON.parse(k); return a + (optIn(o) && (o.d || []).includes(d) ? n : 0); }, 0);
      if (nAp < K_MIN) continue;
      const ads = open.filter((r) => (r.disciplines || []).includes(d));
      const adSk = ads.map((r) => new Set(skillsIn(`${r.title} ${r.description || r.summary || ''}`)));
      const have = new Map(ap.map(([s, n]) => [s, n]));
      for (const [sk] of SKILLS) {
        const a = have.get(sk) || 0, w = adSk.filter((s) => s.has(sk)).length;
        if (!a && !w) continue;
        rows.push([d, sk, a >= K_MIN ? Math.round((100 * a) / nAp) + '%' : `n<${K_MIN}`, ads.length ? Math.round((100 * w) / ads.length) + '%' : '', nAp, ads.length]);
      }
    }
    return { columns: ['PhD subject', 'Skill group', 'Applicants with it', 'Adverts asking for it', 'Applicants (opted in)', 'Open adverts'], rows,
      note: 'Subjects with fewer than 10 opted-in applicants are left out.' };
  }
  if (report === 'listings') {
    // Per university, or per advert with inst=… . Counts are about adverts, not people.
    const inst = q.get('inst');
    const blank = () => Object.fromEntries(Object.keys(LISTING_ACTIONS).map((a) => [a, 0]));
    const per = new Map(), perAd = new Map();
    for (const [k, n] of Object.entries(L)) {
      const o = JSON.parse(k);
      const x = perAd.get(o.id) || blank(); x[o.a] = (x[o.a] || 0) + n; perAd.set(o.id, x);
      const key = inst ? (o.u === inst ? o.id : null) : o.u;
      if (!key) continue;
      const y = per.get(key) || blank(); y[o.a] = (y[o.a] || 0) + n; per.set(key, y);
    }
    const bench = Object.fromEntries(Object.keys(LISTING_ACTIONS).map((a) => [LISTING_ACTIONS[a], median([...perAd.values()].map((x) => x[a]))]));
    const byId = new Map(DB.rows.map((r) => [r.id, r]));
    const rows = [...per].map(([k, x]) => [inst ? (byId.get(k)?.title || k) : k, ...(inst ? [byId.get(k)?.funding || ''] : []),
      x.mi, x.v, x.rm, x.a, x.sv, x.pp, x.v ? Math.round((100 * x.a) / x.v) + '%' : '', ...(inst ? [k] : [])])
      .sort((a, b) => b[inst ? 3 : 2] - a[inst ? 3 : 2]);
    return { columns: [inst ? 'Advert' : 'University', ...(inst ? ['Funding'] : []), 'Appeared in CV matches', 'Page views', 'Read the full advert', 'Apply clicks', 'Saves', 'Preparation packs', 'Apply clicks per view', ...(inst ? ['Advert id'] : [])], rows,
      benchmark: { 'Median per advert, all universities': bench } };
  }
  if (report === 'sources') {
    // How visitors reached advert pages, optionally for one university (inst=…).
    const inst = q.get('inst');
    const rows = crosstab(L, ['src'], (o) => o.a === 'v' && (!inst || o.u === inst)).map(([src, n]) => [SOURCES[src] || (src === '(none)' ? 'Not recorded' : src), n]);
    const total = rows.reduce((a, r) => a + r[1], 0);
    return { columns: ['Arrived from', 'Advert page views', 'Share'], rows: rows.map((r) => [...r, total ? Math.round((100 * r[1]) / total) + '%' : '']) };
  }
  if (report === 'matched') {
    // Who an institution's adverts matched in CV matching. Profile columns are opted-in
    // applicants only, and every group under K_MIN is hidden. dims from: fee lvl ug fdc c
    const inst = q.get('inst');
    const dims = String(q.get('dims') || 'ug').split(',').filter((d) => ['fee', 'lvl', 'ug', 'fdc', 'c'].includes(d)).slice(0, 2);
    // Profile dimensions (lvl, ug, fdc) only exist for opted-in applicants; fee and c exist for everyone.
    const keep = (o) => o.a === 'mi' && (!inst || o.u === inst) && (dims.every((d) => d === 'fee' || d === 'c') || o.ug !== undefined);
    const bySubject = q.get('bysubject') !== '0';
    const rows = crosstab(L, [...(bySubject ? ['d'] : []), ...dims], keep).map((r) => [...r.slice(0, -1), supp(r[r.length - 1])]);
    const shown = rows.filter((r) => r[r.length - 1] !== `<${K_MIN}`);
    return { columns: [...(bySubject ? ['PhD subject'] : []), ...dims.map((d) => LABEL[d]), 'Times matched'], rows: shown, suppressed: rows.length - shown.length,
      note: `Counts how often ${inst ? inst + "'s" : 'all'} adverts appeared in CV match results, by applicant category. One applicant can match several adverts. Profile categories come only from applicants who ticked "Count me in". Groups under ${K_MIN} are hidden.` };
  }
  if (report === 'search') {
    const dims = String(q.get('dims') || 'd').split(',').filter((d) => SEARCH_DIMS.has(d)).slice(0, 3);
    if (!dims.length) return { error: 'dims must be from ' + [...SEARCH_DIMS].join(' ') };
    const rows = crosstab(S, dims).filter((r) => r[r.length - 1] >= K_MIN);
    return { columns: [...dims.map((d) => LABEL[d]), 'Searches'], rows, note: `Combinations seen fewer than ${K_MIN} times are hidden.` };
  }
  return { error: 'Unknown report. Use summary, terms, filters, demand, applicants, skills, listings, sources, matched or search.' };
}
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

const csv = (r) => [r.columns, ...r.rows].map((row) => row.map((v) => {
  const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',')).join('\n') + '\n';

export default async function handler(request) {
  const key = (env('INSIGHTS_ADMIN_KEY') || '').trim();
  if (!key || key.length < 24) return new Response('Not found', { status: 404 });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  if (!sameKey((request.headers.get('x-doctum-admin') || '').trim(), key)) return new Response('Not found', { status: 404 });
  const q = new URL(request.url).searchParams;
  const from = WEEK.test(q.get('from') || '') ? q.get('from') : '0000-W00';
  const to = WEEK.test(q.get('to') || '') ? q.get('to') : '9999-W99';
  const store = insightsStore();
  const { blobs } = await store.list({ prefix: 'week/' });
  const weeks = [];
  for (const b of blobs.sort((a, c) => a.key.localeCompare(c.key))) {
    const w = b.key.slice(5);
    if (w >= from && w <= to) weeks.push(await store.get(b.key, { type: 'json' }));
  }
  const r = buildReport(q.get('report') || 'summary', weeks, q);
  const h = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  if (r.error) return Response.json(r, { status: 400, headers: h });
  if (q.get('format') === 'csv') return new Response(csv(r), { headers: { ...h, 'Content-Type': 'text/csv; charset=utf-8' } });
  return Response.json({ report: q.get('report') || 'summary', from, to, weeks: weeks.map((w) => w.week), ...r }, { headers: h });
}

export const config = { path: '/api/insights' };
