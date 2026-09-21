// cspell:words Consolas focusable Menlo Neue nums optimizeLegibility SFMono
/**
 * The agenttrail brand palette, stylesheet and logo that the scan report inlines.
 *
 * Static assets only: every sentence the report writes stays in `report.ts`, where the
 * copy checks read it. Nothing here may reference anything outside the file — no web
 * font, no `url(…)`, no `xmlns`, no `href` — because `report.test.ts` asserts the whole
 * page references at most the URLs it names.
 *
 * ── One stylesheet, two hosts ────────────────────────────────────────────────
 * The same CSS serves the standalone file and the page-content variant published as a
 * Claude artifact. The light palette sits on a bare `:root`; the dark palette is applied
 * by `prefers-color-scheme` unless the host has stamped `data-theme="light"`, and again by
 * an explicit `data-theme="dark"`, so a viewer's own theme choice wins in both directions.
 * A standalone file never carries `data-theme`, so it follows the operating system.
 */

/** Light-theme colour tokens. Keys become `--<key>` custom properties. */
export const LIGHT_TOKENS = {
  bg: "#fafafa",
  fg: "#0a0a0a",
  "muted-fg": "#525252",
  card: "#ffffff",
  subtle: "#f5f5f5",
  "code-bg": "#f5f5f5",
  "code-border": "#e5e5e5",
  border: "#d4d4d4",
  divider: "#e5e5e5",
  brand: "#0748fe",
  "brand-hover": "#013de5",
  "brand-fg": "#ffffff",
  "brand-text": "#0748fe",
  mark: "#0748fe",
  "note-bg": "#f3f6ff",
  "note-border": "#baccff",
  shadow: "0 1px 2px rgba(10, 10, 10, 0.05)",
  "sev-critical-fg": "#b91c1c",
  "sev-critical-bg": "#fdecec",
  "sev-critical-bd": "#f9bebe",
  "sev-high-fg": "#c2410c",
  "sev-high-bg": "#fef1e8",
  "sev-high-bd": "#fdcead",
  "sev-medium-fg": "#b45309",
  "sev-medium-bg": "#fef5e7",
  "sev-medium-bd": "#fcddaa",
  "sev-low-fg": "#0369a1",
  "sev-low-bg": "#e7f6fd",
  "sev-low-bd": "#abe0f7",
  "sev-info-fg": "#3f3f46",
  "sev-info-bg": "#f1f1f2",
  "sev-info-bd": "#cdcdd0",
  "sev-unknown-fg": "#52525b",
  "sev-unknown-bg": "#f1f1f2",
  "sev-unknown-bd": "#cdcdd0",
  "act-block-fg": "#b91c1c",
  "act-block-bd": "#f8abab",
  "act-ask-fg": "#b45309",
  "act-ask-bd": "#fbd391",
  "act-warn-fg": "#52525b",
  "act-warn-bd": "#bfbfc3",
} as const;

/** Dark-theme colour tokens. Typed off the light set, so a missing key does not compile. */
export const DARK_TOKENS: { readonly [K in keyof typeof LIGHT_TOKENS]: string } = {
  bg: "#0b0f1e",
  fg: "#fafafa",
  "muted-fg": "#a3a3a3",
  card: "#111629",
  subtle: "#1a2137",
  "code-bg": "#1a2137",
  "code-border": "#2b344f",
  border: "#2b344f",
  divider: "#212a44",
  brand: "#0748fe",
  "brand-hover": "#2d63ff",
  "brand-fg": "#ffffff",
  "brand-text": "#6ea0ff",
  mark: "#ffffff",
  "note-bg": "#0f1f4f",
  "note-border": "#0d2d89",
  shadow: "none",
  "sev-critical-fg": "#f87171",
  "sev-critical-bg": "#351d2d",
  "sev-critical-bd": "#6a2834",
  "sev-high-fg": "#fb923c",
  "sev-high-bg": "#362526",
  "sev-high-bd": "#6e3b21",
  "sev-medium-fg": "#fbbf24",
  "sev-medium-bg": "#352c24",
  "sev-medium-bd": "#6c4c1d",
  "sev-low-fg": "#38bdf8",
  "sev-low-bg": "#112d48",
  "sev-low-bd": "#104f76",
  "sev-info-fg": "#d4d4d8",
  "sev-info-bg": "#202536",
  "sev-info-bd": "#373a49",
  "sev-unknown-fg": "#a1a1aa",
  "sev-unknown-bg": "#202536",
  "sev-unknown-bd": "#373a49",
  "act-block-fg": "#f87171",
  "act-block-bd": "#802d37",
  "act-ask-fg": "#fbbf24",
  "act-ask-bd": "#835a1a",
  "act-warn-fg": "#a1a1aa",
  "act-warn-bd": "#414452",
};

/** One custom property per line, so no line of the rendered file grows unbounded. */
function vars(tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens)
    .map(([key, value]) => `  --${key}: ${value};`)
    .join("\n");
}

const FONT_SANS = `"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const FONT_MONO = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace`;

const SEVERITIES = ["critical", "high", "medium", "low", "info", "unknown"] as const;
const ACTIONS = ["block", "ask", "warn"] as const;

const severityRules = SEVERITIES.map(
  (s) =>
    `.sev-${s} { color: var(--sev-${s}-fg); background: var(--sev-${s}-bg); border-color: var(--sev-${s}-bd); }`,
).join("\n");

const actionRules = ACTIONS.map(
  (a) => `.act-${a} { color: var(--act-${a}-fg); border-color: var(--act-${a}-bd); }`,
).join("\n");

/** The report's whole stylesheet. No `url(…)`, no `@import`, no `@font-face`. */
export const REPORT_STYLES = `
:root {
  --font-sans: ${FONT_SANS};
  --font-mono: ${FONT_MONO};
  color-scheme: light;
${vars(LIGHT_TOKENS)}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
  color-scheme: dark;
${vars(DARK_TOKENS)}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
${vars(DARK_TOKENS)}
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.page { max-width: 64rem; margin: 0 auto; padding: 32px clamp(16px, 4vw, 40px) 64px; }
p { margin: 0 0 12px; }
p, dd { max-width: 72ch; }
h1, h2 { color: var(--fg); font-weight: 650; letter-spacing: -0.02em; line-height: 1.25; }
h1 { font-size: 28px; margin: 6px 0 10px; letter-spacing: -0.025em; }
h2 { font-size: 18px; margin: 0 0 12px; }
section { margin-top: 44px; }
strong { font-weight: 600; color: var(--fg); }
code {
  font-family: var(--font-mono);
  font-size: 0.86em;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: 6px;
  padding: 0.05em 0.4em;
  overflow-wrap: anywhere;
}
.note { color: var(--muted-fg); font-size: 14px; }
.empty { color: var(--muted-fg); font-style: italic; }
.masthead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--divider);
}
.brand { display: inline-flex; line-height: 0; }
.lockup { display: block; height: 24px; width: auto; }
.lockup-mark, .mark { fill: var(--mark); }
.lockup-word { fill: var(--fg); }
.product-tag {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--brand-text);
  background: var(--note-bg);
  border: 1px solid var(--note-border);
  border-radius: 999px;
  padding: 1px 10px;
}
.intro { margin-top: 32px; }
.agent {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-fg);
}
.agent::before { content: ""; width: 8px; height: 8px; border-radius: 999px; background: var(--brand); }
.lead { font-size: 17px; margin-bottom: 8px; }
.provenance { color: var(--muted-fg); font-size: 13px; margin: 0; }
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 12px;
  margin-top: 28px;
}
.stat {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: var(--shadow);
}
.stat-value {
  font-size: 28px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
.stat-label { color: var(--muted-fg); font-size: 13px; margin-top: 4px; }
.stat-note { color: var(--muted-fg); font-size: 12px; margin-top: 6px; }
.tally {
  display: flex;
  flex-wrap: wrap;
  gap: 14px 40px;
  margin-top: 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
  box-shadow: var(--shadow);
}
.tally-group { display: flex; flex-direction: column; gap: 8px; }
.tally-label {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-fg);
}
.pills { display: flex; flex-wrap: wrap; gap: 8px 14px; list-style: none; margin: 0; padding: 0; }
.pills li { display: inline-flex; align-items: center; gap: 6px; }
.tally-count { font-weight: 650; font-variant-numeric: tabular-nums; }
.tally .note { flex-basis: 100%; margin: 0; font-size: 12px; }
.badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid;
  border-radius: 999px;
  padding: 0 9px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.05em;
  line-height: 1.8;
  text-transform: uppercase;
  white-space: nowrap;
}
${severityRules}
.sev-unknown { border-style: dashed; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.7;
  white-space: nowrap;
  background: var(--card);
}
.chip::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
${actionRules}
.callout {
  background: var(--subtle);
  border: 1px solid var(--border);
  border-left: 3px solid var(--sev-medium-fg);
  border-radius: 8px;
  padding: 18px 20px;
}
.callout h2 { font-size: 16px; margin-bottom: 8px; }
.legend {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 12px 0 14px;
  font-size: 14px;
}
.legend div { display: contents; }
.legend dt { margin: 0; }
.legend dd { margin: 0; color: var(--muted-fg); }
.warning { font-size: 14px; margin: 0; }
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 16px;
  margin-bottom: 12px;
}
.section-head h2 { margin: 0; }
.section-meta { margin: 0; color: var(--muted-fg); font-size: 13px; }
.table-wrap {
  position: relative;
  overflow-x: auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.table-wrap + p { margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 12px 14px; border-bottom: 1px solid var(--divider); }
tbody tr:last-child > * { border-bottom: 0; }
thead th {
  background: var(--subtle);
  color: var(--muted-fg);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
}
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.num { font-weight: 600; }
.kv th { color: var(--muted-fg); font-weight: 500; }
.guardrail-title { font-weight: 600; font-size: 15px; }
.guardrail-id { margin-top: 2px; font-size: 13px; }
.guardrail-id code { background: none; border: 0; padding: 0; color: var(--muted-fg); }
.shapes { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.shapes li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.times { color: var(--muted-fg); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.more { color: var(--muted-fg); font-size: 13px; font-style: italic; }
.findings td.sev, .findings td.act { white-space: nowrap; }
.recurring td.shape { width: 55%; }
.rule-name { color: var(--muted-fg); }
.list { margin: 8px 0 14px; padding-left: 20px; }
.list li { margin-bottom: 4px; }
.product-note {
  margin-top: 48px;
  background: var(--note-bg);
  border: 1px solid var(--note-border);
  border-radius: 12px;
  padding: 24px 26px;
}
.eyebrow {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--brand-text);
}
.product-note h2 { font-size: 22px; margin: 0 0 8px; }
.product-note-action { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin: 16px 0 0; }
.button {
  display: inline-flex;
  align-items: center;
  background: var(--brand);
  color: var(--brand-fg);
  font-weight: 600;
  font-size: 14px;
  text-decoration: none;
  border-radius: 6px;
  padding: 9px 16px;
}
.button:hover { background: var(--brand-hover); }
.button:focus-visible { outline: 2px solid var(--brand-text); outline-offset: 2px; }
.url { font-family: var(--font-mono); font-size: 13px; color: var(--brand-text); }
footer {
  margin-top: 48px;
  padding-top: 20px;
  border-top: 1px solid var(--divider);
  color: var(--muted-fg);
  font-size: 13px;
}
footer p { margin: 0 0 6px; max-width: none; }
.footer-brand { display: flex; align-items: center; gap: 8px; }
.mark { display: block; width: 16px; height: 16px; flex: none; }
@media (min-width: 48rem) {
  h1 { font-size: 36px; }
}
@media (max-width: 40rem) {
  .findings thead, .recurring thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .findings, .findings tbody, .findings td, .recurring, .recurring tbody, .recurring td { display: block; }
  .findings tr {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: center;
    gap: 10px;
    padding: 14px;
    border-bottom: 1px solid var(--divider);
  }
  .recurring tr {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 6px 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--divider);
  }
  .findings tbody tr:last-child, .recurring tbody tr:last-child { border-bottom: 0; }
  .findings td, .recurring td { padding: 0; border: 0; }
  .findings td.rule, .recurring td.shape { grid-column: 1 / -1; width: auto; }
  .findings td.num { justify-self: end; }
  .findings td.num::before { content: attr(data-label) " "; color: var(--muted-fg); font-weight: 400; font-size: 12px; }
  .recurring td.num { text-align: left; }
  .legend { grid-template-columns: 1fr; gap: 2px; }
  .legend dd { margin-bottom: 8px; }
}
@media print {
  body { background: #ffffff; }
  .stat, .tally, .table-wrap, .product-note, tr { break-inside: avoid; }
}
`;

const MARK_PATHS = `<path d="m49 68.207v-8.207c0-6.6289 5.3711-12 12-12s12 5.3711 12 12v9.2422l13 14.734v-31.977c0-19.883-16.117-36-36-36s-36 16.117-36 36v32.785z"/>
<path d="m18.672 87h64.66l-13.234-15h-19.758z"/>`;

/** The "agenttrail" wordmark as outlined glyphs, one subpath per line. */
const WORDMARK_PATH = `M5.28 0.22L5.28 0.22Q3.96 0.22 2.95-0.25Q1.94-0.72 1.37-1.56Q0.79-2.40 0.79-3.50L0.79-3.50Q0.79-5.23 2.11-6.23Q3.43-7.22 5.74-7.22L5.74-7.22Q7.54-7.22 9.07-6.53L9.07-6.53L9.07-7.82Q9.07-9.12 8.32-9.78Q7.56-10.44 6.10-10.44L6.10-10.44Q5.26-10.44 4.34-10.19Q3.43-9.94 2.30-9.38L2.30-9.38L1.42-11.21Q2.81-11.86 4.01-12.16Q5.21-12.46 6.43-12.46L6.43-12.46Q8.81-12.46 10.12-11.33Q11.42-10.20 11.42-8.11L11.42-8.11L11.42 0L9.07 0L9.07-1.06Q8.26-0.41 7.32-0.10Q6.38 0.22 5.28 0.22Z
M3.10-3.55L3.10-3.55Q3.10-2.66 3.85-2.12Q4.61-1.58 5.83-1.58L5.83-1.58Q6.79-1.58 7.60-1.86Q8.40-2.14 9.07-2.74L9.07-2.74L9.07-4.80Q8.38-5.21 7.62-5.39Q6.86-5.57 5.93-5.57L5.93-5.57Q4.63-5.57 3.86-5.02Q3.10-4.46 3.10-3.55Z
M19.76 5.14L19.76 5.14Q18.41 5.14 17.14 4.82Q15.87 4.51 14.84 3.94L14.84 3.94L15.77 2.04Q16.83 2.59 17.78 2.86Q18.72 3.12 19.68 3.12L19.68 3.12Q21.29 3.12 22.12 2.38Q22.95 1.63 22.95 0.19L22.95 0.19L22.95-1.20Q21.34 0.07 19.30 0.07L19.30 0.07Q17.60 0.07 16.19-0.76Q14.79-1.58 13.97-3.01Q13.16-4.44 13.16-6.19L13.16-6.19Q13.16-7.92 13.98-9.35Q14.81-10.78 16.22-11.60Q17.62-12.43 19.37-12.43L19.37-12.43Q20.36-12.43 21.28-12.11Q22.20-11.78 22.97-11.18L22.97-11.18L22.97-12.22L25.35-12.22L25.35 0.19Q25.35 2.57 23.91 3.85Q22.47 5.14 19.76 5.14Z
M19.59-1.99L19.59-1.99Q20.64-1.99 21.51-2.36Q22.37-2.74 22.95-3.43L22.95-3.43L22.95-8.90Q22.37-9.58 21.50-9.95Q20.62-10.32 19.59-10.32L19.59-10.32Q18.44-10.32 17.51-9.78Q16.59-9.24 16.06-8.29Q15.53-7.34 15.53-6.19L15.53-6.19Q15.53-4.99 16.07-4.04Q16.61-3.10 17.54-2.54Q18.46-1.99 19.59-1.99Z
M33.54 0.22L33.54 0.22Q31.74 0.22 30.28-0.62Q28.83-1.46 27.98-2.90Q27.13-4.34 27.13-6.12L27.13-6.12Q27.13-7.87 27.94-9.31Q28.76-10.75 30.15-11.59Q31.54-12.43 33.27-12.43L33.27-12.43Q34.95-12.43 36.28-11.58Q37.62-10.73 38.40-9.28Q39.18-7.82 39.18-6L39.18-6L39.18-5.33L29.55-5.33Q29.72-4.34 30.28-3.55Q30.85-2.76 31.72-2.30Q32.60-1.85 33.63-1.85L33.63-1.85Q34.54-1.85 35.35-2.12Q36.15-2.40 36.73-2.90L36.73-2.90L38.26-1.39Q37.21-0.58 36.06-0.18Q34.90 0.22 33.54 0.22Z
M29.55-7.15L29.55-7.15L36.78-7.15Q36.61-8.09 36.10-8.82Q35.60-9.55 34.84-9.97Q34.09-10.39 33.20-10.39L33.20-10.39Q32.29-10.39 31.52-9.98Q30.75-9.58 30.25-8.84Q29.74-8.11 29.55-7.15Z
M43.36 0L40.93 0L40.93-12.22L43.36-12.22L43.36-10.97Q44.77-12.46 47.03-12.46L47.03-12.46Q48.42-12.46 49.50-11.86Q50.58-11.26 51.18-10.18Q51.78-9.10 51.78-7.68L51.78-7.68L51.78 0L49.38 0L49.38-7.27Q49.38-8.71 48.56-9.54Q47.75-10.37 46.36-10.37L46.36-10.37Q45.37-10.37 44.62-9.96Q43.86-9.55 43.36-8.78L43.36-8.78L43.36 0Z
M59.30 0.22L59.30 0.22Q57.52 0.22 56.58-0.61Q55.65-1.44 55.65-3.02L55.65-3.02L55.65-10.20L53.06-10.20L53.06-12.22L55.65-12.22L55.65-15.34L58.05-15.91L58.05-12.22L61.65-12.22L61.65-10.20L58.05-10.20L58.05-3.58Q58.05-2.64 58.46-2.24Q58.86-1.85 59.85-1.85L59.85-1.85Q60.33-1.85 60.72-1.92Q61.12-1.99 61.60-2.16L61.60-2.16L61.60-0.12Q61.12 0.05 60.47 0.13Q59.82 0.22 59.30 0.22Z
M68.16 0.22L68.16 0.22Q66.38 0.22 65.44-0.61Q64.51-1.44 64.51-3.02L64.51-3.02L64.51-10.20L61.92-10.20L61.92-12.22L64.51-12.22L64.51-15.34L66.91-15.91L66.91-12.22L70.51-12.22L70.51-10.20L66.91-10.20L66.91-3.58Q66.91-2.64 67.32-2.24Q67.72-1.85 68.71-1.85L68.71-1.85Q69.19-1.85 69.58-1.92Q69.98-1.99 70.46-2.16L70.46-2.16L70.46-0.12Q69.98 0.05 69.33 0.13Q68.68 0.22 68.16 0.22Z
M74.21 0L71.78 0L71.78-12.22L74.21-12.22L74.21-10.66Q74.76-11.54 75.61-12.02Q76.46-12.50 77.54-12.50L77.54-12.50Q78.29-12.48 78.77-12.29L78.77-12.29L78.77-10.13Q78.46-10.27 78.08-10.33Q77.71-10.39 77.35-10.39L77.35-10.39Q76.30-10.39 75.49-9.82Q74.69-9.24 74.21-8.18L74.21-8.18L74.21 0Z
M84.08 0.22L84.08 0.22Q82.76 0.22 81.75-0.25Q80.74-0.72 80.16-1.56Q79.59-2.40 79.59-3.50L79.59-3.50Q79.59-5.23 80.91-6.23Q82.23-7.22 84.53-7.22L84.53-7.22Q86.33-7.22 87.87-6.53L87.87-6.53L87.87-7.82Q87.87-9.12 87.11-9.78Q86.36-10.44 84.89-10.44L84.89-10.44Q84.05-10.44 83.14-10.19Q82.23-9.94 81.10-9.38L81.10-9.38L80.21-11.21Q81.60-11.86 82.80-12.16Q84.00-12.46 85.23-12.46L85.23-12.46Q87.60-12.46 88.91-11.33Q90.22-10.20 90.22-8.11L90.22-8.11L90.22 0L87.87 0L87.87-1.06Q87.05-0.41 86.12-0.10Q85.18 0.22 84.08 0.22Z
M81.89-3.55L81.89-3.55Q81.89-2.66 82.65-2.12Q83.40-1.58 84.63-1.58L84.63-1.58Q85.59-1.58 86.39-1.86Q87.20-2.14 87.87-2.74L87.87-2.74L87.87-4.80Q87.17-5.21 86.42-5.39Q85.66-5.57 84.72-5.57L84.72-5.57Q83.43-5.57 82.66-5.02Q81.89-4.46 81.89-3.55Z
M94.93 0L92.50 0L92.50-12.22L94.93-12.22L94.93 0Z
M93.70-14.18L93.70-14.18Q93.10-14.18 92.67-14.63Q92.24-15.07 92.24-15.67L92.24-15.67Q92.24-16.30 92.67-16.73Q93.10-17.16 93.70-17.16L93.70-17.16Q94.33-17.16 94.76-16.73Q95.19-16.30 95.19-15.67L95.19-15.67Q95.19-15.07 94.76-14.63Q94.33-14.18 93.70-14.18Z
M99.68 0L97.26 0L97.26-16.80L99.68-17.26L99.68 0Z`;

/**
 * The full lockup: the mark and the wordmark, in the brand kit's own geometry.
 *
 * No `xmlns` (HTML parses inline SVG without it, and it would be a second URL in the
 * file), no `<title>` (an SVG title inside the page's first 8KB can be mistaken for the
 * page's), and no `href`. The accessible name comes from the wrapper in `report.ts`.
 */
export const LOGO_LOCKUP_SVG = `<svg class="lockup" viewBox="4.62 -20.772 137.06 25.912" width="127" height="24" aria-hidden="true" focusable="false">
<svg class="lockup-mark" x="0" y="-26.051" width="33" height="33" viewBox="0 0 100 100">
${MARK_PATHS}
</svg>
<path class="lockup-word" transform="translate(42 0)" d="${WORDMARK_PATH}"/>
</svg>`;

/** The mark alone, cropped to its own bounds, for the footer. */
export const LOGO_MARK_SVG = `<svg class="mark" viewBox="14 16 72 71" width="16" height="16" aria-hidden="true" focusable="false">
${MARK_PATHS}
</svg>`;
