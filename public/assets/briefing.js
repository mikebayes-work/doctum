// Doctum — Opportunity Briefing page (/briefing/). Needs search.js (window.Doctum) first.
//   /briefing/?id=<listing id>  → request form (supervisor, optional CV, optional access code)
//   /briefing/?rid=<job id>     → progress, "is this the right person?" step, then the pack
// The CV stays in this browser tab (sessionStorage) and is sent only with the request
// that needs it. Nothing here builds prompts or ranks papers: that is all server side.
(function () {
  'use strict';
  var D = window.Doctum, esc = D.esc, api = D.api;
  var root = document.getElementById('briefing'); if (!root) return;
  var qs = new URLSearchParams(location.search);
  var id = qs.get('id'), rid = qs.get('rid');
  if (id && !/^[0-9a-f]{12}$/.test(id)) id = null;
  if (rid && !/^[0-9a-f]{24}$/.test(rid)) rid = null;
  var CV_KEY = 'doctum.cv';
  var getCv = function () { try { return sessionStorage.getItem(CV_KEY) || ''; } catch (e) { return ''; } };
  var setCv = function (v) { try { if (v) sessionStorage.setItem(CV_KEY, v); else sessionStorage.removeItem(CV_KEY); } catch (e) { /* private mode */ } };
  var post = function (body) { return api('/api/briefing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); };
  var ukDate = function (iso) { var d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  var li = function (a, f) { return (a || []).map(function (x) { return '<li>' + (f ? f(x) : esc(x)) + '</li>'; }).join(''); };

  if (rid) return poll();
  if (!id) { root.innerHTML = '<p class="lead">Open a PhD listing and choose <strong>Get a preparation pack</strong> to start one.</p><p><a class="btn" href="/">Search PhDs</a></p>'; return; }

  // ── Request form ──
  Promise.all([api('/api/phd?id=' + id), api('/api/briefing?config=1')]).then(function (r) {
    var d = r[0], cfg = r[1];
    if (!cfg.enabled) { root.innerHTML = '<p class="lead">PhD preparation packs are not switched on yet. Please check back soon.</p><p><a href="' + esc(d.path) + '">Back to the PhD</a></p>'; return; }
    var sups = d.supervisors || [];
    root.innerHTML =
      '<p class="profile">Preparation pack for <a href="' + esc(d.path) + '">' + esc(d.title) + '</a> (' + esc(d.institution) + ').</p>' +
      '<form id="brief-form" class="match-form">' +
      '<div class="step"><h2><span>1</span> Lead supervisor</h2><p class="small">Everyone named on the advert is included in the pack. Choose who leads the project.</p>' +
      (sups.length ? '<div class="radios">' + sups.map(function (s, i) { return '<label><input type="radio" name="sup" value="' + esc(s) + '"' + (i === 0 ? ' checked' : '') + '> ' + esc(s) + (i === 0 ? ' <span class="small">(usually the lead)</span>' : '') + '</label>'; }).join('') +
        '<label><input type="radio" name="sup" value=""> Someone else</label></div>' : '<p class="small">The advert doesn’t name a supervisor. Type the name from the advert or the university website.</p>') +
      '<label class="sr" for="sup-other">Supervisor name</label><input type="text" id="sup-other" class="text" maxlength="100" placeholder="e.g. Dr Jane Smith"' + (sups.length ? ' hidden' : '') + '></div>' +
      '<div class="step"><h2><span>2</span> Your CV <small>(optional, makes the skills table personal)</small></h2>' +
      '<label class="file">Upload a PDF or text file <input type="file" id="cv-file" accept=".pdf,.txt,.md"></label>' +
      '<label for="cv" class="sr">CV text</label><textarea id="cv" rows="8" maxlength="30000" placeholder="…or paste your CV here. Leave blank for a general pack."></textarea><p class="small" id="cv-status"></p></div>' +
      (cfg.needsCode ? '<div class="step"><h2><span>3</span> Access code</h2><p class="small">Preparation packs are in testing. Enter the code you were given.</p><label class="sr" for="code">Access code</label><input type="text" id="code" class="text" maxlength="100" autocomplete="off"></div>' : '') +
      '<button class="btn btn-brass" type="submit">Prepare my pack</button> <span class="small">Takes about two minutes.</span>' +
      '<p class="error" id="brief-error" role="alert"></p></form>';
    var form = document.getElementById('brief-form'), other = document.getElementById('sup-other'), cvEl = document.getElementById('cv');
    cvEl.value = getCv();
    if (cvEl.value) document.getElementById('cv-status').textContent = 'Your CV from Match my CV is filled in. Clear it if you don’t want to use it.';
    form.addEventListener('change', function (e) { if (e.target.name === 'sup') { other.hidden = e.target.value !== ''; if (!other.hidden) other.focus(); } });
    document.getElementById('cv-file').addEventListener('change', readFile);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('brief-error'); err.textContent = '';
      var pick = form.querySelector('input[name="sup"]:checked');
      var sup = (pick && pick.value) || other.value.trim();
      var cv = cvEl.value.trim();
      if (!sup) { err.textContent = 'Choose or type the supervisor’s name.'; return; }
      if (cv && cv.length < 200) { err.textContent = 'Add a few more lines of your CV, or leave it blank.'; return; }
      var codeEl = document.getElementById('code');
      var btn = form.querySelector('button[type="submit"]'); btn.disabled = true; btn.textContent = 'Starting…';
      setCv(cv);
      post({ action: 'start', id: id, supervisor: sup, cv: cv, code: codeEl ? codeEl.value.trim() : '' }).then(function (r2) {
        location.href = '/briefing/?rid=' + r2.rid;
      }).catch(function (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = 'Prepare my pack'; });
    });
  }).catch(function (e) { root.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; });

  // PDF/text reading, same approach as Match my CV: text is extracted in the browser.
  function readFile() {
    var f = this.files[0], st = document.getElementById('cv-status'), cvEl = document.getElementById('cv'); if (!f) return;
    if (f.size > 5e6) { st.textContent = 'That file is over 5 MB. Paste the text instead.'; return; }
    st.textContent = 'Reading ' + f.name + '…';
    var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    var isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    var load = function () { return window.pdfjsLib ? Promise.resolve() : new Promise(function (ok, no) { var s = document.createElement('script'); s.src = PDFJS + 'pdf.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); };
    (isPdf ? f.arrayBuffer().then(function (buf) {
      return load().then(function () { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; return window.pdfjsLib.getDocument({ data: buf }).promise; })
        .then(function (pdf) {
          var ps = []; for (var i = 1; i <= Math.min(pdf.numPages, 8); i++) ps.push(pdf.getPage(i).then(function (pg) { return pg.getTextContent(); }).then(function (tc) { return tc.items.map(function (it) { return it.str; }).join(' '); }));
          return Promise.all(ps);
        }).then(function (t) { return t.join('\n'); });
    }) : f.text()).then(function (t) {
      cvEl.value = t.replace(/[ \t]+/g, ' ').slice(0, 30000).trim();
      st.textContent = cvEl.value.length < 200 ? 'Could not read much text from that file. Paste the text instead.' : 'Read ' + f.name + '.';
    }).catch(function () { st.textContent = 'Could not read that file. Paste the text instead.'; });
  }

  // ── Progress and result ──
  function poll() {
    var tries = 0;
    (function tick() {
      api('/api/briefing?rid=' + rid).then(function (j) {
        if (j.state === 'done') return render(j.briefing);
        if (j.state === 'error') { root.innerHTML = '<h1>Pack not ready</h1><p class="error">' + esc(j.error) + '</p>' + (j.listing ? '<p><a href="' + esc(j.listing.path) + '">Back to the PhD</a></p>' : ''); return; }
        if (j.state === 'confirm') return confirmStep(j);
        root.innerHTML = '<h1>Preparing your pack</h1>' +
          '<p class="lead">' + esc(j.supervisor) + ' · ' + esc(j.listing.title) + '</p>' +
          '<div class="progress" role="status"><span class="spinner" aria-hidden="true"></span> ' + esc(j.step || 'Working') + '…</div>' +
          '<p class="small">This usually takes one to three minutes. You can leave this page open, or keep the link and come back: <a href="' + esc(location.href) + '">' + esc(location.href) + '</a></p>';
        if (++tries < 200) setTimeout(tick, tries < 10 ? 2500 : 5000);
      }).catch(function (e) { root.innerHTML = '<h1>PhD preparation pack</h1><p class="error">' + esc(e.message) + '</p>'; });
    })();
  }

  function confirmStep(j) {
    var c = j.candidates || [];
    root.innerHTML = '<h1>Is this the right person?</h1>' +
      '<p class="lead">We found more than one possible publication record for ' + esc(j.supervisor) + ', or couldn’t confirm the match. Pick the one that fits the PhD ' +
      '(<a href="' + esc(j.listing.path) + '">' + esc(j.listing.title) + '</a>).</p>' +
      '<form id="pick" class="match-form">' + c.map(function (a, i) {
        return '<label class="cand"><input type="radio" name="author" value="' + esc(a.id) + '"' + (i === 0 ? ' checked' : '') + '><span><strong>' + esc(a.name) + '</strong> · ' + esc((a.institutions || []).join(', ') || 'institution unknown') +
          ' · ' + esc(a.works) + ' papers<br><span class="small">Topics: ' + esc((a.topics || []).slice(0, 4).join('; ')) + '</span>' +
          (a.sample && a.sample.length ? '<ul class="small">' + li(a.sample) + '</ul>' : '') + '</span></label>';
      }).join('') +
      '<label class="cand"><input type="radio" name="author" value="none"' + (c.length ? '' : ' checked') + '><span><strong>None of these</strong><br><span class="small">' + 'We’ll write the pack from the university profile only, if we found one.' + '</span></span></label>' +
      '<button class="btn btn-brass" type="submit">Continue</button><p class="error" id="pick-error" role="alert"></p></form>';
    document.getElementById('pick').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = (this.querySelector('input[name="author"]:checked') || {}).value, b = this.querySelector('button');
      b.disabled = true;
      post({ action: 'confirm', rid: rid, author: v, cv: getCv() }).then(poll).catch(function (x) { document.getElementById('pick-error').textContent = x.message; b.disabled = false; });
    });
  }

  function render(B) {
    var R = B.report, P = B.papers || {}, L = B.listing, I = B.identity;
    var ref = function (k) { var p = P[k]; if (!p) return ''; return '<a class="ref" href="' + esc(p.url) + '" target="_blank" rel="noopener" title="' + esc(p.title + ' (' + p.year + ')') + '">' + esc(p.year || '?') + '</a>'; };
    var refs = function (a) { return (a || []).length ? ' <span class="refs">' + a.map(ref).join(' ') + '</span>' : ''; };
    var paper = function (k, why, n) {
      var p = P[k]; if (!p) return '';
      return '<li class="paper">' + (n ? '<span class="num">' + n + '</span>' : '') + '<div><h3><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a></h3>' +
        '<p class="small">' + esc(p.authors.join(', ')) + (p.more ? ' +' + p.more : '') + ' · ' + esc(p.venue || 'venue not listed') + ' · ' + esc(p.year) + (p.hasAbstract ? '' : ' · <em>title only, no abstract available</em>') + '</p>' +
        '<p>' + esc(why) + '</p></div></li>';
    };
    var CONF = { high: 'high', medium: 'medium', low: 'low', confirmed: 'confirmed by you' };
    var STAT = { matched: 'Matched', partial: 'Partial', gap: 'Gap', unknown: B.hadCv ? 'Unclear' : 'No CV' };
    var dl = L.deadline ? 'Closes ' + ukDate(L.deadline) : (L.deadline_text || '');
    var chips = [L.funding && '<span class="chip ' + ({ 'Fully funded': 'funded', 'Competition funded': 'comp', 'Self-funded': 'self' }[L.funding] || '') + '">' + esc(L.funding) + '</span>',
      L.stipend && '<span class="chip money">£' + Number(L.stipend).toLocaleString('en-GB') + ' / yr</span>',
      dl && '<span class="chip">' + esc(dl) + '</span>',
      L.eligibility === 'UK/Home only' && '<span class="chip">UK / Home fees only</span>',
      L.eligibility === 'UK & International' && '<span class="chip">Open to international</span>',
      L.start && '<span class="chip">Starts ' + esc(L.start) + '</span>',
      '<span class="chip">' + (B.hadCv ? 'Personalised to your CV' : 'General (no CV)') + '</span>'].filter(Boolean).join('');
    var TEAM = B.team || [{ name: B.supervisor.name, roleLabel: 'Lead supervisor', confidence: I.confidence, profileUrl: B.supervisor.profileUrl, orcid: B.supervisor.orcid, openalex: B.supervisor.openalex }];
    var links = function (m) { return [m.profileUrl && '<a href="' + esc(m.profileUrl) + '" target="_blank" rel="noopener">Profile</a>', m.orcid && '<a href="https://orcid.org/' + esc(m.orcid) + '" target="_blank" rel="noopener">ORCID</a>', m.openalex && '<a href="' + esc(m.openalex) + '" target="_blank" rel="noopener">OpenAlex record</a>'].filter(Boolean).join(' · '); };
    function supSection() {
      var byName = {}; (R.team || []).forEach(function (t) { byName[t.name] = t; });
      var cards = TEAM.map(function (m, i) {
        var t = byName[m.name] || (i === 0 && R.supervisorSummary ? { summary: R.supervisorSummary, refs: [] } : null);
        var conf = m.confidence === 'unconfirmed' || m.confidence === 'not found'
          ? '<span class="st st-gap">Publication record not confirmed</span>' : '';
        return '<div class="sup"><h3>' + esc(m.name) + ' <span class="role">' + esc(m.roleLabel || '') + (m.org ? ' · ' + esc(m.org) : '') + '</span></h3>' + conf +
          (t ? '<p>' + esc(t.summary) + refs(t.refs) + '</p>' : '<p class="small">Named on the advert. We couldn’t confirm their publication record, so this pack says only what the advert says about them.</p>') +
          (i === 0 && R.profileQuote ? '<blockquote>' + esc(R.profileQuote) + '<cite>' + (m.profileUrl ? '<a href="' + esc(m.profileUrl) + '" target="_blank" rel="noopener">University profile</a>' : 'University profile') + '</cite></blockquote>' : '') +
          (links(m) ? '<p class="small">' + links(m) + '</p>' : '') + '</div>';
      }).join('');
      var legacy = (R.coSupervisors || []).map(function (c) { return '<div class="sup"><h3>' + esc(c.name) + '</h3><p>' + esc(c.note) + '</p></div>'; }).join('');
      var fit = R.teamFit ? '<div class="team-fit"><h3>How the team fits together</h3><p>' + esc(R.teamFit) + refs(R.teamFitRefs) + '</p>' +
        ((B.overlap || []).filter(function (o) { return o.n; }).length ? '<p class="small">Shared papers: ' + B.overlap.filter(function (o) { return o.n; }).map(function (o) { return esc(o.a) + ' and ' + esc(o.b) + ': ' + o.n + (o.latest ? ' (latest ' + o.latest + ')' : ''); }).join('; ') + '</p>' : '') + '</div>' : '';
      var others = (R.others || []).length ? '<div class="team-fit"><h3>Also named in the advert</h3><ul>' + li(R.others, function (o) { return '<strong>' + esc(o.name) + '</strong>: ' + esc(o.note); }) + '</ul></div>' : '';
      return '<section id="supervisors"><h2>' + (TEAM.length > 1 ? 'The supervisory team' : 'The supervisor') + '</h2>' + cards + legacy + fit + others + '</section>';
    }
    function fundSection() {
      var F = B.funders || [], f = R.funder || {};
      if (!F.length && !f.summary) return '';
      var ev = F.map(function (x) {
        var rows = (x.per || []).filter(function (p) { return p.acknowledged || p.coauthored || p.worksThere; });
        return '<div class="fund"><h3>' + esc(x.funder) + ' <span class="role">' + esc(x.kind) + '</span></h3>' +
          (rows.length ? '<ul>' + li(rows, function (p) {
            var bits = []; if (p.worksThere) bits.push('works at ' + esc(x.funder)); if (p.acknowledged) bits.push(p.acknowledged + ' paper' + (p.acknowledged > 1 ? 's' : '') + ' acknowledging ' + esc(x.funder));
            if (p.coauthored) bits.push(p.coauthored + ' co-authored with people at ' + esc(x.funder));
            return '<strong>' + esc(p.name) + '</strong>: ' + bits.join('; ') + (p.examples.length ? '<br><span class="small">e.g. ' + p.examples.map(function (e) { return '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a> (' + esc(e.year) + ')'; }).join('; ') + '</span>' : '');
          }) + '</ul>' : '<p class="small">No papers by the team acknowledge or include ' + esc(x.funder) + ' in the records we checked.</p>') + '</div>';
      }).join('');
      return '<section id="funding"><h2>Funding and partners</h2>' +
        (f.summary ? '<p class="label">General background</p><p>' + esc(f.summary) + '</p>' : '') + ev +
        (f.relationship ? '<p><strong>Existing relationship:</strong> ' + esc(f.relationship) + '</p>' : '') +
        ((f.angles || []).length ? '<h3>Angles to raise</h3><ul>' + li(f.angles) + '</ul>' : '') +
        '<p class="small">Evidence from OpenAlex: grant acknowledgements and co-author affiliations on the team’s papers from the last ten years. Records can be incomplete.</p></section>';
    }
    var toc = [['glance', 'At a glance'], ['supervisors', TEAM.length > 1 ? 'The team' : 'The supervisor']].concat((B.funders || []).length || (R.funder && R.funder.summary) ? [['funding', 'Funding and partners']] : []).concat([['read', 'Read these first'], ['thread', 'The research thread'], ['skills', B.hadCv ? 'Skills vs your CV' : 'Skills they look for'], ['questions', 'Open questions'], ['interview', 'Interview prep'], ['bigger', 'Bigger picture'], ['approach', 'Approach angles'], ['method', 'Sources and method']]);
    var S = B.supervisor;
    document.title = 'PhD preparation pack: ' + L.title + ' | Doctum';
    root.innerHTML =
      '<article class="briefing">' +
      '<p class="eyebrow">PhD preparation pack · prepared ' + esc(ukDate(B.created)) + '</p>' +
      '<h1>' + esc(L.title) + '</h1>' +
      '<p class="lead">' + esc(L.institution) + (L.school ? ' · ' + esc(L.school) : '') + ' · lead supervisor ' + esc(S.name) + '</p>' +
      '<p class="chips">' + chips + '</p>' +
      '<p class="idnote idnote-' + esc(I.confidence) + '"><strong>Identity confidence: ' + esc(CONF[I.confidence] || I.confidence) + '.</strong> ' + esc(I.method) + '.' +
        (B.stats.excluded ? ' ' + B.stats.excluded + ' paper' + (B.stats.excluded > 1 ? 's' : '') + ' credited to a different researcher with a similar name were removed (see <a href="#method">Sources and method</a>).' : '') + '</p>' +
      '<div class="brief-actions no-print"><button type="button" class="btn btn-ghost" id="b-print">Print or save as PDF</button><button type="button" class="btn btn-ghost" id="b-copy">Copy link</button><a class="btn btn-ghost" href="' + esc(L.path) + '">Back to the PhD</a><a class="btn btn-brass" href="' + esc(L.url) + '" target="_blank" rel="noopener">Apply at the university ↗</a></div>' +
      '<nav class="toc no-print" aria-label="In this pack">' + toc.map(function (t) { return '<a href="#' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</nav>' +

      '<section id="glance"><h2>At a glance</h2><div class="glance">' +
        '<div><h3>' + (B.hadCv ? 'Why you fit' : 'What a strong applicant brings') + '</h3><ul>' + li(R.atAGlance.whyFit) + '</ul></div>' +
        '<div><h3>' + (B.hadCv ? 'Biggest gaps' : 'Common gaps') + '</h3><ul>' + li(R.atAGlance.gaps) + '</ul></div>' +
        '<div><h3>Do this week</h3><ul>' + li(R.atAGlance.thisWeek) + '</ul></div></div></section>' +

      supSection() + fundSection() +

      '<section id="read"><h2>Read these first</h2><ol class="papers">' + R.readFirst.map(function (x, i) { return paper(x.ref, x.why, i + 1); }).join('') + '</ol>' +
        (R.alsoSkim.length ? '<h3>Also worth skimming</h3><ul>' + li(R.alsoSkim, function (x) { var p = P[x.ref]; return p ? '<a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.title) + '</a> (' + esc(p.year) + '). ' + esc(x.why) : ''; }) + '</ul>' : '') + '</section>' +

      '<section id="thread"><h2>The research thread</h2><p class="small">How the strand of work behind this project has developed. Each step links to dated papers.</p><ol class="thread">' +
        R.thread.map(function (t) { return '<li><span class="when">' + esc(t.period) + '</span><p>' + esc(t.text) + refs(t.refs) + '</p></li>'; }).join('') +
        '<li class="next"><span class="when">Next</span><p>This PhD. <span class="small">From the project advert.</span></p></li></ol>' +
        (R.otherStrands.length ? '<p class="small"><strong>Other strands of their work</strong> (not part of this project, but worth knowing): ' + R.otherStrands.map(esc).join(' ') + '</p>' : '') + '</section>' +

      '<section id="skills"><h2>' + (B.hadCv ? 'What they’ll look for, against your CV' : 'What they’ll look for') + '</h2><div class="table-wrap"><table><thead><tr><th>Skill or knowledge</th><th>Where it shows up in their work</th>' + (B.hadCv ? '<th>Your CV</th><th>Status</th>' : '') + '<th>What to do</th></tr></thead><tbody>' +
        R.skills.map(function (s) { return '<tr><td><strong>' + esc(s.skill) + '</strong></td><td>' + esc(s.evidence) + refs(s.refs) + '</td>' + (B.hadCv ? '<td>' + esc(s.cv) + '</td><td><span class="st st-' + esc(s.status) + '">' + esc(STAT[s.status]) + '</span></td>' : '') + '<td>' + esc(s.action) + '</td></tr>'; }).join('') + '</tbody></table></div></section>' +

      '<section id="questions"><h2>Open questions in their recent work</h2><p class="small">From the papers and the advert. Good material for conversation and interview.</p><ul class="qs">' +
        li(R.openQuestions, function (q) { return '<strong>' + esc(q.q) + '</strong>' + refs(q.refs) + '<br><span class="small">Angle: ' + esc(q.angle) + '</span>'; }) + '</ul></section>' +

      '<section id="interview"><h2>Interview prep</h2><div class="glance"><div><h3>Questions you may be asked</h3><ul>' + li(R.interview.likely) + '</ul></div><div><h3>Questions to ask them</h3><ul>' + li(R.interview.toAsk) + '</ul></div></div></section>' +

      '<section id="bigger"><h2>Bigger picture</h2><p class="label">General background, not from the supervisor’s papers.</p><p>' + esc(R.bigPicture) + '</p></section>' +

      '<section id="approach"><h2>Approach angles</h2><p class="small">Ideas for your first contact. Write the email yourself: supervisors can spot a template.</p><ul>' + li(R.approach) + '</ul></section>' +

      '<section id="method"><h2>Sources and method</h2><ul>' +
        '<li>Identity: ' + esc(I.method) + ' (confidence ' + esc(CONF[I.confidence] || I.confidence) + ').' + (I.notes || []).map(function (n) { return ' ' + esc(n); }).join('') + '</li>' +
        '<li>Publications from <a href="https://openalex.org" target="_blank" rel="noopener">OpenAlex</a>, last ten years' + (B.stats.people > 1 ? ', for ' + B.stats.people + ' people' : '') + ': ' + B.stats.kept + ' kept, ' + B.stats.withAbstracts + ' with abstracts. Papers without abstracts are described from their titles only.</li>' +
        (B.team && B.team.length > 1 ? li(B.team.slice(1), function (m) { return 'Identity, ' + esc(m.name) + ': ' + esc(m.method || 'not found') + ' (' + esc(m.confidence) + ').'; }) : '') +
        '<li>Only abstracts were read, not full papers. Check anything important in the paper itself.</li>' +
        (B.excluded.length ? '<li>Removed as probably a different researcher: <ul>' + li(B.excluded, function (w) { return esc(w.title) + ' (' + esc(w.year) + ', ' + esc(w.field) + ')'; }) + '</ul></li>' : '') +
        li(R.limits) +
        '<li>Written by an AI model (Anthropic’s Claude) from the material above only, with every claim tied to a paper, the profile or the advert. It can still make mistakes. The university’s advert is always the authority.</li></ul>' +
        '<p class="small no-print">This pack is kept for 30 days and anyone with the link can open it. <button type="button" class="btn-link" id="b-del">Delete it now</button></p></section>' +
      '</article>';

    document.getElementById('b-print').onclick = function () { window.print(); };
    document.getElementById('b-copy').onclick = function () { var b = this; (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject()).then(function () { b.textContent = 'Link copied'; }).catch(function () { b.textContent = location.href; }); };
    document.getElementById('b-del').onclick = function () {
      post({ action: 'delete', rid: rid }).then(function () { root.innerHTML = '<h1>Pack deleted</h1><p><a href="' + esc(L.path) + '">Back to the PhD</a></p>'; }).catch(function (x) { document.getElementById('b-del').textContent = x.message; });
    };
  }
})();
