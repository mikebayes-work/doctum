// scripts/pages.js — static, crawlable HTML built at deploy time.
//
// Carries over The Grid's 2026-10-30 SEO change (scripts/static-pages.js):
// every page a search engine or AI assistant should read is real HTML with its
// own <title>, description, canonical, Open Graph and JSON-LD. JavaScript only
// adds the interactive parts (search filters, CV match) on top.
//
// What the static pages publish: the public facts of each advert (title,
// university, funding, deadline, eligibility, a short excerpt, a link to the
// university's page). They are crawlable by design: that's the SEO trade-off.
// What they do NOT publish: the full database as a file, the full advert text
// in bulk, change history, the search/match logic or any prompts. Those stay
// in the edge functions.

const fs = require('fs');
const path = require('path');
const { explainerBody } = require('./explainer.js');
const { recommended } = require('./recommended.js');
const { observatoryBody } = require('./observatory.js');
const COUNTRIES = [
  ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['IN', 'India'], ['CN', 'China'], ['PK', 'Pakistan'], ['NG', 'Nigeria'], ['GH', 'Ghana'], ['KE', 'Kenya'],
  ['EG', 'Egypt'], ['SA', 'Saudi Arabia'], ['AE', 'United Arab Emirates'], ['IR', 'Iran'], ['TR', 'Turkey'], ['BD', 'Bangladesh'], ['LK', 'Sri Lanka'],
  ['NP', 'Nepal'], ['MY', 'Malaysia'], ['SG', 'Singapore'], ['ID', 'Indonesia'], ['VN', 'Vietnam'], ['TH', 'Thailand'], ['HK', 'Hong Kong'], ['TW', 'Taiwan'],
  ['JP', 'Japan'], ['KR', 'South Korea'], ['US', 'United States'], ['CA', 'Canada'], ['MX', 'Mexico'], ['BR', 'Brazil'], ['CO', 'Colombia'], ['CL', 'Chile'],
  ['AU', 'Australia'], ['NZ', 'New Zealand'], ['ZA', 'South Africa'], ['DE', 'Germany'], ['FR', 'France'], ['IT', 'Italy'], ['ES', 'Spain'], ['PT', 'Portugal'],
  ['NL', 'Netherlands'], ['GR', 'Greece'], ['CY', 'Cyprus'], ['PL', 'Poland'], ['RO', 'Romania'], ['SE', 'Sweden'],
]; // keep in step with netlify/doctum/facets.js COUNTRIES

// ── Helpers ──────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const ukDate = (iso) => {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? String(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const n = (x) => Number(x).toLocaleString('en-GB');
const money = (x) => '£' + n(Math.round(x));
const days = (iso, today) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
const trimWords = (s, max) => {
  const w = String(s || '').replace(/\s+/g, ' ').trim().split(' ');
  return w.length <= max ? w.join(' ') : w.slice(0, max).join(' ').replace(/[,;:.\-–]+$/, '') + '…';
};
const jsonld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

const ELIG = {
  'UK & International': 'Open to international',
  'UK/Home only': 'UK / Home fee status only',
  'Open to all (self-funded)': 'Anyone (self-funded)',
  'Not stated': 'Not stated',
};
const FUNDING_NOTE = {
  'Fully funded': 'Fully funded usually means tuition fees are paid and you receive a tax-free stipend for living costs. Check whether international fees are covered.',
  'Competition funded': 'Competition funded means the project can be funded, but candidates compete for a limited number of awards, often after shortlisting.',
  'Partially funded': 'Partially funded means some costs are covered (for example fees only). Check the advert for what you would need to pay.',
  'Self-funded': 'Self-funded means you pay tuition fees and living costs yourself, or bring your own scholarship or sponsor.',
  Unknown: 'The advert does not state the funding clearly. Check with the university before applying.',
};

// ── Page shell ───────────────────────────────────────────────────────
function makeShell(ctx) {
  const { site, index, gaId, builtAt, root } = ctx;
  // Cache-busting: each asset URL carries a hash of its contents, so a new deploy
  // never pairs fresh HTML with a stylesheet or script the browser cached earlier.
  const crypto = require('crypto');
  const ver = (f) => crypto.createHash('sha1').update(fs.readFileSync(path.join(root, 'public', f))).digest('hex').slice(0, 10);
  const A = (u) => u.startsWith('/assets/') ? `${u}?v=${ver(u.slice(1))}` : u;
  const nav = [
    ['/', 'Search'], ['/match/', 'CV match'], ['/subjects/', 'Subjects'],
    ['/universities/', 'Universities'], ['/phd-preparation-pack/', 'Prep packs'], ['/observatory/', 'Observatory'], ['/guides/', 'Guides'], ['/about/', 'About'],
  ];
  return function shell({ path: p, title, description, body, ld = [], noindex = false, scripts = [], ogType = 'website', crumbs }) {
    const url = site + p;
    const robots = !index || noindex ? 'noindex, follow' : 'index, follow, max-snippet:-1, max-image-preview:large';
    const crumbLd = crumbs ? [{
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [['/', 'Home'], ...crumbs].map(([u, name], i) => ({ '@type': 'ListItem', position: i + 1, name, item: site + u })),
    }] : [];
    const crumbHtml = crumbs ? `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${crumbs.map(([u, t], i) =>
      i === crumbs.length - 1 ? ` <span aria-hidden="true">›</span> <span aria-current="page">${esc(t)}</span>` : ` <span aria-hidden="true">›</span> <a href="${esc(u)}">${esc(t)}</a>`).join('')}</nav>` : '';
    return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="Doctum">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${site}/brand/og-image.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${site}/brand/og-image.png">
<meta name="theme-color" content="#1B2A4A">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="${A('/assets/site.css')}">
${[...crumbLd, ...ld].map(jsonld).join('\n')}
${gaId ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>\n<script src="${A('/assets/site.js')}" data-ga="${gaId}"></script>` : `<script src="${A('/assets/site.js')}" defer></script>`}
${scripts.map((s) => `<script src="${A(s)}" defer></script>`).join('\n')}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="/" aria-label="Doctum home">
      <img src="/brand/logo-nav-dark.svg" alt="Doctum" width="166" height="46">
      <span class="motto"><em lang="la">Fac te doctum</em><span class="motto-en">Make yourself learned</span></span>
    </a>
    <p class="engine">Powered by the <strong>Research Intelligence Engine</strong></p>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="sitenav">Menu</button>
    <nav id="sitenav" class="sitenav" aria-label="Main">${nav.map(([u, t]) => `<a href="${u}"${(u === '/' ? p === '/' : p.startsWith(u)) ? ' aria-current="page"' : ''}>${t}</a>`).join('')}</nav>
  </div>
</header>
<main id="main" class="wrap">
${crumbHtml}
${body}
</main>
<footer class="foot-site">
  <div class="wrap foot-in">
    <div>
      <img src="/brand/mark-dark.svg" alt="" width="36" height="36">
      <p><strong>Doctum</strong>: funded UK PhDs, matched to you. <span lang="la"><em>Fac te doctum</em></span>: make yourself learned.</p>
      <p class="small">Listings are collected from university websites and checked twice a week. Always confirm details on the university's own page before applying. Last updated ${esc(ukDate(builtAt))}.</p>
    </div>
    <nav aria-label="Footer">
      <a href="/fully-funded-phds/">Fully funded PhDs</a>
      <a href="/funded-phds-international-students/">PhDs open to international students</a>
      <a href="/closing-soon/">Closing soon</a>
      <a href="/phd-preparation-pack/">PhD preparation packs</a>
      <a href="/observatory/">Doctum Observatory: the UK PhD market</a>
      <a href="/data/uk-phd-stipends/">UK PhD stipend data</a>
      <a href="/about/">About and methodology</a>
      <a href="/privacy/">Privacy</a>
    </nav>
  </div>
</footer>
</body>
</html>
`;
  };
}

// ── Components ───────────────────────────────────────────────────────
function deadlineHtml(r, today) {
  if (!r.deadline) return r.deadline_text ? esc(trimWords(r.deadline_text, 8)) : 'Not stated';
  const d = days(r.deadline, today);
  const tag = d < 0 ? ' <span class="pill pill-closed">Closed</span>' : d <= 14 ? ` <span class="pill pill-soon">${d === 0 ? 'Today' : d + ' days left'}</span>` : '';
  return `<time datetime="${esc(r.deadline)}">${esc(ukDate(r.deadline))}</time>${tag}`;
}
function fundPill(f) {
  const cls = f === 'Fully funded' ? 'pill-full' : f === 'Competition funded' ? 'pill-comp' : f === 'Self-funded' ? 'pill-self' : 'pill-other';
  return `<span class="pill ${cls}">${esc(f || 'Unknown')}</span>`;
}
const shortInst = (i) => String(i || '').replace(/^University of /, '').replace(/ University$/, '').replace(/^Queen's University Belfast$/, "Queen's");
const ELIG_CHIP = { 'UK & International': 'Open to international', 'UK/Home only': 'UK / Home only' };
const FUND_CLS = { 'Fully funded': 'funded', 'Competition funded': 'comp', 'Self-funded': 'self' };
function closesChip(r, today) {
  if (!r.deadline) return r.deadline_text ? `<span class="chip">${esc(trimWords(r.deadline_text, 6))}</span>` : '';
  const d = days(r.deadline, today);
  const when = d < 0 ? 'Closed' : d === 0 ? 'closes today' : d === 1 ? '1 day' : `${d} days`;
  return `<span class="chip${d <= 14 ? ' urgent' : ''}">Closes <time datetime="${esc(r.deadline)}">${esc(ukDate(r.deadline))}</time> · ${when}</span>`;
}
// Rich result card. public/assets/search.js renders the same markup from /api/search.
function cardHtml(r, today) {
  const funded = r.funding === 'Fully funded';
  const disc = (r.disciplines || [])[0];
  const sup = (r.supervisors || []).slice(0, 3), fun = (r.funders || []).slice(0, 3);
  const foot = [sup.length && `Supervisor${sup.length > 1 ? 's' : ''}: ${esc(sup.join(', '))}`, fun.length && `Funder: ${esc(fun.join(', '))}`].filter(Boolean).join(' · ');
  return `<article class="card${funded ? ' is-funded' : ''}" data-id="${esc(r.id)}">
  <p class="meta"><strong>${esc(r.institution)}</strong>${r.school ? `<span>· ${esc(r.school)}</span>` : ''}${disc ? `<span>· ${esc(disc)}</span>` : ''}</p>
  <h3><a href="${esc(r.path)}">${esc(r.title)}</a></h3>
  <p class="chips"><span class="chip ${FUND_CLS[r.funding] || ''}">${esc(r.funding || 'Funding unknown')}</span>${r.stipend ? `<span class="chip money">${money(r.stipend)} / yr</span>` : ''}${closesChip(r, today)}${ELIG_CHIP[r.eligibility] ? `<span class="chip">${ELIG_CHIP[r.eligibility]}</span>` : ''}${r.programme ? `<span class="chip">${esc(trimWords(r.programme, 5))}</span>` : ''}${r.start ? `<span class="chip">Starts ${esc(trimWords(r.start, 4))}</span>` : ''}</p>
  ${r.summary ? `<p class="sum">${esc(trimWords(r.summary, 55))}</p>` : ''}
  <p class="more"><button type="button" class="btn-link" data-more="${esc(r.id)}">Read the full advert</button></p>
  <div class="foot"><span class="sup">${foot}</span><span class="actions"><a class="brief" href="/briefing/?id=${esc(r.id)}" rel="nofollow" title="PhD preparation pack: the key papers, research thread and interview prep for this PhD">Prep pack</a><button type="button" data-save="${esc(r.id)}" aria-pressed="false">Save</button><a class="go" href="${esc(r.url)}" rel="nofollow noopener" target="_blank">Apply at ${esc(shortInst(r.institution))} ↗</a></span></div>
</article>`;
}
const cardList = (list, today) => list.length ? `<div class="cards">${list.map((r) => cardHtml(r, today)).join('\n')}</div>` : '<p class="empty">No open listings right now. Check back after the next update.</p>';
const searchForm = (q = '') => `<form class="searchbar" action="/" method="get" role="search">
  <label class="sr" for="q">Search PhDs</label>
  <input id="q" name="q" type="search" value="${esc(q)}" placeholder="Topic, method or supervisor (e.g. tribology, hydrogen, Bayesian)" maxlength="120">
  <button type="submit">Search</button>
</form>`;
const itemList = (site, list, name) => ({
  '@context': 'https://schema.org', '@type': 'ItemList', name, numberOfItems: list.length,
  itemListElement: list.slice(0, 50).map((r, i) => ({ '@type': 'ListItem', position: i + 1, url: site + r.path, name: r.title })),
});

// ── Preparation packs / guides (same frontmatter as The Grid's briefings/) ───
function readGuides(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`guides/${file}: missing the --- header block (see guides/README.md)`);
    const meta = {};
    for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
    if (String(meta.draft).toLowerCase() === 'true') continue;
    for (const k of ['title', 'date', 'excerpt']) if (!meta[k]) throw new Error(`guides/${file}: header is missing "${k}:"`);
    if (isNaN(new Date(meta.date + 'T00:00:00Z'))) throw new Error(`guides/${file}: date must be YYYY-MM-DD`);
    out.push({ slug: slugify(file.replace(/\.html$/, '')), date: meta.date, title: meta.title, tag: meta.tag || 'Guide',
      excerpt: meta.excerpt, description: meta.description || meta.excerpt, body: m[2].trim() });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ── Build ────────────────────────────────────────────────────────────
function buildPages({ rows, builtAt, site, index, gaId, dist, root }) {
  const today = new Date().toISOString().slice(0, 10);
  const shell = makeShell({ site, index, gaId, builtAt, root });
  const sitemap = [];
  let count = 0;
  const write = (p, html, { sitemap: sm = true, priority = 0.6, lastmod = builtAt.slice(0, 10) } = {}) => {
    const file = p.endsWith('/') ? path.join(dist, p, 'index.html') : path.join(dist, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
    count++;
    if (sm) sitemap.push({ loc: site + p, lastmod, priority });
  };

  const isOpen = (r) => r.status === 'open' && (!r.deadline || r.deadline >= today);
  const byDeadline = (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || (b.funding === 'Fully funded') - (a.funding === 'Fully funded');
  const open = rows.filter(isOpen).sort(byDeadline);
  const funded = open.filter((r) => r.funding === 'Fully funded');
  const intl = open.filter((r) => r.eligibility === 'UK & International' && r.funding !== 'Self-funded');
  const soon = open.filter((r) => r.deadline && days(r.deadline, today) <= 30);
  const insts = [...new Set(open.map((r) => r.institution))].sort();
  const discs = [...new Set(open.flatMap((r) => r.disciplines || []))].sort();
  const instSlug = (x) => slugify(x.replace(/^University of /i, '').replace(/ University$/i, ''));
  const discSlug = slugify;
  const pick = (list, k = 60) => list.slice(0, k);
  const updated = ukDate(builtAt);
  const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Doctum', url: site, logo: site + '/brand/icon-512.png',
    description: 'Doctum lists funded PhD opportunities from UK university websites and matches them to your CV.' };

  // ── Listing pages ──
  const similarOf = (r) => {
    const d0 = (r.disciplines || [])[0];
    return open.filter((x) => x.id !== r.id && (x.disciplines || [])[0] === d0)
      .sort((a, b) => (b.institution === r.institution) - (a.institution === r.institution) || byDeadline(a, b)).slice(0, 5);
  };
  for (const r of rows) {
    const live = isOpen(r);
    const elig = ELIG[r.eligibility] || 'Not stated';
    const excerpt = trimWords(r.description || r.summary, 140);
    const facts = [
      ['University', esc(r.institution)],
      r.school && ['Department', esc(r.school)],
      ['Funding', fundPill(r.funding)],
      r.stipend && ['Stipend', `${money(r.stipend)} a year (as advertised)`],
      ['Who can apply', esc(elig)],
      ['Deadline', deadlineHtml(r, today)],
      r.start && ['Start', esc(r.start)],
      r.degree && r.degree !== 'PhD' && ['Award', esc(r.degree)],
      r.programme && ['Programme', esc(r.programme)],
      (r.supervisors || []).length && ['Supervisors', esc(r.supervisors.slice(0, 4).join(', '))],
      (r.funders || []).length && ['Funders', esc(r.funders.join(', '))],
      (r.disciplines || []).length && ['Subjects', r.disciplines.map((d) => `<a href="/subjects/${discSlug(d)}/">${esc(d)}</a>`).join(', ')],
    ].filter(Boolean);
    const desc = `${r.funding && r.funding !== 'Unknown' ? r.funding + ' ' : ''}PhD at ${r.institution}${r.deadline ? ', deadline ' + ukDate(r.deadline) : ''}. ${trimWords(r.summary || r.description, 22)}`;
    const ld = {
      '@context': 'https://schema.org', '@type': 'EducationalOccupationalProgram',
      name: r.title, description: trimWords(r.summary || r.description, 60), url: site + r.path,
      educationalCredentialAwarded: r.degree || 'PhD', programType: 'Doctoral research',
      provider: { '@type': 'CollegeOrUniversity', name: r.institution, ...(r.region ? { address: { '@type': 'PostalAddress', addressRegion: r.region, addressCountry: 'GB' } } : {}) },
      ...(r.deadline ? { applicationDeadline: r.deadline } : {}),
      ...(r.start ? { startDate: r.start } : {}),
      ...(r.stipend ? { financialAidEligible: `Stipend £${r.stipend} a year` } : {}),
      ...(r.funding === 'Fully funded' ? { offers: { '@type': 'Offer', price: 0, priceCurrency: 'GBP', category: 'Fully funded' } } : {}),
      sameAs: r.url, dateModified: r.last_changed || r.last_seen || builtAt.slice(0, 10),
    };
    const sim = similarOf(r);
    const firstDisc = (r.disciplines || [])[0];
    const body = `
<article class="listing" data-id="${esc(r.id)}">
  ${live ? '' : '<p class="notice notice-closed">This PhD is closed. It is kept here for reference. <a href="/">Search open PhDs</a>.</p>'}
  <h1>${esc(r.title)}</h1>
  <p class="lead">${esc(r.institution)}${r.school ? ' · ' + esc(r.school) : ''}</p>
  <div class="listing-grid">
    <div class="listing-main">
      <h2>About this PhD</h2>
      <div class="advert" id="advert"><p>${esc(excerpt)}</p></div>
      <p class="advert-actions">
        ${(r.description || '').split(/\s+/).length > 140 ? `<button type="button" class="btn-link" id="read-more" data-id="${esc(r.id)}">Read the full advert</button>` : ''}
        <a class="btn" href="${esc(r.url)}" rel="nofollow noopener" target="_blank">View on the ${esc(r.institution)} website</a>
      </p>
      <h2>What the funding means</h2>
      <p>${esc(FUNDING_NOTE[r.funding] || FUNDING_NOTE.Unknown)}${elig === 'UK / Home fee status only' ? ' This one is limited to applicants with UK (Home) fee status.' : ''}</p>
      <p class="small">Details are taken from the university's advert and were last checked on ${esc(ukDate(r.last_seen || builtAt))}. Always confirm on the university's page before applying.</p>
    </div>
    <aside class="listing-side">
      <dl class="facts-list">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${live ? `<a class="btn btn-brass" href="/match/?id=${esc(r.id)}">Check my CV against this PhD</a>
      <a class="btn btn-ghost btn-pack" href="/briefing/?id=${esc(r.id)}" rel="nofollow">Get a preparation pack</a>
      <p class="side-note">The key papers behind this project, the skills to show and interview prep. <a href="/phd-preparation-pack/">What’s in a preparation pack?</a></p>` : ''}
    </aside>
  </div>
  ${sim.length ? `<section><h2>Similar PhDs${firstDisc ? ' in ' + esc(firstDisc) : ''}</h2>${cardList(sim, today)}</section>` : ''}
</article>`;
    write(r.path, shell({
      path: r.path, title: `${trimWords(r.title, 12)} | PhD at ${r.institution} | Doctum`, description: desc, body, ld: [ld], noindex: !live,
      scripts: ['/assets/search.js'],
      crumbs: firstDisc ? [['/subjects/', 'Subjects'], [`/subjects/${discSlug(firstDisc)}/`, firstDisc], [r.path, trimWords(r.title, 8)]] : [[r.path, trimWords(r.title, 8)]],
    }), { sitemap: live, priority: r.funding === 'Fully funded' ? 0.7 : 0.5, lastmod: (r.last_changed || r.last_seen || builtAt).slice(0, 10) });
  }

  // ── Home = the search page ──
  // Filter rail + first page of results are rendered here so Google and no-JS visitors
  // get real content; /assets/search.js then takes over and calls /api/search.
  const discCount = (d) => open.filter((r) => (r.disciplines || []).includes(d)).length;
  const instCount = (i) => open.filter((r) => r.institution === i).length;
  const FUND_ORDER = ['Fully funded', 'Competition funded', 'Partially funded', 'Self-funded', 'Unknown'];
  const tally = (vals) => { const c = {}; for (const v of vals) c[v] = (c[v] || 0) + 1; return c; };
  const facetData = {
    funding: Object.entries(tally(open.map((r) => r.funding))).sort((a, b) => FUND_ORDER.indexOf(a[0]) - FUND_ORDER.indexOf(b[0])),
    elig: Object.entries(tally(open.map((r) => ELIG[r.eligibility] || 'Not stated'))).sort((a, b) => b[1] - a[1]),
    disc: Object.entries(tally(open.flatMap((r) => r.disciplines || []))).sort((a, b) => b[1] - a[1]),
    inst: Object.entries(tally(open.map((r) => r.institution))).sort((a, b) => b[1] - a[1]),
  };
  const FACET_LABEL = { funding: 'Funding', disc: 'Subject', elig: 'Who can apply', inst: 'University' };
  const facetsHtml = ['funding', 'disc', 'elig', 'inst'].map((k) => `<fieldset class="fgroup"><legend>${FACET_LABEL[k]}</legend>${facetData[k]
    .map(([v, c]) => `<label><input type="checkbox" name="${k}" value="${esc(v)}"> ${esc(k === 'funding' && v === 'Unknown' ? 'Not stated in advert' : v)}<span class="n">${c}</span></label>`).join('')}</fieldset>`).join('');
  const firstPage = [...open].sort((a, b) => recommended(a, b, today)).slice(0, 20);
  const pages = Math.min(25, Math.ceil(open.length / 20));
  write('/', shell({
    path: '/', title: 'Doctum | Funded UK PhDs, matched to you',
    description: `Search ${n(open.length)} open PhDs from ${insts.length} UK universities, including ${n(funded.length)} fully funded. Filter by funding, subject and eligibility, or match your CV to the right projects.`,
    ld: [org, { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Doctum', url: site,
      potentialAction: { '@type': 'SearchAction', target: site + '/?q={search_term_string}', 'query-input': 'required name=search_term_string' } },
      itemList(site, firstPage, 'Open UK PhDs, fully funded first')],
    scripts: ['/assets/search.js'],
    body: `
<section class="hero hero-split">
  <div class="hero-main">
    <p class="eyebrow">Doctoral opportunities · United Kingdom</p>
    <h1>Funded UK PhDs, matched to you</h1>
    <p class="lead">PhD adverts collected straight from university websites. No adverts, no paid placement.</p>
    <div class="figures"><div><b>${n(open.length)}</b>open PhDs</div><div><b>${n(funded.length)}</b>fully funded</div><div><b>${insts.length}</b>universities</div></div>
    <p class="updated">Updated every Tuesday and Friday · last update ${esc(ukDate(builtAt))}</p>
  </div>
  <aside class="cv-card" aria-labelledby="cv-card-h">
    <p class="cv-card-tag">Free · CV match</p>
    <h2 id="cv-card-h">See which PhDs fit your CV</h2>
    <p>Upload your CV and Doctum ranks every open PhD you can apply for, explains each match and flags anything that could rule you out.</p>
    <a class="btn btn-brass" href="/match/">Find my matches</a>
    <p class="small">Your CV is read for this search only and never stored.</p>
  </aside>
</section>
<ol class="steps-strip" aria-label="How Doctum works">
  <li><span>1</span><div><strong>Match your CV</strong>Your best-fit funded PhDs, with the reasons.</div></li>
  <li><span>2</span><div><strong>Get a preparation pack</strong>The key papers behind the project, the skills to show and interview prep. <a href="/phd-preparation-pack/">See an example</a></div></li>
  <li><span>3</span><div><strong>Apply prepared</strong>Write to the supervisor knowing their work.</div></li>
</ol>
<div class="search-app" id="search-app">
  <div class="searchrow">
    ${searchForm()}
    <label class="sr" for="sort">Sort results</label>
    <select id="sort"><option value="">Best match</option><option value="deadline">Deadline soonest</option><option value="stipend">Highest stipend</option><option value="newest">Newest</option></select>
  </div>
  <div class="quick" role="group" aria-label="Quick filters">
    <button type="button" data-quick="funded" aria-pressed="false">Fully funded only</button>
    <button type="button" data-quick="intl" aria-pressed="false">Open to international</button>
    <button type="button" data-quick="soon" aria-pressed="false">Closing in 30 days</button>
    <button type="button" id="shortlist-btn" aria-pressed="false">My shortlist (<span id="shortlist-n">0</span>)</button>
    <button type="button" class="filters-toggle" aria-expanded="false" aria-controls="filters">Filters</button>
  </div>
  <div class="search-layout">
    <aside class="filters" id="filters" aria-label="Filters">
      <button type="button" class="reset" id="reset" hidden>Clear all filters</button>
      <div id="facets">${facetsHtml}</div>
    </aside>
    <section class="results" aria-live="polite">
      <div class="results-bar"><p id="count"><strong>${n(open.length)}</strong> open projects · ${n(funded.length)} fully funded</p><a class="btn btn-ghost" href="/match/">Match my CV instead</a></div>
      <div id="results">${cardList(firstPage, today)}</div>
      <nav id="pager" class="pager" aria-label="Pages">${pages > 1 ? Array.from({ length: Math.min(pages, 7) }, (_, i) => `<button type="button" data-p="${i + 1}"${i === 0 ? ' aria-current="page"' : ''}>${i + 1}</button>`).join('') + '<button type="button" data-p="2">Next</button>' : ''}</nav>
    </section>
  </div>
</div>
<div class="rule-head"><h2>Browse by subject</h2></div>
<ul class="chips-list">${discs.map((d) => `<li><a href="/subjects/${discSlug(d)}/">${esc(d)}<span>${discCount(d)}</span></a></li>`).join('')}</ul>
<div class="rule-head"><h2>Browse by university</h2></div>
<ul class="chips-list">${insts.map((i) => `<li><a href="/universities/${instSlug(i)}/">${esc(i)}<span>${instCount(i)}</span></a></li>`).join('')}</ul>
<section class="cta">
  <div><h2>Match my CV</h2><p>Paste or upload your CV. Doctum compares it with every open advert in your subject and explains each match: the overlap, the gaps and anything that might rule you out. Your CV is not stored.</p></div>
  <a class="btn btn-brass" href="/match/">Match my CV</a>
</section>
<div class="rule-head"><h2>How Doctum works</h2></div>
<ul class="principles">
  <li><strong>Straight from the source</strong>Every listing is read from the university's own website and links back to the original advert.</li>
  <li><strong>No paid ranking</strong>Results are ordered by deadline or relevance. Nobody pays to appear higher.</li>
  <li><strong>Clear funding and eligibility</strong>Each advert is labelled so you can see at a glance whether it is funded and who can apply. <a href="/about/">Methodology</a></li>
</ul>`,
  }), { priority: 1.0 });

  // ── Match page (filled by /assets/match.js, calls /api/match) ──
  write('/match/', shell({
    path: '/match/', title: 'Match your CV to UK PhDs | Doctum',
    description: 'Paste or upload your CV and Doctum finds the open UK PhDs that fit, explains each match and flags anything that might rule you out. Your CV is not stored.',
    scripts: ['/assets/search.js', '/assets/match.js'],
    body: `
<h1>Match your CV to open PhDs</h1>
<p class="lead">Doctum compares your CV with every open advert in the subjects you choose, after first removing anything you can't apply for. Your CV is read for this search only and is not stored.</p>
<form id="match-form" class="match-form">
  <div class="step"><h2><span>1</span> Your CV</h2>
    <label class="file">Upload a PDF or text file <input type="file" id="cv-file" accept=".pdf,.txt,.md"></label>
    <label for="cv" class="sr">CV text</label>
    <textarea id="cv" rows="10" placeholder="…or paste your CV here: degrees, projects, skills, publications." maxlength="30000"></textarea>
    <p class="small" id="cv-status"></p>
  </div>
  <div class="step"><h2><span>2</span> Subject areas <small>(pick one or two)</small></h2>
    <div class="chips-select" id="disc">${discs.filter((d) => !/^Other/.test(d)).map((d) => `<label><input type="checkbox" name="disc" value="${esc(d)}"> ${esc(d)}</label>`).join('')}</div>
    <p class="small" id="disc-hint"></p>
  </div>
  <div class="step"><h2><span>3</span> Your situation</h2>
    <fieldset class="inline"><legend>Fee status</legend>
      <label><input type="radio" name="fee" value="uk"> UK (Home)</label>
      <label><input type="radio" name="fee" value="intl"> International</label>
    </fieldset>
    <label>Funding <select name="funding" id="funding"><option value="full">Fully funded only</option><option value="any">Any funding (incl. competition)</option><option value="all">Include self-funded</option></select></label>
  </div>
  <div class="step share"><h2><span>4</span> Help shape future PhDs <small>(optional)</small></h2>
    <label class="check"><input type="checkbox" id="share"> Count me, anonymously, in Doctum's applicant statistics</label>
    <p class="small">Doctum adds a tally to broad categories only: your highest degree and class, the subject area of your first degree, whether your CV mentions publications, a research project or industry experience, and which of 18 skill groups it mentions (for example "Python" or "Experimental lab work"). No CV text, name or contact details are kept, and nothing links the tally to you. Universities see totals only, never a group smaller than 10. <a href="/privacy/#statistics">How this works</a></p>
    <label class="fdc" hidden>Country of your first degree <small>(optional)</small> <select id="fdc"><option value="">Prefer not to say</option>${COUNTRIES.map(([c, nm]) => `<option value="${c}">${esc(nm)}</option>`).join('')}<option value="OTHER">Other</option></select></label>
  </div>
  <button class="btn btn-brass" type="submit">Find my matches</button>
  <p class="error" id="match-error" role="alert"></p>
</form>
<section id="match-results" aria-live="polite"></section>
<noscript><p>CV matching needs JavaScript.</p></noscript>`,
  }), { priority: 0.9 });

  // ── PhD preparation pack (filled by /assets/briefing.js, calls /api/briefing) ──
  // Per-person pages behind ?id= / ?rid=: never indexed, not in the sitemap.
  write('/briefing/', shell({
    path: '/briefing/', title: 'PhD preparation pack | Doctum', noindex: true,
    description: 'A preparation pack for one PhD: the supervisor’s key papers, their research thread, the skills they look for and interview preparation.',
    scripts: ['/assets/search.js', '/assets/briefing.js'],
    body: `
<div id="briefing">
<h1>PhD preparation pack</h1>
<p class="lead">Before you contact a supervisor, know their work. Doctum reads the supervisor’s university profile and recent papers and turns them into a preparation pack for one PhD: which three papers to read first, how their research has developed, the skills they will look for (checked against your CV if you add it), open questions and interview preparation.</p>
<p><a href="/phd-preparation-pack/">See an example pack</a>, then open any PhD and choose <strong>Prep pack</strong>.</p>
<noscript><p>Preparation packs need JavaScript.</p></noscript>
</div>`,
  }), { sitemap: false });

  // ── What's in a pack (public, indexable explainer with an anonymised example) ──
  write('/phd-preparation-pack/', shell({
    path: '/phd-preparation-pack/', title: 'PhD preparation packs: the research behind a PhD, ready for your application | Doctum',
    description: 'A preparation pack for one PhD: the supervisor’s three key papers, their research thread, the skills they look for, open questions and interview prep. See an example.',
    crumbs: [['/phd-preparation-pack/', 'PhD preparation packs']],
    body: explainerBody({ openCount: n(open.length) }),
  }), { priority: 0.8 });

  // ── Hubs ──
  const hub = (p, title, h1, intro, list, crumbs, extra = '', priority = 0.8) => write(p, shell({
    path: p, title, description: intro.replace(/<[^>]+>/g, '').slice(0, 300), crumbs,
    ld: [itemList(site, pick(list), h1)],
    body: `<h1>${esc(h1)}</h1><p class="lead">${intro}</p>${extra}${cardList(pick(list), today)}${list.length > 60 ? `<p class="more-link">Showing the 60 closing soonest of ${n(list.length)}. <a href="/">Search and filter all of them →</a></p>` : ''}`,
  }), { priority });

  write('/subjects/', shell({
    path: '/subjects/', title: 'PhDs by subject | Doctum', description: 'Browse open UK PhDs by subject area, from engineering and computer science to medicine and the humanities.',
    crumbs: [['/subjects/', 'Subjects']],
    body: `<h1>PhDs by subject</h1><ul class="chips-list big">${discs.map((d) => `<li><a href="/subjects/${discSlug(d)}/">${esc(d)} <span>${discCount(d)} open</span></a></li>`).join('')}</ul>`,
  }), { priority: 0.7 });
  for (const d of discs) {
    const list = open.filter((r) => (r.disciplines || []).includes(d));
    const f = list.filter((r) => r.funding === 'Fully funded').length;
    hub(`/subjects/${discSlug(d)}/`, `${d} PhDs in the UK | ${n(list.length)} open | Doctum`, `${d} PhDs`,
      `${n(list.length)} open ${esc(d)} PhDs at UK universities, ${n(f)} of them fully funded. Sorted by deadline. Updated ${esc(updated)}.`,
      list, [['/subjects/', 'Subjects'], [`/subjects/${discSlug(d)}/`, d]]);
  }
  write('/universities/', shell({
    path: '/universities/', title: 'PhDs by university | Doctum', description: `Open PhDs at ${insts.length} UK universities, collected directly from their websites.`,
    crumbs: [['/universities/', 'Universities']],
    body: `<h1>PhDs by university</h1><p class="lead">Doctum currently collects adverts from these universities' own websites. More are being added.</p><ul class="chips-list big">${insts.map((i) => `<li><a href="/universities/${instSlug(i)}/">${esc(i)} <span>${instCount(i)} open</span></a></li>`).join('')}</ul>`,
  }), { priority: 0.7 });
  for (const i of insts) {
    const list = open.filter((r) => r.institution === i);
    const f = list.filter((r) => r.funding === 'Fully funded').length;
    const subj = [...new Set(list.flatMap((r) => r.disciplines || []))];
    hub(`/universities/${instSlug(i)}/`, `PhDs at ${i} | ${n(list.length)} open | Doctum`, `PhDs at ${i}`,
      `${n(list.length)} open PhDs at ${esc(i)}, ${n(f)} fully funded. Sorted by deadline. Updated ${esc(updated)}.`,
      list, [['/universities/', 'Universities'], [`/universities/${instSlug(i)}/`, i]],
      subj.length ? `<p class="chips-line">Subjects: ${subj.map((d) => `<a href="/subjects/${discSlug(d)}/">${esc(d)}</a>`).join(' · ')}</p>` : '');
  }
  hub('/fully-funded-phds/', `Fully funded PhDs in the UK | ${n(funded.length)} open | Doctum`, 'Fully funded PhDs in the UK',
    `${n(funded.length)} open PhDs that state they are fully funded: tuition fees paid plus a stipend for living costs. Check each advert for whether international fees are covered. Updated ${esc(updated)}.`,
    funded, [['/fully-funded-phds/', 'Fully funded PhDs']], '', 0.9);
  hub('/funded-phds-international-students/', `Funded PhDs for international students in the UK | Doctum`, 'Funded PhDs open to international students',
    `${n(intl.length)} open UK PhDs whose adverts say international applicants can apply. Funding varies: some cover international fees, some only the Home rate. Updated ${esc(updated)}.`,
    intl, [['/funded-phds-international-students/', 'Open to international students']], '', 0.9);
  hub('/closing-soon/', `UK PhDs closing soon | Doctum`, 'PhDs closing in the next 30 days',
    `${n(soon.length)} open UK PhDs with a deadline in the next 30 days. Updated ${esc(updated)}.`,
    soon, [['/closing-soon/', 'Closing soon']], '', 0.8);

  // ── Data pages (citable, with Dataset JSON-LD) ──
  const withStip = open.filter((r) => r.stipend >= 10000 && r.stipend <= 60000);
  const st = withStip.map((r) => r.stipend).sort((a, b) => a - b);
  const q = (p) => st.length ? st[Math.min(st.length - 1, Math.floor(p * (st.length - 1)))] : 0;
  const byInst = insts.map((i) => { const s = withStip.filter((r) => r.institution === i).map((r) => r.stipend).sort((a, b) => a - b); return [i, s]; }).filter(([, s]) => s.length);
  const dataset = (name, description, p) => ({
    '@context': 'https://schema.org', '@type': 'Dataset', name, description, url: site + p, creator: { '@type': 'Organization', name: 'Doctum', url: site },
    dateModified: builtAt.slice(0, 10), spatialCoverage: 'United Kingdom', isAccessibleForFree: true, license: 'https://creativecommons.org/licenses/by/4.0/',
  });
  write('/data/uk-phd-stipends/', shell({
    path: '/data/uk-phd-stipends/', title: 'UK PhD stipends: what open adverts are paying | Doctum',
    description: `Stipends stated in ${n(st.length)} open UK PhD adverts: median ${money(q(0.5))} a year. Updated ${updated}.`,
    crumbs: [['/data/uk-phd-stipends/', 'UK PhD stipend data']],
    ld: [dataset('UK PhD stipends in open adverts', 'Annual stipend amounts stated in open UK PhD adverts collected by Doctum from university websites.', '/data/uk-phd-stipends/')],
    body: `<h1>UK PhD stipends: what open adverts are paying</h1>
<p class="lead">Of ${n(open.length)} open PhDs Doctum is tracking, ${n(st.length)} state an annual stipend in the advert. These figures are what the adverts say on ${esc(updated)}, not an official rate.</p>
<div class="kpis"><div><span>${money(q(0.5))}</span>Median stipend</div><div><span>${money(q(0.1))}–${money(q(0.9))}</span>Middle 80%</div><div><span>${n(st.length)}</span>Adverts with a stated stipend</div></div>
<h2>By university</h2>
<div class="table-wrap"><table><thead><tr><th>University</th><th>Adverts with a stipend</th><th>Median</th><th>Highest</th></tr></thead><tbody>
${byInst.map(([i, s]) => `<tr><td><a href="/universities/${instSlug(i)}/">${esc(i)}</a></td><td>${s.length}</td><td>${money(s[Math.floor((s.length - 1) / 2)])}</td><td>${money(s[s.length - 1])}</td></tr>`).join('')}
</tbody></table></div>
<h2>How this is measured</h2>
<p>Doctum reads each advert and extracts the annual stipend where one is stated as a figure. Adverts that only say "UKRI rate" or "standard rate" are not counted. Values outside £10,000–£60,000 are excluded as likely errors or totals. The data is refreshed twice a week. You are welcome to cite this page; please link to it.</p>`,
  }), { priority: 0.7 });
  const discRows = discs.map((d) => { const l = open.filter((r) => (r.disciplines || []).includes(d)); return [d, l.length, l.filter((r) => r.funding === 'Fully funded').length, l.filter((r) => r.eligibility === 'UK & International').length]; }).sort((a, b) => b[1] - a[1]);
  const fundRows = ['Fully funded', 'Competition funded', 'Partially funded', 'Self-funded', 'Unknown'].map((f) => [f, open.filter((r) => r.funding === f).length]).filter(([, c]) => c);
  write('/data/funded-phds-open-now/', shell({
    path: '/data/funded-phds-open-now/', title: 'Open UK PhDs right now: by subject and funding | Doctum',
    description: `${n(open.length)} open UK PhDs on ${updated}: ${n(funded.length)} fully funded. Counts by subject, funding type and eligibility.`,
    crumbs: [['/data/funded-phds-open-now/', 'Open PhDs by subject']],
    ld: [dataset('Open UK PhDs by subject and funding', 'Counts of open UK PhD adverts by subject area, funding type and eligibility, collected by Doctum from university websites.', '/data/funded-phds-open-now/')],
    body: `<h1>Open UK PhDs right now</h1>
<p class="lead">On ${esc(updated)} Doctum was tracking ${n(open.length)} open PhD adverts at ${insts.length} UK universities. ${n(funded.length)} say they are fully funded.</p>
<h2>By funding type</h2>
<div class="table-wrap"><table><thead><tr><th>Funding</th><th>Open adverts</th><th>Share</th></tr></thead><tbody>${fundRows.map(([f, c]) => `<tr><td>${esc(f)}</td><td>${n(c)}</td><td>${Math.round(100 * c / open.length)}%</td></tr>`).join('')}</tbody></table></div>
<h2>By subject</h2>
<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Open</th><th>Fully funded</th><th>Open to international (stated)</th></tr></thead><tbody>${discRows.map(([d, c, f, i]) => `<tr><td><a href="/subjects/${discSlug(d)}/">${esc(d)}</a></td><td>${n(c)}</td><td>${n(f)}</td><td>${n(i)}</td></tr>`).join('')}</tbody></table></div>
<p class="small">An advert can be in more than one subject. Coverage is currently ${insts.length} universities, so these counts describe Doctum's sources, not every PhD in the UK. See <a href="/about/#sources">sources</a>.</p>`,
  }), { priority: 0.7 });

  // ── Doctum Observatory (live market tracker; see scripts/observatory.js) ──
  const obs = observatoryBody({ open, today, updated, esc, n, money, ukDate, slugify, cardList, root });
  write('/observatory/', shell({
    path: '/observatory/', title: 'Doctum Observatory: the UK PhD market, measured | Doctum',
    description: obs.description,
    crumbs: [['/observatory/', 'Doctum Observatory']],
    ld: [dataset('Doctum Observatory: UK PhD market tracker', 'Counts of open UK PhD adverts by funding, eligibility, deadline month, subject, nation and stipend, plus new and closed adverts, measured from university websites twice a week.', '/observatory/')],
    body: obs.html,
  }), { priority: 0.9 });

  // ── Guides (blog) ──
  const guides = readGuides(path.join(root, 'guides'));
  write('/guides/', shell({
    path: '/guides/', title: 'PhD guides and data | Doctum', description: 'Practical guides to finding and applying for a funded PhD in the UK, plus data reports from the Doctum database.',
    crumbs: [['/guides/', 'Guides']],
    body: `<h1>Guides</h1>${guides.length ? `<div class="cards">${guides.map((g) => `<article class="card"><p class="meta">${esc(g.tag)} · <time datetime="${g.date}">${esc(ukDate(g.date))}</time></p><h3><a href="/guides/${g.slug}/">${esc(g.title)}</a></h3><p>${esc(g.excerpt)}</p></article>`).join('')}</div>` : '<p class="empty">The first guides are on their way.</p>'}`,
  }), { priority: 0.6 });
  for (const g of guides) {
    const p = `/guides/${g.slug}/`;
    write(p, shell({
      path: p, title: `${g.title} | Doctum`, description: g.description, ogType: 'article', crumbs: [['/guides/', 'Guides'], [p, trimWords(g.title, 8)]],
      ld: [{ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: g.title, description: g.description, datePublished: g.date, dateModified: g.date,
        url: site + p, mainEntityOfPage: site + p, image: site + '/brand/og-image.png', author: { '@type': 'Organization', name: 'Doctum', url: site }, publisher: org }],
      body: `<article class="prose"><p class="meta">${esc(g.tag)} · <time datetime="${g.date}">${esc(ukDate(g.date))}</time></p><h1>${esc(g.title)}</h1>${g.body}</article>
<aside class="cta"><div><h2>Find your PhD</h2><p>${n(open.length)} open UK PhDs, ${n(funded.length)} fully funded.</p></div><a class="btn btn-brass" href="/match/">Match my CV</a></aside>`,
    }), { priority: 0.6, lastmod: g.date });
  }

  // ── About / privacy / 404 ──
  const sources = insts.map((i) => `<li><a href="/universities/${instSlug(i)}/">${esc(i)}</a> (${instCount(i)} open)</li>`).join('');
  write('/about/', shell({
    path: '/about/', title: 'About Doctum: sources and methodology', description: 'How Doctum collects, labels and updates UK PhD listings, how CV matching works, and how AI is used.',
    crumbs: [['/about/', 'About']], ld: [org],
    body: `<article class="prose"><h1>About Doctum</h1>
<p><em>Doctum</em> is Latin for “taught” or “learned”. Doctum is a free search of PhD opportunities at UK universities, built to make funded PhDs easier to find and to help applicants see quickly which ones they can apply for.</p>
<h2 id="sources">Where the listings come from</h2>
<p>Doctum reads the PhD and studentship pages on university websites directly. It does not copy other PhD listing sites. Each listing links back to the university's own advert. Current sources:</p><ul>${sources}</ul>
<p>The crawler identifies itself as DoctumBot, follows each site's robots.txt and waits between requests.</p>
<h2>How often it updates</h2>
<p>Every Tuesday and Friday morning. New adverts are added, changed adverts are updated and closed adverts are marked as closed. Listings past their deadline are hidden from search straight away. Last update: ${esc(updated)}.</p>
<h2>How listings are labelled</h2>
<ul><li><strong>Funding</strong>: fully funded, competition funded, partially funded, self-funded, or unknown, based on what the advert says.</li>
<li><strong>Who can apply</strong>: open to international applicants, UK (Home) fee status only, or not stated.</li>
<li><strong>Subjects</strong>: one or more subject areas assigned from the title and text.</li></ul>
<p>Labels are generated automatically and can be wrong. The university's advert is always the authority.</p>
<h2>Ranking</h2>
<p>Search results are ordered by deadline, relevance, stipend or date added. Nobody can pay to rank higher. If Doctum ever shows a sponsored listing it will be clearly labelled as sponsored.</p>
<h2>How CV matching works</h2>
<p>First, hard filters remove adverts you can't apply for: closed ones, ones outside your chosen subjects, ones limited to UK fee status if you're international, and ones outside your funding choice. Then Doctum compares the words and phrases in your CV with each advert, weighting distinctive terms more than common ones, and explains each match: the overlap, the gaps, and any stated requirements (such as a First or a Master's) you may not meet. This step does not use AI.</p>
<h2>How AI is used</h2>
<p>An optional detailed analysis of one CV against one advert uses an AI model (Anthropic's Claude) with a fixed set of instructions. It is told to use only your CV and the advert text and not to invent facts. Treat it as a second opinion, not a decision.</p>
<h2>PhD preparation packs</h2>
<p>A preparation pack looks at one PhD's lead supervisor. Doctum first confirms who they are: the supervisor's university profile linked from the advert, their ORCID record, and their publication record in <a href="https://openalex.org">OpenAlex</a>, a free open index of research papers. Where OpenAlex has mixed in papers by a different person with a similar name, those papers are removed and listed. If the match isn't certain, you are asked to pick the right person before anything is written.</p>
<p>Doctum then ranks the supervisor's papers from the last ten years against the advert, and an AI model (Anthropic's Claude) writes the pack using only the profile, the paper titles and abstracts, the advert and, if you add it, your CV. Every statement about the supervisor's work links to the paper it comes from. Only public, professional research information is used. Doctum does not use Google Scholar.</p>
<h2>Corrections</h2>
<p>If a listing is wrong or should be removed, email <a href="mailto:hello@doctum.co.uk">hello@doctum.co.uk</a>.</p></article>`,
  }), { priority: 0.5 });
  write('/privacy/', shell({
    path: '/privacy/', title: 'Privacy | Doctum', description: 'What Doctum does with your data: your CV is processed for your search and not stored.',
    crumbs: [['/privacy/', 'Privacy']],
    body: `<article class="prose"><h1>Privacy</h1>
<h2>Your CV</h2><p>When you use CV matching, your CV text is sent to Doctum's server, used to find matches for that request and then discarded. It is not saved, logged or used to train anything. If you upload a PDF, the text is extracted in your browser and only the text is sent.</p>
<h2>Detailed analysis</h2><p>If you ask for a detailed analysis, your CV text and the advert are sent to Anthropic, the provider of the Claude AI model, to produce that analysis. Anthropic processes it under its commercial terms, which do not allow it to train models on this data by default.</p>
<h2>PhD preparation packs</h2><p>If you add your CV to a preparation pack request, the CV text is sent to Doctum's server and to Anthropic to write that pack, then discarded. The CV itself is not saved. The finished pack (which includes short notes on how your CV matches the project) is stored for 30 days under a private, unguessable link so you can come back to it, then deleted. You can delete it sooner from the pack page. In your browser, the CV you pasted is kept in this tab's session storage so you don't have to paste it twice; it is cleared when you close the tab.</p>
<p>Preparation packs use public, professional information about supervisors only: their university profile, ORCID record and published papers (via OpenAlex). If you are a supervisor and something is wrong, email <a href="mailto:hello@doctum.co.uk">hello@doctum.co.uk</a>.</p>
<h2 id="statistics">Anonymous statistics</h2>
<p>Doctum counts what applicants look for, so that we (and universities planning PhDs) can see where demand is. These counts contain no identifiers: no IP address, cookie, account, session or device id, and nothing finer than the day. Two of your searches cannot be linked to each other or to you.</p>
<ul>
<li><strong>Searches:</strong> the words you search for (cleaned of anything that looks like an email address, phone number or link), the filters you choose, how many results were found, and the country your connection comes from. The country is worked out from your connection by our host (Netlify); your IP address is not stored.</li>
<li><strong>Adverts:</strong> when an advert page is viewed, its apply link is clicked, it is saved to a shortlist or a preparation pack is requested. Only the advert and the action are counted.</li>
<li><strong>CV match:</strong> the subject areas, fee status and funding option you choose on the form are counted like search filters.</li>
<li><strong>Your CV, only if you tick "Count me":</strong> Doctum adds to tallies of broad categories: highest degree and class, the subject area of your first degree, the country of your first degree if you choose one, whether your CV mentions publications, a research project or dissertation, or industry experience, and which of 18 skill groups it mentions. Your CV text is never stored, and the tally is not linked to you. If you don't tick the box, nothing from your CV is counted.</li>
</ul>
<p>Individual events are combined into weekly totals within about a day and then deleted. Reports, including ones Doctum may sell to universities, contain totals only and never show a group smaller than 10 people. We rely on our legitimate interest in understanding demand for searches and adverts, and on your consent for the CV categories. You can withdraw that consent by not ticking the box next time; because the tallies can't be linked to you, past ones can't be removed individually.</p>
<h2>Analytics cookies</h2><p>${gaId ? 'Doctum uses Google Analytics to count visits and see which pages are useful. It does not receive your CV.' : 'Doctum does not use analytics cookies.'}</p>
<h2>Contact</h2><p><a href="mailto:hello@doctum.co.uk">hello@doctum.co.uk</a></p></article>`,
  }), { priority: 0.3 });
  write('/404.html', shell({
    path: '/404.html', title: 'Page not found | Doctum', description: 'This page could not be found.', noindex: true,
    body: `<h1>Page not found</h1><p class="lead">This PhD may have closed and been removed, or the link is wrong.</p>${searchForm()}<p><a href="/closing-soon/">See PhDs closing soon</a> · <a href="/fully-funded-phds/">Fully funded PhDs</a></p>`,
  }), { sitemap: false });

  // ── sitemap.xml, robots.txt, llms.txt ──
  fs.writeFileSync(path.join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemap.map((u) => `<url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority.toFixed(1)}</priority></url>`).join('\n')}
</urlset>
`);
  fs.writeFileSync(path.join(dist, 'robots.txt'), index
    ? `# Doctum. Search engines and AI assistants are welcome to read and cite the public pages.\nUser-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /.netlify/\n\nSitemap: ${site}/sitemap.xml\n`
    : `# Indexing is switched off (ALLOW_INDEXING is not "true").\nUser-agent: *\nDisallow: /\n`);
  fs.writeFileSync(path.join(dist, 'llms.txt'), `# Doctum

> Doctum lists PhD opportunities collected directly from UK university websites, updated every Tuesday and Friday. Each listing states the funding type, who can apply (UK fee status or international), the deadline and a link to the university's own advert.

Figures on ${updated}: ${n(open.length)} open PhDs at ${insts.length} universities, ${n(funded.length)} fully funded.

When citing a listing, link to its Doctum page and remind readers to confirm details on the university's advert.

## Key pages
- [Fully funded PhDs in the UK](${site}/fully-funded-phds/)
- [Funded PhDs open to international students](${site}/funded-phds-international-students/)
- [PhDs closing in the next 30 days](${site}/closing-soon/)
- [Doctum Observatory: live figures on the UK PhD market (funding, eligibility, deadlines, stipends)](${site}/observatory/)
- [UK PhD stipends: what open adverts pay](${site}/data/uk-phd-stipends/)
- [Open UK PhDs by subject and funding](${site}/data/funded-phds-open-now/)
- [PhD preparation packs: what a preparation pack contains](${site}/phd-preparation-pack/)
- [Sources and methodology](${site}/about/)

## Subjects
${discs.map((d) => `- [${d} PhDs](${site}/subjects/${discSlug(d)}/)`).join('\n')}

## Universities
${insts.map((i) => `- [PhDs at ${i}](${site}/universities/${instSlug(i)}/)`).join('\n')}
`);
  return count;
}

module.exports = { buildPages, slugify, esc };
