// /api/match — CV match, server side.
//
//   POST { action:'profile', cv }                              → { profile }   (suggest subjects)
//   POST { action:'match', cv, disc:[1-2], fee:'uk'|'intl', funding:'full'|'any'|'all' } → { profile, considered, matches }
//   POST { action:'analyse', cv, id }                          → Anthropic SSE (only if ANTHROPIC_API_KEY is set)
//
// The CV is processed in memory for this request and never stored or logged.
// Ranking logic and prompts never reach the browser; the browser can't send a
// prompt. Inputs are size-capped. The Anthropic Console spend cap is the
// financial backstop for 'analyse' (as on The Grid).
import DB from '../doctum/listings.generated.js';
import { buildIndex, match, readProfile, analyseRequest } from '../doctum/core.js';
import { guard, env, today } from '../doctum/http.js';

const MAX_BODY = 60000, MAX_CV = 30000;
const MODEL = 'claude-haiku-4-5-20251001';
let INDEX;

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

export default async function handler(request, context) {
  const g = guard(request, context, { methods: ['POST'], limit: 20 });
  if (g.early) return g.early;
  INDEX ||= buildIndex(DB);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return g.respond(413, { error: 'That CV is too long. Paste the main sections only.' });
    body = JSON.parse(raw);
  } catch { return g.respond(400, { error: 'Invalid request' }); }

  const cv = str(body?.cv, MAX_CV).trim();
  if (cv.length < 200) return g.respond(400, { error: 'Add a few more lines of your CV: degrees, projects, skills.' });

  if (body.action === 'profile') {
    const p = readProfile(INDEX, cv);
    return g.respond(200, { profile: { degree: p.degree, cls: p.cls, hasMasters: p.hasMasters, terms: p.terms, subjects: p.subjects } });
  }

  if (body.action === 'match') {
    const valid = new Set(INDEX.rows.flatMap((r) => r.disciplines || []));
    const disc = [].concat(body.disc || []).filter((d) => typeof d === 'string' && valid.has(d)).slice(0, 2);
    if (!disc.length) return g.respond(400, { error: 'Pick one or two subject areas.' });
    const fee = body.fee === 'intl' ? 'intl' : body.fee === 'uk' ? 'uk' : null;
    if (!fee) return g.respond(400, { error: 'Choose your fee status.' });
    const funding = ['full', 'any', 'all'].includes(body.funding) ? body.funding : 'full';
    return g.respond(200, match(INDEX, { cv, disc, fee, funding, today: today() }));
  }

  if (body.action === 'analyse') {
    const key = env('ANTHROPIC_API_KEY');
    if (!key) return g.respond(501, { error: 'Detailed analysis is not switched on yet.' });
    const id = str(body.id, 12);
    const r = /^[0-9a-f]{12}$/.test(id) ? INDEX.byId.get(id) : null;
    if (!r || r.status !== 'open') return g.respond(404, { error: 'Listing not found' });
    const req = analyseRequest(cv, r);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: req.max_tokens, system: req.system, messages: [{ role: 'user', content: req.content }], stream: true }),
    });
    if (!res.ok || !res.body) {
      console.error('analyse upstream error', res.status);
      return g.respond(502, { error: 'The analysis service is busy. Please try again shortly.' });
    }
    return new Response(res.body, { status: 200, headers: { ...g.cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
  }

  return g.respond(400, { error: 'Unknown action' });
}

export const config = {
  path: '/api/match',
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
