// cspell:words beforeprint afterprint
/**
 * The report's one script: what it must never contain, and what it does.
 *
 * The static checks read the source: a Content-Security-Policy stops requests but not
 * navigation, so every network, navigation and markup API is banned here, each ban with a
 * negative control. The behaviour checks run the real script in a bare `node:vm` context,
 * against a small stand-in for the page that implements only what the script touches.
 */

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  EXPORT_PREFIX,
  REPORT_SCRIPT,
  REPORT_SCRIPT_LOGIC,
  SHARE_PREFIX,
  THEME_KEY,
} from "../core/report-script.js";

// ── What the script must never contain ──────────────────────────────────────

/** The two `href` writes the script may make, each behind a fixed prefix. */
const ALLOWED_HREF_WRITES = [
  "a.href = exportHref(data.textContent);",
  "shareLink.href = shareHref(shareInput.value, suffix);",
];

const BANNED: readonly [string, RegExp, string][] = [
  ["fetch", /\bfetch\b/, "fetch('/x')"],
  ["XMLHttpRequest", /XMLHttpRequest/, "new XMLHttpRequest()"],
  ["WebSocket", /WebSocket/, "new WebSocket('wss://x')"],
  ["EventSource", /EventSource/, "new EventSource('/x')"],
  ["sendBeacon", /sendBeacon/, "navigator.sendBeacon('/x', d)"],
  ["dynamic import", /\bimport\s*\(/, "import('./x.js')"],
  ["a worker", /\bWorker\b/, "new Worker('x.js')"],
  ["an image request", /new\s+Image\b/, "new Image().src = u"],
  ["a src write", /\.src\s*=/, "img.src = u"],
  ["an object URL", /createObjectURL/, "URL.createObjectURL(b)"],
  ["location", /\blocation\b/, "window.location = u"],
  ["window.open", /window\.open/, "window.open(u)"],
  ["a URL attribute write", /setAttribute\(\s*["'](href|src|action)/, "a.setAttribute('href', u)"],
  ["innerHTML", /innerHTML/, "el.innerHTML = s"],
  ["outerHTML", /outerHTML/, "el.outerHTML = s"],
  ["insertAdjacentHTML", /insertAdjacentHTML/, "el.insertAdjacentHTML('beforeend', s)"],
  ["document.write", /document\.write/, "document.write(s)"],
  ["eval", /\beval\b/, "eval(s)"],
  ["the Function constructor", /\bFunction\s*\(/, "new Function(s)"],
  ["a timer given a string", /setTimeout\(\s*["'`]/, "setTimeout('x()', 1)"],
];

describe("the script contains no network, navigation or markup API", () => {
  it.each(BANNED)("no %s", (_label, pattern) => {
    expect(REPORT_SCRIPT).not.toMatch(pattern);
  });

  it.each(BANNED)("negative control — the %s matcher fires", (_label, pattern, violating) => {
    expect(violating).toMatch(pattern);
  });

  it("writes an href in exactly the two allowed statements", () => {
    const writes = REPORT_SCRIPT.split("\n")
      .map((line) => line.trim())
      .filter((line) => /\.href\s*=/.test(line));
    expect(writes).toEqual(ALLOWED_HREF_WRITES);
  });

  it("negative control — a third href write is seen", () => {
    const tampered = `${REPORT_SCRIPT}\nlink.href = other;`;
    expect(tampered.split("\n").filter((line) => /\.href\s*=/.test(line))).toHaveLength(3);
  });

  it("names no URL but the X post prefix", () => {
    expect(REPORT_SCRIPT.match(/https?:\/\/[^\s"'`]*/g)).toEqual([SHARE_PREFIX]);
  });

  it("each allowed write starts from a fixed prefix", () => {
    expect(SHARE_PREFIX).toBe("https://x.com/intent/post?text=");
    expect(EXPORT_PREFIX.startsWith("data:application/json")).toBe(true);
    expect(REPORT_SCRIPT_LOGIC).toContain(
      "return SHARE_PREFIX + encodeURIComponent(String(text)) + suffix;",
    );
    expect(REPORT_SCRIPT_LOGIC).toContain("return EXPORT_PREFIX + encodeURIComponent(");
  });
});

// ── The pure functions ──────────────────────────────────────────────────────

interface Logic {
  xLength(text: string): number;
  postLength(text: string): number;
  shareSuffix(href: unknown): string | null;
  shareHref(text: string, suffix: string): string;
  readTheme(value: unknown): string | null;
  nextTheme(current: unknown, systemDark: boolean): string;
  isFilter(value: unknown): boolean;
  rowVisible(filter: string, action: string | null): boolean;
  isSort(value: unknown): boolean;
  rankOf(value: unknown): number;
  exportHref(raw: string): string;
}

const logic = runInNewContext(
  `${REPORT_SCRIPT_LOGIC}
({ xLength, postLength, shareSuffix, shareHref, readTheme, nextTheme, isFilter, rowVisible,
   isSort, rankOf, exportHref });`,
) as Logic;

const SUFFIX = `&url=${encodeURIComponent("https://www.agenttrail.sh/agenttrail-guard?utm_source=guard")}&hashtags=agenttrail`;
const LINK = `${SHARE_PREFIX}${encodeURIComponent("hello")}${SUFFIX}`;

describe("the share link", () => {
  it("keeps the rendered link's suffix and rejects any other link", () => {
    expect(logic.shareSuffix(LINK)).toBe(SUFFIX);
    expect(logic.shareSuffix("javascript:alert(1)")).toBeNull();
    expect(logic.shareSuffix(`https://example.com/?text=a${SUFFIX}`)).toBeNull();
    expect(logic.shareSuffix(null)).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    '"><script>alert(1)</script>',
    "line one\nline two",
    "&url=https://example.com&hashtags=x",
    "日本語 and café 🙂",
  ])("stays an X post whatever is typed: %s", (typed) => {
    const href = logic.shareHref(typed, SUFFIX);
    expect(href.startsWith(SHARE_PREFIX)).toBe(true);
    const url = new URL(href);
    expect(url.origin).toBe("https://x.com");
    expect(url.searchParams.get("text")).toBe(typed);
    expect(url.searchParams.getAll("url")).toEqual([
      "https://www.agenttrail.sh/agenttrail-guard?utm_source=guard",
    ]);
    expect(url.searchParams.getAll("hashtags")).toEqual(["agenttrail"]);
  });

  it("weighs text as X does", () => {
    const base = logic.postLength("");
    expect(base).toBe(1 + 23 + 1 + "#agenttrail".length);
    expect(logic.xLength("abc")).toBe(3);
    expect(logic.xLength("日本")).toBe(4);
    expect(logic.xLength("🙂")).toBe(2);
  });
});

describe("theme, filters and sort", () => {
  it("reads back only light or dark", () => {
    expect(logic.readTheme("light")).toBe("light");
    expect(logic.readTheme("dark")).toBe("dark");
    for (const junk of ["", "Dark", "blue", "<script>", null, undefined, 1]) {
      expect(logic.readTheme(junk)).toBeNull();
    }
  });

  it("toggles away from what is shown, starting from the system's choice", () => {
    expect(logic.nextTheme(null, true)).toBe("light");
    expect(logic.nextTheme(null, false)).toBe("dark");
    expect(logic.nextTheme("light", true)).toBe("dark");
    expect(logic.nextTheme("junk", false)).toBe("dark");
  });

  it("accepts only the four filters and the four sorts", () => {
    for (const f of ["all", "block", "require_approval", "warn"])
      expect(logic.isFilter(f)).toBe(true);
    for (const f of ["", "ask", "toString", "__proto__"]) expect(logic.isFilter(f)).toBe(false);
    for (const s of ["serious", "category", "count", "name"]) expect(logic.isSort(s)).toBe(true);
    for (const s of ["", "toString", "hasOwnProperty", "__proto__"])
      expect(logic.isSort(s)).toBe(false);
  });

  it("shows a row for its own action, or for all", () => {
    expect(logic.rowVisible("all", "warn")).toBe(true);
    expect(logic.rowVisible("block", "block")).toBe(true);
    expect(logic.rowVisible("block", "warn")).toBe(false);
  });

  it("reads a rank as a whole number, and anything else as zero", () => {
    expect(logic.rankOf("7")).toBe(7);
    for (const junk of ["", "-3", "x", null, "Infinity"]) expect(logic.rankOf(junk)).toBe(0);
  });
});

describe("the export", () => {
  it("is a data URL holding exactly the embedded data, pretty-printed", () => {
    const payload = { tool: "agenttrail-guard", findings: [{ text: "a </script> b" }] };
    const raw = JSON.stringify(payload).replace(/</g, "\\u003c");
    const href = logic.exportHref(raw);
    expect(href.startsWith(EXPORT_PREFIX)).toBe(true);
    const json = decodeURIComponent(href.slice(EXPORT_PREFIX.length));
    expect(JSON.parse(json)).toEqual(payload);
    expect(json.endsWith("\n")).toBe(true);
  });
});

// ── The script in a page ────────────────────────────────────────────────────

type Listener = () => void;

/** The parts of an element the script touches, and nothing more. */
class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  hidden = false;
  open = false;
  textContent = "";
  value = "";
  download = "";
  selected = false;
  constructor(
    readonly tagName: string,
    attrs: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    if ("hidden" in attrs) this.hidden = true;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  get href(): string {
    return this.attrs.get("href") ?? "";
  }
  set href(value: string) {
    this.attrs.set("href", value);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  click(): void {
    this.fire("click");
  }
  select(): void {
    this.selected = true;
  }
}

interface Page {
  readonly elements: FakeElement[];
  readonly byId: Map<string, FakeElement>;
  readonly root: FakeElement;
  readonly windowListeners: Map<string, Listener[]>;
  readonly stored: Map<string, string>;
  readonly appended: FakeElement[];
  printed: number;
  copied: string[];
}

interface PageOptions {
  readonly storage?: "works" | "throws";
  readonly stored?: string;
  readonly systemDark?: boolean;
}

/** A page shaped like the report, with three findings, and the script run against it. */
function loadPage(options: PageOptions = {}): Page {
  const el = (tag: string, attrs: Record<string, string> = {}): FakeElement =>
    new FakeElement(tag, attrs);
  const elements: FakeElement[] = [
    el("button", { id: "theme-toggle", class: "js-only", hidden: "" }),
    el("button", { id: "print-button", class: "js-only", hidden: "" }),
    el("button", { id: "export-button", class: "js-only", hidden: "" }),
    el("div", { class: "controls js-only", hidden: "" }),
    el("button", { "data-filter": "all", "aria-pressed": "true" }),
    el("button", { "data-filter": "block", "aria-pressed": "false" }),
    el("button", { "data-filter": "warn", "aria-pressed": "false" }),
    el("button", { "data-filter": "nonsense", "aria-pressed": "false" }),
    el("select", { id: "sort" }),
    el("p", { id: "findings-status" }),
    el("li", {
      class: "finding",
      "data-action": "block",
      "data-rank-name": "2",
      "data-rank-count": "1",
    }),
    el("li", {
      class: "finding",
      "data-action": "warn",
      "data-rank-name": "0",
      "data-rank-count": "0",
    }),
    el("li", {
      class: "finding",
      "data-action": "require_approval",
      "data-rank-name": "1",
      "data-rank-count": "x",
    }),
    el("details", {}),
    el("details", {}),
    el("code", { id: "cmd-init" }),
    el("button", {
      class: "copy js-only",
      hidden: "",
      "data-copy": "cmd-init",
      "data-label": "Copy",
    }),
    el("textarea", { id: "share-text" }),
    el("a", { id: "share-link", href: LINK }),
    el("span", { id: "share-count" }),
    el("textarea", { id: "copy-buffer" }),
    el("script", { id: "report-data" }),
  ];
  const byId = new Map<string, FakeElement>();
  for (const e of elements) {
    const id = e.getAttribute("id");
    if (id !== null) byId.set(id, e);
  }
  const code = byId.get("cmd-init");
  if (code) code.textContent = "agenttrail-guard init --agent claude";
  const data = byId.get("report-data");
  if (data) data.textContent = JSON.stringify({ tool: "agenttrail-guard", n: 1 });
  const details = elements.filter((e) => e.tagName === "details");
  if (details[1]) details[1].open = true;

  const root = new FakeElement("html");
  const windowListeners = new Map<string, Listener[]>();
  const stored = new Map<string, string>();
  if (options.stored !== undefined) stored.set(THEME_KEY, options.stored);
  const appended: FakeElement[] = [];
  const page: Page = {
    elements,
    byId,
    root,
    windowListeners,
    stored,
    appended,
    printed: 0,
    copied: [],
  };

  const matches = (e: FakeElement, selector: string): boolean => {
    const classes = (e.getAttribute("class") ?? "").split(" ");
    if (selector === ".js-only") return classes.includes("js-only");
    if (selector === ".finding") return classes.includes("finding");
    if (selector === "[data-filter]") return e.getAttribute("data-filter") !== null;
    if (selector === "[data-copy]") return e.getAttribute("data-copy") !== null;
    if (selector === "details") return e.tagName === "details";
    throw new Error(`the script asked for a selector this page does not model: ${selector}`);
  };

  const localStorage = {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  };
  const window = {
    get localStorage() {
      if (options.storage === "throws") throw new Error("storage is blocked");
      return localStorage;
    },
    matchMedia: () => ({ matches: options.systemDark ?? false }),
    print: () => {
      page.printed++;
    },
    addEventListener: (type: string, fn: Listener) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]);
    },
  };
  const document = {
    documentElement: root,
    body: {
      appendChild: (e: FakeElement) => void appended.push(e),
      removeChild: () => undefined,
    },
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (selector: string) => elements.filter((e) => matches(e, selector)),
    createElement: (tag: string) => new FakeElement(tag),
    execCommand: () => true,
  };
  const navigator = {
    clipboard: {
      writeText: (text: string) => {
        page.copied.push(text);
        return Promise.resolve();
      },
    },
  };
  runInNewContext(REPORT_SCRIPT, { window, document, navigator, setTimeout: () => 0 });
  return page;
}

const rows = (page: Page) => page.elements.filter((e) => e.getAttribute("class") === "finding");
const filterButton = (page: Page, value: string) =>
  page.elements.find((e) => e.getAttribute("data-filter") === value) as FakeElement;

describe("the script in the page", () => {
  it("reveals the controls that need it", () => {
    const page = loadPage();
    const hidden = page.elements.filter(
      (e) => (e.getAttribute("class") ?? "").includes("js-only") && e.hidden,
    );
    expect(hidden).toEqual([]);
  });

  it("filters rows, marks the pressed button and announces the count", () => {
    const page = loadPage();
    filterButton(page, "block").click();
    expect(rows(page).map((r) => r.hidden)).toEqual([false, true, true]);
    expect(filterButton(page, "block").getAttribute("aria-pressed")).toBe("true");
    expect(filterButton(page, "all").getAttribute("aria-pressed")).toBe("false");
    expect(page.byId.get("findings-status")?.textContent).toBe("Showing 1 of 3 guardrails");
    filterButton(page, "all").click();
    expect(rows(page).map((r) => r.hidden)).toEqual([false, false, false]);
  });

  it("ignores a filter it does not know", () => {
    const page = loadPage();
    filterButton(page, "nonsense").click();
    expect(rows(page).map((r) => r.hidden)).toEqual([false, false, false]);
    expect(filterButton(page, "all").getAttribute("aria-pressed")).toBe("true");
  });

  it("sorts by moving rows on screen only, and leaves their order in the page alone", () => {
    const page = loadPage();
    const before = rows(page);
    const sort = page.byId.get("sort") as FakeElement;
    sort.value = "name";
    sort.fire("change");
    expect(rows(page)).toEqual(before);
    expect(rows(page).map((r) => r.style.order)).toEqual(["2", "0", "1"]);
    expect(page.byId.get("findings-status")?.textContent).toContain("stays most serious first");
    sort.value = "count";
    sort.fire("change");
    expect(rows(page).map((r) => r.style.order)).toEqual(["1", "0", "0"]);
  });

  it("ignores a sort it does not know", () => {
    const page = loadPage();
    const sort = page.byId.get("sort") as FakeElement;
    sort.value = "toString";
    sort.fire("change");
    expect(rows(page).map((r) => r.style.order)).toEqual([undefined, undefined, undefined]);
  });

  it("remembers a theme choice, and applies it on the next load", () => {
    const page = loadPage({ systemDark: true });
    (page.byId.get("theme-toggle") as FakeElement).click();
    expect(page.root.getAttribute("data-theme")).toBe("light");
    expect(page.stored.get(THEME_KEY)).toBe("light");
    const again = loadPage({ stored: "light" });
    expect(again.root.getAttribute("data-theme")).toBe("light");
  });

  it("ignores a stored theme that is not light or dark", () => {
    const page = loadPage({ stored: '"><script>' });
    expect(page.root.getAttribute("data-theme")).toBeNull();
  });

  it("still works when storage is blocked", () => {
    const page = loadPage({ storage: "throws" });
    (page.byId.get("theme-toggle") as FakeElement).click();
    expect(page.root.getAttribute("data-theme")).toBe("dark");
    filterButton(page, "warn").click();
    expect(rows(page).map((r) => r.hidden)).toEqual([true, false, true]);
  });

  it("copies the text of the element a button names", async () => {
    const page = loadPage();
    page.elements.find((e) => e.getAttribute("data-copy") === "cmd-init")?.click();
    await Promise.resolve();
    expect(page.copied).toEqual(["agenttrail-guard init --agent claude"]);
  });

  it("keeps the Post-on-X link an X post as the text is edited, and counts it", () => {
    const page = loadPage();
    const input = page.byId.get("share-text") as FakeElement;
    const link = page.byId.get("share-link") as FakeElement;
    for (const typed of ["javascript:alert(1)", '"><script>alert(1)</script>', "a\nb"]) {
      input.value = typed;
      input.fire("input");
      expect(link.href.startsWith(SHARE_PREFIX)).toBe(true);
      expect(new URL(link.href).searchParams.get("text")).toBe(typed);
      expect(link.href.endsWith(SUFFIX)).toBe(true);
    }
    input.value = "x".repeat(300);
    input.fire("input");
    expect(page.byId.get("share-count")?.getAttribute("data-over")).toBe("true");
  });

  it("prints, opening every collapsed section and closing them again after", () => {
    const page = loadPage();
    (page.byId.get("print-button") as FakeElement).click();
    expect(page.printed).toBe(1);
    const details = page.elements.filter((e) => e.tagName === "details");
    for (const fn of page.windowListeners.get("beforeprint") ?? []) fn();
    expect(details.map((d) => d.open)).toEqual([true, true]);
    for (const fn of page.windowListeners.get("afterprint") ?? []) fn();
    expect(details.map((d) => d.open)).toEqual([false, true]);
  });

  it("exports the embedded data as a download, through a data URL", () => {
    const page = loadPage();
    (page.byId.get("export-button") as FakeElement).click();
    const [link] = page.appended;
    expect(link?.download).toBe("agenttrail-guard-report.json");
    expect(link?.href.startsWith(EXPORT_PREFIX)).toBe(true);
    expect(JSON.parse(decodeURIComponent((link?.href ?? "").slice(EXPORT_PREFIX.length)))).toEqual({
      tool: "agenttrail-guard",
      n: 1,
    });
  });
});
