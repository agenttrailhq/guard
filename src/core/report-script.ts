// cspell:words beforeprint afterprint
/**
 * The scan report's one inline script, as a constant.
 *
 * ── What it may do ───────────────────────────────────────────────────────────
 * Search over the findings, Expand all, opening a cut-off command, copy buttons, the theme
 * toggle, print and the JSON export, and keeping the Post-on-X link in step with the editable
 * share text. The filters, the OWASP risks, the sorts and the top-five limits need no script:
 * they are radio groups the stylesheet reads. The script marks `<html>` with `js`, which shows
 * its controls. Everything it shows is already in the
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

function wellFormed(text) {
  var out = "";
  Array.from(String(text)).forEach(function (ch) {
    var code = ch.codePointAt(0);
    out += code >= 0xd800 && code <= 0xdfff ? "\\ufffd" : ch;
  });
  return out;
}

function shareHref(text, suffix) {
  return SHARE_PREFIX + encodeURIComponent(wellFormed(text)) + suffix;
}

function readTheme(value) {
  return value === "light" || value === "dark" ? value : null;
}

function nextTheme(current, systemDark) {
  var effective = readTheme(current) || (systemDark ? "dark" : "light");
  return effective === "dark" ? "light" : "dark";
}

function copiedText(name) {
  var label = String(name || "");
  return label.indexOf("Copy ") === 0 ? "Copied " + label.slice(5) : "Copied";
}

function matchesQuery(text, query) {
  var q = String(query || "").trim().toLowerCase();
  if (q === "") return true;
  return String(text || "").toLowerCase().indexOf(q) !== -1;
}

function searchText(shown, total) {
  return "Showing " + shown + " of " + total + (total === 1 ? " guardrail" : " guardrails") + " that match the search";
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
page.classList.add("js");
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

function systemDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function showTheme(button) {
  var current = readTheme(page.getAttribute("data-theme")) || (systemDark() ? "dark" : "light");
  button.setAttribute("aria-pressed", current === "dark" ? "true" : "false");
}

var saved = storedTheme();
if (saved) page.setAttribute("data-theme", saved);

var themeButton = byId("theme");
if (themeButton) {
  showTheme(themeButton);
  themeButton.addEventListener("click", function () {
    var next = nextTheme(page.getAttribute("data-theme"), systemDark());
    page.setAttribute("data-theme", next);
    storeTheme(next);
    showTheme(themeButton);
  });
}

var pageStatus = byId("page-status");
var toast = byId("toast");
var toastTimer = 0;

function say(text) {
  if (toast) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.toggle("show", false);
    }, 1800);
  }
  if (!pageStatus) return;
  // Cleared first and written a moment later, so the same message is announced again.
  pageStatus.textContent = "";
  setTimeout(function () {
    pageStatus.textContent = text;
  }, 50);
}

function relabel(button, text, ms) {
  button.textContent = text;
  button.classList.add("copied");
  setTimeout(function () {
    button.textContent = button.getAttribute("data-label") || "Copy";
    button.classList.toggle("copied", false);
  }, ms);
}

function copied(button) {
  relabel(button, "Copied", 1500);
  say(copiedText(button.getAttribute("aria-label")));
}

function copyByHand(text, button, target) {
  var buffer = byId("copy-buffer");
  var done = false;
  if (buffer) {
    buffer.value = text;
    buffer.select();
    try {
      done = document.execCommand("copy") === true;
    } catch {
      done = false;
    }
  }
  // The buffer is hidden: focus goes back to the button either way.
  button.focus();
  if (done) {
    copied(button);
    return;
  }
  // Copying is blocked here. Select the text where it is shown, for the reader to copy.
  if (target.tagName === "TEXTAREA") target.select();
  else if (window.getSelection) window.getSelection().selectAllChildren(target);
  relabel(button, "Press Ctrl+C or \\u2318C", 4000);
  say("Copying is blocked here. The text is selected: press Ctrl+C, or Command+C on a Mac.");
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
          copyByHand(text, button, target);
        },
      );
    } else {
      copyByHand(text, button, target);
    }
  });
});

var printButton = byId("print");
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

var exportButton = byId("export");
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

var findings = byId("findings");
var search = byId("search");
var searchCount = byId("rc-search");
var emptyList = byId("flist-empty");

// The sorts, filters and limits are radio groups the stylesheet reads; a search hides what it
// does not match, and each group header with no row left.
if (findings && search) {
  search.addEventListener("input", function () {
    var query = search.value;
    var searching = query.trim() !== "";
    var shown = 0;
    var total = 0;
    var cats = [];
    each("#flist .frow", function (row) {
      var match = matchesQuery(row.textContent, query);
      row.classList.toggle("nomatch", !match);
      total++;
      if (match) {
        shown++;
        cats.push(row.getAttribute("data-cat"));
      }
    });
    each("#flist .fgroup", function (group) {
      group.classList.toggle("nomatch", searching && cats.indexOf(group.getAttribute("data-cat")) === -1);
    });
    findings.classList.toggle("searching", searching);
    if (searchCount) searchCount.textContent = searching ? searchText(shown, total) : "";
    if (emptyList) emptyList.classList.toggle("show", searching && shown === 0);
  });
}

var expandAll = byId("expand-all");
if (expandAll) {
  expandAll.addEventListener("click", function () {
    var open = expandAll.getAttribute("aria-expanded") !== "true";
    each("#flist .frow", function (row) {
      row.open = open;
    });
    expandAll.setAttribute("aria-expanded", open ? "true" : "false");
    expandAll.textContent = open ? "Collapse all" : "Expand all";
  });
}

// A command cut off at the edge of its box opens in full when chosen.
each(".cmd", function (cmd) {
  if (cmd.scrollWidth <= cmd.clientWidth) return;
  cmd.setAttribute("role", "button");
  cmd.setAttribute("tabindex", "0");
  cmd.setAttribute("aria-expanded", "false");
  function toggle() {
    var open = !cmd.classList.contains("expanded");
    cmd.classList.toggle("expanded", open);
    cmd.setAttribute("aria-expanded", open ? "true" : "false");
  }
  cmd.addEventListener("click", toggle);
  cmd.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });
});

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
