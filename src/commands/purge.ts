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
import { getSkill } from "../lib/db.js";
import { readManifest } from "../lib/manifest.js";
import { remove, type RemoveResult } from "./remove.js";
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
  const head = result.dryRun ? `Purge plan for '${result.name}' (dry run — nothing deleted):` : `Purged '${result.name}':`;
  lines.push(head);

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

  for (const k of result.keptUserData) {
    for (const p of k.paths) {
      lines.push(`  kept (user data): ${p} — yours, arc will not touch it`);
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

  return lines.join("\n");
}
