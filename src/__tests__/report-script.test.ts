// cspell:words beforeprint afterprint ttps
/**
 * The report's one script: what it must never contain, and what it does.
 *
 * The static checks read the source: a Content-Security-Policy stops requests but not
 * navigation, so the script is held to allow-lists — the property names it may use, the lines
 * that may mention `href`, the attributes it may set and the element it may create — with a
 * negative control per rule. The behaviour checks run the real script in a bare `node:vm` context,
 * against a small stand-in for the page that implements only what the script touches.
 */

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderReport } from "../core/report.js";
import {
  EXPORT_PREFIX,
  REPORT_SCRIPT,
  REPORT_SCRIPT_LOGIC,
  SHARE_PREFIX,
  THEME_KEY,
} from "../core/report-script.js";

// ── What the script may contain: allow-lists ────────────────────────────────

/** Every property name the script may use. Anything else is a violation. */
const ALLOWED_PROPERTIES = new Set([
  "addEventListener",
  "appendChild",
  "body",
  "call",
  "click",
  "clipboard",
  "codePointAt",
  "createElement",
  "documentElement",
  "download",
  "execCommand",
  "focus",
  "forEach",
  "from",
  "getAttribute",
  "getElementById",
  "getItem",
  "getSelection",
  "hidden",
  "href",
  "indexOf",
  "length",
  "localStorage",
  "matchMedia",
  "matches",
  "open",
  "order",
  "parse",
  "print",
  "prototype",
  "push",
  "querySelectorAll",
  "removeChild",
  "select",
  "selectAllChildren",
  "setAttribute",
  "setItem",
  "slice",
  "stringify",
  "style",
  "tagName",
  "textContent",
  "then",
  "value",
  "writeText",
]);

/** The only lines that may mention `href`: two writes, each behind a fixed prefix. */
const ALLOWED_HREF_LINES = [
  "function shareSuffix(href) {",
  'if (typeof href !== "string" || href.indexOf(SHARE_PREFIX) !== 0) return null;',
  'var at = href.indexOf("&url=");',
  "return at === -1 ? null : href.slice(at);",
  "function shareHref(text, suffix) {",
  "function exportHref(raw) {",
  "a.href = exportHref(data.textContent);",
  'var suffix = shareLink ? shareSuffix(shareLink.getAttribute("href")) : null;',
  "shareLink.href = shareHref(shareInput.value, suffix);",
];

/** The only statements that may add or remove an element: the export's temporary link. */
const ALLOWED_TREE_CHANGES = ["document.body.appendChild(a);", "document.body.removeChild(a);"];

/** The only object whose method the script may borrow with `.call`. */
const ALLOWED_CALL = "Array.prototype.forEach";

/** The only statement that may click an element: the export's temporary link. */
const ALLOWED_CLICKS = ["a.click();"];

/** Names that may be assigned in one statement only: the export's link and the post suffix. */
const PINNED_ASSIGNMENTS: readonly (readonly [string, string])[] = [
  ["a", 'var a = document.createElement("a");'],
  ["suffix", 'var suffix = shareLink ? shareSuffix(shareLink.getAttribute("href")) : null;'],
];

/** The attributes the script may set, and the one element it may create. */
const SETTABLE_ATTRIBUTES = new Set(['"data-theme"', '"aria-pressed"', '"data-over"']);
const CREATABLE_ELEMENTS = new Set(['"a"']);

/** Calls and names that are never allowed, whatever property list they get past. */
const BANNED_CODE: readonly [string, RegExp][] = [
  ["a call to open", /\bopen\s*\(/],
  ["computed member access", /[\w$)\]]\s*\[/],
  ["an appending href write", /\.href\s*[-+*|&]=/],
  ["a timer given a string", /set(Timeout|Interval)\(\s*""/],
  ["dynamic import", /\bimport\s*\(/],
  ["eval", /\beval\b/],
  ["the Function constructor", /\bFunction\b/],
  ["a network constructor", /\b(XMLHttpRequest|WebSocket|EventSource|Worker|Image)\b/],
  ["fetch", /\bfetch\b/],
  ["location", /\blocation\b/],
  ["Reflect", /\bReflect\b/],
];

/** Split the script into code with string literals emptied, and the literals themselves. */
function splitStrings(source: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  const code = source
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (literal) => {
      strings.push(literal);
      return '""';
    })
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return { code, strings };
}

/** Every way `source` steps outside the allow-lists. Empty for the shipped script. */
function scriptViolations(source: string): string[] {
  const out: string[] = [];
  const { code, strings } = splitStrings(source);
  const lines = source.split("\n").map((line) => line.trim());

  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) {
    if (!ALLOWED_PROPERTIES.has(m[1] ?? "")) out.push(`property .${m[1]}`);
  }
  // A borrowed method runs with any receiver, so only the one known borrow is allowed.
  for (const m of code.matchAll(/([\w$.\s]*?)\.\s*call\b/g)) {
    if (
      (m[1] ?? "")
        .replace(/\s+/g, "")
        .split(/[^\w$.]/)
        .pop() !== ALLOWED_CALL
    ) {
      out.push(`borrowed call: ${(m[0] ?? "").trim()}`);
    }
  }
  // These two are checked by their arguments below, so they may only be called directly.
  for (const m of code.matchAll(/\b(setAttribute|createElement)\b(?!\s*\()/g)) {
    out.push(`indirect ${m[1]}`);
  }
  for (const line of code.split("\n").map((l) => l.trim())) {
    // With the string literals emptied, an event name like "click" is gone: only code is left.
    if (/\bclick\b/.test(line) && !ALLOWED_CLICKS.includes(line)) out.push(`click: ${line}`);
  }
  // The clicked element and the post link's fixed suffix are each set in one place only.
  for (const line of lines) {
    for (const [name, only] of PINNED_ASSIGNMENTS) {
      if (new RegExp(`\\b${name}\\s*(=(?!=)|\\+=)`).test(line) && line !== only) {
        out.push(`assignment to ${name}: ${line}`);
      }
    }
  }
  for (const [label, pattern] of BANNED_CODE) {
    if (pattern.test(code)) out.push(label);
  }
  for (const line of lines.filter((l) => /href/i.test(l))) {
    if (!ALLOWED_HREF_LINES.includes(line)) out.push(`href line: ${line}`);
  }
  for (const line of lines.filter((l) =>
    /\b(appendChild|removeChild|insertBefore|replaceChild|replaceChildren|append|prepend|before|after|replaceWith|remove)\s*\(/.test(
      l,
    ),
  )) {
    if (!ALLOWED_TREE_CHANGES.includes(line)) out.push(`tree change: ${line}`);
  }
  for (const m of source.matchAll(/setAttribute\(\s*([^,)]*)/g)) {
    if (!SETTABLE_ATTRIBUTES.has((m[1] ?? "").trim())) out.push(`setAttribute ${m[1]}`);
  }
  for (const m of source.matchAll(/createElement\(\s*([^,)]*)/g)) {
    if (!CREATABLE_ELEMENTS.has((m[1] ?? "").trim())) out.push(`createElement ${m[1]}`);
  }
  for (const literal of strings) {
    const text = literal.slice(1, -1);
    const isUrl = /^(\w+:|\/\/)/.test(text) || text.includes("//");
    if (isUrl && text !== SHARE_PREFIX && text !== EXPORT_PREFIX) out.push(`URL ${literal}`);
  }
  return out;
}

describe("the script stays inside its allow-lists", () => {
  it("the shipped script has no violation", () => {
    expect(scriptViolations(REPORT_SCRIPT)).toEqual([]);
  });

  it("is plain ASCII, so its hash holds whatever encoding a reader's browser picks", () => {
    expect([...REPORT_SCRIPT].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)).toEqual([]);
  });

  it("writes an href in exactly the two allowed statements", () => {
    const writes = REPORT_SCRIPT.split("\n")
      .map((line) => line.trim())
      .filter((line) => /\.href\s*=/.test(line));
    expect(writes).toEqual([
      "a.href = exportHref(data.textContent);",
      "shareLink.href = shareHref(shareInput.value, suffix);",
    ]);
  });

  it("each allowed write starts from a fixed prefix", () => {
    expect(SHARE_PREFIX).toBe("https://x.com/intent/post?text=");
    expect(EXPORT_PREFIX.startsWith("data:application/json")).toBe(true);
    expect(REPORT_SCRIPT_LOGIC).toContain(
      "return SHARE_PREFIX + encodeURIComponent(wellFormed(text)) + suffix;",
    );
    expect(REPORT_SCRIPT_LOGIC).toContain("return EXPORT_PREFIX + encodeURIComponent(");
  });

  // One tampered statement per rule. Each must be reported.
  const TAMPERED: readonly [string, string][] = [
    ["a bare open()", "open(u);"],
    ["self.open()", "self.open(u);"],
    ["window.open()", "window.open(u);"],
    ["a computed href write", 'a["href"] = u;'],
    ["a computed name", "window[key] = u;"],
    ["an appending href write", "a.href += u;"],
    ["setAttribute with a variable name", "el.setAttribute(name, u);"],
    ["setAttribute href", 'el.setAttribute("href", u);'],
    ["setAttributeNS", 'el.setAttributeNS(null, "href", u);'],
    ["Object.assign", "Object.assign(a, { target: u });"],
    ["Reflect.set", 'Reflect.set(a, "target", u);'],
    ["a ping write", "a.ping = u;"],
    ["an action write", "f.action = u;"],
    ["a formAction write", "b.formAction = u;"],
    ["a srcdoc write", "i.srcdoc = u;"],
    ["a src write", "img.src = u;"],
    ["innerHTML", "el.innerHTML = s;"],
    ["outerHTML", "el.outerHTML = s;"],
    ["insertAdjacentHTML", 'el.insertAdjacentHTML("beforeend", s);'],
    ["document.write", "document.write(s);"],
    ["location", "location.assign(u);"],
    ["fetch", "fetch(u);"],
    ["sendBeacon", "navigator.sendBeacon(u, d);"],
    ["a WebSocket", "new WebSocket(u);"],
    ["an image", "new Image();"],
    ["dynamic import", 'import("./x.js");'],
    ["eval", "eval(s);"],
    ["the Function constructor", "new Function(s);"],
    ["a timer given a string", 'setTimeout("x()", 1);'],
    ["a protocol-relative URL", 'var u = "//example.com/x";'],
    ["a full URL", 'var u = "https://example.com/x";'],
    ["a javascript: URL", 'var u = "javascript:alert(1)";'],
    ["an href in an object literal", "var o = { href: u };"],
    ["moving a row", "row.parentNode.appendChild(row);"],
    ["inserting a row", "list.insertBefore(row, null);"],
    ["replacing the rows", "list.replaceChildren(row);"],
    ["appending a row", "list.append(row);"],
    ["creating another element", 'document.createElement("img");'],
    ["a borrowed setAttribute", 'shareLink.setAttribute.call(shareLink, "src", u);'],
    ["a borrowed createElement", 'var el = document.createElement.call(document, "iframe");'],
    ["a click on another element", "shareLink.click();"],
    [
      "a built attribute name through a borrowed call",
      'var k = "hr" + "ef"; shareLink.setAttribute.call(shareLink, k, "h" + "ttps" + ":" + "/" + "/e.example/?" + data.textContent);',
    ],
    ["a stored setAttribute", "var set = el.setAttribute; set(name, u);"],
    ["another borrowed method", "Array.prototype.map.call(rows, f);"],
    [
      "a click inside a listener",
      'x.addEventListener("click", function () { shareLink.click(); });',
    ],
    ["a click on another element named a", "var a = shareLink;\na.click();"],
    [
      "data added to the post suffix",
      'suffix = "&d=" + encodeURIComponent(data.textContent) + suffix;',
    ],
    ["data appended to the post suffix", "suffix += data.textContent;"],
  ];

  it.each(TAMPERED)("negative control — %s is reported", (_label, statement) => {
    expect(scriptViolations(`${REPORT_SCRIPT}\n${statement}\n`)).not.toEqual([]);
  });
});

// ── The script and the page agree ───────────────────────────────────────────

describe("everything the script looks for is in the rendered page", () => {
  const META = { version: "0.0.0", generatedAt: new Date("2026-10-01T09:00:00.000Z") };
  const finding = {
    ruleId: "t.x",
    title: "A guardrail",
    severity: "high",
    action: "block" as const,
    count: 1,
    examples: [{ text: "x", count: 1 }],
    owasp: ["ASI02" as const],
  };
  const html = renderReport(
    {
      agent: "claude",
      sessions: 1,
      quarantined: 0,
      notRead: 0,
      skippedLines: 0,
      projects: 1,
      toolCalls: 1,
      riskyActions: 1,
      riskyByAction: { block: 1, require_approval: 0, warn: 0 },
      decided: [{ action: "block", ruleIds: ["t.x"], calls: 1 }],
      findings: [finding],
      recurring: [],
      owasp: [{ id: "ASI02" as const, callCount: 1, ruleMatches: 1, guardrailCount: 1 }],
      tokens: null,
    },
    META,
  );
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  it("every id the script asks for", () => {
    const wanted = [...REPORT_SCRIPT.matchAll(/byId\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(wanted.length).toBeGreaterThan(5);
    for (const id of wanted) expect(ids.has(id), id).toBe(true);
  });

  it("every selector the script queries", () => {
    const present: Record<string, RegExp> = {
      ".js-only": /class="[^"]*\bjs-only\b/,
      "[data-filter]": /\sdata-filter="/,
      ".finding": /class="finding"/,
      "[data-copy]": /\sdata-copy="/,
      "[data-risk]": /\sdata-risk="/,
      details: /<details\b/,
    };
    const wanted = [...REPORT_SCRIPT.matchAll(/each\("([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(wanted.length).toBeGreaterThan(3);
    for (const selector of wanted) {
      const pattern = present[selector];
      expect(pattern, `no check for ${selector}`).toBeDefined();
      expect(html).toMatch(pattern as RegExp);
    }
  });

  it("every copy button names an element that exists", () => {
    const targets = [...html.matchAll(/\sdata-copy="([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(2);
    for (const id of targets) expect(ids.has(id), id).toBe(true);
  });

  /** The option values of one `<select>`. */
  const optionsOf = (id: string): string[] => {
    const at = html.indexOf(`<select id="${id}">`);
    const select = html.slice(at, html.indexOf("</select>", at));
    return [...select.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1] ?? "");
  };

  it("the sort control offers exactly the sorts the script accepts", () => {
    const options = optionsOf("sort");
    expect(options).toEqual(["serious", "category", "count", "name"]);
    for (const key of options) expect(html).toMatch(new RegExp(`data-rank-${key}="\\d+"`));
  });

  it("the risk filter offers any risk, then each risk touched, each one the script accepts", () => {
    expect(optionsOf("risk-filter")).toEqual(["", "ASI02"]);
    expect(logic.isRisk("ASI02")).toBe(true);
    expect(html).toContain('data-owasp="ASI02"');
    expect(html).toContain('data-risk="ASI02"');
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
  isRisk(value: unknown): boolean;
  copiedText(name: unknown): string;
  riskVisible(risk: string, ids: string | null): boolean;
  exportHref(raw: string): string;
}

const logic = runInNewContext(
  `${REPORT_SCRIPT_LOGIC}
({ xLength, postLength, shareSuffix, shareHref, readTheme, nextTheme, isFilter, rowVisible,
   isSort, rankOf, isRisk, riskVisible, copiedText, exportHref });`,
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

  it.each([
    ["edited text \uD800", "edited text \uFFFD"],
    ["\uDC00 at the start", "\uFFFD at the start"],
    ["pair 🙂 then \uDBFF", "pair 🙂 then \uFFFD"],
    ["pair 🙂", "pair 🙂"],
  ])("writes a lone surrogate as the replacement character instead of failing: %j", (typed, sent) => {
    const href = logic.shareHref(typed, SUFFIX);
    expect(new URL(href).searchParams.get("text")).toBe(sent);
    expect(href.endsWith(SUFFIX)).toBe(true);
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

  it("accepts an OWASP id only as the two lists spell them", () => {
    for (const id of ["ASI01", "ASI10", "LLM01", "LLM10"]) expect(logic.isRisk(id)).toBe(true);
    for (const junk of ["", "ASI00", "ASI11", "ASI1", "asi01", "LLM010", "XYZ01", "ASI0x", null, 1])
      expect(logic.isRisk(junk)).toBe(false);
  });

  it("shows a row for a risk it carries, or for any risk", () => {
    expect(logic.riskVisible("", null)).toBe(true);
    expect(logic.riskVisible("ASI02", "ASI02 LLM03")).toBe(true);
    expect(logic.riskVisible("LLM03", "ASI02 LLM03")).toBe(true);
    expect(logic.riskVisible("ASI02", null)).toBe(false);
    // A whole id, never part of one.
    expect(logic.riskVisible("ASI01", "ASI010")).toBe(false);
    expect(logic.riskVisible("nonsense", "nonsense")).toBe(false);
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
  /** Upper case, as a real page reports an HTML element's tag name. */
  readonly tagName: string;
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
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
  focused = false;
  focus(): void {
    this.focused = true;
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
  execCommands: string[];
  /** Elements whose text the script selected in place. */
  selectedAll: FakeElement[];
  timers: (() => void)[];
}

interface PageOptions {
  readonly storage?: "works" | "throws";
  readonly stored?: string;
  readonly systemDark?: boolean;
  /** How the clipboard behaves: it works, it is not there, or it refuses. */
  readonly clipboard?: "works" | "missing" | "rejects";
  /** What `execCommand("copy")` does: copies, reports it did not, or throws. */
  readonly execCopy?: "copies" | "refuses" | "throws";
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
    el("select", { id: "risk-filter" }),
    el("button", { class: "tool js-only", hidden: "", "data-risk": "LLM03" }),
    el("button", { class: "tool js-only", hidden: "", "data-risk": "nonsense" }),
    el("p", { id: "findings-status" }),
    el("p", { id: "findings-count" }),
    el("div", { id: "findings-empty", hidden: "" }),
    el("button", { id: "clear-filters" }),
    el("li", {
      class: "finding",
      "data-action": "block",
      "data-owasp": "ASI02 LLM03",
      "data-rank-serious": "0",
      "data-rank-name": "2",
      "data-rank-count": "1",
    }),
    el("li", {
      class: "finding",
      "data-action": "warn",
      "data-owasp": "ASI02",
      "data-rank-serious": "1",
      "data-rank-name": "0",
      "data-rank-count": "0",
    }),
    el("li", {
      class: "finding",
      "data-action": "require_approval",
      "data-rank-serious": "2",
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
      "aria-label": "Copy the init command",
    }),
    el("textarea", { id: "share-text" }),
    el("button", {
      class: "copy js-only",
      hidden: "",
      "data-copy": "share-text",
      "data-label": "Copy text",
    }),
    el("a", { id: "share-link", href: LINK }),
    el("span", { id: "share-count" }),
    el("p", { id: "page-status" }),
    el("textarea", { id: "copy-buffer" }),
    el("script", { id: "report-data" }),
  ];
  const byId = new Map<string, FakeElement>();
  for (const e of elements) {
    const id = e.getAttribute("id");
    if (id !== null) byId.set(id, e);
  }
  const count = byId.get("findings-count");
  if (count) count.textContent = "3 guardrails matched";
  const code = byId.get("cmd-init");
  if (code) code.textContent = "agenttrail-guard init --agent claude";
  const data = byId.get("report-data");
  if (data) data.textContent = JSON.stringify({ tool: "agenttrail-guard", n: 1 });
  const details = elements.filter((e) => e.tagName === "DETAILS");
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
    execCommands: [],
    selectedAll: [],
    timers: [],
  };

  const matches = (e: FakeElement, selector: string): boolean => {
    const classes = (e.getAttribute("class") ?? "").split(" ");
    if (selector === ".js-only") return classes.includes("js-only");
    if (selector === ".finding") return classes.includes("finding");
    if (selector === "[data-filter]") return e.getAttribute("data-filter") !== null;
    if (selector === "[data-copy]") return e.getAttribute("data-copy") !== null;
    if (selector === "[data-risk]") return e.getAttribute("data-risk") !== null;
    if (selector === "details") return e.tagName === "DETAILS";
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
    getSelection: () => ({
      selectAllChildren: (e: FakeElement) => void page.selectedAll.push(e),
    }),
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
    execCommand: (command: string) => {
      page.execCommands.push(command);
      if (options.execCopy === "throws") throw new Error("not allowed");
      return options.execCopy !== "refuses";
    },
  };
  const clipboard = {
    writeText: (text: string) => {
      if (options.clipboard === "rejects") return Promise.reject(new Error("not allowed"));
      page.copied.push(text);
      return Promise.resolve();
    },
  };
  const navigator = options.clipboard === "missing" ? {} : { clipboard };
  const setTimeout = (fn: () => void) => {
    page.timers.push(fn);
    return 0;
  };
  runInNewContext(REPORT_SCRIPT, { window, document, navigator, setTimeout });
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

  it("filters rows by OWASP risk, together with the action filter", () => {
    const page = loadPage();
    const risk = page.byId.get("risk-filter") as FakeElement;
    risk.value = "ASI02";
    risk.fire("change");
    expect(rows(page).map((r) => r.hidden)).toEqual([false, false, true]);
    expect(page.byId.get("findings-status")?.textContent).toBe("Showing 2 of 3 guardrails");
    filterButton(page, "warn").click();
    expect(rows(page).map((r) => r.hidden)).toEqual([true, false, true]);
    risk.value = "";
    risk.fire("change");
    expect(rows(page).map((r) => r.hidden)).toEqual([true, false, true]);
    filterButton(page, "all").click();
    expect(rows(page).map((r) => r.hidden)).toEqual([false, false, false]);
  });

  it("shows the filtered count where the total was, and puts the total back", () => {
    const page = loadPage();
    const count = page.byId.get("findings-count") as FakeElement;
    filterButton(page, "block").click();
    expect(count.textContent).toBe("Showing 1 of 3 guardrails");
    filterButton(page, "all").click();
    expect(count.textContent).toBe("3 guardrails matched");
  });

  it("shows a row with a way back when the filters leave nothing", () => {
    const page = loadPage();
    const risk = page.byId.get("risk-filter") as FakeElement;
    const empty = page.byId.get("findings-empty") as FakeElement;
    expect(empty.hidden).toBe(true);
    risk.value = "LLM03";
    risk.fire("change");
    filterButton(page, "warn").click();
    expect(rows(page).map((r) => r.hidden)).toEqual([true, true, true]);
    expect(empty.hidden).toBe(false);
    (page.byId.get("clear-filters") as FakeElement).click();
    expect(rows(page).map((r) => r.hidden)).toEqual([false, false, false]);
    expect(risk.value).toBe("");
    expect(filterButton(page, "all").getAttribute("aria-pressed")).toBe("true");
    expect(filterButton(page, "warn").getAttribute("aria-pressed")).toBe("false");
    expect(filterButton(page, "all").focused).toBe(true);
    expect(empty.hidden).toBe(true);
  });

  it("a risk's button shows all of that risk's findings, whatever action was chosen", () => {
    const page = loadPage();
    filterButton(page, "warn").click();
    page.elements.find((e) => e.getAttribute("data-risk") === "LLM03")?.click();
    expect(filterButton(page, "all").getAttribute("aria-pressed")).toBe("true");
    expect(filterButton(page, "warn").getAttribute("aria-pressed")).toBe("false");
    expect(rows(page).map((r) => r.hidden)).toEqual([false, true, true]);
  });

  it("treats a risk value it does not know as any risk", () => {
    const page = loadPage();
    const risk = page.byId.get("risk-filter") as FakeElement;
    risk.value = "toString";
    risk.fire("change");
    expect(rows(page).map((r) => r.hidden)).toEqual([false, false, false]);
  });

  it("a risk's button selects it in the filter, applies it, and moves focus there", () => {
    const page = loadPage();
    const risk = page.byId.get("risk-filter") as FakeElement;
    page.elements.find((e) => e.getAttribute("data-risk") === "LLM03")?.click();
    expect(risk.value).toBe("LLM03");
    expect(risk.focused).toBe(true);
    expect(rows(page).map((r) => r.hidden)).toEqual([false, true, true]);
  });

  it("ignores a risk button with a value it does not know", () => {
    const page = loadPage();
    const risk = page.byId.get("risk-filter") as FakeElement;
    page.elements.find((e) => e.getAttribute("data-risk") === "nonsense")?.click();
    expect(risk.value).toBe("");
    expect(risk.focused).toBe(false);
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
    const sort = page.byId.get("sort") as FakeElement;
    sort.value = "name";
    sort.fire("change");
    // The rows themselves never move in the page: the static allow-list above refuses any
    // statement that adds, moves or removes an element other than the export's link.
    expect(rows(page).map((r) => r.style.order)).toEqual(["2", "0", "1"]);
    expect(page.byId.get("findings-status")?.textContent).toContain("stays most serious first");
    sort.value = "count";
    sort.fire("change");
    expect(rows(page).map((r) => r.style.order)).toEqual(["1", "0", "0"]);
    // Back to most serious: the page's own order.
    sort.value = "serious";
    sort.fire("change");
    expect(rows(page).map((r) => r.style.order)).toEqual(["0", "1", "2"]);
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
    const toggle = page.byId.get("theme-toggle") as FakeElement;
    // The label says what pressing it does.
    expect(toggle.textContent).toBe("Switch to light theme");
    toggle.click();
    expect(page.root.getAttribute("data-theme")).toBe("light");
    expect(page.stored.get(THEME_KEY)).toBe("light");
    expect(toggle.textContent).toBe("Switch to dark theme");
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

  /** The copy button that names `target`. */
  const copyButton = (page: Page, target: string) =>
    page.elements.find((e) => e.getAttribute("data-copy") === target) as FakeElement;

  /** Let a settled clipboard promise run its handlers. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };

  it("copies a text area's value, not its text", async () => {
    const page = loadPage();
    const input = page.byId.get("share-text") as FakeElement;
    input.textContent = "the text the page was rendered with";
    input.value = "the text as edited";
    copyButton(page, "share-text").click();
    await settle();
    expect(page.copied).toEqual(["the text as edited"]);
  });

  it("says Copied, then puts its own label back", async () => {
    const page = loadPage();
    const button = copyButton(page, "share-text");
    button.click();
    await settle();
    expect(button.textContent).toBe("Copied");
    for (const fn of page.timers) fn();
    expect(button.textContent).toBe("Copy text");
  });

  it.each([
    "missing",
    "rejects",
  ] as const)("copies by hand through the hidden buffer when the clipboard %s", async (mode) => {
    const page = loadPage({ clipboard: mode });
    const button = copyButton(page, "cmd-init");
    button.click();
    await settle();
    const buffer = page.byId.get("copy-buffer") as FakeElement;
    expect(page.copied).toEqual([]);
    expect(buffer.value).toBe("agenttrail-guard init --agent claude");
    expect(buffer.selected).toBe(true);
    expect(page.execCommands).toEqual(["copy"]);
    expect(button.textContent).toBe("Copied");
    // Focus comes back from the hidden buffer to the button.
    expect(button.focused).toBe(true);
    for (const fn of page.timers) fn();
    expect(page.byId.get("page-status")?.textContent).toBe("Copied the init command");
  });

  it.each([
    "refuses",
    "throws",
  ] as const)("says how to copy by hand, with the text selected where it is shown, when copying %s", async (execCopy) => {
    const page = loadPage({ clipboard: "missing", execCopy });
    const button = copyButton(page, "cmd-init");
    button.click();
    await settle();
    expect(button.textContent).toBe("Press Ctrl+C or ⌘C");
    expect(button.focused).toBe(true);
    expect(page.selectedAll).toEqual([page.byId.get("cmd-init")]);
    for (const fn of page.timers) fn();
    expect(page.byId.get("page-status")?.textContent).toContain("press Ctrl+C");
    expect(button.textContent).toBe("Copy");
  });

  it("selects a text area's own text when copying by hand fails", async () => {
    const page = loadPage({ clipboard: "missing", execCopy: "refuses" });
    copyButton(page, "share-text").click();
    await settle();
    expect((page.byId.get("share-text") as FakeElement).selected).toBe(true);
    expect(page.selectedAll).toEqual([]);
  });

  it("announces a copy by the button's name", async () => {
    const page = loadPage();
    copyButton(page, "cmd-init").click();
    await settle();
    for (const fn of page.timers) fn();
    expect(page.byId.get("page-status")?.textContent).toBe("Copied the init command");
    // A second copy clears the region first, so the same message is announced again.
    page.timers.length = 0;
    copyButton(page, "cmd-init").click();
    await settle();
    expect(page.byId.get("page-status")?.textContent).toBe("");
    for (const fn of page.timers) fn();
    expect(page.byId.get("page-status")?.textContent).toBe("Copied the init command");
    expect(logic.copiedText("Copy text of the post")).toBe("Copied text of the post");
    expect(logic.copiedText(null)).toBe("Copied");
  });

  it("keeps the Post-on-X link an X post as the text is edited, and counts it", () => {
    const page = loadPage();
    const input = page.byId.get("share-text") as FakeElement;
    const link = page.byId.get("share-link") as FakeElement;
    for (const typed of ["javascript:alert(1)", '"><script>alert(1)</script>', "a\nb"]) {
      input.value = typed;
      input.fire("input");
      // Exactly the prefix, the typed text encoded, and the rendered suffix: nothing else.
      expect(link.href).toBe(SHARE_PREFIX + encodeURIComponent(typed) + SUFFIX);
      expect(new URL(link.href).searchParams.get("text")).toBe(typed);
    }
    input.value = "edited text \uD800";
    input.fire("input");
    expect(new URL(link.href).searchParams.get("text")).toBe("edited text \uFFFD");
    input.value = "x".repeat(300);
    input.fire("input");
    expect(page.byId.get("share-count")?.getAttribute("data-over")).toBe("true");
  });

  it("prints, opening every collapsed section and closing them again after", () => {
    const page = loadPage();
    (page.byId.get("print-button") as FakeElement).click();
    expect(page.printed).toBe(1);
    const details = page.elements.filter((e) => e.tagName === "DETAILS");
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
