// /api/briefing — Opportunity Briefing (supervisor deep dive), request side.
//
//   GET  ?config=1                         → { enabled, needsCode }
//   GET  ?rid=<24 hex>                     → the job: state queued|working|confirm|done|error, plus the briefing when done
//   POST { action:'start', id, supervisor, cv?, code? }   → { rid }
//   POST { action:'confirm', rid, author:'A123…'|'none', cv? } → { rid }
//   POST { action:'delete', rid }          → { ok }
//
// The work itself runs in briefing-background (Netlify Background Function, up
// to 15 minutes), which this function starts with a signed request. Same guard
// as every /api/* endpoint (origin allowlist, per-IP limits, generic errors).
// No paywall yet: daily caps, an optional access code and the Anthropic spend
// cap keep the cost bounded. When the paid tier arrives, the entitlement check
// goes where the access-code check is now.
import DB from '../doctum/listings.generated.js';
import { guard } from '../doctum/http.js';
import { parseName } from '../doctum/briefing.js';
import { settings, store, newRid, sign, ipHash, sameCode, readJob, patchJob, getCount, bump, publicJob, RID_RE } from '../doctum/jobs.js';

const MAX_BODY = 60000, MAX_CV = 30000;
let BY_ID;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

async function kick(request, cfg, payload) {
  const url = new URL('/.netlify/functions/briefing-background', request.url);
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-doctum-sig': sign(cfg.key, payload.rid) }, body: JSON.stringify(payload) });
  if (res.status !== 202 && !res.ok) throw new Error('worker start failed ' + res.status);
}

export default async function handler(request, context) {
  const g = guard(request, context, { methods: ['GET', 'POST'], limit: 40 });
  if (g.early) return g.early;
  const cfg = settings();
  const s = store();
  const u = new URL(request.url);

  if (request.method === 'GET') {
    if (u.searchParams.has('config')) return g.respond(200, { enabled: cfg.enabled, needsCode: !!cfg.accessCode });
    const rid = u.searchParams.get('rid') || '';
    if (!RID_RE.test(rid)) return g.respond(404, { error: 'Briefing not found' });
    const j = await readJob(s, rid);
    if (!j) return g.respond(404, { error: 'This briefing has expired or been deleted.' });
    return g.respond(200, publicJob(j), { 'Cache-Control': j.state === 'done' ? 'private, max-age=300' : 'no-store' });
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return g.respond(413, { error: 'That CV is too long. Paste the main sections only.' });
    body = JSON.parse(raw);
  } catch { return g.respond(400, { error: 'Invalid request' }); }
  const cv = str(body?.cv, MAX_CV).trim();

  if (body.action === 'delete') {
    const rid = str(body.rid, 24);
    if (!RID_RE.test(rid)) return g.respond(404, { error: 'Briefing not found' });
    await s.delete('job/' + rid);
    return g.respond(200, { ok: true });
  }

  if (!cfg.enabled) return g.respond(501, { error: 'Opportunity briefings are not switched on yet.' });

  if (body.action === 'start') {
    if (cfg.accessCode && !sameCode(str(body.code, 100).trim(), cfg.accessCode)) return g.respond(403, { error: 'That access code is not right.' });
    BY_ID ||= new Map(DB.rows.map((r) => [r.id, r]));
    const id = str(body.id, 12);
    const r = /^[0-9a-f]{12}$/.test(id) ? BY_ID.get(id) : null;
    if (!r || r.status !== 'open') return g.respond(404, { error: 'That PhD is not open any more.' });
    const supervisor = str(body.supervisor, 100).trim();
    const name = parseName(supervisor);
    if (!name || name.last.length < 2) return g.respond(400, { error: 'Choose or type the supervisor’s name.' });
    if (cv && cv.length < 200) return g.respond(400, { error: 'Add a few more lines of your CV, or leave it blank.' });

    const ip = ipHash(cfg.key, context?.ip || request.headers.get('x-nf-client-connection-ip') || 'unknown');
    if ((await getCount(s, 'all')) >= cfg.dailyLimit) return g.respond(429, { error: 'Today’s free briefings have all been used. Please try again tomorrow.' });
    if ((await getCount(s, ip)) >= cfg.perIp) return g.respond(429, { error: `You can request ${cfg.perIp} briefings a day while this is free. Please try again tomorrow.` });
    await bump(s, ip);

    const rid = newRid();
    await s.setJSON('job/' + rid, {
      rid, state: 'queued', step: 'Queued', created: new Date().toISOString(),
      listing: { id: r.id, path: r.path, title: r.title, institution: r.institution }, supervisor: name.full, supervisorRaw: supervisor,
    });
    try { await kick(request, cfg, { rid, phase: 'identify', cv }); }
    catch (e) { console.error('briefing kick', e.message); await patchJob(s, rid, { state: 'error', error: 'The briefing service could not start. Please try again shortly.' }); }
    return g.respond(200, { rid });
  }

  if (body.action === 'confirm') {
    const rid = str(body.rid, 24);
    const author = str(body.author, 20);
    if (!RID_RE.test(rid) || !(author === 'none' || /^A\d{4,15}$/.test(author))) return g.respond(400, { error: 'Invalid request' });
    const j = await readJob(s, rid);
    if (!j || j.state !== 'confirm') return g.respond(409, { error: 'This briefing is not waiting for a choice.' });
    const allowed = new Set([...(j.candidates || []).map((c) => c.id), 'none']);
    if (!allowed.has(author)) return g.respond(400, { error: 'Pick one of the researchers listed.' });
    await patchJob(s, rid, { state: 'queued', step: 'Queued', candidates: [] });
    try { await kick(request, cfg, { rid, phase: 'write', author, cv }); }
    catch (e) { console.error('briefing kick', e.message); await patchJob(s, rid, { state: 'error', error: 'The briefing service could not start. Please try again shortly.' }); }
    return g.respond(200, { rid });
  }

  return g.respond(400, { error: 'Unknown action' });
}

export const config = {
  path: '/api/briefing',
  rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
