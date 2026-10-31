// DoctumPull - one double-click to get the latest Doctum repo from GitHub.
// Adapted from The Grid's GridPull.
//
// Put DoctumPull.exe in the doctum folder and double-click it. It:
//   - picks up the Tuesday/Friday scrape results the bot committed to main
//   - switches you back to main (from a merged PR branch, for example)
//   - brings main up to date with GitHub, keeping any edits you haven't committed
//     as long as GitHub hasn't changed the same files
//   - deletes local branches whose PRs have been merged
//   - shows what came down
package main

import (
	"fmt"
	"strings"

	g "doctumtools/gitx"
)

func main() { g.Main("Doctum - get latest from GitHub", run) }

func run() {
	g.Setup()
	branch := g.CurrentBranch()
	fmt.Println("Branch: ", branch)

	fmt.Println("\nChecking GitHub...")
	if !g.Fetch() {
		panic("Couldn't reach GitHub (offline?). Nothing changed.")
	}

	files, _ := g.Changes()

	// Uncommitted edits that GitHub has also changed would be overwritten / conflict.
	if len(files) > 0 {
		upstream := lines(g.Git("diff", "--name-only", "HEAD", "origin/main"))
		if clash := g.Overlap(files, upstream); len(clash) > 0 {
			panic("You have unsaved edits to files that are also newer on GitHub:\n    " +
				strings.Join(clash, "\n    ") +
				"\n  Nothing was changed. Either commit them first with DoctumCommit," +
				"\n  or, if you don't need the edits, discard them in VS Code" +
				"\n  (Source Control -> right-click the file -> Discard Changes) and run this again.")
		}
		fmt.Printf("  You have %d uncommitted change(s) - they'll be kept:\n", len(files))
		for _, f := range files {
			fmt.Printf("     %-9s %s\n", f.Label(), f.Path)
		}
	}

	// Leave a feature branch: warn if it has work that isn't on main yet.
	if branch != "main" {
		if n := g.Count("origin/main..HEAD"); n > 0 {
			fmt.Printf("\n  ! '%s' has %d commit(s) that aren't on main yet (PR not merged?).\n", branch, n)
			fmt.Println("    They stay safe on that branch if you switch.")
			if !g.Ask("    Switch to main anyway? [y/N] ", false) {
				fmt.Println("Cancelled - nothing changed.")
				return
			}
		}
		if out, err := g.Git("checkout", "main"); err != nil {
			panic("Couldn't switch to main:\n" + out)
		}
		fmt.Println("\nSwitched to main.")
	}

	before := strings.TrimSpace(g.Must(g.Git("rev-parse", "HEAD")))
	behind := g.Count("HEAD..origin/main")
	if behind == 0 {
		fmt.Println("\nAlready up to date with GitHub.")
	} else {
		if out, err := g.Git("merge", "--ff-only", "origin/main"); err != nil {
			panic("Couldn't update main:\n" + out +
				"\n  (Your local main has commits GitHub doesn't. Ask Claude to help sort it out.)")
		}
		fmt.Printf("\nOK  Pulled %d new commit(s):\n", behind)
		for _, l := range lines(g.Git("log", "--format=   %h  %ad  %s", "--date=format:%d %b %H:%M", before+"..HEAD")) {
			fmt.Println(l)
		}
		stat := lines(g.Git("diff", "--stat=70", before, "HEAD"))
		if len(stat) > 0 {
			fmt.Println("\n  Files updated:")
			for _, l := range stat {
				fmt.Println("  " + l)
			}
		}
	}

	// Tidy: delete local branches already merged into main
	var gone []string
	for _, b := range lines(g.Git("branch", "--format=%(refname:short)", "--merged", "main")) {
		b = strings.TrimSpace(b)
		if b == "" || b == "main" || b == "master" {
			continue
		}
		if _, err := g.Git("branch", "-d", b); err == nil {
			gone = append(gone, b)
		}
	}
	if len(gone) > 0 {
		fmt.Println("\nTidied up merged branches:", strings.Join(gone, ", "))
	}

	fmt.Println("\nOK  You're on the latest main. Make your changes, then run DoctumCommit.")
}

func lines(out string, _ error) []string { return g.Lines(out) }
