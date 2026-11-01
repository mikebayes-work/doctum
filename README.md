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
pip install -r requirements.txt
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
   | `ANTHROPIC_API_KEY` | optional: turns on "Detailed analysis" and Opportunity briefings |
   | `BRIEFING_ACCESS_CODE` | optional: if set, briefings need this code (use it for a closed test) |
   | `BRIEFING_DAILY_LIMIT` / `BRIEFING_PER_IP` | optional caps while briefings are free (defaults 30 a day in total, 3 per IP) |
   | `BRIEFING_MODEL` | optional: model for briefings (default `claude-sonnet-5-5`) |
   | `BRIEFINGS` | set to `off` to switch briefings off without removing the key |
   | `OPENALEX_API_KEY` | optional: OpenAlex key, if you register one |
   | `GA_ID` | optional: Google Analytics 4 id |
3. **Domain**: add doctum.co.uk in Netlify → Domain management, point 123-reg's
   DNS at Netlify (or switch nameservers), and let Netlify issue the certificate.
   Make `www` redirect to the bare domain (or the reverse) so only one is canonical.
4. **Daily rebuild** (optional but recommended): Netlify → Build hooks → create one,
   save the URL as the GitHub secret `NETLIFY_BUILD_HOOK`.
5. **Launch**: set `ALLOW_INDEXING=true`, redeploy, then submit
   `https://doctum.co.uk/sitemap.xml` in Google Search Console and Bing Webmaster Tools.

## Opportunity briefings (supervisor deep dive)

`/briefing/?id=<listing>` asks which supervisor (and, optionally, a CV), then `/api/briefing`
(netlify/functions/briefing.mjs) starts `briefing-background` (a Netlify Background Function,
up to 15 minutes) with a signed request. The worker:

1. finds the supervisor's university profile through the advert's own link (robots.txt respected),
2. matches them to OpenAlex by the ORCID on the profile, or by name + institution with an ORCID
   employment or profile-DOI cross-check, giving high / medium / low confidence,
3. on low confidence stops and asks the student to pick the right researcher, before any AI cost,
4. fetches ten years of works, removes papers from merged namesakes (co-author/affiliation graph),
   ranks papers against the advert,
5. makes one AI call that may use only that material, then drops any citation to a paper that
   wasn't supplied and any profile "quote" that isn't verbatim.

Jobs, results and caches live in Netlify Blobs (store `briefings`): results for 30 days, identity
and works per supervisor for 14 days. The CV is never stored. Logic is in `netlify/doctum/briefing.js`
and `netlify/doctum/jobs.js`; `node scripts/test-briefing.mjs` runs the whole flow offline against
a local Blobs server and mocked OpenAlex, ORCID, university pages and Anthropic.

Paywall later: the entitlement check goes where the access-code check is in `briefing.mjs`.

## Writing guides

See `guides/README.md`. Same header format as The Grid's briefings.

## Brand

`brand/`: logo (light/dark, with and without tagline), mark, favicon, app icons,
og-image (1200×630). Navy `#1B2A4A`, brass `#B08A4E`, parchment `#F6F1E7`.
Headings Cormorant Garamond, body IBM Plex Sans.

## Doctum Observatory (/observatory/)

A live, public tracker of the UK PhD market built from our own adverts. After each scrape, `python -m scraper.observatory` appends a dated snapshot to `data/observatory.json` (server-only, never published). `scripts/observatory.js` draws the page at build time: headline figures, funding, eligibility, deadlines by month, subjects, stipend bands against the UKRI minimum, what adverts disclose, top universities, nations, and a trend line once there are three or more snapshots. "New" adverts exclude anything found by a source's first productive run or by a run whose new count jumps past 40% of that source's size (coverage changes, not new PhDs), and only count from the date tracking started. Update the UKRI rate in `scripts/observatory.js` each year.

## Demand insights (private): what applicants look for

Anonymous counts of searches, filters, CV-match choices and advert interest, plus coarse CV categories from applicants who tick "Count me" on the CV match form. No identifiers are ever stored (no IP, hash, cookie or session id). See `netlify/doctum/insights.js` for the full privacy design and `/privacy/#statistics` for the public wording.

- Logged by `/api/search`, `/api/match`, `/api/briefing` (preparation pack starts) and `/api/event` (advert viewed, apply clicked, saved; sent by `assets/search.js` with `navigator.sendBeacon`).
- Stored in Netlify Blobs, store `insights`. `insights-rollup` (scheduled, 03:17 UTC daily) folds each day into `week/<yyyy-Www>` counts and deletes the raw events.
- Reports: `GET /api/insights?report=…` with header `x-doctum-admin: <INSIGHTS_ADMIN_KEY>` (404 without it). Reports: summary, terms, filters, demand, applicants (dims), skills, listings (optionally `inst=`), search (dims). Any applicant figure under 10 is suppressed.
- Download everything as CSV: `set INSIGHTS_ADMIN_KEY=…` then `node scripts/insights-report.mjs 2026-W45 2026-W52 ["University name"]` → `reports/insights/` (gitignored).
- Environment: `INSIGHTS_ADMIN_KEY` (at least 24 characters) to enable reports; `INSIGHTS=off` stops all logging.
- Test offline: `node scripts/test-insights.mjs`.

