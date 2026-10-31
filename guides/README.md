# Guides (blog posts)

Same format as The Grid's briefings. One file per guide; the file name becomes the URL:
`fully-funded-vs-competition-funded-phd.html` → https://doctum.co.uk/guides/fully-funded-vs-competition-funded-phd/

Each file starts with a header between `---` lines, then the article body as HTML
(`<p>`, `<h2>`, `<strong>`, `<ul><li>`, `<a href>`):

```
---
title: Article title (also the Google result title)
date: 2026-11-03            ← YYYY-MM-DD; newest is listed first
tag: Funding
excerpt: One or two sentences. Used on the card and as the Google description.
---
<p>First paragraph…</p>
```

Optional header lines: `description:` (overrides the excerpt for Google) and `draft: true` (skipped).
On deploy, `scripts/pages.js` builds each page, the /guides/ list and the sitemap entry.
