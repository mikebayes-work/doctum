// Doctum — search page (/search/) and "Read the full advert" on listing pages.
// Talks only to /api/search and /api/phd. All filtering and ranking happen on
// the server; the browser only ever receives one page of results.
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ukDate = function (iso) { var d = new Date(iso + 'T00:00:00Z'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  var today = new Date().toISOString().slice(0, 10);
  var daysLeft = function (iso) { return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5); };
  var pillCls = { 'Fully funded': 'pill-full', 'Competition funded': 'pill-comp', 'Self-funded': 'pill-self' };

  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
        return j;
      });
    });
  }
  function deadline(c) {
    if (!c.deadline) return esc(c.deadline_text ? c.deadline_text.split(/\s+/).slice(0, 8).join(' ') : 'Not stated');
    var d = daysLeft(c.deadline);
    return esc(ukDate(c.deadline)) + (d <= 14 && d >= 0 ? ' <span class="pill pill-soon">' + (d === 0 ? 'Today' : d + ' days left') + '</span>' : '');
  }
  function cardHtml(c, extra) {
    return '<article class="card">' + (extra && extra.score != null ? '<span class="score" title="Match score">' + extra.score + '</span>' : '') +
      '<h3><a href="' + esc(c.path) + '">' + esc(c.title) + '</a></h3>' +
      '<p class="meta">' + esc(c.institution) + (c.school ? ' · ' + esc(c.school) : '') + '</p>' +
      '<p class="facts"><span class="pill ' + (pillCls[c.funding] || 'pill-other') + '">' + esc(c.funding || 'Unknown') + '</span>' +
      (c.stipend ? ' <span class="pill pill-other">£' + Number(c.stipend).toLocaleString('en-GB') + ' a year</span>' : '') +
      ' <span class="pill pill-other">' + esc(c.eligibility) + '</span>' +
      ' <span class="dl">Deadline: ' + deadline(c) + '</span></p>' +
      (extra && extra.html ? extra.html : '') + '</article>';
  }
  window.Doctum = { esc: esc, api: api, cardHtml: cardHtml };

  // ── Listing page: full advert on demand ──
  var more = document.getElementById('read-more');
  if (more) more.addEventListener('click', function () {
    more.disabled = true; more.textContent = 'Loading…';
    api('/api/phd?id=' + encodeURIComponent(more.getAttribute('data-id'))).then(function (d) {
      var box = document.getElementById('advert');
      box.innerHTML = String(d.description || '').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p.trim()) + '</p>'; }).join('');
      more.remove();
    }).catch(function (e) { more.disabled = false; more.textContent = e.message; });
  });

  // ── Search page ──
  var app = document.getElementById('search-app');
  if (!app) return;
  var form = app.querySelector('form.searchbar'), qIn = document.getElementById('q'), sortSel = document.getElementById('sort');
  var facetsBox = document.getElementById('facets'), results = document.getElementById('results'), countEl = document.getElementById('count'), pager = document.getElementById('pager');
  var LABEL = { funding: 'Funding', elig: 'Who can apply', disc: 'Subject', inst: 'University' };
  var state = fromUrl();
  var narrow = window.matchMedia && window.matchMedia('(max-width: 820px)').matches;

  function fromUrl() {
    var p = new URLSearchParams(location.search), s = { q: p.get('q') || '', sort: p.get('sort') || '', page: +p.get('page') || 1 };
    ['funding', 'disc', 'elig', 'inst', 'quick'].forEach(function (k) { s[k] = p.getAll(k); });
    return s;
  }
  function toQuery(s) {
    var p = new URLSearchParams();
    if (s.q) p.set('q', s.q); if (s.sort) p.set('sort', s.sort); if (s.page > 1) p.set('page', s.page);
    ['funding', 'disc', 'elig', 'inst', 'quick'].forEach(function (k) { s[k].forEach(function (v) { p.append(k, v); }); });
    return p.toString();
  }
  function syncControls() {
    qIn.value = state.q; sortSel.value = state.sort;
    app.querySelectorAll('input[name="quick"]').forEach(function (i) { i.checked = state.quick.indexOf(i.value) >= 0; });
  }
  function renderFacets(f) {
    facetsBox.innerHTML = ['funding', 'elig', 'disc', 'inst'].map(function (k) {
      var items = f[k] || [];
      var sel = state[k];
      var list = items.map(function (e) {
        return '<label><input type="checkbox" name="' + k + '" value="' + esc(e[0]) + '"' + (sel.indexOf(e[0]) >= 0 ? ' checked' : '') + '> ' + esc(e[0]) + ' <span>' + e[1] + '</span></label>';
      }).join('');
      var open = sel.length || (!narrow && (k === 'funding' || k === 'elig'));
      return '<details' + (open ? ' open' : '') + '><summary>' + LABEL[k] + '</summary><fieldset><legend class="sr">' + LABEL[k] + '</legend>' + (list || '<p class="small">None</p>') + '</fieldset></details>';
    }).join('');
  }
  function renderPager(r) {
    if (r.pages <= 1) { pager.innerHTML = ''; return; }
    var out = [], from = Math.max(1, r.page - 3), to = Math.min(r.pages, r.page + 3);
    if (r.page > 1) out.push('<button data-p="' + (r.page - 1) + '">Previous</button>');
    for (var i = from; i <= to; i++) out.push('<button data-p="' + i + '"' + (i === r.page ? ' aria-current="page"' : '') + '>' + i + '</button>');
    if (r.page < r.pages) out.push('<button data-p="' + (r.page + 1) + '">Next</button>');
    pager.innerHTML = out.join('');
  }
  var seq = 0;
  function run(push) {
    var my = ++seq, qs = toQuery(state);
    if (push) history.pushState(null, '', '/search/' + (qs ? '?' + qs : ''));
    countEl.textContent = 'Searching…';
    api('/api/search?' + qs).then(function (r) {
      if (my !== seq) return;
      state.page = r.page;
      countEl.innerHTML = '<strong>' + r.total.toLocaleString('en-GB') + '</strong> open PhDs' + (r.fullyFunded ? ' · ' + r.fullyFunded + ' fully funded' : '') + (r.capped ? ' · showing the first 500, narrow your search to see more' : '');
      results.innerHTML = r.results.length ? '<div class="cards">' + r.results.map(function (c) { return cardHtml(c); }).join('') + '</div>' : '<p class="empty">No open PhDs match. Try removing a filter.</p>';
      renderFacets(r.facets); renderPager(r);
    }).catch(function (e) { if (my === seq) { countEl.textContent = e.message; results.innerHTML = ''; } });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); state.q = qIn.value.trim().slice(0, 120); state.page = 1; run(true); });
  sortSel.addEventListener('change', function () { state.sort = sortSel.value; state.page = 1; run(true); });
  app.addEventListener('change', function (e) {
    var t = e.target; if (t.type !== 'checkbox') return;
    var k = t.name, arr = state[k]; if (!arr) return;
    var i = arr.indexOf(t.value);
    if (t.checked && i < 0) arr.push(t.value); if (!t.checked && i >= 0) arr.splice(i, 1);
    state.page = 1; run(true);
  });
  pager.addEventListener('click', function (e) {
    var p = e.target.getAttribute && e.target.getAttribute('data-p'); if (!p) return;
    state.page = +p; run(true); window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  window.addEventListener('popstate', function () { state = fromUrl(); syncControls(); run(false); });
  syncControls(); run(false);
})();
