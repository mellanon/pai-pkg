import { join } from "path";
import { existsSync } from "fs";
import { rm } from "node:fs/promises";
import type {
  ArcPaths,
  ArcManifest,
  HostAdapter,
  HostId,
  InstalledSkill,
  PackageTier,
} from "../types.js";
import type { Database } from "bun:sqlite";
import { errorMessage } from "../lib/errors.js";
import { readManifest, readLibraryArtifacts, assessRisk, formatAuthor, formatCapabilities } from "../lib/manifest.js";
import { getSkill, removeSkill } from "../lib/db.js";
import { runScript, runLifecycleScripts } from "../lib/scripts.js";
import { satisfiesRange } from "../lib/semver.js";
import { isSemverShapedRef, pinRefCandidates } from "../lib/pin-ref.js";
import {
  type ArtifactSymlinkRecord,
  artifactDropPresent,
  createArtifactSymlinks,
  rollbackArtifactSymlinks,
  toposortArtifacts,
} from "../lib/artifact-installer.js";
import { extractRepoName, isInsideRepos, repoNameFromPreExtracted } from "../lib/repo-name.js";
import { requireBrokerForManifest } from "../lib/nats-broker.js";
import {
  type HostOverrides,
  orderTargetsForInstall,
  resolveHost,
} from "../lib/hosts/registry.js";
import {
  type LaunchdInstallRecord,
  installLaunchdArtifacts,
  rollbackLaunchdArtifacts,
} from "../lib/hosts/launchd-install.js";
import { isDarwinLaunchdHost } from "../lib/hosts/darwin-launchd.js";
import {
  type SystemctlRunner,
  type SystemdInstallRecord,
  installSystemdArtifacts,
  rollbackSystemdArtifacts,
} from "../lib/hosts/systemd-install.js";
import { isLinuxSystemdHost } from "../lib/hosts/linux-systemd.js";
import {
  ArtifactInstallState,
  beginLibraryInstallTransaction,
  completeInstallTransaction,
  type InstallTransaction,
  type InstallTransactionEvidence,
  type LibraryInstallJournal,
} from "../lib/install-transaction.js";
// F-6e (arc#229): SECRETS provisioning. Lives in its own module
// (secret-provision.ts / secrets.ts); wired in below as a SINGLE clearly
// commented hook at the SECRETS step — non-adjacent to F-6b's identity hook
// (near the return) and F-6c's library-ordering (install-transaction.ts), per
// the batch-merge coordination note on arc#229. Concern: SECRETS only.
import {
  installTimeProvisionSecrets,
  buildSecretEnvForInstall,
} from "../lib/secret-provision-install.js";
import type { SecretBackend, SecretBackendChoice } from "../lib/secrets.js";
// F-6b (arc#228): agent identity provisioning. Lives in its own module; wired
// in below as a SINGLE hook call at the identity step (merge-coordination with
// the F-6c / F-6e install lanes — keep this concern isolated and its insertion
// point non-adjacent to theirs).
import {
  maybeProvisionAgentIdentity,
  reportProvisioningResult,
} from "../lib/identity-provision.js";
// F-6a (cortex#858): cortex config composition. Lives in its own module
// (cortex-config-provision.ts); wired in below as a SINGLE clearly-commented
// hook at the cortex-config step ("step 6c") — AFTER the post-landing
// transaction (which runs postinstall), non-adjacent to F-6b's identity hook
// and F-6e's secrets hook. Concern: cortex config merge only.
import { maybeMergeCortexConfig } from "../lib/cortex-config-provision.js";

export interface InstallOptions {
  /** arc's own state paths (configRoot, dbPath, reposDir, …). Host-independent. */
  arc: ArcPaths;
  /** Target host adapter (Claude Code today; Codex/Cursor later). */
  host: HostAdapter;
  db: Database;
  repoUrl: string;
  /** Skip capability display confirmation (for non-interactive / test use) */
  yes?: boolean;
  /** Source this package is being installed from */
  sourceName?: string;
  /** Trust tier of the source */
  sourceTier?: PackageTier;
  /** Consumer repo directory for rules template generation (defaults to cwd) */
  consumerDir?: string;
  /** When installing from a library, the specific artifact name to install */
  artifactName?: string;
  /** When installing from a library, the library name (for DB tracking) */
  libraryName?: string;
  /**
   * Resume a failed library install from the named artifact (arc#227 / F-6c).
   *
   * Skips every artifact that orders BEFORE this one in the dependency-sorted
   * sequence (they are assumed already installed or deliberately skipped — NOT
   * verified against the DB in v1; known gap arc#232), then installs from this
   * artifact onward with the same ordered / atomic-rollback semantics. Library
   * installs only; ignored for standalone installs.
   * Example: `arc install dev-loop --resume-from=dev` after fixing the broker.
   */
  resumeFromArtifact?: string;
  /**
   * Pre-extracted install path (for registry installs from F-4).
   * When provided, skips git clone and uses this directory as the source.
   */
  preExtractedPath?: string;
  /**
   * Pinned git ref — checkout this ref after clone (arc#387). A semver-shaped
   * value (e.g. "1.2.0") tries tag "v1.2.0" then "1.2.0" (compat contract
   * with arc's pre-#387 tag-only behaviour); anything else — a branch, a
   * full or short commit SHA, a non-semver tag — is checked out verbatim.
   * See src/lib/pin-ref.ts for the full grammar.
   */
  pinnedRef?: string;
  /**
   * Per-host adapter overrides for multi-target installs (arc#140 P3).
   *
   * When the package's manifest declares `targets:`, arc resolves each
   * declared HostId through `resolveHost()`. Tests pass overrides here
   * to redirect default paths (`~/.config/cortex`, `~/Library/LaunchAgents`)
   * to sandboxed temp dirs. Production calls leave this absent.
   */
  hostOverrides?: HostOverrides;
  /**
   * Injectable `systemctl --user` seam for linux-systemd installs (arc#311).
   * Production leaves this absent (real spawn). Tests inject a recorder so
   * a linux-systemd multi-target install/rollback never spawns a real
   * `systemctl` process. Only `daemon-reload` runs during install — arc's
   * dispatch is render-only; activation is deferred to the package's own
   * `lifecycle.postinstall` (principal decision, PR #314 review).
   */
  systemctlRunner?: SystemctlRunner;
  /**
   * F-6e (arc#229) — secret provisioning controls.
   *
   * `--skip-secrets`: install proceeds without prompting; declared secrets are
   * left unstored and the daemon fails at first use with a clear message.
   * `--from-env`: resolve each declared secret from the current environment
   * instead of prompting (CI / scripted installs).
   * `secretBackend`: `--secret-backend keychain|file|auto` override. `auto`
   * (default) prefers Keychain on a single-user macOS dev box but the
   * chmod-600 file backend on a shared/CI host (where the macOS `security`
   * argv-exposure window is at risk — arc#234 review).
   */
  skipSecrets?: boolean;
  fromEnv?: boolean;
  secretBackend?: SecretBackendChoice;
  /**
   * Injectable secret-storage backend seam (arc#363). Production leaves this
   * absent — the backend is resolved from the manifest + platform. Tests inject
   * a stub (e.g. one whose `retrieve` throws) to drive the SECRETS-step and
   * post-landing env-build failure/rollback paths without a real Keychain/file
   * store. When present it overrides `secretBackend` for this install.
   */
  secretBackendInstance?: SecretBackend;
  /**
   * F-6a (cortex#858) — target stack id (`{principal}/{stack}`) for the cortex
   * config merge step. Forwarded to `cortex config merge --stack`. Optional:
   * cortex requires it only when the target config dir holds more than one
   * `stacks/*.yaml`. Ignored unless the manifest declares `cortex_config` AND
   * the target host is a cortex stack.
   */
  cortexStackId?: string;
  /**
   * S1 (arc#244 / cortex#1133) — config-split stack targeting.
   *
   * Extra env vars merged into the postinstall lifecycle env (the pack's
   * reload + creds scripts) so they target the resolved stack config dir rather
   * than the legacy `~/.config/cortex` root. Populated by the CLI from
   * `--config-dir` / `--stack` (see `buildCortexInstallSteering`) and carries
   * `CORTEX_CONFIG` (the stack config dir). Absent → scripts see only
   * `process.env` + secrets, i.e. today's behavior.
   *
   * Where the agent fragment + persona LAND is decided separately by
   * `hostOverrides.cortex.configRoot` (threaded into `createCortexHost`); this
   * env only tells the postinstall scripts which stack to reload/issue against.
   */
  cortexConfigEnv?: Record<string, string>;
}

export interface InstallResult {
  success: boolean;
  name?: string;
  version?: string;
  /**
   * arc#354: the package was ALREADY installed (status: active) and nothing
   * was done — a harmless no-op success, not an error. Set by the duplicate
   * guards in install() so callers (CLI output, the dependency loop) can
   * report "already installed" instead of "Installed vX".
   */
  alreadyInstalled?: boolean;
  error?: string;
  manifest?: ArcManifest;
  evidence?: InstallTransactionEvidence;
  /**
   * For library installs: per-artifact result (backward-compat shape).
   *
   * Retained as `InstallResult[]` so existing callers/tests keep reading
   * `.success` / `.name` / `.version`. The authoritative per-artifact STATE
   * (skipped / success / failed / rolled_back) lives in `journal` (arc#227).
   */
  artifacts?: InstallResult[];
  /**
   * For library installs (arc#227 / F-6c): the full transactional journal —
   * ordered per-artifact state, errors, and landed-artifact evidence. Present
   * on every library install (success or failure), absent for standalone.
   */
  journal?: LibraryInstallJournal;
}

/**
 * Narrowed slice of {@link InstallOptions} that the package-dependency
 * install loop needs. Lets `upgradePackage()` reuse the exact same loop
 * without threading a full InstallOptions.
 */
export interface PackageDependencyContext {
  /** arc's own state paths (configRoot, dbPath, reposDir, …). */
  arc: ArcPaths;
  /** Target host adapter. */
  host: HostAdapter;
  db: Database;
  /** Skip capability confirmation / suppress progress chatter. */
  yes?: boolean;
  /** Per-host adapter overrides for multi-target / sandboxed-test installs. */
  hostOverrides?: HostOverrides;
}

/**
 * Install a package's arc-package dependencies (`depends_on.packages`).
 *
 * Extracted from the install "step 2b" loop so BOTH `install()` and
 * `upgradePackage()` install declared package dependencies through the SAME
 * code path. Before arc#306, `arc upgrade` pulled new code + ran `bun install`
 * but NEVER installed newly-declared `depends_on.packages` — so an upgrade
 * across an extraction boundary (e.g. cortex moving its platform adapters to 5
 * first-party surface bundles) landed new code with none of its dependency
 * bundles: no adapters + the renderer-coverage boot guard hard-failing.
 *
 * Behavior is preserved exactly from the original inline loop: the arc#248
 * drop-present re-install check, stale-row removal, the recursive `install()`,
 * and failure propagation.
 */
export async function installPackageDependencies(
  manifest: ArcManifest,
  ctx: PackageDependencyContext,
): Promise<{ success: boolean; error?: string }> {
  const { arc, host, db } = ctx;

  if (manifest.depends_on?.packages?.length) {
    for (const dep of manifest.depends_on.packages) {
      if (!dep.repo) {
        if (!ctx.yes) {
          console.log(`  Skipping dependency ${dep.name}: no repo URL specified`);
        }
        continue;
      }

      // arc#248: honor the `active` skip only when the dependency's host DROP
      // is actually present on disk. The DB can claim a dep is installed while
      // its symlinks/fragments are gone (a prior run recorded the row but the
      // drop never landed, or the host dir was wiped) — skipping then is a
      // silent no-op. Re-derive the expected targets from the dep's recorded
      // install path + its manifest (the SAME path the install would write);
      // fall through to (re-)install when the drop is missing.
      //
      // arc#354: resolve the installed row by declared name OR by repo URL.
      // The dep's declared `name` is the manifest-author's label and can
      // differ from the installed package's manifest name (live repro:
      // quest-master declares `agent-state`, the installed skill row is
      // `AgentState`) — a name-only lookup missed the row, the recursive
      // install() then tripped its duplicate guard, and an already-satisfied
      // dependency aborted the whole install.
      const existing =
        getSkill(db, dep.name) ??
        (db
          .prepare("SELECT * FROM skills WHERE repo_url = ? AND library_name IS NULL")
          .get(dep.repo) as InstalledSkill | null);
      if (existing?.status === "active") {
        // arc#354: declared compat range vs the installed version. Same
        // warn-don't-fail posture as the arc#284 depends_on.skills check —
        // and never silently upgrade an already-installed package as a side
        // effect of installing its dependent. Unconditional (not gated on
        // ctx.yes): a silently-incompatible dependency shouldn't hide behind
        // --yes.
        if (dep.version && !satisfiesRange(existing.version, dep.version)) {
          process.stderr.write(
            `arc: WARN — ${manifest.name} declares depends_on.packages: ${dep.name}@${dep.version}, ` +
              `but installed ${existing.name} is v${existing.version} (range not satisfied). ` +
              `Proceeding without upgrading it — run \`arc upgrade ${existing.name}\` if needed.\n`,
          );
        }
        // Determine whether the dep's host drop is actually present, and — when
        // it is NOT — WHY, so the operator notice is accurate (a missing/
        // unreadable repo clone is a different failure than a wiped host drop).
        let dropPresent = false;
        let reason = "host drop missing";
        if (!existsSync(existing.install_path)) {
          reason = "repo clone missing";
        } else {
          const depManifest = await readManifest(existing.install_path);
          if (!depManifest) {
            reason = "manifest unreadable";
          } else {
            dropPresent = await artifactDropPresent({
              type: depManifest.type,
              manifest: depManifest,
              arc,
              host,
              installDir: existing.install_path,
              hostOverrides: ctx.hostOverrides,
            });
          }
        }
        if (dropPresent) {
          // Already installed and the drop is present — the dependency is
          // SATISFIED (arc#354). One-line notice so the operator can see why
          // no install ran; suppressed under --yes like the other progress
          // chatter.
          if (!ctx.yes) {
            console.log(
              `  ✓ dependency '${dep.name}' already installed (v${existing.version}) — satisfied`,
            );
          }
          continue;
        }
        // DB says active but the drop (or its repo clone / manifest) cannot be
        // confirmed — re-install rather than skip. Surfaced unconditionally so
        // the operator sees the accurate reason a supposedly-installed dep is
        // being re-installed.
        process.stderr.write(
          `  re-installing dependency ${dep.name}: DB row active but ${reason}\n`,
        );
        // Drop the stale row so the recursive install's recordInstall INSERT
        // doesn't trip the skills.name UNIQUE constraint / the standalone
        // "already installed" guard. Discarding the row here is intentional and
        // non-transactional: the precondition is an ALREADY-broken install
        // (the recorded drop is gone / unverifiable), so the row was already
        // lying; and the recursive install() below fails loudly if the re-drop
        // fails, so we never silently leave a WORSE state than we found.
        // arc#354: remove by the row's RECORDED name — when the row was
        // resolved via repo URL, `dep.name` may not match it and the stale
        // row would survive to trip the recursive install's guard.
        removeSkill(db, existing.name);
      }

      if (!ctx.yes) {
        console.log(`\nInstalling dependency: ${dep.name} (${dep.repo})`);
      }

      const depResult = await install({
        arc,
        host,
        db,
        repoUrl: dep.repo,
        yes: ctx.yes,
      });

      if (!depResult.success) {
        return {
          success: false,
          error: `Failed to install dependency '${dep.name}': ${depResult.error}`,
        };
      }

      if (!ctx.yes) {
        // arc#354: the recursive install may report the dep was already
        // installed (e.g. resolved under a different recorded name) — that's
        // satisfied, not freshly installed.
        console.log(
          depResult.alreadyInstalled
            ? `  ✓ dependency '${dep.name}' already installed (v${depResult.version}) — satisfied`
            : `  ✓ ${dep.name} v${depResult.version}`,
        );
      }
    }
  }

  return { success: true };
}

/**
 * Install a skill from a git repo URL.
 *
 * Flow:
 * 1. Clone repo to repos directory
 * 2. Read arc-manifest.yaml
 * 3. Display capabilities + risk level
 * 4. Create skill symlink
 * 5. Create bin symlink (if CLI declared)
 * 6. Run bun install (if package.json in repo root)
 * 7. Record in database
 */
export async function install(opts: InstallOptions): Promise<InstallResult> {
  const { arc, host, db, repoUrl } = opts;

  // 1. Clone repo (or use pre-extracted path for registry installs).
  // basename (via repoNameFromPreExtracted) is separator-safe — `split("/")`
  // returned the whole path on Windows `\`-separated paths (#219).
  const repoName = repoNameFromPreExtracted(opts.preExtractedPath) ?? extractRepoName(repoUrl);
  const installPath = opts.preExtractedPath ?? join(arc.reposDir, repoName);

  // S2: Path traversal guard — ensure installPath stays inside reposDir.
  // Uses a path.relative-based containment check (isInsideRepos) instead of a
  // separator-naive `startsWith(reposDir + "/")` that false-rejected valid
  // `\`-separated Windows child paths while still blocking `..` escapes (#219).
  if (!isInsideRepos(arc.reposDir, installPath)) {
    return {
      success: false,
      error: `Refusing to install: repo name "${repoName}" would escape repos directory`,
    };
  }

  // For library artifact installs, skip the repo-level duplicate check
  // (multiple artifacts share the same repo URL)
  if (!opts.libraryName) {
    // Check if already installed in DB (by repo name or by scanning all skills)
    const allSkills = db
      .prepare("SELECT * FROM skills")
      .all() as { name: string; version: string; status: string; repo_url: string; library_name: string | null }[];

    // arc#354: an already-installed ACTIVE package is the SUCCESS case, not a
    // failure — `arc install X` twice is a harmless no-op, and a declared
    // dependency that's already present is satisfied (the exact live-repro:
    // quest-master → agent-state aborted the whole install mid-way because
    // this guard returned an error the dependency loop propagated). Only a
    // DISABLED row still errors, with the arc#158-style actionable hint —
    // silently "succeeding" while the package stays disabled would lie.
    const existingByUrl = allSkills.find((s) => s.repo_url === repoUrl && !s.library_name);
    if (existingByUrl) {
      if (existingByUrl.status === "active") {
        return {
          success: true,
          alreadyInstalled: true,
          name: existingByUrl.name,
          version: existingByUrl.version,
        };
      }
      return {
        success: false,
        error: `Skill '${existingByUrl.name}' is already installed (status: ${existingByUrl.status}). Run \`arc enable ${existingByUrl.name}\` to re-enable it, or \`arc remove ${existingByUrl.name}\` first if you want a clean install.`,
      };
    }

    // Skip stale-clone cleanup for registry installs (preExtractedPath) —
    // the directory was just extracted and its name (scope__name) won't match
    // the repo_url format (@scope/name@version).
    if (existsSync(installPath) && !opts.preExtractedPath) {
      // Only clean up stale clone if no library artifacts are installed from it
      const existingByPath = allSkills.find((s) =>
        s.repo_url.endsWith(repoName)
      );
      if (existingByPath && !existingByPath.library_name) {
        // Same arc#354 posture as the repo_url guard above: active → no-op
        // success; disabled → actionable error.
        if (existingByPath.status === "active") {
          return {
            success: true,
            alreadyInstalled: true,
            name: existingByPath.name,
            version: existingByPath.version,
          };
        }
        return {
          success: false,
          error: `Skill '${existingByPath.name}' is already installed (status: ${existingByPath.status}). Run \`arc enable ${existingByPath.name}\` to re-enable it, or \`arc remove ${existingByPath.name}\` first if you want a clean install.`,
        };
      }
      // If no DB entries reference this path, clean up stale clone
      if (!existingByPath) {
        Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
      }
    }
  }

  // Only clone if not already present and no pre-extracted path (registry installs skip git)
  if (!existsSync(installPath) && !opts.preExtractedPath) {
    const cloneResult = Bun.spawnSync(["git", "clone", repoUrl, installPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (cloneResult.exitCode !== 0) {
      return {
        success: false,
        error: `git clone failed: ${cloneResult.stderr.toString().trim()}`,
      };
    }

    // Checkout pinned ref if specified (arc#387)
    if (opts.pinnedRef) {
      const checkoutResult = checkoutPinnedRef(installPath, opts.pinnedRef);
      if (!checkoutResult.success) {
        Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
        return { success: false, error: checkoutResult.error ?? "checkout failed" };
      }
    }
  }

  // 2. Read manifest
  let manifest: ArcManifest | null;
  try {
    manifest = await readManifest(installPath);
  } catch (err) {
    Bun.spawnSync(["rm", "-rf", installPath]);
    return {
      success: false,
      error: `Failed to read manifest in ${repoUrl}: ${errorMessage(err)}`,
    };
  }
  if (!manifest) {
    // Cleanup cloned repo
    Bun.spawnSync(["rm", "-rf", installPath]);
    return {
      success: false,
      error: `No arc-manifest.yaml (or pai-manifest.yaml) found in ${repoUrl}`,
    };
  }

  // arc#158: catch same-name installs the repo_url check missed (e.g. legacy
  // tarball install whose stored repo_url no longer matches the registry one).
  // Without this, recordInstall would crash on the PRIMARY KEY constraint
  // after all the work was done.
  if (!opts.libraryName) {
    const existingByName = getSkill(db, manifest.name);
    if (existingByName && !existingByName.library_name) {
      // Clean up the clone we just made (other early-exits in this function
      // do the same — preExtractedPath comes from the registry pipeline and
      // owns its own cleanup).
      if (!opts.preExtractedPath) {
        Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
      }

      // arc#354: active at the SAME version → the install is already
      // satisfied; a re-run is a harmless no-op success (idempotency), not an
      // error. A disabled row or a version mismatch still errors with the
      // arc#158 actionable hint — those need an explicit operator decision
      // (`arc enable` / `arc upgrade` / `arc remove`), not a silent side
      // effect.
      if (existingByName.status === "active" && existingByName.version === manifest.version) {
        return {
          success: true,
          alreadyInstalled: true,
          name: existingByName.name,
          version: existingByName.version,
        };
      }

      // Remaining cases: disabled (any version), or active at a DIFFERENT
      // version (the active+same-version case returned success above).
      const hint =
        existingByName.status === "disabled"
          ? `Run \`arc enable ${manifest.name}\` to re-enable it, or \`arc remove ${manifest.name}\` first if you want a clean install.`
          : `Run \`arc upgrade ${manifest.name}\`, or \`arc remove ${manifest.name}\` first if the existing install can't be upgraded in place.`;
      return {
        success: false,
        error: `'${manifest.name}' v${existingByName.version} is already installed (status: ${existingByName.status}). ${hint}`,
      };
    }
  }

  // 2a. Library detection — delegate to per-artifact installs
  if (manifest.type === "library") {
    return installLibrary(opts, installPath, manifest);
  }

  // 2a'. Runtime broker check (arc#152) — packages that route over the
  // shared NATS bus declare `requires.nats: true`. Verify a broker is up
  // (or bootstrap one locally) BEFORE we touch the filesystem; a postinstall
  // that tries to publish-on-bus would otherwise silently no-op on a host
  // that lost its broker registration after reboot.
  const brokerGate = await requireBrokerForManifest(manifest, {
    quiet: opts.yes,
    noun: "Package",
  });
  if (!brokerGate.ok) {
    // Async rollback of the cloned repo — sage cycle-3 performance
    // suggestion. The earlier Bun.spawnSync(["rm","-rf",…]) blocked the
    // event loop on potentially-large checkouts. `force: true` keeps
    // the existing best-effort semantics (no throw on missing path).
    await rm(installPath, { recursive: true, force: true }).catch(() => {
      /* secondary to the broker gate failure; surface the original error */
    });
    return { success: false, error: brokerGate.error };
  }

  // 2b. Install package dependencies (other arc packages).
  // Extracted to installPackageDependencies() so the SAME loop runs on both
  // the fresh-install path (here) and the upgrade path (upgradePackage) —
  // arc#306 closed the gap where `arc upgrade` pulled new code but never
  // installed newly-declared `depends_on.packages`.
  const packageDepsResult = await installPackageDependencies(manifest, {
    arc,
    host,
    db,
    yes: opts.yes,
    hostOverrides: opts.hostOverrides,
  });
  if (!packageDepsResult.success) {
    return { success: false, error: packageDepsResult.error };
  }

  // 2c. Compat surfacing (arc#284) — WARN, not hard-fail (burn-in posture,
  // consistent with the confidentiality-gate precedent) when a declared
  // `depends_on.skills[].version` range is violated by what's installed.
  // This is the general mechanism for one arc package to declare a compat
  // range against another — e.g. a cortex plugin bundle declaring
  // `depends_on.skills: [{ name: "cortex", version: ">=6.0.0" }]` — so the
  // dependency's installed version (already exposed via `arc list --json`,
  // InstalledSkill.version) gets checked against the declared range at
  // install time. Unconditional (not gated on opts.yes): same "always
  // visible" posture as reportProvisioningResult's failure path — a
  // silently-incompatible install shouldn't hide behind --yes.
  //
  // A MISSING dependency (declared but not installed) is a separate,
  // pre-existing gap — depends_on.skills has never auto-installed its
  // targets (unlike depends_on.packages above) — so it's not this check's
  // job; only a VIOLATED range warns here. depends_on.tools is intentionally
  // NOT checked: tool deps (e.g. `bun`) generally name system binaries, not
  // arc-managed packages, and verifying those needs a per-tool
  // `--version`-parsing mechanism this slice doesn't build (see arc#284
  // comment).
  if (manifest.depends_on?.skills?.length) {
    for (const dep of manifest.depends_on.skills) {
      if (!dep.version) continue;
      const installedDep = getSkill(db, dep.name);
      if (!installedDep) continue;
      if (!satisfiesRange(installedDep.version, dep.version)) {
        process.stderr.write(
          `arc: WARN — ${manifest.name} declares depends_on.skills: ${dep.name}@${dep.version}, ` +
            `but installed ${dep.name} is v${installedDep.version} (range not satisfied)` +
            `${dep.reason ? ` — ${dep.reason}` : ""}\n`,
        );
      }
    }
  }

  // 3. Display capabilities
  const risk = assessRisk(manifest);
  const capLines = formatCapabilities(manifest);

  if (!opts.yes) {
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";

    if (tier === "custom" || !opts.sourceName) {
      console.log(`\n⚠️  UNKNOWN SOURCE — review capabilities carefully`);
    } else if (tier === "community") {
      console.log(`\n📦 Community source: ${opts.sourceName}`);
    }

    console.log(`\nInstall: ${manifest.name} v${manifest.version}`);
    const authorLine = formatAuthor(manifest);
    if (authorLine) {
      console.log(`Author: ${authorLine}`);
    }
    console.log(`Source: ${opts.sourceName ?? "direct URL"} [${tier}]`);
    console.log(`Risk: ${risk.toUpperCase()}`);

    if (tier !== "official") {
      console.log(`\nCapabilities:`);
      for (const line of capLines) {
        console.log(line);
      }
    }
  }

  // ── F-6e (arc#229) SECRETS STEP ──────────────────────────────────────────
  // Provision the package's declared `capabilities.secrets` (prompt / --from-env
  // / --skip-secrets) and store them via the platform backend (Keychain on
  // macOS, chmod-600 file fallback elsewhere) BEFORE preinstall — so a
  // preinstall/postinstall script that bootstraps a token can read it from the
  // injected env. Best-effort + fail-closed-loud: a store failure aborts the
  // install (clean — no symlinks placed yet); a skipped secret just WARNs.
  // Values never touch stdout/argv-we-log (issue §E). IDENTITY (F-6b) owns a
  // separate hook near the return; LIBRARY ORDERING (F-6c) lives in
  // install-transaction.ts. Concern here: SECRETS only.
  const secretStep = await installTimeProvisionSecrets(manifest, {
    arc,
    skipSecrets: opts.skipSecrets,
    fromEnv: opts.fromEnv,
    quiet: opts.yes,
    backendChoice: opts.secretBackend,
    backend: opts.secretBackendInstance,
  });
  if (!secretStep.success) {
    Bun.spawnSync(["rm", "-rf", installPath], { stdout: "pipe", stderr: "pipe" });
    return { success: false, error: secretStep.error };
  }

  // 3b. Run preinstall script(s) if declared
  const preinstallResult = runPreinstallPhase(installPath, manifest, opts.yes);
  if (!preinstallResult.success) {
    return preinstallResult;
  }

  // 4. Create symlinks based on artifact type.
  //
  // Two paths:
  //   - manifest.targets present → arc#140 P3 multi-target dispatch:
  //     iterate declared targets in install order (cortex/claude-code first,
  //     OS-supervision hosts last), call createArtifactSymlinks per target
  //     or installLaunchdArtifacts for darwin-launchd.
  //   - manifest.targets absent → existing single-host flow against opts.host.
  let symlinkResult: { record: ArtifactSymlinkRecord; filesMissingSource: { source: string; target: string }[] };
  let launchdRecords: LaunchdInstallRecord[] = [];
  let systemdRecords: SystemdInstallRecord[] = [];
  if (manifest.targets && manifest.targets.length > 0) {
    const multi = await installPerTarget({
      targets: manifest.targets,
      manifest,
      arc,
      installPath,
      consumerDir: opts.consumerDir,
      quiet: opts.yes,
      hostOverrides: opts.hostOverrides,
      systemctlRunner: opts.systemctlRunner,
    });
    if ("error" in multi) {
      return { success: false, error: multi.error };
    }
    symlinkResult = { record: multi.symlinks, filesMissingSource: [] };
    launchdRecords = multi.launchd;
    systemdRecords = multi.systemd;
  } else {
    symlinkResult = await createArtifactSymlinks({
      type: manifest.type,
      manifest,
      arc,
      host,
      installDir: installPath,
      consumerDir: opts.consumerDir,
      quiet: opts.yes,
    });
    if (symlinkResult.filesMissingSource.length) {
      const detail = symlinkResult.filesMissingSource
        .map((f) => `  - ${f.source} -> ${f.target}`)
        .join("\n");
      return {
        success: false,
        error:
          `Manifest declares provides.files entries whose source does not exist in the package:\n${detail}`,
      };
    }
  }
  // 5b. Complete the post-landing Install Transaction.
  // S1 (arc#244): config-split steering env (CORTEX_CONFIG) is merged in so a
  // pack's reload/creds postinstall scripts target the resolved stack dir.
  // Secrets win on key collision (a pack wouldn't name a secret CORTEX_CONFIG,
  // but secrets are the more privileged source, so they take precedence).
  // Symlinks (and any launchd/systemd artifacts) have landed above but the
  // post-landing transaction — which owns rollback — has not started yet. A
  // throw while building the postinstall env would therefore strand a dangling
  // skill symlink + the orphaned clone (arc#363). Guard the window: on failure,
  // unwind exactly what landed above, then remove the clone, before aborting.
  let postinstallEnv: Record<string, string>;
  try {
    postinstallEnv = {
      ...(opts.cortexConfigEnv ?? {}),
      ...(await buildSecretEnvForInstall(manifest, {
        arc,
        backendChoice: opts.secretBackend,
        backend: opts.secretBackendInstance,
      })),
    };
  } catch (err) {
    // Best-effort unwind — each rollback is name-scoped and never throws the
    // original secret error; surface that error to the caller regardless.
    await rollbackArtifactSymlinks(symlinkResult.record).catch(() => {
      /* best-effort; the secret-env error below is the reported failure */
    });
    for (const record of launchdRecords) {
      await rollbackLaunchdArtifacts(record).catch(() => {
        /* best-effort */
      });
    }
    for (const record of systemdRecords) {
      await rollbackSystemdArtifacts(record, { systemctlRunner: opts.systemctlRunner }).catch(() => {
        /* best-effort */
      });
    }
    await rm(installPath, { recursive: true, force: true }).catch(() => {
      /* best-effort; the clone may already be gone */
    });
    return { success: false, error: `Secret env build failed: ${errorMessage(err)}` };
  }
  // Capture the live transaction so the F-6a cortex-config step below can
  // unwind the landed state (symlinks/hooks/launchd/DB row) if the merge fails
  // — atomic, same as the library path's onTransaction capture.
  let installTx: InstallTransaction | undefined;
  const transactionResult = await completeInstallTransaction({
    host,
    db,
    repoUrl,
    installPath,
    manifest,
    authorization: { approved: true },
    symlinks: symlinkResult.record,
    launchdRecords,
    systemdRecords,
    systemctlRunner: opts.systemctlRunner,
    quiet: opts.yes,
    sourceName: opts.sourceName ?? null,
    sourceTier: opts.sourceTier ?? manifest.tier ?? "custom",
    libraryName: opts.libraryName ?? null,
    postinstallEnv,
    onTransaction: (handle) => {
      installTx = handle;
    },
  });
  if (!transactionResult.success) {
    // arc#373 defect B: a failed postinstall (or node-deps / missing-hook gate)
    // makes completeInstallTransaction run its rollback of symlinks/hooks/
    // launchd — but the cloned repo is NOT part of that rollback, and the DB row
    // is committed only AFTER postinstall succeeds. So a failed postinstall left
    // an orphaned clone with no DB row: `arc remove <pkg>` couldn't find it and
    // the tester had to `rm` the clone by hand. Roll the clone back here to match
    // every other failure exit in this function (git-clone, manifest-read,
    // secret-env). Guarded on !preExtractedPath: a registry install's extracted
    // dir is owned by the registry pipeline's own cleanup, and a shared-library
    // clone is never installed through this single-package path.
    if (!opts.preExtractedPath) {
      await rm(installPath, { recursive: true, force: true }).catch(() => {
        /* best-effort; the clone may already be gone */
      });
    }
    return transactionResult;
  }

  // F-6b (arc#228) — IDENTITY STEP. For type:agent packages, provision the
  // agent's NKey seed + DID and scaffold its instance state. Best-effort and
  // fail-closed (cortex#563): on any guard trip this WARNs and returns without
  // throwing, so the install still succeeds and the agent boots unidentified
  // until the operator closes the gap. The SECRETS step (F-6e) owns a separate,
  // non-adjacent hook; LIBRARY ORDERING (F-6c) lives in install-transaction.ts.
  // A fail-closed/skip outcome is surfaced UNCONDITIONALLY (even under --yes) so
  // a non-interactive install never hides an unidentified-agent gap.
  const identityResult = await maybeProvisionAgentIdentity(manifest, { quiet: opts.yes });
  reportProvisioningResult(identityResult);

  // ── F-6a (cortex#858) CORTEX-CONFIG STEP ("step 6c") ──────────────────────
  // When the manifest declares `cortex_config` AND the target host is a cortex
  // stack, merge the package's declared capabilities/policy into the stack's
  // `stacks/<id>.yaml` via `cortex config merge`. Runs AFTER the post-landing
  // transaction (so postinstall has run) and is fail-closed: a merge failure
  // unwinds the landed state and aborts the install. The cortex verb is
  // idempotent + writes a 0o600 backup, so a retry after fixing the cause is
  // safe. No-op (success) for non-cortex hosts or a manifest without the field.
  const cortexConfigResult = maybeMergeCortexConfig(manifest, {
    host,
    installPath,
    stackId: opts.cortexStackId,
    quiet: opts.yes,
  });
  if (!cortexConfigResult.success) {
    // Fail-closed: unwind the landed state. The transaction's rollback unwinds
    // symlinks/hooks/extensions/launchd; the DB row was committed by
    // completeInstallTransaction as its LAST step (the existing rollback paths
    // all fire BEFORE that commit), so this step — which runs AFTER it — must
    // remove the row itself to leave nothing behind.
    const evidence = installTx ? await installTx.rollback() : transactionResult.evidence;
    removeSkill(db, manifest.name);
    // arc#373 defect B (sibling exit): the DB row is torn down above, so without
    // this the clone would be orphaned with no way for `arc remove` to find it —
    // same un-removable state a failed postinstall used to leave. Roll the clone
    // back too, guarded on !preExtractedPath like the transaction-failure exit.
    if (!opts.preExtractedPath) {
      await rm(installPath, { recursive: true, force: true }).catch(() => {
        /* best-effort; the clone may already be gone */
      });
    }
    return {
      success: false,
      name: manifest.name,
      version: manifest.version,
      error: cortexConfigResult.error,
      evidence,
    };
  }

  return transactionResult;
}

/**
 * Install artifacts from a library repo.
 * If opts.artifactName is set, installs only that artifact.
 * Otherwise, installs all artifacts (with per-artifact confirmation when interactive).
 */
async function installLibrary(
  opts: InstallOptions,
  installPath: string,
  libraryManifest: ArcManifest,
): Promise<InstallResult> {
  const { db } = opts;
  const libraryName = libraryManifest.name;

  if (!opts.yes) {
    console.log(`\n📚 Library: ${libraryName} v${libraryManifest.version}`);
    const authorLine = formatAuthor(libraryManifest);
    if (authorLine) {
      console.log(`Author: ${authorLine}`);
    }
  }

  // Read all artifact manifests
  let artifactEntries: Awaited<ReturnType<typeof readLibraryArtifacts>>;
  try {
    artifactEntries = await readLibraryArtifacts(installPath, libraryManifest);
  } catch (err) {
    return { success: false, error: errorMessage(err) };
  }

  // Filter to specific artifact if requested. A single-artifact install keeps
  // the original semantics — no ordering / atomic-rollback applies to a set of
  // one — but still flows through the ordered path below (toposort of one
  // element is itself).
  if (opts.artifactName) {
    const match = artifactEntries.find(
      (a) => a.manifest.name === opts.artifactName
    );
    if (!match) {
      const available = artifactEntries.map((a) => a.manifest.name).join(", ");
      return {
        success: false,
        error: `Artifact '${opts.artifactName}' not found in library '${libraryName}'. Available: ${available}`,
      };
    }
    artifactEntries = [match];
  }

  // arc#227 / F-6c: order artifacts by depends_on so each lands after the
  // intra-library artifacts it depends on. A cycle (or unresolvable graph) is
  // a manifest authoring error — fail before touching the filesystem.
  let orderedArtifacts: typeof artifactEntries;
  try {
    orderedArtifacts = toposortArtifacts(artifactEntries);
  } catch (err) {
    return {
      success: false,
      name: libraryName,
      version: libraryManifest.version,
      error: `Cannot order artifacts of library '${libraryName}': ${errorMessage(err)}`,
    };
  }

  // arc#227 / F-6c: resume a failed install from a named artifact. Everything
  // ordered before it is assumed already installed (or deliberately skipped) —
  // this is NOT verified against the DB in v1, so resuming from an artifact
  // whose predecessors never landed can install it against a missing
  // dependency. Known gap, tracked in arc#232 (verify predecessors before
  // resuming).
  let startIndex = 0;
  if (opts.resumeFromArtifact) {
    startIndex = orderedArtifacts.findIndex(
      (a) => a.manifest.name === opts.resumeFromArtifact,
    );
    if (startIndex === -1) {
      const available = orderedArtifacts.map((a) => a.manifest.name).join(", ");
      return {
        success: false,
        name: libraryName,
        version: libraryManifest.version,
        error: `Resume artifact '${opts.resumeFromArtifact}' not found in library '${libraryName}'. Available: ${available}`,
      };
    }
  }

  if (!opts.yes && !opts.artifactName) {
    console.log(`\nArtifact install order (${orderedArtifacts.length}):`);
    for (const { entry, manifest } of orderedArtifacts) {
      const depNames = manifest.depends_on?.packages?.map((p) => p.name) ?? [];
      const deps = depNames.length ? depNames.join(", ") : "(none)";
      console.log(
        `  → ${manifest.name} [${manifest.type}] v${manifest.version} — ${entry.description ?? entry.path} [depends on: ${deps}]`,
      );
    }
    if (opts.resumeFromArtifact) {
      console.log(`  (resuming from '${opts.resumeFromArtifact}')`);
    }
  }

  // arc#227 / F-6c: a multi-artifact transaction journals each artifact's
  // outcome and, on a mid-sequence failure, unwinds every artifact landed in
  // THIS run in reverse order (symlinks/hooks/launchd via each sub-transaction;
  // committed DB rows via removeDbRow). This lifts the arc#140 P4 single-package
  // rollback model to the library level.
  const tx = beginLibraryInstallTransaction({
    libraryName,
    removeDbRow: (name) => {
      removeSkill(db, name);
    },
  });

  // Backward-compat result shape (callers read `.success` / `.name`).
  const results: InstallResult[] = [];
  let firstFailure: { name: string; error: string } | null = null;

  for (let i = startIndex; i < orderedArtifacts.length; i++) {
    const { entry, manifest: artifactManifest } = orderedArtifacts[i];

    const artifactInstallPath = join(installPath, entry.path);

    // Already installed (from a previous run, a sibling library, or this
    // session's resume): a skip counts as success and is NEVER rolled back —
    // it predates this transaction.
    //
    // arc#248: an `active` DB row is only honored when the host-side DROP it
    // claims is ACTUALLY present on disk. DB-truth and filesystem-truth can
    // diverge (a prior run recorded the row but the drop never landed, or the
    // host dir was wiped) — and when they do, a blind skip is a silent no-op
    // reinstall ("Installed N artifact(s)" while the target dir stays empty).
    // Re-derive the expected targets (honoring manifest.targets + host
    // overrides, the SAME path the install would write) and fall through to a
    // (re-)install when the drop is missing. Idempotent symlink creation makes
    // the re-drop safe.
    const existing = getSkill(db, artifactManifest.name);
    if (existing?.status === "active") {
      const dropPresent = await artifactDropPresent({
        type: artifactManifest.type,
        manifest: artifactManifest,
        arc: opts.arc,
        host: opts.host,
        installDir: artifactInstallPath,
        hostOverrides: opts.hostOverrides,
      });
      if (dropPresent) {
        if (!opts.yes) {
          console.log(`  ⏩ ${artifactManifest.name} already installed, skipping`);
        }
        tx.recordArtifactSkipped(
          artifactManifest.name,
          artifactManifest.version,
          artifactManifest.type,
        );
        results.push({
          success: true,
          name: artifactManifest.name,
          version: artifactManifest.version,
        });
        continue;
      }
      // DB says active but the drop is missing — re-drop rather than skip.
      // Always surfaced (even under --yes) so the operator sees why a
      // supposedly-installed member is being re-installed.
      process.stderr.write(
        `  re-dropping ${artifactManifest.name}: DB row active but host drop missing\n`,
      );
      // Drop the stale row so the re-install's recordInstall INSERT doesn't hit
      // the skills.name UNIQUE constraint. The member is then (re-)installed by
      // the normal path below and recorded as a landed artifact of THIS
      // transaction (so a later mid-sequence failure rolls it back cleanly).
      //
      // Discarding the row here is intentional and non-transactional: the
      // precondition is an ALREADY-broken drop (artifactDropPresent returned
      // false), so the row was already lying about the filesystem; and the
      // re-drop below fails loudly (recorded as an artifact failure → library
      // rollback) if it cannot land, so we never silently leave a WORSE state.
      removeSkill(db, artifactManifest.name);
    }

    // Capture the live sub-transaction so a LATER failure can roll this one
    // back. installSingleArtifact rolls back its OWN partial state on internal
    // failure; on success it hands us the committed transaction here.
    let artifactTx: InstallTransaction | undefined;
    const artifactResult = await installSingleArtifact(
      opts,
      artifactInstallPath,
      artifactManifest,
      libraryName,
      (handle) => {
        artifactTx = handle;
      },
    );
    results.push(artifactResult);

    if (!artifactResult.success) {
      if (!opts.yes) {
        console.log(`  ❌ ${artifactManifest.name}: ${artifactResult.error}`);
      }
      const failureError = artifactResult.error ?? "unknown error";
      tx.recordArtifactFailure(
        artifactManifest.name,
        failureError,
        artifactManifest.version,
        artifactManifest.type,
      );
      firstFailure = {
        name: artifactManifest.name,
        error: failureError,
      };
      // Stop the sequence — do not attempt later artifacts. Rollback follows.
      break;
    }

    if (!opts.yes) {
      console.log(`  ✅ ${artifactResult.name} v${artifactResult.version}`);
    }
    // onTransaction always fires (before any hook/postinstall gate) on the path
    // that reaches a success return, so artifactTx is guaranteed set here. Guard
    // the invariant rather than branch on it — a missing handle would mean this
    // artifact could not be rolled back if a later one fails, so fail loud.
    if (!artifactTx) {
      throw new Error(
        `internal: artifact '${artifactManifest.name}' succeeded without a captured install transaction`,
      );
    }
    tx.recordArtifactSuccess(
      artifactManifest.name,
      artifactTx,
      artifactManifest.version,
      artifactManifest.type,
    );
  }

  // Mid-sequence failure → atomically roll back everything this run landed.
  if (firstFailure) {
    if (!opts.yes) {
      console.log(
        `\n↩️  Rolling back ${libraryName} — artifact '${firstFailure.name}' failed; unwinding landed artifacts in reverse order…`,
      );
    }
    const journal = await tx.rollback();
    if (!opts.yes) {
      for (const detail of journal.artifacts) {
        const icon =
          detail.state === ArtifactInstallState.ROLLED_BACK
            ? "↩️ "
            : detail.state === ArtifactInstallState.FAILED
              ? "❌"
              : detail.state === ArtifactInstallState.SKIPPED
                ? "⏩"
                : "✅";
        console.log(`  ${icon} ${detail.name}: ${detail.state}`);
        if (detail.error) console.log(`     ${detail.error}`);
      }
    }
    return {
      success: false,
      name: libraryName,
      version: libraryManifest.version,
      error: `Library '${libraryName}' install failed at artifact '${firstFailure.name}': ${firstFailure.error}. Rolled back all artifacts installed in this run.`,
      artifacts: results,
      journal,
    };
  }

  const journal = tx.journal();
  return {
    success: true,
    name: libraryName,
    version: libraryManifest.version,
    manifest: libraryManifest,
    artifacts: results,
    journal,
  };
}

/**
 * Install a single artifact from a library (or standalone).
 * The artifactDir is the resolved directory containing the artifact's manifest.
 *
 * @param onTransaction Optional hook (arc#227 / F-6c) invoked with the live
 *   InstallTransaction once it is opened — BEFORE any hook/postinstall gate.
 *   The library-install caller captures the handle so that, if a LATER artifact
 *   in the sequence fails, this artifact's landed state can be rolled back.
 *   On a SUCCESS return the handle is the committed transaction; on a failure
 *   return installSingleArtifact has already rolled its own state back, so the
 *   library caller does not record it as a rollback target.
 */
export async function installSingleArtifact(
  opts: InstallOptions,
  artifactDir: string,
  manifest: ArcManifest,
  libraryName: string,
  onTransaction?: (tx: InstallTransaction) => void,
): Promise<InstallResult> {
  const { arc, host, db, repoUrl } = opts;

  // Runtime broker check (arc#152) — same gate as the standalone install
  // path. Library artifacts that declare `requires.nats: true` get the
  // broker probe before any symlinks land.
  const brokerGate = await requireBrokerForManifest(manifest, {
    quiet: opts.yes,
    noun: "Artifact",
  });
  if (!brokerGate.ok) return { success: false, error: brokerGate.error };

  // Display capabilities per-artifact
  const risk = assessRisk(manifest);
  const capLines = formatCapabilities(manifest);

  if (!opts.yes) {
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";
    console.log(`\n  Install: ${manifest.name} v${manifest.version} [${manifest.type}]`);
    console.log(`  Risk: ${risk.toUpperCase()}`);
    if (tier !== "official" && capLines.length) {
      for (const line of capLines) {
        console.log(`  ${line}`);
      }
    }
  }

  // F-6e (arc#229) SECRETS STEP — library-artifact path. dev-loop ships its
  // agents as library artifacts (design §6.1), so per-artifact install also
  // provisions declared secrets. Same fail-closed-loud hook + env injection as
  // the standalone path. Concern: SECRETS only.
  const secretStep = await installTimeProvisionSecrets(manifest, {
    arc,
    skipSecrets: opts.skipSecrets,
    fromEnv: opts.fromEnv,
    quiet: opts.yes,
    backendChoice: opts.secretBackend,
  });
  if (!secretStep.success) {
    return { success: false, error: secretStep.error };
  }

  // Run preinstall script(s)
  const preinstallResult = runPreinstallPhase(artifactDir, manifest, opts.yes);
  if (!preinstallResult.success) {
    return preinstallResult;
  }

  // Create symlinks based on artifact type. THIS MIRRORS the standalone
  // install() flow's two-path dispatch (arc#244 / cortex#1133):
  //   - manifest.targets present → installPerTarget: iterate declared targets,
  //     resolving each HostId through resolveHost(targetId, hostOverrides). For
  //     a `type: agent` member targeting cortex this takes the cortex BOT-PACK
  //     DROP (agent.yaml → {configRoot}/agents.d/<id>.yaml + persona.md →
  //     {configRoot}/personas/<id>.md) honoring hostOverrides.cortex.configRoot
  //     — so `arc install <library>` of bot-packs actually lands the agents on
  //     the stack subdir. Before this, the library fan-out called
  //     createArtifactSymlinks with `opts.host` (the claude-code default) and
  //     IGNORED manifest.targets, so members were DB-tracked but never dropped
  //     (cortex#129).
  //   - manifest.targets absent → existing single-host flow against `host`
  //     (plain skills/tools/prompts — byte-identical to before).
  let symlinkResult: { record: ArtifactSymlinkRecord; filesMissingSource: { source: string; target: string }[] };
  let artifactLaunchdRecords: LaunchdInstallRecord[] = [];
  let artifactSystemdRecords: SystemdInstallRecord[] = [];
  if (manifest.targets && manifest.targets.length > 0) {
    const multi = await installPerTarget({
      targets: manifest.targets,
      manifest,
      arc,
      installPath: artifactDir,
      consumerDir: opts.consumerDir,
      quiet: opts.yes,
      hostOverrides: opts.hostOverrides,
      systemctlRunner: opts.systemctlRunner,
    });
    if ("error" in multi) {
      return { success: false, error: multi.error };
    }
    symlinkResult = { record: multi.symlinks, filesMissingSource: [] };
    artifactLaunchdRecords = multi.launchd;
    artifactSystemdRecords = multi.systemd;
  } else {
    symlinkResult = await createArtifactSymlinks({
      type: manifest.type,
      manifest,
      arc,
      host,
      installDir: artifactDir,
      consumerDir: opts.consumerDir,
      quiet: opts.yes,
    });
    if (symlinkResult.filesMissingSource.length) {
      const detail = symlinkResult.filesMissingSource
        .map((f) => `  - ${f.source} -> ${f.target}`)
        .join("\n");
      return {
        success: false,
        error:
          `Manifest declares provides.files entries whose source does not exist in the package:\n${detail}`,
      };
    }
  }
  // S1 (arc#244): library-artifact path — same config-split steering as the
  // standalone path. dev-loop ships its agents as library artifacts, so each
  // member's reload/creds postinstall must target the resolved stack too.
  const artifactPostinstallEnv = {
    ...(opts.cortexConfigEnv ?? {}),
    ...(await buildSecretEnvForInstall(manifest, {
      arc,
      backendChoice: opts.secretBackend,
    })),
  };
  // Wrap the caller's onTransaction so we ALSO capture the handle locally —
  // the F-6a cortex-config step below must unwind THIS artifact's landed state
  // if the merge fails (installSingleArtifact's contract: on a failure return,
  // its own state is already rolled back, so the library caller does not record
  // it as a rollback target).
  let artifactTx: InstallTransaction | undefined;
  const artifactTransactionResult = await completeInstallTransaction({
    host,
    db,
    repoUrl,
    installPath: artifactDir,
    manifest,
    authorization: { approved: true },
    symlinks: symlinkResult.record,
    launchdRecords: artifactLaunchdRecords,
    systemdRecords: artifactSystemdRecords,
    systemctlRunner: opts.systemctlRunner,
    quiet: opts.yes,
    sourceName: opts.sourceName ?? `library:${libraryName}`,
    sourceTier: opts.sourceTier ?? manifest.tier ?? "custom",
    libraryName,
    postinstallEnv: artifactPostinstallEnv,
    onTransaction: (handle) => {
      artifactTx = handle;
      onTransaction?.(handle);
    },
  });
  if (!artifactTransactionResult.success) return artifactTransactionResult;

  // F-6b (arc#228) — IDENTITY STEP (library-artifact path). dev-loop ships its
  // agents as library artifacts (design §6.1), so the per-artifact install must
  // also provision identity. Same fail-closed, best-effort hook as the
  // standalone path above — and the same unconditional failure-visibility rule.
  const artifactIdentityResult = await maybeProvisionAgentIdentity(manifest, { quiet: opts.yes });
  reportProvisioningResult(artifactIdentityResult);

  // F-6a (cortex#858) — CORTEX-CONFIG STEP (library-artifact path). dev-loop's
  // agents are the primary carriers of `cortex_config` (design §6.1), so the
  // per-artifact install merges it too. Same fail-closed semantics: on a merge
  // failure roll THIS artifact's landed state back and return failure, so the
  // library transaction's own unwind treats it as an already-rolled-back step.
  const artifactCortexConfig = maybeMergeCortexConfig(manifest, {
    host,
    installPath: artifactDir,
    stackId: opts.cortexStackId,
    quiet: opts.yes,
  });
  if (!artifactCortexConfig.success) {
    // Roll THIS artifact's landed state back (symlinks/hooks/launchd) AND remove
    // its committed DB row — the transaction's own rollback stops short of the
    // DB commit (its last step), and the library caller does not record a
    // FAILED artifact as a rollback target. So installSingleArtifact owns the
    // full unwind on a failure return, per its contract.
    if (artifactTx) await artifactTx.rollback();
    removeSkill(db, manifest.name);
    return {
      success: false,
      name: manifest.name,
      version: manifest.version,
      error: artifactCortexConfig.error,
    };
  }

  return artifactTransactionResult;
}

/**
 * Multi-target install dispatch (arc#140 P3).
 *
 * When a manifest declares `targets:`, arc lands the artifact's per-target
 * pieces in the order required by cortex `docs/design-arc-agent-bots.md`
 * §3.2 — registry hosts (cortex, claude-code) FIRST, then OS-supervision
 * hosts (darwin-launchd, linux-systemd). The daemon needs the fragment +
 * NATS creds in place BEFORE `launchctl bootstrap` runs.
 *
 * Returns an aggregated record that combines:
 *   - all symlinks created across registry hosts (one merged
 *     ArtifactSymlinkRecord — same rollback path as the single-host case
 *     since the existing `rollbackArtifactSymlinks` walks the list)
 *   - per-host LaunchdInstallRecords / SystemdInstallRecords (one per
 *     supervision target) so the downstream postinstall-failure or
 *     hook-gate-failure path can also roll back the supervision side.
 *
 * On `provides.files` validation failure or supervision-side install
 * failure inside the loop, this function rolls back ALL accumulated state
 * before returning so the caller never sees partial multi-target state.
 *
 * Hooks registration (`provides.hooks`) is the caller's responsibility —
 * arc#140 P3 keeps hooks on the existing `opts.host` (typically claude-code),
 * not driven by `manifest.targets`. A future P4 may revisit if a host
 * other than claude-code needs settings-json-style hooks.
 */
interface MultiTargetInstallResult {
  symlinks: ArtifactSymlinkRecord;
  launchd: LaunchdInstallRecord[];
  systemd: SystemdInstallRecord[];
}

async function installPerTarget(opts: {
  targets: HostId[];
  manifest: ArcManifest;
  arc: ArcPaths;
  installPath: string;
  consumerDir?: string;
  quiet?: boolean;
  hostOverrides?: HostOverrides;
  systemctlRunner?: SystemctlRunner;
}): Promise<MultiTargetInstallResult | { error: string }> {
  const ordered = orderTargetsForInstall(opts.targets);
  const merged: ArtifactSymlinkRecord = {
    symlinks: [],
    shims: { dir: opts.arc.shimDir, names: [] },
  };
  const launchd: LaunchdInstallRecord[] = [];
  const systemd: SystemdInstallRecord[] = [];

  const rollbackAll = async () => {
    await rollbackArtifactSymlinks(merged);
    for (const r of launchd) {
      await rollbackLaunchdArtifacts(r);
    }
    for (const r of systemd) {
      await rollbackSystemdArtifacts(r, { systemctlRunner: opts.systemctlRunner });
    }
  };

  for (const targetId of ordered) {
    let targetHost;
    try {
      targetHost = resolveHost(targetId, opts.hostOverrides);
    } catch (err) {
      await rollbackAll();
      return { error: errorMessage(err) || `Failed to resolve host '${targetId}'` };
    }

    if (targetId === "darwin-launchd") {
      // Sage P3 review (arc#143): type guard replaces a blanket `as` cast
      // so a future refactor that drops the plistDir extension surfaces
      // here instead of at runtime when host.paths.plistDir is undefined.
      if (!isDarwinLaunchdHost(targetHost)) {
        await rollbackAll();
        return {
          error:
            `Internal error: 'darwin-launchd' resolved to a host adapter without launchd paths`,
        };
      }
      try {
        const rec = await installLaunchdArtifacts({
          host: targetHost,
          manifest: opts.manifest,
          installDir: opts.installPath,
          quiet: opts.quiet,
        });
        launchd.push(rec);
      } catch (err) {
        await rollbackAll();
        return {
          error: `darwin-launchd install failed: ${errorMessage(err)}`,
        };
      }
      continue;
    }

    if (targetId === "linux-systemd") {
      // Sister to the darwin-launchd branch above (arc#311, L2): type guard
      // replaces a blanket `as` cast so a future refactor that drops the
      // unitDir extension surfaces here instead of at runtime.
      if (!isLinuxSystemdHost(targetHost)) {
        await rollbackAll();
        return {
          error:
            `Internal error: 'linux-systemd' resolved to a host adapter without systemd paths`,
        };
      }
      // Root-cause fix (PR #314 review, BLOCKER): dispatch never consulted
      // host.detect() before this — on a host with no systemd user session
      // (e.g. macOS, or a Linux box that never ran `systemctl --user`),
      // installSystemdArtifacts would still spawn `systemctl` for real,
      // throw on ENOENT, and only THEN discover there was nothing to do
      // here. Gate BEFORE any disk mutation instead — a clear, targeted
      // failure beats a throw deep inside a spawn call.
      if (!targetHost.detect()) {
        await rollbackAll();
        return {
          error:
            `linux-systemd target requires a systemd user session (systemctl + ~/.config/systemd/user); not available on this host`,
        };
      }
      try {
        const rec = await installSystemdArtifacts({
          host: targetHost,
          manifest: opts.manifest,
          installDir: opts.installPath,
          quiet: opts.quiet,
          systemctlRunner: opts.systemctlRunner,
        });
        systemd.push(rec);
      } catch (err) {
        await rollbackAll();
        return {
          error: `linux-systemd install failed: ${errorMessage(err)}`,
        };
      }
      continue;
    }

    // registry hosts (cortex, claude-code) take the existing symlink path.
    // A THROW from the artifact drop (e.g. a bot pack refusing an unsafe
    // fragment id) must roll back the targets already installed and surface
    // as a normal install error, not an uncaught exception.
    let r: Awaited<ReturnType<typeof createArtifactSymlinks>>;
    try {
      r = await createArtifactSymlinks({
        type: opts.manifest.type,
        manifest: opts.manifest,
        arc: opts.arc,
        host: targetHost,
        installDir: opts.installPath,
        consumerDir: opts.consumerDir,
        quiet: opts.quiet,
      });
    } catch (err) {
      await rollbackAll();
      return { error: `[${targetId}] ${errorMessage(err)}` };
    }
    if (r.filesMissingSource.length) {
      const detail = r.filesMissingSource
        .map((f) => `  - ${f.source} -> ${f.target}`)
        .join("\n");
      await rollbackAll();
      return {
        error:
          `[${targetId}] provides.files entries whose source does not exist in the package:\n${detail}`,
      };
    }
    merged.symlinks.push(...r.record.symlinks);
    merged.shims.names.push(...r.record.shims.names);
  }

  return { symlinks: merged, launchd, systemd };
}

/**
 * Run the preinstall phase: single-script `scripts.preinstall` first, then
 * the ordered `lifecycle.preinstall` array (arc#140). Both shapes may be
 * present on the same manifest; arc runs them in that order.
 *
 * Called BEFORE any symlinks are created — a failure here leaves no
 * partial filesystem state to roll back, so the caller just returns the
 * error directly.
 */
function runPreinstallPhase(
  installPath: string,
  manifest: ArcManifest,
  quiet?: boolean,
): InstallResult {
  if (manifest.scripts?.preinstall) {
    const result = runScript({
      installPath,
      scriptPath: manifest.scripts.preinstall,
      hookName: "preinstall",
      quiet,
    });
    if (!result.success && !result.skipped) {
      return {
        success: false,
        error: `Preinstall script failed (exit ${result.exitCode})`,
      };
    }
  }

  const lifecycle = manifest.lifecycle?.preinstall;
  if (lifecycle && lifecycle.length > 0) {
    const result = runLifecycleScripts({
      installPath,
      scriptPaths: lifecycle,
      phase: "preinstall",
      quiet,
    });
    if (!result.success) {
      return {
        success: false,
        error: `Preinstall lifecycle script failed: ${result.failedAt} (exit ${result.steps.at(-1)?.exitCode ?? "?"})`,
      };
    }
  }

  return { success: true };
}

/**
 * Parse a version suffix from a name-based install input.
 * e.g., "MySkill@1.2.0" → { name: "MySkill", version: "1.2.0" }
 * Returns null if no @ version suffix is present.
 */
export function parseNameVersion(input: string): { name: string; version: string } | null {
  // Don't parse URLs (contain ://) or scoped refs (@scope/name)
  if (input.includes("://") || input.startsWith("@") || input.startsWith("git@")) return null;

  const atIndex = input.lastIndexOf("@");
  if (atIndex <= 0) return null;

  const name = input.slice(0, atIndex);
  const version = input.slice(atIndex + 1);

  // Validate version looks like semver (digits and dots, with optional v prefix)
  if (!/^v?\d+\.\d+/.test(version)) return null;

  return { name, version: version.replace(/^v/, "") };
}

/**
 * Checkout a pinned git ref in a cloned repo (arc#387). `ref` builds a
 * candidate list via pinRefCandidates() (src/lib/pin-ref.ts): a
 * semver-shaped value tries tag "v{x}" then "{x}" — byte-identical to
 * arc's pre-#387 tag-only behaviour, a compatibility contract — while
 * anything else (a branch, a full/short commit SHA, a non-semver tag) is
 * tried exactly once, verbatim, with no `v`-stripping and no prefixing.
 *
 * Every `git checkout` call passes a trailing `--` (post-#387 review
 * finding, HIGH) to force `<candidate>` to resolve as a revision, never a
 * pathspec. Without it, `git checkout <arg>` silently accepts an `<arg>`
 * that isn't a ref at all but IS a path in the working tree — it
 * reinterprets it as a pathspec restore ("Updated 0 paths from the
 * index"), exits 0, and leaves HEAD untouched. Pre-#387 the semver-only
 * regex made a filename collision unlikely; once any string is a
 * candidate, `--pin arc-manifest.yaml` (a file every arc package ships at
 * its repo root) — or `docs`, `src`, `test` — would silently "succeed"
 * while installing whatever the default branch happened to be, printing a
 * specific, plausible-looking pinned commit that was never actually
 * checked out. `git checkout <ref> --` fails loudly (`fatal: invalid
 * reference`, exit 128) instead. This was checked against a pre-check
 * alternative (`git rev-parse --verify "<ref>^{commit}"` before checkout)
 * and rejected: `rev-parse` does NOT perform checkout's own
 * remote-tracking-branch DWIM (a bare branch name that exists only as
 * `origin/<branch>` post-clone — i.e. every branch except whichever one
 * HEAD happened to point at when cloned — fails to resolve under
 * `rev-parse`), so that approach silently broke branch pinning. `--` keeps
 * `git checkout` itself as the resolver, so its DWIM is untouched, and
 * only strips pathspec fallback.
 */
function checkoutPinnedRef(
  repoPath: string,
  ref: string,
): { success: boolean; ref?: string; error?: string } {
  const candidates = pinRefCandidates(ref);
  const semverShaped = isSemverShapedRef(ref);

  for (const candidate of candidates) {
    const result = Bun.spawnSync(
      ["git", "checkout", candidate, "--"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode === 0) {
      // Record what was actually pinned, and warn that it won't survive
      // `arc upgrade` (arc#387 — arc has nowhere to record a non-tag pin;
      // see the issue's "Interaction with arc#272 / #371 / PR #308").
      // Skipped for the semver/tag path: the resolved ref there IS a
      // release tag, which `arc upgrade` already understands.
      if (!semverShaped) {
        const shaResult = Bun.spawnSync(
          ["git", "rev-parse", "--short", "HEAD"],
          { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
        );
        const shortSha = shaResult.exitCode === 0 ? shaResult.stdout.toString().trim() : "unknown";
        process.stderr.write(`arc: pinned to ${candidate} (${shortSha})\n`);
        process.stderr.write(
          `arc: WARN — ${candidate} is an install-time pin only; \`arc upgrade <name>\` will move this checkout. Re-run \`arc install --pin\` to return to a specific ref.\n`,
        );
      }
      return { success: true, ref: candidate };
    }
  }

  // List available tags for a helpful error.
  const tagList = Bun.spawnSync(
    ["git", "tag", "--list", "--sort=-v:refname"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const tags = tagList.stdout.toString().trim().split("\n").filter(Boolean).slice(0, 5);

  if (semverShaped) {
    // Preserve the pre-#387 error string verbatim — asserted by
    // test/commands/install.test.ts ("fails when pinned version tag does
    // not exist").
    const [vTag, plainTag] = candidates;
    const available = tags.length ? ` Available: ${tags.join(", ")}` : "";
    return {
      success: false,
      error: `Version ${ref} not found (tried tags ${vTag}, ${plainTag}).${available}`,
    };
  }

  // Non-semver miss: also surface branches, since a ref this shape is at
  // least as likely to be a branch as a tag.
  const branchList = Bun.spawnSync(
    ["git", "branch", "-r", "--format=%(refname:short)"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  const branches = branchList.stdout.toString().trim().split("\n").filter(Boolean).slice(0, 5);

  const availableParts: string[] = [];
  if (tags.length) availableParts.push(`tags: ${tags.join(", ")}`);
  if (branches.length) availableParts.push(`branches: ${branches.join(", ")}`);
  const available = availableParts.length ? ` Available ${availableParts.join("; ")}.` : "";

  return {
    success: false,
    error: `Ref "${ref}" not found in the cloned repo (not a branch, tag, or commit).${available}`,
  };
}
