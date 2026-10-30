# Measuring the Plugins page in the window

`plugins-page.cjs` reports what the Plugins page costs in WebView2 — the
window the user has, not a browser — and what it is made of, so a change to
it can be weighed before and after. It is a measurement, not a test: nothing
runs it on CI, and `make test-ui` doesn't pick it up (that glob names
`*.test.cjs` directly under `tests/`).

What it prints, for one run:

- **first paint** — task, script, style and layout over the stretch from the
  navigation to the page settling, which is where the page's own build work
  lands (§12 of [perf-baseline](../../../../docs/perf-baseline.md) read 8.22%
  here);
- **settled** — the same counters over a quiet stretch after it;
- **what the page is made of** — DOM nodes, pictures loaded and drawn,
  decoded picture area (MP), and the bytes the pictures were sent as;
- **sections by nodes** — for each `section.pm-sec` of the page, its node
  count, cards and pictures. This is the number that decides whether a page
  needs drawing in parts, and where the parts would split.

## Running it

Start the app with WebView2's debugging port open, in a sandbox HOME, so it
reads neither your providers nor your plugin sign-ins:

```sh
SB=/tmp/magpie-measure-home
mkdir -p "$SB"
env HOME="$SB" USERPROFILE="$SB" \
    APPDATA="$SB/AppData/Roaming" LOCALAPPDATA="$SB/AppData/Local" \
    XDG_CONFIG_HOME="$SB/.config" XDG_CACHE_HOME="$SB/.cache" \
    MAGPIE_ADDR=127.0.0.1:3446 \
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333" \
    ./magpie
```

Then, with Playwright on the module path (the browser tests' README says how
this checkout has it):

```sh
NODE_PATH=<playwright's node_modules> node internal/gui/tests/measure/plugins-page.cjs \
  --cdp http://127.0.0.1:9333 --settle 20000 --window 10000
```

Flags: `--cdp <url>` (default `http://127.0.0.1:9222`), `--view <name>`
(default `plugins`), `--settle <ms>` (default 20000), `--window <ms>` (default
10000), `--no-icons` (pictures refused, so the page's cost without them can be
told apart), `--json`.

## Reading it right

- A page timed in a hidden window is timed in the throttler: the run refuses
  to report one (`LESSONS.md`, 10-26).
- A window that just started is still doing the work every start does
  (agents' detection, the `.dsh` folders, WSL's probes). Measure a start
  that has been up a while, or the page's numbers will be someone else's.
- Two runs to compare need the same page in the same state: the same sandbox
  HOME, the same window size, one run at a time. A different set of listings
  is a different page.
- One run is one sample. Alternating the two binaries a few times, as
  §0.3 and §7.4 did, keeps the machine's own noise out of the answer.
