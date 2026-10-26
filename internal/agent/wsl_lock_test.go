package agent

import (
	"testing"
	"time"
)

// TestWSLProbeNotUnderLock: a wsl.exe that hangs must not hold wsl's mutex,
// which every other reader of WSL (the Agents page, the sessions listing, a
// request's call sources) takes first. Run under -race this fails on a lock
// held across the fork; as it is, it fails on the reader waiting for it.
//
// docs/code-standards.md: "Nothing that can block runs under a lock its
// reader needs."
func TestWSLProbeNotUnderLock(t *testing.T) {
	fakeWSL(t, "Ubuntu\r\n", "Ubuntu\r\n", nil, nil)
	release := make(chan struct{})
	entered := make(chan struct{})
	prev := wslRun
	wslRun = func(_ time.Duration, args ...string) ([]byte, error) {
		return prev(0, args...)
	}
	_ = entered
	_ = release
	// list says Ubuntu runs, so wslDistros probes it; the probe blocks
	// until the test says so.
	var probed bool
	run := wslRun
	wslRun = func(d time.Duration, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "-l" {
			return run(d, args...)
		}
		if !probed {
			probed = true
			close(entered)
			<-release
		}
		return []byte("home:/home/me\ndir:.codex\n"), nil
	}

	done := make(chan struct{})
	go func() { defer close(done); wslDistros() }()

	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the probe was never reached")
	}
	// while the probe is stuck, another reader must get in
	locked := make(chan bool, 1)
	go func() {
		got := make(chan struct{})
		go func() { wsl.Lock(); wsl.Unlock(); close(got) }()
		select {
		case <-got:
			locked <- false
		case <-time.After(time.Second):
			locked <- true
		}
	}()
	if held := <-locked; held {
		close(release)
		<-done
		t.Fatal("wsl's mutex was held while wsl.exe ran: every other WSL reader waits on it")
	}
	close(release)
	<-done
}
