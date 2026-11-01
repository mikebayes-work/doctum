// /api/event — anonymous interest signals for one listing, sent by the page with
// navigator.sendBeacon: a listing page viewed, "apply" clicked, saved to shortlist.
//
//   POST (text/plain) {"a":"v"|"a"|"sv","id":"<12 hex>"}   → 204
//
// Only the action, the listing (and its public university and subject) and the
// country Netlify reports are counted. No identifiers: see netlify/doctum/insights.js.
// These counts are what a university's own report is built from: views, apply
// click-throughs and shortlist saves per advert.
import DB from '../doctum/listings.generated.js';
import { guard } from '../doctum/http.js';
import { record } from '../doctum/insights.js';

let BY_ID;
const ACTIONS = new Set(['v', 'a', 'sv']);

export default async function handler(request, context) {
  const g = guard(request, context, { methods: ['POST'], limit: 60 });
  if (g.early) return g.early;
  let b;
  try {
    const raw = await request.text();
    if (raw.length > 200) return new Response(null, { status: 413, headers: g.cors });
    b = JSON.parse(raw);
  } catch { return new Response(null, { status: 400, headers: g.cors }); }
  BY_ID ||= new Map(DB.rows.map((r) => [r.id, r]));
  const r = typeof b?.id === 'string' && /^[0-9a-f]{12}$/.test(b.id) ? BY_ID.get(b.id) : null;
  if (r && ACTIONS.has(b.a)) record(request, context, { t: 'l', a: b.a, id: r.id, u: r.institution, d: (r.disciplines || [])[0] || '' });
  return new Response(null, { status: 204, headers: g.cors });
}

export const config = {
  path: '/api/event',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
