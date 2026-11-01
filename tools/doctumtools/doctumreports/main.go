// DoctumReports - one double-click to build Doctum's private demand reports.
//
// Put DoctumReports.exe in the doctum folder (next to DoctumCommit.exe) and double-click it.
// It asks what you want, then runs the Node scripts in scripts/:
//   1  University report  (PDF)  scripts/university-report.mjs --inst "<name>"
//   2  UK sector report   (PDF)  scripts/university-report.mjs
//   3  All the raw data   (CSV)  scripts/insights-report.mjs
//   4  Sample report      (PDF, made-up figures, to check the layout)
//   5  Change the saved key
// The INSIGHTS_ADMIN_KEY is asked for once and saved in your Windows user folder
// (%USERPROFILE%\.doctum\insights-key.txt), outside the repo, so it never reaches GitHub.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	g "doctumtools/gitx"
)

func main() { g.Main("Doctum - university and sector reports", run) }

func keyFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".doctum", "insights-key.txt")
}

func savedKey() string {
	b, err := os.ReadFile(keyFile())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func askKey() {
	fmt.Println("\nPaste your INSIGHTS_ADMIN_KEY (the 64-character key you saved in Netlify),")
	fmt.Println("then press Enter. Right-click pastes in this window.")
	k := strings.TrimSpace(g.Prompt("Key: "))
	if len(k) < 24 {
		panic("That key is too short (it should be 64 characters). Nothing saved.")
	}
	if err := os.MkdirAll(filepath.Dir(keyFile()), 0o700); err != nil {
		panic("Couldn't create " + filepath.Dir(keyFile()) + ": " + err.Error())
	}
	if err := os.WriteFile(keyFile(), []byte(k), 0o600); err != nil {
		panic("Couldn't save the key: " + err.Error())
	}
	fmt.Printf("Saved (ends ...%s) in %s\n", k[len(k)-4:], keyFile())
}

// Universities with open adverts, from data/listings.json (run DoctumPull first for the latest).
func universities() []string {
	b, err := os.ReadFile(filepath.Join("data", "listings.json"))
	if err != nil {
		panic("Can't read data/listings.json. Is DoctumReports.exe in the doctum folder?")
	}
	var db struct {
		Listings []struct {
			Institution string `json:"institution"`
			Status      string `json:"status"`
		} `json:"listings"`
	}
	if err := json.Unmarshal(b, &db); err != nil {
		panic("data/listings.json couldn't be read: " + err.Error())
	}
	seen := map[string]bool{}
	var out []string
	for _, l := range db.Listings {
		if l.Status == "open" && !seen[l.Institution] {
			seen[l.Institution] = true
			out = append(out, l.Institution)
		}
	}
	sort.Strings(out)
	return out
}

func pickUniversity() string {
	all := universities()
	for {
		q := strings.TrimSpace(g.Prompt("\nUniversity (part of the name is fine, or 'list'): "))
		if q == "" {
			continue
		}
		var hits []string
		for _, u := range all {
			if strings.EqualFold(q, "list") || strings.Contains(strings.ToLower(u), strings.ToLower(q)) {
				hits = append(hits, u)
			}
		}
		switch {
		case len(hits) == 0:
			fmt.Println("  No university with open adverts matches that. Try another part of the name, or 'list'.")
		case len(hits) == 1:
			fmt.Println("  ->", hits[0])
			return hits[0]
		default:
			for i, h := range hits {
				fmt.Printf("  %2d  %s\n", i+1, h)
			}
			if n, err := strconv.Atoi(strings.TrimSpace(g.Prompt("  Number: "))); err == nil && n >= 1 && n <= len(hits) {
				fmt.Println("  ->", hits[n-1])
				return hits[n-1]
			}
		}
	}
}

func weeks() string {
	w := strings.TrimSpace(g.Prompt("How many full weeks to cover? [4]: "))
	if n, err := strconv.Atoi(w); err == nil && n >= 1 && n <= 52 {
		return strconv.Itoa(n)
	}
	return "4"
}

func node(args ...string) {
	if err := g.RunLive("node", args...); err != nil {
		panic("The report script stopped with an error (see above).")
	}
}

func run() {
	wd := g.ToExeDir()
	fmt.Println("Folder: ", wd)
	if !g.Has("node") {
		panic("Node.js isn't installed. In Command Prompt run:\n    winget install OpenJS.NodeJS.LTS\n  then close this window and try again.")
	}
	if _, err := os.Stat(filepath.Join("scripts", "university-report.mjs")); err != nil {
		panic("scripts/university-report.mjs not found. Put DoctumReports.exe in the doctum folder and run DoctumPull.")
	}

	fmt.Println("\nWhat would you like?")
	fmt.Println("  1  University report (PDF)")
	fmt.Println("  2  UK sector report (PDF)")
	fmt.Println("  3  All the raw data (CSV files)")
	fmt.Println("  4  Sample university report (made-up figures, to check the layout)")
	fmt.Println("  5  Change the saved key")
	choice := strings.TrimSpace(g.Prompt("Choose 1-5 [1]: "))
	if choice == "" {
		choice = "1"
	}

	if choice == "5" {
		askKey()
		return
	}
	if choice != "4" && savedKey() == "" {
		fmt.Println("\nFirst time: Doctum needs your report key.")
		askKey()
	}

	switch choice {
	case "1":
		u := pickUniversity()
		node("scripts/university-report.mjs", "--inst", u, "--weeks", weeks(), "--open")
	case "2":
		node("scripts/university-report.mjs", "--weeks", weeks(), "--open")
	case "3":
		node("scripts/insights-report.mjs")
		g.OpenBrowser(filepath.Join(wd, "reports", "insights"))
	case "4":
		u := pickUniversity()
		node("scripts/university-report.mjs", "--inst", u, "--sample", "--open")
	default:
		panic("Please choose a number from 1 to 5.")
	}
	fmt.Println("\nOK  Done. The report folder has been opened.")
	fmt.Println("    Read it through before sending: check any figure that looks surprising.")
}
