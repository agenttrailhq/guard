// cspell:words beforeprint afterprint
/**
 * The scan report's one inline script, as a constant.
 *
 * ── What it may do ───────────────────────────────────────────────────────────
 * Filters, sort, copy buttons, the theme toggle, print and the JSON export, and keeping the
 * Post-on-X link in step with the editable share text. Everything it shows is already in the
 * page: it reads the `#report-data` block with `textContent` + `JSON.parse`, writes text with
 * `textContent` only, and never builds markup from data.
 *
 * ── What it must not do ──────────────────────────────────────────────────────
 * Make a request, navigate, open a window, or evaluate code. The standalone page pins this
 * script by hash in a `default-src 'none'` Content-Security-Policy, which stops requests;
 * navigation is not covered by a CSP, so `report-script.test.ts` scans this source for every
 * network, navigation and markup API and allows exactly two `href` writes, each behind a
 * fixed prefix: the X intent link and the `data:` URL of the JSON export.
 *
 * ── Two parts ─────────────────────────────────────────────────────────────────
 * `REPORT_SCRIPT_LOGIC` is pure functions over strings and numbers, so the tests run it in a
 * bare `node:vm` context. `REPORT_SCRIPT_GLUE` wires them to the page. The page gets both,
 * inside one function scope.
 */

/** The fixed start of every Post-on-X link. User text only ever follows it, encoded. */
export const SHARE_PREFIX = "https://x.com/intent/post?text=";

/** The fixed start of the JSON export's download link. A `data:` URL loads nothing. */
export const EXPORT_PREFIX = "data:application/json;charset=utf-8,";

/** Where the theme choice is remembered. Only `light` and `dark` are ever read back. */
export const THEME_KEY = "agenttrail-guard-report-theme";

/** How many characters X allows in a post. */
export const POST_LIMIT = 280;

/** Pure functions. No `document`, no `window`. */
export const REPORT_SCRIPT_LOGIC = `
var SHARE_PREFIX = ${JSON.stringify(SHARE_PREFIX)};
var EXPORT_PREFIX = ${JSON.stringify(EXPORT_PREFIX)};
var THEME_KEY = ${JSON.stringify(THEME_KEY)};
var POST_LIMIT = ${POST_LIMIT};
var URL_WEIGHT = 23;
var HASHTAG = "#agenttrail";
var FILTERS = ["all", "block", "require_approval", "warn"];
var SORTS = ["serious", "category", "count", "name"];

function charWeight(code) {
  if (code <= 0x10ff) return 1;
  if (code >= 0x2000 && code <= 0x200d) return 1;
  if (code >= 0x2010 && code <= 0x201f) return 1;
  if (code >= 0x2032 && code <= 0x2037) return 1;
  return 2;
}

function xLength(text) {
  var n = 0;
  Array.from(String(text)).forEach(function (ch) {
    n += charWeight(ch.codePointAt(0));
  });
  return n;
}

function postLength(text) {
  return xLength(text) + 1 + URL_WEIGHT + 1 + HASHTAG.length;
}

function shareSuffix(href) {
  if (typeof href !== "string" || href.indexOf(SHARE_PREFIX) !== 0) return null;
  var at = href.indexOf("&url=");
  return at === -1 ? null : href.slice(at);
}

function shareHref(text, suffix) {
  return SHARE_PREFIX + encodeURIComponent(String(text)) + suffix;
}

function readTheme(value) {
  return value === "light" || value === "dark" ? value : null;
}

function nextTheme(current, systemDark) {
  var effective = readTheme(current) || (systemDark ? "dark" : "light");
  return effective === "dark" ? "light" : "dark";
}

function isFilter(value) {
  return FILTERS.indexOf(value) !== -1;
}

function rowVisible(filter, action) {
  return filter === "all" || filter === action;
}

function isSort(value) {
  return SORTS.indexOf(value) !== -1;
}

function rankOf(value) {
  var n = parseInt(value, 10);
  return isFinite(n) && n >= 0 ? n : 0;
}

function statusText(shown, total) {
  return "Showing " + shown + " of " + total + (total === 1 ? " guardrail" : " guardrails");
}

function sortLabel(key) {
  if (key === "serious") return "most serious";
  if (key === "count") return "most matches";
  return key;
}

function sortText(key) {
  return "Sorted by " + sortLabel(key) + ". Keyboard and screen-reader order stays most serious first.";
}

function exportHref(raw) {
  return EXPORT_PREFIX + encodeURIComponent(JSON.stringify(JSON.parse(raw), null, 2) + "\\n");
}
`;

/** Wires the pure functions to the page. Runs once, on load. */
export const REPORT_SCRIPT_GLUE = `
function byId(id) {
  return document.getElementById(id);
}

function each(selector, fn) {
  Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
}

var page = document.documentElement;
var store = null;
try {
  store = window.localStorage;
} catch {
  store = null;
}

function storedTheme() {
  try {
    return store ? readTheme(store.getItem(THEME_KEY)) : null;
  } catch {
    return null;
  }
}

function storeTheme(value) {
  try {
    if (store) store.setItem(THEME_KEY, value);
  } catch {
    // Storage is blocked: the choice lasts for this page only.
  }
}

function themeLabel(button) {
  var current = readTheme(page.getAttribute("data-theme"));
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  button.textContent = nextTheme(current, dark) === "dark" ? "Dark theme" : "Light theme";
}

var saved = storedTheme();
if (saved) page.setAttribute("data-theme", saved);

each(".js-only", function (el) {
  el.hidden = false;
});

var themeButton = byId("theme-toggle");
if (themeButton) {
  themeLabel(themeButton);
  themeButton.addEventListener("click", function () {
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = nextTheme(page.getAttribute("data-theme"), dark);
    page.setAttribute("data-theme", next);
    storeTheme(next);
    themeLabel(themeButton);
  });
}

var status = byId("findings-status");

each("[data-filter]", function (button) {
  button.addEventListener("click", function () {
    var filter = button.getAttribute("data-filter");
    if (!isFilter(filter)) return;
    each("[data-filter]", function (other) {
      other.setAttribute("aria-pressed", other === button ? "true" : "false");
    });
    var shown = 0;
    var total = 0;
    each(".finding", function (row) {
      var visible = rowVisible(filter, row.getAttribute("data-action"));
      row.hidden = !visible;
      total++;
      if (visible) shown++;
    });
    if (status) status.textContent = statusText(shown, total);
  });
});

var sortSelect = byId("sort");
if (sortSelect) {
  sortSelect.addEventListener("change", function () {
    var key = sortSelect.value;
    if (!isSort(key)) return;
    each(".finding", function (row) {
      row.style.order = String(rankOf(row.getAttribute("data-rank-" + key)));
    });
    if (status) status.textContent = sortText(key);
  });
}

function copied(button) {
  button.textContent = "Copied";
  setTimeout(function () {
    button.textContent = button.getAttribute("data-label") || "Copy";
  }, 1500);
}

function copyByHand(text, button) {
  var buffer = byId("copy-buffer");
  if (!buffer) return;
  buffer.value = text;
  buffer.select();
  try {
    document.execCommand("copy");
    copied(button);
  } catch {
    // Copying is blocked here; the text stays selected for the reader to copy.
  }
}

each("[data-copy]", function (button) {
  button.addEventListener("click", function () {
    var target = byId(button.getAttribute("data-copy"));
    if (!target) return;
    var text = target.tagName === "TEXTAREA" ? target.value : target.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          copied(button);
        },
        function () {
          copyByHand(text, button);
        },
      );
    } else {
      copyByHand(text, button);
    }
  });
});

var printButton = byId("print-button");
if (printButton) {
  printButton.addEventListener("click", function () {
    window.print();
  });
}

var openedForPrint = [];
window.addEventListener("beforeprint", function () {
  each("details", function (d) {
    if (!d.open) {
      d.open = true;
      openedForPrint.push(d);
    }
  });
});
window.addEventListener("afterprint", function () {
  openedForPrint.forEach(function (d) {
    d.open = false;
  });
  openedForPrint = [];
});

var exportButton = byId("export-button");
var data = byId("report-data");
if (exportButton && data) {
  exportButton.addEventListener("click", function () {
    var a = document.createElement("a");
    a.href = exportHref(data.textContent);
    a.download = "agenttrail-guard-report.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
}

var shareInput = byId("share-text");
var shareLink = byId("share-link");
var shareCount = byId("share-count");
var suffix = shareLink ? shareSuffix(shareLink.getAttribute("href")) : null;
if (shareInput && shareLink && suffix !== null) {
  shareInput.addEventListener("input", function () {
    shareLink.href = shareHref(shareInput.value, suffix);
    var length = postLength(shareInput.value);
    if (shareCount) {
      shareCount.textContent = length + " / " + POST_LIMIT;
      shareCount.setAttribute("data-over", length > POST_LIMIT ? "true" : "false");
    }
  });
}
`;

/**
 * The script as written into the page, between `<script>` and `</script>`, exactly.
 *
 * The Content-Security-Policy hash is computed over this string, so it starts and ends with
 * the line breaks the page carries.
 */
export const REPORT_SCRIPT = `
(function () {
"use strict";
${REPORT_SCRIPT_LOGIC.trim()}
${REPORT_SCRIPT_GLUE.trim()}
})();
`;
