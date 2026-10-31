// netlify/doctum/http.js — access control shared by every /api/* edge function.
//
// Lessons from The Grid, applied:
//  * Origin/referer allowlist (production domains + this site's Netlify deploy
//    previews). Stops other websites and casual bots. It does NOT stop a
//    determined script forging headers — that is what the rate limits are for.
//  * Rate limits in two layers: Netlify's own per-IP rule declared in each
//    function's `config.rateLimit` (enforced at Netlify's edge before our code
//    runs), plus a small in-memory per-IP counter here as a backstop.
//  * Generic error messages to the visitor; real detail goes to the logs.

export const PROD_ORIGINS = new Set(['https://doctum.co.uk', 'https://www.doctum.co.uk']);

export function env(name) {
  try { if (globalThis.Netlify?.env?.get) return Netlify.env.get(name); } catch { /* not on Netlify */ }
  try { if (globalThis.Deno?.env?.get) return Deno.env.get(name); } catch { /* no permission */ }
  return globalThis.process?.env?.[name];
}

export function isAllowedOrigin(o, context) {
  if (!o) return false;
  if (PROD_ORIGINS.has(o)) return true;
  const site = context?.site?.name;
  if (!site) return false;
  return o === `https://${site}.netlify.app` || (o.startsWith('https://') && o.endsWith(`--${site}.netlify.app`));
}

// Per-isolate sliding window. Edge isolates are short-lived and many, so this
// is a backstop, not the main limit.
const hits = new Map();
function overLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) for (const k of [...hits.keys()].slice(0, 1000)) hits.delete(k);
  return arr.length > limit;
}

// Returns { ok, cors, respond } — call guard() first in every handler.
export function guard(request, context, { methods = ['GET'], limit = 60, windowMs = 60000 } = {}) {
  const origin = request.headers.get('origin');
  let refOrigin = null;
  try { refOrigin = request.headers.get('referer') ? new URL(request.headers.get('referer')).origin : null; } catch { /* ignore */ }
  const originOk = isAllowedOrigin(origin, context);
  const ok = originOk || isAllowedOrigin(refOrigin, context);
  const cors = {
    'Access-Control-Allow-Origin': originOk ? origin : 'null',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': [...methods, 'OPTIONS'].join(', '),
    'Vary': 'Origin',
    'X-Robots-Tag': 'noindex',
  };
  const respond = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
    status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
  if (request.method === 'OPTIONS') return { early: new Response(null, { status: 204, headers: cors }) };
  if (!ok) return { early: respond(403, { error: 'Forbidden' }) };
  if (!methods.includes(request.method)) return { early: respond(405, { error: 'Method not allowed' }) };
  const ip = context?.ip || request.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (overLimit(`${new URL(request.url).pathname}|${ip}`, limit, windowMs)) {
    return { early: respond(429, { error: 'Too many requests. Please wait a minute and try again.' }, { 'Retry-After': '60' }) };
  }
  return { cors, respond };
}

export const today = () => new Date().toISOString().slice(0, 10);
