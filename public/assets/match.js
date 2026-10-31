// Doctum — CV match page (/match/). Needs search.js (window.Doctum) loaded first.
// The CV text is sent to /api/match for this request only; nothing is stored.
// PDF text is extracted in the browser with pdf.js (cdnjs), so the file itself never leaves the device.
(function () {
  'use strict';
  var D = window.Doctum, esc = D.esc, api = D.api;
  var form = document.getElementById('match-form'); if (!form) return;
  var cvEl = document.getElementById('cv'), fileEl = document.getElementById('cv-file'), cvStatus = document.getElementById('cv-status');
  var discBox = document.getElementById('disc'), hint = document.getElementById('disc-hint'), err = document.getElementById('match-error');
  var out = document.getElementById('match-results');
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  var target = new URLSearchParams(location.search).get('id');
  var analyseOn = true;
  if (target && !/^[0-9a-f]{12}$/.test(target)) target = null;

  function post(body) {
    return api('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function checkedDiscs() { return Array.prototype.map.call(discBox.querySelectorAll('input:checked'), function (i) { return i.value; }); }
  discBox.addEventListener('change', function (e) {
    if (checkedDiscs().length > 2) { e.target.checked = false; hint.textContent = 'Pick up to two subjects.'; } else hint.textContent = '';
  });
  function preselect(list, why) {
    if (checkedDiscs().length) return;
    var done = [];
    (list || []).slice(0, 2).forEach(function (d) {
      var i = discBox.querySelector('input[value="' + d.replace(/"/g, '\\"') + '"]'); if (i) { i.checked = true; done.push(d); }
    });
    if (done.length) hint.textContent = why + ': ' + done.join(' and ') + '. Change them if they are wrong.';
  }

  // Checking against one listing (from a listing page's button)
  if (target) api('/api/phd?id=' + target).then(function (d) {
    var p = document.createElement('p'); p.className = 'profile';
    p.innerHTML = 'Checking your CV against <a href="' + esc(d.path) + '">' + esc(d.title) + '</a> (' + esc(d.institution) + '), plus similar open PhDs.';
    form.parentNode.insertBefore(p, form);
    preselect(d.disciplines, 'Subjects set from that PhD');
  }).catch(function () { target = null; });

  // CV upload
  function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
  function pdfText(buf) {
    return (window.pdfjsLib ? Promise.resolve() : loadScript(PDFJS + 'pdf.min.js')).then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
      return window.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var pages = []; for (var i = 1; i <= Math.min(pdf.numPages, 8); i++) pages.push(i);
      return Promise.all(pages.map(function (n) {
        return pdf.getPage(n).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
          var lines = [], last = null;
          tc.items.forEach(function (it) { var y = Math.round(it.transform[5]); if (last !== null && Math.abs(y - last) > 2) lines.push('\n'); lines.push(it.str, ' '); last = y; });
          return lines.join('');
        });
      }));
    }).then(function (t) { return t.join('\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n'); });
  }
  fileEl.addEventListener('change', function () {
    var f = fileEl.files[0]; if (!f) return;
    if (f.size > 5e6) { cvStatus.textContent = 'That file is over 5 MB. Paste the text instead.'; return; }
    cvStatus.textContent = 'Reading ' + f.name + '…';
    var isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    (isPdf ? f.arrayBuffer().then(pdfText) : f.text()).then(function (t) {
      cvEl.value = t.slice(0, 30000).trim();
      cvStatus.textContent = cvEl.value.length < 200 ? 'Could not read much text from that file. If it is a scanned PDF, paste the text instead.' : 'Read ' + f.name + '. Check the text below, then choose your subjects.';
      suggest();
    }).catch(function () { cvStatus.textContent = 'Could not read that file. Paste the text instead.'; });
  });
  var lastSuggested = '';
  function suggest() {
    var cv = cvEl.value.trim(); if (cv.length < 200 || cv === lastSuggested || checkedDiscs().length) return;
    lastSuggested = cv;
    post({ action: 'profile', cv: cv }).then(function (r) { preselect(r.profile.subjects, 'Suggested from your CV'); }).catch(function () {});
  }
  cvEl.addEventListener('blur', suggest);

  // Results
  function tags(list, cls) { return list && list.length ? '<ul class="tags ' + (cls || '') + '">' + list.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : ''; }
  function matchCard(m) {
    var html = '<p class="why">In common with your CV:</p>' + tags(m.why, 'good') +
      (m.gaps.length ? '<p class="why">The advert also mentions:</p>' + tags(m.gaps) : '') +
      (m.flags.length ? '<p class="why">Check before applying:</p>' + tags(m.flags, 'flags') : '') +
      (analyseOn ? '<p class="why"><button type="button" class="btn-link" data-analyse="' + esc(m.id) + '">Detailed analysis of this PhD</button></p><div class="analysis" hidden></div>' : '');
    return D.cardHtml(m, { score: m.score, html: html });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault(); err.textContent = '';
    var cv = cvEl.value.trim(), disc = checkedDiscs(), fee = (form.querySelector('input[name="fee"]:checked') || {}).value;
    if (cv.length < 200) { err.textContent = 'Add your CV first: at least a few lines on degrees, projects and skills.'; return; }
    if (!disc.length) { err.textContent = 'Pick one or two subject areas.'; return; }
    if (!fee) { err.textContent = 'Choose your fee status (UK or international).'; return; }
    var btn = form.querySelector('button[type="submit"]'); btn.disabled = true; btn.textContent = 'Matching…';
    post({ action: 'match', cv: cv, disc: disc, fee: fee, funding: document.getElementById('funding').value }).then(function (r) {
      var p = r.profile, bits = [];
      if (p.degree) bits.push('highest degree: ' + p.degree + (p.cls ? ' (' + p.cls + ')' : ''));
      if (p.terms.length) bits.push('key terms: ' + p.terms.slice(0, 8).join(', '));
      var m = r.matches;
      if (target) m.sort(function (a, b) { return (b.id === target) - (a.id === target); });
      out.innerHTML = '<div class="profile"><strong>What we read from your CV</strong>: ' + esc(bits.join('; ') || 'not much: try pasting more detail') + '.<br>' +
        r.considered + ' open PhDs passed your filters. ' + (m.length ? 'Your ' + m.length + ' closest matches:' : 'None overlapped enough with your CV. Try another subject or widen the funding option.') + '</div>' +
        (m.length ? '<div class="cards results">' + m.map(matchCard).join('') + '</div><p class="small">Scores compare the words and phrases in your CV with each advert. They are a guide to where to look first, not a prediction of success.</p>' : '');
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e2) { err.textContent = e2.message; }).then(function () { btn.disabled = false; btn.textContent = 'Find my matches'; });
  });

  // Optional AI analysis (streamed from /api/match → Anthropic)
  out.addEventListener('click', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-analyse'); if (!id) return;
    var b = e.target, box = b.closest('.card').querySelector('.analysis');
    b.disabled = true; b.textContent = 'Analysing… (about 15 seconds)'; box.hidden = true;
    fetch('/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'analyse', id: id, cv: cvEl.value.trim() }) })
      .then(function (r) {
        if (r.status === 501) { analyseOn = false; throw new Error('Detailed analysis is not switched on yet.'); }
        if (!r.ok || !r.body) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'The analysis failed. Please try again.'); });
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', text = '';
        return (function pump() {
          return reader.read().then(function (c) {
            if (c.done) return text;
            buf += dec.decode(c.value, { stream: true });
            var lines = buf.split('\n'); buf = lines.pop();
            lines.forEach(function (l) {
              if (l.indexOf('data:') !== 0) return;
              try { var ev = JSON.parse(l.slice(5)); if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) text += ev.delta.text; } catch (x) { /* keep-alive */ }
            });
            return pump();
          });
        })();
      })
      .then(function (text) {
        var j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        var li = function (a, f) { return (a || []).map(function (x) { return '<li>' + f(x) + '</li>'; }).join(''); };
        var S = { met: 'Met', partial: 'Partly met', missing: 'Missing', unclear: 'Unclear' };
        box.innerHTML = '<p><strong>Fit ' + esc(j.fitScore) + '/100.</strong> ' + esc(j.verdict) + '</p>' +
          (j.requirements && j.requirements.length ? '<strong>Requirements</strong><ul>' + li(j.requirements, function (r) { return esc(r.r) + ': <em>' + esc(S[r.s] || r.s) + '</em>. ' + esc(r.w); }) + '</ul>' : '') +
          '<strong>Strengths</strong><ul>' + li(j.strengths, esc) + '</ul>' +
          '<strong>Gaps and what to do</strong><ul>' + li(j.gaps, function (g) { return esc(g.g) + ': ' + esc(g.a); }) + '</ul>' +
          '<strong>Questions to ask the supervisor</strong><ul>' + li(j.supervisorQuestions, esc) + '</ul>' +
          '<strong>Angles for your personal statement</strong><ul>' + li(j.statementAngles, esc) + '</ul>' +
          '<p class="small">AI-generated from your CV and the advert only. Check everything against the advert.</p>';
        box.hidden = false; b.remove();
      })
      .catch(function (x) {
        b.textContent = x instanceof SyntaxError ? 'The analysis came back incomplete. Try again.' : x.message;
        b.disabled = !analyseOn;
        if (!analyseOn) out.querySelectorAll('[data-analyse]').forEach(function (o) { if (o !== b) o.parentNode.remove(); });
      });
  });
})();
