import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
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

function git(repoPath: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

function commit(repoPath: string, message: string): void {
  Bun.spawnSync(["git", "add", "-A"], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", message],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
}

/** Read → mutate → write the repo's arc-manifest.yaml, then commit. */
async function editManifest(
  repoPath: string,
  mutate: (m: Record<string, unknown>) => void,
  message: string,
): Promise<void> {
  const manifestPath = join(repoPath, "arc-manifest.yaml");
  const parsed = YAML.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
  mutate(parsed);
  await Bun.write(manifestPath, YAML.stringify(parsed));
  commit(repoPath, message);
}

function capabilityPairs(name: string): string[] {
  return (
    env.db
      .prepare("SELECT type, value FROM capabilities WHERE skill_name = ? ORDER BY type, value")
      .all(name) as { type: string; value: string }[]
  ).map((r) => `${r.type}:${r.value}`);
}

/**
 * arc#396 hardening pass — the trust breaks the review lanes confirmed on the
 * first cut. Each block names the specific way the first implementation could
 * still hand an operator a wrong-but-successful outcome.
 */
describe("arc#396 hardening — stale refs (F2 / F3 / W3)", () => {
  test("a MOVED remote tag re-pins to the new commit, not the stale local tag", async () => {
    // A tag is not immutable in practice: repos re-tag. `git fetch --tags`
    // without --force leaves the stale local tag in place, and resolving the
    // bare local candidate then pins the OLD commit while reporting success —
    // the arc#396 failure mode again, one layer down.
    const repo = await createMockSkillRepo(env.root, { name: "MovedTagSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });
    const installPath = join(env.arc.reposDir, "mock-MovedTagSkill");
    const staleSha = git(installPath, "rev-parse", "HEAD");

    // Origin re-tags v1.0.0 onto a NEW commit.
    await editManifest(repo.path, (m) => { m.version = "1.0.1"; }, "hotfix");
    Bun.spawnSync(["git", "tag", "-f", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    const retaggedSha = git(repo.path, "rev-parse", "v1.0.0^{commit}");
    expect(retaggedSha).not.toBe(staleSha);

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });

    expect(result.success).toBe(true);
    expect(git(installPath, "rev-parse", "HEAD")).toBe(retaggedSha);
    expect(result.repinned?.to).toBe(retaggedSha);
    expect(getSkill(env.db, "MovedTagSkill")?.version).toBe("1.0.1");
  });

  test("a re-pin to a BRANCH whose origin tip advanced lands on the new tip", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "AdvancedBranchSkill", version: "1.0.0" });
    const branch = git(repo.path, "symbolic-ref", "--short", "HEAD");

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: branch,
    });
    const installPath = join(env.arc.reposDir, "mock-AdvancedBranchSkill");
    const oldTip = git(installPath, "rev-parse", "HEAD");

    await editManifest(repo.path, (m) => { m.version = "2.0.0"; }, "advance branch");
    const newTip = git(repo.path, "rev-parse", "HEAD");
    expect(newTip).not.toBe(oldTip);

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: branch,
    });

    expect(result.success).toBe(true);
    expect(git(installPath, "rev-parse", "HEAD")).toBe(newTip);
    expect(git(installPath, "symbolic-ref", "--short", "HEAD")).toBe(branch);
  });

  test("an advanced branch is NOT reported as nothing-to-do", async () => {
    // The no-op path is the one that prints "already installed — nothing to
    // do" and exits 0. Reaching it while origin has moved is the same silent
    // lie arc#396 fixed.
    const repo = await createMockSkillRepo(env.root, { name: "NoopLieSkill", version: "1.0.0" });
    const branch = git(repo.path, "symbolic-ref", "--short", "HEAD");

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: branch,
    });

    await editManifest(repo.path, (m) => { m.version = "3.0.0"; }, "advance branch");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: branch,
    });

    expect(result.alreadyInstalled).toBeUndefined();
    expect(result.repinned).toBeDefined();
    expect(result.version).toBe("3.0.0");
    expect(getSkill(env.db, "NoopLieSkill")?.version).toBe("3.0.0");
  });

  test("refuses to fast-forward a local branch that DIVERGED from origin", async () => {
    // Fast-forwarding is only safe while the local branch is an ancestor of
    // the origin tip. A diverged branch carries local commits; `git reset
    // --hard` would delete an operator's work as a side effect of a re-pin.
    const repo = await createMockSkillRepo(env.root, { name: "DivergedSkill", version: "1.0.0" });
    const branch = git(repo.path, "symbolic-ref", "--short", "HEAD");

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: branch,
    });
    const installPath = join(env.arc.reposDir, "mock-DivergedSkill");

    // Local commit in the checkout…
    await Bun.write(join(installPath, "LOCAL.md"), "local work\n");
    commit(installPath, "local work");
    const localSha = git(installPath, "rev-parse", "HEAD");

    // …and an independent commit on origin.
    await editManifest(repo.path, (m) => { m.version = "2.0.0"; }, "origin work");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: branch,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("diverged");
    expect(git(installPath, "rev-parse", "HEAD")).toBe(localSha);
  });
});

describe("arc#396 hardening — confused deputy (F4)", () => {
  test("refuses when the installed row's repo URL differs from the requested one", async () => {
    // The path guard matches on `repo_url.endsWith(repoName)` — a BASENAME.
    // Two different repos can share one basename, and moving the wrong repo's
    // checkout to a ref from an unrelated repo is a confused deputy: the
    // caller names repo B and arc mutates repo A.
    const repoA = await createMockSkillRepo(join(env.root, "a"), { name: "Collide", version: "1.0.0" });
    const repoB = await createMockSkillRepo(join(env.root, "b"), { name: "Collide", version: "1.0.0" });
    expect(repoA.url).not.toBe(repoB.url);

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repoA.url, yes: true,
    });
    const installPath = join(env.arc.reposDir, "mock-Collide");
    const before = git(installPath, "rev-parse", "HEAD");

    Bun.spawnSync(["git", "tag", "v9.9.9"], { cwd: repoB.path, stdout: "pipe", stderr: "pipe" });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repoB.url, yes: true, pinnedRef: "9.9.9",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(repoA.url);
    expect(result.error).toContain(repoB.url);
    expect(git(installPath, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("arc#396 hardening — capability honesty (F1 / W1)", () => {
  test("a WIDENING re-pin without --yes is refused BEFORE anything moves", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "WidenSkill",
      version: "1.0.0",
      capabilities: { network: [{ domain: "api.example.com", reason: "telemetry" }] },
    });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });
    const installPath = join(env.arc.reposDir, "mock-WidenSkill");
    const before = git(installPath, "rev-parse", "HEAD");

    await editManifest(repo.path, (m) => {
      m.version = "2.0.0";
      (m.capabilities as Record<string, unknown>).filesystem = { write: ["~/.ssh"] };
    }, "widen capabilities");
    Bun.spawnSync(["git", "tag", "v2.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    // yes:false + no TTY (bun test) → the consent read returns nothing, which
    // is a refusal, not an approval.
    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: false, pinnedRef: "2.0.0",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("capabilities");
    expect(result.error).toContain("fs_write");
    // Nothing moved, and the recorded surface is untouched.
    expect(git(installPath, "rev-parse", "HEAD")).toBe(before);
    expect(capabilityPairs("WidenSkill")).toEqual(["network:api.example.com"]);
    expect(getSkill(env.db, "WidenSkill")?.version).toBe("1.0.0");
  });

  test("a WIDENING re-pin with --yes moves AND refreshes the recorded capabilities", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "WidenYesSkill",
      version: "1.0.0",
      capabilities: { network: [{ domain: "api.example.com", reason: "telemetry" }] },
    });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });
    expect(capabilityPairs("WidenYesSkill")).toEqual(["network:api.example.com"]);

    await editManifest(repo.path, (m) => {
      m.version = "2.0.0";
      (m.capabilities as Record<string, unknown>).filesystem = { write: ["~/.ssh"] };
    }, "widen capabilities");
    Bun.spawnSync(["git", "tag", "v2.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "2.0.0",
    });

    expect(result.success).toBe(true);
    expect(result.repinned).toBeDefined();
    expect(capabilityPairs("WidenYesSkill")).toEqual([
      "fs_write:~/.ssh",
      "network:api.example.com",
    ]);
  });

  test("a NARROWING re-pin needs no consent and drops the withdrawn capability", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "NarrowSkill",
      version: "1.0.0",
      capabilities: {
        network: [{ domain: "api.example.com", reason: "telemetry" }],
        filesystem: { write: ["~/.ssh"] },
      },
    });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });
    expect(capabilityPairs("NarrowSkill")).toEqual([
      "fs_write:~/.ssh",
      "network:api.example.com",
    ]);

    await editManifest(repo.path, (m) => {
      m.version = "2.0.0";
      delete (m.capabilities as Record<string, unknown>).filesystem;
    }, "narrow capabilities");
    Bun.spawnSync(["git", "tag", "v2.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    // No --yes: narrowing takes nothing new, so it must not stop to ask.
    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: false, pinnedRef: "2.0.0",
    });

    expect(result.success).toBe(true);
    expect(capabilityPairs("NarrowSkill")).toEqual(["network:api.example.com"]);
  });
});

describe("arc#396 hardening — dependencies move with the code (W2)", () => {
  test("a re-pin installs the node dependencies declared at the new ref", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "DepMoveSkill", version: "1.0.0" });
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "1.0.0",
    });
    const installPath = join(env.arc.reposDir, "mock-DepMoveSkill");
    expect(existsSync(join(installPath, "node_modules", "local-dep"))).toBe(false);

    // A file: dependency keeps this offline and deterministic — the point is
    // that `bun install` RAN against the new ref, not that npm is reachable.
    await Bun.write(
      join(repo.path, "local-dep", "package.json"),
      JSON.stringify({ name: "local-dep", version: "1.0.0" }) + "\n",
    );
    await Bun.write(
      join(repo.path, "package.json"),
      JSON.stringify({
        name: "dep-move-skill",
        version: "2.0.0",
        dependencies: { "local-dep": "file:./local-dep" },
      }) + "\n",
    );
    await editManifest(repo.path, (m) => { m.version = "2.0.0"; }, "add a dependency");
    Bun.spawnSync(["git", "tag", "v2.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, pinnedRef: "2.0.0",
    });

    expect(result.success).toBe(true);
    // A re-pin is meant to be equivalent to remove + pinned re-install; code
    // without its dependencies is not that.
    expect(existsSync(join(installPath, "node_modules", "local-dep"))).toBe(true);
  });
});

describe("arc#396 hardening — pin-ref injection guard inside install() (S3)", () => {
  test("a fresh install rejects an unsafe --pin value without shelling out to git", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "UnsafePinSkill", version: "1.0.0" });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
      pinnedRef: "--upload-pack=touch /tmp/pwned",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid pin ref");
  });

  test("a re-pin rejects an unsafe --pin value too", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "UnsafeRepinSkill", version: "1.0.0" });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
    });
    const installPath = join(env.arc.reposDir, "mock-UnsafeRepinSkill");
    const before = git(installPath, "rev-parse", "HEAD");

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true,
      pinnedRef: "--upload-pack=touch /tmp/pwned",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid pin ref");
    expect(git(installPath, "rev-parse", "HEAD")).toBe(before);
  });
});
