#!/usr/bin/env node
// cspell:words breakpad
// Compares a rendered scan report with the design it is built to, section by section.
//
//   node scripts/report-compare.mjs --design <design.html> --report <report.html> --out <folder>
//                                   [--chrome <path>]
//
// Opens both pages in headless Chrome with a new, empty profile, driven over
// --remote-debugging-pipe, so no port is opened, in light and dark at 1440 px and 390 px wide.
// It writes, into --out (created 0700):
//
//   <theme>-<width>-<section>.png  the design's section on the left, the report's on the right
//   <theme>-<width>-full-design.png, <theme>-<width>-full-report.png   whole pages
//   style-diff.json  for each width and theme, every computed property that differs between
//                    the two pages, by selector; a selector on one page only is listed as such
//   heights.json     each section's height, and the page's, on both pages
//
// It prints counts only: how many sections were compared and how many properties differ. It
// never prints page text, so a report made from real sessions can be compared without its
// contents reaching a terminal or a log; the images and JSON stay in --out.
//
// No network. Chrome starts with its background services and web fonts off and every host name
// mapped to nothing, and every request a page makes is intercepted: one for anything but a
// file: or data: URL is failed, and fails the run.
//
// Needs Node 20+ and Chrome or Chromium, found from --chrome, then CHROME_PATH, then the usual
// install paths.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage: node scripts/report-compare.mjs --design <design.html> --report <report.html> --out <folder>
                                      [--chrome <path>]

  --design <file>  The design page.
  --report <file>  The report page to compare with it.
  --out <folder>   Where to write the images and JSON (created 0700). Required.
  --chrome <path>  The Chrome or Chromium binary. Default: CHROME_PATH, then the usual paths.
`;

/** The sections both pages are measured by, in page order. */
const SECTIONS = [
  ["topbar", ".topbar"],
  ["hero", ".hero"],
  ["lead-extra", "#lead-extra"],
  ["stats", ".stats"],
  ["what-happened", "#what-happened"],
  ["outcomes", "#outcomes"],
  ["owasp", "#owasp"],
  ["findings", "#findings"],
  ["repeats", "#repeats"],
  ["next", "#next"],
  ["share", "#share"],
  ["privacy", "#privacy"],
  ["product", ".product"],
  ["report-meta", ".report-meta"],
  ["site-footer", ".site-footer"],
];

/** The components compared property by property: the first element each selector finds. */
const SELECTORS = [
  "body",
  ".page",
  ".topbar",
  ".topbar-inner",
  ".navlinks a",
  ".icon-btn",
  ".icon-btn.labeled",
  ".hero",
  ".hero-pill",
  ".hero-kicker",
  ".hero h1",
  ".hero h1 em",
  ".hero .lead",
  ".hero-cta .btn-primary",
  ".hero-cta .btn-secondary",
  ".copy",
  ".ring-wrap",
  ".ring-label",
  ".ring-legend",
  ".lx-evidence",
  ".lx-head",
  ".lx-creds li",
  ".lx-creds b",
  ".lx-times",
  ".lx-h",
  ".lx-grid",
  ".lx-grid li",
  ".stats",
  ".stat",
  ".stat-value",
  ".stat-label",
  ".stat-note",
  ".section-head h2",
  ".section-head p",
  ".vrow",
  ".vtone",
  ".vtop h3",
  ".vmatched",
  ".vfacts",
  ".vcmds",
  ".vcmd",
  ".vnote",
  ".outcome",
  ".outcome .n",
  ".insight",
  ".sevbar-card",
  ".sevbar",
  ".sevlegend",
  ".risk",
  ".risk-title",
  ".risk-meter",
  ".toolbar",
  ".seg",
  ".filter",
  ".search",
  ".flist-card",
  ".flist-head",
  ".fgroup",
  ".frow",
  ".ftitle",
  ".fid",
  ".badge",
  ".act",
  ".repeat-table",
  ".repeat-table th",
  ".repeat-table td",
  ".step",
  ".step-n",
  ".post",
  ".post-text",
  ".privacy",
  ".checks",
  ".legend",
  ".more-info",
  ".product",
  ".product h2",
  ".product-ctas .btn",
  ".report-meta",
  ".site-footer",
  ".sf-cols",
];

/** The properties compared, as `getComputedStyle` names them. */
const PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "background-color",
  "background-image",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "border-radius",
  "padding",
  "gap",
  "grid-template-columns",
  "box-shadow",
  "display",
  "white-space",
];

const VIEWS = [
  { theme: "light", width: 1440 },
  { theme: "dark", width: 1440 },
  { theme: "light", width: 390 },
  { theme: "dark", width: 390 },
];

/** Chrome's usual install paths, per platform. */
const CHROME_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/** Flags that keep Chrome off the network and its output stable. */
const CHROME_FLAGS = [
  "--headless",
  "--remote-debugging-pipe",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
  "--disable-breakpad",
  "--disable-remote-fonts",
  "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
  "--no-pings",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--force-color-profile=srgb",
  "--hide-scrollbars",
  "--mute-audio",
];

/** How long one step may take before the run gives up. */
const STEP_MS = 30_000;

/** A reason to stop, said to the user without a stack trace. */
class Stop extends Error {}

function fail(message) {
  throw new Stop(message);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (["--design", "--report", "--out", "--chrome"].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value\n\n${USAGE}`);
      i += 1;
      options[arg.slice(2)] = value;
    } else {
      fail(`unknown argument "${arg}"\n\n${USAGE}`);
    }
  }
  for (const name of ["design", "report", "out"]) {
    if (options[name] === undefined) fail(`--${name} is required\n\n${USAGE}`);
  }
  for (const name of ["design", "report"]) {
    if (!existsSync(options[name])) fail(`--${name}: no such file`);
  }
  return options;
}

function findChrome(given) {
  const candidates = [given, process.env.CHROME_PATH, ...(CHROME_PATHS[process.platform] ?? [])];
  const found = candidates.find(
    (path) => typeof path === "string" && path !== "" && existsSync(path),
  );
  if (found === undefined) fail("no Chrome found: pass --chrome <path> or set CHROME_PATH");
  return found;
}

/** A Chrome DevTools Protocol client over the pipe Chrome opens on fds 3 and 4. */
function devtools(child) {
  const input = child.stdio[3];
  const output = child.stdio[4];
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  output.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(0); end !== -1; end = buffer.indexOf(0)) {
      const message = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      buffer = buffer.subarray(end + 1);
      if (message.id === undefined) {
        for (const listener of listeners) listener(message);
        continue;
      }
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (waiter === undefined) continue;
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  return {
    send(method, params = {}, sessionId = undefined) {
      const id = nextId;
      nextId += 1;
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        input.write(`${JSON.stringify(message)}\0`);
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    once(method, sessionId) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`timed out waiting for ${method}`));
        }, STEP_MS);
        const off = this.on((message) => {
          if (message.method !== method || message.sessionId !== sessionId) return;
          clearTimeout(timer);
          off();
          resolve(message.params);
        });
      });
    },
  };
}

/** Runs in the page: each section's box, and each selector's computed properties. */
const MEASURE = `((sections, selectors, properties) => {
  const boxes = {};
  for (const [name, selector] of sections) {
    const element = document.querySelector(selector);
    if (element === null) continue;
    const rect = element.getBoundingClientRect();
    boxes[name] = { top: rect.top + scrollY, height: rect.height };
  }
  const styles = {};
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element === null) continue;
    const style = getComputedStyle(element);
    const values = {};
    for (const property of properties) values[property] = style.getPropertyValue(property);
    styles[selector] = values;
  }
  return { boxes, styles, height: document.documentElement.scrollHeight };
})(${JSON.stringify(SECTIONS)}, ${JSON.stringify(SELECTORS)}, ${JSON.stringify(PROPERTIES)})`;

/** Every property that differs between two pages' measured styles. */
function styleDiff(design, report) {
  const out = { differ: {}, designOnly: [], reportOnly: [] };
  for (const selector of SELECTORS) {
    const a = design[selector];
    const b = report[selector];
    if (a === undefined && b === undefined) continue;
    if (b === undefined) {
      out.designOnly.push(selector);
      continue;
    }
    if (a === undefined) {
      out.reportOnly.push(selector);
      continue;
    }
    const changed = {};
    for (const property of PROPERTIES) {
      if (a[property] !== b[property]) changed[property] = { design: a[property], report: b[property] };
    }
    if (Object.keys(changed).length > 0) out.differ[selector] = changed;
  }
  return out;
}

/** Two images side by side, the design's on the left, as one page to capture. */
function pairPage(left, right, width) {
  const cell = (data) =>
    data === null
      ? `<div class="none"></div>`
      : `<img src="data:image/png;base64,${data}" alt="">`;
  return `<!doctype html><meta charset="utf-8"><style>
body { margin: 0; background: #808080; display: flex; gap: 8px; align-items: flex-start; }
img, .none { display: block; width: ${width}px; }
.none { height: 40px; background: repeating-linear-gradient(45deg, #ccc 0 8px, #eee 8px 16px); }
</style>${cell(left)}${cell(right)}`;
}

async function compare(chromePath, pages, work, out) {
  const child = spawn(chromePath, [...CHROME_FLAGS, `--user-data-dir=${join(work, "profile")}`], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const cdp = devtools(child);
  let refused = 0;
  cdp.on((message) => {
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    if (/^(?:file|data):/.test(request.url)) {
      cdp.send("Fetch.continueRequest", { requestId }, message.sessionId).catch(() => {});
    } else {
      refused += 1;
      const params = { requestId, errorReason: "BlockedByClient" };
      cdp.send("Fetch.failRequest", params, message.sessionId).catch(() => {});
    }
  });
  const noOutsideRequest = () => {
    if (refused > 0) fail(`a page asked for ${refused} outside resource(s)`);
  };

  /** A new tab at `width`, in `theme`, showing `url`. */
  const open = async (url, view) => {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: view.width, height: 900, deviceScaleFactor: 1, mobile: view.width < 600 },
      sessionId,
    );
    await cdp.send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: view.theme }] },
      sessionId,
    );
    if (url !== undefined) {
      const loaded = cdp.once("Page.loadEventFired", sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
    }
    return { targetId, sessionId };
  };
  const evaluate = async (tab, expression) =>
    (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, tab.sessionId)).result
      .value;
  const shoot = async (tab, clip) =>
    (
      await cdp.send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: true, ...(clip ? { clip } : {}) },
        tab.sessionId,
      )
    ).data;

  const styles = {};
  const heights = {};
  let sections = 0;
  let differences = 0;
  try {
    for (const view of VIEWS) {
      const key = `${view.theme}-${view.width}`;
      const design = await open(pages.design, view);
      const report = await open(pages.report, view);
      noOutsideRequest();
      const measured = {
        design: await evaluate(design, MEASURE),
        report: await evaluate(report, MEASURE),
      };
      const diff = styleDiff(measured.design.styles, measured.report.styles);
      styles[key] = diff;
      differences += Object.values(diff.differ).reduce((n, d) => n + Object.keys(d).length, 0);
      heights[key] = { design: { total: measured.design.height }, report: { total: measured.report.height } };
      for (const [name] of SECTIONS) {
        const a = measured.design.boxes[name];
        const b = measured.report.boxes[name];
        heights[key].design[name] = a === undefined ? null : Math.round(a.height);
        heights[key].report[name] = b === undefined ? null : Math.round(b.height);
        if (a === undefined && b === undefined) continue;
        sections += 1;
        const clip = (box) =>
          box === undefined
            ? null
            : { x: 0, y: box.top, width: view.width, height: Math.max(1, box.height), scale: 1 };
        const left = a === undefined ? null : await shoot(design, clip(a));
        const right = b === undefined ? null : await shoot(report, clip(b));
        const pair = await open(undefined, { ...view, width: view.width * 2 + 8 });
        const frameId = (await cdp.send("Page.getFrameTree", {}, pair.sessionId)).frameTree.frame
          .id;
        await cdp.send(
          "Page.setDocumentContent",
          { frameId, html: pairPage(left, right, view.width) },
          pair.sessionId,
        );
        await evaluate(
          pair,
          "Promise.all([...document.images].map((i) => i.decode().catch(() => {})))",
        );
        writeFileSync(join(out, `${key}-${name}.png`), Buffer.from(await shoot(pair), "base64"));
        await cdp.send("Target.closeTarget", { targetId: pair.targetId });
      }
      writeFileSync(join(out, `${key}-full-design.png`), Buffer.from(await shoot(design), "base64"));
      writeFileSync(join(out, `${key}-full-report.png`), Buffer.from(await shoot(report), "base64"));
      await cdp.send("Target.closeTarget", { targetId: design.targetId });
      await cdp.send("Target.closeTarget", { targetId: report.targetId });
    }
  } finally {
    await cdp.send("Browser.close").catch(() => child.kill());
    await exited;
  }
  noOutsideRequest();
  writeFileSync(join(out, "style-diff.json"), `${JSON.stringify(styles, null, 2)}\n`);
  writeFileSync(join(out, "heights.json"), `${JSON.stringify(heights, null, 2)}\n`);
  return { sections, differences, views: VIEWS.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chromePath = findChrome(options.chrome);
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  chmodSync(options.out, 0o700);
  const work = mkdtempSync(join(tmpdir(), "guard-report-compare-"));
  try {
    const counts = await compare(
      chromePath,
      {
        design: pathToFileURL(resolve(options.design)).href,
        report: pathToFileURL(resolve(options.report)).href,
      },
      work,
      options.out,
    );
    process.stdout.write(
      `report-compare: ${counts.views} views, ${counts.sections} section pairs, ${counts.differences} differing properties\n`,
    );
  } finally {
    // Only the folder this run made: Chrome's profile.
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(`report-compare: ${error.message}\n`);
  process.exitCode = 1;
}
