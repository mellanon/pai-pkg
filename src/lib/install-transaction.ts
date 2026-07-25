import type { ArtifactSymlinkRecord } from "./artifact-installer.js";
import {
  installNodeDependencies,
  reportNodeDependencyResult,
  resolveArtifactSourceDir,
  rollbackArtifactSymlinks,
} from "./artifact-installer.js";
import type { LaunchdInstallRecord } from "./hosts/launchd-install.js";
import { rollbackLaunchdArtifacts } from "./hosts/launchd-install.js";
import type { SystemctlRunner, SystemdInstallRecord } from "./hosts/systemd-install.js";
import { rollbackSystemdArtifacts } from "./hosts/systemd-install.js";
import {
  findMissingHookFiles,
  registerHooks,
  removeHooks,
  resolveHooksFromManifest,
} from "./hooks.js";
import { errorMessage } from "./errors.js";
import { rollbackWiredExtensions, wireExtensions } from "./extensions.js";
import { recordInstall } from "./db.js";
import { runLifecycleScripts, runScript } from "./scripts.js";
import { runSomaSkillProjection } from "./soma-projection.js";
import type { Database } from "bun:sqlite";
import { existsSync } from "fs";
import type {
  ArcManifest,
  ArtifactType,
  HostAdapter,
  PackageTier,
} from "../types.js";

export interface InstallAuthorization {
  approved: boolean;
}

export type LandedArtifact =
  | { kind: "symlink"; path: string }
  | { kind: "shim"; dir: string; name: string }
  | { kind: "hook"; settingsPath: string; count: number }
  | { kind: "extension"; name: string }
  | { kind: "launchd"; plistPath?: string; binSymlink?: string }
  | { kind: "systemd"; unitPath?: string; binSymlink?: string }
  | { kind: "soma-projection"; skillDir: string }
  | { kind: "db-row"; name: string };

export interface InstallTransactionEvidence {
  packageName: string;
  landedArtifacts: LandedArtifact[];
  dbCommitted: boolean;
  rollback: {
    attempted: boolean;
    warnings: string[];
  };
}

export interface InstallTransaction {
  readonly evidence: InstallTransactionEvidence;
  recordSymlinks(record: ArtifactSymlinkRecord): void;
  recordLaunchd(records: LaunchdInstallRecord[]): void;
  recordSystemd(records: SystemdInstallRecord[]): void;
  recordHookRegistration(settingsPath: string, count: number): void;
  recordExtensions(names: string[], claudeRoot: string): void;
  recordSomaProjection(installPath: string, manifest: ArcManifest): void;
  recordSomaProjectionCleanup(installPath: string, manifest: ArcManifest): void;
  recordDbCommit(name: string): void;
  rollback(): Promise<InstallTransactionEvidence>;
}

// ── Library (multi-artifact) install transaction (arc#227 / F-6c) ───────────
//
// The single-package InstallTransaction above (arc#140 P4 lineage) tracks ONE
// artifact's landed state and unwinds it on failure. A `type: library` install
// lands an ORDERED SEQUENCE of artifacts; if artifact N fails, artifacts 1..N-1
// — which have already committed their DB rows + symlinks + hooks + launchd —
// must be unwound in REVERSE order to leave the stack in a known-good state.
//
// beginLibraryInstallTransaction is that lift: it holds each successful
// artifact's live sub-transaction handle (so rollback reuses the exact same
// rollback path, not a re-derived one) plus a `removeDbRow` callback for the
// committed DB rows the sub-transaction itself does not undo (the DB commit is
// the last step of a single-artifact install, so single-artifact rollback never
// needs it — the library level does).

/** Per-artifact outcome within a library install (arc#227 / F-6c). */
export enum ArtifactInstallState {
  /** Already installed before this run; left untouched. */
  SKIPPED = "skipped",
  /** Installed cleanly in this run. */
  SUCCESS = "success",
  /** Install attempt failed — the sequence stops here. */
  FAILED = "failed",
  /** Installed in this run, then unwound because a later artifact failed. */
  ROLLED_BACK = "rolled_back",
}

/** Reported per-artifact state for a library install (extends InstallResult). */
export interface ArtifactInstallDetail {
  name: string;
  version?: string;
  type?: string;
  state: ArtifactInstallState;
  /** Failure reason when state === FAILED. */
  error?: string;
  /** Landed-artifact evidence captured for SUCCESS / ROLLED_BACK entries. */
  evidence?: InstallTransactionEvidence;
}

/** Full transactional journal of a library install (arc#227 / F-6c). */
export interface LibraryInstallJournal {
  libraryName: string;
  artifacts: ArtifactInstallDetail[];
  /** ISO timestamp the library transaction opened. */
  startedAt: string;
}

export interface LibraryInstallTransaction {
  /** Record an artifact that was already installed (pre-existing — not unwound). */
  recordArtifactSkipped(name: string, version?: string, type?: string): void;
  /** Record a successful artifact install, capturing its live sub-transaction. */
  recordArtifactSuccess(
    name: string,
    tx: InstallTransaction,
    version?: string,
    type?: string,
  ): void;
  /** Record the failing artifact; the sequence stops and rollback follows. */
  recordArtifactFailure(name: string, error: string, version?: string, type?: string): void;
  /** Unwind every SUCCESS artifact in reverse order (symlinks/hooks/launchd + DB row). */
  rollback(): Promise<LibraryInstallJournal>;
  /** Snapshot of the journal as it currently stands. */
  journal(): LibraryInstallJournal;
}

export function beginLibraryInstallTransaction(opts: {
  libraryName: string;
  /**
   * Teardown callback for a committed DB row. Injected (rather than importing
   * the db module) so this transaction stays a pure unit. install.ts passes a
   * closure over `removeSkill(db, name)`.
   */
  removeDbRow?: (name: string) => void;
}): LibraryInstallTransaction {
  const startedAt = new Date().toISOString();

  // Ordered details, mirrored by the live sub-transaction handles for the
  // SUCCESS entries (parallel arrays keyed by insertion order).
  const details: ArtifactInstallDetail[] = [];
  const landed: { name: string; tx: InstallTransaction }[] = [];

  const find = (name: string) => details.find((d) => d.name === name);

  return {
    recordArtifactSkipped(name, version, type) {
      details.push({ name, version, type, state: ArtifactInstallState.SKIPPED });
    },

    recordArtifactSuccess(name, tx, version, type) {
      details.push({
        name,
        version,
        type,
        state: ArtifactInstallState.SUCCESS,
        evidence: tx.evidence,
      });
      landed.push({ name, tx });
    },

    recordArtifactFailure(name, error, version, type) {
      details.push({ name, version, type, state: ArtifactInstallState.FAILED, error });
    },

    async rollback() {
      // Reverse order: last landed artifact unwinds first.
      //
      // Every teardown step here is best-effort and MUST NOT abort the loop:
      // the atomic-rollback invariant (no earlier-sequence artifact left with
      // its symlinks/hooks/launchd behind) requires that we unwind ALL landed
      // artifacts even if one step throws. The filesystem teardown
      // (tx.rollback()) runs first and is itself best-effort across its own
      // steps; the DB-row removal that follows is the one call the
      // sub-transaction does not own, so we wrap it here to match the same
      // warn-and-continue discipline.
      for (let i = landed.length - 1; i >= 0; i--) {
        const { name, tx } = landed[i];

        // Filesystem teardown (symlinks/hooks/launchd/extensions). Internally
        // best-effort; if it ever threw, the DB row + later artifacts must
        // still be cleaned, so guard it too.
        try {
          await tx.rollback();
        } catch (err) {
          process.stderr.write(
            `  ⚠ rollback: failed to unwind artifact '${name}': ${errorMessage(err)}\n`,
          );
        }

        // The sub-transaction's own rollback does NOT remove the committed DB
        // row (the DB commit is the last step of a single-artifact install, so
        // it never had to). The library level removes it here — and a failure
        // (SQLITE_BUSY, locked DB, schema drift) must not abort the unwind of
        // the remaining artifacts.
        if (opts.removeDbRow) {
          try {
            opts.removeDbRow(name);
          } catch (err) {
            process.stderr.write(
              `  ⚠ rollback: failed to remove DB row for '${name}': ${errorMessage(err)}\n`,
            );
          }
        }

        const detail = find(name);
        if (detail) {
          detail.state = ArtifactInstallState.ROLLED_BACK;
          detail.evidence = tx.evidence;
        }
      }
      return { libraryName: opts.libraryName, artifacts: details, startedAt };
    },

    journal() {
      return { libraryName: opts.libraryName, artifacts: details, startedAt };
    },
  };
}

export function beginInstallTransaction(opts: {
  packageName: string;
  authorization: InstallAuthorization;
  /** Injectable systemctl seam for systemd rollback (test isolation, arc#311). */
  systemctlRunner?: SystemctlRunner;
}): InstallTransaction {
  if (!opts.authorization.approved) {
    throw new Error("Install Transaction requires Install Authorization");
  }

  const symlinkRecords: ArtifactSymlinkRecord[] = [];
  const launchdRecords: LaunchdInstallRecord[] = [];
  const systemdRecords: SystemdInstallRecord[] = [];
  const hookRegistrations: { settingsPath: string; packageName: string }[] = [];
  const extensionRecords: { names: string[]; claudeRoot: string }[] = [];
  const somaProjectionRecords: { installPath: string; manifest: ArcManifest }[] = [];
  const evidence: InstallTransactionEvidence = {
    packageName: opts.packageName,
    landedArtifacts: [],
    dbCommitted: false,
    rollback: {
      attempted: false,
      warnings: [],
    },
  };

  const warn = (message: string) => {
    evidence.rollback.warnings.push(message);
  };

  return {
    evidence,

    recordSymlinks(record) {
      symlinkRecords.push(record);
      for (const path of record.symlinks) {
        evidence.landedArtifacts.push({ kind: "symlink", path });
      }
      for (const name of record.shims.names) {
        evidence.landedArtifacts.push({ kind: "shim", dir: record.shims.dir, name });
      }
    },

    recordLaunchd(records) {
      launchdRecords.push(...records);
      for (const record of records) {
        evidence.landedArtifacts.push({
          kind: "launchd",
          plistPath: record.plistPath,
          binSymlink: record.binSymlink,
        });
      }
    },

    recordSystemd(records) {
      systemdRecords.push(...records);
      for (const record of records) {
        evidence.landedArtifacts.push({
          kind: "systemd",
          unitPath: record.unitPath,
          binSymlink: record.binSymlink,
        });
      }
    },

    recordHookRegistration(settingsPath, count) {
      hookRegistrations.push({ settingsPath, packageName: opts.packageName });
      evidence.landedArtifacts.push({ kind: "hook", settingsPath, count });
    },

    recordExtensions(names, claudeRoot) {
      extensionRecords.push({ names, claudeRoot });
      for (const name of names) {
        evidence.landedArtifacts.push({ kind: "extension", name });
      }
    },

    recordSomaProjection(installPath, manifest) {
      const skillDir = resolveArtifactSourceDir(manifest.type, installPath);
      somaProjectionRecords.push({ installPath, manifest });
      evidence.landedArtifacts.push({ kind: "soma-projection", skillDir });
    },

    recordSomaProjectionCleanup(installPath, manifest) {
      somaProjectionRecords.push({ installPath, manifest });
    },

    recordDbCommit(name) {
      evidence.dbCommitted = true;
      evidence.landedArtifacts.push({ kind: "db-row", name });
    },

    async rollback() {
      evidence.rollback.attempted = true;
      for (const hook of hookRegistrations) {
        try {
          await removeHooks(hook.packageName, hook.settingsPath);
        } catch (err) {
          warn(`failed to remove hooks from ${hook.settingsPath}: ${errorMessage(err)}`);
        }
      }
      for (const record of extensionRecords) {
        try {
          const warnings = await rollbackWiredExtensions(record.names, record.claudeRoot);
          for (const warning of warnings) {
            warn(warning);
          }
        } catch (err) {
          warn(`failed to roll back extensions: ${errorMessage(err)}`);
        }
      }
      for (const record of somaProjectionRecords) {
        const result = await runSomaSkillProjection({
          manifest: record.manifest,
          installPath: record.installPath,
          mode: "unproject",
        });
        if (result.warning) {
          warn(result.warning);
        }
      }
      for (const record of symlinkRecords) {
        try {
          await rollbackArtifactSymlinks(record);
        } catch (err) {
          warn(`failed to roll back symlinks: ${errorMessage(err)}`);
        }
      }
      for (const record of launchdRecords) {
        try {
          await rollbackLaunchdArtifacts(record);
        } catch (err) {
          warn(`failed to roll back launchd artifacts: ${errorMessage(err)}`);
        }
      }
      for (const record of systemdRecords) {
        try {
          await rollbackSystemdArtifacts(record, { systemctlRunner: opts.systemctlRunner });
        } catch (err) {
          warn(`failed to roll back systemd artifacts: ${errorMessage(err)}`);
        }
      }
      return evidence;
    },
  };
}

export interface CompleteInstallTransactionOptions {
  host: HostAdapter;
  db: Database;
  repoUrl: string;
  installPath: string;
  manifest: ArcManifest;
  authorization: InstallAuthorization;
  symlinks: ArtifactSymlinkRecord;
  launchdRecords?: LaunchdInstallRecord[];
  systemdRecords?: SystemdInstallRecord[];
  /** Injectable systemctl seam threaded to the transaction's rollback (test isolation, arc#311). */
  systemctlRunner?: SystemctlRunner;
  quiet?: boolean;
  sourceName?: string | null;
  sourceTier?: PackageTier;
  libraryName?: string | null;
  postinstallEnv?: Record<string, string>;
  onTransaction?: (tx: InstallTransaction) => void;
}

export interface CompleteInstallTransactionResult {
  success: boolean;
  name?: string;
  version?: string;
  error?: string;
  manifest?: ArcManifest;
  evidence?: InstallTransactionEvidence;
}

/**
 * Complete an Install Transaction after the package's primary Landed Artifacts
 * have been created.
 *
 * Callers still own **Resolved Package** creation, **Install Authorization**,
 * and preinstall gates. This module owns the post-landing invariants:
 * hook validation/registration, extension wiring, dependency install,
 * postinstall lifecycle, package DB commit, rollback, and Transaction Evidence.
 */
export async function completeInstallTransaction(
  opts: CompleteInstallTransactionOptions,
): Promise<CompleteInstallTransactionResult> {
  const { host, db, repoUrl, installPath, manifest } = opts;
  const tx = beginInstallTransaction({
    packageName: manifest.name,
    authorization: opts.authorization,
    systemctlRunner: opts.systemctlRunner,
  });
  opts.onTransaction?.(tx);
  tx.recordSymlinks(opts.symlinks);
  tx.recordLaunchd(opts.launchdRecords ?? []);
  tx.recordSystemd(opts.systemdRecords ?? []);

  const resolvedHooks = resolveHooksFromManifest(
    manifest.provides?.hooks,
    installPath,
    manifest.name,
    host.paths.root,
  );
  if (resolvedHooks?.length) {
    const missingHookFiles = findMissingHookFiles(resolvedHooks);
    if (missingHookFiles.length) {
      const detail = missingHookFiles
        .map((m) => `  - ${m.event}: ${m.command}\n      missing: ${m.missingPath}`)
        .join("\n");
      const evidence = await tx.rollback();
      return {
        success: false,
        evidence,
        error:
          `Manifest declares hooks whose command references a file that was not installed:\n${detail}\n` +
          `Add the file to provides.files (or fix the command path) and reinstall.`,
      };
    }
    const tier = opts.sourceTier ?? manifest.tier ?? "custom";
    const approved = await promptHookConsent(
      manifest.name,
      tier,
      resolvedHooks,
      opts.quiet,
    );
    if (approved) {
      const settingsPath = host.paths.settingsPath;
      await registerHooks(manifest.name, resolvedHooks, settingsPath);
      tx.recordHookRegistration(settingsPath, resolvedHooks.length);
      if (!opts.quiet) {
        console.log("  \u2713 Hooks registered in settings.json");
      }
    } else if (!opts.quiet) {
      console.log("  \u2298 Hook registration declined");
    }
  }

  if (manifest.extensions) {
    const wired = await wireExtensions(manifest, installPath, host.paths.root);
    tx.recordExtensions(wired, host.paths.root);
    if (wired.length && !opts.quiet) {
      for (const ext of wired) {
        console.log(`  \u2713 Extension wired: ${ext}`);
      }
    }
  }

  const nodeDepsResult = installNodeDependencies(installPath);
  reportNodeDependencyResult(nodeDepsResult, manifest.name, opts.quiet ?? false);
  if (nodeDepsResult.ran && !nodeDepsResult.success) {
    // A genuine dependency-install failure (survived the frozen->unfrozen
    // retry in installNodeDependencies — see its doc comment) must not
    // record the install as successful: node_modules is incomplete, and
    // cortex's dynamic import() of the package's entry point WILL fail at
    // runtime, just later and further from the cause. Same posture as
    // runPostinstallPhase failure below — roll back rather than WARN and
    // continue.
    const evidence = await tx.rollback();
    return {
      success: false,
      evidence,
      error: `bun install failed for ${manifest.name} (node_modules incomplete): ${nodeDepsResult.error ?? "unknown error"}`,
    };
  }

  const postinstallResult = runPostinstallPhase(
    installPath,
    manifest,
    opts.quiet,
    opts.postinstallEnv,
  );
  if (!postinstallResult.success) {
    const evidence = await tx.rollback();
    return { ...postinstallResult, evidence };
  }

  const somaProjectionResult = await runSomaSkillProjection({
    manifest,
    installPath,
    mode: "project",
  });
  if (somaProjectionResult.success) {
    tx.recordSomaProjection(installPath, manifest);
  } else if (somaProjectionResult.attempted && !somaProjectionResult.skipped) {
    tx.recordSomaProjectionCleanup(installPath, manifest);
  }
  if (somaProjectionResult.warning && !opts.quiet) {
    process.stderr.write(
      `  ⚠ ${somaProjectionResult.warning}; continuing without Soma projection\n`,
    );
  }

  const now = new Date().toISOString();
  // ArcManifest.type and ArtifactType are the same union since arc#361
  // (governance + system folded into ArtifactType) — no assertion needed.
  const artifactType: ArtifactType = manifest.type;
  const artifactSourceDir = resolveArtifactSourceDir(manifest.type, installPath);
  recordInstall(
    db,
    {
      name: manifest.name,
      version: manifest.version,
      repo_url: repoUrl,
      install_path: installPath,
      skill_dir: existsSync(artifactSourceDir) ? artifactSourceDir : installPath,
      status: "active",
      artifact_type: artifactType,
      tier: opts.sourceTier ?? manifest.tier ?? "custom",
      customization_path: null,
      install_source: opts.sourceName ?? null,
      library_name: opts.libraryName ?? null,
      installed_at: now,
      updated_at: now,
    },
    manifest,
  );
  tx.recordDbCommit(manifest.name);

  return {
    success: true,
    name: manifest.name,
    version: manifest.version,
    manifest,
    evidence: tx.evidence,
  };
}

interface PhaseResult {
  success: boolean;
  error?: string;
}

function runPostinstallPhase(
  installPath: string,
  manifest: ArcManifest,
  quiet?: boolean,
  env?: Record<string, string>,
): PhaseResult {
  if (manifest.scripts?.postinstall) {
    const result = runScript({
      installPath,
      scriptPath: manifest.scripts.postinstall,
      hookName: "postinstall",
      quiet,
      env,
    });
    if (!result.success && !result.skipped) {
      return {
        success: false,
        error: `Postinstall script failed (exit ${result.exitCode})`,
      };
    }
  }

  const lifecycle = manifest.lifecycle?.postinstall;
  if (lifecycle && lifecycle.length > 0) {
    const result = runLifecycleScripts({
      installPath,
      scriptPaths: lifecycle,
      phase: "postinstall",
      quiet,
      env,
    });
    if (!result.success) {
      return {
        success: false,
        error: `Postinstall lifecycle script failed: ${result.failedAt} (exit ${result.steps.at(-1)?.exitCode ?? "?"})`,
      };
    }
  }

  return { success: true };
}

async function promptHookConsent(
  packageName: string,
  tier: string,
  hooks: { event: string; command: string; matcher?: string }[],
  autoApprove?: boolean,
): Promise<boolean> {
  if (autoApprove) return true;
  if (tier === "official") return true;

  console.log(`\n\u{1F4CB} ${packageName} wants to register hooks:`);
  for (const hook of hooks) {
    const matcherLabel = hook.matcher ? ` (${hook.matcher})` : "";
    console.log(`  \u2022 ${hook.event}${matcherLabel} \u2192 ${hook.command}`);
  }
  console.log("");
  console.log("Hooks run during Claude Code sessions.");

  if (tier === "community" || tier === "custom") {
    process.stdout.write("Allow? [y/N] ");
    const response = await readLine();
    return response.trim().toLowerCase() === "y";
  }

  return true;
}

function readLine(): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve("");
  }
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
