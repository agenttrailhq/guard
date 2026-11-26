export const FILE_PATH_RESOLVED_ATTR = "file_path_resolved";

const FILE_PATH = "file_path";

interface Rooted {
  readonly kind: "absolute" | "open";
  readonly prefix: string;
  readonly rest: string;
}

function isDriveLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function hasDriveRoot(s: string): boolean {
  return s.length >= 3 && isDriveLetter(s.charCodeAt(0)) && s[1] === ":" && s[2] === "/";
}

function hasDriveRelative(s: string): boolean {
  return s.length >= 2 && isDriveLetter(s.charCodeAt(0)) && s[1] === ":" && s[2] !== "/";
}

function separators(input: string): string {
  const s = input.replace(/\\/g, "/");
  if (s.startsWith("//?/") || s.startsWith("//./") || s.startsWith("/??/")) {
    const rest = s.slice(4);
    if (rest.slice(0, 4).toLowerCase() === "unc/") return `//${rest.slice(4)}`;
    return rest;
  }
  return s;
}

function rootOf(s: string, uncReading: boolean): Rooted {
  if (hasDriveRoot(s)) return { kind: "absolute", prefix: s.slice(0, 3), rest: s.slice(3) };
  if (hasDriveRelative(s)) return { kind: "open", prefix: s.slice(0, 2), rest: s.slice(2) };
  if (uncReading && s.startsWith("//") && s[2] !== "/") {
    const body = s.slice(2);
    const first = body.indexOf("/");
    const server = first === -1 ? body : body.slice(0, first);
    if (server !== "") {
      const afterServer = first === -1 ? "" : body.slice(first + 1);
      const second = afterServer.indexOf("/");
      const share = second === -1 ? afterServer : afterServer.slice(0, second);
      const rest = second === -1 ? "" : afterServer.slice(second + 1);
      if (share === "" || share === "." || share === "..") {
        return { kind: "absolute", prefix: `//${server}`, rest: afterServer };
      }
      return { kind: "absolute", prefix: `//${server}/${share}`, rest };
    }
  }
  if (s.startsWith("/")) return { kind: "absolute", prefix: "/", rest: s.slice(1) };
  if (s === "~" || s.startsWith("~/")) return { kind: "open", prefix: "~", rest: s.slice(2) };
  return { kind: "open", prefix: "", rest: s };
}

type ManyDots = "." | "..";

function windowsSegment(segment: string, manyDots: ManyDots): string {
  const colon = segment.indexOf(":");
  const name = colon === -1 ? segment : segment.slice(0, colon);
  let end = name.length;
  while (end > 0 && (name[end - 1] === "." || name[end - 1] === " ")) end -= 1;
  if (end > 0) return name.slice(0, end);
  let dots = 0;
  while (dots < name.length && name[dots] === ".") dots += 1;
  if (dots === 2) return "..";
  return dots > 2 ? manyDots : ".";
}

function resolveSegments(root: Rooted, windows: false | ManyDots): string {
  const stack: string[] = [];
  let start = 0;
  const rest = root.rest;
  for (let i = 0; i <= rest.length; i += 1) {
    if (i !== rest.length && rest[i] !== "/") continue;
    const raw = rest.slice(start, i);
    start = i + 1;
    const segment = windows !== false && raw !== "" ? windowsSegment(raw, windows) : raw;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const top = stack[stack.length - 1];
      if (top !== undefined && top !== "..") stack.pop();
      else if (root.kind === "open") stack.push("..");
      continue;
    }
    stack.push(segment);
  }
  const joined = stack.join("/");
  const { prefix } = root;
  if (prefix === "") return joined === "" ? "." : joined;
  if (prefix.endsWith("/")) return prefix + joined;
  if (prefix === "~" || prefix.startsWith("//"))
    return joined === "" ? prefix : `${prefix}/${joined}`;

  return prefix + joined;
}

export function lexicalPath(input: string): string {
  if (input === "") return input;
  return resolveSegments(rootOf(separators(input), true), false);
}

export function lexicalForms(input: string): string[] {
  if (input === "") return [];
  const s = separators(input);
  const roots: Rooted[] = [rootOf(s, true)];
  if (s.startsWith("//") && s[2] !== "/") roots.push(rootOf(s, false));
  if (hasDriveRelative(s)) {
    roots.push({ kind: "absolute", prefix: `${s.slice(0, 2)}/`, rest: s.slice(2) });
  }

  if (s[0] === "/" && hasDriveRoot(s.slice(1))) {
    roots.push({ kind: "absolute", prefix: s.slice(1, 4), rest: s.slice(4) });
  }

  const admin = adminShare(s);
  if (admin !== undefined) roots.push(admin);

  const out: string[] = [];
  for (const root of roots) out.push(resolveSegments(root, false));
  for (const root of roots) out.push(resolveSegments(root, ".."));
  for (const root of roots) out.push(resolveSegments(root, "."));
  return [...new Set(out)];
}

function adminShare(s: string): Rooted | undefined {
  if (!s.startsWith("//") || s[2] === "/") return undefined;
  const slash = s.indexOf("/", 2);
  if (slash === -1) return undefined;
  const share = s.slice(slash + 1, slash + 3);
  const after = s[slash + 3];
  if (share.length !== 2 || !isDriveLetter(share.charCodeAt(0)) || share[1] !== "$")
    return undefined;
  if (after !== undefined && after !== "/") return undefined;
  return { kind: "absolute", prefix: `${share[0]}:/`, rest: s.slice(slash + 4) };
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || hasDriveRoot(p);
}

const HOME_PREFIXES = [["$", "{HOME}"].join(""), "$HOME", "~"] as const;

export interface PathContext {
  readonly cwd?: string | undefined;

  readonly home?: string | undefined;
}

export function resolvePath(raw: string, context: PathContext): string | undefined {
  if (raw === "") return undefined;
  const s = separators(raw);
  const home = context.home !== undefined ? separators(context.home) : "";
  for (const prefix of HOME_PREFIXES) {
    if (s === prefix || s.startsWith(`${prefix}/`)) {
      if (!isAbsolute(home)) return undefined;
      return lexicalPath(`${home}/${s.slice(prefix.length)}`);
    }
  }
  if (isAbsolute(s) || s.startsWith("//") || hasDriveRelative(s)) return undefined;
  const cwd = context.cwd !== undefined ? separators(context.cwd) : "";
  if (!isAbsolute(cwd)) return undefined;
  return lexicalPath(`${cwd}/${s}`);
}

export function resolvedPathAttribute(
  raw: string,
  context: PathContext,
  cap: number,
): string | undefined {
  const resolved = resolvePath(raw, context);
  if (resolved === undefined || resolved.length > cap) return undefined;
  return resolved === lexicalPath(raw) ? undefined : resolved;
}

function isRelativeGlob(pattern: string): boolean {
  if (pattern.includes("\\")) return false;
  const segments = pattern.split("/");

  const first = segments[0] ?? "";
  if (first === "" || first === "." || first === "..") return false;
  for (let i = 0; i < first.length; i += 1) {
    const c = first.charCodeAt(i);
    const plain = (c >= 48 && c <= 57) || isDriveLetter(c) || c === 95 || c === 45 || c === 46;
    if (!plain) return false;
  }
  return !segments.some((segment) => segment === "." || segment === "..");
}

function isAbsoluteForm(form: string): boolean {
  return form.startsWith("/") || hasDriveRoot(form);
}

export function exemptionForms(forms: readonly string[], pattern: string): readonly string[] {
  if (!isRelativeGlob(pattern)) return forms;
  return forms.filter((form, index) => index === 0 || !isAbsoluteForm(form));
}

const FORMS_CACHE = new WeakMap<object, readonly string[]>();

export function pathForms(attributes: Readonly<Record<string, string>>): readonly string[] {
  const cached = FORMS_CACHE.get(attributes);
  if (cached !== undefined) return cached;
  const filePath = attributes[FILE_PATH];
  let forms: readonly string[] = [];
  if (filePath !== undefined) {
    const all = [filePath, ...lexicalForms(filePath)];
    const resolved = attributes[FILE_PATH_RESOLVED_ATTR];
    if (resolved !== undefined && resolved !== "") all.push(resolved, ...lexicalForms(resolved));
    forms = [...new Set(all)];
  }
  FORMS_CACHE.set(attributes, forms);
  return forms;
}
