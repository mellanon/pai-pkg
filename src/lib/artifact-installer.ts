import { join, dirname, basename } from "path";
import { existsSync, readdirSync } from "fs";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";
import YAML from "yaml";
import type {
  ArtifactType,
  ArcManifest,
  ArcPaths,
  CortexHostPaths,
  HostAdapter,
  HostId,
  LibraryArtifactEntry,
} from "../types.js";
import { errorMessage, isErrno } from "./errors.js";
import {
  createSymlink,
  createCliShim,
  extractAllCliInfo,
  isValidSymlink,
  removeSymlink,
  removeCliShim,
} from "./symlinks.js";
import { generateRules } from "./rules.js";
import { requireHostDir } from "./hosts/dispatch.js";
import { resolveHost, type HostOverrides } from "./hosts/registry.js";
import { resolveProvidesTarget } from "./provides-target.js";
import { isDarwinLaunchdHost } from "./hosts/darwin-launchd.js";
import { isLinuxSystemdHost } from "./hosts/linux-systemd.js";

/**
 * The complete set of manifest `type`s arc can install (arc#334). This is the
 * INSTALLER side of the validator↔installer type-set contract: the strict
 * validator's `VALID_TYPES` (validate-manifest.ts) must equal this set exactly,
 * asserted by a parity test so the two can't drift again (the drift that let
 * `type: bundle` validate green yet throw at install).
 *
 * It is the union of:
 *   - every case handled by `planArtifactSymlinks` below — skill, system, tool,
 *     agent, prompt, component, pipeline, rules, action, governance; and
 *   - the two types intercepted earlier, in `readManifest` (manifest.ts), which
 *     never reach `planArtifactSymlinks` — library and process.
 *
 * A new installable type means: add a `planArtifactSymlinks` case (or a
 * readManifest special-case) AND add it here AND to `VALID_TYPES`. `bundle` is
 * deliberately absent — it is a repo-name class, not a manifest type.
 */
export const INSTALLABLE_ARTIFACT_TYPES = [
  "skill",
  "system",
  "tool",
  "agent",
  "prompt",
  "component",
  "pipeline",
  "rules",
  "action",
  "library",
  "process",
  "governance",
] as const;

/**
 * Maps an artifact type to its conventional source subdirectory within a cloned repo.
 *
 * - rules, governance, component, tool -> baseDir (no subdirectory)
 * - pipeline -> join(baseDir, "pipeline") if it exists, else baseDir
 * - agent -> join(baseDir, "agent")
 * - prompt -> join(baseDir, "prompt")
 * - skill (default) -> join(baseDir, "skill")
 */
export function resolveArtifactSourceDir(type: ArtifactType | "rules" | "system", baseDir: string): string {
  switch (type) {
    case "action":
    case "rules":
    case "governance":
    case "component":
    case "tool":
      return baseDir;

    case "pipeline": {
      const pipelineDir = join(baseDir, "pipeline");
      return existsSync(pipelineDir) ? pipelineDir : baseDir;
    }

    case "agent":
      return join(baseDir, "agent");

    case "prompt":
      return join(baseDir, "prompt");

    case "skill":
    case "system":
    default:
      return join(baseDir, "skill");
  }
}

/**
 * Create symlinks for an installed artifact based on its type.
 *
 * Handles all artifact types: rules (template generation), pipeline, component,
 * tool, agent, prompt, and skill. Extracted from install() to allow reuse
 * across install and single-artifact install flows.
 */
/**
 * Aggregate of every filesystem artifact a single createArtifactSymlinks call
 * created. Captured so a downstream failure (hook gate, post-install script,
 * etc.) can roll back the partial state — see issue #89.
 */
export interface ArtifactSymlinkRecord {
  /** Absolute paths of symlinks created (any directory). */
  symlinks: string[];
  /** CLI shim files created via createCliShim (need removeCliShim, not unlink). */
  shims: { dir: string; names: string[] };
}

/** Common option shape shared by the planner and the apply step. */
export interface ArtifactSymlinkOpts {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  arc: ArcPaths;
  /** Target host adapter. Defaults to Claude-Code in the caller. */
  host: HostAdapter;
  installDir: string;
  consumerDir?: string;
  quiet?: boolean;
}

/** A single symlink the install will create: `source` linked at `target`. */
export interface PlannedSymlink {
  source: string;
  target: string;
}

/**
 * The pure, write-free PLAN of what createArtifactSymlinks would drop for a
 * given artifact + host. Extracted (arc#248) so the install-time path
 * computation lives in ONE place. Two callers consume it:
 *   - createArtifactSymlinks (the APPLY step) turns the plan into real symlinks
 *     + shims (and runs the `rules` template-generation side effect, which has
 *     no symlink target and is invisible to the plan).
 *   - artifactDropPresent (the VERIFY step) checks each planned target actually
 *     exists on disk, so the DB-active skip-guard can be gated on
 *     filesystem-truth instead of blindly trusting the DB row.
 *
 * Re-deriving (vs. persisting) mirrors `arc verify` (src/commands/verify.ts),
 * which re-computes the expected skill symlink path rather than reading a
 * symlinks column the DB does not have.
 *
 * NOTE: planning READS the disk (to pick a source dir, detect the cortex
 * bot-pack agent.yaml shape, read the fragment id) but never WRITES. The reads
 * are the same branch decisions the apply step makes, so the two stay in
 * lock-step (the planner-parity test enforces target-set equality).
 */
export interface ArtifactSymlinkPlan {
  /** Symlink targets: primary per-type links + provides.files links. */
  symlinkTargets: PlannedSymlink[];
  /** Logical CLI shim names that will be written into `arc.shimDir`. */
  shimNames: string[];
  /**
   * provides.files entries whose source is MISSING in the package. When
   * non-empty the apply step aborts before mutating the filesystem (#84/#89).
   */
  filesMissingSource: PlannedSymlink[];
}

/**
 * Compute -- WITHOUT touching the filesystem -- every symlink + shim a
 * createArtifactSymlinks call would create for `opts`. Single source of truth
 * for the per-type install path logic; never writes.
 */
export function planArtifactSymlinks(opts: ArtifactSymlinkOpts): ArtifactSymlinkPlan {
  const { type, manifest, arc, host, installDir } = opts;
  const symlinkTargets: PlannedSymlink[] = [];
  const shimNames: string[] = [];

  // Pre-validation pass (#89): assert every provides.files source exists in
  // the package. The apply step bails here with zero filesystem mutation.
  const declaredFiles = manifest.provides?.files ?? [];
  const filesMissingSource: PlannedSymlink[] = [];
  for (const file of declaredFiles) {
    const sourcePath = join(installDir, file.source);
    if (!existsSync(sourcePath)) {
      filesMissingSource.push({
        source: sourcePath,
        target: resolveProvidesTarget(file.target),
      });
    }
  }
  if (filesMissingSource.length) {
    return { symlinkTargets: [], shimNames: [], filesMissingSource };
  }

  const shimNamesFor = (): string[] => extractAllCliInfo(manifest).map((e) => e.binName);

  switch (type) {
    case "action": {
      symlinkTargets.push({ source: installDir, target: join(arc.actionsDir, manifest.name) });
      break;
    }

    case "rules": {
      // Rules packages produce no symlink target -- they generate templates
      // into the consumer repo (done only in the apply step). Nothing to plan.
      break;
    }

    case "governance": {
      // Governance packages (arc#361) have no per-type primary layout: their
      // drops are declared via provides.files (handled by the type-agnostic
      // pass below) and provides.templates render like `rules` in the apply
      // step. Nothing to plan here.
      break;
    }

    case "pipeline": {
      const pipelineSourceDir = join(installDir, "pipeline");
      const sourceDir = existsSync(pipelineSourceDir) ? pipelineSourceDir : installDir;
      symlinkTargets.push({ source: sourceDir, target: join(arc.pipelinesDir, manifest.name) });

      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        symlinkTargets.push({ source: installDir, target: join(host.paths.binDir, entry.binName) });
      }
      if (cliEntries.length) {
        shimNames.push(...shimNamesFor());
      }
      break;
    }

    case "component": {
      // No per-type primary layout -- provides.files only (handled below).
      break;
    }

    case "tool": {
      const binDir = requireHostDir(host, "tool");
      const cliEntries = extractAllCliInfo(manifest);
      for (const entry of cliEntries) {
        symlinkTargets.push({ source: installDir, target: join(binDir, entry.binName) });
      }
      if (!cliEntries.length) {
        symlinkTargets.push({ source: installDir, target: join(binDir, manifest.name) });
      }
      shimNames.push(...shimNamesFor());
      break;
    }

    case "agent": {
      const botPackFragment = join(installDir, "agent.yaml");
      // Bot-pack branch needs BOTH a cortex host target AND the agent.yaml
      // shape at the pack root (cortex is today the only host with a
      // fragment/persona contract). Otherwise fall through to the legacy .md.
      if (host.id === "cortex" && existsSync(botPackFragment)) {
        const cortexPaths = host.paths as CortexHostPaths;
        const agentId = resolveBotPackAgentId(botPackFragment, manifest.name);
        symlinkTargets.push({
          source: botPackFragment,
          target: join(cortexPaths.agentsDir, `${agentId}.yaml`),
        });
        const personaPath = join(installDir, "persona.md");
        if (existsSync(personaPath)) {
          symlinkTargets.push({
            source: personaPath,
            target: join(cortexPaths.personasDir, `${agentId}.md`),
          });
        }
        break;
      }

      const agentsDir = requireHostDir(host, "agent");
      const agentSourceDir = join(installDir, "agent");
      const sourceDir = existsSync(agentSourceDir) ? agentSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      if (existsSync(sourcePath)) {
        symlinkTargets.push({ source: sourcePath, target: join(agentsDir, mdFile) });
      } else {
        symlinkTargets.push({ source: sourceDir, target: join(agentsDir, manifest.name) });
      }
      break;
    }

    case "prompt": {
      const promptsDir = requireHostDir(host, "prompt");
      const promptSourceDir = join(installDir, "prompt");
      const sourceDir = existsSync(promptSourceDir) ? promptSourceDir : installDir;
      const mdFile = `${manifest.name}.md`;
      const sourcePath = join(sourceDir, mdFile);
      if (existsSync(sourcePath)) {
        symlinkTargets.push({ source: sourcePath, target: join(promptsDir, mdFile) });
      } else {
        symlinkTargets.push({ source: sourceDir, target: join(promptsDir, manifest.name) });
      }
      break;
    }

    case "skill":
    case "system": {
      const skillsDir = requireHostDir(host, type);
      const skillSourceDir = join(installDir, "skill");
      const sourceDir = existsSync(skillSourceDir) ? skillSourceDir : installDir;
      symlinkTargets.push({ source: sourceDir, target: join(skillsDir, manifest.name) });

      const cliEntries = extractAllCliInfo(manifest);
      if (cliEntries.length) {
        const binDir = requireHostDir(host, "tool", "expose a bin directory for skill CLIs");
        for (const entry of cliEntries) {
          symlinkTargets.push({ source: installDir, target: join(binDir, entry.binName) });
        }
        shimNames.push(...shimNamesFor());
      }
      break;
    }

    default: {
      throw new Error(
        `Unsupported artifact type "${type as string}" in planArtifactSymlinks`,
      );
    }
  }

  // Type-agnostic provides.files pass -- every type honors provides.files (#84).
  for (const file of declaredFiles) {
    symlinkTargets.push({
      source: join(installDir, file.source),
      target: resolveProvidesTarget(file.target),
    });
  }

  return { symlinkTargets, shimNames, filesMissingSource: [] };
}

/**
 * Resolve the cortex bot-pack agent id (filename stem) from the fragment's
 * `id:` field, falling back to the manifest name -- IDENTICAL logic to
 * linkCortexBotPackSymlinks, shared so the planner and the apply step agree on
 * where the fragment + persona land. Throws on a present-but-unsafe id (sage
 * arc#238 round 2) so the planner surfaces the same error the apply step would,
 * rather than silently planning a different target.
 */
function resolveBotPackAgentId(fragmentPath: string, manifestName: string): string {
  const rawId = readRawAgentFragmentId(fragmentPath);
  if (rawId !== undefined) {
    const agentId = sanitizeAgentId(rawId);
    if (agentId === undefined) {
      throw new Error(
        `agent pack "${manifestName}": agent.yaml declares an unsafe id "${rawId}" ` +
          `-- an id is a filename stem under agents.d/ (alphanumeric start, ` +
          `[a-z0-9._-], no "..", <=128 chars). Refusing to install.`,
      );
    }
    return agentId;
  }
  const agentId = sanitizeAgentId(manifestName.toLowerCase());
  if (agentId === undefined) {
    throw new Error(
      `agent pack "${manifestName}": agent.yaml has no usable id and the manifest ` +
        `name is not a safe filename stem -- refusing to install.`,
    );
  }
  return agentId;
}

/**
 * Verify that the host-side DROP for an artifact actually exists on disk
 * (arc#248). Re-derives the expected targets via planArtifactSymlinks, honoring
 * `manifest.targets` exactly as installPerTarget does (resolve each declared
 * HostId through resolveHost), else the single fallback host. Each primary
 * symlink target is checked with isValidSymlink; each provides.files target
 * with existsSync (it may be a symlink OR a copied file -- presence is what
 * matters).
 *
 * Returns false if ANY expected target is missing -- the DB row claims the
 * artifact is installed but the filesystem disagrees, so a skip-on-active guard
 * must NOT honor the skip (it would be a silent no-op reinstall).
 *
 * v2 (arc#250): supervision hosts (darwin-launchd, linux-systemd) are no
 * longer skipped -- the rendered plist/unit's presence at its computed path
 * (mirroring installLaunchdArtifacts / installSystemdArtifacts' basename-based
 * target) is checked, same as the symlink/fragment presence check registry
 * hosts get. `provides.binary`'s symlink into that host's `binDir` is checked
 * too when declared. This closes the false-positive arc#248 originally
 * scoped out (v1): a manifest whose `targets` is ONLY supervision hosts no
 * longer skips verification entirely -- a wiped plist/unit now reads as
 * "not present", so the skip-on-active guard re-runs the install instead of
 * silently trusting a stale DB row.
 *
 * FAIL-SAFE (arc#250): resolving `manifest.targets` can never legitimately
 * produce ZERO checks when `targets.length > 0` -- every declared HostId is
 * either a registry host (resolveHost, which throws on an unknown id) or one
 * of the two known supervision ids. But should that invariant ever be wrong
 * (a future HostId this function hasn't been taught to classify), returning
 * `true` from an empty-checks run would be the exact arc#248/#250 failure
 * mode again -- a DB row nothing here actually verified. So an empty result
 * fails safe to `false`, not `true`.
 */
export async function artifactDropPresent(opts: {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  arc: ArcPaths;
  /** Fallback host when the manifest declares no `targets`. */
  host: HostAdapter;
  installDir: string;
  hostOverrides?: HostOverrides;
}): Promise<boolean> {
  // `rules` packages drop no host symlink (templates land in the consumer repo
  // and aren't tracked per-host), so there is nothing to verify -- treat as
  // present so the skip-guard keeps its prior behavior for rules.
  if (opts.type === "rules") return true;

  const declaredFileTargets = new Set(
    (opts.manifest.provides?.files ?? []).map((f) => resolveProvidesTarget(f.target)),
  );

  // Split declared targets into registry hosts (symlink/fragment check below)
  // and supervision targets (plist/unit + binary check below) -- mirrors
  // installPerTarget's own per-target dispatch.
  const registryHosts: HostAdapter[] = [];
  const supervisionTargets: HostId[] = [];
  if (opts.manifest.targets && opts.manifest.targets.length > 0) {
    for (const targetId of opts.manifest.targets) {
      if (targetId === "darwin-launchd" || targetId === "linux-systemd") {
        supervisionTargets.push(targetId);
      } else {
        registryHosts.push(resolveHost(targetId, opts.hostOverrides));
      }
    }
  } else {
    registryHosts.push(opts.host);
  }

  // Fail-safe backstop -- see doc comment above.
  if (registryHosts.length === 0 && supervisionTargets.length === 0) {
    return false;
  }

  for (const targetHost of registryHosts) {
    let plan: ArtifactSymlinkPlan;
    try {
      plan = planArtifactSymlinks({
        type: opts.type,
        manifest: opts.manifest,
        arc: opts.arc,
        host: targetHost,
        installDir: opts.installDir,
      });
    } catch {
      // A throw means the artifact CANNOT have been validly dropped (e.g. an
      // unsafe bot-pack id) -- so a recorded "active" cannot reflect a real
      // drop. Treat as not-present so the caller re-runs install, which
      // surfaces the same error loudly instead of silently skipping.
      return false;
    }

    for (const link of plan.symlinkTargets) {
      if (declaredFileTargets.has(link.target)) {
        // provides.files: plain file or symlink -- presence is what matters.
        if (!existsSync(link.target)) return false;
      } else {
        // Primary per-type drop: must be a valid (non-dangling) symlink.
        if (!(await isValidSymlink(link.target))) return false;
      }
    }
  }

  for (const targetId of supervisionTargets) {
    const targetHost = resolveHost(targetId, opts.hostOverrides);
    const provides = opts.manifest.provides ?? {};

    if (targetId === "darwin-launchd") {
      if (!isDarwinLaunchdHost(targetHost)) return false;
      if (provides.plist) {
        const plistPath = join(targetHost.paths.plistDir, basename(provides.plist));
        if (!existsSync(plistPath)) return false;
      }
    } else {
      if (!isLinuxSystemdHost(targetHost)) return false;
      if (provides.systemdUnit) {
        const unitPath = join(targetHost.paths.unitDir, basename(provides.systemdUnit));
        if (!existsSync(unitPath)) return false;
      }
    }

    if (provides.binary) {
      const binPath = join(targetHost.paths.binDir, basename(provides.binary));
      if (!(await isValidSymlink(binPath))) return false;
    }
  }

  return true;
}

export async function createArtifactSymlinks(opts: {
  type: ArtifactType | "rules" | "system";
  manifest: ArcManifest;
  arc: ArcPaths;
  /** Target host adapter. Defaults to Claude-Code in the caller. */
  host: HostAdapter;
  installDir: string;
  consumerDir?: string;
  quiet?: boolean;
}): Promise<{
  filesCreated: { source: string; target: string }[];
  filesMissingSource: { source: string; target: string }[];
  record: ArtifactSymlinkRecord;
}> {
  const { type, manifest, arc, host, installDir, quiet } = opts;
  const record: ArtifactSymlinkRecord = { symlinks: [], shims: { dir: arc.shimDir, names: [] } };

  // Path computation is delegated to planArtifactSymlinks (arc#248) -- the SAME
  // plan the drop-presence verifier consumes -- so this step only APPLIES the
  // plan to the filesystem (plus the `rules` template-generation side effect
  // that has no symlink target).
  const plan = planArtifactSymlinks(opts);
  if (plan.filesMissingSource.length) {
    return { filesCreated: [], filesMissingSource: plan.filesMissingSource, record };
  }

  // `rules` and `governance` are the types whose apply step has a side effect
  // with no symlink target (template generation into the consumer repo).
  if (type === "rules" || type === "governance") {
    const templates = manifest.provides?.templates ?? [];
    if (templates.length) {
      const consumerDir = opts.consumerDir ?? process.cwd();
      const results = await generateRules(installDir, templates, consumerDir);
      if (!quiet) {
        for (const r of results) {
          if (r.success && r.target) {
            console.log(`  Generated ${r.target}`);
          } else if (!r.success) {
            console.log(`  \u26A0 ${r.target}: ${r.error}`);
          }
        }
      }
    }
  }

  // Apply the plan. provides.files targets may land outside the dirs
  // ensureDirectories pre-created; createSymlink mkdir's the parent regardless,
  // but we keep an explicit mkdir for the provides.files subset to preserve
  // prior behavior and to populate `filesCreated`.
  const declaredFileTargets = new Set(
    (manifest.provides?.files ?? []).map((f) => resolveProvidesTarget(f.target)),
  );
  const filesCreated: { source: string; target: string }[] = [];
  for (const link of plan.symlinkTargets) {
    const isProvidesFile = declaredFileTargets.has(link.target);
    if (isProvidesFile) {
      await mkdir(dirname(link.target), { recursive: true });
    }
    await createSymlink(link.source, link.target);
    record.symlinks.push(link.target);
    if (isProvidesFile) {
      filesCreated.push({ source: link.source, target: link.target });
    }
  }

  // Shims: createCliShim derives the SAME names from the manifest the plan did,
  // so create them once when the plan expects a shim set (mirrors the prior
  // per-type shim creation).
  if (plan.shimNames.length) {
    const created = await createCliShim(arc.shimDir, host.paths.binDir, manifest);
    record.shims.names.push(...created);
  }

  return { filesCreated, filesMissingSource: [], record };
}

/**
 * Roll back every symlink and shim recorded by createArtifactSymlinks.
 *
 * Called by install on:
 *   - Hook-validation gate failure (issue #89): symlinks placed but hooks
 *     not yet registered. Caller only needs this helper.
 *   - Postinstall-script failure (issue #97): symlinks AND hooks both placed
 *     before the script ran, so the caller pairs this with removeHooks
 *     before returning. recordInstall hasn't happened yet at that point,
 *     so no DB row to clean up.
 *
 * Best-effort across all entries: an ENOENT on one path doesn't abort
 * cleanup of the others. Non-ENOENT errors (e.g. permission denied) are
 * surfaced via console.warn so the user sees orphans they need to inspect
 * manually rather than failing silently.
 */
export async function rollbackArtifactSymlinks(record: ArtifactSymlinkRecord): Promise<void> {
  for (const link of record.symlinks) {
    try {
      await removeSymlink(link);
    } catch (err) {
      if (!isErrno(err) || err.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove symlink ${link}: ${errorMessage(err)}`);
      }
    }
  }
  for (const name of record.shims.names) {
    try {
      await removeCliShim(record.shims.dir, name);
    } catch (err) {
      if (!isErrno(err) || err.code !== "ENOENT") {
        console.warn(`  ⚠ rollback: failed to remove shim ${name}: ${errorMessage(err)}`);
      }
    }
  }
}

export interface NodeDependencyInstallResult {
  /** false when there was no package.json — nothing to install, not an error. */
  ran: boolean;
  success: boolean;
  /** Best-effort top-level node_modules entry count, for the summary line. */
  packageCount?: number;
  usedFrozenLockfile: boolean;
  /**
   * true when a `--frozen-lockfile` install failed because the committed
   * lockfile had drifted from `package.json`, and an unfrozen retry
   * recovered it. `success` is still `true` in that case — this flag exists
   * so `reportNodeDependencyResult` can WARN that reproducibility was lost,
   * without treating the install itself as failed.
   */
  staleLockfileRecovered?: boolean;
  /** Tail of stderr when `success` is false. */
  error?: string;
}

/** Tail of a spawnSync stderr buffer, for a short error summary. */
function stderrTail(result: { stderr?: Buffer }, exitCode: number | null): string {
  const tail = (result.stderr ?? Buffer.alloc(0))
    .toString()
    .trim()
    .split("\n")
    .slice(-5)
    .join("\n");
  return tail || `bun install exited ${exitCode}`;
}

function runBunInstall(dir: string, extraArgs: string[]) {
  return Bun.spawnSync(["bun", "install", ...extraArgs], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Run `bun install` if `package.json` exists in the given directory — so a
 * package's (or plugin bundle's, arc#284) declared npm dependencies resolve
 * into `node_modules` before symlinks/postinstall run (this is what makes
 * cortex's dynamic `import()` of a bundle entry resolve its deps).
 *
 * NOTE: this deliberately does NOT pass `--production`. It did briefly
 * during arc#284 development, but `runPostinstallPhase` runs immediately
 * after this step and ROLLS BACK the whole install on failure — a package
 * whose `postinstall` shells into a devDependency-provided binary (`tsc`,
 * `esbuild`, `prisma generate`, …) would abort, not warn. arc installs
 * skills and CLIs broadly; "the runtime never resolves a devDependency" is
 * too strong an assumption for that population. See the follow-up issue
 * linked from the arc#284/#289 PR for a scoped `--production` re-add with a
 * manifest opt-out.
 *
 * A lockfile (`bun.lock` / legacy `bun.lockb`) present in the directory gets
 * `--frozen-lockfile` first — reproducible, and matches what a well-behaved
 * repo expects. If that frozen install fails, it almost always means the
 * lockfile drifted from `package.json` (not that the dependency itself is
 * unresolvable) — bun's `--frozen-lockfile` hard-errors on ANY lockfile
 * change, including a harmless one. Silently downgrading that hard error to
 * a WARN-and-proceed would leave `node_modules` incomplete while the
 * install still records success (the exact bug class arc#284/#289 exists to
 * kill), so we retry once WITHOUT `--frozen-lockfile` — recovering the
 * common case (a plugin bundle whose lockfile just wasn't regenerated) while
 * still surfacing a WARN that reproducibility was lost
 * (`staleLockfileRecovered`). Only a failure that survives the unfrozen
 * retry is treated as a genuine dependency-resolution failure — see
 * `success: false` handling in `completeInstallTransaction` /
 * `upgradePackage`, which roll the install back rather than record success.
 *
 * Idempotent by construction: `bun install` re-run against an
 * already-satisfied `node_modules` is a fast no-op (arc#284 acceptance
 * criterion — re-install must be idempotent).
 */
export function installNodeDependencies(dir: string): NodeDependencyInstallResult {
  const packageJsonPath = join(dir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { ran: false, success: true, usedFrozenLockfile: false };
  }

  const hasLockfile =
    existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));

  if (hasLockfile) {
    const frozen = runBunInstall(dir, ["--frozen-lockfile"]);
    if (frozen.exitCode === 0) {
      return {
        ran: true,
        success: true,
        usedFrozenLockfile: true,
        packageCount: countTopLevelNodeModules(dir),
      };
    }

    // Frozen install failed — most likely a stale lockfile, not a genuine
    // dependency failure. Retry unfrozen so a drifted lockfile doesn't brick
    // the install (arc#289 blocker).
    const unfrozen = runBunInstall(dir, []);
    if (unfrozen.exitCode === 0) {
      return {
        ran: true,
        success: true,
        usedFrozenLockfile: false,
        staleLockfileRecovered: true,
        packageCount: countTopLevelNodeModules(dir),
      };
    }

    // Both attempts failed — a genuine dependency-resolution failure
    // (network, unresolvable dep), not a lockfile drift.
    return {
      ran: true,
      success: false,
      usedFrozenLockfile: false,
      error: stderrTail(unfrozen, unfrozen.exitCode),
    };
  }

  const result = runBunInstall(dir, []);
  if (result.exitCode !== 0) {
    return {
      ran: true,
      success: false,
      usedFrozenLockfile: false,
      error: stderrTail(result, result.exitCode),
    };
  }

  return {
    ran: true,
    success: true,
    usedFrozenLockfile: false,
    packageCount: countTopLevelNodeModules(dir),
  };
}

/** Best-effort count of top-level node_modules entries (not the full
 * resolved dependency-tree size, but enough for a one-line summary). */
function countTopLevelNodeModules(dir: string): number | undefined {
  try {
    const nodeModulesDir = join(dir, "node_modules");
    if (!existsSync(nodeModulesDir)) return undefined;
    return readdirSync(nodeModulesDir).filter((name) => !name.startsWith(".")).length;
  } catch {
    return undefined;
  }
}

/**
 * Surface a `bun install` result on the install log. Mirrors
 * `reportProvisioningResult` (identity-provision.ts): a FAILURE is written
 * to stderr unconditionally (even under `--yes`/quiet) so a bundle never
 * silently ships with an unresolved `node_modules`; a success respects
 * `quiet`. No-op when nothing ran (no package.json).
 */
export function reportNodeDependencyResult(
  result: NodeDependencyInstallResult,
  packageLabel: string,
  quiet: boolean,
): void {
  if (!result.ran) return;
  if (!result.success) {
    process.stderr.write(
      `arc: bun install failed for ${packageLabel} (node_modules may be incomplete):\n${result.error}\n`,
    );
    return;
  }
  if (result.staleLockfileRecovered) {
    // Unconditional (like the failure branch above): a stale lockfile is a
    // real signal the package needs `bun install` re-run + committed, even
    // though the install itself recovered.
    process.stderr.write(
      `arc: WARN — ${packageLabel} has a stale bun.lock (frozen install failed; recovered via unfrozen retry). ` +
        `Re-run \`bun install\` in the package and commit the updated lockfile.\n`,
    );
  }
  if (!quiet) {
    const count = result.packageCount != null ? `${result.packageCount} package(s)` : "dependencies";
    const mode = result.usedFrozenLockfile ? "--frozen-lockfile" : "no lockfile";
    console.log(`  ✓ bun install: ${count} for ${packageLabel} (${mode})`);
  }
}

/**
 * Parse a "library:artifact" colon-separated reference.
 *
 * Returns null if the ref looks like a URL (contains "/") rather than a library ref.
 * If there's no colon, returns { libraryName: ref } indicating the whole library.
 *
 * Examples:
 *   "mylib:tool-a"  -> { libraryName: "mylib", artifactName: "tool-a" }
 *   "mylib"         -> { libraryName: "mylib" }
 *   "https://..."   -> null (URL, not a library ref)
 *   "org/repo"      -> null (URL-like path)
 */
export function parseLibraryRef(ref: string): { libraryName: string; artifactName?: string } | null {
  // URLs contain "/" — not a library ref
  if (ref.includes("/")) {
    return null;
  }

  const colonIndex = ref.indexOf(":");
  if (colonIndex === -1) {
    // No colon: whole library
    return { libraryName: ref };
  }

  const libraryName = ref.slice(0, colonIndex);
  const artifactName = ref.slice(colonIndex + 1);

  if (!libraryName) {
    return null;
  }

  return { libraryName, artifactName: artifactName || undefined };
}

/** A library artifact paired with its manifest, as read by readLibraryArtifacts. */
export interface ArtifactEntry {
  entry: LibraryArtifactEntry;
  manifest: ArcManifest;
}

/**
 * Topologically sort a library's artifacts by `depends_on.packages`.
 *
 * F-6c (arc#227): library installs must land each artifact AFTER the artifacts
 * it depends on, so that e.g. `pilot` (depends_on agent-state) installs only
 * once `agent-state` is in place. Only intra-library dependencies constrain
 * ordering — a `depends_on.packages` entry that names a package NOT contained
 * in this library (an external dep such as a tool, or another repo's package)
 * is an install-time gate handled elsewhere (`install.ts` dep check), not an
 * ordering edge, so it is ignored here.
 *
 * Algorithm: Kahn's algorithm over the dependency DAG. Independent peers keep
 * their declaration order (stable), which keeps console output and the journal
 * deterministic. A cycle (direct, self, or transitive) leaves nodes unemitted
 * and throws with the offending names so the operator can fix the manifests.
 *
 * @throws Error if a dependency cycle is detected.
 */
export function toposortArtifacts(artifacts: ArtifactEntry[]): ArtifactEntry[] {
  // Index by artifact name so we can tell intra-library deps from external ones.
  const byName = new Map<string, ArtifactEntry>();
  for (const a of artifacts) {
    byName.set(a.manifest.name, a);
  }

  // Build the dependency edges (dependency -> dependent) and in-degrees,
  // counting only deps that resolve to another artifact in THIS library.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const a of artifacts) {
    inDegree.set(a.manifest.name, inDegree.get(a.manifest.name) ?? 0);
  }
  for (const a of artifacts) {
    const deps = a.manifest.depends_on?.packages ?? [];
    for (const dep of deps) {
      if (!byName.has(dep.name)) continue; // external dep — not an ordering edge
      const list = dependents.get(dep.name) ?? [];
      list.push(a.manifest.name);
      dependents.set(dep.name, list);
      inDegree.set(a.manifest.name, (inDegree.get(a.manifest.name) ?? 0) + 1);
    }
  }

  // Kahn's algorithm. Seed the queue in declaration order to keep peers stable.
  const queue: string[] = [];
  for (const a of artifacts) {
    if ((inDegree.get(a.manifest.name) ?? 0) === 0) {
      queue.push(a.manifest.name);
    }
  }

  const ordered: ArtifactEntry[] = [];
  let cursor = 0;
  while (cursor < queue.length) {
    const name = queue[cursor++];
    const node = byName.get(name);
    if (node) ordered.push(node);
    for (const dependent of dependents.get(name) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }

  if (ordered.length !== artifacts.length) {
    const emitted = new Set(ordered.map((o) => o.manifest.name));
    const unresolved = artifacts
      .map((a) => a.manifest.name)
      .filter((n) => !emitted.has(n));
    throw new Error(
      `Dependency cycle detected among library artifacts: ${unresolved.join(", ")}`,
    );
  }

  return ordered;
}

/**
 * Read the RAW `id:` string from a cortex agent identity fragment. Returns
 * `undefined` when the file is unreadable, not a YAML map, or `id` is absent
 * or not a string — those cases fall back to the manifest name (the caller
 * validates safety either way; cortex's loader validates the fragment after
 * the drop). NO safety filtering here: a present-but-unsafe id must surface
 * as an error upstream, never silently degrade to the fallback.
 */
function readRawAgentFragmentId(fragmentPath: string): string | undefined {
  try {
    const raw = YAML.parse(readFileSync(fragmentPath, "utf-8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const id = (raw as Record<string, unknown>).id;
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
  } catch (err) {
    console.warn(
      `arc: could not read agent fragment id from ${fragmentPath}: ${errorMessage(err)}`,
    );
    return undefined;
  }
}

/**
 * An agent id is used as a FILENAME STEM under agents.d/ and personas/ — it
 * must not be able to escape those directories (sage arc#238 round 1
 * blocker: an id containing `/` or `..` would symlink outside agents.d).
 * Accepts cortex-conventional ids only: case-insensitive alphanumerics
 * plus `.`, `_`, `-`, starting alphanumeric, and no `..` sequence anywhere.
 * Returns `undefined` for anything else.
 */
export function sanitizeAgentId(id: string): string | undefined {
  if (id.length === 0 || id.length > 128) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return undefined;
  if (id.includes("..")) return undefined;
  return id;
}
