import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { cp, mkdir } from "fs/promises";
import { homedir } from "os";
import type { ArcManifest, ArcPaths, HostAdapter, RulesTemplate } from "../types.js";
import type { Database } from "bun:sqlite";
import {
  compositionMembers,
  compositionRecord,
  getSkill,
  listByLibrary,
  listSkills,
  replaceCapabilities,
  replaceCompositionRecord,
  type CompositionMemberState,
} from "../lib/db.js";
import { readManifest, readLibraryArtifacts } from "../lib/manifest.js";
import YAML from "yaml";
import { install, installSingleArtifact, installPackageDependencies, type InstallResult } from "./install.js";
import { recordCompositionSnapshot } from "./files.js";
import { errorMessage } from "../lib/errors.js";
import {
  dirtyMemberEntries,
  planMemberMoves,
  resolveMemberPin,
  type MemberMove,
} from "../lib/composition-upgrade.js";
import { readCompositionReferences, validateCompositionFields } from "../lib/composition.js";
import { createSymlink } from "../lib/symlinks.js";
import { resolveProvidesTarget } from "../lib/provides-target.js";
import { findGitRoot } from "../lib/paths.js";
import { loadSources } from "../lib/sources.js";
import { findInAllSources } from "../lib/remote-registry.js";
import {
  parsePackageRef,
  resolveFromRegistry,
  fetchAndVerifyRegistryPackage,
} from "../lib/registry-install.js";
import { runScript } from "../lib/scripts.js";
import { registerHooks, removeHooks, resolveHooksFromManifest } from "../lib/hooks.js";
import { generateRules } from "../lib/rules.js";
import { wireExtensions } from "../lib/extensions.js";
import { requireBrokerForManifest } from "../lib/nats-broker.js";
import { runSomaSkillProjection } from "../lib/soma-projection.js";
import { installNodeDependencies, reportNodeDependencyResult, dropUntrackedBunLock } from "../lib/artifact-installer.js";

export interface UpgradeOptions {
  /** Re-run the upgrade pipeline even when already at the latest version. */
  force?: boolean;
  /**
   * Internal: packages already upgraded by this command (arc#346). Threads
   * through the `depends_on.packages` cascade so a shared dep or a cycle is
   * upgraded at most once. Not a public flag.
   */
  _seen?: Set<string>;
  /**
   * Internal (arc#401): upgrade ONLY this package, never its composition. Set
   * by `upgradeComposition` when it moves the factory's own code, so the
   * dispatch cannot re-enter. Not a public flag.
   */
  _skipComposition?: boolean;
  /**
   * TEST SEAM (arc#401 review, F8/S1): perform one member's move.
   *
   * Production leaves this absent and the move goes through the ordinary
   * `arc install --pin` path. It exists because the MIXED-STATE path — the
   * factory advanced, a member did not — is by design almost unreachable:
   * pre-flight is meant to catch every failure that is knowable beforehand, so
   * staging a real one means defeating the guards this slice added. The seam
   * makes "what does arc RECORD when a member move fails anyway" an assertable
   * claim instead of a comment, which is the same argument `composition.ts`
   * makes for its own seams.
   */
  _moveMember?: (move: MemberMove) => Promise<InstallResult>;
}

export interface UpgradeCheckResult {
  name: string;
  installedVersion: string;
  registryVersion: string | null;
  repoVersion: string | null;
  upgradable: boolean;
}

export interface UpgradeResult {
  success: boolean;
  name: string;
  oldVersion: string;
  newVersion?: string;
  error?: string;
  /**
   * Results of cascading the upgrade to this package's already-installed
   * `depends_on.packages` (arc#346). Populated only for a package that both
   * declares package dependencies AND has them installed — e.g. `arc upgrade
   * cortex` cascades to its surface-adapter bundles so the whole stack advances
   * together. A dependency that fails to upgrade lands here with success:false
   * but does NOT fail the parent (adapters are independent packages with their
   * own rollback; a stale-but-working adapter is not a broken parent).
   */
  cascaded?: UpgradeResult[];
  /**
   * arc#401 D3 — for a COMPOSITION, the per-member moves onto the new
   * release's pins. Distinct from `cascaded`, which is the `depends_on.packages`
   * cascade (arc#346): a composition member is not a dependency, it IS the
   * composition, and conflating the two would hide which of the two mechanisms
   * moved a package.
   *
   * Empty (and omitted) when the factory was already current or no pin changed.
   */
  members?: { success: boolean; name: string; oldVersion: string; newVersion?: string; error?: string }[];
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * The version advertised by a git-cloned package's REMOTE default branch — the
 * source of truth for a repo-first (not-on-registry) package like cortex, which
 * is distributed straight from GitHub, NOT the meta-factory.ai registry.
 *
 * arc#305: `checkUpgrades` used to read the version from the package's LOCAL
 * clone for git-cloned packages — i.e. it compared the installed version
 * against itself, so a version bump pushed to GitHub was never detected and
 * `arc upgrade <name>` reported "already at X" without ever fetching. The
 * available version for a git-cloned package lives on the remote, so fetch it
 * and read the manifest at the upstream ref.
 *
 * Returns null on ANY failure (not a git repo, no upstream, fetch/auth failure,
 * missing/unparseable remote `arc-manifest.yaml`) — the caller then falls back
 * to the local manifest, preserving prior behaviour.
 */
function readRemoteManifestVersion(installPath: string): string | null {
  const manifest = readRemoteManifest(installPath);
  return manifest && typeof manifest.version === "string" ? manifest.version : null;
}

/**
 * The manifest a git-cloned package's REMOTE default branch advertises —
 * i.e. the release `arc upgrade` is about to pull, read WITHOUT pulling it.
 *
 * Extracted from `readRemoteManifestVersion` for arc#401: a composition's
 * upgrade has to settle its whole plan (which members move, to which pins,
 * and whether those pins are even reachable) BEFORE the factory's code moves,
 * because a factory recorded at a release whose members never followed is a
 * broken snapshot every later command believes. Reading the prospective
 * manifest off `@{u}` is how that plan is built with nothing mutated.
 *
 * Returns null on ANY failure (not a git repo, no upstream, fetch/auth
 * failure, missing or unparseable remote manifest) — callers fall back to the
 * local manifest, preserving the pre-arc#305 behaviour and staying usable
 * offline.
 */
function readRemoteManifest(installPath: string): Record<string, unknown> | null {
  const gitRoot = findGitRoot(installPath);
  if (!gitRoot || !existsSync(join(gitRoot, ".git"))) return null;
  const opts = { cwd: gitRoot, stdout: "pipe" as const, stderr: "pipe" as const };
  // Fetch remote refs (no working-tree change). Non-fatal on failure.
  if (Bun.spawnSync(["git", "fetch", "--quiet"], opts).exitCode !== 0) return null;
  // Upstream of the checked-out branch (e.g. origin/main); fall back to
  // origin/HEAD when no upstream is configured.
  let upstream = Bun.spawnSync(
    ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    opts,
  ).stdout.toString().trim();
  if (!upstream) {
    upstream = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"], opts)
      .stdout.toString()
      .trim();
  }
  if (!upstream) return null;
  for (const file of ["arc-manifest.yaml", "pai-manifest.yaml"]) {
    const show = Bun.spawnSync(["git", "show", `${upstream}:${file}`], opts);
    if (show.exitCode !== 0) continue;
    try {
      const parsed = YAML.parse(show.stdout.toString()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (_err) {
      // Unparseable remote manifest → treat as "no remote manifest"; the caller
      // falls back to the local one. Non-fatal.
    }
  }
  return null;
}

/**
 * Check which installed packages have newer versions available.
 *
 * @param host Unused today; threaded for signature consistency with
 *   upgradePackage / upgradeAll / upgradeLibrary. Will be consumed when
 *   check needs host-specific upgrade-path detection (e.g. an adapter
 *   that resolves upgrades through a host-side registry).
 */
export async function checkUpgrades(
  db: Database,
  arc: ArcPaths,
  _host: HostAdapter,
): Promise<UpgradeCheckResult[]> {
  const installed = listSkills(db).filter((s) => s.status === "active");
  const sources = await loadSources(arc.sourcesPath);
  const results: UpgradeCheckResult[] = [];

  for (const skill of installed) {
    const result: UpgradeCheckResult = {
      name: skill.name,
      installedVersion: skill.version,
      registryVersion: null,
      repoVersion: null,
      upgradable: false,
    };

    // Resolve the advertised version. Registry-extracted packages store a
    // package ref (`@scope/name@version`) in repo_url and are published to the
    // metafactory HTTP API, NOT the YAML registry index — so findInAllSources
    // can never see them and --check would falsely report "up to date"
    // (arc#187 bug 1). Resolve those through resolveFromRegistry instead.
    // Git / YAML-registry packages keep the findInAllSources path unchanged.
    const ref = parsePackageRef(skill.repo_url);
    if (ref) {
      const resolved = await resolveFromRegistry(
        { scope: ref.scope, name: ref.name },
        sources.sources,
      );
      if (resolved?.version) {
        result.registryVersion = resolved.version;
      }
    } else {
      const found = await findInAllSources(sources, skill.name, arc.cachePath);
      if (found?.entry.version) {
        result.registryVersion = found.entry.version;
      }
    }

    // Resolve the AVAILABLE version. For a git-cloned (repo-first, non-registry)
    // package the source of truth is the REMOTE default branch (GitHub), not the
    // local clone — reading the clone would compare the installed version to
    // itself and never see a pushed bump (arc#305). Registry packages already
    // resolved registryVersion above; fall back to the local manifest only when
    // the remote read fails (preserving prior behaviour / offline).
    if (existsSync(skill.install_path)) {
      if (!ref) {
        result.repoVersion =
          readRemoteManifestVersion(skill.install_path) ??
          (await readManifest(skill.install_path))?.version ??
          null;
      } else {
        const manifest = await readManifest(skill.install_path);
        if (manifest) {
          result.repoVersion = manifest.version;
        }
      }
    }

    // Determine if upgrade is available
    // Priority: registry version (remote truth) > repo version (remote default
    // branch for git-cloned; local manifest fallback).
    const availableVersion = result.registryVersion ?? result.repoVersion;
    if (availableVersion && compareSemver(skill.version, availableVersion) < 0) {
      result.upgradable = true;
    }

    results.push(result);
  }

  return results;
}

/**
 * Find all repos that have a matching config file for a rules template.
 * Scans ~/Developer/* for repos with the config file (e.g., agents-md.yaml).
 */
function findConsumerRepos(templates: RulesTemplate[]): string[] {
  const configFiles = templates.map((t) => t.config);
  const devRoot = process.env.BLUEPRINT_DEV_ROOT ?? join(homedir(), "Developer");
  const dirs: string[] = [];

  try {
    const entries = readdirSync(devRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoDir = join(devRoot, entry.name);
      for (const config of configFiles) {
        if (existsSync(join(repoDir, config))) {
          dirs.push(repoDir);
          break;
        }
      }
    }
  } catch (_err: unknown) {
    // Dev root doesn't exist or can't be read — fall back to cwd
  }

  // Always include cwd if it has a config and isn't already in the list
  const cwd = process.cwd();
  for (const config of configFiles) {
    if (existsSync(join(cwd, config)) && !dirs.includes(cwd)) {
      dirs.push(cwd);
      break;
    }
  }

  return dirs;
}

const REGISTRY_UPGRADE_PRESERVED_OVERLAY_PATHS = [
  "EXTEND.yaml",
  "skill/EXTEND.yaml",
  ".soma-projection-state.json",
];

async function copyKnownOverlayEntries(srcDir: string, destDir: string): Promise<void> {
  // Preserve explicit overlay/state paths only. Copying every old path absent
  // from the new payload would keep package files the publisher removed.
  for (const relPath of REGISTRY_UPGRADE_PRESERVED_OVERLAY_PATHS) {
    const src = join(srcDir, relPath);
    const dest = join(destDir, relPath);
    if (!existsSync(src) || existsSync(dest)) continue;

    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
}

/**
 * Cascade an upgrade to a package's already-installed `depends_on.packages`
 * (arc#346). Complements `installPackageDependencies` (install.ts), which only
 * INSTALLS missing declared deps on upgrade — it deliberately skips deps already
 * present, so an `arc upgrade cortex` advanced cortex but left its surface-adapter
 * bundles pinned at their old versions. This upgrades the present ones so the
 * whole stack moves together.
 *
 * Semantics:
 *  - Only deps that are installed + active + on-disk are cascaded (a MISSING dep
 *    is `installPackageDependencies`' job, not this one).
 *  - `seen` guards against re-upgrading a package already handled this command
 *    (shared deps, and dependency cycles): a dep in `seen` is skipped.
 *  - Best-effort: a failed dep upgrade is RETURNED (success:false) but never
 *    thrown — the caller records it under `cascaded` without failing the parent.
 */
async function cascadeDependencyUpgrades(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  manifest: { depends_on?: { packages?: { name: string }[] } },
  seen: Set<string>,
  opts?: { force?: boolean },
): Promise<UpgradeResult[]> {
  const cascaded: UpgradeResult[] = [];
  for (const dep of manifest.depends_on?.packages ?? []) {
    if (seen.has(dep.name)) continue;
    const existing = getSkill(db, dep.name);
    // Only cascade to deps that are actually installed + active + on-disk.
    // A missing/disabled dep is not this function's concern (install path).
    if (existing?.status !== "active" || !existsSync(existing.install_path)) continue;
    cascaded.push(
      await upgradePackage(db, arc, host, dep.name, { force: opts?.force, _seen: seen }),
    );
  }
  return cascaded;
}

/**
 * Upgrade a single installed package.
 * Pulls latest from git, re-reads manifest, updates DB version.
 *
 * After the package itself commits, cascades the upgrade to its already-installed
 * `depends_on.packages` (arc#346) so a component and its bundles (e.g. cortex +
 * its surface adapters) advance together. `_seen` threads the set of packages
 * already upgraded this command so a shared dep / cycle is upgraded at most once.
 */
export async function upgradePackage(
  db: Database,
  arc: ArcPaths, host: HostAdapter,
  name: string,
  opts?: UpgradeOptions
): Promise<UpgradeResult> {
  const seen = opts?._seen ?? new Set<string>();
  // Mark self BEFORE the cascade so a dependency that (transitively) depends
  // back on this package can't re-enter and loop.
  seen.add(name);
  const skill = getSkill(db, name);
  if (!skill) {
    return { success: false, name, oldVersion: "?", error: `"${name}" is not installed` };
  }
  if (skill.status !== "active") {
    return { success: false, name, oldVersion: skill.version, error: `"${name}" is disabled — enable it first` };
  }

  const installPath = skill.install_path;
  if (!existsSync(installPath)) {
    return { success: false, name, oldVersion: skill.version, error: `Install path not found: ${installPath}` };
  }

  // arc#401 D3 — a COMPOSITION advances as a whole: the factory to its new
  // release, its members to THAT release's pins. Dispatched after the
  // installed/active/on-disk checks (so a composition gets the same three
  // errors any package does) and before any code moves, because the whole
  // point of the composition path is that its refusals fire first.
  if (!opts?._skipComposition && compositionRecord(db, name)) {
    return upgradeComposition(db, arc, host, name, skill.repo_url, opts);
  }

  // Two upgrade substrates with different fetch + rollback mechanics (arc#187).
  // Registry-extracted packages store a package ref in repo_url and have no
  // `.git`, so `git pull` can never work for them (bug 2). Git-cloned packages
  // pull. `rollback()` restores the prior on-disk state if a later gate fails;
  // `commitSwap()` drops the registry backup once the upgrade has committed.
  const ref = parsePackageRef(skill.repo_url);
  const isRegistry = ref !== null;

  let rollback: () => string;
  let commitSwap: () => void = () => undefined;

  if (isRegistry) {
    // Clean, fully-verified re-download (SHA-256 + registry signature +
    // Sigstore — security parity with install) into a temp dir, then an
    // atomic swap. Because the download+verify completes BEFORE the working
    // install is touched, a failed/blocked fetch can never strand the user
    // with no install — which is the remove+install hazard (bug 3).
    const sources = await loadSources(arc.sourcesPath);
    const tmpDirName = `${ref.scope}__${ref.name}.arc-upgrade-tmp`;
    const fetched = await fetchAndVerifyRegistryPackage({
      ref: { scope: ref.scope, name: ref.name },
      sources: sources.sources,
      reposDir: arc.reposDir,
      targetDirName: tmpDirName,
    });
    if (!fetched.success || !fetched.extractedPath) {
      return { success: false, name, oldVersion: skill.version, error: fetched.error ?? "registry re-download failed" };
    }

    const newPath = fetched.extractedPath;
    const backupPath = `${installPath}.arc-upgrade-bak`;
    Bun.spawnSync(["rm", "-rf", backupPath], { stdout: "pipe", stderr: "pipe" });
    try {
      await copyKnownOverlayEntries(installPath, newPath);
    } catch (err) {
      Bun.spawnSync(["rm", "-rf", newPath], { stdout: "pipe", stderr: "pipe" });
      const detail = err instanceof Error ? err.message : String(err);
      return { success: false, name, oldVersion: skill.version, error: `upgrade overlay preservation failed: ${detail}` };
    }
    const aside = Bun.spawnSync(["mv", installPath, backupPath], { stdout: "pipe", stderr: "pipe" });
    if (aside.exitCode !== 0) {
      Bun.spawnSync(["rm", "-rf", newPath], { stdout: "pipe", stderr: "pipe" });
      return { success: false, name, oldVersion: skill.version, error: `upgrade swap failed: ${aside.stderr.toString().trim()}` };
    }
    const intoPlace = Bun.spawnSync(["mv", newPath, installPath], { stdout: "pipe", stderr: "pipe" });
    if (intoPlace.exitCode !== 0) {
      // Restore the working install — never leave the user without one.
      Bun.spawnSync(["mv", backupPath, installPath], { stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync(["rm", "-rf", newPath], { stdout: "pipe", stderr: "pipe" });
      return { success: false, name, oldVersion: skill.version, error: `upgrade swap failed: ${intoPlace.stderr.toString().trim()}` };
    }
    rollback = () => {
      Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
      const r = Bun.spawnSync(["mv", backupPath, installPath], { stdout: "pipe", stderr: "pipe" });
      return r.exitCode === 0 ? "" : ` Additionally, restore of the prior install failed: ${r.stderr.toString().trim()}`;
    };
    commitSwap = () => { Bun.spawnSync(["rm", "-rf", backupPath], { stdout: "pipe", stderr: "pipe" }); };
  } else {
    // For library artifacts, git pull must run at the repo root (not artifact subdir)
    const gitCwd = findGitRoot(installPath) ?? installPath;

    // Capture the pre-pull HEAD so the broker-gate failure path below can
    // roll the repo back to a consistent state — sage cycle-3 important
    // finding. Without rollback, a broker-failed upgrade leaves the repo
    // at the new commit while the DB still records the old version,
    // creating a state-drift hazard for the next operation.
    const preHeadProbe = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: gitCwd, stdout: "pipe", stderr: "pipe",
    });
    const preHeadSha = preHeadProbe.exitCode === 0 ? preHeadProbe.stdout.toString().trim() : null;

    // arc#386: a checkout that predates its origin tracking bun.lock has an
    // untracked one in the working tree. `git pull --ff-only` refuses to
    // overwrite an untracked file the incoming commit also adds, which would
    // otherwise brick `arc upgrade arc` on exactly the release meant to fix
    // this. Safe to drop — installNodeDependencies below regenerates it.
    dropUntrackedBunLock(gitCwd);

    // git pull in the cloned repo
    const pullResult = Bun.spawnSync(["git", "pull", "--ff-only"], {
      cwd: gitCwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (pullResult.exitCode !== 0) {
      const stderr = pullResult.stderr.toString().trim();
      return { success: false, name, oldVersion: skill.version, error: `git pull failed: ${stderr}` };
    }

    rollback = () => {
      if (preHeadSha !== null) {
        const resetRes = Bun.spawnSync(["git", "reset", "--hard", preHeadSha], {
          cwd: gitCwd, stdout: "pipe", stderr: "pipe",
        });
        return resetRes.exitCode === 0
          ? ""
          : ` Additionally, post-failure rollback to ${preHeadSha} failed: ${resetRes.stderr.toString().trim()}`;
      }
      return ` Pre-pull HEAD was not captured; on-disk repo may be ahead of recorded version.`;
    };
  }

  // Re-read manifest for new version (from the now-current install path).
  const manifest = await readManifest(installPath);
  if (!manifest) {
    const note = rollback();
    return { success: false, name, oldVersion: skill.version, error: "No arc-manifest.yaml (or pai-manifest.yaml) after upgrade" + note };
  }

  // Runtime broker check (arc#152) — re-verify the bus dependency. The
  // upgrade may have ADDED `requires.nats: true` since the last install,
  // or the broker registration may have been lost since (manual brew
  // unregister, machine reboot, …). Idempotent: when reachable, just logs.
  const brokerGate = await requireBrokerForManifest(manifest, {
    noun: "Package",
    contextClause: " during upgrade",
  });
  if (!brokerGate.ok) {
    // Roll the on-disk state back so it stays consistent with the DB.
    // Best-effort: surface the broker error (the real cause) AND any
    // rollback failure so the operator sees both.
    const rollbackNote = rollback();
    return {
      success: false,
      name,
      oldVersion: skill.version,
      error: brokerGate.error + rollbackNote,
    };
  }

  const oldVersion = skill.version;
  const newVersion = manifest.version;

  if (compareSemver(oldVersion, newVersion) >= 0 && !opts?.force) {
    // Version matches — but if this package provides templates, still
    // regenerate them (template content may have changed even if the version
    // was already bumped). Keyed off `provides.templates`, NOT `type`: any
    // package that declares templates (e.g. type:rules OR
    // type:governance like compass) regenerates them in its consumers
    // (arc#203).
    if (manifest.provides?.templates?.length) {
      const consumerDirs = findConsumerRepos(manifest.provides.templates);
      for (const dir of consumerDirs) {
        await generateRules(installPath, manifest.provides.templates, dir);
      }
    }
    commitSwap();
    // Cascade even when this package is already current: a dependency (e.g. a
    // surface adapter) may still have a newer version, and `arc upgrade cortex`
    // should advance the whole stack (arc#346).
    const cascaded = await cascadeDependencyUpgrades(db, arc, host, manifest, seen, opts);
    return {
      success: true,
      name,
      oldVersion,
      newVersion: oldVersion,
      ...(cascaded.length ? { cascaded } : {}),
    };
  }

  // Run preupgrade script if declared
  if (manifest.scripts?.preupgrade) {
    const preResult = runScript({
      installPath,
      scriptPath: manifest.scripts.preupgrade,
      hookName: "preupgrade",
      env: { PAI_OLD_VERSION: oldVersion, PAI_NEW_VERSION: newVersion },
    });
    if (!preResult.success && !preResult.skipped) {
      const note = rollback();
      return { success: false, name, oldVersion, error: `Preupgrade script failed (exit ${preResult.exitCode})` + note };
    }
  }

  // Re-symlink provides.files drops for types whose payload is provides.files.
  // component: no per-type primary layout. governance (arc#361): the ENTIRE
  // install payload is provides.files — without this re-drop, a governance
  // package that adds or moves a drop between versions never lands it on
  // upgrade.
  if (
    (manifest.type === "component" || manifest.type === "governance") &&
    manifest.provides?.files?.length
  ) {
    for (const file of manifest.provides.files) {
      const sourcePath = join(installPath, file.source);
      const targetPath = resolveProvidesTarget(file.target);
      await mkdir(dirname(targetPath), { recursive: true });
      await createSymlink(sourcePath, targetPath);
    }
  }

  // Run bun install if package.json exists (dependencies may have changed).
  // Shared with the fresh-install path (installNodeDependencies,
  // install-transaction.ts) so upgrade gets the same --frozen-lockfile /
  // stale-lockfile-retry handling and failure surfacing (arc#284/#289)
  // instead of a second, drifted inline copy.
  const nodeDepsResult = installNodeDependencies(installPath);
  reportNodeDependencyResult(nodeDepsResult, name, false);
  if (nodeDepsResult.ran && !nodeDepsResult.success) {
    // Same posture as completeInstallTransaction (install-transaction.ts):
    // a genuine dependency-install failure (survived the frozen->unfrozen
    // retry) must not be recorded as a successful upgrade — this is in fact
    // the PRIMARY blast radius the arc#289 blocker named (cortex ships a
    // committed bun.lock, so every `arc upgrade cortex` takes this path).
    const note = rollback();
    return {
      success: false,
      name,
      oldVersion,
      error: `bun install failed for ${name} (node_modules incomplete): ${nodeDepsResult.error ?? "unknown error"}` + note,
    };
  }

  // Install package dependencies (arc#306) — parity with fresh install's
  // step 2b. `arc upgrade` previously pulled new code + ran `bun install`
  // but NEVER installed newly-declared `depends_on.packages`. So an upgrade
  // across an extraction boundary (cortex moving its platform adapters to 5
  // first-party surface bundles) landed new code with NONE of its dependency
  // bundles — no adapters + the renderer-coverage boot guard hard-failing.
  // Runs the SAME shared loop install() uses, AFTER `bun install` (so the
  // package's own node deps are present) and BEFORE postupgrade + commit (so
  // the bundles are on disk before any postupgrade hook / DB version bump).
  // On failure: roll the code pull back so DB + on-disk stay consistent.
  const packageDepsResult = await installPackageDependencies(manifest, {
    arc,
    host,
    db,
  });
  if (!packageDepsResult.success) {
    const note = rollback();
    return {
      success: false,
      name,
      oldVersion,
      error: (packageDepsResult.error ?? "dependency install failed") + note,
    };
  }

  // Re-register hooks (remove old, add new) — no consent prompt on upgrade.
  // host.paths.root is threaded as $PAI_DIR expansion target — see install.ts.
  const resolvedHooks = resolveHooksFromManifest(
    manifest.provides?.hooks,
    installPath,
    name,
    host.paths.root,
  );
  if (resolvedHooks?.length) {
    const settingsPath = host.paths.settingsPath;
    await removeHooks(name, settingsPath);
    await registerHooks(name, resolvedHooks, settingsPath);
  }

  // Re-generate templates for any package that provides them.
  // Scan all repos with matching config files, not just cwd. Keyed off
  // `provides.templates`, NOT `type`: type:rules AND type:governance
  // (compass) both regenerate the templates they declare into consumers
  // (arc#203).
  if (manifest.provides?.templates?.length) {
    const consumerDirs = findConsumerRepos(manifest.provides.templates);
    for (const dir of consumerDirs) {
      await generateRules(installPath, manifest.provides.templates, dir);
    }
  }

  // Re-wire extensions (if declared)
  if (manifest.extensions) {
    const wired = await wireExtensions(manifest, installPath, host.paths.root);
    for (const ext of wired) {
      console.log(`  \u2713 Extension wired: ${ext}`);
    }
  }

  // Run postupgrade script if declared (falls back to postinstall)
  const postHook = manifest.scripts?.postupgrade ?? manifest.scripts?.postinstall;
  const postHookName = manifest.scripts?.postupgrade ? "postupgrade" : "postinstall";
  if (postHook) {
    const postResult = runScript({
      installPath,
      scriptPath: postHook,
      hookName: postHookName,
      env: { PAI_OLD_VERSION: oldVersion, PAI_NEW_VERSION: newVersion },
    });
    if (!postResult.success && !postResult.skipped) {
      const note = rollback();
      return { success: false, name, oldVersion, error: `${postHookName} script failed (exit ${postResult.exitCode})` + note };
    }
  }

  // Update DB
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE skills SET version = ?, updated_at = ? WHERE name = ?"
  ).run(newVersion, now, name);

  // Update capabilities — delete old, re-insert from new manifest. Shares the
  // single walk in db.ts with fresh install and arc#396's re-pin (the walk was
  // duplicated verbatim here before that extraction).
  replaceCapabilities(db, name, manifest);

  // Upgrade committed — drop the registry backup (no-op for git packages).
  commitSwap();

  const somaProjectionResult = await runSomaSkillProjection({
    manifest,
    installPath,
    mode: "project",
  });
  if (somaProjectionResult.warning) {
    process.stderr.write(
      `  ⚠ ${somaProjectionResult.warning}; continuing without Soma projection\n`,
    );
  }

  // Cascade the upgrade to this package's already-installed depends_on.packages
  // (arc#346) — AFTER commitSwap()/DB bump so the parent is fully committed
  // before any dependency moves, and best-effort so a dependency failure is
  // reported (under cascaded) without undoing the parent's successful upgrade.
  const cascaded = await cascadeDependencyUpgrades(db, arc, host, manifest, seen, opts);
  return {
    success: true,
    name,
    oldVersion,
    newVersion,
    ...(cascaded.length ? { cascaded } : {}),
  };
}

/**
 * Upgrade a whole COMPOSITION (arc#401, `docs/design-factory-type.md` D3/D4).
 *
 * The factory moves to its new release; every member moves to THAT release's
 * pins — never floating latest. `lib/composition-upgrade.ts` owns the rules
 * (and the header there explains what this slice supports and what waits for
 * arc#366); this function owns the sequencing, and the sequencing is the safety
 * property:
 *
 *   1. Read the PROSPECTIVE manifest off the remote, nothing moved.
 *   2. Validate its composition declarations (exact pins, D4) — the same
 *      function `arc validate` and `arc install` run, so the three gates cannot
 *      disagree about one manifest.
 *   3. Plan the member moves; refuse a membership change or a registry member.
 *   4. PRE-FLIGHT every move: is the pin reachable, and does the manifest at it
 *      declare that version? A refusal here is a refusal with the factory still
 *      on its old release — which is the whole reason this step exists rather
 *      than being discovered halfway through step 6.
 *   5. Move the factory itself, through the ORDINARY single-package upgrade
 *      (`_skipComposition`), so its hooks, templates, node deps, rollback and
 *      `depends_on.packages` cascade are the same ones every package gets.
 *   6. Move each member through the ORDINARY `arc install --pin` path, so each
 *      inherits arc#396's dirty-tree / diverged-branch / capability-widening
 *      guards and `replaceCapabilities` — the recorded surface describes the
 *      code now checked out. `yes: true` matches `createMemberInstaller`'s
 *      posture: `arc upgrade` is non-interactive by design, and re-prompting
 *      per member is the death-by-a-thousand-confirmations D2 rejects.
 *   7. Re-record the composition at its new version and RE-TAKE the inventory
 *      snapshot, because D6's untangle proof must describe the release that is
 *      actually installed.
 *
 * Steps 5 and 6 are best-effort in opposite directions on purpose. If 5 fails,
 * nothing has moved and the refusal is clean. If a member in 6 fails, the
 * factory has already advanced; the failure is REPORTED per member (mirroring
 * arc#346's cascade contract) and the composition record is rewritten to the
 * new release for the members that DID move, so `arc list` shows the true
 * mixed state rather than a tidy fiction.
 */
async function upgradeComposition(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  repoUrl: string,
  opts?: UpgradeOptions,
): Promise<UpgradeResult> {
  const skill = getSkill(db, name);
  // Unreachable: the caller resolved it. Narrowed rather than asserted.
  if (!skill) return { success: false, name, oldVersion: "?", error: `"${name}" is not installed` };
  const oldVersion = skill.version;

  // A registry-sourced factory: the mechanism exists, the operations are HELD.
  if (parsePackageRef(repoUrl)) {
    return {
      success: false,
      name,
      oldVersion,
      error:
        `Refusing to upgrade '${name}': it was installed from the REGISTRY (${repoUrl}), and moving a composition to a new registry release needs live-registry operations that are HELD (arc#366). ` +
        `Nothing was moved. This slice upgrades repo-sourced compositions; re-run once arc#366 lands.`,
    };
  }

  // 1. The PROSPECTIVE release. arc#401 review, F6: an unreadable remote is a
  //    REFUSAL, not a fall-through.
  //
  //    The first cut fell through to the ordinary single-package path when the
  //    remote could not be read (offline, no upstream, unparseable manifest).
  //    For a plain package that is right — the local manifest is all there is,
  //    and "already at X" is honest. For a COMPOSITION it is the exact lie this
  //    command exists to prevent: without the new release's `references[]` there
  //    is no way to know which members must move, so the fall-through could
  //    advance the factory alone and leave every member on the old pins. Not
  //    knowing the plan is a reason to stop, never a reason to proceed with
  //    half of it.
  const remote = readRemoteManifest(skill.install_path);
  if (!remote) {
    return {
      success: false,
      name,
      oldVersion,
      error:
        `Refusing to upgrade '${name}': could not read the new release's manifest from its remote ` +
        `(no upstream, the fetch failed, or the manifest is unreadable at ${skill.install_path}).\n` +
        `A composition's members move to the pins the NEW release names (docs/design-factory-type.md D3/D4), and those pins are only in that manifest. ` +
        `Advancing the factory without them would record a release whose members never followed. Nothing was moved.`,
    };
  }

  // 2. Validated through the SAME gate install and publish use.
  const violations = validateCompositionFields(remote);
  if (violations.length > 0) {
    return {
      success: false,
      name,
      oldVersion,
      error: [
        `Refusing to upgrade '${name}': the new release's composition declarations are invalid.`,
        ...violations.map((v) => `  ${v.field}: ${v.rule}`),
        "Nothing was moved.",
      ].join("\n"),
    };
  }

  // 3. Plan.
  const recorded = compositionMembers(db, name);
  const plan = planMemberMoves(
    recorded,
    readCompositionReferences(remote as unknown as ArcManifest),
  );
  if (!plan.ok) {
    return { success: false, name, oldVersion, error: plan.error };
  }
  const moves: MemberMove[] = plan.moves;

  // 4. Pre-flight, with nothing moved yet. Everything that could make a member
  //    move fail and is knowable NOW is asked here, because a refusal after the
  //    factory has advanced is a mixed state rather than a clean "no".
  const blockers: string[] = [];
  for (const move of moves) {
    const member = getSkill(db, move.name);
    if (!member) {
      blockers.push(`  ${move.name}: recorded as a member but not installed`);
      continue;
    }
    if (member.status !== "active") {
      blockers.push(`  ${move.name}: disabled — \`arc enable ${move.name}\` first`);
      continue;
    }
    if (!existsSync(member.install_path)) {
      blockers.push(`  ${move.name}: install path not found (${member.install_path})`);
      continue;
    }
    // S1 — the dirty-tree question `repinInstalledCheckout` asks at MOVE time,
    // asked here instead, so an operator's uncommitted edits produce a refusal
    // with the factory still on its old release.
    const dirty = dirtyMemberEntries(member.install_path);
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 5).join("; ");
      const more = dirty.length > 5 ? `; …and ${dirty.length - 5} more` : "";
      blockers.push(
        `  ${move.name}: uncommitted changes in ${member.install_path} (${shown}${more}) — commit, stash or discard them`,
      );
      continue;
    }
    const resolution = resolveMemberPin(member.install_path, move.to);
    if (!resolution.ok) blockers.push(`  ${move.name}: ${resolution.error}`);
  }
  if (blockers.length > 0) {
    return {
      success: false,
      name,
      oldVersion,
      error: [
        `Refusing to upgrade '${name}': ${blockers.length} member(s) cannot reach the new release's pins.`,
        ...blockers,
        `Nothing was moved — a factory recorded at the new release with members still on the old pins is a broken snapshot (docs/design-factory-type.md D4).`,
      ].join("\n"),
    };
  }

  // 5. The factory itself, through the ordinary path.
  const factoryResult = await upgradePackage(db, arc, host, name, {
    ...opts,
    _skipComposition: true,
  });
  if (!factoryResult.success) return factoryResult;

  // 6. The members, each through the ordinary pinned-install path.
  const moveMember =
    opts?._moveMember ??
    ((move: MemberMove) =>
      install({ arc, host, db, repoUrl: move.ref, pinnedRef: move.to, yes: true }));

  const memberResults: NonNullable<UpgradeResult["members"]> = [];
  for (const move of moves) {
    const result = await moveMember(move);
    memberResults.push(
      result.success
        ? { success: true, name: move.name, oldVersion: move.from, newVersion: result.version ?? move.to }
        : { success: false, name: move.name, oldVersion: move.from, error: result.error },
    );
  }

  // 7. Re-record the composition — in ONE transaction (arc#401 review, F3).
  //
  // The first cut wrote this as `beginComposition` plus a loop of state marks.
  // Between them every member reads `pending`, and a kill in that window erased
  // which members the operator had installed by hand — after which the next
  // `arc purge <factory>` deleted them and no re-run could heal it.
  // `replaceCompositionRecord` commits the header, the membership and every
  // state together or not at all.
  const newVersion = factoryResult.newVersion ?? oldVersion;
  const stateByLabel = new Map(recorded.map((row) => [row.member_label, row.state]));
  const landedVersion = new Map(
    memberResults.filter((m) => m.success).map((m) => [m.name, m.newVersion ?? m.oldVersion]),
  );
  const failed = memberResults.filter((m) => !m.success);

  replaceCompositionRecord(
    db,
    name,
    newVersion,
    recorded.map((row) => ({
      label: row.member_label,
      name: row.member_name,
      // A member whose move FAILED is recorded at the version it is actually
      // on. The record describes the machine, not the intention — which is also
      // what lets a later `arc upgrade` RE-PLAN the outstanding move.
      version: landedVersion.get(row.member_name) ?? row.member_version,
      source: row.member_source,
      ref: row.member_ref,
      // Who installed a member does not change because it moved version, so the
      // `preexisting` marking (the one thing standing between a hand-installed
      // package and the purge cascade) is carried across rather than reset.
      state: (stateByLabel.get(row.member_label) as CompositionMemberState | undefined) ?? "landed",
    })),
    // F8 — an honest header. `partial` says what is true: the factory moved and
    // at least one member did not. `arc list` flags it, and `upgradeComposition`
    // re-plans from the membership (which records the OLD pins for the members
    // that did not follow), so a retry finishes the job instead of reporting
    // "already at" over a composition it never finished moving.
    failed.length > 0 ? "partial" : "complete",
  );

  // S3 — a snapshot that cannot be re-taken is SAID, the same as install's.
  // Silence would leave `arc purge` unable to verify the untangle with nothing
  // explaining why.
  await recordCompositionSnapshot(db, arc, host, name).catch((err: unknown) => {
    process.stderr.write(
      `  ⚠ could not re-record the install-time inventory for '${name}' after upgrade: ${errorMessage(err)}; ` +
        `\`arc purge ${name}\` will still cascade, but cannot verify the untangle (arc#401 D6)\n`,
    );
  });

  return {
    ...factoryResult,
    ...(memberResults.length ? { members: memberResults } : {}),
    ...(failed.length
      ? {
          success: false,
          error:
            `'${name}' moved to ${newVersion}, but ${failed.length} member(s) did not follow:\n` +
            failed.map((m) => `  ${m.name}: ${m.error ?? "unknown error"}`).join("\n") +
            `\nThe composition is recorded as PARTIAL at the versions actually installed; re-run \`arc upgrade ${name}\` to retry the outstanding move(s).`,
        }
      : {}),
  };
}

/**
 * Upgrade all installed packages that have newer versions.
 * When force=true, skips the expensive checkUpgrades (git fetch + registry
 * lookup per package) and instead gets all active packages directly from the DB.
 */
export async function upgradeAll(
  db: Database,
  arc: ArcPaths, host: HostAdapter,
  opts?: { force?: boolean }
): Promise<UpgradeResult[]> {
  const results: UpgradeResult[] = [];
  // One shared set across the whole run: when a package cascades an upgrade to
  // a dependency (arc#346), that dependency is marked seen, so the top-level
  // loop below skips it rather than upgrading it a second time. It still appears
  // in the output nested under its parent's `cascaded`.
  const seen = new Set<string>();

  if (opts?.force) {
    // Skip checkUpgrades entirely — just get all active packages from DB
    const active = listSkills(db).filter((s) => s.status === "active");
    for (const pkg of active) {
      if (seen.has(pkg.name)) continue;
      const result = await upgradePackage(db, arc, host, pkg.name, { ...opts, _seen: seen });
      results.push(result);
    }
  } else {
    const checks = await checkUpgrades(db, arc, host);
    const upgradable = checks.filter((c) => c.upgradable);
    for (const check of upgradable) {
      if (seen.has(check.name)) continue;
      const result = await upgradePackage(db, arc, host, check.name, { _seen: seen });
      results.push(result);
    }
  }

  return results;
}

export function formatCheckResults(results: UpgradeCheckResult[]): string {
  const upgradable = results.filter((r) => r.upgradable);

  if (!upgradable.length) {
    return "All packages are up to date.";
  }

  const lines: string[] = [
    `${upgradable.length} package(s) can be upgraded:`,
    "",
  ];

  for (const r of upgradable) {
    const target = r.registryVersion ?? r.repoVersion ?? "?";
    lines.push(`  ${r.name}: ${r.installedVersion} → ${target}`);
  }

  lines.push("");
  lines.push("Run `arc upgrade` to upgrade all, or `arc upgrade <name>` for one.");

  return lines.join("\n");
}

export function formatUpgradeResults(results: UpgradeResult[], opts?: { force?: boolean }): string {
  if (!results.length) {
    return "Nothing to upgrade.";
  }

  const lines: string[] = [];

  // Format one result at a given indent, then recurse into its cascaded
  // dependency upgrades (arc#346) one level deeper so the stack reads as a tree:
  //   cortex: 6.10.0 → 6.11.0
  //     ↳ metafactory-cortex-adapter-web: 1.2.0 → 1.3.0
  const emit = (r: UpgradeResult, indent: string): void => {
    if (r.success) {
      if (r.oldVersion === r.newVersion) {
        lines.push(
          opts?.force
            ? `${indent}${r.name}: force-upgraded at ${r.oldVersion}`
            : `${indent}${r.name}: already at ${r.oldVersion}`,
        );
      } else {
        lines.push(`${indent}${r.name}: ${r.oldVersion} → ${r.newVersion}`);
      }
    } else {
      lines.push(`${indent}${r.name}: failed — ${r.error}`);
    }
    for (const c of r.cascaded ?? []) {
      emit(c, `${indent}  ↳ `);
    }
  };

  for (const r of results) emit(r, "  ");

  return lines.join("\n");
}

/**
 * Upgrade all artifacts from a library.
 * Pulls the repo once, then checks each artifact's manifest version.
 */
export async function upgradeLibrary(
  db: Database,
  arc: ArcPaths, host: HostAdapter,
  libraryName: string,
  opts?: { force?: boolean }
): Promise<UpgradeResult[]> {
  const artifacts = listByLibrary(db, libraryName);
  if (!artifacts.length) {
    return [{ success: false, name: libraryName, oldVersion: "?", error: `No artifacts installed from library '${libraryName}'` }];
  }

  // Pull the library repo once (from the first artifact's path)
  const gitRoot = findGitRoot(artifacts[0].install_path);
  if (gitRoot) {
    const pullResult = Bun.spawnSync(["git", "pull", "--ff-only"], {
      cwd: gitRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pullResult.exitCode !== 0) {
      return [{ success: false, name: libraryName, oldVersion: "?", error: `git pull failed: ${pullResult.stderr.toString().trim()}` }];
    }
  }

  // Upgrade each existing artifact via upgradePackage (git pull is a no-op since we already pulled).
  // This ensures per-artifact scripts, hooks, capabilities, and symlinks are all handled.
  const results: UpgradeResult[] = [];
  for (const artifact of artifacts) {
    const result = await upgradePackage(db, arc, host, artifact.name, opts);
    results.push(result);
  }

  // Discover and install new artifacts added to the library manifest since last install
  if (gitRoot) {
    const rootManifest = await readManifest(gitRoot);
    if (rootManifest?.type === "library") {
      let manifestArtifacts: Awaited<ReturnType<typeof readLibraryArtifacts>>;
      try {
        manifestArtifacts = await readLibraryArtifacts(gitRoot, rootManifest);
      } catch {
        // Some artifacts may not have manifests yet (WIP) — skip new artifact discovery
        return results;
      }
      const existingNames = new Set(artifacts.map((a) => a.name));

      for (const { entry, manifest: artifactManifest } of manifestArtifacts) {
        if (existingNames.has(artifactManifest.name)) continue;

        // New artifact — install it
        console.log(`  📦 New artifact discovered: ${artifactManifest.name} v${artifactManifest.version}`);
        const artifactDir = join(gitRoot, entry.path);
        const installResult = await installSingleArtifact(
          {
            arc,
            host,
            db,
            repoUrl: artifacts[0].repo_url,
            yes: true,
          },
          artifactDir,
          artifactManifest,
          libraryName,
        );

        results.push({
          success: installResult.success,
          name: artifactManifest.name,
          oldVersion: "new",
          newVersion: installResult.version,
          error: installResult.error,
        });
      }
    }
  }

  return results;
}
