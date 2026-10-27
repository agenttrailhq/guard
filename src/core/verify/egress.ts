// cspell:words gsutil rclone ncat netcat cloudflared frpc frps zrok devtunnel tmole loclx inlets rathole gost socat copyto moveto awslocal urlencode pgrep preproxy Aebcmwx SENDTO DCCP
/**
 * The egress check, for the "Data leaving the machine" card: uploads and tunnels from commands
 * that RAN, told apart from traffic that never left the machine, plus tunnel and relay
 * programs running now.
 *
 * ── What counts ──────────────────────────────────────────────────────────────
 *  - **Uploads:** `curl` sending a file (`-T`, `-F …@file`, `--data… @file`), `wget
 *    --post-file`, `scp` and `rsync` to a remote destination, copies into cloud storage
 *    (`aws s3`, `gsutil`, `gcloud storage`, `az storage blob`, `rclone`), `gh gist create`
 *    and `gh release upload`, `nc` and `socat` sending to a host, and `ssh` fed a file or a
 *    pipe on its standard input.
 *  - **Tunnels started:** `ngrok`, `cloudflared tunnel`, `ssh -R` and the other programs that
 *    expose a local port to the internet.
 *  - The guardrails that match uploads, paste services, reverse shells and tunnels count too,
 *    where the reading above does not recognize the shape.
 *
 * ── What is set aside ────────────────────────────────────────────────────────
 *  - A target on this machine: `localhost`, a loopback address, `host.docker.internal`. A
 *    health check or a test server is not data leaving the machine.
 *  - LocalStack: an AWS call with an `--endpoint-url` on this machine, or `awslocal`.
 *  - Text in tests, a search, a message or a printed string: those calls did not run
 *    (`ran.ts`), and are counted as mentioned.
 *
 * ── Running now ──────────────────────────────────────────────────────────────
 * What `VerifyIO.processNames` reports running (names only, never arguments) is compared with
 * `TUNNEL_PROCESS_NAMES` by file name (`tunnelProgramOf`), and counted as programs, each once.
 * An `ssh -R` or a script-run tunnel shows as `ssh` or an interpreter, and is not counted here.
 *
 * What leaves this module is counts and fixed enums. Hosts and paths are never kept.
 */

import type { CompiledAllowlist } from "../evaluate.js";
import type { CompiledRule } from "../rules.js";
import {
  backstopCalls,
  type CorpusCalls,
  executedText,
  hidingFacts,
  isShell,
  programAndArgs,
  quietStatus,
  rulesMatcher,
  runStateOf,
  type SimpleCommand,
  simpleCommands,
} from "./calls.js";
import {
  couldHideTemplate,
  counted,
  type FullCard,
  moreMatches,
  restsOnCodex,
} from "./card-parts.js";
import {
  type CardContext,
  type ChipReason,
  chipFor,
  type LocalFix,
  localFixCommand,
  type SentenceTemplate,
  sentences,
  type ToCard,
  type UnsafeFix,
} from "./cards.js";
import { PROCESS_CHECKS, TUNNEL_PROCESS_NAMES, UPLOAD_KINDS } from "./command-facts.js";
import { bareHost, endpointsLocal, hostOf, isLocalHost } from "./hosts.js";
import { READ_PROGRAMS } from "./ran.js";
import type { CheckedCategory, HidingForm, VerifyIO, VerifyStatus } from "./types.js";

export { PROCESS_CHECKS, TUNNEL_PROCESS_NAMES, UPLOAD_KINDS };

/** One of `UPLOAD_KINDS`. */
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** One of `TUNNEL_PROCESS_NAMES`. */
export type TunnelProgram = (typeof TUNNEL_PROCESS_NAMES)[number];

/** One of `PROCESS_CHECKS`. */
export type ProcessCheck = (typeof PROCESS_CHECKS)[number];

/** What the egress check found. Every count of calls is of calls that ran. */
export interface EgressFacts {
  /** Uploads to a host that is not this machine. */
  readonly uploads: number;
  /** What kinds they were, in `UPLOAD_KINDS` order. */
  readonly uploadKinds: readonly UploadKind[];
  /** Tunnels started to expose this machine. */
  readonly tunnelsStarted: number;
  /** Upload- or tunnel-shaped calls to this machine or LocalStack, set aside. */
  readonly localOnly: number;
  /** Tunnel and relay programs running now: programs, not processes. */
  readonly tunnelsRunning: number;
  /** Which programs, in `TUNNEL_PROCESS_NAMES` order. */
  readonly tunnelPrograms: readonly TunnelProgram[];
  readonly processCheck: ProcessCheck;
  /** Matches that only mentioned one of these, and did not run. */
  readonly mentioned: number;
  /** Matches that could not be confirmed as run. */
  readonly unconfirmed: number;
  /** Calls that ran, or may have run, and could have run other commands this check does not read. */
  readonly couldHide: number;
  /** The hiding forms those calls hold, in `HIDING_FORMS` order. */
  readonly hidingForms: readonly HidingForm[];
}

declare module "./types.js" {
  interface CategoryFactsMap {
    egress: EgressFacts;
  }
}

/** The egress category's result. */
export type EgressCheck = CheckedCategory<EgressFacts>;

/** What one simple command sends, by this module's reading. */
type Traffic =
  | { readonly kind: "upload"; readonly upload: UploadKind; readonly local: boolean }
  | { readonly kind: "tunnel"; readonly local: boolean };

/** `curl` options that take the next word. */
const CURL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-binary",
  "--data-raw",
  "--data-ascii",
  "--data-urlencode",
  "--json",
  "-X",
  "--request",
  "-o",
  "--output",
  "-u",
  "--user",
  "-F",
  "--form",
  "-T",
  "--upload-file",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-b",
  "--cookie",
  "-c",
  "--cookie-jar",
  "-m",
  "--max-time",
  "--connect-timeout",
  "-w",
  "--write-out",
  "-x",
  "--proxy",
  "--url",
  "--resolve",
  "--cacert",
  "--cert",
  "--key",
  "-K",
  "--config",
  "--retry",
]);

/** Is `host` a real host name, not a Windows drive letter? */
function realHost(host: string | undefined): host is string {
  return host !== undefined && host.length > 1;
}

/** The host a target names: a URL, `user@host:path`, or a bare `host[:port]`. */
function targetHost(target: string): string | undefined {
  return hostOf(target) ?? bareHost(target);
}

/**
 * curl options that send the request somewhere other than the URL's host — a proxy, a name
 * resolved to another address, a connection redirected — or that read a config file, which may
 * set any of those or another URL (`-K`, `--config`). With any of them, a localhost URL is not
 * traffic known to stay on this machine.
 */
const CURL_ROUTING: ReadonlySet<string> = new Set([
  "-x",
  "--proxy",
  "--preproxy",
  "--socks4",
  "--socks4a",
  "--socks5",
  "--socks5-hostname",
  "--resolve",
  "--connect-to",
  "--proxy1.0",
  "-K",
  "--config",
]);

/** curl short options that take a value: the rest of their word, or else the next word. */
const CURL_SHORT_VALUES = "HdXouFTAebcmwxKErQYyzCDtPU";

/** One curl option as given, with its value when it takes one. */
interface CurlOption {
  readonly name: string;
  readonly value: string;
}

/**
 * curl's words read as options and operands. Short options may be clustered (`-sT file`), and
 * the first one in a cluster that takes a value takes the rest of the word as it, when there
 * is a rest (`-sxhttp://proxy`), or else the next word. A long option takes the next word when
 * it is one that takes a value; `--name=value` is read as the option with its value too.
 */
function curlWords(args: readonly string[]): { options: CurlOption[]; operands: string[] } {
  const options: CurlOption[] = [];
  const operands: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string;
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      if (eq > 0) options.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      else if (CURL_VALUE_OPTIONS.has(arg) || CURL_ROUTING.has(arg)) {
        options.push({ name: arg, value: args[k + 1] ?? "" });
        k += 1;
      } else options.push({ name: arg, value: "" });
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (let i = 1; i < arg.length; i++) {
        const letter = arg[i] as string;
        if (!CURL_SHORT_VALUES.includes(letter)) {
          options.push({ name: `-${letter}`, value: "" });
          continue;
        }
        const attached = arg.slice(i + 1);
        if (attached !== "") options.push({ name: `-${letter}`, value: attached });
        else {
          options.push({ name: `-${letter}`, value: args[k + 1] ?? "" });
          k += 1;
        }
        break;
      }
    } else operands.push(arg);
  }
  return { options, operands };
}

/** curl options whose value is data to send, which names a file when it starts with `@`. */
const CURL_DATA = /^(?:-d|--data(?:-binary|-raw|-ascii|-urlencode)?|--json)$/;

/**
 * `curl`: a file sent, and where to. Every URL counts, since curl sends to each one, and the
 * upload is local only when every one is on this machine and nothing routes it elsewhere.
 */
function readCurl(args: readonly string[], routedByEnvironment: boolean): Traffic | undefined {
  const { options, operands } = curlWords(args);
  let sendsFile = false;
  let routed = routedByEnvironment;
  const hosts: (string | undefined)[] = operands.map(targetHost);
  for (const { name, value } of options) {
    if (CURL_ROUTING.has(name)) routed = true;
    if (name === "--url") hosts.push(targetHost(value));
    if (name === "-T" || name === "--upload-file") sendsFile = true;
    // `-F f=@file` sends a file, and `-F f=<file` its content.
    if ((name === "-F" || name === "--form") && /[@<]/.test(value)) sendsFile = true;
    if (CURL_DATA.test(name) && value.startsWith("@")) sendsFile = true;
  }
  if (!sendsFile) return undefined;
  const local =
    !routed && hosts.length > 0 && hosts.every((host) => realHost(host) && isLocalHost(host));
  return { kind: "upload", upload: "http-upload", local };
}

/** The operands of a copy command: the words that are not options. */
function copyOperands(args: readonly string[], valueOptions: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string;
    if (valueOptions.has(arg)) {
      k += 1;
      continue;
    }
    if (!arg.startsWith("-")) out.push(arg);
  }
  return out;
}

/** An ssh option or `-e`/`--rsh` value that sends the connection through another host. */
const SSH_ROUTING = /(?:^|\s)-J\b|ProxyJump|ProxyCommand/i;

/** Do the arguments of `ssh`, `scp` or `rsync` route the connection through another host? */
function sshRouted(args: readonly string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string;
    if (arg === "-J" || /^-J./.test(arg)) return true;
    if (/^-o/.test(arg) && SSH_ROUTING.test(arg === "-o" ? (args[k + 1] ?? "") : arg)) return true;
    if ((arg === "-e" || arg === "--rsh") && SSH_ROUTING.test(args[k + 1] ?? "")) return true;
    if (arg.startsWith("--rsh=") && SSH_ROUTING.test(arg)) return true;
  }
  return false;
}

/**
 * `scp` and `rsync`: a copy whose destination is on another host. Local only when the
 * destination is this machine and the connection goes nowhere else on the way.
 */
function readRemoteCopy(
  args: readonly string[],
  routedByEnvironment: boolean,
): Traffic | undefined {
  const operands = copyOperands(
    args,
    new Set(["-P", "-i", "-o", "-F", "-J", "-e", "-l", "--rsh", "--port"]),
  );
  const destination = operands[operands.length - 1];
  if (operands.length < 2 || destination === undefined) return undefined;
  // `user@host:path`, `host::module` and `rsync://host/…` all name the host the same way.
  const host = hostOf(destination);
  if (!realHost(host)) return undefined;
  const routed = routedByEnvironment || sshRouted(args);
  return { kind: "upload", upload: "file-copy", local: !routed && isLocalHost(host) };
}

/** A copy into cloud storage: the destination is a bucket and the source is not. */
function readStorageCopy(
  operands: readonly string[],
  bucket: RegExp,
  local: boolean,
): Traffic | undefined {
  const destination = operands[operands.length - 1] ?? "";
  if (operands.length < 2 || !bucket.test(destination)) return undefined;
  if (operands.slice(0, -1).every((source) => bucket.test(source))) return undefined;
  return { kind: "upload", upload: "cloud-storage", local };
}

/** `aws s3 cp|mv|sync` into a bucket. */
function readAwsS3(
  args: readonly string[],
  awslocal: boolean,
  routedByEnvironment: boolean,
): Traffic | undefined {
  // Every endpoint named must be this machine; with none, `awslocal` is.
  const local = !routedByEnvironment && (endpointsLocal(args) ?? awslocal);
  const words = copyOperands(
    args,
    new Set([
      "--profile",
      "--region",
      "--endpoint-url",
      "--acl",
      "--exclude",
      "--include",
      "--storage-class",
      "--output",
      "--query",
    ]),
  );
  if (words[0] !== "s3" || !["cp", "mv", "sync"].includes(words[1] ?? "")) return undefined;
  return readStorageCopy(words.slice(2), /^s3:\/\//, local);
}

/** `nc host port`, unless it listens or only scans. A proxy (`-x`, `-X`) is not local. */
function readNetcat(args: readonly string[], routedByEnvironment: boolean): Traffic | undefined {
  if (args.some((a) => /^-[A-Za-z]*[lz]/.test(a))) return undefined;
  const operands = copyOperands(
    args,
    new Set(["-w", "-p", "-s", "-i", "-q", "-x", "-X", "-e", "-c"]),
  );
  const host = operands[0];
  if (!realHost(host) || operands.length < 2) return undefined;
  const routed = routedByEnvironment || args.some((a) => /^-[xX]/.test(a));
  return { kind: "upload", upload: "raw-socket", local: !routed && isLocalHost(host) };
}

/** `ssh` options that take the next word as their value. */
const SSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-p",
  "-i",
  "-l",
  "-o",
  "-F",
  "-J",
  "-L",
  "-R",
  "-D",
  "-b",
  "-c",
  "-E",
  "-e",
  "-m",
  "-O",
  "-Q",
  "-S",
  "-W",
  "-w",
  "-B",
]);

/** The host an `ssh` command connects to: its first operand, past any `user@`. */
function sshHost(args: readonly string[]): string | undefined {
  const destination = copyOperands(args, SSH_VALUE_OPTIONS)[0] ?? "";
  return destination.includes("@") ? destination.split("@").pop() : destination;
}

/**
 * `ssh`: a remote port forwarded to this machine (`-R`) is a tunnel. Without one, an `ssh` whose
 * standard input is a file (`ssh host 'cat > x' < dump.sql`) or a pipe (`cat dump.sql | ssh
 * host …`) sends that data to the host: a file copy.
 */
function readSsh(simple: SimpleCommand, args: readonly string[]): Traffic | undefined {
  const routed = sshRouted(args);
  const host = sshHost(args);
  const local = !routed && realHost(host) && isLocalHost(host);
  if (args.some((a) => /^-[A-Za-z]*R/.test(a))) return { kind: "tunnel", local };
  if ((simple.readsFile || simple.pipedIn) && realHost(host)) {
    return { kind: "upload", upload: "file-copy", local };
  }
  return undefined;
}

/**
 * A `socat` address that connects out to a host, by type: the fields after the type are the
 * host and the port. `SOCKS…` and `PROXY…` name a proxy first, so they always leave the
 * machine.
 */
const SOCAT_CONNECT =
  /^(?:(TCP[46]?(?:-CONNECT)?|OPENSSL(?:-CONNECT)?|SSL|UDP[46]?(?:-SENDTO|-CONNECT)?|SCTP[46]?-CONNECT|DCCP-CONNECT)|(SOCKS4A?|SOCKS5|PROXY(?:-CONNECT)?)):/i;

/**
 * `socat` with an address that connects out to a host (`TCP:host:9000`, `OPENSSL:host:443`,
 * `UDP:host:53`, through a SOCKS or HTTP proxy): data sent over a raw socket. Local only when
 * every such address is this machine and none goes through a proxy. A `socat` that only
 * listens is not read here.
 */
function readSocat(args: readonly string[]): Traffic | undefined {
  let connects = false;
  let local = true;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const type = SOCAT_CONNECT.exec(arg);
    if (type === null) continue;
    connects = true;
    if (type[2] !== undefined) {
      local = false;
      continue;
    }
    const rest = arg.slice(type[0].length);
    const host = rest.startsWith("[") ? rest.slice(0, rest.indexOf("]") + 1) : rest.split(":")[0];
    if (!realHost(host) || !isLocalHost(host)) local = false;
  }
  return connects ? { kind: "upload", upload: "raw-socket", local } : undefined;
}

/** Programs that start a tunnel, and the first word that makes them do so (any, when empty). */
const TUNNEL_STARTERS: ReadonlyMap<string, readonly string[]> = new Map([
  ["ngrok", ["http", "tcp", "tls", "start", "tunnel"]],
  ["cloudflared", ["tunnel"]],
  ["lt", []],
  ["localtunnel", []],
  ["bore", ["local"]],
  ["frpc", []],
  ["chisel", ["client"]],
  ["zrok", ["share"]],
  ["devtunnel", ["host"]],
  ["tmole", []],
  ["loclx", ["tunnel"]],
  ["inlets", ["client"]],
]);

/** A variable that sends a program's traffic through a proxy. */
const PROXY_VARIABLE = /^(?:https?|all|ftp|socks|rsync)_proxy=/i;

/** wget options that take the next word as their value. */
const WGET_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-O",
  "-o",
  "-a",
  "-e",
  "-P",
  "-U",
  "--post-file",
  "--body-file",
  "--post-data",
  "--body-data",
  "--header",
  "--method",
  "--user",
  "--password",
  "--output-document",
]);

/**
 * `wget --post-file`: a file sent. Local only when every URL is this machine and no proxy is
 * set (`-e use_proxy=…`, `-e https_proxy=…`).
 */
function readWget(args: readonly string[], routedByEnvironment: boolean): Traffic | undefined {
  if (!args.some((a) => /^--(?:post|body)-file\b/.test(a))) return undefined;
  const routed =
    routedByEnvironment ||
    args.some((a, k) => (a === "-e" ? /proxy/i.test(args[k + 1] ?? "") : /^-e.*proxy/i.test(a)));
  const hosts = copyOperands(args, WGET_VALUE_OPTIONS).map(targetHost);
  const local =
    !routed && hosts.length > 0 && hosts.every((host) => realHost(host) && isLocalHost(host));
  return { kind: "upload", upload: "http-upload", local };
}

/**
 * What one simple command sends, if anything. `routedBefore` says a proxy variable was set
 * earlier in the same shell text (`export HTTPS_PROXY=…`).
 */
function readSimple(simple: SimpleCommand, routedBefore: boolean): Traffic | undefined {
  const { program, args, assignments } = programAndArgs(simple);
  const routed = routedBefore || assignments.some((a) => PROXY_VARIABLE.test(a));
  const first = args.find((a) => !a.startsWith("-")) ?? "";
  const starter = TUNNEL_STARTERS.get(program);
  if (starter !== undefined && (starter.length === 0 || starter.includes(first))) {
    return { kind: "tunnel", local: false };
  }
  switch (program) {
    case "curl":
      return readCurl(args, routed);
    case "wget":
      return readWget(args, routed);
    case "scp":
    case "rsync":
      return readRemoteCopy(args, routed);
    case "aws":
    case "awslocal":
      return readAwsS3(args, program === "awslocal", routed);
    case "gsutil":
      return ["cp", "mv", "rsync"].includes(first)
        ? readStorageCopy(copyOperands(args, new Set()).slice(1), /^gs:\/\//, false)
        : undefined;
    case "gcloud":
      return args[0] === "storage" && ["cp", "mv", "rsync"].includes(args[1] ?? "")
        ? readStorageCopy(copyOperands(args, new Set()).slice(2), /^gs:\/\//, false)
        : undefined;
    case "az":
      return args[0] === "storage" && args[1] === "blob" && /^upload/.test(args[2] ?? "")
        ? { kind: "upload", upload: "cloud-storage", local: false }
        : undefined;
    case "rclone":
      return ["copy", "copyto", "move", "moveto", "sync"].includes(first)
        ? readStorageCopy(copyOperands(args, new Set()).slice(1), /^[A-Za-z0-9_-]{2,}:/, false)
        : undefined;
    case "gh":
      if (args[0] === "gist" && args[1] === "create") {
        return { kind: "upload", upload: "paste", local: false };
      }
      return args[0] === "release" && args[1] === "upload"
        ? { kind: "upload", upload: "http-upload", local: false }
        : undefined;
    case "nc":
    case "ncat":
    case "netcat":
      return readNetcat(args, routed);
    case "socat":
      return readSocat(args);
    case "ssh":
      return readSsh(simple, args);
    default:
      return undefined;
  }
}

/** What a shell text sends, by this module's own reading. */
export function readEgress(command: string): Traffic[] {
  const out: Traffic[] = [];
  let routed = false;
  for (const simple of simpleCommands(command)) {
    const { program, args } = programAndArgs(simple);
    if (program === "export" && args.some((a) => PROXY_VARIABLE.test(a))) routed = true;
    const traffic = readSimple(simple, routed);
    if (traffic !== undefined) out.push(traffic);
  }
  return out;
}

/** Guardrails whose match is an upload or a tunnel, and what each counts as. */
export const EGRESS_RULES: ReadonlyMap<string, UploadKind | "tunnel"> = new Map([
  ["ex.file-upload", "other"],
  ["se.secret-egress", "other"],
  ["ex.paste-service", "paste"],
  ["ex.reverse-shell", "raw-socket"],
  ["ex.tunnel-expose", "tunnel"],
]);

/**
 * The tunnel or relay program a process entry is, if any: its file name, lower case, without
 * `.exe`, equal to one of `TUNNEL_PROCESS_NAMES`. A name that only contains one does not count.
 */
export function tunnelProgramOf(entry: string): TunnelProgram | undefined {
  const name = (entry.trim().split(/[\\/]/).pop() ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
  return (TUNNEL_PROCESS_NAMES as readonly string[]).includes(name)
    ? (name as TunnelProgram)
    : undefined;
}

/**
 * The tunnel and relay programs among what the seam reports running, each once, in
 * `TUNNEL_PROCESS_NAMES` order. Programs, not processes: two `ngrok` processes are one.
 */
export function tunnelProgramsIn(running: readonly string[]): TunnelProgram[] {
  const seen = new Set<TunnelProgram>();
  for (const entry of running) {
    const program = tunnelProgramOf(entry);
    if (program !== undefined) seen.add(program);
  }
  return TUNNEL_PROCESS_NAMES.filter((p) => seen.has(p));
}

/** What the egress check needs. */
export interface EgressInput {
  readonly calls: CorpusCalls;
  readonly catalog: readonly CompiledRule[];
  readonly allowlist: CompiledAllowlist;
  readonly io: VerifyIO;
}

/** What the egress check produced. */
export interface EgressOutcome {
  readonly check: EgressCheck;
  readonly localFixes: readonly (LocalFix | UnsafeFix)[];
}

/** Run the egress check. See the module header. Never throws. */
export async function checkEgress(input: EgressInput): Promise<EgressOutcome> {
  const { agent, calls } = input.calls;
  const egressRule = rulesMatcher(input.catalog, input.allowlist, (r) =>
    EGRESS_RULES.has(r.rule.id),
  );
  const counts = {
    uploads: 0,
    tunnelsStarted: 0,
    localOnly: 0,
    mentioned: 0,
    unconfirmed: 0,
  };
  const kinds = new Set<UploadKind>();
  let matches = 0;

  for (const call of calls) {
    if (!isShell(call)) continue;
    const ruled = call.ruleIds.filter((id) => EGRESS_RULES.has(id));
    if (ruled.length === 0 && readEgress(call.command).length === 0) continue;
    matches += 1;
    const holds = (command: string): boolean =>
      readEgress(command).length > 0 || egressRule(call, command);
    const state = runStateOf(agent, call, holds);
    if (state === "mentioned") {
      counts.mentioned += 1;
      continue;
    }
    if (state === "unknown") {
      counts.unconfirmed += 1;
      continue;
    }

    const ran = executedText(call.command);
    const traffic = readEgress(ran);
    if (traffic.length === 0 && egressRule(call, ran)) {
      // A guardrail matched a shape the reading above does not know. It counts as leaving the
      // machine: nothing here shows it stayed.
      const as = ruled.map((id) => EGRESS_RULES.get(id)).find((k) => k !== undefined) ?? "other";
      traffic.push(
        as === "tunnel"
          ? { kind: "tunnel", local: false }
          : { kind: "upload", upload: as, local: false },
      );
    }
    for (const item of traffic) {
      if (item.local) counts.localOnly += 1;
      else if (item.kind === "tunnel") counts.tunnelsStarted += 1;
      else {
        counts.uploads += 1;
        kinds.add(item.upload);
      }
    }
  }

  const listed = await input.io.processNames();
  const running = listed.ok ? tunnelProgramsIn(listed.running) : [];
  const facts: EgressFacts = {
    ...counts,
    uploadKinds: UPLOAD_KINDS.filter((k) => kinds.has(k)),
    tunnelsRunning: running.length,
    tunnelPrograms: running,
    processCheck: listed.ok ? "checked" : "could-not-check",
    // Traffic behind a program no check reads, in any call, read or not.
    ...hidingFacts(
      input.calls,
      backstopCalls(
        input.calls,
        READ_PROGRAMS.egress,
        (tail) => readEgress(tail).some((t) => !t.local),
        egressRule,
      ),
    ),
  };
  const fixes = running.map((program) =>
    // The program is one of `TUNNEL_PROCESS_NAMES`, so the command carries no data.
    localFixCommand("egress", ["pgrep", "-lx", program]),
  );
  return { check: { status: egressStatus(facts), matches, facts }, localFixes: fixes };
}

/** The egress card's tone. A tunnel running now is `act`; an upload that ran is `review`. */
export function egressStatus(facts: EgressFacts): VerifyStatus {
  if (facts.tunnelsRunning > 0) return "act";
  if (facts.uploads + facts.tunnelsStarted > 0) return "review";
  if (facts.processCheck === "could-not-check") return "could-not-check";
  return quietStatus(facts.unconfirmed, facts.couldHide);
}

// ── The card ─────────────────────────────────────────────────────────────────

/** How each upload kind reads in a sentence. */
const KIND_WORDS: Readonly<Record<UploadKind, string>> = {
  "http-upload": "HTTP uploads",
  "file-copy": "copies to another host",
  "cloud-storage": "copies into cloud storage",
  paste: "paste or gist posts",
  "raw-socket": "raw network sends",
  other: "other uploads a guardrail matched",
};

/** A template that renders when `when` holds. */
function when(
  id: string,
  test: (f: EgressFacts) => boolean,
  say: (f: EgressFacts) => string,
): SentenceTemplate<EgressFacts> {
  return { id, render: (f) => (test(f) ? say(f) : undefined) };
}

/** "What checking found". */
export const EGRESS_FOUND: readonly SentenceTemplate<EgressFacts>[] = [
  when(
    "egress.uploads",
    (f) => f.uploads > 0,
    (f) =>
      `${counted(f.uploads, "upload", "uploads")} that ran sent data off this machine: ${f.uploadKinds.map((k) => KIND_WORDS[k]).join(", ")}.`,
  ),
  when(
    "egress.tunnels-started",
    (f) => f.tunnelsStarted > 0,
    (f) =>
      `${counted(f.tunnelsStarted, "tunnel was", "tunnels were")} started to expose a port on this machine.`,
  ),
  when(
    "egress.none",
    (f) => f.uploads + f.tunnelsStarted === 0 && f.couldHide === 0 && f.unconfirmed === 0,
    () => "No upload or tunnel that ran sent data off this machine.",
  ),
  when(
    "egress.local-only",
    (f) => f.localOnly > 0,
    (f) =>
      `${counted(f.localOnly, "match", "matches")} went only to this machine (a local server or LocalStack) and ${f.localOnly === 1 ? "is" : "are"} not counted.`,
  ),
  couldHideTemplate("egress.could-hide"),
  when(
    "egress.mentioned",
    (f) => f.mentioned > 0,
    (f) =>
      `${moreMatches(f.mentioned, f.uploads + f.tunnelsStarted + f.localOnly > 0)} only mentioned an upload or a tunnel (in a test, a search or a message) and did not run.`,
  ),
  when(
    "egress.unconfirmed",
    (f) => f.unconfirmed > 0,
    (f) => `${counted(f.unconfirmed, "match", "matches")} could not be confirmed as run.`,
  ),
];

/** "Now": tunnel and relay programs running. */
export const EGRESS_NOW: readonly SentenceTemplate<EgressFacts>[] = [
  when(
    "egress.running",
    (f) => f.tunnelsRunning > 0,
    (f) =>
      `${counted(f.tunnelsRunning, "tunnel or relay program is", "tunnel or relay programs are")} running now: ${f.tunnelPrograms.join(", ")}.`,
  ),
  when(
    "egress.running-none",
    (f) => f.processCheck === "checked" && f.tunnelsRunning === 0,
    () => "No known tunnel or relay program is running now.",
  ),
  when(
    "egress.running-unknown",
    (f) => f.processCheck === "could-not-check",
    () => "The running programs could not be listed, so running tunnels were not checked.",
  ),
];

/** "Fix", in sentences. */
export const EGRESS_FIX_STEPS: readonly SentenceTemplate<EgressFacts>[] = [
  when(
    "egress.fix.running",
    (f) => f.tunnelsRunning > 0,
    () => "Stop the tunnel or relay programs you did not start on purpose.",
  ),
  when(
    "egress.fix.uploads",
    (f) => f.uploads + f.tunnelsStarted > 0,
    () => "Check what each upload or tunnel sent, and to where.",
  ),
];

/** The chip's usual claim: the number is shown apart. */
const EGRESS_CHIP: ChipReason<EgressFacts> = {
  id: "egress.chip",
  count: (f) => f.uploads,
  one: "upload off this machine",
  many: "uploads off this machine",
};

/** What can make the card act, then review, in the order `egressStatus` reads them. */
const EGRESS_CHIP_REASONS: readonly ChipReason<EgressFacts>[] = [
  {
    id: "egress.chip.running",
    count: (f) => f.tunnelsRunning,
    one: "tunnel or relay program running now",
    many: "tunnel or relay programs running now",
  },
  EGRESS_CHIP,
  {
    id: "egress.chip.tunnels",
    count: (f) => f.tunnelsStarted,
    one: "tunnel started",
    many: "tunnels started",
  },
];

/** The card for the egress check. */
export const egressCard: ToCard<"egress"> = (result, context: CardContext) => {
  const f = result.facts;
  const card: FullCard = {
    category: "egress",
    tone: result.status,
    count: result.matches,
    found: sentences(EGRESS_FOUND, f),
    now: sentences(EGRESS_NOW, f),
    fixes: f.tunnelsRunning > 0 ? [{ shape: "pgrep -lx <program>" }] : [],
    fixSteps: sentences(EGRESS_FIX_STEPS, f),
    chip: chipFor(f, EGRESS_CHIP_REASONS, EGRESS_CHIP),
    codexCaveat: restsOnCodex(context) && f.uploads + f.tunnelsStarted > 0,
  };
  return card;
};
