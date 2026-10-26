#!/usr/bin/env node
// cspell:words breakpad
// Screenshots of the scan report for the README, from the synthetic verified corpus.
//
//   node scripts/readme-screenshots.mjs --out <folder> [--chrome <path>] [--scale <n>]
//                                       [--keep-html] [--allow-test-only]
//
// 1. Bundles the synthetic corpus (src/__tests__/verified-corpus.ts) and the report renderer
//    (src/core/report.ts) with tsup, and renders the standalone page. The corpus is made up: no
//    transcript, repository or other file on this machine is read.
// 2. Opens the page in headless Chrome with a new, empty profile, driven over
//    --remote-debugging-pipe, so no port is opened. It captures, as PNG:
//      scan-report-{light,dark}.png        1280 px wide: the top of the page, to the totals
//      scan-report-cards-{light,dark}.png  1280 px wide: "What actually happened"
//      scan-report-phone-{light,dark}.png  390 px wide: the top of the page, to the totals
//
// No network. The page itself loads nothing: its Content-Security-Policy allows no request, and
// it uses the system's fonts. On top of that, Chrome starts with its background services and
// web fonts off and every host name mapped to nothing, and every request the page makes is
// intercepted: one for anything but a file: or data: URL is failed, and fails the run.
//
// The images must show only wording the report ships, so the cards are built by the report's
// own builders. --allow-test-only, for a preview, uses the corpus's test-only builders
// instead (`TEST_ONLY_BUILDERS`); without it, a render that holds a line from one (a
// `data-template` id starting `test-only.`) is refused.
//
// Needs Node 20+, the dev dependencies (pnpm install) and Chrome or Chromium. Chrome is found
// from --chrome, then CHROME_PATH, then the usual install paths.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CORPUS = join(ROOT, "src", "__tests__", "verified-corpus.ts");
const REPORT = join(ROOT, "src", "core", "report.ts");

const USAGE = `Usage: node scripts/readme-screenshots.mjs --out <folder> [--chrome <path>] [--scale <n>]
                                           [--keep-html] [--allow-test-only]

  --out <folder>     Where to write the PNG files (created if missing). Required.
  --chrome <path>    The Chrome or Chromium binary. Default: CHROME_PATH, then the usual paths.
  --scale <n>        Device pixel ratio, 1 to 3. Default 2.
  --keep-html        Also write the rendered page, as scan-report.html.
  --allow-test-only  Build the cards with the corpus's test-only builders (a preview only).
`;

/** The shots: name, viewport width, theme, and which part of the page. */
const SHOTS = [
  { name: "scan-report-light", width: 1280, theme: "light", part: "lead" },
  { name: "scan-report-dark", width: 1280, theme: "dark", part: "lead" },
  { name: "scan-report-cards-light", width: 1280, theme: "light", part: "cards" },
  { name: "scan-report-cards-dark", width: 1280, theme: "dark", part: "cards" },
  { name: "scan-report-phone-light", width: 390, theme: "light", part: "lead" },
  { name: "scan-report-phone-dark", width: 390, theme: "dark", part: "lead" },
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
  const options = { scale: 2, keepHtml: false, allowTestOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === "--out" || arg === "--chrome" || arg === "--scale") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value\n\n${USAGE}`);
      i += 1;
      if (arg === "--out") options.out = value;
      else if (arg === "--chrome") options.chrome = value;
      else options.scale = Number(value);
    } else if (arg === "--keep-html") {
      options.keepHtml = true;
    } else if (arg === "--allow-test-only") {
      options.allowTestOnly = true;
    } else {
      fail(`unknown argument "${arg}"\n\n${USAGE}`);
    }
  }
  if (options.out === undefined) fail(`--out is required\n\n${USAGE}`);
  if (!(options.scale >= 1 && options.scale <= 3)) fail("--scale must be a number from 1 to 3");
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

/** Render the synthetic verified report to one standalone HTML page. */
async function renderPage(work, allowTestOnly) {
  const { build } = await import("tsup");
  const outDir = join(work, "bundle");
  await build({
    entry: { corpus: CORPUS, report: REPORT },
    outDir,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    platform: "node",
    target: "node20",
    // One copy of each module, shared by both entries.
    splitting: true,
    noExternal: [/.*/],
    dts: false,
    sourcemap: false,
    clean: false,
    silent: true,
    config: false,
  });
  const corpus = await import(pathToFileURL(join(outDir, "corpus.mjs")).href);
  const { renderReport } = await import(pathToFileURL(join(outDir, "report.mjs")).href);
  if (corpus.VERIFIED_RESULT === undefined || corpus.VERIFIED_META === undefined) {
    fail("the corpus exports no VERIFIED_RESULT and VERIFIED_META");
  }
  // The report's own card builders, unless a preview asks for the corpus's test-only ones.
  const builders = allowTestOnly ? corpus.TEST_ONLY_BUILDERS : undefined;
  const html = renderReport(corpus.VERIFIED_RESULT, corpus.VERIFIED_META, {
    variant: "document",
    localFixCategories: corpus.LOCAL_FIX_CATEGORIES ?? [],
    ...(builders === undefined ? {} : { cardBuilders: builders }),
  });
  if (!html.includes('id="what-happened"')) fail("the page has no verified sections");
  if (/@font-face|<link\b|\bsrc=["']https?:/i.test(html)) {
    fail("the page names an outside font, stylesheet or source");
  }
  if (html.includes('data-template="test-only.') && !allowTestOnly) {
    fail(
      "a card line comes from a test-only builder, whose wording does not ship. " +
        "Pass --allow-test-only for a preview.",
    );
  }
  return html;
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

/** Where each part of the page starts and ends, in CSS pixels from the top. */
const REGIONS = `(() => {
  const box = (selector) => {
    const element = document.querySelector(selector);
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { top: rect.top + scrollY, bottom: rect.bottom + scrollY };
  };
  return { stats: box("section.stats"), cards: box("#what-happened") };
})()`;

/** The clip for one part of the page. */
function clipFor(part, regions, width) {
  const pad = 24;
  if (part === "lead") {
    if (regions.stats === null) fail("the page has no totals section");
    return { x: 0, y: 0, width, height: Math.ceil(regions.stats.bottom + pad), scale: 1 };
  }
  if (regions.cards === null) fail('the page has no "What actually happened" section');
  const y = Math.max(0, Math.floor(regions.cards.top - pad));
  return { x: 0, y, width, height: Math.ceil(regions.cards.bottom + pad - y), scale: 1 };
}

async function capture(chromePath, pageUrl, work, out, scale) {
  const child = spawn(chromePath, [...CHROME_FLAGS, `--user-data-dir=${join(work, "profile")}`], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const cdp = devtools(child);
  const refused = [];
  cdp.on((message) => {
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    if (/^(?:file|data):/.test(request.url)) {
      cdp.send("Fetch.continueRequest", { requestId }, message.sessionId).catch(() => {});
    } else {
      refused.push(request.url);
      const params = { requestId, errorReason: "BlockedByClient" };
      cdp.send("Fetch.failRequest", params, message.sessionId).catch(() => {});
    }
  });
  const noOutsideRequest = () => {
    if (refused.length > 0) {
      fail(`the page asked for ${refused.length} outside resource(s): ${refused.join(", ")}`);
    }
  };
  const written = [];
  try {
    for (const shot of SHOTS) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: shot.width, height: 900, deviceScaleFactor: scale, mobile: shot.width < 600 },
        sessionId,
      );
      await cdp.send(
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", value: shot.theme }] },
        sessionId,
      );
      const loaded = cdp.once("Page.loadEventFired", sessionId);
      await cdp.send("Page.navigate", { url: pageUrl }, sessionId);
      await loaded;
      // Checked before each image is written, so a page that reached out leaves no image.
      noOutsideRequest();
      const { result } = await cdp.send(
        "Runtime.evaluate",
        { expression: REGIONS, returnByValue: true },
        sessionId,
      );
      const clip = clipFor(shot.part, result.value, shot.width);
      const { data } = await cdp.send(
        "Page.captureScreenshot",
        { format: "png", clip, captureBeyondViewport: true },
        sessionId,
      );
      const file = join(out, `${shot.name}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      written.push(file);
      await cdp.send("Target.closeTarget", { targetId });
    }
  } finally {
    await cdp.send("Browser.close").catch(() => child.kill());
    await exited;
  }
  noOutsideRequest();
  return written;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chromePath = findChrome(options.chrome);
  const work = mkdtempSync(join(tmpdir(), "guard-readme-shots-"));
  try {
    const html = await renderPage(work, options.allowTestOnly);
    const page = join(work, "scan-report.html");
    writeFileSync(page, html);
    mkdirSync(options.out, { recursive: true });
    if (options.keepHtml) writeFileSync(join(options.out, "scan-report.html"), html);
    const written = await capture(
      chromePath,
      pathToFileURL(page).href,
      work,
      options.out,
      options.scale,
    );
    for (const file of written) process.stdout.write(`${file}\n`);
  } finally {
    // Only the folder this run made: the bundle, the page and Chrome's profile.
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(`readme-screenshots: ${error.message}\n`);
  process.exitCode = 1;
}
