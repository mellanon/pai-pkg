/**
 * The install-time INVENTORY SNAPSHOT of a whole composition, and the
 * mechanical diff that verifies a purge undid it (arc#401,
 * `docs/design-factory-type.md` D6; anchor arc#365).
 *
 * D6 is the non-negotiable: install is a reversible decision, and the proof is
 * not a promise in a doc — it is a diff. At install arc records what the
 * composition put on the machine; after `arc purge <factory>` that record is
 * re-checked against the disk, and anything still there is either a LEAK or a
 * user-data REFUSAL. Empty-except-refusals is the acceptance test.
 *
 * ## Why the snapshot stores DECLARATIONS, not only expansions
 *
 * The obvious snapshot — "the list of paths that existed at install" — cannot
 * work, and getting this wrong would make the acceptance test vacuous. A
 * package's `owns.config` / `owns.state` / `owns.userData` name what its
 * RUNTIME writes; at install time almost none of it exists yet (that is exactly
 * the cortex#2441 finding remove.ts already encodes). A snapshot of expansions
 * would record nothing for those entries, and the post-purge diff would then be
 * empty because it looked at nothing — the most dangerous kind of green test.
 *
 * So an owns entry is stored as the ENTRY (`~/.config/metafactory/cortex`,
 * globs included) and re-expanded at diff time. A path the package's runtime
 * created between install and purge is therefore in scope, which is the whole
 * point. Concrete artifacts (symlinks, shims, drops, units) are stored as
 * resolved absolute paths, because those arc itself creates at install and
 * their identity does not depend on when you look.
 *
 * `present` records liveness AT INSTALL. The diff does not gate on it — a leak
 * is a leak whenever it appeared — but it is the honest record of what the
 * install actually landed, and it is what tells an operator reading the
 * snapshot apart from an operator reading a wish list.
 *
 * ## Why this module owns no database
 *
 * Same doctrine as `composition.ts`: db.ts persists rows, this module decides
 * what a row MEANS. The diff is a pure function of (snapshot, disk), so the
 * acceptance test can call it with a snapshot captured by hand — which is what
 * "test-rig assertable" in D6 has to mean if it means anything.
 */

import { existsSync } from "fs";
import { expandOwnsEntry, pathLiveness, type OwnsClass } from "./owns.js";
import { listPackageHooks } from "./hooks.js";
import { canonicalMemberKey } from "./composition-identity.js";

/**
 * The `kind` a snapshot row carries for an `owns:` declaration. Everything
 * else reuses `FileArtifact.kind` verbatim ("artifact symlink", "cli shim",
 * "bin symlink", "provides.files", "hook", "unit") so a snapshot row reads the
 * same as the `arc files` line it came from.
 */
export const OWNS_KIND = "owns";

/**
 * Field separator for the de-duplication key below. NUL, because the fields it
 * joins are paths and owns entries — a separator that CAN occur in one of them
 * would let two different rows collide into one key and silently drop a path
 * from the snapshot. Written as an escape; a raw NUL in the source would make
 * git treat this file as binary.
 */
const KEY_SEP = "\u0000";

/** One row of the composition's install-time inventory. */
export interface InventoryEntry {
  /** The package that contributed it — a member, or the composition itself. */
  member: string;
  /** `FileArtifact.kind`, or `"owns"`. */
  kind: string;
  /** The owns class for `kind: "owns"`; null for every concrete artifact. */
  ownsClass: OwnsClass | null;
  /**
   * The owns DECLARATION for `kind: "owns"` (re-expanded at diff time), the
   * hook's command for `kind: "hook"`, an absolute path for everything else.
   */
  entry: string;
  /** Liveness at the moment the snapshot was taken. */
  present: boolean;
}

/** One thing the snapshot named that is STILL on the machine after a purge. */
export interface InventoryResidue {
  member: string;
  kind: string;
  ownsClass: OwnsClass | null;
  /** The concrete path (or hook descriptor) still present. */
  path: string;
}

/**
 * The D6 verdict: what a purge left behind, split by whether arc MEANT to.
 *
 * `refusals` is `owns.userData` — named and kept, the apt `/home` guarantee
 * (purge.ts's never-touch rule). `residue` is everything else, and a non-empty
 * `residue` is a failed untangle.
 */
export interface InventoryDiff {
  residue: InventoryResidue[];
  refusals: InventoryResidue[];
  /**
   * Paths belonging to a member the cascade RETAINED on purpose — refcounting
   * kept it because another composition or another package still needs it
   * (arc#401 review, W2).
   *
   * A third bucket, not residue, because they are opposite verdicts. The
   * snapshot names everything the composition put on the machine, and a
   * retained member's footprint is legitimately still all of it; classifying
   * that as residue made CORRECT refcounting render as a failed untangle, which
   * is exactly how an operator learns to ignore the one line D6 exists to make
   * trustworthy.
   */
  retained: InventoryResidue[];
}

/** The `arc files`-shaped input a snapshot is built from. */
export interface ListingLike {
  name: string;
  artifacts: { kind: string; path: string; liveness: "present" | "absent" }[];
  owns: { class: OwnsClass; entry: string; matches: { liveness: "present" | "absent" }[] }[];
}

/**
 * Reduce one or more `arc files` listings to snapshot rows.
 *
 * Deduped on (member, kind, entry): a package can declare the same owns entry
 * under two classes, and two listings can name one path, but the snapshot is a
 * SET of things that must be gone — counting a path twice would only make the
 * diff report it twice.
 */
export function inventoryFromListings(listings: readonly ListingLike[]): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  const seen = new Set<string>();
  const push = (row: InventoryEntry): void => {
    const key = [row.member, row.kind, row.ownsClass ?? "", row.entry].join(KEY_SEP);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  };

  for (const listing of listings) {
    for (const artifact of listing.artifacts) {
      push({
        member: listing.name,
        kind: artifact.kind,
        ownsClass: null,
        entry: artifact.path,
        present: artifact.liveness === "present",
      });
    }
    for (const owns of listing.owns) {
      push({
        member: listing.name,
        kind: OWNS_KIND,
        ownsClass: owns.class,
        entry: owns.entry,
        present: owns.matches.some((m) => m.liveness === "present"),
      });
    }
  }
  return out;
}

export interface DiffOptions {
  /** Home root for `~`-rooted owns expansion. */
  home: string;
  /** `settings.json`, so a leftover hook registration is visible as residue. */
  settingsPath: string;
  /**
   * Member names the cascade RETAINED on purpose (arc#401 review, W2). Their
   * rows are classified `retained` rather than `residue` — refcounting keeping
   * a shared member is the design working, not the untangle failing. Compared
   * canonically, so a snapshot row written under one spelling of the member's
   * name still matches a retention decision recorded under another.
   */
  retainedMembers?: readonly string[];
}

/**
 * Re-check a snapshot against the machine — D6's mechanical verification.
 *
 * Every row is asked one question: is the thing you named still here? The
 * answer comes from the same primitives `arc files` uses, so a snapshot row and
 * the `arc files` line it was built from can never disagree about liveness.
 *
 *  - owns rows are RE-EXPANDED (see the module header). `userData` matches land
 *    in `refusals`; `config`/`state` matches are `residue`.
 *  - hook rows are re-read from `settings.json` by the `_arc_pkg` tag, not
 *    stat'ed: a hook's "path" is a settings entry, and a settings.json that
 *    exists proves nothing about whether the package's entry survived in it.
 *  - every other row is a real path and is stat'ed (lstat, so a dangling
 *    symlink still counts as present — a broken link left behind is exactly
 *    the debris the untangle is supposed to remove).
 */
export function diffCompositionInventory(
  entries: readonly InventoryEntry[],
  opts: DiffOptions,
): InventoryDiff {
  const residue: InventoryResidue[] = [];
  const refusals: InventoryResidue[] = [];
  const retained: InventoryResidue[] = [];
  const hooksByPackage = new Map<string, { event: string; command: string }[]>();

  const retainedKeys = new Set((opts.retainedMembers ?? []).map(canonicalMemberKey));
  const isRetained = (member: string): boolean => retainedKeys.has(canonicalMemberKey(member));

  for (const entry of entries) {
    if (entry.kind === OWNS_KIND) {
      for (const path of expandOwnsEntry(entry.entry, opts.home)) {
        if (pathLiveness(path) !== "present") continue;
        const row: InventoryResidue = {
          member: entry.member,
          kind: entry.kind,
          ownsClass: entry.ownsClass,
          path,
        };
        // userData is a refusal whoever owns it — the never-touch promise does
        // not depend on whether the member stayed. A retained member's
        // deletable paths are neither residue nor a refusal: they are still
        // there because the package is still installed.
        if (entry.ownsClass === "userData") refusals.push(row);
        else if (isRetained(entry.member)) retained.push(row);
        else residue.push(row);
      }
      continue;
    }

    if (entry.kind === "hook") {
      if (!hooksByPackage.has(entry.member)) {
        hooksByPackage.set(
          entry.member,
          existsSync(opts.settingsPath) ? listPackageHooks(entry.member, opts.settingsPath) : [],
        );
      }
      const live = hooksByPackage.get(entry.member) ?? [];
      if (live.some((h) => h.command === entry.entry)) {
        const row: InventoryResidue = {
          member: entry.member,
          kind: entry.kind,
          ownsClass: null,
          path: `${opts.settingsPath} :: ${entry.entry}`,
        };
        (isRetained(entry.member) ? retained : residue).push(row);
      }
      continue;
    }

    if (pathLiveness(entry.entry) === "present") {
      const row: InventoryResidue = {
        member: entry.member,
        kind: entry.kind,
        ownsClass: null,
        path: entry.entry,
      };
      (isRetained(entry.member) ? retained : residue).push(row);
    }
  }

  return { residue, refusals, retained };
}

/** Human lines for a diff — the report `arc purge <factory>` prints. */
export function formatInventoryDiff(diff: InventoryDiff): string[] {
  const lines: string[] = [];
  if (diff.residue.length === 0) {
    lines.push("  untangle: CLEAN — nothing the install-time inventory named is left on disk");
  } else {
    lines.push(`  untangle: ${diff.residue.length} path(s) NOT removed (arc#401 D6):`);
    for (const row of diff.residue) {
      lines.push(`    ✗ ${row.member} [${row.kind}] ${row.path}`);
    }
  }
  if (diff.retained.length > 0) {
    lines.push(
      `    · ${diff.retained.length} path(s) retained by design — they belong to a member another referent still needs:`,
    );
    for (const row of diff.retained) {
      lines.push(`        ${row.member} [${row.kind}] ${row.path}`);
    }
  }
  // F9 — the two user-data lines describe OPPOSITE SIDES of the purge, and the
  // wording says which. `formatPurge` prints the DECLARED plan line before
  // anything is deleted (from the owns declaration, whether or not the path
  // exists); this one is the post-purge check, and it appears only for paths
  // arc went back and found. A declared path with nothing on disk is named
  // above and absent here, which is correct and not a discrepancy.
  for (const row of diff.refusals) {
    lines.push(`    · verified still present after purge (user data): ${row.path}`);
  }
  return lines;
}
