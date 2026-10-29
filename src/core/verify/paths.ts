// cspell:words automount Statting
/**
 * Paths verification must not touch.
 *
 * A working directory named in a transcript can be a network share (`\\host\share`,
 * `//host/share`) or an automount point (`/net/…`, `/Network/…`). Statting one, walking up from
 * one, or running `git` in one reaches the network, so verification treats such a path as not
 * there: the repo it names reads as could-not-check.
 *
 * Best effort, by the path's text alone. A network share mounted under a local-looking path
 * is not detected: a mapped drive letter on Windows (`Z:\…`) or an SMB share under
 * `/Volumes/<share>` on macOS, which looks the same as a local disk there. A Windows long path
 * (`\\?\C:\…`) is read as a network path, which leaves it unchecked rather than touched.
 */

/** Is `path` on a network share or an automount? */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path) || /^\/(?:net|Network)(?:\/|$)/.test(path);
}
