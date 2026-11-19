// scripts/programmes.js — /doctoral-training/: what DTPs, CDTs and DLAs are, which ones are
// recruiting now, and the open adverts that belong to each.
//
// Input: data/programmes.json (hand-checked facts about each programme, plus the patterns
// that tie an advert to it) and the open listings. An advert belongs to a programme when
// one of its patterns appears in the advert's title, summary or the opening of its
// description (or anywhere in the description, for programmes marked "anywhere").
// Programmes with at least one open advert get their own page; the rest are listed on
// the hub with a link to their own site, so there are no empty pages for search engines.

const fs = require('fs');
const path = require('path');

const UKRI = { year: '2026/27', min: 21805 }; // UKRI minimum stipend from 1 Oct 2026 (same figure as observatory.js)
const TYPE_NAME = { DTP: 'Doctoral Training Partnership', CDT: 'Centre for Doctoral Training', DLA: 'Doctoral Landscape Award' };
const EARLY = 500; // characters of the description searched for programmes not marked "anywhere"

function loadProgrammes(root) {
  const file = path.join(root, 'data', 'programmes.json');
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const seen = new Set();
  return (raw.programmes || []).map((p) => {
    if (!/^[a-z0-9-]+$/.test(p.id || '')) throw new Error(`data/programmes.json: bad id ${JSON.stringify(p.id)}`);
    if (seen.has(p.id)) throw new Error(`data/programmes.json: duplicate id ${p.id}`);
    seen.add(p.id);
    if (!TYPE_NAME[p.type]) throw new Error(`data/programmes.json: ${p.id} has type ${JSON.stringify(p.type)} (use DTP, CDT or DLA)`);
    if (p.website && !/^https:\/\//.test(p.website)) throw new Error(`data/programmes.json: ${p.id} website must start https://`);
    const res = [...(p.match || []).map((s) => new RegExp(s)), ...(p.match_i || []).map((s) => new RegExp(s, 'i'))];
    if (!res.length) throw new Error(`data/programmes.json: ${p.id} has no match patterns`);
    return { ...p, res, list: [] };
  });
}

// Fills p.list for each programme and returns Map(listing id -> [programmes]).
function matchProgrammes(progs, open) {
  const byListing = new Map();
  for (const r of open) {
    const early = [r.title, r.summary, r.programme, (r.description || '').slice(0, EARLY)].filter(Boolean).join('\n');
    const full = early + '\n' + (r.description || '');
    for (const p of progs) {
      const text = p.anywhere ? full : early;
      if (p.res.some((re) => re.test(text))) {
        p.list.push(r);
        if (!byListing.has(r.id)) byListing.set(r.id, []);
        byListing.get(r.id).push(p);
      }
    }
  }
  return byListing;
}

const progPath = (p) => `/doctoral-training/${p.id}/`;

function explainer({ esc, n, live, liveAdverts }) {
  return `<div class="prose dtp-explainer">
<h2>What is doctoral training?</h2>
<p>Most funded PhDs in the UK are paid for by UK Research and Innovation (UKRI) through its seven research councils, such as EPSRC for engineering and physical sciences, ESRC for social sciences and AHRC for arts and humanities. Rather than fund PhDs one at a time, the councils give large grants to groups of universities, which then recruit a cohort of PhD students each year and train them together. These groups are called doctoral training programmes.</p>
<h3>Doctoral Training Partnerships (DTPs)</h3>
<p>A DTP is a partnership of several universities, sometimes with research institutes, covering a broad subject area such as biosciences, environmental science or social science. Students apply either to a specific advertised project or to the partnership's open competition with their own proposal. A DTP usually offers a wide choice of projects and supervisors across its partners.</p>
<h3>Centres for Doctoral Training (CDTs)</h3>
<p>A CDT focuses on one specific topic, such as net zero infrastructure, artificial intelligence or defence systems. CDTs train their students as a cohort, often with a taught first year (an MRes or integrated PhD), and many work closely with industry partners who co-fund or co-supervise projects. Some pay a higher stipend than the UKRI minimum.</p>
<h3>Doctoral Landscape Awards and Focal Awards</h3>
<p>Since 2024 UKRI has funded its new doctoral training through Doctoral Landscape Awards, which work much like DTPs, and Doctoral Focal Awards, which work much like CDTs. Many programmes have kept their DTP or CDT names, so you will see both sets of terms in adverts.</p>
<h2>What the funding covers</h2>
<p>A UKRI-funded studentship normally pays your tuition fees and a tax-free stipend for living costs. The UKRI minimum stipend for ${esc(UKRI.year)} is £${n(UKRI.min)} a year, and most programmes also give a budget for research and training costs. Studentships usually last three and a half to four years. Many are open to international applicants as well as UK students, but places for international students can be limited, so check each advert.</p>
<h2>How to apply</h2>
<p>Each programme runs its own recruitment, usually with one main deadline in the winter for a start the following October. Read the programme's own website for its process, then apply to the project or competition through the route it gives. On Doctum you can see which open adverts belong to each programme below; every advert links to the university's own page.</p>
<p class="small">Doctum currently links ${n(liveAdverts)} open adverts to ${n(live)} programmes. Adverts are linked when they name the programme; some programme adverts don't, so always check the programme's own site as well.</p>
</div>`;
}

function directory({ esc, n, live, idle }) {
  const fund = (p) => (p.funder || []).join(', ');
  const rows = live.map((p) => `<tr><td><a href="${progPath(p)}">${esc(p.short)}</a><br><span class="small">${esc(p.name)}</span></td><td>${esc(p.type)}</td><td>${esc(fund(p)) || '<span class="small">Not stated</span>'}</td><td class="num">${n(p.list.length)}</td></tr>`).join('');
  const others = idle.map((p) => `<li>${p.website ? `<a href="${esc(p.website)}" rel="noopener" target="_blank">${esc(p.short)} ↗</a>` : `<strong>${esc(p.short)}</strong>`} <span class="small">${esc(p.type)}${fund(p) ? ' · ' + esc(fund(p)) : ''}${p.short !== p.name ? ' · ' + esc(p.name) : ''}</span></li>`).join('');
  return `<h2 id="recruiting">Programmes with open adverts on Doctum</h2>
<div class="table-wrap"><table class="data dtp-table"><thead><tr><th>Programme</th><th>Type</th><th>Funder</th><th class="num">Open</th></tr></thead><tbody>${rows}</tbody></table></div>
${idle.length ? `<h2 id="others">Other programmes</h2><p>Doctum doesn't have open adverts from these programmes right now. They may be between recruitment rounds, or advertise only on their own sites.</p><ul class="dtp-others">${others}</ul>` : ''}`;
}

function programmePage(p, { esc, n, cardList, today, updated }) {
  const funded = p.list.filter((r) => r.funding === 'Fully funded').length;
  const insts = [...new Set(p.list.map((r) => r.institution))].sort();
  const facts = [
    ['Type', `${esc(TYPE_NAME[p.type])} (${esc(p.type)})`],
    (p.funder || []).length && ['Funded by', esc(p.funder.join(', '))],
    (p.partners || []).length && ['Partners', esc(p.partners.join(', '))],
    (p.subjects || []).length && ['Subjects', esc(p.subjects.join(', '))],
    p.website && ['Website', `<a href="${esc(p.website)}" rel="noopener" target="_blank">${esc(p.website.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, ''))} ↗</a>`],
    ['Open adverts on Doctum', `${n(p.list.length)}${funded ? ` (${n(funded)} fully funded)` : ''} at ${insts.map(esc).join(', ')}`],
  ].filter(Boolean);
  const intro = `${p.about ? esc(p.about) + ' ' : ''}Doctum has ${n(p.list.length)} open advert${p.list.length === 1 ? '' : 's'} from the ${esc(p.short)}, sorted by deadline. Updated ${esc(updated)}.`;
  return {
    intro,
    body: `<h1>${esc(p.short)} PhDs</h1>
<p class="lead">${intro}</p>
<dl class="facts-list dtp-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
<p class="small">Facts on this page come from the programme's own site and adverts. Check the programme's site for its full list of projects and how to apply. <a href="/doctoral-training/">What is a ${esc(p.type)}?</a></p>
${cardList(p.list, today)}`,
  };
}

// Writes /doctoral-training/ and one page per live programme. Returns the live programmes.
function programmePages({ progs, shell, write, cardList, itemList, esc, n, today, updated, site, byDeadline }) {
  for (const p of progs) p.list.sort(byDeadline);
  const live = progs.filter((p) => p.list.length).sort((a, b) => b.list.length - a.list.length || a.short.localeCompare(b.short));
  const idle = progs.filter((p) => !p.list.length).sort((a, b) => a.short.localeCompare(b.short));
  const liveAdverts = new Set(live.flatMap((p) => p.list.map((r) => r.id))).size;
  const crumbs = [['/doctoral-training/', 'Doctoral training']];
  const faq = {
    '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [
      ['What is a Doctoral Training Partnership (DTP)?', 'A DTP is a group of universities, funded by a UKRI research council, that recruits and trains a cohort of funded PhD students each year across a broad subject area.'],
      ['What is a Centre for Doctoral Training (CDT)?', 'A CDT is a UKRI-funded centre that trains a cohort of PhD students on one specific topic, often with a taught first year and industry partners.'],
      ['What does a UKRI studentship pay?', `Tuition fees plus a tax-free stipend; the UKRI minimum stipend for ${UKRI.year} is £${UKRI.min.toLocaleString('en-GB')} a year.`],
    ].map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  write('/doctoral-training/', shell({
    path: '/doctoral-training/', title: 'Doctoral training programmes: DTPs and CDTs recruiting now | Doctum',
    description: `What DTPs, CDTs and Doctoral Landscape Awards are, what they pay, and ${n(live.length)} UK programmes with open PhD adverts on Doctum right now.`,
    crumbs, ld: [faq],
    body: `<h1>Doctoral training programmes</h1>
<p class="lead">Many funded UK PhDs are offered through Doctoral Training Partnerships (DTPs) and Centres for Doctoral Training (CDTs). Here is what they are, and ${n(live.length)} programmes with open adverts right now.</p>
<p><a href="#recruiting">Jump to the programmes →</a></p>
${explainer({ esc, n, live: live.length, liveAdverts })}
${directory({ esc, n, live, idle })}`,
  }), { priority: 0.8 });
  for (const p of live) {
    const pg = programmePage(p, { esc, n, cardList, today, updated });
    write(progPath(p), shell({
      path: progPath(p), title: `${p.short} PhDs | ${n(p.list.length)} open | Doctum`,
      description: pg.intro.slice(0, 300), crumbs: [...crumbs, [progPath(p), p.short]],
      ld: [itemList(site, p.list, `${p.short} PhDs`)], body: pg.body,
    }), { priority: 0.7 });
  }
  return live;
}

module.exports = { loadProgrammes, matchProgrammes, programmePages, progPath };
