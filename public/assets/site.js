// Doctum — small shared script: mobile menu + optional Google Analytics.
(function () {
  var me = document.currentScript;
  var ga = me && me.getAttribute('data-ga');
  if (ga) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', ga, { anonymize_ip: true });
  }
  function init() {
    var b = document.querySelector('.menu-btn'), n = document.getElementById('sitenav');
    if (b && n) b.addEventListener('click', function () {
      var open = n.classList.toggle('open');
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
