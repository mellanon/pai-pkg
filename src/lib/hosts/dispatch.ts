import type { ArtifactType, HostAdapter } from "../../types.js";

/**
 * Map an artifact type to its install directory on a given host.
 *
 * Returns `null` for types that don't live inside a host's directory tree:
 *
 *   - `pipeline` / `action` — arc state (`~/.config/metafactory/{pipelines,actions}/`)
 *   - `rules`               — writes templates into the consumer repo
 *   - `governance`          — provides.files drops + consumer-repo templates only
 *   - `library`             — meta type; contained artifacts route individually
 *   - `component`           — no per-type primary layout; uses provides.files only
 *
 * Phase 2 install dispatch (per #117) uses this to ask the host "where does
 * this go on you?" instead of hard-coding `host.paths.skillsDir` etc. at
 * every call site. When future adapters land (Codex, Cursor, …) they can
 * differ on directory naming without changing dispatch code.
 *
 * Returning `null` is the right "I cannot install this" signal — callers
 * should fall back to the arc-state path or the consumer repo, never invent
 * a host directory the adapter didn't promise.
 *
 * ## Not equivalent to `HostAdapter.supports()`
 *
 * The two answer different questions:
 *
 *   - `supports(type)` → "does the host *recognize* this artifact type?"
 *   - `hostPathFor(host, type)` → "does this type *install into* a host
 *     directory, and if so, where?"
 *
 * `host.supports("component")` is `true` (Claude Code recognizes components)
 * but `hostPathFor(host, "component")` is `null` (components don't install
 * into a host directory). Don't bridge them — calling
 * `hostPathFor(host, type)!` after a positive `supports()` check will hit a
 * null on component / rules / library.
 */
export function hostPathFor(
  host: HostAdapter,
  type: ArtifactType | "system",
): string | null {
  switch (type) {
    case "skill":
    case "system":
      return host.paths.skillsDir;
    case "agent":
      return host.paths.agentsDir;
    case "prompt":
      return host.paths.promptsDir;
    case "tool":
      return host.paths.binDir;
    case "component":
    case "rules":
    case "governance":
    case "library":
    case "pipeline":
    case "action":
      return null;
    default:
      return null;
  }
}

/**
 * Throwing variant of {@link hostPathFor}. Use at install/remove dispatch
 * points that have already established the artifact type *must* live in a
 * host directory (skill / agent / prompt / tool) — turning a null into a
 * single-line precondition error keeps the call sites readable.
 *
 * For types that legitimately return null (component / rules / library /
 * pipeline / action), use {@link hostPathFor} directly and branch on null.
 */
export function requireHostDir(
  host: HostAdapter,
  type: ArtifactType | "system",
  description?: string,
): string {
  const dir = hostPathFor(host, type);
  if (!dir) {
    const what = description ?? `support ${type as string} artifacts`;
    throw new Error(`Host ${host.id} does not ${what}`);
  }
  return dir;
}
