// netlify/doctum/insights.js — anonymous demand analytics ("what students look for").
//
// Shared by the edge functions (/api/search, /api/match, /api/event) and the Node
// functions (/api/briefing, insights-rollup, /api/insights).
//
// Privacy design (see /privacy/ and the project doc "doctum-demand-insights"):
//  * No identifiers at all: no IP address, no IP hash, no cookie, no session id,
//    no user agent, no timestamp finer than the day. Two events from the same
//    person cannot be linked to each other.
//  * Country is the two-letter code Netlify derives from the connection; the IP
//    itself is never written.
//  * Search text is cleaned (no emails, long numbers, links) and capped.
//  * From a CV: only category names from facets.js, and only if the applicant
//    ticks "count me in". Never CV text, never a hash of it.
//  * Raw events are deleted by the daily rollup (insights-rollup), which keeps
//    only weekly counts. Reports suppress any figure under K_MIN.
//  * INSIGHTS=off switches all of this off.
//
// Storage: Netlify Blobs, store "insights":
//   raw/<yyyy-mm-dd>/<uuid>     one event (deleted by the rollup, normally within a day)
//   week/<yyyy-Www>             weekly counts { s, m, l } of event tuples → count
//   done/<yyyy-mm-dd>           marker: that day has been rolled up
import { getStore } from '@netlify/blobs';
import { env } from './http.js';

export const K_MIN = 10;
export const insightsStore = () => getStore({ name: 'insights' });
export const insightsOn = () => String(env('INSIGHTS') || '').toLowerCase() !== 'off';

export function isoWeek(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear();
  const w = 1 + Math.round(((d - Date.UTC(y, 0, 4)) / 864e5 - 3 + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

export function countryOf(context) {
  const c = context?.geo?.country?.code;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'XX';
}

// Search text → a short, lower-case phrase, or '' if it looks like personal data.
export function cleanQuery(q) {
  let s = String(q || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (/@|https?:|www\.|\d{5,}|\+\d{6,}/.test(s)) return '';
  s = s.replace(/[^a-z0-9&+#.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60 || s.split(' ').length > 8) return '';
  return s;
}

export function bucket(n) {
  n = Number(n) || 0;
  return n === 0 ? '0' : n < 10 ? '1-9' : n < 50 ? '10-49' : n < 200 ? '50-199' : '200+';
}

const BOT = /bot|crawl|spider|slurp|headless|preview|fetch|curl|wget|python|httpclient|axios|node-fetch|go-http|java\//i;

// Fire-and-forget: never delays or breaks the request it describes. (Outside Netlify,
// e.g. in the offline tests, there is no Blobs store: one warning, then silence.)
let warned = false;
export function record(request, context, ev) {
  try {
    if (!insightsOn()) return;
    if (BOT.test(request.headers.get('user-agent') || '')) return;
    const day = new Date().toISOString().slice(0, 10);
    const key = `raw/${day}/${crypto.randomUUID()}`;
    const p = insightsStore().setJSON(key, { ...ev, c: countryOf(context) }).catch((e) => console.error('insights write', e.message));
    if (typeof context?.waitUntil === 'function') context.waitUntil(p);
  } catch (e) { if (!warned) console.error('insights off:', e.message); warned = true; }
}

// The tuple an event is counted under. Field order is fixed so equal events share a key.
const FIELDS = {
  s: ['q', 'f', 'd', 'e', 'i', 'k', 'o', 'r', 'c'],
  m: ['d', 'fee', 'fund', 'r', 'c', 'opt', 'lvl', 'cls', 'ug', 'fdc', 'pub', 'proj', 'ind', 'sk'],
  l: ['a', 'id', 'u', 'd', 'c'],
};
export function tupleKey(type, ev) {
  const o = {};
  for (const f of FIELDS[type]) if (ev[f] !== undefined && ev[f] !== '' && !(Array.isArray(ev[f]) && !ev[f].length)) o[f] = Array.isArray(ev[f]) ? [...ev[f]].sort() : ev[f];
  return JSON.stringify(o);
}
export const typeOf = (ev) => (['s', 'm', 'l'].includes(ev && ev.t) ? ev.t : null);
export const LISTING_ACTIONS = { v: 'Viewed', a: 'Clicked through to apply', sv: 'Saved to shortlist', pp: 'Requested a preparation pack' };
