// scripts/university-report.mjs — a branded Doctum report for one university (or the whole sector).
//
//   node scripts/university-report.mjs --inst "Cranfield University" [--from 2026-W45] [--to 2026-W48]
//   node scripts/university-report.mjs                      (no --inst: UK sector overview)
//   node scripts/university-report.mjs --inst "…" --sample (made-up figures, to see the layout)
//   options: --weeks N (last N full weeks, default 4), --no-pdf (HTML only), --open (open the folder afterwards)
//   DOCTUM_NO_WEBFONTS=1 skips Google Fonts (only needed where the web is blocked, e.g. offline tests)
//
// Needs INSIGHTS_ADMIN_KEY (or the key saved by DoctumReports.exe) unless --sample.
// Reads the private /api/insights reports plus this repo's data/listings.json (for the
// university's open adverts and what each advert states), writes
//   reports/university/<name>_<from>_<to>/report.html and report.pdf
// The PDF is printed by Microsoft Edge or Google Chrome in headless mode, so nothing
// extra needs installing on Windows. Every applicant figure under 10 is already
// suppressed by the server; this script never un-suppresses or estimates them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = 10;
const UKRI = 21805;

// ── arguments ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
const flag = (name) => argv.includes('--' + name);
const INST = opt('inst');
const SAMPLE = flag('sample');
const SITE = (process.env.SITE_URL || 'https://doctum.co.uk').replace(/\/+$/, '');
const KEY_FILE = path.join(os.homedir(), '.doctum', 'insights-key.txt');
const KEY = (process.env.INSIGHTS_ADMIN_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8') : '')).trim();

function isoWeek(d) {
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const weekStart = (wk) => { // Monday of an ISO week
  const [y, w] = wk.split('-W').map(Number); const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(jan4); mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7); return mon;
};
const lastFull = isoWeek(new Date(Date.now() - 7 * 864e5));
const WEEKS = Math.min(52, Math.max(1, parseInt(opt('weeks'), 10) || 4));
const FROM = opt('from') || isoWeek(new Date(weekStart(lastFull).getTime() - (WEEKS - 1) * 7 * 864e5));
const TO = opt('to') || lastFull;
const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const PERIOD = `${fmtDate(weekStart(FROM))} to ${fmtDate(new Date(weekStart(TO).getTime() + 6 * 864e5))}`;

// ── data ──────────────────────────────────────────────────────────────
const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'listings.json'), 'utf8'));
const OPEN = db.listings.filter((r) => r.status === 'open');
const MINE = INST ? OPEN.filter((r) => r.institution === INST) : OPEN;
if (INST && !MINE.length) {
  const near = [...new Set(OPEN.map((r) => r.institution))].filter((i) => i.toLowerCase().includes(INST.toLowerCase().split(' ')[0].toLowerCase())).slice(0, 5);
  console.error(`No open adverts for "${INST}" in data/listings.json.${near.length ? ' Did you mean: ' + near.join('; ') + '?' : ''}`);
  process.exit(1);
}
const SUBJECTS = [...new Set(MINE.flatMap((r) => r.disciplines || []))].filter((d) => !/^Other/.test(d));

async function api(report, params = {}) {
  const u = new URL('/api/insights', SITE);
  u.searchParams.set('report', report); u.searchParams.set('from', FROM); u.searchParams.set('to', TO);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { 'x-doctum-admin': KEY } });
  if (res.status === 404) throw new Error(`${report}: HTTP 404 (the key doesn't match, or the site isn't deployed)`);
  if (!res.ok) {
    // e.g. 400 "Unknown report" when the live site is older than this script: carry on without that section
    console.log(`  ! ${report}${params.dims ? ' (' + params.dims + ')' : ''}: HTTP ${res.status}. That section will be empty. Run DoctumCommit to deploy the latest code.`);
    return { rows: [], columns: [] };
  }
  return res.json();
}

async function liveData() {
  if (!KEY) { console.error('No key: set INSIGHTS_ADMIN_KEY or run DoctumReports.exe once to save it. Or use --sample.'); process.exit(1); }
  const i = INST || '';
  const [summary, listings, listingsAll, sources, sourcesAll, fee, ug, fdc, lvl, feeAll, ugAll, demand, skills, terms] = await Promise.all([
    api('summary'), i ? api('listings', { inst: i }) : null, api('listings'), api('sources', { inst: i }), api('sources'),
    api('matched', { inst: i, dims: 'fee', bysubject: '0' }), api('matched', { inst: i, dims: 'ug', bysubject: '0' }),
    api('matched', { inst: i, dims: 'fdc', bysubject: '0' }), api('matched', { inst: i, dims: 'lvl', bysubject: '0' }),
    api('matched', { dims: 'fee', bysubject: '0' }), api('matched', { dims: 'ug', bysubject: '0' }),
    api('demand'), api('skills'), api('terms'),
  ]);
  return { summary, listings, listingsAll, sources, sourcesAll, fee, ug, fdc, lvl, feeAll, ugAll, demand, skills, terms };
}

// Made-up but plausible figures in exactly the shape the API returns, for layout previews.
function sampleData() {
  let seed = [...(INST || 'sector')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const int = (a, b) => Math.round(a + rnd() * (b - a));
  const ads = (INST ? MINE : OPEN.slice(0, 40)).map((r) => {
    const v = int(8, 160), mi = int(v, v * 3), rm = Math.round(v * (0.3 + rnd() * 0.4)), a = Math.round(v * (0.08 + rnd() * 0.25));
    return [r.title, r.funding || '', mi, v, rm, a, Math.round(a * (0.3 + rnd() * 0.6)), int(0, 4), v ? Math.round((100 * a) / v) + '%' : '', r.id];
  });
  const bench = { 'Viewed': 41, 'Read the full advert': 15, 'Clicked through to apply': 6, 'Saved to shortlist': 3, 'Requested a preparation pack': 0, 'Appeared in CV match results': 88 };
  const share = (rows) => { const t = rows.reduce((a, r) => a + r[1], 0); return rows.map((r) => [...r, Math.round((100 * r[1]) / t) + '%']); };
  const src = (k) => share([['Doctum search', int(200, 400) * k], ['Search engine', int(120, 260) * k], ['Doctum CV match', int(90, 200) * k], ['Doctum subject page', int(40, 90) * k],
    ['AI assistant', int(20, 60) * k], ['Similar PhDs on Doctum', int(20, 50) * k], ['Social media', int(10, 30) * k], ['Direct or unknown', int(30, 80) * k]].sort((a, b) => b[1] - a[1]));
  const subj = SUBJECTS.length ? SUBJECTS : ['Engineering'];
  const allDiscs = [...new Set(OPEN.flatMap((r) => r.disciplines || []))].filter((d) => !/^Other/.test(d));
  return {
    summary: { weeks: [], columns: [], rows: [] },
    listings: INST ? { columns: [], rows: ads, benchmark: { 'Median per advert, all universities': bench } } : null,
    listingsAll: { columns: [], rows: [], benchmark: { 'Median per advert, all universities': bench } },
    sources: { rows: src(1) }, sourcesAll: { rows: src(12) },
    fee: { rows: [['UK', int(300, 900)], ['International', int(400, 1100)]] },
    ug: { rows: [[subj[0], int(150, 400)], ['Physics & Astronomy', int(60, 160)], ['Mathematics & Statistics', int(40, 120)], ['Computer Science & AI', int(40, 120)], ['Chemistry', int(15, 60)], ['Biological Sciences', int(10, 40)]].filter((r, k, a) => a.findIndex((x) => x[0] === r[0]) === k).sort((a, b) => b[1] - a[1]) },
    fdc: { rows: [['United Kingdom', int(200, 500)], ['India', int(150, 400)], ['China', int(80, 250)], ['Nigeria', int(40, 140)], ['Pakistan', int(30, 100)], ['Iran', int(15, 60)], ['Greece', int(10, 40)]].sort((a, b) => b[1] - a[1]) },
    lvl: { rows: [["Master's", int(300, 700)], ["Bachelor's", int(200, 500)], ['PhD', int(10, 40)]].sort((a, b) => b[1] - a[1]) },
    feeAll: { rows: [['UK', 9400], ['International', 11800]] },
    ugAll: { rows: [['Engineering', 4100], ['Biological Sciences', 2900], ['Computer Science & AI', 2600], ['Physics & Astronomy', 1500], ['Chemistry', 1300]] },
    demand: { rows: allDiscs.map((d) => { const n = OPEN.filter((r) => (r.disciplines || []).includes(d)).length, s = int(n * 2, n * 9), m = int(n, n * 5);
      return [d, s, m, n, OPEN.filter((r) => r.funding === 'Fully funded' && (r.disciplines || []).includes(d)).length, n ? +((s + m) / n).toFixed(2) : null, int(35, 70) + '%']; }).sort((a, b) => b[5] - a[5]) },
    skills: { rows: subj.flatMap((d) => [['Python', 62, 38], ['Machine learning', 41, 29], ['Simulation and modelling', 33, 44], ['Experimental lab work', 28, 47], ['Statistics', 36, 21], ['MATLAB', 30, 18], ['CAD and design', 14, 12], ['High-performance computing', 9, 16]]
      .map(([s, a, w]) => [d, s, Math.max(5, a + int(-8, 8)) + '%', Math.max(3, w + int(-8, 8)) + '%', int(120, 600), OPEN.filter((r) => (r.disciplines || []).includes(d)).length])) },
    terms: { rows: [['hydrogen', 412, '<10'], ['machine learning', 388, '<10'], ['battery', 301, '<10'], ['quantum computing', 190, 41], ['nuclear fusion', 160, 22], ['motorsport', 141, 63], ['sustainable aviation fuel', 98, 57], ['space debris', 74, 48], ['agritech robotics', 52, 39], ['digital twin', 210, '<10']] },
  };
}

// ── helpers ───────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x) => (typeof x === 'number' ? x.toLocaleString('en-GB') : esc(x));
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const num = (v) => (typeof v === 'number' ? v : 0);
const sum = (rows, i = 1) => rows.reduce((a, r) => a + num(r[i]), 0);
const times = (a, b) => (!b ? '' : a / b >= 1.15 ? `${(a / b).toFixed(1)}× the median advert` : a / b <= 0.87 ? `${Math.round(100 * a / b)}% of the median advert` : 'in line with the median advert');

// Horizontal bar chart (SVG). rows: [label, value, compareValue?]; compare drawn as a thin marker.
function bars(rows, { unit = '', compare = '', barLabel = INST ? 'Your adverts' : 'All adverts', max, width = 640, fmt = (v) => n(v) + unit } = {}) {
  if (!rows.length) return '<p class="empty">Not enough data in this period yet.</p>';
  const narrow = width < 500, lw = narrow ? 130 : 210, vw = narrow ? 36 : 70, bw = width - lw - vw - 10, h = narrow ? 24 : 26;
  const m = max || Math.max(1, ...rows.map((r) => Math.max(num(r[1]), num(r[2]))));
  const H = rows.length * h + 6;
  return `<svg class="chart" viewBox="0 0 ${width} ${H}" role="img">${rows.map((r, i) => {
    const y = i * h + 4, w = (num(r[1]) / m) * bw, c = r[2] != null ? (num(r[2]) / m) * bw : null;
    return `<text x="0" y="${y + 15}" class="lab">${esc(String(r[0]).slice(0, narrow ? 22 : 34))}</text>
<rect x="${lw}" y="${y + 3}" width="${Math.max(1.5, w).toFixed(1)}" height="16" rx="2" class="bar"/>
${c != null ? `<rect x="${(lw + c - 1).toFixed(1)}" y="${y}" width="2.5" height="22" class="mark"/>` : ''}
<text x="${width}" y="${y + 15}" text-anchor="end" class="val">${typeof r[1] === 'number' ? fmt(r[1]) : esc(r[1])}</text>`;
  }).join('')}</svg>${compare ? `<p class="key"><span class="k-bar"></span>${esc(barLabel)} <span class="k-mark"></span>${esc(compare)}</p>` : ''}`;
}
// Share split bar (two or three parts) with labels.
function split(parts) {
  const t = parts.reduce((a, p) => a + p[1], 0) || 1; let x = 0;
  return `<svg class="chart" viewBox="0 0 640 46" role="img">${parts.map(([l, v], i) => {
    const w = (640 * v) / t, s = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 2).toFixed(1)}" height="22" class="seg s${i}"/><text x="${(x + 4).toFixed(1)}" y="38" class="lab">${esc(l)} ${pct(v, t)}%</text>`;
    x += w; return s;
  }).join('')}</svg>`;
}
const table = (cols, rows, cls = '') => `<div class="tw"><table class="${cls}"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${typeof v === 'number' ? n(v) : v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

// What an advert states (public facts from the advert itself)
const CHECKS = [
  ['Stipend amount', (r) => !!r.stipend],
  ['Who can apply', (r) => r.eligibility && r.eligibility !== 'Not stated'],
  ['Deadline date', (r) => !!r.deadline],
  ['Supervisor named', (r) => (r.supervisors || []).length > 0],
  ['Start date', (r) => !!r.start],
];

// ── build ─────────────────────────────────────────────────────────────
function build(D) {
  const bench = Object.values(D.listingsAll.benchmark || {})[0] || {};
  const B = { mi: num(bench['Appeared in CV match results']), v: num(bench['Viewed']), rm: num(bench['Read the full advert']), a: num(bench['Clicked through to apply']), sv: num(bench['Saved to shortlist']), pp: num(bench['Requested a preparation pack']) };
  const byId = new Map((D.listings?.rows || []).map((r) => [r[r.length - 1], r]));
  const adRows = MINE.map((r) => { const x = byId.get(r.id); return { r, mi: num(x?.[2]), v: num(x?.[3]), rm: num(x?.[4]), a: num(x?.[5]), sv: num(x?.[6]), pp: num(x?.[7]) }; });
  const nAds = Math.max(1, MINE.length);
  const T = INST ? ['mi', 'v', 'rm', 'a', 'sv', 'pp'].reduce((o, k) => ({ ...o, [k]: adRows.reduce((s, x) => s + x[k], 0) }), {}) : null;
  const per = T ? Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v / nAds])) : null;
  const findings = [];

  // 1. glance
  let glance = '';
  if (INST) {
    const tiles = [[MINE.length, 'open adverts listed on Doctum', `${MINE.filter((r) => r.funding === 'Fully funded').length} fully funded`],
      [T.mi, 'times in applicants’ CV match results', times(per.mi, B.mi)], [T.v, 'advert page views', times(per.v, B.v)],
      [T.rm, 'full advert reads', times(per.rm, B.rm)], [T.a, 'click-throughs to apply', times(per.a, B.a)], [T.sv + T.pp, 'shortlist saves and preparation packs', '']];
    glance = `<div class="tiles">${tiles.map(([v, l, s]) => `<div><b>${n(v)}</b><span>${esc(l)}</span>${s ? `<small>${esc(s)}</small>` : ''}</div>`).join('')}</div>`;
    if (B.v) findings.push(`Each of your adverts was viewed ${per.v.toFixed(0)} times on average, ${times(per.v, B.v)} on Doctum.`);
    if (T.v) findings.push(`${pct(T.a, T.v)}% of views led to a click through to your application page${B.v ? ` (median advert: ${pct(B.a, B.v)}%)` : ''}.`);
  }

  // 2. funnel
  const funnel = INST ? `<section class="keep"><h2>From match to application</h2><p class="lead">The average journey for one of your adverts, compared with the median advert across all universities on Doctum.</p>
${bars([['Appeared in CV matches', Math.round(per.mi), B.mi], ['Page views', Math.round(per.v), B.v], ['Read the full advert', Math.round(per.rm), B.rm], ['Clicked through to apply', Math.round(per.a), B.a]], { compare: 'Median advert, all universities' })}</section>` : '';

  // 3. adverts
  let adverts = '';
  if (INST) {
    const missing = CHECKS.map(([l, f]) => [l, MINE.filter((r) => !f(r)).length]).filter(([, c]) => c);
    const tick = (ok) => (ok ? '<span class="yes">✓</span>' : '<span class="no">–</span>');
    const rows = adRows.sort((a, b) => b.v - a.v).map((x) => [`<span class="t">${esc(x.r.title.slice(0, 90))}</span><br><span class="sub">${esc(x.r.funding || 'Funding not stated')}${x.r.deadline ? ' · closes ' + esc(fmtDate(new Date(x.r.deadline + 'T00:00:00Z'))) : ''}</span>`,
      x.mi, x.v, x.rm, x.a, x.v ? pct(x.a, x.v) + '%' : '–', CHECKS.map(([, f]) => tick(f(x.r))).join(' ')]);
    adverts = `<h2>Advert by advert</h2>${table(['Advert', 'In CV matches', 'Views', 'Full reads', 'Apply clicks', 'Apply rate', 'States: stipend · eligibility · deadline · supervisor · start'], rows, 'ads')}
${missing.length ? `<div class="advice"><h3>Quick wins in the adverts themselves</h3><ul>${missing.map(([l, c]) => `<li><strong>${c} of ${MINE.length}</strong> adverts don’t state the ${esc(l.toLowerCase())}.</li>`).join('')}</ul><p>Applicants filter on funding and eligibility first. Adverts that leave these out are harder to find on Doctum and easier to skip elsewhere.</p></div>` : ''}`;
    if (missing.length) findings.push(`${missing[0][1]} of your ${MINE.length} adverts don’t state the ${missing[0][0].toLowerCase()}, one of the first things applicants look for.`);
  }

  // 4. sources
  const sAll = new Map((D.sourcesAll.rows || []).map((r) => [r[0], num(r[1])])), sAllT = [...sAll.values()].reduce((a, b) => a + b, 0);
  const sMine = (D.sources.rows || []).map((r) => [r[0], num(r[1])]), sMineT = sum(sMine);
  const sources = `<section class="keep"><h2>How applicants find ${INST ? 'your adverts' : 'adverts'}</h2>${bars(sMine.map(([l, v]) => [l, pct(v, sMineT), INST ? pct(sAll.get(l) || 0, sAllT) : null]), { unit: '%', max: 100 * Math.max(...sMine.map((r) => r[1] / (sMineT || 1)), ...[...sAll.values()].map((v) => v / (sAllT || 1)), 0.01), compare: INST ? 'All universities' : '' })}</section>`;
  const ai = sMine.find((r) => r[0] === 'AI assistant'), se = sMine.find((r) => r[0] === 'Search engine');
  if (sMineT && se) findings.push(`${pct(se[1], sMineT)}% of visits to ${INST ? 'your' : ''} advert pages came from search engines${ai ? ` and ${pct(ai[1], sMineT)}% from AI assistants such as ChatGPT` : ''}.`);

  // 5. reach
  const feeR = (D.fee.rows || []).map((r) => [r[0] === 'intl' ? 'International' : r[0] === 'uk' ? 'UK' : r[0], num(r[1])]).filter((r) => r[1] >= K);
  const feeA = (D.feeAll.rows || []).map((r) => [r[0] === 'intl' ? 'International' : r[0] === 'uk' ? 'UK' : r[0], num(r[1])]);
  const intl = (rows) => { const t = sum(rows); const i = rows.find((r) => r[0] === 'International'); return t ? pct(i ? i[1] : 0, t) : null; };
  const top = (rows, k = 8) => (rows || []).map((r) => [r[0], num(r[1])]).filter((r) => r[1] >= K && !/unknown|\(none\)/i.test(r[0])).slice(0, k);
  const reach = `<section class="keep"><h2>Who ${INST ? 'your adverts' : 'adverts'} reach</h2><p class="lead">Applicants whose CV matched ${INST ? 'your adverts' : 'an advert'} on Doctum. Degree and country come only from applicants who chose to be counted; groups smaller than ${K} are not shown.</p>
<h3>Fee status</h3>${feeR.length ? split(feeR) : '<p class="empty">Not enough data in this period yet.</p>'}${INST && intl(feeA) != null && intl(feeR) != null ? `<p class="small">All universities: ${intl(feeA)}% international.</p>` : ''}
<div class="two"><div><h3>First-degree subject</h3>${bars(top(D.ug.rows), { width: 330 })}</div><div><h3>Country of first degree</h3>${bars(top(D.fdc.rows), { width: 330 })}</div></div>
<h3>Highest degree so far</h3>${bars(top(D.lvl.rows, 4))}</section>`;
  if (intl(feeR) != null) findings.push(`${intl(feeR)}% of applicants matched to ${INST ? 'your adverts' : 'adverts'} need international fee status${INST && intl(feeA) != null ? ` (all universities: ${intl(feeA)}%)` : ''}.`);
  const firstUg = top(D.ug.rows)[0];
  if (firstUg) findings.push(`The largest group of matched applicants took their first degree in ${firstUg[0]}.`);

  // 6. demand
  const dRows = (D.demand.rows || []).filter((r) => !INST || SUBJECTS.includes(r[0]));
  const natMedian = (() => { const v = (D.demand.rows || []).map((r) => num(r[5])).filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : 0; })();
  const demand = `<section class="keep"><h2>Demand in ${INST ? 'your subjects' : 'each subject'}</h2><p class="lead">Searches and CV matches per open advert. Above the median means more applicants chasing each PhD.</p>
${bars(dRows.map((r) => [r[0], num(r[5]), natMedian]), { fmt: (v) => v.toFixed(1), barLabel: 'Searches and matches per open advert', compare: 'Median subject' })}</section>
${table(['Subject', 'Searches', 'CV matches', 'Open adverts', 'Fully funded', 'International share'], dRows.map((r) => [esc(r[0]), r[1], r[2], r[3], r[4], esc(r[6])]))}`;
  const hot = dRows.filter((r) => num(r[5]) > natMedian * 1.3).map((r) => r[0]);
  if (hot.length) findings.push(`Demand per advert is well above the median in ${hot.slice(0, 3).join(', ')}: more applicants than PhDs.`);

  // 7. skills
  const skRows = (D.skills.rows || []).filter((r) => !INST || SUBJECTS.includes(r[0]));
  // The three subjects with most of this university's adverts (or the four with most applicants, sector-wide).
  const subjForSkills = (INST ? [...SUBJECTS].sort((a, b) => MINE.filter((r) => (r.disciplines || []).includes(b)).length - MINE.filter((r) => (r.disciplines || []).includes(a)).length)
    : [...new Set(skRows.map((r) => r[0]))]).filter((d) => skRows.some((r) => r[0] === d && /%$/.test(String(r[2])))).slice(0, INST ? 3 : 4);
  const skills = subjForSkills.map((d) => {
    const rows = skRows.filter((r) => r[0] === d && /%$/.test(String(r[2]))).map((r) => [r[1], parseInt(r[2], 10), parseInt(r[3], 10) || 0]).sort((a, b) => b[2] - a[2]).slice(0, 8);
    if (!rows.length) return '';
    const gaps = rows.filter((r) => r[2] - r[1] >= 10).map((r) => r[0]);
    if (gaps.length && INST) findings.push(`In ${d}, adverts ask for ${gaps.slice(0, 2).join(' and ').toLowerCase()} more often than applicants offer it.`);
    return `<div class="skill"><h3>${esc(d)}</h3>${bars(rows.map((r) => [r[0], r[1], r[2]]), { unit: '%', max: 100, width: 330, barLabel: 'Applicants with it', compare: 'Adverts asking for it' })}</div>`;
  }).join('');
  const skillsSec = `<section class="keep"><h2>Skills applicants bring, and what adverts ask for</h2><p class="lead">Bars: share of applicants in the subject whose CV mentions each skill group. Marker: share of open adverts in the subject that ask for it. ${INST ? 'Your three largest subjects.' : ''}</p>${skills ? `<div class="two">${skills}</div>` : '<p class="empty">Not enough data in this period yet.</p>'}</section>`;

  // 8. unmet demand
  const unmet = (D.terms.rows || []).filter((r) => typeof r[2] === 'number').sort((a, b) => b[2] - a[2]).slice(0, 10);
  const searched = (D.terms.rows || []).slice(0, 10);
  const termsSec = `<section class="keep"><h2>What applicants search for</h2><div class="two"><div><h3>Most searched</h3>${bars(searched.map((r) => [r[0], num(r[1])]), { width: 330 })}</div>
<div><h3>Searched, but nothing found</h3>${bars(unmet.map((r) => [r[0], r[2]]), { width: 330 })}<p class="small">Topics where applicants found no open PhD on Doctum. A signal for new projects and CDT themes.</p></div></div></section>`;
  if (unmet[0]) findings.push(`Applicants searched for “${unmet[0][0]}” ${n(unmet[0][2])} times without finding a single open PhD.`);

  return { glance, funnel, adverts, sources, reach, demand, skillsSec, termsSec, findings: findings.slice(0, 6) };
}

function page(S) {
  const logo = fs.readFileSync(path.join(ROOT, 'brand', 'logo.svg'), 'utf8').replace(/<metadata>[\s\S]*?<\/metadata>/, '');
  const title = INST ? `${INST}: your PhD adverts on Doctum` : 'UK PhD demand on Doctum';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
${process.env.DOCTUM_NO_WEBFONTS ? "" : `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">`}
<style>
@page{size:A4;margin:16mm 15mm 18mm}
*{box-sizing:border-box}
body{margin:0;font:400 10.5pt/1.5 'IBM Plex Sans',system-ui,sans-serif;color:#1c2436;-webkit-print-color-adjust:exact;print-color-adjust:exact}
h1,h2,h3{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;color:#1B2A4A;line-height:1.15;margin:0 0 .4em}
h1{font-size:30pt}h2{font-size:19pt;margin-top:1.4em;padding-top:.4em;border-top:3px double #B08A4E;break-after:avoid}h3{font-size:13.5pt;margin-top:1em;break-after:avoid}
.lead{color:#5d6475;max-width:62em}.small,.key{font-size:8.5pt;color:#5d6475}.empty{color:#5d6475;font-style:italic}
.cover{min-height:245mm;display:flex;flex-direction:column;break-after:page}
.cover .logo svg{height:56px;width:auto}
.cover .eyebrow{font:600 8pt 'IBM Plex Sans';letter-spacing:.16em;text-transform:uppercase;color:#86652f;margin:60px 0 10px}
.cover .period{font-size:12pt;color:#5d6475;margin:0 0 30px}
.findings{background:#FAF6EE;border:1px solid #E0D7C4;border-top:3px double #B08A4E;padding:16px 22px;margin-top:10px}
.findings h2{border:0;margin:0 0 6px;padding:0;font-size:16pt}.findings li{margin:5px 0}
.cover .foot{margin-top:auto;font-size:8.5pt;color:#5d6475;border-top:1px solid #E0D7C4;padding-top:10px}
.sample{position:fixed;top:40%;left:0;right:0;text-align:center;font:700 64pt 'IBM Plex Sans';color:rgba(155,44,44,.09);transform:rotate(-24deg);pointer-events:none}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.tiles div{border:1px solid #E0D7C4;border-top:3px double #B08A4E;padding:10px 12px;break-inside:avoid}
.tiles b{display:block;font:600 22pt/1.05 'Cormorant Garamond',Georgia,serif;color:#1B2A4A}.tiles span{display:block}.tiles small{color:#86652f;font-size:8.5pt}
.chart{width:100%;height:auto;display:block;margin:6px 0;break-inside:avoid}
.chart .lab{font:9pt 'IBM Plex Sans';fill:#1c2436}.chart .val{font:600 9pt 'IBM Plex Sans';fill:#1c2436}
.chart .bar{fill:#B08A4E}.chart .mark{fill:#1B2A4A}.chart .s0{fill:#1B2A4A}.chart .s1{fill:#B08A4E}.chart .s2{fill:#CFC3AA}
.key span{display:inline-block;width:14px;height:9px;margin:0 5px 0 12px;vertical-align:baseline}.key span:first-child{margin-left:0}.k-bar{background:#B08A4E}.k-mark{background:#1B2A4A;width:3px!important}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px}.skill{break-inside:avoid}
table{width:100%;border-collapse:collapse;font-size:8.8pt;margin:8px 0}th{text-align:left;font-weight:600;color:#5d6475;border-bottom:1.5px solid #CFC3AA;padding:5px 6px}
td{border-bottom:1px solid #E0D7C4;padding:5px 6px;vertical-align:top}tr{break-inside:avoid}
table.ads td:nth-child(n+2):nth-child(-n+6){text-align:right;white-space:nowrap}.ads .t{font-weight:500}.ads .sub{color:#5d6475;font-size:8pt}
.yes{color:#1d6a48;font-weight:700}.no{color:#9b2c2c;font-weight:700}
.advice{background:#FAF6EE;border-left:3px solid #B08A4E;padding:10px 16px;margin:12px 0;break-inside:avoid}.advice h3{margin-top:0}
.method li{margin:3px 0}
.keep{break-inside:avoid}
.tw{overflow-x:auto}
/* On screen (phone or browser): a readable column instead of A4 pages */
@media screen{
  body{max-width:880px;margin:0 auto;padding:20px 16px 40px;font-size:15px}
  .cover{min-height:0;margin-bottom:10px}.cover .eyebrow{margin-top:24px}
  .sample{position:fixed;font-size:44px}
}
@media screen and (max-width:640px){
  h1{font-size:28px}h2{font-size:22px}
  .tiles{grid-template-columns:1fr 1fr}.tiles b{font-size:24px}
  .two{grid-template-columns:1fr}
  table{font-size:12px}table.ads{min-width:620px}
}
</style></head><body>
${SAMPLE ? '<div class="sample">SAMPLE DATA</div>' : ''}
<section class="cover">
<div class="logo">${logo}</div>
<p class="eyebrow">${INST ? 'University report' : 'Sector report'} · Doctum Observatory</p>
<h1>${esc(title)}</h1>
<p class="period">${esc(PERIOD)}${SAMPLE ? ' · <strong>sample figures for layout only</strong>' : ''}</p>
${S.findings.length ? `<div class="findings"><h2>Key findings</h2><ul>${S.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
${S.glance}
<p class="foot">Doctum lists PhD opportunities collected from UK university websites and matches them to applicants’ CVs. This report contains anonymous totals only: no individual can be identified, and any group smaller than ${K} is not shown. Prepared ${esc(fmtDate(new Date()))} · doctum.co.uk · hello@doctum.co.uk</p>
</section>
${S.funnel}${S.adverts}${S.sources}${S.reach}${S.demand}${S.skillsSec}${S.termsSec}
<h2>About this report</h2><ul class="method small">
<li><strong>Period:</strong> ${esc(PERIOD)} (ISO weeks ${esc(FROM)} to ${esc(TO)}).</li>
<li><strong>Advert figures</strong> count events on Doctum: appearing in an applicant’s CV match results, page views, opening the full advert, clicking through to the university’s page, saving to a shortlist and requesting a preparation pack. The median advert is across all universities listed on Doctum in the same period.</li>
<li><strong>Applicant figures</strong> come from Doctum’s CV match. Fee status and subject choices come from the form; degree, first-degree subject and country only from applicants who ticked “Count me in”. CVs are never stored.</li>
<li><strong>Privacy:</strong> Doctum stores no identifiers (no IP address, cookie or account) with these counts, and any group smaller than ${K} is withheld. See doctum.co.uk/privacy.</li>
<li><strong>Coverage:</strong> ${n(OPEN.length)} open PhDs at ${new Set(OPEN.map((r) => r.institution)).size} UK universities were listed at the time of writing.</li>
</ul></body></html>`;
}

function findBrowser() {
  const c = process.platform === 'win32' ? [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : [process.env.CHROME_PATH || '', '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return c.find((p) => p && fs.existsSync(p));
}

// ── run ───────────────────────────────────────────────────────────────
const D = SAMPLE ? sampleData() : await liveData();
const html = page(build(D));
const slug = (INST || 'uk-sector').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dir = path.join(ROOT, 'reports', 'university', `${slug}_${FROM}_${TO}${SAMPLE ? '_SAMPLE' : ''}`);
fs.mkdirSync(dir, { recursive: true });
const htmlPath = path.join(dir, 'report.html');
fs.writeFileSync(htmlPath, html);
console.log('wrote', htmlPath);
if (!flag('no-pdf')) {
  const browser = findBrowser();
  if (!browser) console.log('No Edge or Chrome found: open report.html in a browser and choose Print > Save as PDF.');
  else {
    const pdf = path.join(dir, 'report.pdf');
    try { fs.rmSync(pdf, { force: true }); } catch { /* open in a viewer: overwritten below if possible */ }
    // Headless printing uses its own temporary profile, so an open Edge window isn't disturbed.
    // If that doesn't produce a file, try once more with a dedicated profile folder.
    const base = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
    const prof = path.join(os.homedir(), '.doctum', 'pdf-profile');
    let r;
    for (const extra of [[], [`--user-data-dir=${prof}`]]) {
      r = spawnSync(browser, [...base, ...extra, `--print-to-pdf=${pdf}`, pathToFileURL(htmlPath).href], { timeout: 60000, stdio: 'ignore' });
      if (fs.existsSync(pdf) && fs.statSync(pdf).size > 1000) break;
    }
    console.log(fs.existsSync(pdf) ? 'wrote ' + pdf : 'PDF printing did not work on this PC. Open report.html in Edge or Chrome and choose Print > Save as PDF (tick "Background graphics").');
  }
}
if (flag('open') && process.platform === 'win32') spawnSync('explorer.exe', [dir], { stdio: 'ignore' }); // explorer exits 1 even on success
