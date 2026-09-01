import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync } from "fs";
import { join } from "path";
import { install } from "../../src/commands/install.js";
import { getSkill } from "../../src/lib/db.js";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

/** Commit the current worktree of `repoPath` with a fixed identity. */
function commit(repoPath: string, message: string): void {
  Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", message],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
}

function git(repoPath: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().trim();
}

/** Bump the manifest version in `repoPath`, commit it, and tag it. */
async function bumpAndTag(repoPath: string, from: string, to: string, tag: string): Promise<void> {
  const manifestPath = join(repoPath, "arc-manifest.yaml");
  const content = await Bun.file(manifestPath).text();
  await Bun.write(manifestPath, content.replace(from, to));
  commit(repoPath, `bump to ${to}`);
  Bun.spawnSync(["git", "tag", tag], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
}

/**
 * arc#396: `arc install <repo> --pin <ref>` on an ALREADY-INSTALLED package
 * exited 0, printed success, and left the checkout wherever it was — the new
 * pin was silently ignored. The duplicate guard (`alreadyInstalled`) returned
 * before any git work, and `checkoutPinnedRef` sat inside the
 * `if (!existsSync(installPath))` clone branch, unreachable for an installed
 * package.
 *
 * A pinned install is a determinism claim, so exit 0 + wrong commit is the
 * worst possible answer: automation trusts it. The README already promised the
 * fixed behaviour ("Re-run `arc install --pin <ref>` to return to a specific
 * ref"), so the re-run now performs the checkout — refusing loudly rather than
 * clobbering a dirty tree.
 */
describe("install --pin on an already-installed package (arc#396)", () => {
  test("re-pin to a NEW ref moves the checkout, and reports the move", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "RepinSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    const first = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });
    expect(first.success).toBe(true);
    expect(first.version).toBe("1.0.0");

    const installPath = join(env.arc.reposDir, "mock-RepinSkill");
    const v1Sha = git(installPath, "rev-parse", "HEAD");

    // The new ref is created in the ORIGIN *after* the clone — so this also
    // proves the re-pin fetches before resolving.
    await bumpAndTag(repo.path, "1.0.0", "2.0.0", "v2.0.0");
    const v2Sha = git(repo.path, "rev-parse", "HEAD");
    expect(v2Sha).not.toBe(v1Sha);

    const second = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "2.0.0",
    });

    expect(second.success).toBe(true);
    expect(second.repinned).toBeDefined();
    expect(second.repinned?.ref).toBe("v2.0.0");
    expect(second.repinned?.from).toBe(v1Sha);
    expect(second.repinned?.to).toBe(v2Sha);
    // A move is not a no-op — the CLI must not print "nothing to do".
    expect(second.alreadyInstalled).toBeUndefined();

    // The checkout actually moved…
    expect(git(installPath, "rev-parse", "HEAD")).toBe(v2Sha);
    // …and the DB row records the version at the new ref, the same value a
    // fresh pinned install would have recorded.
    expect(second.version).toBe("2.0.0");
    expect(getSkill(env.db, "RepinSkill")?.version).toBe("2.0.0");
  });

  test("re-pin to the SAME ref is a no-op success, and moves nothing", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "SamePinSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    await bumpAndTag(repo.path, "1.0.0", "2.0.0", "v2.0.0");

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });

    const installPath = join(env.arc.reposDir, "mock-SamePinSkill");
    const before = git(installPath, "rev-parse", "HEAD");

    const again = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });

    expect(again.success).toBe(true);
    expect(again.alreadyInstalled).toBe(true);
    expect(again.repinned).toBeUndefined();
    expect(git(installPath, "rev-parse", "HEAD")).toBe(before);
    expect(getSkill(env.db, "SamePinSkill")?.version).toBe("1.0.0");
  });

  test("refuses LOUDLY to move a dirty working tree, and changes nothing", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "DirtyPinSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    await bumpAndTag(repo.path, "1.0.0", "2.0.0", "v2.0.0");

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });

    const installPath = join(env.arc.reposDir, "mock-DirtyPinSkill");
    const before = git(installPath, "rev-parse", "HEAD");

    // Local edit to a TRACKED file — the case where a blind checkout would
    // either clobber the edit or drag it across the move.
    await Bun.write(join(installPath, "skill", "SKILL.md"), "# hand-edited\n");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "2.0.0",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(installPath);
    expect(result.error).toContain("uncommitted changes");
    expect(result.error).toContain("skill/SKILL.md");
    // Nothing moved, nothing recorded.
    expect(git(installPath, "rev-parse", "HEAD")).toBe(before);
    expect(getSkill(env.db, "DirtyPinSkill")?.version).toBe("1.0.0");
  });

  test("a re-run WITHOUT --pin is unchanged: no-op success, checkout untouched", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "NoPinSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });

    const installPath = join(env.arc.reposDir, "mock-NoPinSkill");
    const before = git(installPath, "rev-parse", "HEAD");

    // The origin moves on; a pin-less re-run must NOT follow it (that is
    // `arc upgrade`'s job, not install's).
    await bumpAndTag(repo.path, "1.0.0", "2.0.0", "v2.0.0");

    const again = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
    });

    expect(again.success).toBe(true);
    expect(again.alreadyInstalled).toBe(true);
    expect(again.repinned).toBeUndefined();
    expect(again.version).toBe("1.0.0");
    expect(git(installPath, "rev-parse", "HEAD")).toBe(before);
  });

  test("an unresolvable re-pin fails loudly instead of succeeding at the old ref", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "BadRefSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });

    const installPath = join(env.arc.reposDir, "mock-BadRefSkill");
    const before = git(installPath, "rev-parse", "HEAD");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "no-such-ref",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ref "no-such-ref" not found');
    expect(git(installPath, "rev-parse", "HEAD")).toBe(before);
  });

  test("install-time noise (node_modules, bun.lock) does not count as a dirty tree", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "NoiseSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    await bumpAndTag(repo.path, "1.0.0", "2.0.0", "v2.0.0");

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });

    const installPath = join(env.arc.reposDir, "mock-NoiseSkill");
    // Exactly what `bun install` leaves behind in a package checkout — arc
    // itself creates it, so it must never block arc's own re-pin.
    mkdirSync(join(installPath, "node_modules"), { recursive: true });
    await Bun.write(join(installPath, "node_modules", "marker.txt"), "x\n");
    await Bun.write(join(installPath, "bun.lock"), "{}\n");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "2.0.0",
    });

    expect(result.success).toBe(true);
    expect(result.repinned).toBeDefined();
    expect(result.version).toBe("2.0.0");
  });

  test("re-pinning to a BRANCH whose tip is the current commit still lands ON the branch", async () => {
    // The subtle silent-success case: the commit is already right, so a
    // HEAD-SHA-only comparison would report "already at that ref" while the
    // checkout stayed detached — a different state from what a fresh
    // `--pin <branch>` install produces (a live tracking branch, arc#387).
    const repo = await createMockSkillRepo(env.root, { name: "BranchTipSkill", version: "1.0.0" });
    const defaultBranch = git(repo.path, "symbolic-ref", "--short", "HEAD");
    Bun.spawnSync(["git", "checkout", "-q", "-b", "release/x"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "checkout", "-q", defaultBranch], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    const tipSha = git(repo.path, "rev-parse", "release/x");

    // Install pinned to the raw SHA → detached HEAD at the branch tip.
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: tipSha,
    });

    const installPath = join(env.arc.reposDir, "mock-BranchTipSkill");
    expect(git(installPath, "rev-parse", "HEAD")).toBe(tipSha);

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "release/x",
    });

    expect(result.success).toBe(true);
    const branchProbe = Bun.spawnSync(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd: installPath, stdout: "pipe", stderr: "pipe" },
    );
    expect(branchProbe.exitCode).toBe(0);
    expect(branchProbe.stdout.toString().trim()).toBe("release/x");
  });
});
