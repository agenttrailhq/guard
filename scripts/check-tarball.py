#!/usr/bin/env python3
"""Check a packed npm tarball before it is published.

Checks:
  1. The packed manifest's name and version match --package and --version.
  2. The top-level entries are exactly EXPECTED_ROOTS. package.json is present in every npm
     tarball and is not compared.
  3. Every path in REQUIRED_FILES is in the tarball.
  4. The manifest is not private, has no runtime dependencies, and no dependency range uses the
     `workspace:` protocol.
  5. Every path named by main, module, types, typings, exports and bin exists in the tarball.

EXPECTED_ROOTS and REQUIRED_FILES are written out here rather than read from package.json
`files`, so an incorrect `files` entry fails the check instead of matching itself.

Usage:  python3 scripts/check-tarball.py <tarball> --package <name> --version <version>
Exit:   0 all checks passed · 1 a check failed · 2 the tarball could not be read
"""

from __future__ import annotations

import argparse
import json
import sys
import tarfile

# Top-level entries the tarball must contain, exactly.
EXPECTED_ROOTS = {"dist", "plugin", "README.md", "LICENSE"}

# Files the CLI and the Claude Code plugin need at runtime.
REQUIRED_FILES = {
    "dist/cli.js",
    "plugin/.claude-plugin/plugin.json",
    "plugin/.claude-plugin/marketplace.json",
    "plugin/hooks/hooks.json",
    "plugin/scripts/guard-hook.mjs",
}


def is_macos_noise(path: str) -> bool:
    """AppleDouble (`._*`) and `.DS_Store` entries written by macOS tar. Ignored, and counted."""
    base = path.rsplit("/", 1)[-1]
    return base.startswith("._") or base == ".DS_Store"


def load_tarball(path: str) -> tuple[dict, list[str], int]:
    """Return the packed manifest, the member paths without the `package/` prefix, and the
    number of macOS metadata entries dropped."""
    with tarfile.open(path, "r:gz") as tf:
        raw = [n[len("package/") :] for n in tf.getnames() if n.startswith("package/")]
        member = tf.extractfile("package/package.json")
        if member is None:
            raise SystemExit("check-tarball: tarball has no package/package.json")
        manifest = json.loads(member.read().decode("utf-8"))
    kept = [n for n in raw if n and not is_macos_noise(n)]
    return manifest, kept, len([n for n in raw if n and is_macos_noise(n)])


def entry_point_targets(manifest: dict) -> list[tuple[str, str]]:
    """Every path the manifest exposes to a consumer, as (field, path) pairs."""
    out: list[tuple[str, str]] = []

    for field in ("main", "module", "types", "typings"):
        value = manifest.get(field)
        if isinstance(value, str):
            out.append((field, value))

    def walk(node: object, label: str) -> None:
        if isinstance(node, str):
            out.append((label, node))
        elif isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{label}.{key}")

    if "exports" in manifest:
        walk(manifest["exports"], "exports")
    if "bin" in manifest:
        walk(manifest["bin"], "bin")

    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("tarball")
    ap.add_argument("--package", required=True)
    ap.add_argument("--version", required=True)
    args = ap.parse_args()

    try:
        manifest, members, noise = load_tarball(args.tarball)
    except (OSError, tarfile.TarError) as exc:
        print(f"check-tarball: could not read {args.tarball}: {exc}", file=sys.stderr)
        return 2

    failures: list[str] = []
    member_set = set(members)
    roots = {m.split("/", 1)[0] for m in members if m != "package.json"}

    # Name, version and top-level entries
    if manifest.get("name") != args.package:
        failures.append(f"packed name is {manifest.get('name')!r}, expected {args.package!r}")
    if manifest.get("version") != args.version:
        failures.append(f"packed version is {manifest.get('version')!r}, expected {args.version!r}")

    missing = sorted(EXPECTED_ROOTS - roots)
    if missing:
        failures.append(f"tarball is missing required entries: {', '.join(missing)}")
    unexpected = sorted(roots - EXPECTED_ROOTS)
    if unexpected:
        failures.append(
            f"tarball has unexpected top-level entries: {', '.join(unexpected)} "
            "(update EXPECTED_ROOTS if the package layout changed)"
        )

    for path in sorted(REQUIRED_FILES - member_set):
        failures.append(f"tarball is missing {path}")

    # Manifest is publishable, self-contained and resolvable outside a workspace
    if manifest.get("private") is True:
        failures.append("packed manifest is private: true")

    if manifest.get("dependencies"):
        names = ", ".join(sorted(manifest["dependencies"]))
        failures.append(f"packed manifest has runtime dependencies: {names}")

    for field in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        for name, rng in (manifest.get(field) or {}).items():
            if isinstance(rng, str) and rng.startswith("workspace:"):
                failures.append(f"{field}.{name} uses the workspace protocol ({rng!r})")

    targets = entry_point_targets(manifest)
    for field, target in targets:
        rel = target[2:] if target.startswith("./") else target
        if rel not in member_set:
            failures.append(f"manifest {field} points at {target!r}, which is not in the tarball")

    if failures:
        print("check-tarball: failed\n", file=sys.stderr)
        for f in failures:
            print(f"  x {f}", file=sys.stderr)
        return 1

    print(f"  ok  packed as {manifest['name']}@{manifest['version']}")
    print(f"  ok  top-level entries: {', '.join(sorted(roots))}")
    print(f"  ok  all {len(REQUIRED_FILES)} required files present")
    print("  ok  not private, no runtime dependencies, no workspace: ranges")
    print(f"  ok  all {len(targets)} manifest entry points exist in the tarball")
    if noise:
        print(f"  note  {noise} macOS metadata entries ignored")
    return 0


if __name__ == "__main__":
    sys.exit(main())
