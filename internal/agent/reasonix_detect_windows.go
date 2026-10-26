//go:build windows

package agent

import (
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

// Reading every uninstall entry of two hives took 59% of Detected(), and
// Detected runs on every /api/state: the list is read again at most once a
// minute, and never under test.
var reasonixDirsFor = func() time.Duration {
	if testing.Testing() {
		return 0
	}
	return time.Minute
}()

var reasonixDirs struct {
	sync.Mutex
	at   time.Time
	dirs []string
	read bool
}

func reasonixStudioDirs() []string {
	reasonixDirs.Lock()
	defer reasonixDirs.Unlock()
	if reasonixDirs.read && time.Since(reasonixDirs.at) < reasonixDirsFor {
		return reasonixDirs.dirs
	}
	reasonixDirs.dirs, reasonixDirs.at, reasonixDirs.read = readReasonixStudioDirs(), time.Now(), true
	return reasonixDirs.dirs
}

func readReasonixStudioDirs() []string {
	var dirs []string
	for _, hive := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		for _, root := range []string{`Software\Microsoft\Windows\CurrentVersion\Uninstall`, `Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`} {
			k, err := registry.OpenKey(hive, root, registry.READ)
			if err != nil {
				continue
			}
			names, _ := k.ReadSubKeyNames(-1)
			for _, name := range names {
				entry, err := registry.OpenKey(k, name, registry.QUERY_VALUE)
				if err != nil {
					continue
				}
				display, _, _ := entry.GetStringValue("DisplayName")
				version, _, _ := entry.GetStringValue("DisplayVersion")
				if reasonixStudioRelease(display, version) {
					dir, _, _ := entry.GetStringValue("InstallLocation")
					if dir == "" {
						icon, _, _ := entry.GetStringValue("DisplayIcon")
						if at := strings.LastIndex(icon, ","); at >= 0 {
							icon = icon[:at]
						}
						if icon != "" {
							dir = filepath.Dir(strings.Trim(icon, `"`))
						}
					}
					if filepath.IsAbs(dir) {
						dirs = append(dirs, dir)
					}
				}
				entry.Close()
			}
			k.Close()
		}
	}
	return dirs
}

func reasonixStudioRelease(display, version string) bool {
	name := display == "Reasonix Studio" || strings.HasPrefix(display, "Reasonix Studio ")
	return name && strings.HasPrefix(strings.TrimPrefix(strings.TrimSpace(version), "v"), "2.")
}
