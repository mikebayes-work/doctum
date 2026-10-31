# Doctum

**Funded UK PhDs, matched to you.** doctum.co.uk

A PhD listings site built the same way as The Grid (thegridcareers.co.uk):
static, crawlable pages for Google and AI assistants, with everything clever
(the database, search, ranking, CV matching, AI prompts) on the server in
Netlify Edge Functions.

## How it fits together

```
GitHub Actions (Tue + Fri 05:23 UTC)
  scraper/crawl.py      reads university PhD pages → data/raw/ (not committed)
  scraper/db.py         → data/phd.db (history) → data/listings.json (SERVER-ONLY)
                        → _scrape_manifest.json (per-source counts + alerts)
  commits to main  ─────▶  Netlify build
                            scripts/build.js
                              data/listings.json → netlify/doctum/listings.generated.js
                                                   (bundled INTO the edge functions,
                                                    gitignored, never in dist/)
                              scripts/pages.js → dist/ (≈1,000 static pages,
                                                 sitemap.xml, robots.txt, llms.txt)
                              dist/_headers (CSP, HSTS, etc.)
Browser ──▶ static pages (dist/)
        ──▶ /api/search  /api/phd  /api/stats  /api/match   (netlify/edge-functions/)
```

### What is public and what isn't

| Public (by design, for SEO) | Server only |
|---|---|
| One page per open PhD: title, university, funding, eligibility, deadline, a ~140-word excerpt, link to the university | The database file and the generated JS module |
| Hub pages (subjects, universities, fully funded, international, closing soon) | Search, ranking and facet logic |
| Aggregate data pages (stipends, counts) | CV matching and the AI prompt |
| | Change history (first seen, last changed), raw crawl data |

The full advert text is only served one listing at a time from `/api/phd`.
Search returns at most 20 results per call and 25 pages deep. There is no
"download everything" endpoint.

### Guard rails (carried over from The Grid)

- **Origin allowlist** on every `/api/*`: doctum.co.uk, www, and this site's own
  `*.netlify.app` deploy previews. Other sites get 403.
- **Rate limits** in two layers: Netlify's per-IP `config.rateLimit` in each
  function, plus an in-memory backstop in `netlify/doctum/http.js`.
  *Check your Netlify plan supports code-based rate limits.*
- **Input caps**: search query 120 chars, CV 30,000 chars, body 60 KB; ids must be 12 hex chars.
- **Generic errors** to the visitor, detail only in the function logs.
- **AI**: fixed model and prompt on the server, capped inputs, streamed reply,
  key only in environment variables. Set a monthly **spend cap** in the Anthropic Console.
- **CV privacy**: processed for the request and discarded. Never stored or logged.
- **Scrape safety**: if a source returns 0 adverts or less than half of what was
  live, its existing listings are kept (not marked gone) and the run raises an alert.
- **Build safety**: the build fails if there are 0 open listings, or if any
  `.json/.db/.yaml/.py` or generated file ends up in `dist/`.

## Run it locally

Needs Node 18+ (and Python 3.11 for the scraper).

```
node scripts/build.js          # builds dist/ and the server-only DB module
node scripts/test-api.mjs      # 29 checks: access control, limits, search, match, no leaks
node scripts/dev-server.mjs    # http://localhost:8888 with the APIs running
```

Scraper:

```
pip install requests beautifulsoup4 lxml pyyaml python-dateutil
python -m scraper.crawl            # all sources (or: python -m scraper.crawl leeds qub)
python -m scraper.db build && python -m scraper.db export && python -m scraper.db manifest
```

Sources live in `scraper/sources.yaml`.

## First-time setup

1. **GitHub**: double-click **DoctumCommit.exe** in this folder. On the first run it
   creates the git repo, commits everything, creates a **private** GitHub repo (it holds
   the database), moves the workflow files into `.github/workflows/`, sets Actions to
   read/write and asks for the `CRAWLER_CONTACT` email. After that, the routine is the
   same as The Grid: **DoctumPull** before editing, **DoctumCommit** after (it opens a PR
   with a Netlify deploy preview). See `tools/doctumtools/README.md`.
2. **Netlify**: Add new site → Import from GitHub → pick the repo. The build
   settings come from `netlify.toml`. Environment variables:
   | Name | Value |
   |---|---|
   | `SITE_URL` | `https://doctum.co.uk` |
   | `ALLOW_INDEXING` | leave unset until launch, then `true` |
   | `ANTHROPIC_API_KEY` | optional: turns on "Detailed analysis" |
   | `GA_ID` | optional: Google Analytics 4 id |
3. **Domain**: add doctum.co.uk in Netlify → Domain management, point 123-reg's
   DNS at Netlify (or switch nameservers), and let Netlify issue the certificate.
   Make `www` redirect to the bare domain (or the reverse) so only one is canonical.
4. **Daily rebuild** (optional but recommended): Netlify → Build hooks → create one,
   save the URL as the GitHub secret `NETLIFY_BUILD_HOOK`.
5. **Launch**: set `ALLOW_INDEXING=true`, redeploy, then submit
   `https://doctum.co.uk/sitemap.xml` in Google Search Console and Bing Webmaster Tools.

## Writing guides

See `guides/README.md`. Same header format as The Grid's briefings.

## Brand

`brand/`: logo (light/dark, with and without tagline), mark, favicon, app icons,
og-image (1200×630). Navy `#1B2A4A`, brass `#B08A4E`, parchment `#F6F1E7`.
Headings Cormorant Garamond, body IBM Plex Sans.
