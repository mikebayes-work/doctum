# DoctumCommit / DoctumPull / DoctumReports

Windows helpers for the Doctum repo, adapted from The Grid's GridCommit / GridPull.
The exes sit in the repo root (they are gitignored).

- **DoctumPull.exe**: run BEFORE you start editing. Switches to main, pulls the latest
  from GitHub (including the Tuesday/Friday scrape data), keeps unrelated uncommitted
  edits and deletes local branches whose PRs are merged.
- **DoctumCommit.exe**: run AFTER editing. Commits your changes on a fresh branch off
  the latest main, pushes and opens the PR.
  - **First run** (folder not yet a git repo): creates the repo, commits everything, creates a
    PRIVATE GitHub repo and pushes main. If the GitHub CLI (`gh`) is installed it also sets
    Actions to read/write and adds the `CRAWLER_CONTACT` secret; otherwise it opens
    github.com/new and asks for the repo URL.
  - Moves any workflow files Claude left in `github-workflows/` or
    `tools/move-to-github-workflows/` into `.github/workflows/` (Claude's remote tools can't
    write there).

- **DoctumReports.exe**: builds the private demand reports. Choose a university report (PDF), the UK
  sector report (PDF), all the raw data (CSV) or a sample report with made-up figures. Asks for the
  INSIGHTS_ADMIN_KEY once and saves it in `%USERPROFILE%\.doctum\insights-key.txt` (outside the repo).
  Needs Node.js (`winget install OpenJS.NodeJS.LTS`); PDFs are printed with Edge, already on Windows.

Layout: `main.go` = DoctumCommit, `doctumpull/` = DoctumPull, `doctumreports/` = DoctumReports, `gitx/` = shared helpers.

Rebuild (needs Go, then Node for the icon):
```
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w" -o DoctumCommit.exe .
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w" -o DoctumPull.exe ./doctumpull
GOOS=windows GOARCH=amd64 go build -ldflags "-s -w" -o DoctumReports.exe ./doctumreports
npm i resedit pe-library
node seticon.js DoctumCommit.exe icons/commit.ico "Doctum - commit and open PR"
node seticon.js DoctumPull.exe icons/pull.ico "Doctum - get latest from GitHub"
node seticon.js DoctumReports.exe icons/reports.ico "Doctum - university and sector reports"
```
