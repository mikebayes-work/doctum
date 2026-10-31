// scripts/test-api.mjs — runs the edge functions in Node with fake requests.
// `node scripts/build.js && node scripts/test-api.mjs`
import search from '../netlify/edge-functions/search.js';
import phd from '../netlify/edge-functions/phd.js';
import stats from '../netlify/edge-functions/stats.js';
import match from '../netlify/edge-functions/match.js';
import fs from 'node:fs';

const ORIGIN = 'https://doctum.co.uk';
const ctx = (ip = '1.2.3.4') => ({ ip, site: { name: 'doctum' } });
const req = (url, { method = 'GET', origin = ORIGIN, body } = {}) => new Request('https://doctum.co.uk' + url, {
  method, body, headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' } });
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const j = async (r) => [r.status, await r.json()];

// access control
ok((await search(req('/api/search'), ctx())).status === 200, 'search from own origin → 200');
ok((await search(req('/api/search', { origin: 'https://evil.example' }), ctx())).status === 403, 'other origin → 403');
ok((await search(req('/api/search', { origin: null }), ctx())).status === 403, 'no origin/referer → 403');
ok((await search(req('/api/search', { origin: 'https://deploy-preview-3--doctum.netlify.app' }), ctx())).status === 200, 'deploy preview origin → 200');
ok((await search(req('/api/search', { origin: 'https://doctum.netlify.app.evil.com' }), ctx())).status === 403, 'look-alike origin → 403');
ok((await search(req('/api/search', { method: 'POST', body: '{}' }), ctx())).status === 405, 'POST to search → 405');
const r1 = await search(req('/api/search'), ctx());
ok(r1.headers.get('x-robots-tag') === 'noindex' && r1.headers.get('vary') === 'Origin', 'noindex + Vary headers');

// search
let [s, b] = await j(await search(req('/api/search?q=battery&quick=funded'), ctx('2.2.2.2')));
ok(s === 200 && b.results.length <= 20 && b.results.every((x) => x.funding === 'Fully funded'), `search battery+funded → ${b.total} results, page size ≤ 20`);
ok(b.results.every((x) => !('description' in x)), 'cards carry no full description');
[s, b] = await j(await search(req('/api/search?page=999'), ctx('2.2.2.3')));
ok(b.page <= 25, `page capped at ${b.page} (max 25)`);
[s, b] = await j(await search(req('/api/search?disc=Engineering&elig=Open%20to%20international'), ctx('2.2.2.4')));
ok(b.results.every((x) => x.disciplines.includes('Engineering') && x.eligibility === 'Open to international'), `facet filters → ${b.total}`);

// phd
const id = b.results[0]?.id || (await j(await search(req('/api/search'), ctx('2.2.2.5'))))[1].results[0].id;
[s, b] = await j(await phd(req('/api/phd?id=' + id), ctx('3.3.3.3')));
ok(s === 200 && typeof b.description === 'string' && b.path.startsWith('/phd/'), 'phd detail → 200 with description');
ok((await phd(req('/api/phd?id=../../etc'), ctx('3.3.3.4'))).status === 404, 'bad id → 404');
ok((await phd(req('/api/phd?id=__proto__'), ctx('3.3.3.5'))).status === 404, 'proto id → 404');

// stats
[s, b] = await j(await stats(req('/api/stats'), ctx('4.4.4.4')));
ok(s === 200 && b.open > 0, `stats → ${b.open} open`);

// match
const cv = `Jane Doe\nMEng Mechanical Engineering, First class honours, University of Bath 2025.\n` +
  `Final year project: finite element analysis of composite structures and fatigue of carbon fibre laminates. ` +
  `Internship at an aerospace supplier working on structural integrity testing, MATLAB and Python data analysis, ` +
  `computational fluid dynamics in ANSYS Fluent, experimental mechanics, strain gauges and digital image correlation. ` +
  `Skills: Python, MATLAB, ABAQUS, SolidWorks, machine learning for materials data.`;
const post = (body, ip = '5.5.5.5') => match(req('/api/match', { method: 'POST', body: JSON.stringify(body) }), ctx(ip));
[s, b] = await j(await post({ action: 'profile', cv }));
ok(s === 200 && b.profile.subjects.length > 0, `profile → subjects ${JSON.stringify(b.profile.subjects)}, degree ${b.profile.degree} ${b.profile.cls}`);
ok(!('cv' in b.profile), 'profile does not echo the CV vector');
[s, b] = await j(await post({ action: 'match', cv, disc: ['Engineering', 'Materials Science'], fee: 'intl', funding: 'all' }));
ok(s === 200 && b.matches.length > 0, `match → ${b.considered} considered, ${b.matches.length} matches; top: ${b.matches[0]?.score} ${b.matches[0]?.title}`);
console.log('      why:', b.matches[0]?.why.join(', '), '| gaps:', b.matches[0]?.gaps.join(', '));
ok(b.matches.every((m) => m.eligibility !== 'UK / Home fee status only'), 'intl applicant never sees Home-only adverts');
ok((await post({ action: 'match', cv, disc: ['Nonsense'], fee: 'uk' })).status === 400, 'invalid subject → 400');
ok((await post({ action: 'match', cv, disc: ['Engineering'] })).status === 400, 'missing fee → 400');
ok((await post({ action: 'match', cv: 'too short', disc: ['Engineering'], fee: 'uk' })).status === 400, 'short CV → 400');
ok((await match(req('/api/match', { method: 'POST', body: 'x'.repeat(70000) }), ctx('5.5.5.6'))).status === 413, 'oversized body → 413');
ok((await post({ action: 'analyse', cv, id })).status === 501, 'analyse without API key → 501');
ok((await post({ action: 'nope', cv })).status === 400, 'unknown action → 400');

// rate-limit backstop
let last;
for (let i = 0; i < 95; i++) last = await search(req('/api/search'), ctx('9.9.9.9'));
ok(last.status === 429 && last.headers.get('retry-after') === '60', 'backstop rate limit → 429 after 90/min');

// dist contains no private data
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
const files = walk('dist');
ok(!files.some((f) => /\.(json|db|yaml|py)$/.test(f) || /generated\.js$/.test(f)), `dist has ${files.length} files, none private`);
const sample = fs.readFileSync(files.find((f) => f.includes('/phd/')), 'utf8');
ok(!/ANALYSE_SYSTEM|buildIndex|first_seen/.test(fs.readFileSync('dist/assets/match.js', 'utf8') + sample), 'no server logic or internal fields in public files');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
