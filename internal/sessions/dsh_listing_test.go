package sessions

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// dshFiles lists a session folder again only when the folder itself says
// it changed: a pass over the tree costs a system call per folder, and a
// home with 1154 sessions spent ~430 ms at every page load. A new
// session's folder is still seen the moment it is made, and a reply
// written into a known one is still read, since only the folder listing
// is reused and each file is statted for its own size and time.
func TestDshFolderListingsReused(t *testing.T) {
	home := setupAgents(t)
	dirs, _ := filepath.Glob(filepath.Join(home, ".dsh", "sessions", "*", "*"))
	if len(dirs) == 0 {
		t.Fatal("no session folders in the fixture")
	}
	// readDirectory keeps a listing only once the folder's own mtime is
	// older than racyDirectory: a folder changed a moment ago is listed
	// again, so an entry added in the same tick is never missed. A real
	// dsh home is made of folders that old, which is the case this caches
	// for; make the fixture's folders so too.
	old := time.Now().Add(-time.Minute)
	for _, d := range dirs {
		if err := os.Chtimes(d, old, old); err != nil {
			t.Fatal(err)
		}
	}

	// Count the folders listed for real, which readDirectory does once a
	// folder's mtime and size are unchanged and its listing has settled.
	reads := map[string]int{}
	readDirectoryHook = func(path string) { reads[path]++ }
	t.Cleanup(func() { readDirectoryHook = nil })

	Reset()
	first := dshFiles()
	for _, d := range dirs {
		if reads[d] != 1 {
			t.Fatalf("%s listed %d times in the first pass, want 1", d, reads[d])
		}
	}

	// a second pass, nothing changed: no folder is listed again
	reads = map[string]int{}
	second := dshFiles()
	for _, d := range dirs {
		if reads[d] != 0 {
			t.Fatalf("%s listed again with nothing changed", d)
		}
	}
	if len(first) != len(second) {
		t.Fatalf("the second pass found %d sessions, the first %d", len(second), len(first))
	}

	// a new session's folder is listed at once, so it is found at once
	fresh := filepath.Join(filepath.Dir(dirs[0]), "dsh-fresh")
	if err := os.MkdirAll(fresh, 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dirs[0], "session.v3.jsonl")
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fresh, "session.v3.jsonl"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	reads = map[string]int{}
	third := dshFiles()
	if reads[fresh] == 0 {
		t.Fatalf("the new folder %s was never listed", fresh)
	}
	if len(third) != len(first)+1 {
		t.Fatalf("the new session wasn't found: %d sessions, want %d", len(third), len(first)+1)
	}
}
