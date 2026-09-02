/**
 * The `owns:` purge-scope primitive (arc#359).
 *
 * A package declares the runtime-created state its OWN runtime (not arc) writes
 * to disk — the leftovers `arc remove` cannot know about because arc never
 * installed them. `arc purge` reads this declaration to finish the job apt-style:
 *   - `owns.config` + `owns.state` → deleted (apt conffiles + /var).
 *   - `owns.userData`              → NAMED and KEPT, never deleted (apt /home).
 *
 * This module is the single source of truth for THREE safety-critical concerns,
 * so the validator, `arc files`, and `arc purge` can never disagree. Each layer
 * enforces its guarantee INDEPENDENTLY, so a gap in one is caught by the next:
 *   1. `validateOwns`  — the load-time shape + safety gate. Rejects: home-sweeps
 *      (`~`, `~/`, leading `*`/`**`), absolute paths, any `..` path segment, and
 *      userData↔config/state overlap. Overlap is PATH CONTAINMENT (segment-aware,
 *      both directions), not string equality: a userData entry may not equal, be
 *      an ancestor of, OR be a descendant of any deletable config/state entry.
 *   2. `expandOwnsEntry` / `expandOwns` — glob expansion, ALWAYS rooted at the
 *      user's home so a pattern can only ever name paths under home. It ALSO
 *      independently refuses any entry with a `..` path segment before globbing
 *      (defense-in-depth — it does not rely on `validateOwns` having run first).
 *   3. `deleteOwnedPath` — the deletion primitive: refuse anything that escapes
 *      home (lexically or via a parent symlink), and NEVER follow a symlink OUT
 *      of the tree (unlink the link itself, never `rm -rf` its target's tree).
 */

import { Glob } from "bun";
import { existsSync, lstatSync, realpathSync } from "fs";
import { lstat, unlink, rm } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve, dirname, basename } from "path";
import type { OwnsDeclaration } from "../types.js";
import { errorMessage, isErrno } from "./errors.js";

/** The three ownership classes, in display order. */
export const OWNS_CLASSES = ["config", "state", "userData"] as const;
export type OwnsClass = (typeof OWNS_CLASSES)[number];

/** Classes `arc purge` DELETES. `userData` is deliberately excluded. */
export const PURGEABLE_OWNS_CLASSES = ["config", "state"] as const;

/** One `owns` shape/safety violation. Same {field, rule} shape as the strict
 *  manifest validator's `Violation`, so it threads straight into `arc validate`. */
export interface OwnsViolation {
  field: string;
  rule: string;
}

/** Glob metacharacters. A pattern containing any of these is expanded via `Glob`;
 *  a pattern without them is a literal path (may or may not exist on disk). */
const GLOB_MAGIC_RE = /[*?[\]{}]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an `owns` declaration's shape and safety. Pure — returns EVERY
 * violation (empty ⇒ valid) so a publisher fixes the whole block in one pass.
 * The loader (`manifest.ts`) throws when this is non-empty; the strict validator
 * (`validate-manifest.ts`) folds the violations into its report.
 *
 * Rules (safety-first — a bad entry could sweep the user's home tree):
 *   - `owns` is a map with only `config`/`state`/`userData` keys, each an array
 *     of strings.
 *   - Every entry is `~/…`-rooted with a non-empty tail. Rejected: absolute
 *     paths (`/…`), a bare `~`, `~/` (empty tail), and a plain `/`.
 *   - A leading `*`/`**` segment (`~/*`, `~/**`) is rejected — it sweeps the
 *     whole home tree.
 *   - No `..` segment anywhere (defense against escaping the declared tree).
 *   - A `userData` entry may not OVERLAP a `config`/`state` (deletable) entry —
 *     containment in either direction, compared segment-aware on the entries'
 *     non-glob path roots. The never-delete class must not equal, contain, or be
 *     contained by anything a purge would delete (so `config:['~/work']` +
 *     `userData:['~/work/repo']` is rejected, and vice versa, while `~/work`
 *     vs `~/workspace` is NOT flagged — those are sibling paths, not nested).
 */
export function validateOwns(owns: unknown): OwnsViolation[] {
  const violations: OwnsViolation[] = [];
  if (owns === undefined || owns === null) return violations;

  if (!isRecord(owns)) {
    violations.push({
      field: "owns",
      rule: `must be a map with config/state/userData arrays (got ${Array.isArray(owns) ? "array" : typeof owns})`,
    });
    return violations;
  }

  const unknownKeys = Object.keys(owns).filter(
    (k) => !(OWNS_CLASSES as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    violations.push({
      field: "owns",
      rule: `may only declare ${OWNS_CLASSES.join("/")}; unexpected key(s): ${unknownKeys.join(", ")}`,
    });
  }

  for (const cls of OWNS_CLASSES) {
    const value = owns[cls];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      violations.push({ field: `owns.${cls}`, rule: "must be an array of ~-rooted paths/globs" });
      continue;
    }
    value.forEach((entry, i) => {
      const field = `owns.${cls}[${i}]`;
      if (typeof entry !== "string" || entry.trim().length === 0) {
        violations.push({ field, rule: "must be a non-empty string" });
        return;
      }
      for (const rule of entryViolations(entry)) {
        violations.push({ field, rule });
      }
    });
  }

  // Overlap: a userData entry must not OVERLAP a config/state (deletable) entry.
  // Containment in EITHER direction — userData is never deleted, so it must not
  // equal, be an ancestor of, or be a descendant of anything a purge deletes.
  // Compared segment-aware on tilde-expanded, non-glob path ROOTS, so a shared
  // string prefix that is NOT a path-segment boundary (`~/work` vs `~/workspace`)
  // is not mistaken for nesting.
  const home = homedir();
  const deletables = [
    ...asStringArray(owns.config).map((entry) => ({ entry, cls: "config" })),
    ...asStringArray(owns.state).map((entry) => ({ entry, cls: "state" })),
  ];
  for (const ud of asStringArray(owns.userData)) {
    const udRoot = containmentRoot(ud, home);
    for (const del of deletables) {
      const delRoot = containmentRoot(del.entry, home);
      if (!pathsNest(udRoot, delRoot)) continue;
      let relation: string;
      if (udRoot === delRoot) {
        relation = `they resolve to the same path`;
      } else if (udRoot.startsWith(delRoot + "/")) {
        relation = `userData '${ud}' is nested inside ${del.cls} '${del.entry}'`;
      } else {
        relation = `${del.cls} '${del.entry}' is nested inside userData '${ud}'`;
      }
      violations.push({
        field: "owns.userData",
        rule: `userData '${ud}' overlaps deletable ${del.cls} entry '${del.entry}' — ${relation}; userData is never deleted and must not overlap a deletable class`,
      });
    }
  }

  return violations;
}

/**
 * Do two owns ENTRIES overlap on disk — equal, or one nested inside the other?
 *
 * The containment primitive `validateOwns` uses above, exported for arc#401's
 * CROSS-MEMBER gate (`compositionOwnsConflicts`, lib/composition.ts). A
 * composition can pair two individually-valid manifests into an invalid union —
 * one member's userData containing another member's state — and the two gates
 * must not hold two opinions about what "overlaps" means, so there is one
 * implementation and the composition gate imports it rather than re-deriving.
 *
 * Compared on glob-stripped, tilde-expanded roots at PATH SEGMENT boundaries,
 * so `~/work` and `~/workspace` do not overlap while `~/work` and `~/work/repo`
 * do (in either argument order).
 */
export function ownsEntriesOverlap(a: string, b: string, home: string = homedir()): boolean {
  return pathsNest(containmentRoot(a, home), containmentRoot(b, home));
}

/**
 * The absolute, non-glob path ROOT of an entry, for containment comparison.
 * Strips the glob tail (every segment from the first glob-magic segment on) and
 * tilde-expands to an absolute path under `home`. So `~/.config/cortex/**` and
 * `~/.config/cortex/*.yaml` both root at `<home>/.config/cortex`, and `~/work`
 * roots at `<home>/work`.
 */
function containmentRoot(entry: string, home: string): string {
  const tail = entry.startsWith("~/") ? entry.slice(2) : entry.replace(/^~/, "");
  const solid: string[] = [];
  for (const seg of tail.split("/")) {
    if (seg.length === 0) continue;
    if (GLOB_MAGIC_RE.test(seg)) break; // first glob segment ends the solid prefix
    solid.push(seg);
  }
  return join(home, ...solid);
}

/**
 * True when two normalized absolute paths are equal or one contains the other,
 * compared on PATH SEGMENT boundaries — never a raw string prefix. So
 * `<h>/work` and `<h>/workspace` do NOT nest, but `<h>/work` and `<h>/work/repo`
 * do (in either argument order).
 */
function pathsNest(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Per-entry safety rules. Returns the rule strings this entry violates. */
function entryViolations(entry: string): string[] {
  const rules: string[] = [];

  if (isAbsolute(entry)) {
    rules.push(`must be ~-rooted, not an absolute path ('${entry}')`);
    return rules;
  }
  if (!entry.startsWith("~/")) {
    // Catches a bare '~', '~/'-less, or a relative path. A lone '/' is absolute
    // (handled above); '~' and '~foo' land here.
    rules.push(`must start with '~/' (got '${entry}')`);
    return rules;
  }
  const tail = entry.slice(2); // strip "~/"
  if (tail.trim().length === 0) {
    rules.push("has an empty tail after '~/' — this would sweep the whole home tree");
    return rules;
  }
  const segments = tail.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    rules.push("has an empty tail after '~/' — this would sweep the whole home tree");
    return rules;
  }
  if (segments.includes("..")) {
    rules.push(`must not contain a '..' segment ('${entry}')`);
  }
  if (segments[0] === "*" || segments[0] === "**") {
    rules.push(`must not begin with a '*'/'**' segment ('${entry}') — that sweeps the whole home tree`);
  }
  return rules;
}

/** True when a manifest declares at least one owns entry across any class. */
export function hasOwns(owns: OwnsDeclaration | undefined): boolean {
  if (!owns) return false;
  return OWNS_CLASSES.some((cls) => (owns[cls]?.length ?? 0) > 0);
}

/** The config+state (deletable) entries flattened, in declaration order. */
export function purgeableEntries(owns: OwnsDeclaration | undefined): string[] {
  if (!owns) return [];
  return [...(owns.config ?? []), ...(owns.state ?? [])];
}

/** The userData (never-delete) entries. */
export function userDataEntries(owns: OwnsDeclaration | undefined): string[] {
  return owns?.userData ?? [];
}

/**
 * Expand ONE `~`-rooted entry to concrete absolute paths under `home`.
 *
 * - INDEPENDENTLY of `validateOwns`, an entry containing a `..` path SEGMENT is
 *   refused up front (returns `[]`) — this function provides its own traversal
 *   defense and never expands a `..` pattern, even if it is called on an entry
 *   the load-time validator never saw. The check is segment-aware: a literal
 *   filename like `foo..bar` is NOT a `..` segment and expands normally.
 * - A glob pattern (`…/**`, `…/*.conf`) is scanned via `Glob`, ALWAYS rooted at
 *   `home` — so a pattern can only ever name paths under home. Zero matches ⇒
 *   empty array (the caller renders "absent").
 * - A literal path is returned as a single candidate whether or not it exists —
 *   the caller decides present/absent by stat.
 *
 * Every returned path is filtered through {@link isUnderHome} as a belt-and-
 * braces check; an entry that (somehow) resolves outside home is dropped here
 * and never reaches the deleter.
 */
export function expandOwnsEntry(entry: string, home: string = homedir()): string[] {
  const tail = entry.startsWith("~/") ? entry.slice(2) : entry.replace(/^~/, "");
  // Defense-in-depth: refuse a `..` path segment before globbing. Segment-aware,
  // so a literal filename like `foo..bar` (no `..` segment) is unaffected.
  if (tail.split("/").some((seg) => seg === "..")) return [];
  if (GLOB_MAGIC_RE.test(tail)) {
    const matches: string[] = [];
    const glob = new Glob(tail);
    for (const rel of glob.scanSync({ cwd: home, dot: true, onlyFiles: false, followSymlinks: false })) {
      const abs = join(home, rel);
      if (isUnderHome(abs, home)) matches.push(abs);
    }
    return matches.sort();
  }
  const abs = join(home, tail);
  return isUnderHome(abs, home) ? [abs] : [];
}

/** True when `absPath` is lexically inside `home` (and not home itself). */
export function isUnderHome(absPath: string, home: string): boolean {
  const rel = relative(resolve(home), resolve(absPath));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Outcome of attempting to delete one resolved owns match. */
export type DeleteStatus = "deleted" | "deleted-symlink" | "absent" | "refused-escape" | "error";

export interface DeleteOutcome {
  path: string;
  status: DeleteStatus;
  /** Present only for status "error"/"refused-escape". */
  detail?: string;
}

/**
 * Delete one resolved owns match, safely.
 *
 * Safety rails (arc#359):
 *   - Refuse anything not lexically under `home`, or equal to `home`.
 *   - If the path is itself a symlink, `unlink` the LINK — never `rm -rf` through
 *     it (that would delete the target's tree, which may live outside the
 *     declared area).
 *   - For a real file/dir, resolve the PARENT's realpath and re-check containment
 *     so a parent-component symlink pointing outside home can't smuggle the
 *     delete out of the tree. Only then `rm -rf`.
 *
 * Idempotent: a missing path returns "absent", never throws.
 */
export async function deleteOwnedPath(absPath: string, home: string): Promise<DeleteOutcome> {
  const resolvedHome = safeRealpath(home) ?? resolve(home);

  if (!isUnderHome(absPath, resolvedHome) && !isUnderHome(absPath, resolve(home))) {
    return { path: absPath, status: "refused-escape", detail: "not under home" };
  }

  let stat;
  try {
    stat = await lstat(absPath);
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return { path: absPath, status: "absent" };
    return { path: absPath, status: "error", detail: errorMessage(err) };
  }

  // A symlink: remove the LINK itself, never traverse it.
  if (stat.isSymbolicLink()) {
    try {
      await unlink(absPath);
      return { path: absPath, status: "deleted-symlink" };
    } catch (err) {
      return { path: absPath, status: "error", detail: errorMessage(err) };
    }
  }

  // Real file/dir: guard against a parent-component symlink escaping home.
  const realParent = safeRealpath(dirname(absPath));
  if (realParent !== null) {
    const realTarget = join(realParent, basename(absPath));
    if (!isUnderHome(realTarget, resolvedHome)) {
      return { path: absPath, status: "refused-escape", detail: "resolves outside home via a symlinked parent" };
    }
  }

  try {
    await rm(absPath, { recursive: true, force: true });
    return { path: absPath, status: "deleted" };
  } catch (err) {
    return { path: absPath, status: "error", detail: errorMessage(err) };
  }
}

/** realpathSync that swallows ENOENT (returns null) but surfaces nothing noisy. */
function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    // Path (or a component) does not exist yet — caller falls back to the
    // lexical resolve. Not an error worth surfacing.
    return null;
  }
}

/** Present/absent liveness of a single resolved path (for `arc files`). Follows
 *  nothing dangerous — uses lstat so a dangling symlink still reads "present". */
export function pathLiveness(absPath: string): "present" | "absent" {
  try {
    lstatSync(absPath);
    return "present";
  } catch {
    return existsSync(absPath) ? "present" : "absent";
  }
}
