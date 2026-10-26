// cspell:words automount Statting
/**
 * Paths verification must not touch.
 *
 * A working directory named in a transcript can be a network share (`\\host\share`,
 * `//host/share`) or an automount point (`/net/…`, `/Network/…`). Statting one, walking up from
 * one, or running `git` in one reaches the network, so verification treats such a path as not
 * there: the repo it names reads as could-not-check.
 */

/** Is `path` on a network share or an automount? */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path) || /^\/(?:net|Network)(?:\/|$)/.test(path);
}
