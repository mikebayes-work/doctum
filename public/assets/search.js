// Doctum — search (home page), result cards, shortlist and "Read the full advert".
// Talks only to /api/search and /api/phd. All filtering and ranking happen on the
// server; the browser only ever receives one page of results.
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ukDate = function (iso) { var d = new Date(iso + 'T00:00:00Z'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  var today = new Date().toISOString().slice(0, 10);
  var daysLeft = function (iso) { return Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5); };
  var words = function (s, n) { var w = String(s || '').replace(/\s+/g, ' ').trim().split(' '); return w.length <= n ? w.join(' ') : w.slice(0, n).join(' ').replace(/[,;:.\-–]+$/, '') + '…'; };
  var FUND_CLS = { 'Fully funded': 'funded', 'Competition funded': 'comp', 'Self-funded': 'self' };
  var ELIG_CHIP = { 'Open to international': 'Open to international', 'UK / Home fee status only': 'UK / Home only' };
  var shortInst = function (i) { return String(i || '').replace(/^University of /, '').replace(/ University$/, '').replace(/^Queen's University Belfast$/, "Queen's"); };

  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
        return j;
      });
    });
  }

  // ── Shortlist (this browser only) ──
  var KEY = 'doctum.shortlist';
  function loadSaved() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function storeSaved(list) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 100))); } catch (e) { /* private mode */ } }
  var saved = loadSaved();
  var isSaved = function (id) { return saved.some(function (c) { return c.id === id; }); };
  function syncSaveButtons(root) {
    (root || document).querySelectorAll('[data-save]').forEach(function (b) {
      var on = isSaved(b.getAttribute('data-save'));
      b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.textContent = on ? 'Saved' : 'Save';
    });
    var n = document.getElementById('shortlist-n'); if (n) n.textContent = saved.length;
  }

  function closes(c) {
    if (!c.deadline) return c.deadline_text ? '<span class="chip">' + esc(words(c.deadline_text, 6)) + '</span>' : '';
    var d = daysLeft(c.deadline), when = d < 0 ? 'Closed' : d === 0 ? 'closes today' : d === 1 ? '1 day' : d + ' days';
    return '<span class="chip' + (d <= 14 ? ' urgent' : '') + '">Closes ' + esc(ukDate(c.deadline)) + ' · ' + when + '</span>';
  }
  // Same markup as cardHtml() in scripts/pages.js.
  function cardHtml(c, extra) {
    var disc = (c.disciplines || [])[0], sup = (c.supervisors || []).slice(0, 3), fun = (c.funders || []).slice(0, 3);
    var foot = [sup.length ? 'Supervisor' + (sup.length > 1 ? 's' : '') + ': ' + esc(sup.join(', ')) : '', fun.length ? 'Funder: ' + esc(fun.join(', ')) : ''].filter(Boolean).join(' · ');
    return '<article class="card' + (c.funding === 'Fully funded' ? ' is-funded' : '') + '" data-id="' + esc(c.id) + '">' +
      (extra && extra.score != null ? '<span class="score" title="Match score">' + extra.score + '</span>' : '') +
      '<p class="meta"><strong>' + esc(c.institution) + '</strong>' + (c.school ? '<span>· ' + esc(c.school) + '</span>' : '') + (disc ? '<span>· ' + esc(disc) + '</span>' : '') + '</p>' +
      '<h3><a href="' + esc(c.path) + '">' + esc(c.title) + '</a></h3>' +
      '<p class="chips"><span class="chip ' + (FUND_CLS[c.funding] || '') + '">' + esc(c.funding || 'Funding unknown') + '</span>' +
      (c.stipend ? '<span class="chip money">£' + Number(c.stipend).toLocaleString('en-GB') + ' / yr</span>' : '') + closes(c) +
      (ELIG_CHIP[c.eligibility] ? '<span class="chip">' + ELIG_CHIP[c.eligibility] + '</span>' : '') +
      (c.programme ? '<span class="chip">' + esc(words(c.programme, 5)) + '</span>' : '') +
      (c.start ? '<span class="chip">Starts ' + esc(words(c.start, 4)) + '</span>' : '') + '</p>' +
      (c.summary && !(extra && extra.html) ? '<p class="sum">' + esc(words(c.summary, 55)) + '</p>' : '') +
      (extra && extra.html ? extra.html : '<p class="more"><button type="button" class="btn-link" data-more="' + esc(c.id) + '">Read the full advert</button></p>') +
      '<div class="foot"><span class="sup">' + foot + '</span><span class="actions">' + (c.status === 'open' ? '<a class="brief" href="/briefing/?id=' + esc(c.id) + '" rel="nofollow" title="PhD preparation pack: the key papers, research thread and interview prep for this PhD">Prep pack</a>' : '') + '<button type="button" data-save="' + esc(c.id) + '" aria-pressed="' + (isSaved(c.id) ? 'true' : 'false') + '">' + (isSaved(c.id) ? 'Saved' : 'Save') + '</button>' +
      '<a class="go" href="' + esc(c.url) + '" rel="nofollow noopener" target="_blank">Apply at ' + esc(shortInst(c.institution)) + ' ↗</a></span></div></article>';
  }
  // Anonymous interest signals (listing viewed, apply clicked, saved). No cookies, no ids:
  // just the action and the listing. See netlify/edge-functions/event.js.
  function signal(a, id) {
    if (!id || !/^[0-9a-f]{12}$/.test(id) || !navigator.sendBeacon) return;
    try { navigator.sendBeacon('/api/event', new Blob([JSON.stringify({ a: a, id: id })], { type: 'text/plain' })); } catch (e) { /* ignore */ }
  }
  window.Doctum = { esc: esc, api: api, cardHtml: cardHtml, signal: signal };
  var listing = document.querySelector('article.listing[data-id]');
  if (listing && !listing.querySelector('.notice-closed')) signal('v', listing.getAttribute('data-id'));
  document.addEventListener('click', function (e) {
    var go = e.target.closest && e.target.closest('a.go, .advert-actions a.btn'); if (!go) return;
    var c = go.closest('.card'), s = c && c.querySelector('[data-save]');
    signal('a', s ? s.getAttribute('data-save') : listing && listing.getAttribute('data-id'));
  });

  // ── Card actions anywhere on the page (save, read more) ──
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-save],[data-more],[data-less]'); if (!t) return;
    var card = t.closest('.card');
    if (t.hasAttribute('data-save')) {
      var id = t.getAttribute('data-save');
      if (isSaved(id)) { saved = saved.filter(function (c) { return c.id !== id; }); storeSaved(saved); syncSaveButtons(); if (state && state.shortlist) showShortlist(); return; }
      t.disabled = true;
      api('/api/phd?id=' + encodeURIComponent(id)).then(function (d) {
        delete d.description; saved.unshift(d); storeSaved(saved); syncSaveButtons(); signal('sv', id);
      }).catch(function (x) { t.textContent = x.message; }).then(function () { t.disabled = false; });
    } else if (t.hasAttribute('data-more')) {
      t.disabled = true; t.textContent = 'Loading…';
      api('/api/phd?id=' + encodeURIComponent(t.getAttribute('data-more'))).then(function (d) {
        var box = document.createElement('div'); box.className = 'full';
        box.innerHTML = String(d.description || '').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p.trim()) + '</p>'; }).join('');
        var sum = card && card.querySelector('.sum'); if (sum) sum.hidden = true;
        t.parentNode.parentNode.insertBefore(box, t.parentNode);
        t.disabled = false; t.textContent = 'Show less'; t.removeAttribute('data-more'); t.setAttribute('data-less', '');
      }).catch(function (x) { t.disabled = false; t.textContent = x.message; });
    } else {
      var full = card.querySelector('.full'), s2 = card.querySelector('.sum');
      var open = full.hidden; full.hidden = !open; if (s2) s2.hidden = open;
      t.textContent = open ? 'Show less' : 'Read the full advert';
    }
  });

  // Listing page: full advert on demand
  var more = document.getElementById('read-more');
  if (more) more.addEventListener('click', function () {
    more.disabled = true; more.textContent = 'Loading…';
    api('/api/phd?id=' + encodeURIComponent(more.getAttribute('data-id'))).then(function (d) {
      document.getElementById('advert').innerHTML = String(d.description || '').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p.trim()) + '</p>'; }).join('');
      more.remove();
    }).catch(function (e) { more.disabled = false; more.textContent = e.message; });
  });

  var state = null;
  syncSaveButtons();

  // ── Search page ──
  var app = document.getElementById('search-app');
  if (!app) return;
  var form = app.querySelector('form.searchbar'), qIn = document.getElementById('q'), sortSel = document.getElementById('sort');
  var facetsBox = document.getElementById('facets'), results = document.getElementById('results'), countEl = document.getElementById('count'), pager = document.getElementById('pager');
  var filters = document.getElementById('filters'), resetBtn = document.getElementById('reset'), slBtn = document.getElementById('shortlist-btn');
  var LABEL = { funding: 'Funding', disc: 'Subject', elig: 'Who can apply', inst: 'University' };
  var KEYS = ['funding', 'disc', 'elig', 'inst', 'quick'];

  function fromUrl() {
    var p = new URLSearchParams(location.search), s = { q: p.get('q') || '', sort: p.get('sort') || '', page: +p.get('page') || 1, shortlist: p.get('saved') === '1' };
    KEYS.forEach(function (k) { s[k] = p.getAll(k); });
    return s;
  }
  function toQuery(s) {
    var p = new URLSearchParams();
    if (s.q) p.set('q', s.q); if (s.sort) p.set('sort', s.sort); if (s.page > 1) p.set('page', s.page);
    KEYS.forEach(function (k) { s[k].forEach(function (v) { p.append(k, v); }); });
    return p.toString();
  }
  var active = function () { return !!(state.q || KEYS.some(function (k) { return state[k].length; })); };
  function syncControls() {
    qIn.value = state.q; sortSel.value = state.sort;
    app.querySelectorAll('[data-quick]').forEach(function (b) { b.setAttribute('aria-pressed', state.quick.indexOf(b.getAttribute('data-quick')) >= 0 ? 'true' : 'false'); });
    slBtn.setAttribute('aria-pressed', state.shortlist ? 'true' : 'false');
    facetsBox.querySelectorAll('input[type=checkbox]').forEach(function (i) { i.checked = (state[i.name] || []).indexOf(i.value) >= 0; });
    resetBtn.hidden = !active();
  }
  function renderFacets(f) {
    facetsBox.innerHTML = ['funding', 'disc', 'elig', 'inst'].map(function (k) {
      var sel = state[k], items = (f[k] || []).slice();
      sel.forEach(function (v) { if (!items.some(function (e) { return e[0] === v; })) items.push([v, 0]); });
      return '<fieldset class="fgroup"><legend>' + LABEL[k] + '</legend>' + (items.map(function (e) {
        return '<label><input type="checkbox" name="' + k + '" value="' + esc(e[0]) + '"' + (sel.indexOf(e[0]) >= 0 ? ' checked' : '') + '> ' + esc(k === 'funding' && e[0] === 'Unknown' ? 'Not stated in advert' : e[0]) + '<span class="n">' + e[1] + '</span></label>';
      }).join('') || '<p class="small">None</p>') + '</fieldset>';
    }).join('');
  }
  function renderPager(r) {
    if (r.pages <= 1) { pager.innerHTML = ''; return; }
    var out = [], from = Math.max(1, r.page - 3), to = Math.min(r.pages, r.page + 3);
    if (r.page > 1) out.push('<button type="button" data-p="' + (r.page - 1) + '">Previous</button>');
    for (var i = from; i <= to; i++) out.push('<button type="button" data-p="' + i + '"' + (i === r.page ? ' aria-current="page"' : '') + '>' + i + '</button>');
    if (r.page < r.pages) out.push('<button type="button" data-p="' + (r.page + 1) + '">Next</button>');
    pager.innerHTML = out.join('');
  }
  function showShortlist() {
    countEl.innerHTML = '<strong>' + saved.length + '</strong> saved in this browser';
    results.innerHTML = saved.length ? '<div class="cards">' + saved.map(function (c) { return cardHtml(c); }).join('') + '</div>' : '<p class="empty">Nothing saved yet. Press <b>Save</b> on any project to keep it here.</p>';
    pager.innerHTML = '';
  }
  var seq = 0;
  function run(push) {
    var my = ++seq, qs = toQuery(state);
    if (push) history.pushState(null, '', '/' + (qs || state.shortlist ? '?' + (state.shortlist ? 'saved=1' : qs) : ''));
    syncControls();
    if (state.shortlist) { showShortlist(); return; }
    countEl.textContent = 'Searching…';
    api('/api/search?' + qs).then(function (r) {
      if (my !== seq) return;
      state.page = r.page;
      countEl.innerHTML = '<strong>' + r.total.toLocaleString('en-GB') + '</strong> open projects · ' + r.fullyFunded + ' fully funded' + (r.capped ? ' · showing the first 500: narrow your search to see more' : '');
      results.innerHTML = r.results.length ? '<div class="cards">' + r.results.map(function (c) { return cardHtml(c); }).join('') + '</div>' : '<p class="empty">No open PhDs match. Try removing a filter.</p>';
      renderFacets(r.facets); renderPager(r);
    }).catch(function (e) { if (my === seq) { countEl.textContent = e.message; results.innerHTML = ''; } });
  }
  var top = function () { var y = app.getBoundingClientRect().top + window.scrollY - 8; if (window.scrollY > y) window.scrollTo({ top: y, behavior: 'smooth' }); };

  form.addEventListener('submit', function (e) { e.preventDefault(); state.q = qIn.value.trim().slice(0, 120); state.page = 1; state.shortlist = false; run(true); });
  sortSel.addEventListener('change', function () { state.sort = sortSel.value; state.page = 1; state.shortlist = false; run(true); });
  facetsBox.addEventListener('change', function (e) {
    var t = e.target; if (t.type !== 'checkbox' || !state[t.name]) return;
    var arr = state[t.name], i = arr.indexOf(t.value);
    if (t.checked && i < 0) arr.push(t.value); if (!t.checked && i >= 0) arr.splice(i, 1);
    state.page = 1; state.shortlist = false; run(true);
  });
  app.querySelectorAll('[data-quick]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-quick'), i = state.quick.indexOf(v);
      if (i >= 0) state.quick.splice(i, 1); else state.quick.push(v);
      state.page = 1; state.shortlist = false; run(true);
    });
  });
  slBtn.addEventListener('click', function () { state.shortlist = !state.shortlist; run(true); });
  resetBtn.addEventListener('click', function () { KEYS.forEach(function (k) { state[k] = []; }); state.q = ''; state.page = 1; run(true); });
  var ft = app.querySelector('.filters-toggle');
  ft.addEventListener('click', function () { var o = filters.classList.toggle('open'); ft.setAttribute('aria-expanded', o ? 'true' : 'false'); });
  pager.addEventListener('click', function (e) {
    var p = e.target.getAttribute && e.target.getAttribute('data-p'); if (!p) return;
    state.page = +p; run(true); top();
  });
  window.addEventListener('popstate', function () { state = fromUrl(); run(false); });

  state = fromUrl();
  // The first page is already in the HTML; only call the API if the URL asks for something else.
  if (location.search) run(false); else syncControls();
})();
