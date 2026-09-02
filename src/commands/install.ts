import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
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
import {
  BASH_UNRESTRICTED,
  capabilityRows,
  getSkill,
  recordedCapabilityRows,
  removeSkill,
  replaceCapabilities,
} from "../lib/db.js";
import { dirtyWorktreeEntries, restoreHead } from "../lib/git-tree.js";
import { runScript, runLifecycleScripts } from "../lib/scripts.js";
import { satisfiesRange } from "../lib/semver.js";
import { isSafePinRef, isSemverShapedRef, pinRefCandidates } from "../lib/pin-ref.js";
import {
  type ArtifactSymlinkRecord,
  artifactDropPresent,
  createArtifactSymlinks,
  installNodeDependencies,
  reportNodeDependencyResult,
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
// arc#400 (docs/design-factory-type.md D2/D4/D5) — REFERENCE-COMPOSITION
// install. The trust logic (validation, the tools gate, D2 aggregation, the
// combined review, D5's tier MIN) lives in lib/composition.ts, which owns no
// git, no network and no database so every refusal is assertable without any
// of the three. This file supplies the seams it needs: the host-binary probe,
// the reference resolver (registry or repo), the confirmation channel, and the
// member installer — the last of which is `install()` itself, which is exactly
// why composition.ts must not import it back.
import {
  type CompositionPlan,
  type CompositionSeams,
  type PackageReference,
  type ReferenceResolver,
  type ResolvedCompositionMember,
  type ToolProbe,
  compositionRecordFor,
  installCompositionMembers,
  isCompositionType,
  prepareComposition,
} from "../lib/composition.js";
import {
  beginComposition,
  completeComposition,
  compositionsReferencing,
  markCompositionMemberLanded,
} from "../lib/db.js";
// arc#401 D6 — the install-time inventory snapshot is built from the SAME walk
// `arc files` prints, so the record and the command cannot drift. files.ts is a
// leaf w.r.t. install.ts (it reads the DB and the manifest; it installs
// nothing), so this import introduces no cycle.
import { recordCompositionSnapshot } from "./files.js";
import { loadSources } from "../lib/sources.js";
import { fetchAndVerifyRegistryPackage, parsePackageRef } from "../lib/registry-install.js";

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
  /**
   * arc#400 — reference-composition seams (`type: bundle` / `type: factory`).
   *
   * Production leaves this absent: `defaultCompositionSeams()` supplies a real
   * host-binary probe, a registry/git reference resolver, the stdin
   * confirmation, and `install()` itself as the member installer. Tests inject
   * replacements so every refusal on the trust path — a range pin, a missing
   * tool, a member manifest that fails validation, a declined review — is
   * provable WITHOUT a network, a registry, or a real clone, and so "no member
   * landed" can be asserted by counting installer calls rather than trusted.
   *
   * Individually optional: a test that only needs a stub probe leaves the rest
   * to the defaults.
   */
  composition?: CompositionSeams;
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
  /**
   * arc#396: the package was already installed and a `--pin` ref was given, so
   * the existing checkout was MOVED to that ref (see `repinInstalledCheckout`).
   * Mutually exclusive with `alreadyInstalled`: something changed on disk, so
   * the caller must not print "nothing to do". `from`/`to` are full commit
   * SHAs; they are equal when only HEAD's identity changed (detached →
   * branch), which is still a move.
   */
  repinned?: { ref: string; from: string; to: string };
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

  // Pin-ref injection guard, at the library boundary (arc#396 review, S3).
  // The CLI checks this too, but the CLI is one of several callers — the
  // dependency loop, `arc upgrade`, and tests all reach install() directly,
  // and every branch below hands `pinnedRef` to `git` eventually. Defence in
  // depth: the value never becomes argv without passing this.
  if (opts.pinnedRef && !isSafePinRef(opts.pinnedRef)) {
    return {
      success: false,
      error: `Invalid pin ref "${opts.pinnedRef}": must not start with '-' or contain whitespace or '..'.`,
    };
  }

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
      .all() as { name: string; version: string; status: string; repo_url: string; install_path: string; library_name: string | null }[];

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
        // arc#396: a re-run carrying --pin is NOT a no-op — it is a request to
        // move this checkout to that ref, exactly as the README promises.
        return await repinOrNoop(existingByUrl, opts);
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
        // success (or an arc#396 re-pin when --pin is given); disabled →
        // actionable error.
        if (existingByPath.status === "active") {
          return await repinOrNoop(existingByPath, opts);
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

  // 2a''. COMPOSITION GATE (arc#400, docs/design-factory-type.md D2/D4/D5).
  //
  // For `type: bundle` / `type: factory`, everything that can REFUSE runs here,
  // before a single member lands: the manifest's composition declarations are
  // validated (a range pin is a loud error — D4, at install and not only at
  // publish), the declared `tools:` are checked against the host, every
  // reference is resolved and every member manifest read, the combined
  // capability surface is computed (D2), the tier MIN is re-checked (D5), and
  // ONE confirmation is asked.
  //
  // Placed BEFORE step 2b and before the factory's own landing on purpose: on
  // any refusal below, this function returns having installed nothing at all —
  // not the members, not the composition. That is D2's honesty rule, and it is
  // only reachable because resolution and installation are separate phases.
  let compositionPlan: CompositionPlan | undefined;
  if (isCompositionType(manifest.type)) {
    // Self-heal any `.compose-*` scratch left by a previous crashed run before
    // staging anything new (W3).
    await sweepOrphanedStagingDirs(arc.reposDir);

    const prepared = await prepareComposition({
      manifest,
      seams: defaultCompositionSeams(opts),
      yes: opts.yes,
    });
    if (!prepared.ok) {
      // W3: staged bytes never outlive the refusal that rejected them.
      await sweepStagedMembers(prepared.staged);
      if (!opts.preExtractedPath) {
        await rm(installPath, { recursive: true, force: true }).catch(() => {
          /* best-effort; the refusal is the error worth surfacing */
        });
      }
      return { success: false, error: prepared.error };
    }
    compositionPlan = prepared.plan;
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

  // 2b'. Install the composition's MEMBERS (arc#400 D2).
  //
  // Every refusal has already had its chance in the 2a'' gate, and the operator
  // has approved the combined surface exactly once. A failure here is a member
  // failing at RUNTIME (a postinstall exiting non-zero, a broker that vanished)
  // — not a trust decision — so it propagates the same way a failed
  // `depends_on.packages` dependency does: loud, naming the member, with the
  // members that already landed left for `arc remove` to take down. Unwinding a
  // partially-installed composition is the lifecycle slice's job (arc#401, D6).
  if (compositionPlan?.members.length) {
    const seams = defaultCompositionSeams(opts);

    // F3: OPEN the composition record before the first member lands. From here
    // an interruption — a kill, a member failing at runtime — is visible as an
    // incomplete composition rather than as anonymous member packages and no
    // trace of the factory. See the `compositions` schema comment in db.ts.
    beginComposition(
      db,
      manifest.name,
      manifest.version,
      compositionRecordFor(compositionPlan),
    );

    const membersResult = await installCompositionMembers(compositionPlan, seams.installMember, {
      yes: opts.yes,
      log: seams.log,
      warn: seams.warn,
      // F2: the surface arc RECORDS for a landed member, checked against the
      // surface the operator approved. Bound here because composition.ts owns
      // no database, deliberately.
      recordedRowsFor: (name) => recordedCapabilityRows(db, name),
      reviewedRowsFor: (member) => capabilityRows(member.manifest),
      // arc#401 D6: record not just THAT the member is dealt with, but whether
      // this composition put it there. A member that was ALREADY installed is
      // `preexisting` — unless another COMPOSITION is what installed it, in
      // which case that referent is already tracked in `composition_members`
      // and marking it here too would make the member immortal: retained by
      // the pre-existing rule long after the other composition is gone, in
      // defiance of D3's "falls with the last referent".
      onMemberLanded: (member, landedName, alreadyInstalled) => {
        const recordedName = landedName ?? member.reference.name;
        const trackedElsewhere =
          compositionsReferencing(db, recordedName, { exclude: manifest.name }).length > 0;
        markCompositionMemberLanded(
          db,
          manifest.name,
          member.reference.name,
          alreadyInstalled && !trackedElsewhere ? "preexisting" : "landed",
        );
      },
    });
    if (!membersResult.success) {
      // The record stays `pending`, naming exactly which members landed — that
      // IS the report. Staged bytes for members that never landed are swept.
      await sweepStagedMembers(
        compositionPlan.members.filter((m) => !membersResult.landed.includes(m.reference.name)),
      );
      return { success: false, error: membersResult.error };
    }
  }

  // 3. Display capabilities
  const risk = assessRisk(manifest);
  const capLines = formatCapabilities(manifest);

  // A composition whose combined review already ran does NOT get a second,
  // narrower capability display: the composition's own manifest declares no
  // surface (that is the whole point of the arc#399 presence exemption), so
  // printing an empty "Capabilities:" block under it would read as "this
  // installs nothing" moments after the operator approved the union. The
  // combined review IS this package's capability display.
  if (!opts.yes && !compositionPlan?.reviewed) {
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

  // arc#400 — RECORD THE COMPOSITION. Runs immediately after the transaction
  // commits, because that commit is what creates the `skills` row this
  // membership hangs off (FK, ON DELETE CASCADE): recording earlier would
  // violate the constraint, and recording later risks a step in between
  // returning first and leaving a composition installed but unrecorded.
  //
  // Written for arc#401 to consume — see the `composition_members` schema
  // comment in lib/db.ts. The membership itself was written by
  // `beginComposition` before the members landed (F3); this is the CLOSE that
  // flips the record from `pending` to `complete`, and it is the only thing
  // that distinguishes a finished composition from an interrupted one.
  if (compositionPlan?.members.length) {
    completeComposition(db, manifest.name);
    // arc#401 D6 — and TAKE THE INVENTORY SNAPSHOT. The composition is now
    // fully landed, so `arc files` can see the whole footprint: the factory's
    // own manifest install plus every member's. That union is what `arc purge`
    // must account for, and the snapshot is what the post-purge diff is
    // measured against. Best-effort: a snapshot that cannot be taken must not
    // fail an install that has already succeeded, but it IS said out loud,
    // because a composition with no snapshot has no untangle proof.
    await recordCompositionSnapshot(db, arc, host, manifest.name).catch((err: unknown) => {
      process.stderr.write(
        `  ⚠ could not record the install-time inventory for '${manifest.name}': ${errorMessage(err)}; ` +
          `\`arc purge ${manifest.name}\` will still cascade, but cannot verify the untangle (arc#401 D6)\n`,
      );
    });
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

/** Run a git command in `repoPath`, returning trimmed stdout (empty on failure). */
function gitOut(repoPath: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

/** Does `rev` exist in `repoPath`? */
function refExists(repoPath: string, rev: string): boolean {
  return (
    Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", rev], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode === 0
  );
}

/**
 * Compare two repo URLs for "same repo" purposes.
 *
 * Deliberately shallow — trailing slash and a `.git` suffix are the two
 * differences that mean nothing, and everything else (host, owner, path) is
 * treated as significant. A looser comparison here would re-open the confused
 * deputy this normalisation exists to close.
 */
function sameRepoUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "").replace(/\.git$/, "");
  return norm(a) === norm(b);
}

/**
 * Resolve a `--pin` ref to a commit SHA inside an EXISTING checkout, without
 * moving HEAD (arc#396).
 *
 * `origin/<candidate>` is tried BEFORE the bare candidate. That order is the
 * fix for the stale-ref class the arc#396 review found: after a fetch, the
 * remote-tracking ref is the freshest thing in the repo, while a bare local
 * BRANCH name still resolves to whatever the last checkout left behind. Tags
 * do not live under `origin/`, so for a tag pin the first probe simply misses
 * and the (force-updated) local tag answers — which is why the fetch that
 * precedes this must pass `--force`.
 *
 * `git rev-parse` does NOT perform `git checkout`'s remote-tracking DWIM, so
 * probing `origin/<candidate>` also covers a branch that exists only on the
 * remote post-clone. `^{commit}` keeps the arc#387 pathspec collision closed:
 * a `--pin` value naming a file resolves to nothing.
 *
 * `tagSha` is reported alongside so the caller can detect the one case this
 * ordering cannot decide: a tag and a branch sharing a name but not a commit.
 * `git checkout <name>` prefers the TAG while this resolver prefers the
 * branch, and every guard downstream runs on what this returns — so an
 * undetected disagreement means the guards validate one commit while another
 * lands (arc#396 review, F6). The caller refuses instead of guessing.
 *
 * Returns null when nothing resolves — the caller then hands the ref to
 * `checkoutPinnedRef`, which owns the loud, ref-listing error message.
 */
function resolvePinCommit(
  repoPath: string,
  ref: string,
): {
  candidate: string;
  sha: string;
  isBranch: boolean;
  originSha: string | null;
  tagSha: string | null;
} | null {
  for (const candidate of pinRefCandidates(ref)) {
    const originSha = gitOut(repoPath, "rev-parse", "--verify", "--quiet", `origin/${candidate}^{commit}`);
    const localSha = gitOut(repoPath, "rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
    const sha = originSha || localSha;
    if (!sha) continue;
    const isBranch =
      refExists(repoPath, `refs/heads/${candidate}`) ||
      refExists(repoPath, `refs/remotes/origin/${candidate}`);
    const tagSha = gitOut(repoPath, "rev-parse", "--verify", "--quiet", `refs/tags/${candidate}^{commit}`);
    return { candidate, sha, isBranch, originSha: originSha || null, tagSha: tagSha || null };
  }
  return null;
}

/**
 * Read and fully validate the manifest committed at `sha`, without touching
 * the working tree (arc#396 review, F1).
 *
 * Materialises the manifest candidates into a scratch dir and runs the real
 * `readManifest`, so schema folding, capability normalisation, and every
 * type-specific validation apply exactly as they would after a checkout. The
 * point is to be able to REFUSE before moving: a consent gate that fires after
 * the state has already changed is not a gate.
 */
async function readManifestAtRef(
  repoPath: string,
  sha: string,
): Promise<ArcManifest | null> {
  const candidates = [
    "arc-manifest.yaml",
    "pai-manifest.yaml",
    "agent/arc-manifest.yaml",
    "agent/pai-manifest.yaml",
  ];
  const scratch = await mkdtemp(join(tmpdir(), "arc-repin-manifest-"));
  try {
    let found = false;
    for (const rel of candidates) {
      const show = Bun.spawnSync(["git", "show", `${sha}:${rel}`], {
        cwd: repoPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (show.exitCode !== 0) continue;
      await Bun.write(join(scratch, rel), show.stdout);
      found = true;
    }
    if (!found) return null;
    return await readManifest(scratch);
  } catch {
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {
      /* scratch dir; best-effort */
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// arc#400 — the composition seams (docs/design-factory-type.md D2/D4)
// ───────────────────────────────────────────────────────────────────────────

/** First semver-shaped token in a `--version` banner, or undefined. */
function parseToolVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

/**
 * The real host-binary probe behind a factory's `tools:` gate.
 *
 * Presence is `Bun.which` — the same PATH the postinstall scripts will see.
 * The version is read by running `<binary> --version`, best-effort: a binary
 * that has no `--version`, prints to stderr, or times out yields no version,
 * and `checkTools` then WARNs rather than refusing (its documented fail-open
 * split). The 5s timeout exists because `tools:` names third-party binaries
 * and an install must not hang on one that waits for input.
 */
export function defaultToolProbe(name: string): ReturnType<ToolProbe> {
  const path = Bun.which(name);
  if (!path) return { found: false };

  try {
    const probe = Bun.spawnSync([path, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    });
    const output = `${probe.stdout.toString()}\n${probe.stderr.toString()}`;
    return { found: true, path, version: parseToolVersion(output) };
  } catch {
    return { found: true, path };
  }
}

/**
 * Resolve one `references[]` entry to a staged member — WITHOUT landing it.
 *
 * Two paths, matching arc's two existing install sources:
 *
 *   - REGISTRY (`@scope/name`): the full verified pipeline
 *     (`fetchAndVerifyRegistryPackage` — resolve, download, SHA-256, registry
 *     signature, Sigstore, extract). The extracted dir is carried on the
 *     resolved member as `preExtractedPath`, so the member installer hands the
 *     SAME verified bytes to `install()` rather than downloading them twice.
 *     A member is therefore verified exactly once, before the operator is asked
 *     anything — which is what makes "abort before any member lands" affordable.
 *
 *   - REPO (`repo:` URL): a SHALLOW clone at the tag for the pinned version,
 *     into a scratch dir outside `reposDir`, purely to read the manifest. The
 *     scratch dir is removed before returning; the member installer then does
 *     the ordinary `install({ repoUrl, pinnedRef })`, so a repo member goes
 *     through the identical clone/checkout/validate path a hand-typed
 *     `arc install <url> --pin <v>` takes. Yes, that clones twice; it buys the
 *     honesty rule (nothing lands until every member has validated) without
 *     duplicating install()'s clone semantics here. See the residual-risk note
 *     on arc#400.
 *
 * `pinRefCandidates` gives the tag candidates (`v1.2.0` then `1.2.0`), the same
 * grammar `--pin` uses, so a factory pin and a hand-typed pin resolve alike.
 */
export function createReferenceResolver(ctx: {
  arc: ArcPaths;
}): ReferenceResolver {
  return async (reference: PackageReference) => {
    return reference.repo
      ? resolveRepoReference(reference, reference.repo)
      : resolveRegistryReference(reference, ctx.arc);
  };
}

async function resolveRegistryReference(
  reference: PackageReference,
  arc: ArcPaths,
): Promise<{ ok: true; member: ResolvedCompositionMember } | { ok: false; error: string }> {
  const ref = parsePackageRef(`${reference.name}@${reference.version}`);
  if (!ref) {
    return {
      ok: false,
      error: `'${reference.name}' is not a resolvable registry reference (expected '@scope/name') and declares no 'repo:' URL.`,
    };
  }

  const sources = await loadSources(arc.sourcesPath);
  // A scratch name under reposDir — the same convention the upgrade path uses
  // for a verified re-download it has not committed to yet.
  const targetDirName = `.compose-${ref.scope}__${ref.name}@${reference.version}`;
  const fetched = await fetchAndVerifyRegistryPackage({
    ref,
    sources: sources.sources,
    reposDir: arc.reposDir,
    targetDirName,
  });
  if (!fetched.success || !fetched.extractedPath) {
    return { ok: false, error: fetched.error ?? "registry fetch failed" };
  }

  let manifest: ArcManifest | null;
  try {
    manifest = await readManifest(fetched.extractedPath);
  } catch (err) {
    await rm(fetched.extractedPath, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: `manifest is invalid: ${errorMessage(err)}` };
  }
  if (!manifest) {
    await rm(fetched.extractedPath, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: "package contains no arc-manifest.yaml" };
  }

  return {
    ok: true,
    member: {
      reference,
      manifest,
      source: "registry",
      ref: `@${ref.scope}/${ref.name}`,
      preExtractedPath: fetched.extractedPath,
    },
  };
}

/**
 * Resolve a `repo:` member: shallow-clone at the tag for the pinned version,
 * read its manifest, and pin the member install to the resolved COMMIT.
 *
 * ## Why the pin is a SHA, not the tag (arc#400 review, F2)
 *
 * A tag is a mutable label. Consent is read here, from a scratch clone; the
 * member then lands from a SECOND, independent clone. Handing that second clone
 * the tag NAME reopens the window between them: `git tag -f v1.0.0` in between
 * and the operator approves one commit while a different one installs. The
 * version-equality check does not close it — that compares a number in a
 * manifest, and the attacker controls the manifest too.
 *
 * So the candidate tag is used only to FIND the commit; what travels onward is
 * `git rev-parse HEAD`, and consent is bound to the bytes rather than to the
 * label that happened to point at them. `install()` resolves and checks out
 * commit SHAs robustly (arc#396/#403), so this costs nothing but the extra
 * `rev-parse`. `installCompositionMembers` then verifies the landed surface
 * against the reviewed one as a second, route-independent check.
 *
 * Exported for the moved-tag regression test, which runs this real resolver and
 * moves the tag between resolution and landing.
 */
export async function resolveRepoReference(
  reference: PackageReference,
  repoUrl: string,
): Promise<{ ok: true; member: ResolvedCompositionMember } | { ok: false; error: string }> {
  const candidates = pinRefCandidates(reference.version);
  const scratch = await mkdtemp(join(tmpdir(), "arc-compose-"));
  const checkout = join(scratch, "pkg");

  try {
    let cloned = false;
    let lastError = "";
    for (const candidate of candidates) {
      const result = Bun.spawnSync(
        ["git", "clone", "--depth", "1", "--branch", candidate, repoUrl, checkout],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (result.exitCode === 0) {
        cloned = true;
        break;
      }
      lastError = result.stderr.toString().trim();
      await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
    }

    if (!cloned) {
      return {
        ok: false,
        error:
          `no tag for the pinned version ${reference.version} in ${repoUrl} ` +
          `(tried ${candidates.join(", ")}) — a factory member must be reachable at its exact pin (D4). ${lastError}`,
      };
    }

    // The commit the review is about. From here the tag is irrelevant.
    const revParse = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: checkout,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (revParse.exitCode !== 0) {
      return {
        ok: false,
        error: `could not resolve a commit for ${reference.version} in ${repoUrl}: ${revParse.stderr.toString().trim()}`,
      };
    }
    const pinnedRef = revParse.stdout.toString().trim();

    let manifest: ArcManifest | null;
    try {
      manifest = await readManifest(checkout);
    } catch (err) {
      return { ok: false, error: `manifest is invalid: ${errorMessage(err)}` };
    }
    if (!manifest) {
      return { ok: false, error: `no arc-manifest.yaml at ${repoUrl}` };
    }

    return {
      ok: true,
      member: { reference, manifest, source: "repo", ref: repoUrl, pinnedRef },
    };
  } finally {
    // Staging is not landing: the scratch checkout exists only so the member's
    // manifest can be validated before the operator is asked anything, and it
    // never outlives this call.
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The scratch prefix every staged composition member is extracted under. */
const COMPOSE_STAGING_PREFIX = ".compose-";

/**
 * Delete the staged directories a set of resolved members is holding
 * (arc#400 review, W3).
 *
 * Staging places bytes but nothing else — no symlink, no DB row, no host drop —
 * so a refusal after staging still satisfies the honesty rule. It does leave
 * the bytes, though, and bytes a refusal leaves behind are the next run's
 * confusing state. Best-effort: a sweep failure must never mask the refusal
 * that caused it.
 */
async function sweepStagedMembers(members: readonly ResolvedCompositionMember[]): Promise<void> {
  for (const member of members) {
    if (!member.preExtractedPath) continue;
    await rm(member.preExtractedPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Remove `.compose-*` leftovers in `reposDir` before staging anything new.
 *
 * `sweepStagedMembers` handles every refusal arc controls; this handles the one
 * it does not — a crash or a kill mid-resolution. Same self-healing posture as
 * `pruneKnownDeadSources` (sources.ts): the mess clears itself on the next run
 * instead of needing a documented manual step. Safe because a staged dir is
 * scratch by construction and concurrent composition installs are not a
 * supported scenario.
 */
async function sweepOrphanedStagingDirs(reposDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(reposDir);
  } catch {
    return; // reposDir may not exist yet
  }
  for (const entry of entries) {
    if (!entry.startsWith(COMPOSE_STAGING_PREFIX)) continue;
    await rm(join(reposDir, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Install one resolved member through the ORDINARY install path.
 *
 * `installPackageDependencies` established the pattern (arc#306): a package
 * arc pulls in on another's behalf goes through the same `install()` every
 * hand-typed install does, so it gets the same duplicate guards, the same
 * broker gate, the same secrets/identity/postinstall steps, and the same DB
 * bookkeeping. A composition member is that, with the reference's pin threaded
 * through — no second installer to keep in step.
 *
 * `yes: true` unconditionally: the operator has ALREADY approved this member's
 * capabilities, as part of the one combined review D2 promises. Re-prompting
 * per member here is precisely the death-by-a-thousand-confirmations the
 * combined review exists to prevent.
 *
 * ## The staging rename (arc#400 review, W2)
 *
 * A registry member is verified into `.compose-<scope>__<name>@<version>` — a
 * scratch name, so a refusal mid-resolution leaves something obviously
 * sweepable rather than something that looks installed. Immediately before it
 * is handed to `install()` it is renamed to `<scope>__<name>`, the SAME name
 * `arc install @scope/name` extracts to. Two reasons: a version-stamped install
 * directory goes stale the moment the member is upgraded (arc#401 walks these
 * paths and would find a directory whose name disagrees with the version
 * installed in it), and a member installed as part of a composition should be
 * indistinguishable on disk from the same member installed by hand.
 */
function createMemberInstaller(ctx: {
  arc: ArcPaths;
  host: HostAdapter;
  db: Database;
  hostOverrides?: HostOverrides;
}) {
  return async (member: ResolvedCompositionMember) => {
    let preExtractedPath = member.preExtractedPath;

    if (preExtractedPath) {
      const ref = parsePackageRef(`${member.ref}@${member.reference.version}`);
      if (ref) {
        const target = join(ctx.arc.reposDir, `${ref.scope}__${ref.name}`);
        if (target !== preExtractedPath) {
          // A pre-existing dir here is a stale extract for the same package —
          // install()'s duplicate guards (which run after this, on the DB) are
          // what protect a real install; an orphan directory is just debris.
          await rm(target, { recursive: true, force: true }).catch(() => undefined);
          try {
            await rename(preExtractedPath, target);
            preExtractedPath = target;
            member.preExtractedPath = target; // keep the sweep pointed at reality
          } catch {
            // Rename failed (cross-device, permissions). The staged dir is still
            // a perfectly good source; carry on with the scratch name rather
            // than failing an install over a cosmetic path.
          }
        }
      }
    }

    const result = await install({
      arc: ctx.arc,
      host: ctx.host,
      db: ctx.db,
      repoUrl: preExtractedPath ? `${member.ref}@${member.reference.version}` : member.ref,
      yes: true,
      preExtractedPath,
      pinnedRef: preExtractedPath ? undefined : member.pinnedRef,
      hostOverrides: ctx.hostOverrides,
    });
    return {
      success: result.success,
      error: result.error,
      name: result.name,
      version: result.version,
      alreadyInstalled: result.alreadyInstalled,
    };
  };
}

/**
 * Present the ONE combined capability review and read the operator's answer.
 *
 * Same channel and same posture as `confirmCapabilityWidening`: an explicit
 * `y` approves, everything else (including a non-TTY, which `readConsentLine`
 * answers with "") refuses. The CLI's own non-TTY guard means an operator
 * normally never reaches this without `--yes`; the refusal here is the
 * defence-in-depth half, for the callers that reach `install()` directly.
 */
async function defaultCompositionConfirm(reviewLines: string[]): Promise<boolean> {
  for (const line of reviewLines) console.log(line);
  process.stdout.write("\nInstall this composition and all its members? [y/N] ");
  const answer = (await readConsentLine()).trim().toLowerCase();
  return answer === "y";
}

/** Fill any seam the caller left open with its production implementation. */
function defaultCompositionSeams(
  opts: InstallOptions,
): Required<Pick<CompositionSeams, "probe" | "resolve" | "confirm" | "installMember">> &
  CompositionSeams {
  const provided = opts.composition ?? {};
  return {
    ...provided,
    probe: provided.probe ?? defaultToolProbe,
    resolve: provided.resolve ?? createReferenceResolver({ arc: opts.arc }),
    confirm: provided.confirm ?? defaultCompositionConfirm,
    installMember:
      provided.installMember ??
      createMemberInstaller({
        arc: opts.arc,
        host: opts.host,
        db: opts.db,
        hostOverrides: opts.hostOverrides,
      }),
  };
}

/** Read one line from stdin; "" when there is no TTY to read from. */
function readConsentLine(): Promise<string> {
  if (!process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setEncoding("utf-8");
    stdin.resume();
    stdin.once("data", (data: string) => {
      stdin.pause();
      resolve(data);
    });
  });
}

/**
 * Consent gate for a re-pin that WIDENS the recorded capability surface
 * (arc#396 review, F1 / W1).
 *
 * A pinned move is a code swap, and code at a different ref can declare
 * capabilities the operator never approved. arc's fresh install shows the
 * surface before landing anything; a move that silently inherits the old
 * approval would let `--pin` be the way around consent.
 *
 * Runs BEFORE the checkout — deliberately. The alternative (move, then ask,
 * then roll back on refusal) changes state before consent and leaves a window
 * where a crash strands the operator at an unapproved ref.
 *
 * Non-TTY without `--yes` reads "" and refuses, matching the install-time
 * posture (`readLine` in install-transaction.ts, and the CLI's own non-TTY
 * guard). Narrowing or unchanged surfaces never ask.
 */
async function confirmCapabilityWidening(opts: {
  name: string;
  pinnedRef: string;
  db: Database;
  manifest: ArcManifest;
  yes?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const { name, pinnedRef, db, manifest, yes } = opts;

  const recordedRows = recordedCapabilityRows(db, name);
  const recorded = new Set(recordedRows.map((r) => `${r.type}:${r.value}`));
  const incoming = capabilityRows(manifest);

  // An already-granted UNRESTRICTED bash subsumes any set of restricted bash
  // commands, so re-restricting is a narrowing even though the rows change
  // (arc#396 review, F7). Without this the mirror image of the de-restriction
  // fix would prompt on every restriction — and a gate that fires on
  // improvements teaches operators to wave it through.
  const hadUnrestrictedBash = recorded.has(`bash:${BASH_UNRESTRICTED}`);

  const added = incoming.filter((r) => {
    if (recorded.has(`${r.type}:${r.value}`)) return false;
    if (r.type === "bash" && hadUnrestrictedBash) return false;
    return true;
  });
  if (added.length === 0) return { ok: true };

  const addedLines = added.map((r) => `  + ${r.type}: ${r.value}${r.reason ? ` — ${r.reason}` : ""}`);

  if (yes) {
    // Approved non-interactively, but still put the widened surface on the
    // record — an operator reading a CI log must be able to see what changed.
    process.stderr.write(
      `arc: '${name}' at ${pinnedRef} widens its capabilities:\n${addedLines.join("\n")}\n`,
    );
    return { ok: true };
  }

  console.log(`\n⚠️  Re-pinning '${name}' to ${pinnedRef} WIDENS its capabilities:`);
  for (const line of addedLines) console.log(line);
  console.log(`\nFull capability surface at ${pinnedRef}:`);
  for (const line of formatCapabilities(manifest)) console.log(line);
  console.log(`Risk: ${assessRisk(manifest).toUpperCase()}`);
  process.stdout.write("Allow the widened capabilities? [y/N] ");

  const answer = (await readConsentLine()).trim().toLowerCase();
  if (answer === "y") return { ok: true };

  return {
    ok: false,
    error:
      `Refusing to re-pin '${name}' to ${pinnedRef}: the ref widens the package's capabilities and consent was not given.\n${addedLines.join("\n")}\n` +
      `Nothing was moved. Re-run with --yes to approve non-interactively (an interactive terminal can answer the prompt instead).`,
  };
}

interface RepinOutcome {
  success: boolean;
  error?: string;
  /** True when the checkout's HEAD (commit or branch identity) changed. */
  moved: boolean;
  /** The candidate that resolved/was checked out (e.g. "v2.0.0"). */
  ref?: string;
  from?: string;
  to?: string;
  /** Manifest read at the NEW ref — the version a fresh pinned install records. */
  manifest?: ArcManifest;
}

/**
 * Move an ALREADY-INSTALLED package's checkout to a `--pin` ref (arc#396).
 *
 * Before this, `arc install <repo> --pin <sha>` on an installed package hit
 * the duplicate guard and returned `{success: true, alreadyInstalled: true}`
 * before any git ran — exit 0, success text, checkout untouched. A pinned
 * install is a determinism claim, so that combination is the worst possible
 * answer: automation trusts it. The README's "Pinned installs" section already
 * promised this behaviour ("Re-run `arc install --pin <ref>` to return to a
 * specific ref"), so honour the promise rather than retract it.
 *
 * Order of business, and why:
 *  1. `git fetch --force --tags` — the pin may name a ref minted since the
 *     clone, and a tag may have MOVED. Without `--force`, git refuses to
 *     update an existing local tag, so a re-tagged `v1.0.0` would resolve to
 *     the stale commit and report success: arc#396 again, one layer down. A
 *     fetch failure is NOT fatal (an offline re-pin to an already-local ref
 *     must still work); it is remembered and appended to the error if
 *     resolution then fails, so an offline miss never masquerades as "no such
 *     ref".
 *  2. Resolve the pin to a commit, remote-tracking ref first (see
 *     `resolvePinCommit`), and compare with HEAD. Equal — and, for a branch
 *     pin, already ON that branch — → nothing to do; a dirty tree is not even
 *     consulted, because nothing is going to move.
 *  3. Refuse a dirty tree. `git checkout` would either carry the operator's
 *     edits across the move or fail halfway; arc names the path and stops.
 *  4. Refuse a local branch that has DIVERGED from its origin tip. Landing on
 *     the fetched tip means fast-forwarding the local branch, and a diverged
 *     branch carries local commits that a `reset --hard` would delete.
 *  5. Read + validate the manifest at the target commit and run the
 *     capability-widening consent gate — all BEFORE anything moves.
 *  6. Reuse `checkoutPinnedRef` — the same function the fresh-clone path uses,
 *     so the `--` pathspec guard, the candidate order, and the
 *     install-time-pin warning are identical by construction, not by
 *     duplication. Fast-forward the branch onto the fetched tip afterwards
 *     when the pin named one.
 *  7. Install the new ref's node dependencies, then record the new version and
 *     capability surface. A dependency failure rolls the checkout back rather
 *     than recording a move whose code cannot run.
 */
async function repinInstalledCheckout(opts: {
  name: string;
  installPath: string;
  pinnedRef: string;
  db: Database;
  yes?: boolean;
}): Promise<RepinOutcome> {
  const { name, installPath, pinnedRef, db } = opts;

  if (!existsSync(join(installPath, ".git"))) {
    return {
      success: false,
      moved: false,
      error: `Cannot re-pin '${name}' to ${pinnedRef}: no git checkout at ${installPath}. Run \`arc remove ${name}\` and install again with --pin.`,
    };
  }

  const headBefore = gitOut(installPath, "rev-parse", "HEAD");
  if (!headBefore) {
    return {
      success: false,
      moved: false,
      error: `Cannot re-pin '${name}' to ${pinnedRef}: ${installPath} has no resolvable HEAD.`,
    };
  }
  // Empty when HEAD is detached — restoring to the branch NAME, not the SHA,
  // is what keeps a rollback from silently detaching a tracking branch.
  const branchBefore = gitOut(installPath, "symbolic-ref", "--quiet", "--short", "HEAD");

  // `--force` is the load-bearing flag: a plain `--tags` leaves an existing
  // local tag pointing at its old commit, and repos DO re-tag.
  const fetch = Bun.spawnSync(["git", "fetch", "--quiet", "--force", "--tags"], {
    cwd: installPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const fetchNote =
    fetch.exitCode === 0
      ? ""
      : ` (note: \`git fetch\` failed first — ${fetch.stderr.toString().trim() || `exit ${fetch.exitCode}`})`;

  const target = resolvePinCommit(installPath, pinnedRef);

  // Ambiguous name: a tag and a branch that disagree about which commit they
  // mean (arc#396 review, F6). `git checkout <name>` would take the tag while
  // this resolver takes the branch, so every guard below would validate one
  // object and a different one would land — including the capability consent
  // gate, which is how a wider surface could arrive unapproved. There is no
  // safe guess here: arc names both and asks the operator to say which.
  if (target?.isBranch && target.tagSha && target.tagSha !== target.sha) {
    return {
      success: false,
      moved: false,
      error:
        `Refusing to re-pin '${name}': "${target.candidate}" is ambiguous — it names both a branch (${target.sha.slice(0, 7)}) and a tag (${target.tagSha.slice(0, 7)}). ` +
        `Nothing was moved. Pin the one you mean: \`--pin refs/tags/${target.candidate}\` for the tag, \`--pin refs/heads/${target.candidate}\` for the branch, or pin the commit SHA.`,
    };
  }

  // Already there: same commit AND, when the pin names a branch, already on
  // that branch. Without the branch half, re-pinning a detached checkout to
  // the branch sitting at the same commit would report "already at that ref"
  // while HEAD stayed detached — a different state from a fresh
  // `--pin <branch>` install, and the same silent-mismatch class as arc#396.
  if (target?.sha === headBefore && (!target.isBranch || branchBefore === target.candidate)) {
    return { success: true, moved: false, ref: target.candidate, from: headBefore, to: headBefore };
  }

  const dirty = dirtyWorktreeEntries(installPath);
  if (dirty.length) {
    const shown = dirty.slice(0, 10).join("\n  ");
    const more = dirty.length > 10 ? `\n  …and ${dirty.length - 10} more` : "";
    return {
      success: false,
      moved: false,
      error:
        `Refusing to re-pin '${name}' to ${pinnedRef}: ${installPath} has uncommitted changes.\n  ${shown}${more}\n` +
        `Commit, stash, or discard them — or \`arc remove ${name}\` for a clean pinned re-install — then re-run \`arc install --pin ${pinnedRef}\`.`,
    };
  }

  // Landing on the fetched tip of a branch pin moves the local branch. That is
  // only safe while the local branch is an ANCESTOR of the origin tip — a
  // diverged branch carries local commits, and destroying an operator's work
  // as a side effect of a re-pin is the same trust break as moving a dirty
  // tree.
  if (target?.isBranch && target.originSha && refExists(installPath, `refs/heads/${target.candidate}`)) {
    const localSha = gitOut(installPath, "rev-parse", "--verify", "--quiet", `refs/heads/${target.candidate}`);
    if (localSha && localSha !== target.originSha) {
      const isAncestor =
        Bun.spawnSync(
          ["git", "merge-base", "--is-ancestor", localSha, target.originSha],
          { cwd: installPath, stdout: "pipe", stderr: "pipe" },
        ).exitCode === 0;
      if (!isAncestor) {
        return {
          success: false,
          moved: false,
          error:
            `Refusing to re-pin '${name}' to ${target.candidate}: the local branch (${localSha.slice(0, 7)}) has diverged from origin/${target.candidate} (${target.originSha.slice(0, 7)}) — moving it onto the fetched tip would discard local commits.\n` +
            `Push, reset, or remove the local branch in ${installPath}, or \`arc remove ${name}\` for a clean pinned re-install.`,
        };
      }
    }
  }

  // Consent BEFORE state change: validate the manifest at the target commit
  // and gate a widened capability surface. A ref arc cannot read a manifest
  // from is not installable, so refusing here (rather than after moving) keeps
  // the checkout where it is.
  if (!target) {
    // Nothing resolved. `checkoutPinnedRef` owns the loud, ref-listing error,
    // so let it produce one — but never let it LAND anything: an object this
    // function did not resolve is an object none of the guards above examined.
    const checkout = checkoutPinnedRef(installPath, pinnedRef);
    if (checkout.success) {
      const restoreTarget = branchBefore || headBefore;
      const restored = restoreHead(installPath, restoreTarget);
      return {
        success: false,
        moved: false,
        error:
          `Refusing to re-pin '${name}' to ${pinnedRef}: git checked it out but arc could not resolve it to a commit beforehand, so none of the safety checks applied to it. ` +
          (restored
            ? `Rolled the checkout back to ${restoreTarget}.`
            : `The rollback to ${restoreTarget} ALSO failed — fix it with \`git -C ${installPath} checkout ${restoreTarget}\`.`),
      };
    }
    return { success: false, moved: false, error: (checkout.error ?? "checkout failed") + fetchNote };
  }

  const targetManifest = await readManifestAtRef(installPath, target.sha);
  if (!targetManifest) {
    return {
      success: false,
      moved: false,
      error: `Refusing to re-pin '${name}' to ${pinnedRef}: no readable arc-manifest.yaml at ${target.sha.slice(0, 7)}. Nothing was moved.`,
    };
  }
  const consent = await confirmCapabilityWidening({
    name,
    pinnedRef: target.candidate,
    db,
    manifest: targetManifest,
    yes: opts.yes,
  });
  if (!consent.ok) {
    return { success: false, moved: false, error: consent.error };
  }

  // Land the resolved COMMIT, not the name (arc#396 review, F6).
  //
  // `checkoutPinnedRef` resolves the name a second time, through git's own
  // precedence rules, which are not this resolver's — so handing it the name
  // reopens the gap where the guards validate one object and another lands.
  // The name still decides HOW to land: a branch pin lands on the branch
  // (`-B <branch> <sha>`, which is also the fast-forward the ancestry check
  // above authorised), anything else lands detached at the SHA. The unresolved
  // case is handled above, and is the only remaining caller of
  // `checkoutPinnedRef` on this path (for its error message alone).
  const landing = target.isBranch
    ? Bun.spawnSync(["git", "checkout", "--quiet", "-B", target.candidate, target.sha, "--"], {
        cwd: installPath,
        stdout: "pipe",
        stderr: "pipe",
      })
    : Bun.spawnSync(["git", "checkout", "--quiet", target.sha, "--"], {
        cwd: installPath,
        stdout: "pipe",
        stderr: "pipe",
      });
  if (landing.exitCode !== 0) {
    const restoreTarget = branchBefore || headBefore;
    const restored = restoreHead(installPath, restoreTarget);
    return {
      success: false,
      moved: false,
      error:
        `Failed to check '${name}' out at ${target.candidate} (${target.sha.slice(0, 7)}): ${landing.stderr.toString().trim()}. ` +
        (restored
          ? `Left the checkout at ${restoreTarget}.`
          : `The restore to ${restoreTarget} ALSO failed — the checkout is at ${gitOut(installPath, "rev-parse", "--short", "HEAD") || "an unknown commit"}; fix it with \`git -C ${installPath} checkout ${restoreTarget}\`.`),
    };
  }

  // Re-point the branch at its remote so `git status` in the checkout keeps
  // reading normally; `-B <branch> <sha>` sets no upstream. Best-effort — a
  // missing upstream is cosmetic, and never a reason to fail a landed pin.
  if (target.isBranch && target.originSha) {
    Bun.spawnSync(
      ["git", "branch", "--quiet", `--set-upstream-to=origin/${target.candidate}`, target.candidate],
      { cwd: installPath, stdout: "pipe", stderr: "pipe" },
    );
  }

  // Belt and braces: the object the guards validated must be the object on
  // disk. If these ever disagree again, refuse loudly instead of recording a
  // version and a capability surface for code that is not there.
  const landedSha = gitOut(installPath, "rev-parse", "HEAD");
  if (landedSha !== target.sha) {
    const restoreTarget = branchBefore || headBefore;
    const restored = restoreHead(installPath, restoreTarget);
    return {
      success: false,
      moved: false,
      error:
        `Refusing to record a re-pin of '${name}': arc validated ${target.sha.slice(0, 7)} but the checkout landed on ${landedSha.slice(0, 7) || "an unknown commit"}. ` +
        (restored
          ? `Rolled the checkout back to ${restoreTarget}.`
          : `The rollback to ${restoreTarget} ALSO failed — fix it with \`git -C ${installPath} checkout ${restoreTarget}\`.`),
    };
  }

  const headAfter = gitOut(installPath, "rev-parse", "HEAD");
  const branchAfter = gitOut(installPath, "symbolic-ref", "--quiet", "--short", "HEAD");

  // Re-read from the WORKING TREE — that is what actually got installed, and
  // it is the value a fresh pinned install would record. Defensive: the
  // pre-move read at the same commit already validated, so a failure here
  // means the worktree and the committed blob disagree (filters, a broken
  // checkout). Restore and report rather than record a version arc cannot
  // read.
  let manifest: ArcManifest | null;
  try {
    manifest = await readManifest(installPath);
  } catch {
    manifest = null;
  }
  if (!manifest) {
    const restoreTarget = branchBefore || headBefore;
    const restored = restoreHead(installPath, restoreTarget);
    return {
      success: false,
      moved: false,
      error: restored
        ? `Refusing to re-pin '${name}' to ${pinnedRef}: no readable arc-manifest.yaml in the checked-out tree. Left the checkout at ${restoreTarget}.`
        : `Refusing to re-pin '${name}' to ${pinnedRef}: no readable arc-manifest.yaml in the checked-out tree, AND the restore to ${restoreTarget} failed — the checkout is at ${gitOut(installPath, "rev-parse", "--short", "HEAD") || "an unknown commit"}. Fix it with \`git -C ${installPath} checkout ${restoreTarget}\`.`,
    };
  }

  // The code moved, so its dependencies must move with it — otherwise a
  // re-pin is not equivalent to remove + pinned re-install, which is the whole
  // claim `--pin` makes. Same shared helper (and the same frozen-lockfile /
  // stale-lockfile retry) as fresh install and upgrade; idempotent by
  // construction. A genuine failure rolls the checkout back instead of
  // recording a move whose code cannot run — the posture upgrade.ts takes.
  const nodeDeps = installNodeDependencies(installPath);
  reportNodeDependencyResult(nodeDeps, name, Boolean(opts.yes));
  if (nodeDeps.ran && !nodeDeps.success) {
    const restoreTarget = branchBefore || headBefore;
    const restored = restoreHead(installPath, restoreTarget);
    return {
      success: false,
      moved: false,
      error:
        `bun install failed for '${name}' at ${target.candidate} (node_modules incomplete): ${nodeDeps.error ?? "unknown error"}. ` +
        (restored
          ? `Rolled the checkout back to ${restoreTarget}.`
          : `The rollback to ${restoreTarget} ALSO failed — the checkout is at ${gitOut(installPath, "rev-parse", "--short", "HEAD") || "an unknown commit"}; fix it with \`git -C ${installPath} checkout ${restoreTarget}\`.`),
    };
  }

  const moved = headAfter !== headBefore || branchAfter !== branchBefore;

  if (moved) {
    // Recorded HERE, in the same function, immediately after the last step
    // that can fail — so the window between "the checkout moved" and "the DB
    // says so" is a few statements wide rather than a return trip through the
    // caller (arc#396 review, F5).
    //
    // That window is still not atomic: SQLite holds the row and git holds the
    // checkout, and a process killed between them leaves a DB row describing
    // the OLD version of a checkout that has already moved. It self-heals on
    // the next command that re-derives from the tree — `arc upgrade`, or a
    // re-pin to a different ref — and `arc verify` surfaces the mismatch in
    // the meantime. A real fix needs the checkout inside the install
    // transaction (install-transaction.ts), which is a larger change than
    // this bug fix should carry.
    const now = new Date().toISOString();
    db.prepare("UPDATE skills SET version = ?, updated_at = ? WHERE name = ?").run(
      manifest.version,
      now,
      name,
    );
    // The recorded capability surface must describe the code that is now
    // checked out (arc#396 review, F1) — same delete + re-insert `arc upgrade`
    // performs, through the same shared helper.
    replaceCapabilities(db, name, manifest);
  }

  return {
    success: true,
    moved,
    ref: target.candidate,
    from: headBefore,
    to: headAfter,
    manifest,
  };
}

/**
 * Outcome for an install() that hit a duplicate guard on an ACTIVE row
 * (arc#354's no-op success) — re-pinning the existing checkout first when the
 * re-run carries `--pin` (arc#396).
 *
 * Shared by both pre-clone duplicate guards so the repo_url path and the
 * repo-name path cannot drift apart on the one behaviour that has to be
 * identical: whether a `--pin` is honoured or ignored.
 */
async function repinOrNoop(
  existing: { name: string; version: string; install_path: string; repo_url: string },
  opts: InstallOptions,
): Promise<InstallResult> {
  const noop: InstallResult = {
    success: true,
    alreadyInstalled: true,
    name: existing.name,
    version: existing.version,
  };

  // No pin → arc#354 behaviour, untouched. preExtractedPath is a registry
  // install with no git checkout to move.
  if (!opts.pinnedRef || opts.preExtractedPath) return noop;

  // Confused-deputy guard (arc#396 review, F4). The repo-NAME duplicate guard
  // matches on a basename (`repo_url.endsWith(repoName)`), and two different
  // repos can share one. Moving the installed repo's checkout to a ref named
  // by a DIFFERENT repo is arc acting on repo A because the caller named repo
  // B — so when the URLs disagree, refuse and name both rather than guess.
  if (!sameRepoUrl(existing.repo_url, opts.repoUrl)) {
    return {
      success: false,
      name: existing.name,
      error:
        `Refusing to re-pin '${existing.name}': the installed package came from ${existing.repo_url}, but this install names ${opts.repoUrl}. ` +
        `They share a repo name, not a repo. Nothing was moved — \`arc remove ${existing.name}\` first if you meant to replace it.`,
    };
  }

  const repin = await repinInstalledCheckout({
    name: existing.name,
    installPath: existing.install_path,
    pinnedRef: opts.pinnedRef,
    db: opts.db,
    yes: opts.yes,
  });
  if (!repin.success) {
    return { success: false, name: existing.name, error: repin.error };
  }
  if (!repin.moved) return noop;

  return {
    success: true,
    name: existing.name,
    // Recorded by repinInstalledCheckout at the moment of the move; reported
    // here as the manifest version at the ref now checked out.
    version: repin.manifest?.version ?? existing.version,
    manifest: repin.manifest,
    repinned: { ref: repin.ref ?? opts.pinnedRef, from: repin.from ?? "", to: repin.to ?? "" },
  };
}
