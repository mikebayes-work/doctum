// insights-rollup — Netlify Scheduled Function, daily at 03:17 UTC.
//
// Turns yesterday's (and any older) raw events into weekly counts, then deletes the
// raw events. After this runs, all that remains of a search, a CV match or a click
// is +1 on a weekly tally of coarse categories. Safe to re-run: a day is marked
// done/<date> before its raw events are deleted, and a done day is never counted again.
//
// Can also be run by hand: POST /.netlify/functions/insights-rollup is NOT exposed
// (scheduled functions have no public URL); use the "Run now" button in the Netlify UI.
import { insightsStore, isoWeek, tupleKey, typeOf, expandEvent } from '../doctum/insights.js';
import { store as briefingStore, REPORT_DAYS } from '../doctum/jobs.js';

export async function rollup(store = insightsStore(), now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const { blobs } = await store.list({ prefix: 'raw/' });
  const byDay = new Map();
  for (const b of blobs) {
    const day = b.key.split('/')[1];
    if (day >= today) continue; // today is still being written
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b.key);
  }
  const summary = {};
  for (const [day, keys] of [...byDay].sort()) {
    const already = await store.get('done/' + day);
    if (!already) {
      const wk = isoWeek(day);
      const week = (await store.get('week/' + wk, { type: 'json' })) || { week: wk, s: {}, m: {}, l: {}, days: {} };
      let n = 0;
      for (const k of keys) {
        const raw = await store.get(k, { type: 'json' }).catch(() => null);
        for (const ev of expandEvent(raw)) {
          const t = ev && typeOf(ev);
          if (!t) continue;
          const key = tupleKey(t, ev);
          week[t][key] = (week[t][key] || 0) + 1;
          n++;
        }
      }
      week.days[day] = (week.days[day] || 0) + n;
      await store.setJSON('week/' + wk, week);
      await store.set('done/' + day, String(n));
      summary[day] = n;
    }
    for (const k of keys) await store.delete(k);
  }
  return summary;
}

// Preparation-pack housekeeping, promised on /privacy/:
//  * count/<date>/... (daily caps, incl. the per-IP coded counters) older than today are deleted;
//  * job/<rid> older than REPORT_DAYS is deleted even if nobody opens its link again.
// The ident/ and works2/ caches are left alone (they expire on read after 14 days and hold
// only public supervisor data).
export async function purgeBriefings(s = briefingStore(), now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  let counts = 0, jobs = 0;
  const { blobs: c } = await s.list({ prefix: 'count/' });
  for (const b of c) if (b.key.split('/')[1] < today) { await s.delete(b.key); counts++; }
  const { blobs: j } = await s.list({ prefix: 'job/' });
  for (const b of j) {
    const job = await s.get(b.key, { type: 'json' }).catch(() => null);
    const created = Date.parse(job && job.created);
    if (!job || !Number.isFinite(created) || now - created > REPORT_DAYS * 864e5) { await s.delete(b.key); jobs++; }
  }
  return { counts, jobs };
}

export default async () => {
  const s = await rollup();
  console.log('insights rollup', JSON.stringify(s));
  try { console.log('briefings purge', JSON.stringify(await purgeBriefings())); }
  catch (e) { console.error('briefings purge', e.message); }
};

export const config = { schedule: '17 3 * * *' };
