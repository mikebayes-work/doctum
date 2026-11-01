// scripts/test-insights.mjs — offline test of the anonymous demand analytics.
// `node scripts/build.js && node scripts/test-insights.mjs`
//
// Runs /api/search, /api/match and /api/event against a local Netlify Blobs server,
// then the daily rollup and every /api/insights report. Checks that no identifier
// or CV text is ever stored, that the CV facts need the opt-in, that the rollup
// deletes raw events, and that small groups are suppressed.
import { BlobsServer } from '@netlify/blobs/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctum-insights-'));
const token = 'test-token';
const server = new BlobsServer({ directory: dir, token, port: 0 });
const { port } = await server.start();
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: 'doctum-test', token, edgeURL: `http://localhost:${port}`, uncachedEdgeURL: `http://localhost:${port}` })).toString('base64');
process.env.INSIGHTS_ADMIN_KEY = 'admin-key-for-tests-0123456789';

const search = (await import('../netlify/edge-functions/search.js')).default;
const match = (await import('../netlify/edge-functions/match.js')).default;
const event = (await import('../netlify/edge-functions/event.js')).default;
const insights = (await import('../netlify/functions/insights.mjs')).default;
const { rollup } = await import('../netlify/functions/insights-rollup.mjs');
const { insightsStore, cleanQuery } = await import('../netlify/doctum/insights.js');
const DB = (await import('../netlify/doctum/listings.generated.js')).default;

const pending = [];
const ctx = (cc = 'IN', ip = '9.9.9.' + Math.floor(Math.random() * 250)) => ({ ip, site: { name: 'doctum' }, geo: { country: { code: cc } }, waitUntil: (p) => pending.push(p) });
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130';
const req = (url, { method = 'GET', body, type = 'application/json', ua = UA } = {}) => new Request('https://doctum.co.uk' + url, {
  method, body, headers: { origin: 'https://doctum.co.uk', 'content-type': type, 'user-agent': ua } });
const flush = async () => { await Promise.all(pending.splice(0)); };

// cleaning
ok(cleanQuery('Battery  Modelling!') === 'battery modelling', 'query cleaned to lower case words');
ok(cleanQuery('jane.doe@gmail.com') === '' && cleanQuery('call 07700900123') === '' && cleanQuery('http://x.y') === '', 'emails, phone numbers and links dropped');

const CV = `Priya Example
priya.example@mail.com  +91 98765 43210
EDUCATION
MSc Robotics, University of Somewhere (Distinction)
BTech Mechanical Engineering, First class
Dissertation on legged robot control. Internship at an automotive company.
SKILLS: Python, MATLAB, ROS, machine learning (PyTorch), CFD with ANSYS Fluent, SolidWorks CAD.
PUBLICATIONS: one conference paper in Proceedings of ICRA.
`.repeat(2);

// searches: 12 identical + 2 rare + a bot
for (let i = 0; i < 12; i++) await search(req('/api/search?q=hydrogen&disc=Engineering&quick=funded'), ctx('IN'));
await search(req('/api/search?q=underwater%20basket%20weaving'), ctx('GB'));
await search(req('/api/search?q=jane.doe@gmail.com'), ctx('GB'));
await search(req('/api/search?q=hydrogen', { ua: 'Googlebot/2.1' }), ctx('US'));
await search(req('/api/search?page=2&q=hydrogen'), ctx('GB'));
// matches: 11 opted in (same profile), 3 opted in (rare profile), 5 not opted in
const m = (share, fdc, cc) => match(req('/api/match', { method: 'POST', body: JSON.stringify({ action: 'match', cv: CV, disc: ['Engineering'], fee: 'intl', funding: 'full', share, fdc }) }), ctx(cc));
for (let i = 0; i < 11; i++) await m(true, 'IN', 'IN');
for (let i = 0; i < 3; i++) await m(true, 'MT', 'MT');
for (let i = 0; i < 5; i++) await m(false, 'IN', 'GB');
// listing signals
const L = DB.rows.find((r) => r.status === 'open');
for (const a of ['v', 'v', 'v', 'a', 'sv']) await event(req('/api/event', { method: 'POST', body: JSON.stringify({ a, id: L.id }), type: 'text/plain' }), ctx('GB'));
ok((await event(req('/api/event', { method: 'POST', body: JSON.stringify({ a: 'v', id: '000000000000' }), type: 'text/plain' }), ctx())).status === 204, 'unknown listing id → 204, nothing recorded');
await flush();

// what was stored
const store = insightsStore();
const raw = (await store.list({ prefix: 'raw/' })).blobs;
const events = await Promise.all(raw.map((b) => store.get(b.key, { type: 'json' })));
const text = JSON.stringify(events);
ok(events.filter((e) => e.t === 's').length === 13, `13 search events (bot, page 2 skipped) → ${events.filter((e) => e.t === 's').length}`);
ok(!/9\.9\.9|priya|example|mail\.com|98765|somewhere|ros\b|legged/i.test(text), 'no IP, name, email, phone, university or CV text stored');
ok(!events.some((e) => 'ip' in e || 'ua' in e || 'id' in e && e.t !== 'l' || 'ts' in e), 'no identifier fields');
const mOpt = events.filter((e) => e.t === 'm' && e.opt === 1), mNo = events.filter((e) => e.t === 'm' && e.opt === 0);
ok(mNo.length === 5 && mNo.every((e) => !('ug' in e) && !('sk' in e) && !('lvl' in e)), 'not opted in → no CV facts');
const e0 = mOpt[0];
console.log('  opted-in event:', JSON.stringify(e0));
ok(e0.ug === 'Engineering' && e0.lvl === "Master's" && e0.pub === 1 && e0.proj === 1 && e0.ind === 1 && e0.fdc === 'IN', 'opted in → coarse CV facts read');
ok(['Python', 'MATLAB', 'Machine learning', 'Simulation and modelling', 'CAD and design'].every((s) => e0.sk.includes(s)), 'skill groups: ' + e0.sk.join(', '));
ok(events.filter((e) => e.fdc === 'MT').length === 0 && events.filter((e) => e.t === 'm' && e.c === 'MT').length === 3, 'country outside the list is stored as unknown');
ok(events.filter((e) => e.t === 'l').length === 5, '5 listing signals');

// rollup
const tomorrow = new Date(Date.now() + 864e5);
const sum1 = await rollup(store, tomorrow);
ok(Object.values(sum1).reduce((a, b) => a + b, 0) === raw.length, `rollup counted ${JSON.stringify(sum1)}`);
ok((await store.list({ prefix: 'raw/' })).blobs.length === 0, 'raw events deleted after rollup');
const sum2 = await rollup(store, tomorrow);
ok(Object.keys(sum2).length === 0, 'second rollup counts nothing again');

// reports
const rep = async (qs, key = process.env.INSIGHTS_ADMIN_KEY) => insights(new Request('https://doctum.co.uk/api/insights?' + qs, { headers: key ? { 'x-doctum-admin': key } : {} }));
ok((await rep('report=summary', null)).status === 404 && (await rep('report=summary', 'wrong-key-wrong-key-wrong-key')).status === 404, 'no or wrong admin key → 404');
const J = async (qs) => (await rep(qs)).json();
let r = await J('report=terms');
ok(r.rows.length === 1 && r.rows[0][0] === 'hydrogen' && r.rows[0][1] === 12, 'terms: only the phrase searched ≥10 times → ' + JSON.stringify(r.rows));
r = await J('report=applicants&dims=d,fdc');
ok(r.rows.some((x) => x[1] === 'India' && x[2] === 11) && !r.rows.some((x) => x[1] !== 'India') && r.suppressed >= 1, 'applicants d×fdc: India 11 shown, small group hidden');
r = await J('report=demand');
const eng = r.rows.find((x) => x[0] === 'Engineering');
ok(eng && eng[1] === 12 && eng[2] === 19 && eng[6] === '100%', 'demand: Engineering 12 searches, 19 matches, 100% international → ' + JSON.stringify(eng));
r = await J('report=skills');
ok(r.rows.some((x) => x[0] === 'Engineering' && x[1] === 'Python' && x[2] === '100%'), 'skills gap rows for Engineering');
r = await J('report=listings&inst=' + encodeURIComponent(L.institution));
ok(r.rows[0][1] === 3 && r.rows[0][2] === 1 && r.rows[0][3] === 1, 'listings for one university: 3 views, 1 apply click, 1 save');
const c = await (await rep('report=filters&format=csv')).text();
ok(c.startsWith('Where,Option,Value,Times chosen'), 'CSV export');
ok((await rep('report=nope')).status === 400, 'unknown report → 400');

await server.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
