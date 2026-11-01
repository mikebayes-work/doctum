// scripts/explainer.js — the /phd-preparation-pack/ page: what a pack is, how it is
// made, and an example. The example is a real Doctum preparation pack (31 Oct 2026) with the
// supervisors, university, project title and paper titles removed, so nobody is identifiable.
// Rendered with the same markup and classes as public/assets/briefing.js.

const A = (t) => `<span class="anon">${t}</span>`;
const ref = (y) => `<span class="ref">${y}</span>`;

const SAMPLE = `
<article class="briefing">
<p class="eyebrow">PhD preparation pack · example</p>
<h2 style="margin-top:.2em;font-size:clamp(1.6rem,3.4vw,2.3rem)">${A('AI tools for optical and camera design')}</h2>
<p class="lead">${A('A UK university')} · lead supervisor ${A('Supervisor A')}</p>
<p class="chips"><span class="chip funded">Fully funded</span><span class="chip">Closes ${A('in January')}</span><span class="chip">General (no CV)</span></p>
<p class="idnote idnote-high"><strong>Identity confidence: high.</strong> ORCID record lists the university as an employer. Profile found through the advert’s own link.</p>

<section><h2>At a glance</h2><div class="glance">
<div><h3>What a strong applicant brings</h3><ul>
<li>Strong Python and PyTorch skills, shown by building and benchmarking learned rendering or generative models, fit the group’s recent 3D Gaussian splatting work.</li>
<li>Grounding in physics-based rendering or optics would link directly to the advert’s forward simulation and inverse lens design aims.</li>
<li>Interest in turning AI research into engineering tools with industry partners matches the advert’s stated emphasis.</li></ul></div>
<div><h3>Common gaps</h3><ul>
<li>None of the supervisor’s papers covers lens design or optics, so a candidate must show how their background bridges to optical systems.</li>
<li>Ray tracing and differentiable optics are only “desirable” in the advert, but they will be the technical core of this project.</li>
<li>The industry partner and data sources are not named in the advert, so the practical scope is unclear.</li></ul></div>
<div><h3>Do this week</h3><ul>
<li>Read the three papers below, noting how each ties rendering quality to efficiency and evaluation.</li>
<li>Write a one-page note on how a differentiable renderer could model a simple lens, to test your own understanding.</li>
<li>Check the programme page and send the required title-and-supervisor document before the deadline.</li></ul></div>
</div></section>

<section><h2>The supervisors</h2>
<div class="sup"><h3>${A('Supervisor A')}</h3><p>The profile lists computer vision, graphics, machine learning, media production, digital humans and volumetric video. Recent papers focus on 3D Gaussian splatting: lighting, efficiency and avatars. Earlier work covers multi-view and light-field video capture, human reconstruction and super-resolution.</p>
<p class="small">Profile · ORCID · OpenAlex record (links in the real pack)</p></div>
<div class="sup"><h3>${A('Supervisor B')}</h3><p>Shares several recent papers with ${A('Supervisor A')}, including most of the Gaussian splatting work below. Their specific role in this project is not stated.</p></div>
</section>

<section><h2>Read these first</h2><ol class="papers">
<li class="paper"><span class="num">1</span><div><h3>${A('A 2025 conference paper on relightable Gaussian splatting')}</h3><p class="small">Conference paper · 2025</p>
<p>Splits diffuse and specular reflection in Gaussian splatting for novel views under changing lighting, with photometric and physics-based supervision. Closest of their work to physically grounded, differentiable appearance modelling, which this project needs.</p></div></li>
<li class="paper"><span class="num">2</span><div><h3>${A('A 2025 paper on faster, leaner Gaussian splatting training')}</h3><p class="small">Conference paper · 2025</p>
<p>A coarse-to-fine training scheme that substantially cut model size, GPU memory and training time without losing visual quality. Shows the group’s approach to making learned rendering cheaper to train, relevant to simulating many candidate lenses.</p></div></li>
<li class="paper"><span class="num">3</span><div><h3>${A('A 2026 preprint on efficient 3D head avatars for phones')}</h3><p class="small">Preprint · 2026</p>
<p>Efficient generator for 3D Gaussian heads, evaluated on image quality, multi-view consistency, training cost and deployment. Shows how the group judges learned models beyond one metric, which matters for mapping lens parameters to image quality.</p></div></li>
</ol>
<p class="small">The real pack links each paper’s DOI and lists four more “worth skimming”.</p></section>

<section><h2>The research thread</h2><p class="small">How the strand of work behind this project has developed. Each step links to dated papers.</p><ol class="thread">
<li><span class="when">2016–17</span><p>Early work on view-dependent shape and appearance from multi-view video, and on temporally coherent light-field video. The group’s base in appearance capture. ${ref(2016)} ${ref(2017)}</p></li>
<li><span class="when">2021</span><p>Learned image enhancement: multi-reference super-resolution with attention and a perceptual loss, tackling an ill-posed image problem. ${ref(2021)}</p></li>
<li><span class="when">2025</span><p>Moves to 3D Gaussian splatting. Dual spherical harmonics model diffuse and specular light for relighting. Frequency-modulated training cuts memory and optimisation time. ${ref(2025)} ${ref(2025)}</p></li>
<li><span class="when">2026</span><p>Efficient generative Gaussian head avatars that run on ordinary devices, with large cuts in computation. ${ref(2026)}</p></li>
<li class="next"><span class="when">Next</span><p>This PhD. <span class="small">From the project advert.</span></p></li></ol>
<p class="small"><strong>Other strands of their work</strong> (not part of this project, but worth knowing): human reconstruction from single images; motion capture and multi-person pose tracking; audio-visual datasets for media production.</p></section>

<section><h2>What they’ll look for</h2><div class="table-wrap"><table><thead><tr><th>Skill or knowledge</th><th>Where it shows up in their work</th><th>What to do</th></tr></thead><tbody>
<tr><td><strong>Differentiable or physics-based rendering</strong></td><td>Dual spherical harmonics with physics-based supervision in Gaussian splatting. ${ref(2025)}</td><td>Work through a small differentiable renderer, such as a Gaussian splatting tutorial, and note its limits for optics.</td></tr>
<tr><td><strong>Ray tracing and geometric optics</strong></td><td>Not shown in their papers; the advert lists optics and ray tracing as desirable.</td><td>Learn thin-lens and multi-element ray tracing basics, and aberrations, enough to discuss lens parameters and image quality.</td></tr>
<tr><td><strong>Evaluation of image quality</strong></td><td>Image-quality metrics plus multi-view consistency, training cost and deployment performance. ${ref(2026)} ${ref(2025)}</td><td>Read about PSNR, SSIM and LPIPS, and be able to say when each misleads.</td></tr>
<tr><td><strong>Efficient training</strong></td><td>Smaller models, less GPU memory and faster training without losing visual quality. ${ref(2025)}</td><td>Note any GPU or HPC experience, and how you profile and reduce training cost.</td></tr>
<tr><td><strong>Camera systems and calibration</strong></td><td>Multi-camera calibration; large camera arrays for production datasets. ${ref(2024)}</td><td>Describe hands-on work with cameras, calibration or capture setups, if any.</td></tr>
</tbody></table></div>
<p class="small">With a CV, this table adds a “Your CV” column and a Matched / Partial / Gap status for each row.</p></section>

<section><h2>Open questions in their recent work</h2><ul class="qs">
<li><strong>How might the group’s differentiable rendering be extended to model lens effects through explicit optical parameters?</strong> ${ref(2025)}<br><span class="small">Angle: ask whether the plan is a learned surrogate for ray tracing or a physically based differentiable model, and why.</span></li>
<li><strong>Which perceptual or image-quality objectives should drive inverse lens design for cinema, and who defines them?</strong> ${ref(2026)} ${ref(2021)}<br><span class="small">Angle: link their multi-metric evaluation and perceptual-loss work to how a cinematic “look” would be measured.</span></li>
</ul></section>

<section><h2>Interview prep</h2><div class="glance">
<div><h3>Questions you may be asked</h3><ul><li>What do you know about differentiable rendering? How would you model a camera lens in it?</li><li>How would you judge whether a learned model of lens behaviour is trustworthy against ray tracing?</li><li>Why this project rather than a general computer vision PhD?</li></ul></div>
<div><h3>Questions to ask them</h3><ul><li>Who is the industry partner, and what access to lens data or designs is expected?</li><li>What would a strong first-year outcome look like?</li><li>What compute resources and training support are available?</li></ul></div>
</div>
<p class="small">The full pack continues with the bigger picture (general background), approach angles for your first email, and sources and method.</p></section>
</article>`;

function explainerBody({ openCount }) {
  return `
<article>
<p class="eyebrow">PhD preparation packs</p>
<h1>Walk into your PhD application prepared</h1>
<p class="lead">Supervisors notice the applicants who have read their work. A PhD preparation pack does that groundwork for one PhD: who is on the supervisory team, which of their papers matter for this project, how their research got here, what they’ll look for, and what to ask. Every point links to the paper it comes from.</p>
<p><a class="btn btn-brass" href="/">Find a PhD</a> <a class="btn btn-ghost" href="#example">See an example</a></p>

<div class="rule-head"><h2>What’s in a preparation pack</h2></div>
<ul class="principles">
<li><strong>At a glance</strong>Why you fit (or what a strong applicant brings), the biggest gaps, and what to do this week.</li>
<li><strong>Read these first</strong>The three papers closest to the project, each with what it found and why it matters to you.</li>
<li><strong>The research thread</strong>A dated timeline of how the supervisor’s work led to this PhD, plus the other strands worth knowing.</li>
<li><strong>What they’ll look for</strong>Each skill, where it shows up in their work and what to do about it. Add your CV and each row is marked Matched, Partial or Gap.</li>
<li><strong>Open questions</strong>Problems their recent papers leave open, each with an angle for conversation or interview.</li>
<li><strong>The team and the funder</strong>Every supervisor named on the advert, including industry partners, how their work fits together, and what the funder means for you, with evidence from their own papers.</li>
<li><strong>Interview prep</strong>Questions you may be asked, questions to ask them, and the wider context for the field.</li>
</ul>

<div class="rule-head"><h2>How it’s made</h2></div>
<ol class="how">
<li><strong>Find the right people</strong>Doctum follows the advert’s link to each supervisor’s university profile, then confirms them through ORCID and their publication record. Industry supervisors are found through the company named in the advert.</li>
<li><strong>Check it’s really them</strong>Papers by namesakes are removed and listed. If the match isn’t certain, you pick the right researcher before anything is written.</li>
<li><strong>Read their recent work</strong>Up to ten years of papers from OpenAlex, ranked against the advert (and your CV, if you add it).</li>
<li><strong>Write the pack</strong>An AI model writes from that material only. Any reference to a paper that wasn’t supplied, or a quote that isn’t word for word, is removed automatically.</li>
</ol>

<div class="rule-head"><h2>What it won’t do</h2></div>
<ul>
<li><strong>It isn’t a ready-made email.</strong> It gives you angles and questions; write the email yourself. Supervisors can spot a template.</li>
<li><strong>It reads abstracts, not full papers.</strong> Check anything important in the paper itself. Papers without abstracts are described by topic only.</li>
<li><strong>It uses public, professional information only:</strong> the university profile, ORCID and published papers. Never Google Scholar, and nothing personal.</li>
<li><strong>It doesn’t replace the advert.</strong> The university’s page is always the authority on eligibility, funding and deadlines.</li>
</ul>

<div class="rule-head" id="example"><h2>An example preparation pack</h2></div>
<p>This is a real Doctum preparation pack for a fully funded computer vision PhD, generated without a CV. We’ve removed the supervisors’ names, the university, the project title, the paper titles and other identifying details, and shortened some sections. Everything else is as the student would see it.</p>
<div class="sample"><span class="sample-label">Example · names and titles removed</span>${SAMPLE}</div>

<div class="rule-head"><h2>Questions</h2></div>
<dl class="faq">
<dt>How much does it cost?</dt><dd>Preparation packs are free while we test them, with a small daily limit per person.</dd>
<dt>How long does it take?</dt><dd>Usually one to three minutes. You get a private link and can come back to it.</dd>
<dt>Do I need to add my CV?</dt><dd>No. Without one you get a general pack; with one, the skills table and “why you fit” are about you.</dd>
<dt>What happens to my CV?</dt><dd>It is used to write your pack and then discarded. The pack itself is kept for 30 days under a private link, and you can delete it sooner. See <a href="/privacy/">Privacy</a>.</dd>
<dt>What if it picks the wrong supervisor?</dt><dd>If Doctum isn’t sure, it asks you to choose before writing anything. Each pack states how the supervisor was identified and how confident the match is.</dd>
<dt>I’m a supervisor and something is wrong.</dt><dd>Email <a href="mailto:hello@doctum.co.uk">hello@doctum.co.uk</a> and we’ll correct it.</dd>
</dl>

<aside class="cta"><div><h2>Prepare for a PhD</h2><p>Open any of the ${openCount} open PhDs and choose <strong>Prep pack</strong>.</p></div><a class="btn btn-brass" href="/">Search PhDs</a></aside>
</article>`;
}

module.exports = { explainerBody };
