// /api/phd?id=<12 hex> — one listing's full advert text, fetched when a
// visitor asks to read it on a listing page. Same pattern as The Grid's
// /api/role: id validated by regex + own-property check, one record per call.
import DB from '../doctum/listings.generated.js';
import { detail } from '../doctum/core.js';
import { guard } from '../doctum/http.js';

let BY_ID;

export default async function handler(request, context) {
  const g = guard(request, context, { methods: ['GET'], limit: 60 });
  if (g.early) return g.early;
  BY_ID ||= new Map(DB.rows.map((r) => [r.id, r]));
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[0-9a-f]{12}$/.test(id) || !BY_ID.has(id)) return g.respond(404, { error: 'Not found' });
  return g.respond(200, detail(BY_ID.get(id)), { 'Cache-Control': 'private, max-age=3600' });
}

export const config = {
  path: '/api/phd',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
