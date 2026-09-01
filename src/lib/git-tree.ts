/**
 * Shared git working-tree helpers.
 *
 * Extracted (arc#396 review, S1) so `arc install`'s re-pin guard and `arc
 * verify`'s "Git repo clean" check share ONE definition of what counts as a
 * dirty checkout. They were independently correct and independently editable,
 * which is the shape a divergence bug arrives in: the day `verify` learns
 * about a new install artefact and `install` doesn't, the re-pin guard starts
 * refusing on arc's own droppings.
 */

/**
 * Working-tree entries that do NOT make a package checkout dirty.
 *
 * arc runs `bun install` inside the checkout it manages, so `node_modules/`
 * and `bun.lock` are arc's own leavings, not the operator's uncommitted work.
 * Counting them would make every guard built on this fire on practically any
 * package with a package.json — and a guard that always trips is a guard
 * nobody keeps.
 */
export const INSTALL_NOISE_ENTRY = /^(\?\? |..)?(node_modules\/|bun\.lock|\.DS_Store)$/;

/**
 * Porcelain status lines for `repoPath`, minus arc's own install leavings.
 *
 * Returns `[]` when git cannot report on the path at all (not a repo, git
 * missing): callers treat "no reportable changes" as clean, matching the
 * pre-extraction behaviour of `arc verify`'s check.
 */
export function dirtyWorktreeEntries(repoPath: string): string[] {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((l) => l && !INSTALL_NOISE_ENTRY.test(l));
}

/**
 * Put HEAD back on `target` after an aborted move, reporting whether it worked.
 *
 * `target` should be a BRANCH NAME when the checkout was on one — restoring by
 * SHA would silently detach a tracking branch, which is a different state from
 * the one being restored.
 *
 * The boolean matters: a caller that assumes success prints a reassuring
 * "left the checkout at X" over a checkout that is actually stranded
 * somewhere else. The trailing `--` is the same pathspec guard
 * `checkoutPinnedRef` uses (arc#387) — without it a `target` that happens to
 * name a path would "succeed" while restoring nothing.
 */
export function restoreHead(repoPath: string, target: string): boolean {
  return (
    Bun.spawnSync(["git", "checkout", "--quiet", target, "--"], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode === 0
  );
}
