// Measures the Plugins page in the window the user has — WebView2, not a
// browser — so a change to it can be weighed before and after, the way
// docs/perf-baseline.md §0.3 and §12 were. Three numbers per run: the first
// paint's task time, the settled page's, and what the page is made of (DOM
// nodes, pictures, decoded picture area, and which section holds the most).
//
// It reads a page the window already shows, over CDP; it never serves a page
// of its own, so what is measured is the real thing, with real providers and
// real icons. Start the app with WebView2's debugging port open — the
// isolated way is in README.md beside this file:
//
//   MAGPIE_ADDR=127.0.0.1:3426 \
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
//   ./magpie-dev.exe
//
//   node internal/gui/tests/measure/plugins-page.cjs [--cdp URL] [--view NAME]
//        [--settle MS] [--window MS] [--no-icons] [--json]
//
// A run of the page under a hidden window is a run of the throttler, not of
// the page (LESSONS.md, 10-26): the harness refuses to report one.

const { chromium } = require("playwright");

const DEFAULTS = { cdp: "http://127.0.0.1:9222", view: "plugins", settle: 20000, window: 10000 };

function parseArgs(argv) {
  const a = { ...DEFAULTS, icons: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--json") a.json = true;
    else if (f === "--no-icons") a.icons = false;
    else if (f === "--cdp") a.cdp = argv[++i];
    else if (f === "--view") a.view = argv[++i];
    else if (f === "--settle") a.settle = Number(argv[++i]);
    else if (f === "--window") a.window = Number(argv[++i]);
    else throw new Error(`unknown flag ${f}; see the header of this file`);
  }
  return a;
}

// window measures one stretch of the page's own timeline: the counters CDP
// keeps are cumulative, so a stretch is the difference across it, over the
// wall clock it took.
async function window(cdp, ms) {
  const read = async () => {
    const m = await cdp.send("Performance.getMetrics");
    const at = (name) => m.metrics.find((x) => x.name === name)?.value ?? 0;
    return { at: Date.now(), task: at("TaskDuration"), script: at("ScriptDuration"), style: at("RecalcStyleDuration"), layout: at("LayoutDuration") };
  };
  const a = await read();
  await new Promise((r) => setTimeout(r, ms));
  const b = await read();
  const dt = (b.at - a.at) / 1000;
  return {
    seconds: Number(dt.toFixed(1)),
    task: Number((((b.task - a.task) / dt) * 100).toFixed(2)),
    script: Number((((b.script - a.script) / dt) * 100).toFixed(2)),
    style: Number((((b.style - a.style) * 1000) / dt).toFixed(1)),
    layout: Number((((b.layout - a.layout) * 1000) / dt).toFixed(1)),
  };
}

// madeOf reads the page once it has settled: how many nodes and pictures it
// holds, how much picture area that is once decoded, and how the nodes split
// between the sections and inside one card. That split is what says whether a
// page needs drawing in parts, and where the parts would cut.
function madeOf() {
  const nodes = (n) => n.querySelectorAll("*").length;
  const sections = [...document.querySelectorAll(".pm-body > .pm-sec")].map((s) => ({
    title: s.querySelector(".pm-sechead h3")?.textContent || "(no heading)",
    nodes: nodes(s),
    cards: s.querySelectorAll(".pm-card").length,
    imgs: s.querySelectorAll("img").length,
  }));
  const imgs = [...document.images];
  const decoded = imgs.reduce((a, i) => a + (i.complete && i.naturalWidth > 0 ? i.naturalWidth * i.naturalHeight : 0), 0);
  const drawn = imgs.reduce((a, i) => a + i.getBoundingClientRect().width * i.getBoundingClientRect().height, 0);
  const cards = [...document.querySelectorAll(".pm-card")];
  const cardNodes = cards.reduce((a, c) => a + nodes(c), 0);
  const one = cards[0];
  const parts = one
    ? [...one.querySelectorAll(":scope > *")].map((k) => ({ cls: k.className || k.tagName.toLowerCase(), nodes: nodes(k) }))
    : [];
  return {
    hidden: document.hidden,
    viewport: `${innerWidth}x${innerHeight}`,
    nodes: nodes(document),
    bodyNodes: document.querySelector(".pm-body") ? nodes(document.querySelector(".pm-body")) : 0,
    sections,
    cardCount: cards.length,
    nodesPerCard: cards.length ? Number((cardNodes / cards.length).toFixed(1)) : 0,
    firstCardParts: parts,
    imgs: imgs.length,
    imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    decodedMP: Number((decoded / 1e6).toFixed(1)),
    drawnK: Number((drawn / 1e3).toFixed(1)),
  };
}

// sentBytes is what the pictures on the page cost on the wire, asked of the
// network rather than guessed from the file names.
async function sentBytes(page) {
  const sizes = await page.evaluate(async () => {
    const out = [];
    for (const img of document.images) {
      if (!img.currentSrc) continue;
      try {
        const b = await (await fetch(img.currentSrc)).blob();
        out.push({ src: img.currentSrc.split("/").pop(), bytes: b.size, w: img.naturalWidth, h: img.naturalHeight });
      } catch {}
    }
    return out;
  });
  const total = sizes.reduce((a, s) => a + s.bytes, 0);
  return { totalKB: Math.round(total / 1024), biggest: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 5) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = await chromium.connectOverCDP(args.cdp);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes("wails.localhost")) || ctx.pages()[0];
  if (!page) throw new Error("the app has no page open");
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setBlockedURLs", { urls: args.icons ? [] : ["*/api/icons/*", "*/api/icons?"] });

  // the first paint: from the navigation to the page settling, the stretch
  // §12 measured at 8.22% for this page
  await page.goto(`http://wails.localhost/?view=${args.view}`, { waitUntil: "load", timeout: 30000 });
  const first = await window(cdp, args.settle);
  const done = await page.evaluate(madeOf);
  if (done.hidden) throw new Error("the window is hidden: this would time the throttler, not the page");
  const settled = await window(cdp, args.window);
  const sent = await sentBytes(page);
  await browser.close();

  const report = { view: args.view, icons: args.icons, firstPaint: first, settled, madeOf: done, sent };
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`view=${args.view} icons=${args.icons ? "on" : "blocked"}`);
  console.log(`first paint (${first.seconds}s)   task=${first.task}%  script=${first.script}%  style=${first.style}ms/s  layout=${first.layout}ms/s`);
  console.log(`settled (${settled.seconds}s)       task=${settled.task}%  script=${settled.script}%  style=${settled.style}ms/s  layout=${settled.layout}ms/s`);
  console.log(`window=${done.viewport}`);
  console.log(`nodes=${done.nodes} (body ${done.bodyNodes})  imgs=${done.imgsLoaded}/${done.imgs} loaded  decoded=${done.decodedMP} MP drawn=${done.drawnK} K  sent=${sent.totalKB} KB`);
  console.log("sections, by nodes:");
  for (const s of [...done.sections].sort((a, b) => b.nodes - a.nodes)) {
    console.log(`  ${pad(s.nodes, 6)} ${pad(s.cards, 5)} cards ${pad(s.imgs, 4)} imgs  ${s.title}`);
  }
  console.log(`cards: ${done.cardCount}, ${done.nodesPerCard} nodes each; the first one's parts: ` +
    done.firstCardParts.map((p) => `${p.cls}=${p.nodes}`).join(" "));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
