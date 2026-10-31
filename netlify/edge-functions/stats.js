// /api/stats — headline counts only (status line on interactive pages).
import DB from '../doctum/listings.generated.js';
import { buildIndex, stats } from '../doctum/core.js';
import { guard } from '../doctum/http.js';

let S;

export default async function handler(request, context) {
  const g = guard(request, context, { methods: ['GET'], limit: 60 });
  if (g.early) return g.early;
  S ||= stats(buildIndex(DB));
  return g.respond(200, S, { 'Cache-Control': 'private, max-age=600' });
}

export const config = { path: '/api/stats' };
