// /api/search — server-side search, filters and facet counts.
// Returns one page (max 20) of public card fields. There is no "return
// everything" option and paging stops at 25 pages, so the database can't be
// lifted in one request (The Grid lesson: the browser gets answers, not datasets).
import DB from '../doctum/listings.generated.js';
import { buildIndex, search } from '../doctum/core.js';
import { guard, today } from '../doctum/http.js';
import { record, cleanQuery, bucket } from '../doctum/insights.js';

let INDEX;

export default async function handler(request, context) {
  const g = guard(request, context, { methods: ['GET'], limit: 90 });
  if (g.early) return g.early;
  INDEX ||= buildIndex(DB);
  const p = new URL(request.url).searchParams;
  const q = {
    q: (p.get('q') || '').slice(0, 120),
    sort: p.get('sort') || '',
    page: p.get('page') || '1',
    funding: p.getAll('funding'), disc: p.getAll('disc'), elig: p.getAll('elig'), inst: p.getAll('inst'), quick: p.getAll('quick'),
  };
  const res = search(INDEX, q, today());
  // Anonymous demand analytics: first page of a real search only (no identifiers; see insights.js).
  const words = cleanQuery(q.q);
  const filtered = q.funding.length || q.disc.length || q.elig.length || q.inst.length || q.quick.length;
  if ((parseInt(q.page, 10) || 1) === 1 && (words || filtered) && !p.has('saved')) {
    const cap = (a) => a.filter((v) => typeof v === 'string').slice(0, 6).map((v) => v.slice(0, 80));
    record(request, context, { t: 's', q: words, f: cap(q.funding), d: cap(q.disc), e: cap(q.elig), i: cap(q.inst), k: cap(q.quick), o: ['deadline', 'stipend', 'newest'].includes(q.sort) ? q.sort : '', r: bucket(res.total) });
  }
  return g.respond(200, res, { 'Cache-Control': 'private, max-age=120' });
}

export const config = {
  path: '/api/search',
  // Netlify-enforced per-IP limit (check your plan supports code-based rate limits).
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
