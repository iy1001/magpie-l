// Run with Node's test runner and Playwright on the module path; see README.md.
// A masked call on the Gateway page says how many values masking swapped, and
// opens Settings › Privacy, where what masking kept is set up: the page that
// listed the requests themselves (Insights › Masking) is gone, so the badge
// has nowhere else to go. A call whose values only went as written, as the
// user set a kind to do, says that in amber. Both engines, English and
// Chinese, a narrow window and a wide one. The API is faked.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const calls = [
  { id: 7, time: ago(120e3), agent: "claude", model: "claude-opus-4-1", from: "anthropic", to: "anthropic", status: 200, ms: 900,
    masked: { n: 3, distinct: 2, kinds: { API_KEY: 2, EMAIL: 1 }, by: { rule: 2 }, key: 1792987654321000001 } },
  { id: 8, time: ago(60e3), agent: "claude", model: "claude-opus-4-1", from: "anthropic", to: "anthropic", status: 200, ms: 700,
    masked: { n: 0, distinct: 0, warned: 2, key: 1792987654321000002 } },
];

function serve(lang, asked) {
  const json = (route, data) => route.fulfill({ json: data });
  return async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/masking")) asked.push(url.pathname);
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(route, { agents: [{ id: "claude", name: "Claude Code", fields: [] }], profiles: [], settings: { lang, theme: "light", redact: true, redactPersonal: true } });
    if (url.pathname === "/api/providers") return json(route, { providers: [], presets: [], excluded: [],
      gateway: { running: true, window: true, mine: true, url: "http://127.0.0.1:3999", models: 0, groups: [], calls } });
    if (url.pathname === "/api/masking/summary" || url.pathname === "/api/masking/records") return json(route, { days: [], requests: 0, n: 0, distinct: 0, blocked: 0, kinds: [], by: {}, agents: [], providers: [], values: [], records: [], more: false });
    if (url.pathname.startsWith("/api/")) return json(route, {});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
  };
}

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    for (const width of [1100, 640]) {
      test(`${engine} ${lang} ${width}px: a masked call says what it masked, and opens Settings › Privacy`, async (t) => {
        const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
        const page = await (await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" })).newPage();
        page.setDefaultTimeout(8000);
        page.setDefaultNavigationTimeout(60000);
        const errors = [], asked = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/*", serve(lang, asked));
        t.after(() => browser.close());
        await page.goto("http://magpie.test/?view=gateway");

        const badge = page.locator("#activity .call .mask-badge:not(.warn)").first();
        await badge.waitFor();
        assert.equal(await badge.textContent(), "3", "the count of what masking swapped");
        if (lang === "en") {
          assert.equal(await badge.getAttribute("title"), "3 values masked before it went to the vendor: API keys 2, Emails 1");
        }
        // a call whose values only went as written is said in amber
        const warned = page.locator("#activity .call .mask-badge.warn").first();
        await warned.waitFor();
        assert.equal(await warned.textContent(), "2");
        if (lang === "en") assert.equal(await warned.getAttribute("title"), "2 values went to the vendor as written, as you set");

        // the click is the badge's, not the row's, and it opens where what
        // masking kept is now set: Settings › Privacy
        await badge.click();
        await page.locator("#view-settings").waitFor({ state: "visible" });
        await page.locator("#setPage-privacy").waitFor({ state: "visible" });
        assert.equal(await page.locator("#setTab-privacy").getAttribute("aria-selected"), "true", "the Privacy tab is the one open");
        assert.equal(await page.locator("#activity .call-item.open").count(), 0, "the click wasn't the row's");
        // the page no longer reads what masking kept: the badges say the
        // count on their own
        assert.deepEqual(asked, [], "the window asked for what masking kept");
        assert.deepEqual(errors, []);
      });
    }
  }
}

// The Masking alert's notification opens the same page: it used to open the
// page that is gone. Faked here as the tray's link into the window does.
for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  test(`${engine}: the address the alert's notification opens lands on Settings › Privacy`, async (t) => {
    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" })).newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", serve("en", []));
    t.after(() => browser.close());
    await page.goto("http://magpie.test/?view=settings&tab=privacy");
    await page.locator("#setPage-privacy").waitFor({ state: "visible" });
    assert.equal(await page.locator("#setTab-privacy").getAttribute("aria-selected"), "true");
    assert.deepEqual(errors, []);
  });
}
