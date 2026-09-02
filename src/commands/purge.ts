/**
 * `arc purge <name>` (arc#359) — apt-get purge for arc.
 *
 * `arc remove` tears down everything ARC installed. `arc purge` runs remove,
 * then deletes the runtime-created state the PACKAGE declared it `owns` —
 * finishing the reset a field tester currently does by hand with ~10 `rm`s (one
 * of them destructive). The never-touch rule is load-bearing: `owns.userData`
 * (the workspace) is NAMED and KEPT, never deleted — the apt `/home` guarantee.
 *
 * Flow (v1, per the baked design):
 *   0. Require the package be installed — the manifest IS the source of the owns
 *      declaration; arc keeps no dpkg-style 'rc' state after remove.
 *   1. Snapshot owns + the `scripts.purge` hook BEFORE remove() deletes the repo.
 *   2. remove()  — reuse it verbatim (never fork the teardown logic; cascade,
 *      refcounting, hooks all come along).
 *   3. Delete owns.config + owns.state (glob-expanded, symlink-safe).
 *   4. Run scripts.purge (from the snapshot) — non-declarable cleanup like
 *      `systemctl --user disable --now 'cortex@*'`. Non-aborting.
 *
 *      CONTRACT (arc#372): the snapshot preserves the hook's OWN containing
 *      directory subtree (the package's `scripts/` dir), not just the single
 *      file, so a multi-file purge hook may `source` its own siblings — e.g.
 *      `source "$(dirname "$0")/lib/purge-supervision.sh"`. A hook may assume
 *      only its own `scripts/` subtree is present at run time; anything it
 *      references OUTSIDE that subtree is gone (remove() already deleted the
 *      repo) and will fail — that boundary is intentional and unchanged. A hook
 *      that sits at the repo ROOT (no containing subdir) gets ONLY itself
 *      snapshotted; arc never copies the whole repo.
 *   5. Clear the package's `arc secrets` namespace.
 *   6. Name every owns.userData path as KEPT.
 *
 * `--dry-run` returns the full plan and mutates NOTHING (also used by the CLI to
 * render the confirmation preview). `--yes` runs non-interactively.
 */

import { basename, dirname, isAbsolute, join, normalize, sep } from "path";
import { homedir, tmpdir, userInfo } from "os";
import { existsSync } from "fs";
import { mkdtemp, rm, writeFile, chmod, readFile, cp } from "fs/promises";
import type { Database } from "bun:sqlite";
import type { ArcManifest, ArcPaths, HostAdapter, OwnsDeclaration } from "../types.js";
import {
  compositionInventory,
  compositionMembers,
  compositionRecord,
  compositionsReferencing,
  getSkill,
  removeComposition,
  type CompositionMemberRow,
  type CompositionStatus,
} from "../lib/db.js";
import {
  diffCompositionInventory,
  formatInventoryDiff,
  type InventoryDiff,
} from "../lib/composition-inventory.js";
import { readManifest } from "../lib/manifest.js";
import { packagesRequiring, remove, type RemoveResult } from "./remove.js";
import { runScript } from "../lib/scripts.js";
import {
  type SecretBackend,
  type SecretBackendChoice,
  normalizeDeclaredSecrets,
  resolveSecretBackend,
  SecretListUnsupportedError,
} from "../lib/secrets.js";
import { type SystemctlRunner } from "../lib/hosts/systemd-install.js";
import { type HostOverrides } from "../lib/hosts/registry.js";
import {
  type OwnsClass,
  type DeleteStatus,
  expandOwnsEntry,
  deleteOwnedPath,
  hasOwns,
  pathLiveness,
} from "../lib/owns.js";
import { errorMessage } from "../lib/errors.js";

/** One config/state path acted on (or planned). */
export interface PurgeDeletion {
  class: OwnsClass;
  entry: string;
  path: string;
  /** "planned"/"absent" in a dry run; the real outcome otherwise. */
  status: DeleteStatus | "planned";
  detail?: string;
}

/** One userData entry — NAMED, never deleted. */
export interface PurgeKept {
  entry: string;
  paths: string[];
}

export type PurgeScriptOutcome = "none" | "absent" | "ran" | "failed";

export interface PurgeResult {
  success: boolean;
  name?: string;
  error?: string;
  dryRun?: boolean;
  /** The reused remove() result (cascade, retained, …). Absent on a dry run. */
  removed?: RemoveResult;
  /** config/state deletions (or the plan, on a dry run). */
  deletions: PurgeDeletion[];
  /** userData kept, with a reason. */
  keptUserData: PurgeKept[];
  /** Secret NAMES cleared from the package's namespace (never values). */
  secretsCleared: string[];
  /** scripts.purge outcome. */
  purgeScript: PurgeScriptOutcome;
  /** Cascaded dependency names that THEMSELVES declare owns (dep-purge is out of
   *  v1 scope — surfaced so the operator can purge them explicitly). */
  cascadedOwns: string[];
  /** arc#401 D6 — present only when the purged package is a COMPOSITION. */
  composition?: CompositionPurgeReport;
}

/** A composition member left in place, and every referent that kept it. */
export interface RetainedMember {
  name: string;
  /** Why it stayed — other compositions, other requirers, or a prior install. */
  referents: string[];
}

/** What `arc purge <factory>` did to the composition as a whole (arc#401 D6). */
export interface CompositionPurgeReport {
  /** The record's status when the purge started — `pending` is the interrupted install. */
  status: CompositionStatus;
  /** Members taken down, in teardown order. */
  purged: string[];
  /** Members refcounting kept, each with the referents that kept it. */
  retained: RetainedMember[];
  /** Members whose own purge failed. Best-effort, per arc#348/#349 — never fatal. */
  failed: { name: string; error: string }[];
  /**
   * The D6 verdict: the install-time inventory snapshot re-checked against the
   * machine. `residue` empty and `refusals` naming only user data IS the
   * acceptance criterion. On a dry run this is the CURRENT state (nothing has
   * been removed yet), which is what makes the plan honest about what is there.
   */
  diff: InventoryDiff;
  /** True when no snapshot was recorded (a pre-arc#401 install, or an interrupted one). */
  snapshotMissing: boolean;
}

export interface PurgeOptions {
  /** Non-interactive (the CLI skips its confirm prompt). Passed through to remove(). */
  yes?: boolean;
  /** Compute + return the full plan; mutate NOTHING. */
  dryRun?: boolean;
  /** Suppress informational output on the reused remove() path. */
  quiet?: boolean;
  /** Pass-through to remove()'s dependency cascade (arc#348). */
  keepDeps?: boolean;
  /** Home root for `~`-rooted owns expansion. Defaults to `homedir()`. */
  home?: string;
  /** Secret backend choice (auto|keychain|file). Ignored when `makeSecretBackend` is set. */
  secretBackend?: SecretBackendChoice;
  /** Test seam: build the secret backend for `agent`. Defaults to `resolveSecretBackend`. */
  makeSecretBackend?: (agent: string) => SecretBackend;
  /** Pass-through to remove() (linux-systemd teardown). */
  systemctlRunner?: SystemctlRunner;
  /** Pass-through to remove() (multi-target host overrides). */
  hostOverrides?: HostOverrides;
  /**
   * Internal (arc#401): purge ONLY this package, never its composition cascade.
   * Set by `purgeComposition` when it purges the factory's own package, so the
   * dispatch below cannot re-enter. Not a public flag.
   */
  _skipComposition?: boolean;
}

/**
 * Purge an installed package. See the module header for the flow.
 */
export async function purge(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: PurgeOptions = {},
): Promise<PurgeResult> {
  const home = opts.home ?? homedir();

  // arc#401 D3/D6 — a COMPOSITION purges as a whole: the factory, then every
  // member it owns exclusively, refcounted per arc#349. Dispatched here rather
  // than in the CLI so `arc remove --purge <factory>` and every direct caller
  // get the cascade too; there is one purge, not two.
  if (!opts._skipComposition && compositionRecord(db, name)) {
    return purgeComposition(db, arc, host, name, opts);
  }

  const skill = getSkill(db, name);
  if (!skill) {
    return {
      success: false,
      name,
      error:
        `'${name}' is not installed; purge requires the manifest — remove leftovers ` +
        `manually or reinstall first (arc keeps no post-remove 'rc' state).`,
      deletions: [],
      keptUserData: [],
      secretsCleared: [],
      purgeScript: "none",
      cascadedOwns: [],
    };
  }

  const manifest = await readManifest(skill.install_path).catch(() => null);
  const owns = manifest?.owns;

  // Build the plan up front (both dry-run and real paths need it, and the
  // snapshot must happen while the repo is still on disk).
  const plannedDeletions = planDeletions(owns, home);
  const keptUserData = planUserData(owns, home);

  if (opts.dryRun) {
    return {
      success: true,
      name,
      dryRun: true,
      deletions: plannedDeletions.map((d) => ({
        ...d,
        status: d.liveness === "present" ? ("planned" as const) : ("absent" as const),
      })),
      keptUserData,
      secretsCleared: declaredSecretNames(manifest),
      purgeScript: purgeScriptState(manifest, skill.install_path),
      cascadedOwns: [],
    };
  }

  // Snapshot scripts.purge BEFORE remove() deletes the repo. We run it AFTER
  // owns deletion (per the design), so copy it out to a temp file first.
  const scriptSnapshot = await snapshotPurgeScript(manifest, skill.install_path);

  // Reuse remove() — do NOT fork its logic.
  const removed = await remove(db, arc, host, name, {
    yes: opts.yes,
    quiet: opts.quiet,
    keepDeps: opts.keepDeps,
    systemctlRunner: opts.systemctlRunner,
    hostOverrides: opts.hostOverrides,
  });
  if (!removed.success) {
    if (scriptSnapshot) await rm(scriptSnapshot.dir, { recursive: true, force: true }).catch(() => {/* best-effort cleanup; nothing to recover */});
    return {
      success: false,
      name,
      error: `remove failed during purge: ${removed.error ?? "unknown error"}`,
      removed,
      deletions: [],
      keptUserData,
      secretsCleared: [],
      purgeScript: "none",
      cascadedOwns: [],
    };
  }

  // (a) Delete owns.config + owns.state.
  const deletions: PurgeDeletion[] = [];
  for (const cls of ["config", "state"] as const) {
    for (const entry of owns?.[cls] ?? []) {
      const matches = expandOwnsEntry(entry, home);
      if (matches.length === 0) {
        deletions.push({ class: cls, entry, path: join(home, entry.replace(/^~\//, "")), status: "absent" });
        continue;
      }
      for (const match of matches) {
        const outcome = await deleteOwnedPath(match, home);
        deletions.push({ class: cls, entry, path: outcome.path, status: outcome.status, detail: outcome.detail });
      }
    }
  }

  // (b) scripts.purge — after deletion, non-aborting.
  let purgeScript: PurgeScriptOutcome = "none";
  if (scriptSnapshot) {
    const result = runScript({
      installPath: scriptSnapshot.dir,
      scriptPath: scriptSnapshot.scriptRel,
      hookName: "purge",
      quiet: opts.quiet ?? opts.yes,
    });
    purgeScript = result.success ? "ran" : "failed";
    if (!result.success && !opts.quiet) {
      process.stderr.write(`  ⚠ scripts.purge exited ${result.exitCode}; continuing purge anyway\n`);
    }
    await rm(scriptSnapshot.dir, { recursive: true, force: true }).catch(() => {/* best-effort cleanup; nothing to recover */});
  } else if (manifest?.scripts?.purge) {
    purgeScript = "absent"; // declared but the script file was not on disk
  }

  // (c) Clear the package's arc secrets namespace.
  const secretsCleared = await clearSecrets(name, arc, manifest, opts);

  // (d) Cascade note: name any cascaded dep that itself declares owns.
  const cascadedOwns = (removed.cascaded ?? [])
    .filter((c) => c.success && hasOwns(c.owns))
    .map((c) => c.name ?? "")
    .filter(Boolean);

  return {
    success: true,
    name,
    removed,
    deletions,
    keptUserData,
    secretsCleared,
    purgeScript,
    cascadedOwns,
  };
}

/**
 * Purge a whole COMPOSITION (arc#401, `docs/design-factory-type.md` D3/D6).
 *
 * D6 is the non-negotiable inherited from arc#365: install is a reversible
 * decision. So this is the mirror image of the composition install — the
 * factory's own package, every member it exclusively owns, every symlink, every
 * declared config/state — with user data refused BY NAME exactly as a
 * single-package purge refuses it (that rule lives in `planUserData` and is not
 * re-implemented here). The proof is mechanical: the install-time inventory
 * snapshot is re-checked against the machine afterwards and the diff must be
 * empty except those refusals.
 *
 * ## Order, and why it is this order
 *
 *  1. READ the record and the snapshot INTO MEMORY. Removing the factory's
 *     package deletes the composition header, and membership + inventory
 *     cascade off it — so anything not read first is unrecoverable, including
 *     the very snapshot the verification needs.
 *  2. PURGE THE FACTORY'S OWN PACKAGE. This is what takes the record with it,
 *     which is exactly what the refcount below needs: after it, "another
 *     composition references this member" can no longer mean *this* one.
 *     Mirrors arc#348's precondition ("call AFTER the parent's DB row is
 *     deleted so the parent is naturally excluded from the denominator").
 *  3. CASCADE to members in REVERSE declaration order — install lands them in
 *     order, teardown reverses it, the same discipline `removePerTarget` keeps
 *     for hosts. Each member is purged in full (`purge` recursing, so its own
 *     owns/secrets/hooks all come along) or RETAINED with its referents named.
 *  4. DIFF the in-memory snapshot against the machine.
 *
 * ## The interrupted install
 *
 * A `pending` composition has landed members and NO `skills` row for the
 * factory — the install died between the two. `arc purge <factory>` is the way
 * to clean that up: the landed members are cascaded (refcounted, exactly as
 * above — an interrupted install's members can be shared too), and the pending
 * record is dropped. Without this, the debris is unreachable: `arc purge` used
 * to refuse ("not installed") on the one name that could name it, and the
 * members look like ordinary standalone packages. This is D6 serving the case
 * D6 exists for.
 *
 * ## Best-effort, per arc#348/#349
 *
 * A member whose purge fails is REPORTED (`failed`) and does not fail the
 * composition: the factory is already down, and refusing to continue would
 * leave the rest of the composition installed with no record tying it together.
 * The diff then shows what is still there, which is the actionable form of the
 * same news.
 */
async function purgeComposition(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: PurgeOptions,
): Promise<PurgeResult> {
  const home = opts.home ?? homedir();
  const record = compositionRecord(db, name);
  // Unreachable — the caller checked. Narrowed rather than asserted.
  if (!record) {
    return purge(db, arc, host, name, { ...opts, _skipComposition: true });
  }

  // 1. Everything the teardown will destroy, read first.
  const members = compositionMembers(db, name);
  const snapshot = compositionInventory(db, name);

  // Teardown order: reverse of the order they landed in.
  const teardownOrder = [...members].reverse();

  const verdict = (retainedNames: readonly string[]): InventoryDiff =>
    diffCompositionInventory(snapshot, {
      home,
      settingsPath: host.paths.settingsPath,
      // W2 — a member refcounting KEPT is not a leak. Its paths are classified
      // `retained`, so correct refcounting cannot render as a failed untangle.
      retainedMembers: retainedNames,
    });

  if (opts.dryRun) {
    const plan = await planMemberDispositions(db, name, teardownOrder, record.started_at);
    const memberPlans: PurgeResult[] = [];
    for (const member of plan.purgeable) {
      memberPlans.push(await purge(db, arc, host, member, { ...opts, _skipComposition: true }));
    }
    const factoryPlan = getSkill(db, name)
      ? await purge(db, arc, host, name, { ...opts, _skipComposition: true })
      : null;
    return {
      success: true,
      name,
      dryRun: true,
      // The union of what every purgeable member and the factory would delete /
      // keep — a plan that named only the factory's own paths would understate
      // a composition purge by everything that matters.
      deletions: [...memberPlans.flatMap((p) => p.deletions), ...(factoryPlan?.deletions ?? [])],
      keptUserData: [
        ...memberPlans.flatMap((p) => p.keptUserData),
        ...(factoryPlan?.keptUserData ?? []),
      ],
      secretsCleared: [
        ...memberPlans.flatMap((p) => p.secretsCleared),
        ...(factoryPlan?.secretsCleared ?? []),
      ],
      purgeScript: factoryPlan?.purgeScript ?? "none",
      cascadedOwns: [],
      composition: {
        status: record.status,
        purged: plan.purgeable,
        retained: plan.retained,
        failed: [],
        diff: verdict(plan.retained.map((r) => r.name)),
        snapshotMissing: snapshot.length === 0,
      },
    };
  }

  // 2. THE MEMBERS FIRST (arc#401 review, F5).
  //
  // The first cut took the factory down first, which deleted the composition
  // record with it (`removeSkill` drops the header; membership and inventory
  // cascade). A process killed between that and the member cascade left the
  // members installed and UNREACHABLE: the only name that could resume the
  // cascade now answered "not installed", so `arc purge <factory>` — the
  // command whose entire purpose is untangling — had a window where it created
  // exactly the orphan state it exists to prevent. Reproduced (R5).
  //
  // Members first means the record survives until the last thing that needs it
  // is done, so a killed purge is RESUMABLE by the same name. `memberReferents`
  // never depended on the record already being gone (it excludes this
  // composition explicitly rather than relying on the row's absence), so the
  // refcount is unaffected by the reordering.
  const purged: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const retained: RetainedMember[] = [];
  const deletions: PurgeDeletion[] = [];
  const keptUserData: PurgeKept[] = [];
  const secretsCleared: string[] = [];

  for (const member of teardownOrder) {
    const referents = await memberReferents(db, name, member, record.started_at);
    if (referents.length > 0) {
      retained.push({ name: member.member_name, referents });
      continue;
    }
    if (!getSkill(db, member.member_name)) continue; // never landed, or already gone

    const result = await purge(db, arc, host, member.member_name, {
      ...opts,
      _skipComposition: true,
    });
    if (!result.success) {
      failed.push({ name: member.member_name, error: result.error ?? "unknown error" });
      continue;
    }
    purged.push(member.member_name);
    deletions.push(...result.deletions);
    keptUserData.push(...result.keptUserData);
    secretsCleared.push(...result.secretsCleared);
  }

  // 3. THE FACTORY LAST — and with it the record. A `pending` composition has
  //    no package of its own (the install died before its row committed), so
  //    drop the record explicitly; membership and inventory cascade off it.
  let factoryResult: PurgeResult | null = null;
  if (getSkill(db, name)) {
    factoryResult = await purge(db, arc, host, name, { ...opts, _skipComposition: true });
    if (!factoryResult.success) {
      // The members are down and the record is still here, so the operator can
      // re-run the same name to finish. Reported, not fatal to what succeeded.
      return {
        ...factoryResult,
        deletions,
        keptUserData,
        secretsCleared,
        composition: {
          status: record.status,
          purged,
          retained,
          failed,
          diff: verdict(retained.map((r) => r.name)),
          snapshotMissing: snapshot.length === 0,
        },
      };
    }
    deletions.push(...factoryResult.deletions);
    keptUserData.push(...factoryResult.keptUserData);
    secretsCleared.push(...factoryResult.secretsCleared);
  } else {
    removeComposition(db, name);
  }

  // 4. The D6 verdict.
  return {
    success: true,
    name,
    ...(factoryResult?.removed ? { removed: factoryResult.removed } : {}),
    deletions,
    keptUserData,
    secretsCleared,
    purgeScript: factoryResult?.purgeScript ?? "none",
    cascadedOwns: factoryResult?.cascadedOwns ?? [],
    composition: {
      status: record.status,
      purged,
      retained,
      failed,
      diff: verdict(retained.map((r) => r.name)),
      snapshotMissing: snapshot.length === 0,
    },
  };
}

/**
 * Is a member EXCLUSIVELY OWNED by the composition being purged — and if not,
 * what keeps it? (arc#401 D3, mirroring arc#349's discipline.)
 *
 * Three referent classes, all computed from DB TRUTH, all fail-SAFE (an
 * unanswerable question RETAINS the member — removal is destructive and hard to
 * undo, so the bias runs one way):
 *
 *  1. ANOTHER COMPOSITION lists it. Including a `pending` one: an interrupted
 *     install is a referent whose members may yet be resumed, and taking one
 *     out from under it would turn a recoverable half-install into a broken
 *     one. This is `arc#349`'s shared-dependency rule with `composition_members`
 *     as the register instead of `depends_on.packages`.
 *  2. ANOTHER ACTIVE PACKAGE declares it in `depends_on.packages` — literally
 *     arc#349's own denominator, reused rather than re-derived
 *     (`packagesRequiring`, which counts a package whose manifest cannot be
 *     read as a possible requirer).
 *  3. THE OPERATOR INSTALLED IT FIRST (`state: 'preexisting'`, recorded at
 *     install — see `markCompositionMemberLanded`). Undoing the composition's
 *     install decision must not undo a decision the operator made separately;
 *     composition.ts already takes exactly this posture on the install side,
 *     where a surface drift against an already-installed member is a warning
 *     rather than a refusal, "because that install was consented to separately
 *     and this composition did not put it there".
 *
 * Returns the referent descriptions (empty ⇒ exclusively owned ⇒ purge it).
 */
async function memberReferents(
  db: Database,
  compositionName: string,
  member: CompositionMemberRow,
  startedAt?: string,
): Promise<string[]> {
  const referents: string[] = [];

  for (const other of compositionsReferencing(db, member.member_name, {
    exclude: compositionName,
  })) {
    referents.push(`${other} (composition member)`);
  }

  for (const requirer of await packagesRequiring(db, member.member_name)) {
    referents.push(`${requirer} (depends_on.packages)`);
  }

  if (member.state === "preexisting") {
    referents.push(
      `already installed before '${compositionName}' — the composition did not put it here`,
    );
  }

  // A row still `pending` was never confirmed by this composition: the install
  // was killed between opening the record and marking the member, so the one
  // fact that decides this — did WE put it here — was never written.
  //
  // `preexisting` normally answers that, and arc#401's review closed the
  // rewrite window that used to erase it (`replaceCompositionRecord`, F3). This
  // is the remaining case, and it has no recorded answer at all, so fall back to
  // the only evidence left: a package installed BEFORE this composition's record
  // was opened cannot have been installed by it. Timestamps are too weak to
  // carry the general predicate (`beginComposition` re-stamps `started_at` on
  // every re-run, which is why the state column exists) — but they are strictly
  // better than nothing, and they fail in the RETAIN direction, which is the
  // one arc#349 says to fail in. The cost is that a resumed install's own
  // members may be retained by a later purge of the pending record; the
  // alternative is deleting a package the operator installed by hand.
  if (member.state === "pending") {
    const installed = getSkill(db, member.member_name);
    if (installed && startedAt && installed.installed_at && installed.installed_at < startedAt) {
      referents.push(
        `installed before '${compositionName}' opened its record, which never confirmed the member (interrupted install) — refusing to assume the composition put it here`,
      );
    }
  }

  return referents;
}

/**
 * Who goes, who stays, and why — the shared walk behind both the dry-run plan
 * and the real cascade, so the preview an operator confirms can never disagree
 * with what then happens.
 *
 * Safe to run BEFORE the factory's record is torn down (the dry-run case)
 * because {@link memberReferents} excludes the composition being purged from
 * its own denominator, rather than relying on the row already being gone.
 */
async function planMemberDispositions(
  db: Database,
  compositionName: string,
  members: readonly CompositionMemberRow[],
  startedAt?: string,
): Promise<{ purgeable: string[]; retained: RetainedMember[] }> {
  const purgeable: string[] = [];
  const retained: RetainedMember[] = [];
  for (const member of members) {
    const referents = await memberReferents(db, compositionName, member, startedAt);
    if (referents.length > 0) retained.push({ name: member.member_name, referents });
    else if (getSkill(db, member.member_name)) purgeable.push(member.member_name);
  }
  return { purgeable, retained };
}

/** Config/state entries expanded, each carrying present/absent liveness. */
function planDeletions(
  owns: OwnsDeclaration | undefined,
  home: string,
): { class: OwnsClass; entry: string; path: string; liveness: "present" | "absent" }[] {
  const out: { class: OwnsClass; entry: string; path: string; liveness: "present" | "absent" }[] = [];
  for (const cls of ["config", "state"] as const) {
    for (const entry of owns?.[cls] ?? []) {
      const matches = expandOwnsEntry(entry, home);
      if (matches.length === 0) {
        out.push({ class: cls, entry, path: join(home, entry.replace(/^~\//, "")), liveness: "absent" });
        continue;
      }
      for (const path of matches) out.push({ class: cls, entry, path, liveness: pathLiveness(path) });
    }
  }
  return out;
}

/** userData entries expanded — never deleted, always named. */
function planUserData(owns: OwnsDeclaration | undefined, home: string): PurgeKept[] {
  return (owns?.userData ?? []).map((entry) => {
    const matches = expandOwnsEntry(entry, home);
    return { entry, paths: matches.length > 0 ? matches : [join(home, entry.replace(/^~\//, ""))] };
  });
}

function declaredSecretNames(manifest: ArcManifest | null): string[] {
  return normalizeDeclaredSecrets(manifest?.capabilities?.secrets).map((d) => d.name);
}

function purgeScriptState(manifest: ArcManifest | null, installPath: string): PurgeScriptOutcome {
  const rel = manifest?.scripts?.purge;
  if (!rel) return "none";
  return existsSync(join(installPath, rel)) ? "ran" : "absent"; // dry-run: "ran" reads as "would run"
}

/**
 * Snapshot scripts.purge to a temp dir so it survives remove() deleting the
 * repo (arc#359, arc#372). Returns null when no purge script is declared or the
 * file is missing.
 *
 * arc#372: we copy the hook's CONTAINING directory subtree (the package's
 * `scripts/` dir) — preserving the hook's relative layout — so a multi-file
 * purge hook can `source` its own siblings (e.g. `lib/purge-supervision.sh`).
 * `runScript` runs `bash <dir>/<scriptRel>` with `cwd = <dir>`, mirroring the
 * repo-root-as-cwd contract every other lifecycle hook runs under, so a hook
 * that resolves siblings via `$(dirname "$0")/…` finds them.
 *
 * Bounded on purpose:
 *  - The copy is the hook's containing dir subtree, NOT the whole repo. A hook
 *    whose declared path sits at the repo root (`dirname` is `.`) — or resolves
 *    to an absolute / repo-escaping path — falls back to a single-file copy;
 *    arc never snapshots the entire repo.
 *  - Symlinks inside the subtree are copied as symlinks (not dereferenced), so
 *    a link that points OUTSIDE the subtree dangles once remove() deletes the
 *    repo — preserving the "references beyond its own scripts dir still fail"
 *    boundary.
 *
 * `scriptRel` is the hook path RELATIVE to the returned `dir` (e.g.
 * `scripts/purge.sh`, or just `purge.sh` on the root/fallback path).
 */
async function snapshotPurgeScript(
  manifest: ArcManifest | null,
  installPath: string,
): Promise<{ dir: string; scriptRel: string } | null> {
  const rel = manifest?.scripts?.purge;
  if (!rel) return null;
  const src = join(installPath, rel);
  if (!existsSync(src)) return null;

  const dir = await mkdtemp(join(tmpdir(), "arc-purge-"));

  // The hook's containing directory, relative to the repo root. `normalize`
  // strips a leading `./` so `./scripts/purge.sh` → `scripts/purge.sh`.
  const relNorm = normalize(rel);
  const scriptDirRel = dirname(relNorm);

  // Root-level or escaping hook: snapshot ONLY the single file. Never copy the
  // whole repo, and never reach outside it.
  const isRepoRoot = scriptDirRel === "." || scriptDirRel === "";
  const escapes =
    isAbsolute(relNorm) || relNorm === ".." || relNorm.startsWith(".." + sep);
  if (isRepoRoot || escapes) {
    const name = basename(relNorm);
    const dest = join(dir, name);
    await writeFile(dest, await readFile(src));
    await chmod(dest, 0o755).catch(() => {/* best-effort; a non-exec bit only affects bash-invoked hooks, which we run via `bash <path>` regardless */});
    return { dir, scriptRel: name };
  }

  // Copy the hook's containing subtree, preserving relative layout. `cp` with
  // recursive keeps symlinks verbatim (dereference defaults to false).
  const srcDir = join(installPath, scriptDirRel);
  const destDir = join(dir, scriptDirRel);
  await cp(srcDir, destDir, { recursive: true });
  await chmod(join(dir, relNorm), 0o755).catch(() => {/* best-effort; see above */});
  return { dir, scriptRel: relNorm };
}

/**
 * Clear the package's `arc secrets` namespace.
 *
 * Mechanism: the store is per-package namespaced. FileBackend keeps
 * `<secretsDir>/<agent>/<NAME>` and `list()` enumerates it; KeychainBackend keys
 * on `ai.meta-factory.cortex.<agent>.<NAME>` and CANNOT enumerate (throws
 * SecretListUnsupportedError). So: enumerate via `list()` when supported, else
 * fall back to the manifest-declared names, and `remove()` each — then sweep the
 * now-empty FileBackend agent dir. Values never touched, never logged.
 */
async function clearSecrets(
  name: string,
  arc: ArcPaths,
  manifest: ArcManifest | null,
  opts: PurgeOptions,
): Promise<string[]> {
  const backend =
    opts.makeSecretBackend?.(name) ??
    resolveSecretBackend(name, {
      platform: process.platform,
      secretsRoot: arc.secretsDir,
      username: currentUsername(),
      backendChoice: opts.secretBackend,
    });

  let names: string[];
  try {
    names = await backend.list();
  } catch (err) {
    if (err instanceof SecretListUnsupportedError) {
      // Keychain can't enumerate — clear the manifest-declared names instead.
      names = declaredSecretNames(manifest);
    } else {
      if (!opts.quiet) process.stderr.write(`  ⚠ could not enumerate secrets for '${name}': ${errorMessage(err)}\n`);
      names = declaredSecretNames(manifest);
    }
  }

  const cleared: string[] = [];
  for (const secret of names) {
    try {
      await backend.remove(secret);
      cleared.push(secret);
    } catch (err) {
      if (!opts.quiet) process.stderr.write(`  ⚠ could not clear secret '${secret}': ${errorMessage(err)}\n`);
    }
  }

  // Sweep the now-empty FileBackend agent dir so the namespace is fully gone.
  // No-op for the Keychain / injected backends (the dir won't exist).
  const agentDir = join(arc.secretsDir, name);
  if (existsSync(agentDir)) await rm(agentDir, { recursive: true, force: true }).catch(() => {/* best-effort cleanup; nothing to recover */});

  return cleared;
}

function currentUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return homedir().split("/").filter(Boolean).pop() ?? "user";
  }
}

/** Human-readable purge report. */
export function formatPurge(result: PurgeResult): string {
  if (!result.success && result.error) return `Error: ${result.error}`;

  const lines: string[] = [];
  const composition = result.composition;
  const head = result.dryRun
    ? `Purge plan for '${result.name}'${composition ? " and its composition" : ""} (dry run — nothing deleted):`
    : `Purged '${result.name}':`;
  lines.push(head);

  // arc#401 D3 — the cascade, before the path-level detail: an operator
  // confirming a composition purge needs to know which PACKAGES go first.
  if (composition) {
    if (composition.status === "pending") {
      lines.push(
        `  composition: INTERRUPTED install (pending) — cleaning up the members that landed`,
      );
    }
    const verb = result.dryRun ? "would purge" : "purged";
    lines.push(
      composition.purged.length > 0
        ? `  members ${verb}: ${composition.purged.join(", ")}`
        : `  members ${verb}: (none — every member is still referenced)`,
    );
    for (const kept of composition.retained) {
      lines.push(`  kept (still referenced): ${kept.name} — ${kept.referents.join("; ")}`);
    }
    for (const failure of composition.failed) {
      lines.push(`  ⚠ member '${failure.name}' failed to purge: ${failure.error}`);
    }
  }

  if (result.deletions.length === 0) {
    lines.push("  config/state: (nothing declared)");
  } else {
    lines.push("  config/state:");
    for (const d of result.deletions) {
      const verb =
        d.status === "planned" ? "would delete"
        : d.status === "deleted" ? "deleted"
        : d.status === "deleted-symlink" ? "deleted (symlink)"
        : d.status === "absent" ? "absent"
        : d.status === "refused-escape" ? `REFUSED (${d.detail ?? "escapes home"})`
        : `error (${d.detail ?? "?"})`;
      lines.push(`    ${verb}: ${d.path}`);
    }
  }

  // F9 — this is the DECLARED plan, read from `owns.userData` and printed
  // whether or not the path exists. The untangle block below re-checks the same
  // paths AFTER the purge and names only the ones actually found, so a declared
  // path with nothing on disk appears here and not there. Two lines, two sides
  // of the purge; the wording says which, so the asymmetry reads as the record
  // it is rather than as a discrepancy.
  for (const k of result.keptUserData) {
    for (const p of k.paths) {
      lines.push(`  kept (declared user data): ${p} — yours, arc will not touch it`);
    }
  }

  if (result.secretsCleared.length > 0) {
    lines.push(`  secrets cleared: ${result.secretsCleared.join(", ")}`);
  }

  if (result.purgeScript === "ran") lines.push("  scripts.purge: ran");
  else if (result.purgeScript === "failed") lines.push("  scripts.purge: FAILED (see warning above)");
  else if (result.purgeScript === "absent") lines.push("  scripts.purge: declared but not found on disk");

  for (const dep of result.cascadedOwns) {
    lines.push(`  note: cascaded dependency '${dep}' also declares owns — purge it explicitly with \`arc purge ${dep}\``);
  }

  // arc#401 D6 — the untangle verdict, last, because it is the conclusion the
  // rest of the report supports. Suppressed on a dry run: there the diff
  // describes what is on disk NOW, which would read as a list of failures for a
  // purge that has not run yet.
  if (composition && !result.dryRun) {
    if (composition.snapshotMissing) {
      lines.push(
        `  untangle: NOT VERIFIED — no install-time inventory was recorded for '${result.name}' ` +
          `(installed before arc#401, or the install was interrupted before the snapshot)`,
      );
    } else {
      lines.push(...formatInventoryDiff(composition.diff));
    }
  }

  return lines.join("\n");
}
