// briefing-background — Netlify Background Function (runs up to 15 minutes).
// Started only by /api/briefing with an HMAC signature over the job id, so it
// can't be triggered from outside. Progress and the finished briefing are
// written to the job in Netlify Blobs; the browser polls /api/briefing?rid=.
//
// Phase "identify": find the supervisor (profile → ORCID → OpenAlex). High or
//   medium confidence goes straight on to writing. Low confidence stops and asks
//   the student to pick the right researcher (before any AI cost).
// Phase "write": works → clean → rank → one AI call → validated briefing.
import DB from '../doctum/listings.generated.js';
import { makeNet, identify, buildBriefing, fetchAuthor, sampleTitles, parseName } from '../doctum/briefing.js';
import { settings, store, verify, readJob, patchJob, getCount, bump, cached, CACHE_DAYS } from '../doctum/jobs.js';

let BY_ID;
const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');

const FRIENDLY = {
  'no-material': 'We couldn’t find a publication record or university profile for this supervisor, so there is nothing reliable to base a briefing on.',
  'bad-name': 'We couldn’t read the supervisor’s name.',
  'cap': 'Today’s free briefings have all been used. Please try again tomorrow.',
};

export default async function handler(request) {
  const cfg = settings();
  let body;
  try { body = await request.json(); } catch { return; }
  const rid = String(body?.rid || '');
  if (!cfg.key || !verify(cfg.key, rid, request.headers.get('x-doctum-sig'))) { console.warn('briefing-background: bad signature'); return; }
  const s = store();
  const job = await readJob(s, rid);
  if (!job || job.state !== 'queued') return;
  BY_ID ||= new Map(DB.rows.map((r) => [r.id, r]));
  const listing = BY_ID.get(job.listing.id);
  const cv = typeof body.cv === 'string' ? body.cv.slice(0, 30000) : '';
  const net = makeNet(fetch, { mailto: cfg.mailto, openalexKey: cfg.openalexKey });
  // Progress writes are queued so a late one can never overwrite the final state.
  let chain = Promise.resolve();
  const progress = (step) => (chain = chain.then(() => patchJob(s, rid, { state: 'working', step })).catch(() => {}));
  const finish = async (patch) => { await chain; await patchJob(s, rid, patch); };

  try {
    if (!listing) throw new Error('listing-gone');
    let identity;

    if (body.phase === 'identify') {
      await progress('Finding the supervisor');
      const ikey = `ident/${fold(job.supervisorRaw)}|${fold(listing.institution)}`;
      identity = await cached(s, ikey, CACHE_DAYS, () => identify(net, listing, job.supervisorRaw, progress));
      if (identity.confidence === 'none') throw new Error('no-material');
      if (identity.confidence === 'low') {
        const candidates = [];
        for (const c of identity.candidates || []) candidates.push({ ...c, sample: await sampleTitles(net, c.id) });
        await finish({ state: 'confirm', step: 'Please confirm the supervisor', candidates, identity: { ...identity, candidates: [] }, hasProfile: !!identity.profile });
        return;
      }
    } else if (body.phase === 'write') {
      identity = job.identity;
      if (!identity) throw new Error('no-identity');
      identity.name = parseName(job.supervisorRaw);
      if (body.author === 'none') {
        identity = { ...identity, author: null, confidence: 'confirmed', method: 'University profile only (you confirmed none of the publication records matched)', confirmedByUser: true };
        if (!identity.profile) throw new Error('no-material');
      } else {
        const author = await fetchAuthor(net, body.author);
        if (!author) throw new Error('no-material');
        identity = { ...identity, author, confidence: 'confirmed', method: 'You confirmed this publication record is the right person', confirmedByUser: true };
      }
    } else return;

    if ((await getCount(s, 'all')) >= cfg.dailyLimit) throw new Error('cap');
    await bump(s, 'all');
    const briefing = await buildBriefing({
      net, fetchFn: fetch, listing, identity, cv, key: cfg.key, model: cfg.model, progress,
      worksCache: (authorId, make) => cached(s, `works2/${authorId}`, CACHE_DAYS, make),   // works2: includes funders and co-author organisations
      identCache: (raw, inst, make) => cached(s, `ident/${fold(raw)}|${fold(inst)}`, CACHE_DAYS, make),
    });
    await finish({ state: 'done', step: 'Ready', briefing, identity: null, candidates: [] });
    console.log('briefing done', rid, briefing.usage ? JSON.stringify(briefing.usage) : '');
  } catch (e) {
    console.error('briefing failed', rid, e.message);
    await finish({ state: 'error', error: FRIENDLY[e.message] || 'The briefing could not be completed. Please try again later.', identity: null });
  }
}
