import { join, relative, isAbsolute } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { rm, lstat, readlink, unlink } from "fs/promises";
import type { Database } from "bun:sqlite";
import type {
  ArcManifest,
  ArcPaths,
  HostAdapter,
  HostId,
  OwnsDeclaration,
} from "../types.js";
import { hasOwns, purgeableEntries, expandOwnsEntry, pathLiveness } from "../lib/owns.js";
import { getSkill, removeSkill, listByLibrary, listSkills } from "../lib/db.js";
import { removeSymlink, removeCliShim, extractAllCliInfo } from "../lib/symlinks.js";
import { resolveProvidesTarget } from "../lib/provides-target.js";
import { readManifest } from "../lib/manifest.js";
import { removeHooks } from "../lib/hooks.js";
import { findGitRoot } from "../lib/paths.js";
import { unwireExtensions } from "../lib/extensions.js";
import { runLifecycleScripts, runScript } from "../lib/scripts.js";
import { runSomaSkillProjection } from "../lib/soma-projection.js";
import {
  type HostOverrides,
  orderTargetsForInstall,
  resolveHost,
} from "../lib/hosts/registry.js";
import { removeLaunchdArtifacts } from "../lib/hosts/launchd-install.js";
import { isDarwinLaunchdHost } from "../lib/hosts/darwin-launchd.js";
import { type SystemctlRunner, removeSystemdArtifacts } from "../lib/hosts/systemd-install.js";
import { isLinuxSystemdHost } from "../lib/hosts/linux-systemd.js";
import { errorMessage, isErrno } from "../lib/errors.js";

export interface RemoveResult {
  success: boolean;
  name?: string;
  error?: string;
  removedCount?: number;
  /**
   * Results of cascading the removal to this package's exclusively-owned
   * `depends_on.packages` (arc#348). Sibling of `UpgradeResult.cascaded`
   * (arc#347). Populated only when the package declared package dependencies
   * that were installed AND not still required by another active package. A
   * dependency that fails to remove lands here with success:false but does NOT
   * fail the parent (best-effort per-dep, same contract as the upgrade cascade).
   */
  cascaded?: RemoveResult[];
  /**
   * `depends_on.packages` that were NOT removed because another installed
   * package still requires them (shared-dependency refcounting, arc#348) —
   * surfaced so the operator sees what was kept and why. `requiredBy` lists
   * the other active packages that declare the dependency.
   */
  retained?: RetainedDependency[];
  /**
   * The removed package's `owns:` purge-scope declaration (arc#359), captured
   * from its manifest BEFORE the repo was deleted. Present only when the package
   * declared at least one owns entry. `arc remove` uses it to print a
   * "kept (config/state)" summary that names `arc purge <name>`; the removed
   * config/state trees are LEFT ON DISK by `remove` (it only tears down what arc
   * installed) — deleting them is `arc purge`'s job. Threading the declaration
   * out here means `remove` reads the manifest exactly once.
   */
  owns?: OwnsDeclaration;
}

/**
 * A `depends_on.packages` dependency left in place during a cascade removal
 * because it is still referenced by another installed package (arc#348).
 */
export interface RetainedDependency {
  name: string;
  requiredBy: string[];
}

export interface RemoveOptions {
  /** Suppress interactive prompts / informational output (arc#138). */
  yes?: boolean;
  /**
   * Suppress console output (for non-interactive / test use). Passed
   * through to lifecycle script runs.
   */
  quiet?: boolean;
  /**
   * Per-host adapter overrides for multi-target removes (arc#140 P5).
   * Mirrors `InstallOptions.hostOverrides`.
   */
  hostOverrides?: HostOverrides;
  /**
   * Injectable `systemctl --user` seam for linux-systemd removes (arc#311).
   * Mirrors `InstallOptions.systemctlRunner` — production leaves this
   * absent (real spawn); tests inject a recorder.
   */
  systemctlRunner?: SystemctlRunner;
  /**
   * Opt out of the `depends_on.packages` removal cascade (arc#348). By default
   * `arc remove <component>` also removes the component's exclusively-owned
   * package dependencies (those no other installed package still requires).
   * Set to `true` to remove only the named package and leave its dependencies
   * in place — the pre-arc#348 behaviour.
   */
  keepDeps?: boolean;
  /**
   * Internal: the set of package names already visited by the current remove
   * command (arc#348). Threads through the cascade so a shared dependency — or
   * a dependency cycle — is processed at most once, and the parent can never be
   * re-entered. Mirrors `upgradePackage`'s `_seen`. Not a public flag.
   */
  _seen?: Set<string>;
}

/**
 * Cascade a removal to a package's exclusively-owned `depends_on.packages`
 * (arc#348). Sibling of `cascadeDependencyUpgrades` (upgrade.ts, arc#347):
 * best-effort, per-dep, structured results.
 *
 * Shared-dependency refcounting: a declared dependency is removed ONLY IF no
 * OTHER active installed package still declares it in `depends_on.packages`.
 * An adapter a second component depends on — or one the user installed
 * independently and that another package now references — is RETAINED and
 * reported under `retained`.
 *
 * Preconditions / semantics:
 *  - Call AFTER the parent's DB row is deleted so the parent is naturally
 *    excluded from the refcount denominator.
 *  - Only deps that are installed + active + on-disk are considered (a missing
 *    or disabled dep is nothing to remove).
 *  - Refcount is computed from DB truth only: it counts every active package
 *    still in the DB except the dep itself. The parent and any successfully-
 *    removed deps are already gone from the DB so they don't self-count, while
 *    a still-installed FAILED sibling correctly counts (it still needs the dep).
 *  - `seen` is ONLY the cycle/recursion guard — it stops a dep already handled
 *    this command (shared deps, cycles) from being re-processed. It is NOT used
 *    in the refcount denominator.
 *  - Best-effort: a failed dep removal is RETURNED (success:false) under
 *    `cascaded` but never thrown — the parent removal still succeeds.
 */
async function cascadeDependencyRemovals(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  manifest: { depends_on?: { packages?: { name: string }[] } },
  seen: Set<string>,
  opts: RemoveOptions,
): Promise<{ cascaded: RemoveResult[]; retained: RetainedDependency[] }> {
  const cascaded: RemoveResult[] = [];
  const retained: RetainedDependency[] = [];

  for (const dep of manifest.depends_on?.packages ?? []) {
    if (seen.has(dep.name)) continue;

    const existing = getSkill(db, dep.name);
    // Only cascade to deps that are actually installed + active + on-disk.
    // A missing/disabled dep is nothing to remove.
    if (existing?.status !== "active" || !existsSync(existing.install_path)) {
      continue;
    }

    // Refcount: which OTHER active packages still declare this dep? Refcount is
    // computed from DB TRUTH only, NOT from `seen`. `seen` accumulates every dep
    // the cascade *attempts* to remove — including ones whose removal FAILED and
    // are therefore STILL installed; excluding those from the denominator would
    // undercount and wrongly drop a dep a still-installed sibling needs (the
    // failed-intermediate diamond: A→[B,X], B→X, B's teardown fails → X must
    // stay). The parent is `removeSkill`'d before the cascade and each
    // successfully-removed dep is gone from the DB before its own sub-cascade,
    // so neither self-counts; anything still in the DB legitimately counts.
    const requiredBy = await packagesRequiring(db, dep.name);
    if (requiredBy.length > 0) {
      retained.push({ name: dep.name, requiredBy });
      continue;
    }

    // Exclusively owned by the package being removed — cascade the removal.
    // Mark BEFORE the recursive call so a dep that (transitively) depends back
    // on this one can't re-enter and loop.
    seen.add(dep.name);
    cascaded.push(
      await remove(db, arc, host, dep.name, {
        yes: opts.yes,
        quiet: opts.quiet,
        hostOverrides: opts.hostOverrides,
        systemctlRunner: opts.systemctlRunner,
        _seen: seen,
      }),
    );
  }

  return { cascaded, retained };
}

/**
 * The names of active installed packages (other than `depName` itself) that
 * declare `depName` in their `depends_on.packages` (arc#348 refcount
 * denominator). Computed purely from DB truth — the caller must NOT pass an
 * exclude set, because a package still present in the DB (e.g. one whose cascade
 * removal FAILED) genuinely still needs the dep and must count.
 *
 * Fail-SAFE on an unreadable manifest: removal is destructive and hard to undo,
 * so a candidate package whose manifest can't be parsed is treated as a POSSIBLE
 * requirer and RETAINS the dep (counted under a `<name> (manifest unreadable)`
 * marker), rather than being assumed to need nothing. Better to leave a dep
 * installed than to orphan a package that actually depends on it.
 *
 * EXPORTED for arc#401's composition cascade, which asks the same question
 * about a composition member that this asks about a dependency. Re-deriving it
 * there would give arc two answers to "does anything still need this package",
 * and the one that governs would depend on which command the operator ran.
 */
export async function packagesRequiring(
  db: Database,
  depName: string,
): Promise<string[]> {
  const requiredBy: string[] = [];
  for (const pkg of listSkills(db)) {
    if (pkg.status !== "active") continue;
    if (pkg.name === depName) continue;
    if (!existsSync(pkg.install_path)) continue;
    const pkgManifest = await readManifest(pkg.install_path).catch(() => null);
    if (!pkgManifest) {
      // Manifest unreadable — cannot prove this package does NOT need the dep.
      // Fail safe: count it as a requirer so the dep is retained.
      requiredBy.push(`${pkg.name} (manifest unreadable)`);
      continue;
    }
    const declared = pkgManifest.depends_on?.packages ?? [];
    if (declared.some((d) => d.name === depName)) {
      requiredBy.push(pkg.name);
    }
  }
  return requiredBy;
}

/**
 * Run the preuninstall phase (arc#140 P5): `scripts.preuninstall` (single
 * script) first, then `lifecycle.preuninstall` (ordered array). The arc#140
 * design (cortex `docs/design-arc-agent-bots.md` §8.3) requires
 * preuninstall scripts to fire BEFORE any symlinks are removed — typical
 * sequence is launchctl unload → drain → signal cortex reload, all of
 * which need the agent fragment + binary still on disk.
 *
 * Symmetric to runPreinstallPhase / runPostinstallPhase in install.ts.
 * On any script failure the function returns the error string; caller
 * decides whether to abort the uninstall. Per the design doc's
 * D7 ("abort-on-revoke-failure"), arc remove aborts to avoid leaving
 * phantom state — the operator can investigate and retry.
 */
function runPreuninstallPhase(
  installPath: string,
  manifest: ArcManifest | null,
  quiet?: boolean,
): { success: true } | { success: false; error: string } {
  if (!manifest) return { success: true };

  const lifecycle = manifest.lifecycle?.preuninstall;
  if (lifecycle && lifecycle.length > 0) {
    const result = runLifecycleScripts({
      installPath,
      scriptPaths: lifecycle,
      phase: "preuninstall",
      quiet,
    });
    if (!result.success) {
      return {
        success: false,
        error: `Preuninstall lifecycle script failed: ${result.failedAt} (exit ${result.steps.at(-1)?.exitCode ?? "?"})`,
      };
    }
  }

  return { success: true };
}

/**
 * Run the postuninstall phase (arc#140 P5): `lifecycle.postuninstall`
 * (ordered array). Fires AFTER symlinks + plist + binary are removed,
 * so it's safe for scripts that signal cortex to re-read agents.d/
 * (which is now empty of this bot).
 *
 * Failures in postuninstall do NOT roll the uninstall back (the
 * artifacts are already gone) — they're surfaced to the operator
 * as warnings.
 */
function runPostuninstallPhase(
  installPath: string,
  manifest: ArcManifest | null,
  quiet?: boolean,
): { success: true } | { success: false; error: string } {
  if (!manifest) return { success: true };

  const lifecycle = manifest.lifecycle?.postuninstall;
  if (lifecycle && lifecycle.length > 0) {
    const result = runLifecycleScripts({
      installPath,
      scriptPaths: lifecycle,
      phase: "postuninstall",
      quiet,
    });
    if (!result.success) {
      return {
        success: false,
        error: `Postuninstall lifecycle script failed: ${result.failedAt} (exit ${result.steps.at(-1)?.exitCode ?? "?"})`,
      };
    }
  }

  return { success: true };
}

/**
 * Multi-target uninstall walk (arc#140 P5).
 *
 * Reverses the install ordering: supervision hosts (darwin-launchd,
 * linux-systemd) FIRST so the daemon stops and releases its NATS
 * connection BEFORE the registry-side fragment is removed (per cortex
 * `docs/design-arc-agent-bots.md` §8.3 "revoke creds BEFORE removing
 * files").
 *
 * For each target:
 *   - darwin-launchd → removeLaunchdArtifacts (plist + binary symlink)
 *   - linux-systemd → removeSystemdArtifacts (unit + binary symlink)
 *   - cortex / claude-code → remove the type-appropriate artifact
 *     symlink from that host's directory
 *
 * Errors are best-effort: a missing artifact on one target does not
 * abort the others. Non-ENOENT errors surface via console.warn.
 */
async function removePerTarget(opts: {
  targets: HostId[];
  manifest: ArcManifest;
  packageName: string;
  hostOverrides?: HostOverrides;
  quiet?: boolean;
  systemctlRunner?: SystemctlRunner;
}): Promise<void> {
  const reverseOrder = [...orderTargetsForInstall(opts.targets)].reverse();

  for (const targetId of reverseOrder) {
    const targetHost = resolveHost(targetId, opts.hostOverrides);

    if (targetId === "darwin-launchd") {
      // Sage P3 review (arc#143): type guard instead of blanket cast.
      if (!isDarwinLaunchdHost(targetHost)) {
        if (!opts.quiet) {
          console.warn(
            `  ⚠ Skipping darwin-launchd remove: adapter did not expose plistDir`,
          );
        }
        continue;
      }
      await removeLaunchdArtifacts({
        host: targetHost,
        manifest: opts.manifest,
        quiet: opts.quiet,
      });
      continue;
    }

    if (targetId === "linux-systemd") {
      // Sister to the darwin-launchd branch above (arc#311, L2).
      if (!isLinuxSystemdHost(targetHost)) {
        if (!opts.quiet) {
          console.warn(
            `  ⚠ Skipping linux-systemd remove: adapter did not expose unitDir`,
          );
        }
        continue;
      }
      // Root-cause fix (PR #314 review, BLOCKER): detect() gate, mirroring
      // the install-side guard — remove semantics differ though: install
      // FAILS the target outright (nothing mutated yet to clean up), but
      // remove must still tear down whatever IS on disk even with no
      // systemd user session to talk to (skipSystemctl: true — the unit
      // file + binary symlink still get deleted; only the doomed
      // disable/daemon-reload spawn attempts are skipped).
      const available = targetHost.detect();
      if (!available && !opts.quiet) {
        console.warn(
          `  ⚠ linux-systemd: no systemd user session detected on this host — removing unit file/symlink directly, skipping systemctl teardown`,
        );
      }
      // Defense in depth (PR #314 review, BLOCKER): removeSystemdArtifacts
      // itself no longer throws (every systemctl call is normalized
      // best-effort), but a throw here must NEVER abort the surrounding
      // `arc remove` before it reaches DB/repo cleanup — degrade to a
      // logged warning and keep going, same contract as every other
      // best-effort step in this loop.
      try {
        await removeSystemdArtifacts({
          host: targetHost,
          manifest: opts.manifest,
          quiet: opts.quiet,
          systemctlRunner: opts.systemctlRunner,
          skipSystemctl: !available,
        });
      } catch (err) {
        if (!opts.quiet) {
          console.warn(`  ⚠ linux-systemd remove failed: ${errorMessage(err)}; continuing`);
        }
      }
      continue;
    }

    // registry hosts (cortex, claude-code): unlink the type-conventional
    // artifact symlink from this host's directory. Same per-type dispatch
    // as the single-host path below — factored so the inline reuses it.
    await removeArtifactFromHost(
      opts.manifest.type,
      opts.packageName,
      targetHost,
    );

    // provides.files (e.g. cortex's <name>.md fragment) — unlink each
    // declared target path.
    for (const f of opts.manifest.provides?.files ?? []) {
      const target = resolveProvidesTarget(f.target);
      await removeSymlink(target);
    }
  }
}

/**
 * Remove the type-conventional artifact symlink from one host adapter.
 *
 * Pulled out of the legacy single-host remove path so both that path
 * and {@link removePerTarget} share the same per-type unlink logic.
 */
async function removeArtifactFromHost(
  type: ArcManifest["type"],
  name: string,
  host: HostAdapter,
): Promise<void> {
  switch (type) {
    case "agent": {
      const mdLink = join(host.paths.agentsDir, `${name}.md`);
      const dirLink = join(host.paths.agentsDir, name);
      if (!(await removeSymlink(mdLink))) {
        await removeSymlink(dirLink);
      }
      return;
    }
    case "prompt": {
      const mdLink = join(host.paths.promptsDir, `${name}.md`);
      const dirLink = join(host.paths.promptsDir, name);
      if (!(await removeSymlink(mdLink))) {
        await removeSymlink(dirLink);
      }
      return;
    }
    case "tool": {
      const binLink = join(host.paths.binDir, name);
      await removeSymlink(binLink);
      return;
    }
    case "skill":
    case "system":
    case "component":
    case "rules":
    case "library":
    case "pipeline":
    default: {
      const skillLink = join(host.paths.skillsDir, name);
      await removeSymlink(skillLink);
      return;
    }
  }
}

/**
 * Completely remove an installed skill.
 *
 * Mirrors `install` in reverse:
 *  1. Fire `scripts.preremove` (if declared, arc#138) so the package can
 *     stop daemons and clean up host-side state BEFORE its repo + symlinks
 *     are torn down. Failures here warn but do not abort.
 *  2. arc#140 P5: run `lifecycle.preuninstall` array (in declared order).
 *     The bot's daemon needs the binary + creds in place to drain/unload.
 *     Per design doc §10.1 D7, a failure here ABORTS the remove (phantom
 *     state is worse than refusing the operation).
 *  3. For packages declaring `targets:` (standalone-bot agents): walk each
 *     target's artifacts in REVERSE install order (supervision hosts FIRST,
 *     registry hosts LAST).
 *  4. Otherwise: tear down primary symlink (skill/agent/tool/…).
 *  5. CLI shims, hooks, extensions cleanup.
 *  6. Reverse-iterate `provides.files` and unlink each target IFF it is a
 *     symlink pointing at the source we installed (arc#138 safety).
 *  7. Delete the DB row.
 *  8. arc#140 P5: run `lifecycle.postuninstall` array. Failures warn only.
 *  9. Delete the cloned repo directory.
 */
export async function remove(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  // arc#348: the cascade-tracking set. Mark self BEFORE anything else so the
  // dependency cascade (below) excludes this package from every refcount and a
  // dep that (transitively) depends back on it can never re-enter.
  const seen = opts._seen ?? new Set<string>();
  seen.add(name);

  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, error: `Skill '${name}' is not installed` };
  }

  // Read manifest up-front. Needed for preremove firing, lifecycle scripts,
  // provides.files cleanup, CLI shim names, and hooks teardown. Best-effort:
  // if the manifest is unreadable (corrupted clone, manual rm -rf), fall
  // through with a null manifest — DB row and primary symlink still removed.
  const manifest = await readManifest(skill.install_path).catch(() => null);

  // arc#359: capture the owns declaration ONCE (the manifest is deleted with the
  // repo below) so both success returns can thread it into the result for the
  // remove kept-summary + purge.
  const ownsDecl = manifest?.owns;

  // 1. Fire scripts.preremove (arc#138) — non-aborting on failure.
  if (manifest?.scripts?.preremove) {
    const preResult = runScript({
      installPath: skill.install_path,
      scriptPath: manifest.scripts.preremove,
      hookName: "preremove",
      quiet: opts.yes === true || opts.quiet === true,
    });
    if (!preResult.success && !preResult.skipped) {
      console.warn(
        `  ⚠ preremove script exited ${preResult.exitCode}; continuing remove anyway`,
      );
    }
  }

  // 2. arc#140 P5: lifecycle.preuninstall array — ABORTS on failure (D7).
  const preuninstallResult = runPreuninstallPhase(
    skill.install_path,
    manifest,
    opts.quiet ?? opts.yes,
  );
  if (!preuninstallResult.success) {
    return { success: false, name, error: preuninstallResult.error };
  }

  const isTool = skill.artifact_type === "tool";
  const isAgent = skill.artifact_type === "agent";
  const isPrompt = skill.artifact_type === "prompt";
  const isPipeline = skill.artifact_type === "pipeline";
  const isAction = skill.artifact_type === "action";

  // Multi-target path (arc#140 P5): walk targets in reverse install order.
  // No-op when manifest is missing (we still try to clean DB/repo below).
  if (manifest?.targets && manifest.targets.length > 0) {
    await removePerTarget({
      targets: manifest.targets,
      manifest,
      packageName: name,
      hostOverrides: opts.hostOverrides,
      quiet: opts.quiet,
      systemctlRunner: opts.systemctlRunner,
    });
  } else if (isAction) {
    // Actions: remove action symlink
    const actionLink = join(arc.actionsDir, name);
    await removeSymlink(actionLink);
  } else if (isPipeline) {
    // Pipelines: remove pipeline symlink
    const pipelineLink = join(arc.pipelinesDir, name);
    await removeSymlink(pipelineLink);
  } else if (isTool) {
    // Tools: remove bin symlink (repo root linked to binDir)
    const binLink = join(host.paths.binDir, name);
    await removeSymlink(binLink);
  } else if (isAgent) {
    // Agents: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(host.paths.agentsDir, `${name}.md`);
    const dirLink = join(host.paths.agentsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else if (isPrompt) {
    // Prompts: remove .md file symlink (or legacy directory symlink)
    const mdLink = join(host.paths.promptsDir, `${name}.md`);
    const dirLink = join(host.paths.promptsDir, name);
    if (!await removeSymlink(mdLink)) {
      await removeSymlink(dirLink);
    }
  } else {
    // Skills: remove skill symlink
    const skillLink = join(host.paths.skillsDir, name);
    await removeSymlink(skillLink);
  }

  // Remove all CLI shims and bin symlinks (skills and tools)
  if (!isAgent && !isPrompt && manifest) {
    const cliEntries = extractAllCliInfo(manifest);
    for (const entry of cliEntries) {
      await removeCliShim(arc.shimDir, entry.binName);
      await removeSymlink(join(host.paths.binDir, entry.binName));
    }
    if (!cliEntries.length) {
      // Fallback: remove by conventional name
      const fallbackName = isTool ? name.toLowerCase() : name.replace(/^_/, "").toLowerCase();
      await removeCliShim(arc.shimDir, fallbackName);
      await removeSymlink(join(host.paths.binDir, fallbackName));
    }
  }

  // Remove hooks from settings.json (before deleting repo).
  //
  // arc#137: always invoke removeHooks regardless of manifest state.
  // The filter inside removeHooks keys on the `_arc_pkg` tag written at
  // install time (or the legacy `_pai_pkg` tag, arc#276), so it's safe
  // (and idempotent) to call when the source repo was deleted out-of-band
  // and the manifest no longer parses.
  // Gating on `manifest?.provides?.hooks` was wrong: a missing or
  // unreadable manifest left settings.json entries pointing at paths
  // that no longer exist, surfacing as "No such file or directory"
  // errors on every Claude Code session start.
  await removeHooks(name, host.paths.settingsPath);

  // Remove extensions (before deleting repo)
  if (manifest?.extensions) {
    await unwireExtensions(manifest, host.paths.root);
  }

  if (manifest?.type === "skill") {
    const somaProjectionResult = await runSomaSkillProjection({
      manifest,
      installPath: skill.install_path,
      mode: "unproject",
    });
    if (somaProjectionResult.warning && opts.quiet !== true) {
      process.stderr.write(
        `  ⚠ ${somaProjectionResult.warning}; continuing without Soma projection\n`,
      );
    }
  }

  // Mirror provides.files on the way out.
  //
  // For every {source, target} the installer created, unlink the target IFF
  // it is still a symlink AND it points at the source path we installed.
  //
  // Safety rule: never `rm` a target that has been hand-edited (i.e. it's
  // a regular file now, or its symlink target no longer matches). The
  // operator may have replaced an arc-installed file with their own copy;
  // arc has no business deleting that. Warn instead. See arc#138.
  if (manifest?.provides?.files?.length) {
    for (const file of manifest.provides.files) {
      const expectedSource = join(skill.install_path, file.source);
      const targetPath = resolveProvidesTarget(file.target);
      await removeProvidedFile(targetPath, expectedSource);
    }
  }

  // Remove from database (CASCADE deletes capabilities) — before repo removal
  removeSkill(db, name);

  // arc#140 P5: run postuninstall lifecycle scripts AFTER artifacts are gone
  // — typical use is to signal cortex reload so the AgentRegistry rebuilds
  // without this agent. Failures here are surfaced as warnings (the
  // uninstall itself already succeeded; the artifacts are no longer on disk).
  if (manifest) {
    const postuninstallResult = runPostuninstallPhase(
      skill.install_path,
      manifest,
      opts.quiet,
    );
    if (!postuninstallResult.success && !opts.quiet) {
      console.warn(`  ⚠ ${postuninstallResult.error}`);
    }
  }

  // Remove repo directory — but NOT if other library artifacts still reference it
  if (skill.library_name) {
    const siblings = listByLibrary(db, skill.library_name);
    if (siblings.length === 0) {
      // Last artifact from this library — safe to remove the entire repo clone
      // The repo clone is the parent of install_path for library artifacts
      // install_path points to the artifact subdir, so we need the library root
      const repoRoot = findGitRoot(skill.install_path);
      if (repoRoot) {
        await rm(repoRoot, { recursive: true, force: true });
      }
    }
    // If siblings remain, leave the repo clone in place
  } else {
    // Standalone package — remove repo directory as before
    await rm(skill.install_path, { recursive: true, force: true });
  }

  // arc#348: cascade the removal to this package's exclusively-owned
  // `depends_on.packages`. Runs AFTER the parent's DB row + repo are gone so
  // the refcount denominator naturally excludes the parent. Best-effort: a
  // failed dep removal is recorded under `cascaded` without failing the parent.
  // `--keep-deps` opts out (removes only the named package).
  if (!opts.keepDeps && manifest?.depends_on?.packages?.length) {
    const { cascaded, retained } = await cascadeDependencyRemovals(
      db,
      arc,
      host,
      manifest,
      seen,
      opts,
    );
    return {
      success: true,
      name,
      ...(cascaded.length ? { cascaded } : {}),
      ...(retained.length ? { retained } : {}),
      ...(hasOwns(ownsDecl) ? { owns: ownsDecl } : {}),
    };
  }

  return {
    success: true,
    name,
    ...(hasOwns(ownsDecl) ? { owns: ownsDecl } : {}),
  };
}

/**
 * The post-remove "kept config/state" summary lines (arc#359, arc#373 defect A,
 * cortex#2441 Note 2).
 *
 * BUG (arc#373 defect A): the earliest summary ended with `run: arc purge <name>`
 * — a next step that is IMPOSSIBLE precisely because remove just ran. `arc purge`
 * REQUIRES the package still installed: the manifest is its only source of the
 * `owns` declaration (arc#359), and remove has already deleted the repo/manifest,
 * so post-remove `arc purge <name>` always fails with "not installed".
 *
 * BUG (cortex#2441 Note 2): the summary then named the RAW owns config/state
 * declarations regardless of on-disk existence. `owns` describes what the
 * package's own RUNTIME may write — but on an install where a stack was never
 * stood up, those paths (`~/.config/metafactory/cortex`, …) never got created.
 * Naming an absent declaration as "kept on disk" is misleading. Field report:
 * `arc install cortex` + `arc remove cortex` printed
 * `kept (config/state): ~/.config/metafactory/cortex, …` for a path that quickstart
 * (not `arc install`) creates, so it did not exist.
 *
 * This formatter now names ONLY paths that actually exist on disk:
 *  - Each purgeable (config/state) owns entry is glob-expanded (rooted at `home`),
 *    and every expansion is filtered by real on-disk presence — a literal entry
 *    that doesn't exist, or a glob that matches nothing, contributes nothing.
 *  - Matches are displayed in `~/…` form (re-tilde'd against `home`) so the output
 *    reads the same as the declaration, and de-duplicated (two entries can expand
 *    to the same path).
 *  - When NOTHING is on disk, prints one clean "nothing kept" line and NO
 *    `--purge` suggestion (there is nothing for purge to drop).
 *  - Otherwise points at `arc remove --purge <name>` as the one-shot to use
 *    INSTEAD of a bare remove next time — purge runs WITH remove, while the
 *    manifest is still present, never after it.
 *
 * Returns [] when the package declared no purgeable (config/state) owns entries,
 * so a userData-only declaration (never deleted) prints no purge guidance.
 *
 * `home` is injectable for tests; production callers use the default (real home).
 * It does NOT change what purge DELETES — only what this summary DISPLAYS.
 */
export function formatRemoveKeptSummary(
  result: RemoveResult,
  home: string = homedir(),
): string[] {
  if (!hasOwns(result.owns)) return [];
  const declared = purgeableEntries(result.owns);
  if (declared.length === 0) return [];

  // Existence filter (cortex#2441 Note 2): expand each declared config/state
  // entry glob-aware, keep only expansions that are present on disk.
  const present: string[] = [];
  for (const entry of declared) {
    for (const abs of expandOwnsEntry(entry, home)) {
      if (pathLiveness(abs) === "present") present.push(abs);
    }
  }
  const kept = [...new Set(present)].sort().map((abs) => toTildePath(abs, home));

  if (kept.length === 0) {
    // Nothing the package's runtime wrote is on disk — say so cleanly and do
    // NOT suggest `--purge`: there is nothing for it to drop.
    return [`   ↳ nothing kept — no config/state on disk for ${result.name}`];
  }

  return [
    `   ↳ kept on disk (runtime config/state arc did not install): ${kept.join(", ")}`,
    `      delete these manually, or next time run \`arc remove --purge ${result.name}\` to drop them as part of removal`,
  ];
}

/**
 * Render an absolute path under `home` back to `~/…` display form (matching how
 * owns entries are declared). A path not under `home` is returned unchanged —
 * expandOwnsEntry only ever yields under-home paths, so that branch is defensive.
 */
function toTildePath(abs: string, home: string): string {
  const rel = relative(home, abs);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    return `~/${rel}`;
  }
  return abs;
}

/**
 * Remove a single provides.files target.
 *
 * Only unlinks if the path is a symlink pointing at `expectedSource`. Any
 * other state — regular file, missing entry, symlink to something else — is
 * left untouched and surfaced via a console warning so an operator who has
 * deliberately customised the file isn't ambushed.
 */
async function removeProvidedFile(
  targetPath: string,
  expectedSource: string,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(targetPath);
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return; // already gone, nothing to do
    console.warn(`  ⚠ provides.files cleanup: cannot stat ${targetPath}: ${errorMessage(err)}`);
    return;
  }

  if (!stat.isSymbolicLink()) {
    console.warn(
      `  ⚠ provides.files cleanup: ${targetPath} is not a symlink (skipped — leave it for the operator to inspect)`,
    );
    return;
  }

  let actualTarget: string;
  try {
    actualTarget = await readlink(targetPath);
  } catch (err) {
    console.warn(`  ⚠ provides.files cleanup: readlink failed on ${targetPath}: ${errorMessage(err)}`);
    return;
  }

  if (actualTarget !== expectedSource) {
    console.warn(
      `  ⚠ provides.files cleanup: ${targetPath} points to ${actualTarget}, not ${expectedSource} (skipped)`,
    );
    return;
  }

  try {
    await unlink(targetPath);
  } catch (err) {
    if (isErrno(err) && err.code !== "ENOENT") {
      console.warn(`  ⚠ provides.files cleanup: unlink failed on ${targetPath}: ${errorMessage(err)}`);
    }
  }
}

/**
 * Remove all artifacts belonging to a library package.
 * Falls back from artifact lookup to library lookup.
 */
export async function removeLibrary(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  libraryName: string,
  opts: RemoveOptions = {}
): Promise<RemoveResult> {
  const artifacts = listByLibrary(db, libraryName);
  if (!artifacts.length) {
    return {
      success: false,
      error: `Package '${libraryName}' is not installed (checked as both artifact and library)`,
    };
  }

  const results: RemoveResult[] = [];
  for (const artifact of artifacts) {
    const result = await remove(db, arc, host, artifact.name, opts);
    results.push(result);
  }

  const removedCount = results.filter((r) => r.success).length;
  const allSuccess = results.every((r) => r.success);
  return {
    success: allSuccess,
    name: libraryName,
    removedCount,
  };
}
