// DoctumCommit - one double-click to commit Doctum repo changes and open a PR.
// Adapted from The Grid's GridCommit.
//
// Put DoctumCommit.exe in the doctum folder and double-click it.
//
// FIRST RUN (folder not on GitHub yet): creates the git repo, makes the first
// commit, creates a PRIVATE GitHub repo and pushes main. With the GitHub CLI
// (gh) it also sets Actions to read/write and adds the CRAWLER_CONTACT secret.
//
// EVERY RUN AFTER THAT (same as GridCommit):
//   - checks GitHub: refuses if main has a newer copy of a file you've changed
//     (the twice-weekly scrape commits data/ to main; phd.db can't be merged)
//   - if you're on main, or on an old branch that's already been merged, starts a
//     fresh branch from the LATEST main (your changes come with you)
//   - shows what will be committed, asks for a one-line description
//   - commits, pushes, and opens/creates the pull request
package main

import (
	"fmt"
	"strings"
	"time"

	g "doctumtools/gitx"
)

func main() { g.Main("Doctum - commit & PR", run) }

func run() {
	wd := g.ToExeDir()
	g.NeedGit()
	if !g.IsRepo() {
		firstTime(wd)
		return
	}
	if _, err := g.Git("remote", "get-url", "origin"); err != nil {
		fmt.Println("Repo:   ", wd)
		fmt.Println("\nThis repo isn't connected to GitHub yet.")
		connect(wd)
		return
	}
	g.Setup()
	g.MoveStagedWorkflows()

	branch := g.CurrentBranch()
	fmt.Println("Branch: ", branch)

	files, skipped := g.Changes()
	if len(skipped) > 0 {
		fmt.Println("\nLeft out (local working files):", g.Names(skipped))
	}
	if len(files) == 0 {
		fmt.Println("\nNothing to commit - your folder matches the last commit.")
		return
	}

	// GitHub check
	fmt.Println("\nChecking GitHub for newer changes on main...")
	online := g.Fetch()
	behind, unique := 0, 1
	if !online {
		fmt.Println("  ! Couldn't reach GitHub (offline?). Carrying on, but the push may fail.")
	} else {
		if clash := g.Overlap(files, g.UpstreamChanged()); len(clash) > 0 {
			panic("main on GitHub has newer versions of files you've changed:\n    " +
				strings.Join(clash, "\n    ") +
				"\n  (Usually the Tuesday/Friday scrape updated data/.)" +
				"\n  Nothing was committed. Next time run DoctumPull BEFORE editing." +
				"\n  Ask Claude to help redo this change.")
		}
		behind = g.Count("HEAD..origin/main")
		unique = g.Count("origin/main..HEAD")
		if behind > 0 {
			fmt.Printf("  main has %d newer commit(s) on GitHub, none touching your files - OK.\n", behind)
		} else {
			fmt.Println("  Up to date.")
		}
	}

	// Show + confirm
	fmt.Println("\nFiles to commit:")
	for _, f := range files {
		fmt.Printf("   %-9s %s\n", f.Label(), f.Path)
	}
	if !g.Ask(fmt.Sprintf("\nCommit these %d file(s)? [Y/n] ", len(files)), true) {
		fmt.Println("Cancelled - nothing changed.")
		return
	}
	msg := g.Prompt("One-line description (e.g. \"Add Sheffield source\"): ")
	if msg == "" {
		msg = "Update " + time.Now().Format("2006-01-02 15:04")
	}

	// Branch. Fresh branch from the latest main when on main, or on an old
	// branch whose commits are all already in main (i.e. its PR was merged).
	onMain := branch == "main" || branch == "master" || branch == "HEAD"
	staleBranch := !onMain && online && unique == 0
	if onMain || staleBranch {
		if staleBranch {
			fmt.Printf("\n'%s' has already been merged - starting a fresh branch instead.\n", branch)
		}
		newBranch := g.Slug(msg) + "-" + time.Now().Format("0102-1504")
		base := "HEAD"
		if online {
			base = "origin/main" // carry your changes onto the latest main
		}
		g.Must(g.Git("checkout", "-b", newBranch, base))
		if onMain && online && behind > 0 {
			g.Git("branch", "-f", "main", "origin/main") // keep local main current too
		}
		fmt.Println("Created branch:", newBranch)
		branch = newBranch
	}

	// Stage exactly the listed files, commit, push
	args := []string{"add", "-A", "--"}
	for _, f := range files {
		args = append(args, f.Path)
	}
	g.Must(g.Git(args...))
	g.Must(g.Git("commit", "-m", msg))
	fmt.Println("Committed.")
	fmt.Println("Pushing to GitHub...")
	if out, err := g.Git("push", "-u", "origin", branch); err != nil {
		panic("Push failed:\n" + out)
	}
	fmt.Println("Pushed.")

	// Pull request
	if out, err := g.Run("gh", "pr", "create", "--base", "main", "--head", branch,
		"--title", msg, "--body", "Committed with DoctumCommit."); err == nil {
		url := strings.TrimSpace(g.LastLine(out))
		fmt.Println("\nOK  Pull request created:", url)
		g.OpenBrowser(url)
		fmt.Println("  Check the Netlify deploy preview on the PR, then merge.")
		fmt.Println("  After merging, run DoctumPull.")
		return
	} else if strings.Contains(out, "already exists") {
		fmt.Println("\nOK  Pushed to the existing pull request for", branch)
		return
	}
	if repo := g.RepoSlug(); repo != "" {
		url := fmt.Sprintf("https://github.com/%s/compare/main...%s?expand=1", repo, branch)
		fmt.Println("\nOK  Done. Opening the PR page - press \"Create pull request\":")
		fmt.Println("  ", url)
		g.OpenBrowser(url)
		fmt.Println("  After merging, run DoctumPull.")
	} else {
		fmt.Println("\nOK  Pushed. Open GitHub to create the pull request.")
	}
}

// ─── First run ────────────────────────────────────────────────────────────

func firstTime(wd string) {
	fmt.Println("Folder: ", wd)
	fmt.Println("\nThis folder isn't a git repo yet. First-time setup will:")
	fmt.Println("   1. create the repo here and commit everything as \"Doctum: first version\"")
	fmt.Println("   2. create a PRIVATE GitHub repo and push it (private: it holds the database)")
	fmt.Println("   3. set up GitHub Actions for the Tuesday/Friday scrape")
	if !g.Ask("\nGo ahead? [Y/n] ", true) {
		fmt.Println("Cancelled - nothing changed.")
		return
	}

	// git identity (commits fail without it)
	if name, _ := g.Git("config", "user.name"); strings.TrimSpace(name) == "" {
		n := g.Prompt("Your name for commits (e.g. Mike Bayes): ")
		g.Must(g.Git("config", "--global", "user.name", n))
	}
	if email, _ := g.Git("config", "user.email"); strings.TrimSpace(email) == "" {
		e := g.Prompt("Your email for commits: ")
		g.Must(g.Git("config", "--global", "user.email", e))
	}

	if _, err := g.Git("init", "-b", "main"); err != nil {
		g.Must(g.Git("init"))
		g.Must(g.Git("checkout", "-b", "main"))
	}
	g.MoveStagedWorkflows()
	g.Must(g.Git("add", "-A"))
	for _, f := range g.Lines(g.Must(g.Git("-c", "core.quotepath=off", "diff", "--cached", "--name-only"))) {
		if g.IsSkipped(f) {
			g.Git("rm", "--cached", "-q", "--", f)
		}
	}
	n := len(g.Lines(g.Must(g.Git("diff", "--cached", "--name-only"))))
	fmt.Printf("\nCommitting %d files...\n", n)
	g.Must(g.Git("commit", "-q", "-m", "Doctum: first version"))
	fmt.Println("Committed.")
	connect(wd)
}

// connect creates the GitHub repo (via gh) or links one you made on github.com, then pushes main.
func connect(wd string) {
	useGh := false
	if g.Has("gh") {
		if _, err := g.Run("gh", "auth", "status"); err != nil {
			fmt.Println("\nThe GitHub CLI needs you to log in (a browser window will open)...")
			g.RunLive("gh", "auth", "login", "--web", "--git-protocol", "https")
		}
		_, err := g.Run("gh", "auth", "status")
		useGh = err == nil
	}

	if useGh {
		name := g.Prompt("\nGitHub repo name [doctum]: ")
		if name == "" {
			name = "doctum"
		}
		fmt.Println("Creating private repo", name, "and pushing...")
		if out, err := g.Run("gh", "repo", "create", name, "--private", "--source", ".",
			"--remote", "origin", "--description", "Doctum: funded UK PhDs, matched to you", "--push"); err != nil {
			panic("Couldn't create the GitHub repo:\n" + out +
				"\n  If the name is taken, run DoctumCommit again and pick another name.")
		}
	} else {
		fmt.Println("\nThe GitHub CLI (gh) isn't set up, so make the repo on the website:")
		fmt.Println("   - Repository name: doctum")
		fmt.Println("   - Choose PRIVATE")
		fmt.Println("   - Do NOT add a README, .gitignore or licence")
		g.OpenBrowser("https://github.com/new")
		url := g.Prompt("\nPaste the repo URL (https://github.com/<you>/doctum.git): ")
		if !strings.Contains(url, "github.com") {
			panic("That doesn't look like a GitHub URL. Run DoctumCommit again.")
		}
		g.Must(g.Git("remote", "add", "origin", url))
		fmt.Println("Pushing...")
		if out, err := g.Git("push", "-u", "origin", "main"); err != nil {
			panic("Push failed:\n" + out)
		}
	}
	repo := g.RepoSlug()
	fmt.Println("\nOK  Pushed to GitHub:", repo)

	// Actions settings (needs gh; otherwise print the clicks)
	if useGh && repo != "" {
		if _, err := g.Run("gh", "api", "-X", "PUT", "repos/"+repo+"/actions/permissions/workflow",
			"-f", "default_workflow_permissions=write"); err == nil {
			fmt.Println("OK  Actions can commit the scrape results (read/write permission).")
		} else {
			fmt.Println("!   Set Settings > Actions > General > Workflow permissions > Read and write.")
		}
		email := g.Prompt("\nContact email for the crawler's User-Agent (Enter to skip): ")
		if email != "" {
			if out, err := g.Run("gh", "secret", "set", "CRAWLER_CONTACT", "--repo", repo, "--body", email); err == nil {
				fmt.Println("OK  Secret CRAWLER_CONTACT set.")
			} else {
				fmt.Println("!   Couldn't set the secret:", g.LastLine(out))
			}
		}
	} else if repo != "" {
		fmt.Println("\nTwo clicks left on GitHub:")
		fmt.Println("   Settings > Actions > General > Workflow permissions > Read and write")
		fmt.Println("   Settings > Secrets and variables > Actions > New secret CRAWLER_CONTACT = your email")
	}
	if repo != "" {
		g.OpenBrowser("https://github.com/" + repo)
	}
	fmt.Println("\nNext: connect the repo to Netlify. From now on: DoctumPull before editing, DoctumCommit after.")
}
