// Package gitx holds the helpers shared by DoctumCommit and DoctumPull.
// Adapted from The Grid's tools/gridcommit/gitx (same behaviour, Doctum names).
package gitx

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// Local working files that are never committed and never block a pull.
// (.gitignore covers most of these too; this is belt and braces.)
var SkipPatterns = []string{
	"__pycache__/",
	".pyc",
	"data/raw/",
	"dist/",
	".netlify/",
	"node_modules/",
	"listings.generated.js",
	"~$",
	"DoctumCommit",
	"DoctumPull",
}

var In = bufio.NewReader(os.Stdin)

// Main wraps a tool's run function: panics become friendly messages and the
// console window stays open until Enter.
func Main(title string, run func()) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Println("\nX", r)
		}
		fmt.Print("\nPress Enter to close...")
		In.ReadString('\n')
	}()
	fmt.Println("==============================================")
	fmt.Println("  " + title)
	fmt.Println("==============================================")
	run()
}

// ToExeDir moves into the exe's folder (where it was double-clicked).
func ToExeDir() string {
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if _, err := os.Stat(filepath.Join(dir, "netlify.toml")); err == nil {
			os.Chdir(dir)
		} else if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			os.Chdir(dir)
		}
	}
	wd, _ := os.Getwd()
	return wd
}

func NeedGit() {
	if _, err := exec.LookPath("git"); err != nil {
		panic("git isn't installed or isn't on PATH.\n  Install it from https://git-scm.com/download/win and run this again.")
	}
}

func IsRepo() bool {
	_, err := os.Stat(".git")
	return err == nil
}

// Setup checks git is usable and we're in the Doctum repo.
func Setup() {
	wd := ToExeDir()
	NeedGit()
	if _, err := Git("rev-parse", "--is-inside-work-tree"); err != nil || !IsRepo() {
		panic("This isn't a git repo yet: " + wd + "\n  Run DoctumCommit first: it sets the repo up on GitHub.")
	}
	fmt.Println("Repo:   ", wd)
	if locks, _ := filepath.Glob("~$*.xlsx"); len(locks) > 0 {
		panic("Excel still has a spreadsheet open (" + strings.Join(locks, ", ") + ").\n  Close Excel and run this again.")
	}
}

// ─── git ──────────────────────────────────────────────────────────────────

// Git runs git with no stdin (so any "Should I try again? (y/n)" prompt
// auto-answers no instead of hanging) and returns trimmed combined output.
func Git(args ...string) (string, error) { return Run("git", args...) }

func Run(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimRight(string(out), "\r\n"), err
}

// RunLive runs a command attached to this console (for gh login prompts etc).
func RunLive(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

func Has(name string) bool { _, err := exec.LookPath(name); return err == nil }

func Must(out string, err error) string {
	if err != nil {
		panic(fmt.Sprintf("git failed: %v\n%s", err, out))
	}
	return out
}

func Count(rangeSpec string) int {
	out, err := Git("rev-list", "--count", rangeSpec)
	if err != nil {
		return 0
	}
	n := 0
	fmt.Sscanf(strings.TrimSpace(out), "%d", &n)
	return n
}

func CurrentBranch() string { return Must(Git("rev-parse", "--abbrev-ref", "HEAD")) }

// Fetch updates origin/main. Returns false if GitHub couldn't be reached.
func Fetch() bool {
	_, err := Git("fetch", "origin", "--prune", "--quiet")
	return err == nil
}

// UpstreamChanged lists files changed on origin/main since this branch split off.
func UpstreamChanged() []string {
	out, _ := Git("diff", "--name-only", "HEAD...origin/main")
	return Lines(out)
}

// ─── working-tree changes ─────────────────────────────────────────────────

type Change struct{ Code, Path string }

func (c Change) Label() string {
	switch {
	case strings.Contains(c.Code, "?"):
		return "new"
	case strings.Contains(c.Code, "D"):
		return "deleted"
	case strings.Contains(c.Code, "R"):
		return "renamed"
	default:
		return "changed"
	}
}

// Changes returns the working-tree changes (minus the skip list) and the skipped ones.
func Changes() (keep, skipped []Change) {
	out := Must(Git("-c", "core.quotepath=off", "status", "--porcelain=v1", "--untracked-files=all"))
	for _, l := range Lines(out) {
		if len(l) < 4 {
			continue
		}
		code, path := l[:2], strings.TrimSpace(l[3:])
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+4:]
		}
		c := Change{code, strings.Trim(path, "\"")}
		if IsSkipped(c.Path) {
			skipped = append(skipped, c)
		} else {
			keep = append(keep, c)
		}
	}
	return
}

func IsSkipped(p string) bool {
	p = filepath.ToSlash(p)
	for _, s := range SkipPatterns {
		if strings.Contains(p, s) {
			return true
		}
	}
	return false
}

// Overlap returns the changed paths that also appear in files.
func Overlap(changes []Change, files []string) []string {
	set := map[string]bool{}
	for _, f := range files {
		set[f] = true
	}
	var res []string
	for _, c := range changes {
		if set[c.Path] {
			res = append(res, c.Path)
		}
	}
	return res
}

// MoveStagedWorkflows moves workflow files Claude left in github-workflows/ or
// tools/move-to-github-workflows/ into .github/workflows/ (Claude's remote
// tools can't write into .github directly).
func MoveStagedWorkflows() {
	for _, src := range []string{"github-workflows", filepath.Join("tools", "move-to-github-workflows")} {
		files, _ := filepath.Glob(filepath.Join(src, "*.yml"))
		if len(files) == 0 {
			continue
		}
		dst := filepath.Join(".github", "workflows")
		if err := os.MkdirAll(dst, 0o755); err != nil {
			panic("Couldn't create " + dst + ": " + err.Error())
		}
		fmt.Println("\nMoving workflow files into .github/workflows:")
		for _, f := range files {
			data, err := os.ReadFile(f)
			if err != nil {
				panic("Couldn't read " + f + ": " + err.Error())
			}
			target := filepath.Join(dst, filepath.Base(f))
			if err := os.WriteFile(target, data, 0o644); err != nil {
				panic("Couldn't write " + target + ": " + err.Error())
			}
			os.Remove(f)
			fmt.Println("   ", filepath.Base(f))
		}
		if rest, _ := os.ReadDir(src); len(rest) == 0 {
			os.Remove(src)
		}
	}
}

// ─── misc ─────────────────────────────────────────────────────────────────

func Lines(s string) []string {
	var r []string
	for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			r = append(r, l)
		}
	}
	return r
}

func LastLine(s string) string {
	l := Lines(s)
	if len(l) == 0 {
		return ""
	}
	return l[len(l)-1]
}

func Prompt(q string) string {
	fmt.Print(q)
	s, _ := In.ReadString('\n')
	return strings.TrimSpace(s)
}

func Ask(q string, def bool) bool {
	a := strings.ToLower(Prompt(q))
	if a == "" {
		return def
	}
	return a == "y" || a == "yes"
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func Slug(s string) string {
	s = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 30 {
		s = strings.Trim(s[:30], "-")
	}
	if s == "" {
		s = "update"
	}
	return s
}

var remoteRe = regexp.MustCompile(`github\.com[:/]([^/]+/[^/.\s]+?)(\.git)?$`)

func RepoSlug() string {
	u, err := Git("config", "--get", "remote.origin.url")
	if err != nil {
		return ""
	}
	if m := remoteRe.FindStringSubmatch(strings.TrimSpace(u)); m != nil {
		return m[1]
	}
	return ""
}

func OpenBrowser(url string) {
	switch runtime.GOOS {
	case "windows":
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		exec.Command("open", url).Start()
	default:
		exec.Command("xdg-open", url).Start()
	}
}

func Names(cs []Change) string {
	var n []string
	for _, c := range cs {
		n = append(n, c.Path)
	}
	return strings.Join(n, ", ")
}
