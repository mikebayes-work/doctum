// scripts/insights-report.mjs — download every insights report as CSV files.
//
//   Windows (Command Prompt):
//     set INSIGHTS_ADMIN_KEY=<the key from Netlify>
//     node scripts/insights-report.mjs 2026-W45 2026-W52
//   Optional: a university's own advert report:
//     node scripts/insights-report.mjs 2026-W45 2026-W52 "Cranfield University"
//
// Writes reports/insights/<from>_<to>/*.csv (reports/ is gitignored: these are
// commercial files, not website content). Every applicant figure under 10 is
// already suppressed by the server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [from = '', to = '', inst = ''] = process.argv.slice(2);
import os from 'node:os';
const KEY_FILE = path.join(os.homedir(), '.doctum', 'insights-key.txt'); // saved by DoctumReports.exe
const key = (process.env.INSIGHTS_ADMIN_KEY || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8') : '')).trim(); // Command Prompt keeps trailing spaces
const site = (process.env.SITE_URL || 'https://doctum.co.uk').replace(/\/+$/, '');
if (!key) { console.error('No key: run DoctumReports.exe once to save it, or set INSIGHTS_ADMIN_KEY.'); process.exit(1); }

const jobs = [
  ['summary'], ['terms'], ['filters'], ['demand'], ['skills'], ['listings'],
  ['applicants', 'd,ug'], ['applicants', 'd,fdc'], ['applicants', 'd,lvl,cls'], ['applicants', 'd,fee'], ['applicants', 'ug,fdc'],
  ['applicants', 'd,pub'], ['applicants', 'd,proj'], ['applicants', 'd,ind'], ['search', 'd,f'], ['search', 'd,c'],
];
jobs.push(['sources'], ['matched', 'ug'], ['matched', 'fee']);
if (inst) jobs.push(['listings', '', inst], ['sources', '', inst], ['matched', 'ug', inst], ['matched', 'fee', inst], ['matched', 'fdc', inst], ['matched', 'lvl', inst]);

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'insights', `${from || 'start'}_${to || 'now'}`);
fs.mkdirSync(dir, { recursive: true });
for (const [report, dims = '', i = ''] of jobs) {
  const u = new URL('/api/insights', site);
  u.searchParams.set('report', report); u.searchParams.set('format', 'csv');
  if (from) u.searchParams.set('from', from); if (to) u.searchParams.set('to', to);
  if (dims) u.searchParams.set('dims', dims); if (i) u.searchParams.set('inst', i);
  const res = await fetch(u, { headers: { 'x-doctum-admin': key } });
  const name = [report, dims.replace(/,/g, '-'), i && i.replace(/[^a-z0-9]+/gi, '-')].filter(Boolean).join('_') + '.csv';
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const why = res.status !== 404 ? '' : /<html/i.test(body)
      ? ' (the reports function is not deployed: site returned its normal "Page not found" page)'
      : ' (the function is live but rejected the key: not set in Netlify, set after the last deploy, or different from the one here)';
    console.log(`${name}: HTTP ${res.status}${why}`);
    if (res.status === 404) { console.log(`Key used here: ${key.length} characters, starts ${key.slice(0, 4)}…, ends …${key.slice(-4)}`); break; }
    continue;
  }
  fs.writeFileSync(path.join(dir, name), await res.text());
  console.log('wrote', name);
}
console.log('Reports in', dir);
