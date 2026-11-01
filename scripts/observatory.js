// scripts/observatory.js — /observatory/: Doctum Observatory, a live tracker of the UK PhD market.
//
// Supply side: what the market is actually advertising, measured from every open advert, refreshed after every scrape.
// Public and citable (Dataset JSON-LD), so it serves students, journalists, AI
// assistants and the universities themselves.
//
// Inputs: the open listings (from listings.json) and data/observatory.json, the dated
// snapshots written by scraper/observatory.py. Everything is drawn as plain HTML/SVG at
// build time: no chart library, no client script (the CSP allows none inline).

const fs = require('fs');
const path = require('path');

const UKRI = { year: '2026/27', min: 21805, london: 23805 }; // UKRI minimum stipend from 1 Oct 2026

function readSnapshots(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'data', 'observatory.json'), 'utf8')); } catch { return null; }
}

function observatoryBody({ open, today, updated, esc, n, money, ukDate, slugify, cardList, root }) {
  const pulse = readSnapshots(root); // { started, snapshots }
  const snaps = (pulse && pulse.snapshots) || [];
  const last = snaps[snaps.length - 1] || null;
  const total = open.length || 1;
  const pct = (x, of = total) => Math.round((100 * x) / (of || 1));
  const instSlug = (x) => slugify(x.replace(/^University of /i, '').replace(/ University$/i, ''));

  // ── Figures ──
  const funded = open.filter((r) => r.funding === 'Fully funded');
  const intl = open.filter((r) => r.eligibility === 'UK & International' && r.funding !== 'Self-funded');
  const soon = open.filter((r) => r.deadline && (Date.parse(r.deadline) - Date.parse(today)) / 864e5 <= 30);
  const st = open.map((r) => r.stipend).filter((s) => s >= 12000 && s <= 45000).sort((a, b) => a - b);
  const median = st.length ? st[Math.floor((st.length - 1) / 2)] : null;
  const atLeastUkri = st.filter((s) => s >= UKRI.min).length;
  const insts = new Set(open.map((r) => r.institution));


  // ── Bar list: one hue, value labelled, title attribute as the hover tooltip ──
  const bars = (rows, { of, fmt = (v) => n(v), href, note } = {}) => {
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const two = rows.some((r) => r[2] != null);
    return `<ul class="pbars${two ? ' two' : ''}">${rows.map(([label, v, sub]) => {
      const w = (100 * v) / max, ws = sub != null ? (100 * sub) / max : null;
      const share = of ? ` (${pct(v, of)}%)` : '';
      const tip = `${label}: ${fmt(v)}${share}${sub != null ? `, of which ${n(sub)} fully funded` : ''}`;
      return `<li title="${esc(tip)}"><span class="pl">${href ? `<a href="${esc(href(label))}">${esc(label)}</a>` : esc(label)}</span>` +
        // SVG attributes, not inline styles: the site's CSP (style-src 'self') blocks style="…".
        `<svg class="pb" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true"><rect class="pb-all" x="0" y="0" height="14" width="${Math.max(0.6, w).toFixed(1)}"/>${ws != null ? `<rect class="pb-ff" x="0" y="3" height="8" width="${Math.max(ws ? 0.6 : 0, ws).toFixed(1)}"/>` : ''}</svg>` +
        `<span class="pv">${fmt(v)}${of ? `<small>${pct(v, of)}%</small>` : ''}</span></li>`;
    }).join('')}</ul>${note ? `<p class="small">${note}</p>` : ''}`;
  };
  const tally = (vals) => { const c = new Map(); for (const v of vals) c.set(v, (c.get(v) || 0) + 1); return [...c]; };

  // Widening participation: places set aside for under-represented applicants (ring-fenced), and
  // adverts that particularly encourage them. Read from the advert wording (scraper/extract.py get_wp).
  const wpRing = open.filter((r) => r.wp === 'ring-fenced');
  const wpEnc = open.filter((r) => r.wp === 'encouraged');
  const wpGroups = tally(wpRing.concat(wpEnc).flatMap((r) => r.wp_groups || [])).sort((a, b) => b[1] - a[1])
    .map(([g, c]) => [g, c, wpRing.filter((r) => (r.wp_groups || []).includes(g)).length]);

  const FUND = ['Fully funded', 'Competition funded', 'Partially funded', 'Self-funded', 'Unknown'];
  const fundRows = FUND.map((f) => [f === 'Unknown' ? 'Not stated in advert' : f, open.filter((r) => r.funding === f).length]).filter((r) => r[1]);
  const ELIG = { 'UK & International': 'Open to international applicants', 'UK/Home only': 'UK (Home) fee status only', 'Open to all (self-funded)': 'Anyone (self-funded)', 'Not stated': 'Not stated in advert' };
  const eligRows = tally(open.map((r) => ELIG[r.eligibility] || 'Not stated in advert')).sort((a, b) => b[1] - a[1]);

  // Deadlines by month, next six months, plus rolling / not stated
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 + i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const mLabel = (ym) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dlRows = months.map((m) => [mLabel(m), open.filter((r) => (r.deadline || '').startsWith(m)).length]);
  const later = open.filter((r) => r.deadline && r.deadline.slice(0, 7) > months[5]).length;
  const rolling = open.filter((r) => !r.deadline).length;
  if (later) dlRows.push(['Later', later]);
  dlRows.push(['Open until filled / not stated', rolling]);

  // Subjects: open, with the fully funded part drawn as a darker inner bar
  const discs = tally(open.flatMap((r) => r.disciplines || [])).filter(([d]) => !/^Other/.test(d)).sort((a, b) => b[1] - a[1])
    .map(([d, c]) => [d, c, open.filter((r) => r.funding === 'Fully funded' && (r.disciplines || []).includes(d)).length]);

  // Stipend bands around the UKRI minimum
  const bands = [
    ['Below £20,000', (s) => s < 20000],
    [`£20,000 to ${money(UKRI.min - 1)}`, (s) => s >= 20000 && s < UKRI.min],
    [`${money(UKRI.min)} (UKRI minimum) to £22,999`, (s) => s >= UKRI.min && s < 23000],
    ['£23,000 to £24,999', (s) => s >= 23000 && s < 25000],
    ['£25,000 or more', (s) => s >= 25000],
  ].map(([l, f]) => [l, st.filter(f).length]);

  const regions = tally(open.map((r) => r.region || 'Not stated')).sort((a, b) => b[1] - a[1]);
  const uniFunded = tally(funded.map((r) => r.institution)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);

  // What adverts actually tell applicants
  const has = (f) => open.filter(f).length;
  const disclosure = [
    ['States a deadline date', has((r) => r.deadline)],
    ['Says who can apply (fee status)', has((r) => r.eligibility && r.eligibility !== 'Not stated')],
    ['States the funding clearly', has((r) => r.funding && r.funding !== 'Unknown')],
    ['Names a supervisor', has((r) => (r.supervisors || []).length)],
    ['States a start date', has((r) => r.start)],
    ['States the stipend as a figure', has((r) => r.stipend)],
  ].sort((a, b) => b[1] - a[1]);

  // ── Trend (needs at least three snapshots to be worth drawing) ──
  const trend = (() => {
    if (snaps.length < 3) {
      return `<p class="pulse-wait">Tracking began on ${esc(ukDate(pulse ? pulse.started : today))}. The trend chart appears once there are a few updates to compare (Doctum checks every Tuesday and Friday).</p>`;
    }
    const W = 720, H = 220, L = 44, R = 12, T = 12, B = 28;
    const xs = (i) => L + (i * (W - L - R)) / Math.max(1, snaps.length - 1);
    const ymax = Math.ceil(Math.max(...snaps.map((s) => s.open)) / 100) * 100 || 100;
    const ys = (v) => T + (H - T - B) * (1 - v / ymax);
    const line = (k) => snaps.map((s, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(s[k]).toFixed(1)}`).join('');
    const ticks = [0, ymax / 2, ymax];
    const lab = (s) => new Date(s.date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const pts = (k) => snaps.map((s, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(s[k]).toFixed(1)}" r="6" class="hit"><title>${lab(s)}: ${n(s[k])} ${k === 'open' ? 'open' : 'fully funded'}</title></circle>`).join('');
    const end = (k, cls, text) => `<text x="${(xs(snaps.length - 1) - 4).toFixed(1)}" y="${(ys(snaps[snaps.length - 1][k]) - 8).toFixed(1)}" text-anchor="end" class="${cls}">${text}</text>`;
    return `<figure class="ptrend"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Open and fully funded PhDs at each update since ${esc(ukDate(snaps[0].date))}">
${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${ys(t)}" y2="${ys(t)}" class="grid"/><text x="${L - 6}" y="${ys(t) + 4}" text-anchor="end" class="ax">${n(t)}</text>`).join('')}
<text x="${L}" y="${H - 6}" class="ax">${lab(snaps[0])}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="ax">${lab(snaps[snaps.length - 1])}</text>
<path d="${line('open')}" class="l-open"/><path d="${line('funded')}" class="l-funded"/>${pts('open')}${pts('funded')}
${end('open', 'lbl', 'Open')}${end('funded', 'lbl', 'Fully funded')}
</svg><figcaption><span class="key key-open"></span>Open PhDs <span class="key key-funded"></span>Fully funded</figcaption></figure>
<details class="ptable"><summary>Show as a table</summary><div class="table-wrap"><table><thead><tr><th>Update</th><th>Open</th><th>Fully funded</th><th>Open to international</th><th>New in the week</th><th>Universities</th></tr></thead><tbody>${snaps.slice().reverse().map((s) => `<tr><td>${esc(ukDate(s.date))}</td><td>${n(s.open)}</td><td>${n(s.funded)}</td><td>${n(s.intl)}</td><td>${n(s.new_7d)}</td><td>${s.universities}</td></tr>`).join('')}</tbody></table></div></details>`;
  })();

  // ── New this week ──
  const byId = new Map(open.map((r) => [r.id, r]));
  const fresh = ((last && last.new_ids) || []).map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (b.funding === 'Fully funded') - (a.funding === 'Fully funded') || (a.deadline || '9999').localeCompare(b.deadline || '9999'));

  const tiles = [
    [n(open.length), 'open PhDs', `at ${insts.size} universities`],
    [`${pct(funded.length)}%`, 'fully funded', `${n(funded.length)} adverts`],
    [n(intl.length), 'funded PhDs open to international applicants', `${pct(intl.length)}% of open PhDs`],
    [median ? money(median) : 'n/a', 'median advertised stipend', `UKRI minimum ${money(UKRI.min)}`],
    [n(soon.length), 'close in the next 30 days', '<a href="/closing-soon/">See them</a>'],
    [last ? n(last.new_7d) : '…', 'new adverts in the last 7 days', last ? `${n(last.closed_7d)} closed, ${n(last.changed_7d)} updated${snaps.length < 3 ? ` · counted from ${esc(ukDate(pulse.started))}` : ''}` : 'tracking starts with the next update'],
  ];

  // ── History (sector totals only; per-advert history is never published) ──
  const historyHtml = (() => {
    const hn = last ? last.time_on_market_n || 0 : 0;
    if (!last || hn < 30) {
      return `<p class="pulse-wait">Doctum started recording each advert's history on 1 November 2026: when it first appears, when its deadline moves, when it closes and whether the same project is advertised again. Figures appear here once at least 30 adverts have run their full course.</p>`;
    }
    return `<div class="ptiles">${[
      [`${n(last.time_on_market_median)} days`, 'median time an advert stays open', `from ${n(hn)} adverts that closed in the last 90 days`],
      [n(last.readvertised_30d || 0), 're-advertised in the last 30 days', 'the same project advertised again after closing'],
      [n(last.deadline_extended_30d || 0), 'deadlines extended in the last 30 days', 'a later closing date on the same advert'],
    ].map(([v, l, sub]) => `<div><b>${v}</b><span>${l}</span><small>${sub}</small></div>`).join('')}</div>`;
  })();

  const html = `
<p class="eyebrow pulse-eyebrow">Doctum Observatory · updated ${esc(updated)}</p>
<h1>The UK PhD market, measured</h1>
<p class="lead">Live figures from every open PhD advert Doctum tracks on UK university websites: how many there are, how many are funded, who can apply, what they pay and when they close. Refreshed every Tuesday and Friday.</p>
<div class="ptiles">${tiles.map(([v, l, s]) => `<div><b>${v}</b><span>${l}</span><small>${s}</small></div>`).join('')}</div>

<nav class="toc" aria-label="On this page"><a href="#trend">Trend</a><a href="#funding">Funding</a><a href="#who">Who can apply</a><a href="#deadlines">Deadlines</a><a href="#subjects">Subjects</a><a href="#stipends">Stipends</a><a href="#adverts">What adverts tell you</a><a href="#universities">Universities</a><a href="#access">Under-represented applicants</a><a href="#history">Time on market</a><a href="#method">Method</a></nav>

<section id="trend"><h2>Open PhDs over time</h2>${trend}</section>

${fresh.length ? `<section id="new"><h2>New this week</h2><p class="small">Adverts that appeared on university websites in the last seven days. Fully funded first.</p>${cardList(fresh.slice(0, 12), today)}${fresh.length > 12 ? `<p><a href="/?sort=newest">See all ${n(fresh.length)} new PhDs</a></p>` : ''}</section>` : ''}

<div class="pgrid">
<section id="funding"><h2>Funding</h2>${bars(fundRows, { of: total, note: '“Competition funded” means candidates compete for a limited number of awards. <a href="/guides/fully-funded-vs-competition-funded-phd/">What the funding labels mean</a>.' })}</section>
<section id="who"><h2>Who can apply</h2>${bars(eligRows, { of: total, note: `Many adverts don't say. Of the funded and competition-funded PhDs, ${n(intl.length)} state that international applicants are eligible. <a href="/funded-phds-international-students/">See them</a>.` })}</section>
</div>

<section id="deadlines"><h2>Deadlines</h2>${bars(dlRows, { of: total, note: 'Open PhDs by the month their application deadline falls in. “Open until filled” adverts usually close as soon as a suitable candidate is found, so apply early.' })}</section>

<section id="subjects"><h2>By subject</h2>
<p class="pkey"><span class="key key-open"></span>All open PhDs <span class="key key-funded"></span>of which fully funded</p>
${bars(discs, { href: (d) => `/subjects/${slugify(d)}/`, note: 'An advert can count in more than one subject.' })}</section>

<div class="pgrid">
<section id="stipends"><h2>Stipends</h2>
<p>${n(st.length)} open adverts (${pct(st.length)}%) state the stipend as a figure. Their median is <strong>${median ? money(median) : 'n/a'}</strong> a year, and ${pct(atLeastUkri, st.length)}% are at or above the UKRI minimum for ${UKRI.year} (${money(UKRI.min)}, or ${money(UKRI.london)} in London).</p>
${bars(bands, { of: st.length || 1, note: 'Stipends are usually tax-free. Adverts that say only “UKRI rate” are not counted here. <a href="/data/uk-phd-stipends/">Stipends by university</a>.' })}</section>
<section id="adverts"><h2>What adverts tell you</h2>
<p>The share of open adverts that state each detail an applicant needs.</p>
${bars(disclosure, { of: total, note: 'Measured from the advert text Doctum reads on the university page. A missing detail is worth asking the department about before you apply.' })}</section>
</div>

<div class="pgrid">
<section id="universities"><h2>Most fully funded PhDs open</h2>${bars(uniFunded, { href: (u) => `/universities/${instSlug(u)}/` })}</section>
<section id="regions"><h2>By nation</h2>${bars(regions, { of: total })}</section>
</div>

<section id="access"><h2>Places for under-represented applicants</h2>
<p><strong>${n(wpRing.length)}</strong> open adverts set places aside for applicants from under-represented groups (for example scholarships ring-fenced for Black British applicants, or for applicants who meet widening participation criteria). A further <strong>${n(wpEnc.length)}</strong> particularly encourage applications from under-represented groups but are open to everyone.${wpRing.length ? ` <a href="/widening-participation-phds/">See the ring-fenced places</a>.` : ''}</p>
${wpGroups.length ? `<p class="pkey"><span class="key key-open"></span>Ring-fenced or encouraging <span class="key key-funded"></span>of which ring-fenced</p>${bars(wpGroups, { note: 'Groups as named in the advert. An advert can name more than one. Many universities run widening participation schemes that are advertised centrally rather than on each project, so these figures are a floor, not a total.' })}` : ''}</section>

<section id="history"><h2>How long adverts stay open</h2>${historyHtml}</section>

<section id="method"><h2>How the Observatory is measured</h2>
<ul>
<li><strong>Source.</strong> Every figure comes from PhD adverts Doctum reads directly on UK university websites, currently ${insts.size} universities. Doctum checks them every Tuesday and Friday and takes a dated snapshot after each check.</li>
<li><strong>Open</strong> means the advert is still on the university's site and its deadline (if it has one) has not passed. Adverts Doctum hasn't been able to re-check for three weeks are left out.</li>
<li><strong>New</strong> means new on the university's website, not new to Doctum. When a university is added to Doctum, or its pages are read more completely, the adverts found that way are not counted as new.</li>
<li><strong>Funding and eligibility</strong> are read from the advert wording. Where an advert doesn't say, it is counted as “not stated”, never guessed.</li>
<li><strong>Ring-fenced places</strong> are adverts whose wording sets the place aside for a group (only available to, reserved for, must self-identify as). Adverts that only say they welcome applications from under-represented groups are counted separately.</li>
<li><strong>Time on market</strong> runs from the day Doctum first sees an advert to the day its deadline passes or it is taken down. Adverts that were already on a university's site when Doctum started reading it are left out, because their real start date is unknown. A project advertised again after closing is counted as re-advertised.</li>
<li><strong>Coverage.</strong> Some universities publish funded projects only on paid listing sites, not on their own pages. The Observatory describes the adverts on university websites, so it is a large sample of the UK market rather than every PhD.</li>
</ul>
<p class="small">You are welcome to quote and cite the Doctum Observatory. Please link to this page and give the date. UKRI stipend rates from <a href="https://www.ukri.org/apply-for-funding/studentships-and-doctoral-training/get-a-studentship-to-fund-your-doctorate/" rel="noopener">UKRI</a>.</p>
</section>`;

  const description = `Doctum Observatory, ${updated}: ${n(open.length)} open UK PhDs at ${insts.size} universities, ${pct(funded.length)}% fully funded, median advertised stipend ${median ? money(median) : 'n/a'}. Funding, eligibility, deadlines and stipends, updated twice a week.`;
  return { html, description, summary: { open: open.length, funded: funded.length, median, universities: insts.size } };
}

module.exports = { observatoryBody };
