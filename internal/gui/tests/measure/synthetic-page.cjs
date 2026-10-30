// Measures the Plugins page as it is at the size this machine's own instance
// showed — 122 cards, 150 stored pictures, §12.3 of docs/perf-baseline.md —
// with the API faked, so the page can be weighed without that instance
// running and without touching it. Playwright's Chromium opens the real
// assets of a tree it is pointed at, so the same page can be measured for two
// commits: the one before a change and the one after.
//
//   node internal/gui/tests/measure/synthetic-page.cjs --assets internal/gui/assets
//   node internal/gui/tests/measure/synthetic-page.cjs --assets /tmp/old-assets --json
//
// Flags: --assets DIR (required), --cards N (default 122), --viewport WxH
// (default 440x513, the window this machine's app opens at), --lang en|zh,
// --icons DIR (the .png/.svg/.ico files /api/icons serves, default the
// icons dir of this machine's magpie), --rounds N (default 1), --json.
//
// Chromium is not the window: its numbers are not §12's. They compare two
// trees against each other, which is what a change to the page needs.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

function args(argv) {
  const a = { cards: 122, viewport: "440x513", lang: "en", rounds: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--json") a.json = true;
    else if (f === "--assets") a.assets = path.resolve(argv[++i]);
    else if (f === "--icons") a.icons = path.resolve(argv[++i]);
    else if (f === "--cards") a.cards = Number(argv[++i]);
    else if (f === "--viewport") a.viewport = argv[++i];
    else if (f === "--lang") a.lang = argv[++i];
    else if (f === "--rounds") a.rounds = Number(argv[++i]);
    else throw new Error(`unknown flag ${f}; see the header of this file`);
  }
  if (!a.assets) throw new Error("--assets <dir of internal/gui/assets> is required");
  const [w, h] = a.viewport.split("x").map(Number);
  a.width = w;
  a.height = h;
  return a;
}

// pictures are the files this machine's magpie keeps, biggest first, so a
// card's picture costs what a real one costs; a fixture of 1x1 files would
// measure nothing the page pays for
function pictures(dir) {
  const exts = new Set([".png", ".svg", ".ico", ".webp", ".jpg", ".jpeg"]);
  return fs
    .readdirSync(dir)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((x, y) => y.size - x.size);
}

const KINDS = ["pv", "pv", "pv", "mw", "ag", "tl", "pg"];
// the page reads a listing's kind by the name the registry spells it with
const KIND_NAME = { pv: "provider", mw: "middleware", ag: "agent", tl: "tools", pg: "page" };

// listings makes the page's sections the shape of a market of n plugins:
// subscriptions most of it, then middleware, agents, tools and pages.
function listings(n, pics) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = KINDS[i % KINDS.length];
    const pic = pics[i % pics.length];
    out.push({
      package: `@magpie-community/synthetic-${i}`,
      name: `Synthetic plugin ${i}`,
      kind: KIND_NAME[kind],
      community: true,
      icon: `file:${pic.file}`,
      providers: kind === "pv" ? [`synthetic-provider-${i}`] : [],
      summary: { en: `Plugin number ${i}, measured for the page's own cost.`, zh: `第 ${i} 个插件。` },
      npm: { version: "1.0.0", publisher: "magpie community", weekly: 1000 + i, icon: `file:${pic.file}` },
    });
  }
  return out;
}

function serve(a) {
  const pics = pictures(a.icons);
  const state = {
    list: listings(a.cards, pics),
    plugins: [],
    npm: {},
  };
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".json": "application/json",
    ".woff2": "font/woff2",
  };
  const page = (file, res) =>
    fs.readFile(file, (err, b) => {
      if (err) {
        res.writeHead(404).end("");
        return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
      res.end(b);
    });
  const json = (res, body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    if (p === "/boot.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(`window.bootPrefs = {lang:"${a.lang}",theme:"light",web:true};`);
      return;
    }
    if (p === "/wails/runtime.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end("export const Window = {};");
      return;
    }
    if (p === "/api/plugins/listings") return json(res, { listings: state.list });
    if (p === "/api/plugins/market") return json(res, { listings: state.list, state });
    if (p === "/api/plugins/github") return json(res, { repos: [], topic: "magpie-plugin" });
    if (p === "/api/plugins") return json(res, { plugins: [], state });
    if (p === "/api/plugins/npm") return json(res, { npm: state.npm });
    if (p === "/api/plugins/search") return json(res, { hits: [] });
    if (p === "/api/state") return json(res, { agents: [], profiles: [], settings: { lang: a.lang, theme: "light" } });
    if (p === "/api/providers") return json(res, { providers: [], presets: [], excluded: [], gateway: { running: false, window: true }, plugins: [] });
    if (p === "/api/groups") return json(res, { groups: [], pools: [] });
    if (p === "/api/gateway/trace") return json(res, { routes: [] });
    if (p.startsWith("/api/icons/")) {
      const name = decodeURIComponent(p.slice("/api/icons/".length));
      return page(path.join(a.icons, name), res);
    }
    if (p.startsWith("/api/")) return json(res, {});
    page(path.join(a.assets, p === "/" ? "index.html" : p), res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, pics })));
}

async function measure(browser, a, base) {
  const page = await (await browser.newContext({ viewport: { width: a.width, height: a.height } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const read = async () => {
    const m = await cdp.send("Performance.getMetrics");
    const at = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
    return { at: Date.now(), task: at("TaskDuration"), script: at("ScriptDuration"), style: at("RecalcStyleDuration"), layout: at("LayoutDuration") };
  };
  const span = async (ms) => {
    const s = await read();
    if (ms) await page.waitForTimeout(ms);
    const e = await read();
    const dt = (e.at - s.at) / 1000;
    return { seconds: Number(dt.toFixed(1)), task: Number((((e.task - s.task) / dt) * 100).toFixed(2)), script: Number((((e.script - s.script) / dt) * 100).toFixed(2)), style: Number((((e.style - s.style) * 1000) / dt).toFixed(1)), layout: Number((((e.layout - s.layout) * 1000) / dt).toFixed(1)) };
  };
  const first = await read();
  await page.goto(base + "/?view=plugins", { waitUntil: "load", timeout: 30000 });
  // the page builds, then fetches its pictures: the stretch §12 timed
  await page.waitForTimeout(3000);
  const endOfFirst = await read();
  const dt = (endOfFirst.at - first.at) / 1000;
  const firstPaint = {
    seconds: Number(dt.toFixed(1)),
    task: Number((((endOfFirst.task - first.task) / dt) * 100).toFixed(2)),
    script: Number((((endOfFirst.script - first.script) / dt) * 100).toFixed(2)),
    style: Number((((endOfFirst.style - first.style) * 1000) / dt).toFixed(1)),
    layout: Number((((endOfFirst.layout - first.layout) * 1000) / dt).toFixed(1)),
  };
  const settled = await span(5000);
  const made = await page.evaluate(() => {
    const nodes = (n) => n.querySelectorAll("*").length;
    const imgs = [...document.images];
    const cards = [...document.querySelectorAll(".pm-card")];
    return {
      hidden: document.hidden,
      nodes: nodes(document),
      cards: cards.length,
      nodesPerCard: cards.length ? Number((cards.reduce((x, c) => x + nodes(c), 0) / cards.length).toFixed(1)) : 0,
      imgs: imgs.length,
      imgsLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      decodedMP: Number((imgs.reduce((x, i) => x + (i.complete ? i.naturalWidth * i.naturalHeight : 0), 0) / 1e6).toFixed(1)),
      sections: [...document.querySelectorAll(".pm-body > .pm-sec")].map((s) => ({
        title: s.querySelector(".pm-sechead h3")?.textContent || "(no heading)",
        nodes: nodes(s),
        cards: s.querySelectorAll(".pm-card").length,
        imgs: s.querySelectorAll("img").length,
      })),
    };
  });
  await page.context().close();
  return { errors, firstPaint, settled, made };
}

(async () => {
  const a = args(process.argv.slice(2));
  if (!a.icons) {
    const home = require("node:os").homedir();
    a.icons = path.join(home, ".config", "magpie", "icons");
  }
  const { server, port } = await serve(a);
  const browser = await chromium.launch();
  const runs = [];
  try {
    for (let i = 0; i < a.rounds; i++) runs.push(await measure(browser, a, `http://127.0.0.1:${port}`));
  } finally {
    await browser.close();
    server.close();
  }
  const last = runs[runs.length - 1];
  if (a.json) {
    console.log(JSON.stringify({ assets: a.assets, cards: a.cards, viewport: a.viewport, runs }, null, 2));
    return;
  }
  const tasks = runs.map((r) => r.firstPaint.task).sort((x, y) => x - y);
  const mid = tasks.length ? tasks[Math.floor(tasks.length / 2)] : NaN;
  console.log(`assets=${a.assets}`);
  console.log(`cards=${last.made.cards} viewport=${a.viewport} nodes=${last.made.nodes} (${last.made.nodesPerCard}/card) ` +
    `imgs=${last.made.imgsLoaded}/${last.made.imgs} decoded=${last.made.decodedMP}MP`);
  console.log(`first paint task=${mid}% runs=${JSON.stringify(tasks)} script=${last.firstPaint.script}% ` +
    `style=${last.firstPaint.style}ms/s layout=${last.firstPaint.layout}ms/s`);
  console.log(`settled     task=${last.settled.task}% script=${last.settled.script}% style=${last.settled.style}ms/s layout=${last.settled.layout}ms/s`);
  for (const s of [...last.made.sections].sort((x, y) => y.nodes - x.nodes)) {
    console.log(`  ${String(s.nodes).padEnd(6)} ${String(s.cards).padEnd(4)} cards ${String(s.imgs).padEnd(4)} imgs  ${s.title}`);
  }
  if (last.errors.length) console.log("page errors: " + last.errors.slice(0, 3).join(" | "));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
