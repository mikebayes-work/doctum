// netlify/doctum/jobs.js — briefing jobs: storage, settings, signatures.
// Shared by netlify/functions/briefing.mjs (the /api/briefing endpoint) and
// netlify/functions/briefing-background.mjs (the worker, up to 15 minutes).
//
// Storage is Netlify Blobs, store "briefings":
//   job/<rid>                     the job and, when done, the report (expires after 30 days)
//   ident/<name|institution>      identity result for a supervisor (14 days)
//   works2/<openalex author id>   their works list incl. funders and co-author organisations (14 days)
//   count/<yyyy-mm-dd>/all        reports written today (soft global cap)
//   count/<yyyy-mm-dd>/<ip hash>  reports started today from one IP (soft cap)
// The CV is never written here: it travels in the request to the worker and is
// dropped when the job finishes. The finished report does contain sentences
// about the CV (the "Your CV" column), which is why reports expire.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { env } from './http.js';

export const REPORT_DAYS = 30;
export const CACHE_DAYS = 14;
export const RID_RE = /^[0-9a-f]{24}$/;

export function settings() {
  const key = env('ANTHROPIC_API_KEY') || '';
  const num = (n, d) => { const v = parseInt(env(n) || '', 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    key,
    enabled: !!key && String(env('BRIEFINGS') || '').toLowerCase() !== 'off',
    model: env('BRIEFING_MODEL') || 'claude-sonnet-5-5',
    accessCode: env('BRIEFING_ACCESS_CODE') || '',
    dailyLimit: num('BRIEFING_DAILY_LIMIT', 30),
    perIp: num('BRIEFING_PER_IP', 3),
    mailto: env('CRAWLER_CONTACT') || 'hello@doctum.co.uk',
    openalexKey: env('OPENALEX_API_KEY') || '',
  };
}

export const store = () => getStore({ name: 'briefings', consistency: 'strong' });
export const newRid = () => crypto.randomBytes(12).toString('hex');
export const today = () => new Date().toISOString().slice(0, 10);
export const sign = (key, rid) => crypto.createHmac('sha256', key).update('briefing:' + rid).digest('hex');
export const verify = (key, rid, sig) => {
  const a = Buffer.from(sign(key, rid)), b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
export const ipHash = (key, ip) => crypto.createHash('sha256').update(`${today()}|${ip}|${key.slice(-12)}`).digest('hex').slice(0, 16);
export const sameCode = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

export async function readJob(s, rid) {
  const j = await s.get('job/' + rid, { type: 'json' });
  if (!j) return null;
  if (Date.now() - Date.parse(j.created) > REPORT_DAYS * 864e5) { await s.delete('job/' + rid); return null; }
  return j;
}
export async function patchJob(s, rid, patch) {
  const j = (await s.get('job/' + rid, { type: 'json' })) || {};
  const next = { ...j, ...patch, updated: new Date().toISOString() };
  await s.setJSON('job/' + rid, next);
  return next;
}

export async function getCount(s, k) { return Number(await s.get(`count/${today()}/${k}`)) || 0; }
export async function bump(s, k) { const n = (await getCount(s, k)) + 1; await s.set(`count/${today()}/${k}`, String(n)); return n; }

// cache: { at, value } with a max age in days
export async function cached(s, k, days, make) {
  const hit = await s.get(k, { type: 'json' }).catch(() => null);
  if (hit && Date.now() - Date.parse(hit.at) < days * 864e5) return hit.value;
  const value = await make();
  if (value != null) await s.setJSON(k, { at: new Date().toISOString(), value });
  return value;
}

// What the browser may see of a job (no IP hash, no internals).
export function publicJob(j) {
  const out = { rid: j.rid, state: j.state, step: j.step || '', created: j.created, listing: j.listing, supervisor: j.supervisor };
  if (j.state === 'confirm') out.candidates = j.candidates || [];
  if (j.state === 'error') out.error = j.error || 'Something went wrong.';
  if (j.state === 'done') out.briefing = j.briefing;
  return out;
}
