// /api/search — server-side search, filters and facet counts.
// Returns one page (max 20) of public card fields. There is no "return
// everything" option and paging stops at 25 pages, so the database can't be
// lifted in one request (The Grid lesson: the browser gets answers, not datasets).
import DB from '../doctum/listings.generated.js';
import { buildIndex, search } from '../doctum/core.js';
import { guard, today } from '../doctum/http.js';

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
  return g.respond(200, search(INDEX, q, today()), { 'Cache-Control': 'private, max-age=120' });
}

export const config = {
  path: '/api/search',
  // Netlify-enforced per-IP limit (check your plan supports code-based rate limits).
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
