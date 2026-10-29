// cspell:words hrefs
/** Reading text back out of the report's HTML, for tests. */

/** Decode the five escapes the report writes, and numeric character references. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * The page with each command's word and placeholder spans taken out, so a command reads as one
 * run of text again, as it does on screen and when copied.
 */
export function joinCommandWords(html: string): string {
  return html
    .replace(/<span class="ph">([^<]*)<\/span>/g, "$1")
    .replace(/<span class="tok">([^<]*)<\/span>/g, "$1");
}

/** The note under the cards of "What actually happened", where the fixes file is named. */
export function whatHappenedNote(html: string): string {
  const at = html.indexOf('<section id="what-happened"');
  if (at === -1) return "";
  const section = html.slice(at, html.indexOf("</section>", at));
  // The note under the cards, with the closed expander that follows it.
  const note = section.match(/<p class="vnote">[\s\S]*?<\/p>/)?.[0] ?? "";
  const more =
    section.match(/<details class="more-info" id="checks-notes">[\s\S]*?<\/details>/)?.[0] ?? "";
  return `${note}${more}`;
}

/**
 * Every form a string can take in the file, decoded: the page's text, every `href` with its
 * percent-encoding undone, and the data block parsed back from its JSON escapes.
 */
export function decodedSurfaces(html: string): Record<string, string> {
  const block = html.match(
    /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/,
  );
  const hrefs = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => decodeEntities(m[1] ?? ""));
  const params = hrefs.flatMap((href) => {
    try {
      return [...new URL(href, "https://local.invalid").searchParams.values()];
    } catch {
      return [];
    }
  });
  return {
    text: decodeEntities(joinCommandWords(html)),
    hrefs: hrefs.map((h) => decodeURIComponent(h)).join("\n"),
    params: params.join("\n"),
    data: block === null ? "" : stringLeaves(JSON.parse(block[1] ?? "null")).join("\n"),
  };
}

/** Every string in a parsed value, keys included, exactly as decoded. */
export function stringLeaves(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(stringLeaves);
  if (node !== null && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => [k, ...stringLeaves(v)]);
  }
  return [];
}
