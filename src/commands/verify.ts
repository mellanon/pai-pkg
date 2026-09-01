import { join, relative, basename } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import type { Database } from "bun:sqlite";
import type { ArcPaths, HostAdapter, LinuxSystemdHostPaths } from "../types.js";
import { getSkill, listSkills } from "../lib/db.js";
import { isValidSymlink } from "../lib/symlinks.js";
import { dirtyWorktreeEntries } from "../lib/git-tree.js";
import { readManifest } from "../lib/manifest.js";
import { listPackageHooks, findMissingHookFiles } from "../lib/hooks.js";
import { resolveHost, type HostOverrides } from "../lib/hosts/registry.js";

export interface VerifyCheck {
  check: string;
  passed: boolean;
  detail?: string;
}

export interface VerifyResult {
  name: string;
  checks: VerifyCheck[];
  allPassed: boolean;
  error?: string;
}

/**
 * Verify integrity of an installed skill.
 */
/**
 * Verify integrity of an installed skill.
 *
 * @param arc Unused until Phase 3c, which adds arc-state checks (db row /
 *   manifest cross-reference, sources.yaml integrity). Kept in the
 *   signature now so that pass doesn't churn every call site twice.
 * @param hostOverrides Per-host adapter overrides (arc#311 — test
 *   isolation for the linux-systemd orphaned-unit check below, mirrors
 *   `InstallOptions.hostOverrides`). Production leaves this absent.
 */
export async function verify(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  hostOverrides?: HostOverrides,
): Promise<VerifyResult> {
  const skill = getSkill(db, name);
  if (!skill) {
    return {
      name,
      checks: [],
      allPassed: false,
      error: `Skill '${name}' is not installed`,
    };
  }

  const checks: VerifyCheck[] = [];

  // Check 1: Repo directory exists
  const repoExists = existsSync(skill.install_path);
  checks.push({
    check: "Repo directory exists",
    passed: repoExists,
    detail: skill.install_path,
  });

  // Check 2: arc-manifest.yaml exists
  const manifest = await readManifest(skill.install_path);
  checks.push({
    check: "arc-manifest.yaml valid",
    passed: manifest !== null,
  });

  // Check 3: Skill symlink valid — only for active packages that actually ship
  // a skill. The installer creates the ~/.claude/skills/<name> link only for
  // skill/system types (planArtifactSymlinks); a type:tool package (e.g. a
  // CLI + hooks bundle like content-filter) has no skill link, so running this
  // check unconditionally reported a spurious ❌ (arc#334). Gate on the manifest
  // type so verify checks only what install placed.
  const providesSkill = manifest?.type === "skill" || manifest?.type === "system";
  if (skill.status === "active" && providesSkill) {
    const skillLink = join(host.paths.skillsDir, name);
    const linkValid = await isValidSymlink(skillLink);
    checks.push({
      check: "Skill symlink valid",
      passed: linkValid,
      detail: skillLink,
    });
  }

  // Check 4: Git repo clean.
  // Shares ONE definition of "dirty" with `arc install`'s arc#396 re-pin
  // guard (src/lib/git-tree.ts) — including the filter for arc's own
  // `bun install` leavings — so the two cannot drift.
  if (repoExists) {
    const dirtyLines = dirtyWorktreeEntries(skill.install_path);
    const isClean = dirtyLines.length === 0;
    checks.push({
      check: "Git repo clean",
      passed: isClean,
      detail: isClean ? undefined : "Uncommitted changes detected",
    });
  }

  // Check 5: Hook command paths in settings.json resolve.
  // Issue #85: arc verify previously only checked the repo checkout, not the
  // covenant settings.json expresses ("this command path is runnable"). A
  // package whose installer registered hooks pointing at files that were
  // never placed (see #84) would still pass verify. Walk the package's hooks
  // from settings.json and stat each absolute path token.
  const registeredHooks = listPackageHooks(name, host.paths.settingsPath);
  if (registeredHooks.length) {
    const missing = findMissingHookFiles(registeredHooks);
    if (missing.length === 0) {
      checks.push({
        check: `Hook command paths resolve (${registeredHooks.length} registered)`,
        passed: true,
      });
    } else {
      // For each missing path, hint whether the file exists under the
      // package's repo dir — if so, the manifest probably needs a
      // provides.files entry rather than a raw hook command pointing
      // at an un-symlinked location.
      const detailLines = missing.map((m) => {
        const hint = repoExists ? hintFromRepo(skill.install_path, m.missingPath) : "";
        return `${m.event}: ${m.command}\n      missing: ${m.missingPath}${hint}`;
      });
      checks.push({
        check: `Hook command paths resolve (${registeredHooks.length} registered)`,
        passed: false,
        detail: detailLines.join("\n    "),
      });
    }
  }

  // Check 6: no orphaned systemd units (arc#311). Scoped to packages that
  // declare a linux-systemd target -- a plain skill/tool's verify doesn't
  // pay for a unitDir scan it has no stake in.
  if (manifest?.targets?.includes("linux-systemd")) {
    const systemdHost = resolveHost("linux-systemd", hostOverrides);
    const orphans = await findOrphanedSystemdUnits(db, systemdHost);
    checks.push({
      check: `No orphaned systemd units (${orphans.length} found)`,
      passed: orphans.length === 0,
      detail: orphans.length ? orphans.map((o) => o.unitPath).join(", ") : undefined,
    });
  }

  return {
    name,
    checks,
    allPassed: checks.every((c) => c.passed),
  };
}

/**
 * A rendered systemd unit file found in `host.paths.unitDir` that a
 * DB-known arc package once declared but no longer actively claims.
 */
export interface OrphanedUnit {
  unitPath: string;
  reason: string;
}

/**
 * Scan the linux-systemd host's `unitDir` for `*.service` files that arc
 * once installed but no longer actively owns (arc#311, hardened per PR
 * #314 review). A unit left behind by an interrupted `arc remove`, or a
 * package disabled without its supervision side being torn down, shows up
 * here — none of arc's other checks catch a leftover unit file, since
 * `verify()` otherwise only inspects the ONE named package's own expected
 * drop.
 *
 * SCOPE (adversarial review, arc#311/PR#314): the first cut of this scan
 * flagged EVERY `.service` file not claimed by a currently-active package —
 * including a user's own unrelated, hand-written unit that arc never
 * touched. That's pure noise arc has no business reporting on. The fix:
 * a file is only a *candidate* for "orphaned" if its basename matches SOME
 * package arc's DB has ANY record of (active OR disabled — `listSkills`
 * returns both), not just currently-active ones. A basename with no DB
 * record at all — a stranger's unit — is skipped outright, never flagged.
 *
 * KNOWN GAP (accepted tradeoff, documented per review instruction): a unit
 * whose OWNING package's DB ROW has been fully deleted (`arc remove`
 * completing the DB step but leaving the unit file behind — e.g. an
 * interrupted teardown) is invisible to this scan, since nothing in the DB
 * still names its basename. Catching that would need a content-level
 * "rendered by arc" marker stamped into the unit at install time (the
 * review's other suggested option) — deferred as a follow-up; false
 * negatives here are strictly preferable to false-positiving on every
 * user's unrelated unit.
 */
export async function findOrphanedSystemdUnits(
  db: Database,
  host: HostAdapter,
): Promise<OrphanedUnit[]> {
  const unitDir = (host.paths as Partial<LinuxSystemdHostPaths>).unitDir;
  if (!unitDir || !existsSync(unitDir)) return [];

  // Basenames arc's DB has ANY record of declaring (active or disabled) --
  // the universe of files this scan is even allowed to comment on.
  const everKnown = new Set<string>();
  // Basenames a currently-ACTIVE package still claims -- not orphaned.
  const activeOwned = new Set<string>();
  for (const skill of listSkills(db)) {
    const skillManifest = await readManifest(skill.install_path);
    if (!skillManifest?.targets?.includes("linux-systemd")) continue;
    if (!skillManifest.provides?.systemdUnit) continue;
    const unitName = basename(skillManifest.provides.systemdUnit);
    everKnown.add(unitName);
    if (skill.status === "active") activeOwned.add(unitName);
  }

  const orphans: OrphanedUnit[] = [];
  for (const entry of readdirSync(unitDir)) {
    if (!entry.endsWith(".service")) continue;
    if (!everKnown.has(entry)) continue; // never arc's business -- skip, no noise
    if (activeOwned.has(entry)) continue; // still actively claimed
    orphans.push({
      unitPath: join(unitDir, entry),
      reason: "a DB-known arc package declares this unit but no longer actively claims it",
    });
  }
  return orphans;
}

/**
 * Suggest a fix when a missing hook target exists somewhere under the
 * package's repo dir. Common shape: caduceus declared
 *   command: ${PAI_DIR}/hooks/handlers/SkillNudge.ts
 * but the file actually lives at
 *   {repo}/hooks/handlers/SkillNudge.ts
 * and was never copied/symlinked into ${PAI_DIR}. Suggest adding a
 * provides.files entry so install lands the file at the expected target.
 */
function hintFromRepo(repoDir: string, missingPath: string): string {
  const basename = missingPath.split("/").pop();
  if (!basename) return "";
  const candidates = findFileInRepo(repoDir, basename, 4);
  if (candidates.length === 0) return "";
  const rel = relative(repoDir, candidates[0]);
  return `\n      hint: file exists at ${rel} in the package repo — add a provides.files entry to land it at the hook target`;
}

/**
 * Walk the package repo dir up to `maxDepth` levels deep looking for a file
 * matching `basename`. Returns absolute paths of matches. Skips node_modules
 * and dotdirs to keep the search bounded.
 */
function findFileInRepo(repoDir: string, basename: string, maxDepth: number): string[] {
  const matches: string[] = [];
  const skip = new Set(["node_modules", ".git"]);
  function walk(dir: string, depth: number): boolean {
    if (depth > maxDepth) return false;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || skip.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Short-circuit: once any subtree finds a match, stop walking siblings.
        if (walk(full, depth + 1)) return true;
      } else if (entry === basename) {
        matches.push(full);
        return true;
      }
    }
    return false;
  }
  walk(repoDir, 0);
  return matches;
}

/**
 * Format verify results for console display.
 */
export function formatVerify(result: VerifyResult): string {
  if (result.error) return `Error: ${result.error}`;

  const lines: string[] = [`Verify: ${result.name}`, ``];

  for (const check of result.checks) {
    const icon = check.passed ? "✅" : "❌";
    const detail = check.detail ? ` (${check.detail})` : "";
    lines.push(`  ${icon} ${check.check}${detail}`);
  }

  lines.push(``);
  lines.push(
    result.allPassed
      ? "All checks passed."
      : "Some checks failed — see above."
  );

  return lines.join("\n");
}
