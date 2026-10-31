// scripts/test-briefing.mjs — offline end-to-end test of the Opportunity Briefing.
// `node scripts/build.js && node scripts/test-briefing.mjs`
//
// Runs /api/briefing and briefing-background in Node against a local Netlify
// Blobs server, with every outside call (university pages, robots.txt, OpenAlex,
// ORCID, Anthropic) answered by the mock below. Nothing leaves this machine.
import { BlobsServer } from '@netlify/blobs/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

// ── local Blobs server ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctum-blobs-'));
const token = 'test-token';
const server = new BlobsServer({ directory: dir, token, port: 0 });
const { port } = await server.start();
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: 'doctum-test', token, edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}` })).toString('base64');
process.env.ANTHROPIC_API_KEY = 'sk-test';
process.env.BRIEFING_PER_IP = '3';

const DB = (await import('../netlify/doctum/listings.generated.js')).default;
const L1 = DB.rows.find((r) => r.id === 'a74f08c83ec8') || DB.rows.find((r) => r.status === 'open' && (r.supervisors || []).length >= 2);
const L2 = DB.rows.find((r) => r.status === 'open' && r.id !== L1.id && (r.supervisors || []).length);
L1.status = 'open'; L2.status = 'open';
const sup1 = L1.supervisors[0], sup2 = L2.supervisors[0];
const last1 = sup1.split(/\s+/).pop(), first1 = sup1.replace(/^(Dr|Prof|Professor)\.?\s+/i, '').split(/\s+/)[0];
const co1 = (L1.supervisors[1] || 'Dr Alex Coauthor').replace(/^(Dr|Prof|Professor)\.?\s+/i, '');
const name2 = sup2.replace(/^(Dr|Prof|Professor)\.?\s+/i, '');
console.log(`test listings: ${L1.id} (${sup1}), ${L2.id} (${sup2})`);

// ── mock outside world ──
const ORCID = '0000-0002-1825-0097';
const PROFILE_URL = new URL('/people/' + last1.toLowerCase(), L1.url).href;
const INTEREST = `My research sits between computer vision and graphics. I work on capturing real scenes with multiple cameras and on learning-based tools for optical design.`;
const calls = { model: 0, oa: 0, pages: [] };
let modelPrompt = '';
const work = (i, o = {}) => ({
  id: 'https://openalex.org/W' + (1000 + i), doi: 'https://doi.org/10.1234/test.' + i, title: o.title || `Learning multi-camera capture method ${i}`,
  publication_year: o.year || 2016 + (i % 10), publication_date: `${o.year || 2016 + (i % 10)}-0${1 + (i % 9)}-01`, type: 'article',
  primary_location: { source: { display_name: o.venue || 'IEEE Transactions on Visualization' } },
  abstract_inverted_index: o.noAbs ? null : Object.fromEntries((o.abs || `We present a camera lens optical design method using deep learning for cinematic capture number ${i}`).split(' ').map((w, k) => [w + (k ? '' : ''), [k]])),
  authorships: [{ author: { id: 'https://openalex.org/A5000000111', display_name: `${first1} ${last1}` }, institutions: [{ display_name: o.inst || L1.institution }] },
    ...(o.co || [{ id: 'A5000000222', name: co1 }]).map((c) => ({ author: { id: 'https://openalex.org/' + c.id, display_name: c.name }, institutions: [] }))],
  primary_topic: { display_name: o.topic || 'Computational imaging', field: { display_name: o.field || 'Computer Science' } }, cited_by_count: 10 + i,
});
const WORKS = [
  ...Array.from({ length: 14 }, (_, i) => work(i)),
  work(20, { title: 'Optical lens aberration correction with neural networks', abs: 'Neural networks correct optical lens aberration in cinematic camera design with ray tracing', year: 2025 }),
  work(21, { title: 'Untitled preprint', noAbs: true }),
  // a namesake merged into the record: other field, other co-authors, other institution
  ...[30, 31, 32].map((i) => work(i, { title: `Landslide susceptibility mapping in mountain region ${i}`, field: 'Earth and Planetary Sciences', topic: 'Landslides', inst: 'China University of Geosciences', co: [{ id: 'A5000000900', name: 'Wei Zhang' }], abs: 'Slope stability and landslide risk' })),
];
const author = (id, name, inst, o = {}) => ({ id: 'https://openalex.org/' + id, display_name: name, display_name_alternatives: [], orcid: o.orcid || null, works_count: o.works || 40, cited_by_count: 500,
  last_known_institutions: [{ display_name: inst }], affiliations: [{ institution: { display_name: inst } }], topics: (o.topics || ['Morphology', 'Inflection']).map((t) => ({ display_name: t, field: { display_name: 'Arts' } })) });

const REPORT = (refs) => JSON.stringify({
  atAGlance: { whyFit: ['Your computer vision MSc matches the multi-camera work.', 'Python and PyTorch match the learning methods.', 'Your dissertation used optics.'], gaps: ['No ray tracing experience yet.', 'No publications.'], thisWeek: ['Read P2, P1 and W1 first.', 'Learn the basics of lens aberrations.', 'Check the deadline.'] },
  supervisorSummary: 'Works on multi-camera capture and learning-based optical design.',
  profileQuote: 'My research sits between computer vision and graphics.',
  coSupervisors: [{ name: co1, note: 'Co-author on several capture papers.' }],
  readFirst: [{ ref: refs[0], why: 'Closest to the project.' }, { ref: refs[1], why: 'Method background.' }, { ref: 'P99', why: 'Made up and must be dropped.' }],
  alsoSkim: [{ ref: 'W1', why: 'Earlier capture work.' }],
  thread: [{ period: '2016–19', text: 'Multi-camera capture.', refs: ['P2', 'W2'] }, { period: '2025', text: 'Optics meets learning.', refs: ['P1'] }, { period: '2030', text: 'Invented step with no real refs.', refs: ['P77'] }],
  otherStrands: [],
  skills: [{ skill: 'Deep learning', evidence: 'Most recent papers', refs: ['P1'], cv: 'PyTorch projects', status: 'matched', action: 'Lead with it.' },
    { skill: 'Optical design', evidence: '2025 paper', refs: ['P1'], cv: 'Not mentioned', status: 'gap', action: 'Read an optics primer.' },
    { skill: 'Ray tracing', evidence: '2025 paper', refs: ['P1'], cv: 'Not mentioned', status: 'weird-status', action: 'Try a small renderer.' }],
  openQuestions: [{ q: 'How well does the correction generalise?', refs: ['P1'], angle: 'Ask about test lenses.' }],
  interview: { likely: ['Why this project?'], toAsk: ['What data is available?'] },
  bigPicture: 'Camera makers increasingly use computation.', approach: ['Mention the 2025 paper.'], limits: ['Abstracts only.'],
});

const realFetch = globalThis.fetch;
let worker;
globalThis.fetch = async (input, opts = {}) => {
  const url = typeof input === 'string' ? input : input.url || String(input);
  const u = new URL(url);
  if (u.hostname === 'localhost') return realFetch(input, opts);
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  const html = (h, s = 200) => new Response(h, { status: s, headers: { 'content-type': 'text/html' } });
  if (u.pathname === '/.netlify/functions/briefing-background') {
    await worker(new Request(url, { method: 'POST', headers: opts.headers, body: opts.body }), {});
    return new Response('', { status: 202 });
  }
  if (u.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /admin/\n', { status: 200 });
  if (url === L1.url) { calls.pages.push(url); return html(`<html><body><h1>${L1.title}</h1><p>Supervisors: <a href="${PROFILE_URL}">${sup1}</a> and ${L1.supervisors[1] || ''}</p></body></html>`); }
  if (url === PROFILE_URL) { calls.pages.push(url); return html(`<html><head><title>${sup1} | ${L1.institution}</title></head><body><h1>${sup1}</h1><h2>Research interests</h2><p>${INTEREST}</p><a href="https://orcid.org/${ORCID}">ORCID</a><p>doi: 10.1234/test.3</p></body></html>`); }
  if (url === L2.url) { calls.pages.push(url); return html(`<html><body><h1>${L2.title}</h1><p>No links here.</p></body></html>`); }
  if (u.hostname === 'api.openalex.org') {
    calls.oa++;
    ok(u.searchParams.get('mailto') === 'hello@doctum.co.uk', 'OpenAlex call uses the polite pool (mailto)');
    if (u.pathname === `/authors/orcid:${ORCID}`) return json(author('A5000000111', `${first1} ${last1}`, L1.institution, { orcid: 'https://orcid.org/' + ORCID, topics: ['Computer vision', 'Computational imaging'] }));
    if (u.pathname === '/institutions') return json({ results: [{ id: 'https://openalex.org/I999', display_name: L2.institution }] });
    if (u.pathname === '/authors') return json({ results: [author('A5000000501', name2, 'University of Elsewhere'), author('A5000000502', name2.split(' ')[0][0] + '. ' + name2.split(' ').pop(), 'Another University')] });
    if (u.pathname === '/authors/A5000000501') return json(author('A5000000501', name2, 'University of Elsewhere'));
    if (u.pathname === '/works') {
      const f = u.searchParams.get('filter') || '';
      if (u.searchParams.get('per-page') === '3') return json({ results: [{ title: 'A sample paper', publication_year: 2024 }] });
      if (f.startsWith('author.id:A5000000501')) return json({ results: WORKS.slice(0, 8) });
      if (f.startsWith('author.id:A5000000111')) return json({ results: WORKS });
    }
    return json({ results: [] });
  }
  if (u.hostname === 'pub.orcid.org') return json({ 'affiliation-group': [] });
  if (u.hostname === 'api.anthropic.com') {
    calls.model++;
    const b = JSON.parse(opts.body); modelPrompt = b.messages[0].content;
    ok(opts.headers['x-api-key'] === 'sk-test' && b.model && b.system.includes('Use ONLY the material supplied'), 'model call: key from env, fixed system prompt');
    return json({ content: [{ type: 'text', text: 'Here you go:\n' + REPORT(['P1', 'P2']) }], usage: { input_tokens: 9000, output_tokens: 2500 } });
  }
  return new Response('not found', { status: 404 });
};

worker = (await import('../netlify/functions/briefing-background.mjs')).default;
const api = (await import('../netlify/functions/briefing.mjs')).default;
const ctx = (ip = '9.9.9.9') => ({ ip, site: { name: 'doctum' } });
const call = async (q, { method = 'GET', body, ip, origin = 'https://doctum.co.uk' } = {}) => {
  const r = await api(new Request('https://doctum.co.uk/api/briefing' + q, { method, body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) } }), ctx(ip));
  return [r.status, await r.json().catch(() => ({}))];
};
const CV = 'MSc Computer Vision, University of Somewhere (Distinction). Dissertation on multi-view reconstruction with PyTorch. BSc Physics 2:1, optics modules. Skills: Python, PyTorch, OpenCV, C++, Blender. Internship at a VFX studio building camera calibration tools. '.repeat(2);

// ── access ──
let [s, b] = await call('?config=1');
ok(s === 200 && b.enabled === true && b.needsCode === false, 'config → enabled, no code');
[s] = await call('?config=1', { origin: 'https://evil.example' });
ok(s === 403, 'other origin → 403');
[s] = await call('?rid=../../etc');
ok(s === 404, 'bad rid → 404');

// ── scenario 1: profile → ORCID → high confidence → written straight away ──
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L1.id, supervisor: sup1, cv: CV } });
ok(s === 200 && /^[0-9a-f]{24}$/.test(b.rid), 'start → rid');
const rid1 = b.rid;
[s, b] = await call('?rid=' + rid1);
ok(s === 200 && b.state === 'done', `job done (state ${b.state}${b.error ? ': ' + b.error : ''})`);
const B = b.briefing || {};
ok(B.identity?.confidence === 'high' && /ORCID/.test(B.identity.method), `identity high via ${B.identity?.method}`);
ok(B.supervisor?.profileUrl === PROFILE_URL && B.supervisor?.orcid === ORCID, 'profile URL and ORCID recorded');
ok(B.stats?.excluded === 3 && B.excluded.every((w) => /Landslide/.test(w.title)), `namesake papers removed (${B.stats?.excluded})`);
ok(!modelPrompt.includes('Landslide'), 'removed papers never reach the model');
ok(modelPrompt.includes(INTEREST.slice(0, 60)), 'profile interests are in the model material');
ok(modelPrompt.includes(CV.slice(0, 40)), 'CV is in the model material');
ok(B.report?.readFirst.length === 2 && B.report.readFirst.every((x) => B.papers[x.ref]), 'made-up paper id P99 dropped from Read these first');
ok(B.report?.thread.length === 2, 'thread step citing only non-existent papers dropped');
ok(B.report?.profileQuote === 'My research sits between computer vision and graphics.', 'verbatim profile quote kept');
ok(B.report?.skills.find((x) => x.skill === 'Ray tracing')?.status === 'unknown', 'invalid status normalised');
ok(B.papers?.P1?.title.includes('Optical lens aberration'), 'most advert-relevant paper ranked P1');
ok(B.hadCv === true && !JSON.stringify(b).includes('Internship at a VFX'), 'job JSON does not contain the CV text');
ok(calls.model === 1, 'exactly one model call');
ok(B.report?.coSupervisors.length >= 1, 'co-supervisor note present');
ok(!/\b[PW]\d\b/.test(B.report.atAGlance.thisWeek[0]) && B.report.atAGlance.thisWeek[0].includes('Optical lens aberration'), `paper ids in text replaced by titles: "${B.report?.atAGlance.thisWeek[0]}"`);

// ── scenario 2: no profile, namesakes elsewhere → asks the student first, no AI cost ──
const before = calls.model;
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L2.id, supervisor: sup2 } });
const rid2 = b.rid;
[s, b] = await call('?rid=' + rid2);
ok(b.state === 'confirm' && b.candidates.length >= 1 && b.candidates[0].sample.length, `low confidence → confirm step with ${b.candidates?.length} candidates`);
ok(calls.model === before, 'no model call before the student confirms');
[s, b] = await call('', { method: 'POST', body: { action: 'confirm', rid: rid2, author: 'A5000000777' } });
ok(s === 400, 'confirm with an id that was not offered → 400');
[s, b] = await call('', { method: 'POST', body: { action: 'confirm', rid: rid2, author: 'A5000000501' } });
ok(s === 200, 'confirm → 200');
[s, b] = await call('?rid=' + rid2);
ok(b.state === 'done' && b.briefing.identity.confidence === 'confirmed' && b.briefing.hadCv === false, `confirmed briefing done without CV (state ${b.state})`);
ok(b.briefing?.report?.skills.every((x) => x.status !== undefined), 'skills present');

// ── caching: a second briefing on supervisor 1 reuses identity and works ──
const oaBefore = calls.oa;
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L1.id, supervisor: sup1 }, ip: '8.8.8.8' });
[s, b] = await call('?rid=' + b.rid);
ok(b.state === 'done' && calls.oa === oaBefore, `second briefing for the same supervisor made ${calls.oa - oaBefore} OpenAlex calls (cache)`);

// ── caps, access code, signature, delete ──
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L1.id, supervisor: sup1 } });
ok(s === 200, 'third request from one IP still allowed (cap 3)');
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L1.id, supervisor: sup1 } });
ok(s === 429, 'fourth request from one IP → 429');
process.env.BRIEFING_ACCESS_CODE = 'msc-2026';
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L1.id, supervisor: sup1, code: 'nope' }, ip: '7.7.7.7' });
ok(s === 403, 'wrong access code → 403');
[s, b] = await call('?config=1');
ok(b.needsCode === true, 'config reports that a code is needed');
delete process.env.BRIEFING_ACCESS_CODE;
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L1.id, supervisor: 'x' }, ip: '6.6.6.6' });
ok(s === 400, 'unusable supervisor name → 400');
await worker(new Request('https://doctum.co.uk/.netlify/functions/briefing-background', { method: 'POST', headers: { 'x-doctum-sig': 'forged' }, body: JSON.stringify({ rid: rid1, phase: 'identify' }) }), {});
[s, b] = await call('?rid=' + rid1);
ok(b.state === 'done', 'forged worker call is ignored');
[s, b] = await call('', { method: 'POST', body: { action: 'delete', rid: rid1 } });
[s, b] = await call('?rid=' + rid1);
ok(s === 404, 'deleted briefing → 404');
process.env.BRIEFINGS = 'off';
[s, b] = await call('', { method: 'POST', body: { action: 'start', id: L1.id, supervisor: sup1 }, ip: '5.5.5.5' });
ok(s === 501, 'BRIEFINGS=off → 501');
delete process.env.BRIEFINGS;
ok(calls.pages.every((p) => !p.includes('/admin/')), 'robots.txt respected');

// keep one finished briefing for the page render check
fs.writeFileSync(path.join(os.tmpdir(), 'doctum-sample-briefing.json'), JSON.stringify(B));

await server.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nAll briefing checks passed');
process.exit(fails ? 1 : 0);
