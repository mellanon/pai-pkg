import { readFileSync } from "fs";
import { join } from "path";
import { dropUntrackedBunLock, installNodeDependencies } from "../lib/artifact-installer.js";

export interface SelfUpdateResult {
  success: boolean;
  oldVersion: string;
  newVersion: string;
  commitsPulled: number;
  error?: string;
}

/**
 * Update arc itself by pulling latest from git and reinstalling deps.
 * Refuses to update if running from a dev checkout (dirty tree or non-main branch).
 */
export async function selfUpdate(): Promise<SelfUpdateResult> {
  // This file is at src/commands/self-update.ts — root is two levels up
  const pkgRoot = join(import.meta.dir, "..", "..");
  const pkgJsonPath = join(pkgRoot, "package.json");

  // Read current version
  let oldVersion: string;
  try {
    const pkg = (await Bun.file(pkgJsonPath).json()) as { version: string };
    oldVersion = pkg.version;
  } catch {
    return { success: false, oldVersion: "unknown", newVersion: "unknown", commitsPulled: 0, error: "Could not read package.json" };
  }

  // Dev checkout guard: refuse if dirty tree or non-main branch
  const devGuard = checkDevCheckout(pkgRoot);
  if (devGuard) {
    return { success: false, oldVersion, newVersion: oldVersion, commitsPulled: 0, error: devGuard };
  }

  // Capture HEAD before pull
  const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: pkgRoot, stdout: "pipe", stderr: "pipe",
  }).stdout.toString().trim();

  // arc#386: a checkout that predates arc tracking bun.lock has an
  // untracked one lying around. `git pull --ff-only` refuses to overwrite
  // an untracked file the incoming commit also adds, which would otherwise
  // brick self-update on exactly the release meant to fix this. Safe to
  // drop — `installNodeDependencies` below regenerates it.
  dropUntrackedBunLock(pkgRoot);

  // git pull --ff-only
  const pull = Bun.spawnSync(["git", "pull", "--ff-only"], {
    cwd: pkgRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (pull.exitCode !== 0) {
    const stderr = pull.stderr.toString().trim();
    return {
      success: false,
      oldVersion,
      newVersion: oldVersion,
      commitsPulled: 0,
      error: `git pull failed: ${stderr}`,
    };
  }

  // Count commits pulled
  let commitsPulled = 0;
  const headAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: pkgRoot, stdout: "pipe", stderr: "pipe",
  }).stdout.toString().trim();
  if (headBefore && headAfter && headBefore !== headAfter) {
    const countResult = Bun.spawnSync(
      ["git", "rev-list", "--count", `${headBefore}..${headAfter}`],
      { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" }
    );
    if (countResult.exitCode === 0) {
      commitsPulled = parseInt(countResult.stdout.toString().trim(), 10) || 0;
    } else {
      commitsPulled = 1; // at least one commit changed
    }
  }

  // bun install (in case deps changed) — routed through the shared
  // frozen-first / unfrozen-retry helper (arc#284/#289) so arc's own
  // self-update gets the same reproducible-install guarantee as every
  // package arc installs, now that arc ships a committed bun.lock (arc#386).
  const install = installNodeDependencies(pkgRoot);

  if (install.ran && !install.success) {
    return {
      success: false,
      oldVersion,
      newVersion: oldVersion,
      commitsPulled,
      error: `bun install failed: ${install.error ?? "unknown error"}`,
    };
  }

  // Read new version
  let newVersion: string;
  try {
    // Re-read from disk (not cached)
    const raw = await Bun.file(pkgJsonPath).text();
    const pkg = JSON.parse(raw) as { version: string };
    newVersion = pkg.version;
  } catch {
    newVersion = oldVersion;
  }

  return { success: true, oldVersion, newVersion, commitsPulled };
}

export interface SelfUpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

/**
 * Check if a newer version of arc is available.
 * Compares local package.json against the latest GitHub Release tag.
 */
export function checkSelfUpdate(): SelfUpdateCheck {
  const pkgRoot = join(import.meta.dir, "..", "..");
  const pkgJsonPath = join(pkgRoot, "package.json");

  let currentVersion: string;
  try {
    const raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string };
    currentVersion = raw.version;
  } catch {
    return { currentVersion: "unknown", latestVersion: null, updateAvailable: false };
  }

  // Check latest release tag via gh CLI
  try {
    const result = Bun.spawnSync(
      ["gh", "release", "view", "--repo", "the-metafactory/arc", "--json", "tagName", "--jq", ".tagName"],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 }
    );
    if (result.exitCode === 0) {
      const tag = result.stdout.toString().trim().replace(/^v/, "");
      if (tag) {
        const pa = currentVersion.split(".").map(Number);
        const pb = tag.split(".").map(Number);
        let newer = false;
        for (let i = 0; i < 3; i++) {
          if ((pa[i] ?? 0) < (pb[i] ?? 0)) { newer = true; break; }
          if ((pa[i] ?? 0) > (pb[i] ?? 0)) break;
        }
        return { currentVersion, latestVersion: tag, updateAvailable: newer };
      }
    }
  } catch {
    // gh not available — skip
  }

  // Fallback: check if local git has newer commits on remote
  try {
    Bun.spawnSync(["git", "fetch", "--quiet"], {
      cwd: pkgRoot,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const result = Bun.spawnSync(
      ["git", "rev-list", "HEAD..@{u}", "--count"],
      { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" }
    );
    if (result.exitCode === 0) {
      const count = parseInt(result.stdout.toString().trim(), 10);
      if (count > 0) {
        return { currentVersion, latestVersion: null, updateAvailable: true };
      }
    }
  } catch {
    // git not available or no remote — skip
  }

  return { currentVersion, latestVersion: null, updateAvailable: false };
}

export function formatSelfUpdateCheck(check: SelfUpdateCheck): string {
  if (!check.updateAvailable) return "";
  if (check.latestVersion) {
    return `arc update available: v${check.currentVersion} → v${check.latestVersion} (run \`arc self-upgrade\`)`;
  }
  return `arc update available (run \`arc self-upgrade\`)`;
}

export function formatSelfUpdate(result: SelfUpdateResult): string {
  if (!result.success) {
    return `Self-update failed: ${result.error}`;
  }

  if (result.oldVersion !== result.newVersion) {
    return `arc updated: v${result.oldVersion} → v${result.newVersion} (${result.commitsPulled} commit${result.commitsPulled === 1 ? "" : "s"})`;
  }

  if (result.commitsPulled > 0) {
    return `arc updated: pulled ${result.commitsPulled} new commit${result.commitsPulled === 1 ? "" : "s"} (version unchanged at v${result.newVersion})`;
  }

  return `arc already up to date at v${result.newVersion} — no new commits on remote.`;
}

// ---------------------------------------------------------------------------
// Dev checkout detection
// ---------------------------------------------------------------------------

/**
 * Check if the arc repo looks like a dev checkout rather than a managed install.
 * Returns an error message if self-update should be refused, or null if safe.
 */
function checkDevCheckout(pkgRoot: string): string | null {
  // Check current branch
  const branchResult = Bun.spawnSync(
    ["git", "branch", "--show-current"],
    { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" },
  );
  const branch = branchResult.exitCode === 0
    ? branchResult.stdout.toString().trim()
    : null;

  if (!branch) {
    return `Refusing self-update: arc repo is in detached HEAD state. This may indicate a tag-based checkout or interrupted rebase — update manually with git.`;
  }

  if (branch !== "main" && branch !== "master") {
    return `Refusing self-update: arc repo is on branch "${branch}" (expected main). This looks like a dev checkout — update manually with git.`;
  }

  // Check for uncommitted changes
  const statusResult = Bun.spawnSync(
    ["git", "status", "--porcelain"],
    { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (statusResult.exitCode === 0) {
    // Filter out expected untracked files from bun install — same shape as
    // the "Git repo clean" check in verify.ts:96. An untracked bun.lock
    // (left behind by a checkout that predates arc#386 tracking it) or
    // node_modules is not a sign of a dev checkout and must not block
    // self-update. A MODIFIED tracked lockfile (" M bun.lock" / "M  bun.lock")
    // still refuses below — that's genuine dependency drift.
    const ignored = /^(\?\? |..)?(node_modules\/|bun\.lock|\.DS_Store)$/;
    const status = statusResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter((l) => l && !ignored.test(l))
      .join("\n");
    if (status.length > 0) {
      return `Refusing self-update: arc repo has uncommitted changes. This looks like a dev checkout — commit or stash your changes first, or update manually with git.`;
    }
  }

  return null;
}
