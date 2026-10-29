// cspell:words localdomain localstack
/**
 * Is a host this machine? For telling a localhost health check or a LocalStack call from
 * traffic that leaves the machine.
 *
 * Pure. Nothing is resolved: a name is judged by its text, and a name that only might be
 * local (a bare `db`, a `.local` name) is not taken as local.
 */

/** Host names and addresses that are this machine, or a container's view of it. */
const LOCAL_NAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "host.docker.internal",
  "gateway.docker.internal",
  "host.containers.internal",
  "0.0.0.0",
  "::",
  "::1",
  "[::1]",
  "[::]",
]);

/**
 * LocalStack, the AWS emulator that runs on this machine: its container's name, and the name
 * its DNS answers with a loopback address (`localhost.localstack.cloud` and names under it).
 * `localstack.cloud` itself is LocalStack's public site, and is not local.
 */
const LOCALSTACK = /^localstack$|(?:^|\.)localhost\.localstack\.cloud$/;

/** Is `host` this machine? */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (LOCAL_NAMES.has(name)) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(name)) return true;
  if (/\.localhost$/.test(name)) return true;
  return LOCALSTACK.test(name);
}

/**
 * The host in a URL or a `user@host:path` / `host:path` copy target, or `undefined` when the
 * text names none. A URL's user part ends at the first `/`, `?` or `#`, so an `@` in a query
 * or a fragment is never read as one.
 */
export function hostOf(target: string): string | undefined {
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i.exec(target);
  if (url !== null) return url[1];
  const remote = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^:/\s]+):(?!\/\/)/.exec(target);
  if (remote !== null) return remote[1];
  return undefined;
}

/** A bare host with an optional port: `localhost:4566`, `example.com`. */
export function bareHost(target: string): string | undefined {
  const match = /^(\[[^\]]+\]|[A-Za-z0-9.-]+)(?::\d+)?(?:\/.*)?$/.exec(target);
  return match?.[1];
}

/** The value of every `--endpoint-url` among an AWS command's words, in order. */
export function endpointUrls(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string;
    if (arg === "--endpoint-url") out.push(args[k + 1] ?? "");
    else if (arg.startsWith("--endpoint-url=")) out.push(arg.slice("--endpoint-url=".length));
  }
  return out;
}

/**
 * Do an AWS command's endpoints all name this machine? `undefined` when it names none. Every
 * one counts, whichever the tool would use: one that names another host, or no host at all,
 * makes the answer `false`.
 */
export function endpointsLocal(args: readonly string[]): boolean | undefined {
  const urls = endpointUrls(args);
  if (urls.length === 0) return undefined;
  return urls.every((url) => {
    const host = hostOf(url) ?? bareHost(url);
    return host !== undefined && isLocalHost(host);
  });
}
