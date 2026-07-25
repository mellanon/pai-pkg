import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { cp, mkdir } from "fs/promises";
import { homedir } from "os";
import type { ArcPaths, HostAdapter, RulesTemplate } from "../types.js";
import type { Database } from "bun:sqlite";
import { listSkills, getSkill, listByLibrary } from "../lib/db.js";
import { readManifest, readLibraryArtifacts } from "../lib/manifest.js";
import YAML from "yaml";
import { installSingleArtifact, installPackageDependencies } from "./install.js";
import { createSymlink } from "../lib/symlinks.js";
import { normalizeDeclaredSecrets } from "../lib/secrets.js";
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
import { installNodeDependencies, reportNodeDependencyResult } from "../lib/artifact-installer.js";

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
  const show = Bun.spawnSync(["git", "show", `${upstream}:arc-manifest.yaml`], opts);
  if (show.exitCode !== 0) return null;
  try {
    const parsed = YAML.parse(show.stdout.toString()) as { version?: unknown } | null;
    return parsed && typeof parsed.version === "string" ? parsed.version : null;
  } catch (_err) {
    // Unparseable remote manifest → treat as "no remote version"; caller falls
    // back to the local manifest. Non-fatal.
    return null;
  }
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
  opts?: { force?: boolean; _seen?: Set<string> }
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

  // Update capabilities — delete old, re-insert from new manifest
  db.prepare("DELETE FROM capabilities WHERE skill_name = ?").run(name);

  const insertCap = db.prepare(
    "INSERT INTO capabilities (skill_name, type, value, reason) VALUES (?, ?, ?, ?)"
  );
  const caps = manifest.capabilities;
  if (caps) {
    if (caps.filesystem?.read) {
      for (const p of caps.filesystem.read) insertCap.run(name, "fs_read", p, "");
    }
    if (caps.filesystem?.write) {
      for (const p of caps.filesystem.write) insertCap.run(name, "fs_write", p, "");
    }
    if (caps.network) {
      for (const n of caps.network) insertCap.run(name, "network", n.host, n.reason);
    }
    if (caps.bash?.restricted_to) {
      for (const b of caps.bash.restricted_to) insertCap.run(name, "bash", b, "");
    }
    if (caps.secrets) {
      // Fold both author shapes to NAME + reason (arc#363) — see db.ts.
      for (const s of normalizeDeclaredSecrets(caps.secrets)) insertCap.run(name, "secret", s.name, s.reason);
    }
  }

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
