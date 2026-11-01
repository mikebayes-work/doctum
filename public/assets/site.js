// Doctum — small shared script: mobile menu + Google Analytics behind a consent banner.
//
// Google Analytics sets non-essential cookies, so under PECR it may only load after the
// visitor opts in. Nothing from Google is requested until "Accept" is clicked:
//  * the choice is kept in localStorage "doctum.consent" = {v:'granted'|'denied', at:<ms>}
//    and asked again after 12 months (or if this file's CONSENT_VERSION changes);
//  * "Reject" is as easy as "Accept", and "Cookie settings" in the footer reopens the banner;
//  * withdrawing consent deletes the _ga cookies and stops further collection;
//  * the private preparation-pack link (?rid=) is stripped from what Google sees.
// No inline styles or inline scripts (CSP): everything here is classes from site.css.
(function () {
  var me = document.currentScript;
  var GA = me && me.getAttribute('data-ga');
  var KEY = 'doctum.consent', CONSENT_VERSION = 1, MAX_AGE = 365 * 864e5;
  var COOKIE_SECONDS = 395 * 86400; // about 13 months, as stated on /privacy/

  function readChoice() {
    try {
      var c = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (c && c.ver === CONSENT_VERSION && (c.v === 'granted' || c.v === 'denied') && Date.now() - c.at < MAX_AGE) return c.v;
    } catch (e) { /* storage blocked: ask each visit, never assume consent */ }
    return null;
  }
  function saveChoice(v) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: v, at: Date.now(), ver: CONSENT_VERSION })); } catch (e) { /* private mode */ }
  }

  // Preparation-pack links (?rid=) are private: strip them from the page and the referrer.
  function clean(href) {
    if (!href) return '';
    try { var u = new URL(href); u.searchParams.delete('rid'); return u.toString(); } catch (e) { return ''; }
  }

  var loaded = false;
  function startGA() {
    if (!GA || loaded) return;
    loaded = true;
    window['ga-disable-' + GA] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    window.gtag('js', new Date());
    window.gtag('config', GA, {
      page_location: clean(location.href),
      page_referrer: clean(document.referrer),
      cookie_expires: COOKIE_SECONDS,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA);
    document.head.appendChild(s);
  }

  function stopGA() {
    if (GA) window['ga-disable-' + GA] = true;
    if (window.gtag) window.gtag('consent', 'update', { analytics_storage: 'denied' });
    // Delete Google Analytics cookies (_ga, _ga_<id>) on this host and its parent domains.
    var names = document.cookie.split(';').map(function (c) { return c.split('=')[0].trim(); })
      .filter(function (n) { return n === '_ga' || n.indexOf('_ga_') === 0 || n === '_gid' || n === '_gat'; });
    var parts = location.hostname.split('.'), domains = [''];
    for (var i = 0; i < parts.length - 1; i++) domains.push('; domain=.' + parts.slice(i).join('.'));
    names.forEach(function (n) {
      domains.forEach(function (d) { document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d; });
    });
  }

  var banner = null;
  function closeBanner() { if (banner) { banner.remove(); banner = null; } }
  function choose(v) {
    saveChoice(v);
    closeBanner();
    if (v === 'granted') startGA(); else stopGA();
  }
  function showBanner() {
    if (!GA || banner) return;
    banner = document.createElement('section');
    banner.className = 'consent';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie choice');
    var t = document.createElement('p');
    t.innerHTML = '<strong>Can we count your visit?</strong> With your permission, Doctum uses Google Analytics cookies to see which pages are useful. Your CV is never sent to Google. <a href="/privacy/#device">Privacy policy</a>';
    var row = document.createElement('div');
    row.className = 'consent-btns';
    var yes = document.createElement('button'); yes.type = 'button'; yes.className = 'btn'; yes.textContent = 'Accept analytics';
    var no = document.createElement('button'); no.type = 'button'; no.className = 'btn'; no.textContent = 'Reject';
    yes.addEventListener('click', function () { choose('granted'); });
    no.addEventListener('click', function () { choose('denied'); });
    row.appendChild(yes); row.appendChild(no);
    banner.appendChild(t); banner.appendChild(row);
    document.body.appendChild(banner);
  }

  function init() {
    var b = document.querySelector('.menu-btn'), n = document.getElementById('sitenav');
    if (b && n) b.addEventListener('click', function () {
      var open = n.classList.toggle('open');
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (!GA) return;
    document.querySelectorAll('.cookie-settings').forEach(function (el) {
      el.hidden = false;
      el.addEventListener('click', function () { showBanner(); var f = banner && banner.querySelector('button'); if (f) f.focus(); });
    });
    var c = readChoice();
    if (c === 'granted') startGA();
    else if (c === null) showBanner();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
