import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dirtyWorktreeEntries, restoreHead } from "../../src/lib/git-tree.js";

let repo: string;

function git(...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "arc-git-tree-"));
  git("init");
  await Bun.write(join(repo, "tracked.txt"), "one\n");
  git("add", ".");
  git("-c", "user.name=T", "-c", "user.email=t@t.t", "commit", "-m", "init");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/**
 * The dirty-tree guard and the HEAD restore are shared by `arc install`'s
 * arc#396 re-pin and `arc verify`'s clean-repo check. Both are safety gates,
 * so both are tested on their own terms rather than only through install().
 */
describe("dirtyWorktreeEntries", () => {
  test("a clean checkout reports nothing", () => {
    expect(dirtyWorktreeEntries(repo)).toEqual([]);
  });

  test("a modified tracked file is reported", () => {
    Bun.spawnSync(["sh", "-c", `echo two > ${join(repo, "tracked.txt")}`]);
    const entries = dirtyWorktreeEntries(repo);
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain("tracked.txt");
  });

  test("arc's own install leavings do not count as dirty", () => {
    // arc runs `bun install` inside the package checkout, so these are arc's
    // own droppings — counting them would make the guard fire on nearly every
    // package with a package.json.
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    Bun.spawnSync(["sh", "-c", `echo x > ${join(repo, "node_modules", "m.txt")}`]);
    Bun.spawnSync(["sh", "-c", `echo '{}' > ${join(repo, "bun.lock")}`]);
    Bun.spawnSync(["sh", "-c", `echo x > ${join(repo, ".DS_Store")}`]);
    expect(dirtyWorktreeEntries(repo)).toEqual([]);
  });

  test("a non-repo path reports nothing rather than throwing", async () => {
    const bare = await mkdtemp(join(tmpdir(), "arc-not-a-repo-"));
    try {
      expect(dirtyWorktreeEntries(bare)).toEqual([]);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("restoreHead", () => {
  test("restores a branch by NAME, not by detaching at its SHA", () => {
    const branch = git("symbolic-ref", "--short", "HEAD").out;
    git("checkout", "--quiet", "--detach");
    expect(git("symbolic-ref", "--quiet", "--short", "HEAD").code).not.toBe(0);

    expect(restoreHead(repo, branch)).toBe(true);
    expect(git("symbolic-ref", "--short", "HEAD").out).toBe(branch);
  });

  test("reports failure instead of claiming a restore it did not perform", () => {
    // The caller uses this result to decide between "left the checkout at X"
    // and telling the operator the checkout is stranded. A silent `false`-less
    // failure would print the reassuring message over a broken state.
    expect(restoreHead(repo, "no-such-ref-anywhere")).toBe(false);
  });
});
