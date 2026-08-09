import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, lstatSync, readlinkSync } from "fs";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install, parseNameVersion } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";
import { getSkill } from "../../src/lib/db.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("install command", () => {
  test("clones repo to repos directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);

    const repoDir = join(env.arc.reposDir, `mock-TestSkill`);
    expect(existsSync(repoDir)).toBe(true);
  });

  test("reads arc-manifest.yaml from cloned repo", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      version: "2.5.0",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("TestSkill");
    expect(result.version).toBe("2.5.0");
  });

  test("creates skill symlink in skills directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const skillLink = join(env.host.paths.skillsDir, "TestSkill");
    expect(existsSync(skillLink)).toBe(true);
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
  });

  test("creates bin symlink if CLI declared", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "_JIRA",
      withCli: true,
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const binLink = join(env.host.paths.binDir, "jira");
    expect(existsSync(binLink)).toBe(true);
    expect(lstatSync(binLink).isSymbolicLink()).toBe(true);
  });

  test("records entry in packages.db", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      version: "1.0.0",
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    const skill = getSkill(env.db, "TestSkill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("TestSkill");
    expect(skill!.status).toBe("active");
  });

  test("rejects repo without arc-manifest.yaml", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "BadSkill",
      withoutManifest: true,
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No arc-manifest.yaml");
  });

  test("installs manifest with authors array format", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "MultiAuthor",
      authors: [
        { name: "Jens-Christian Fischer", github: "jcfischer" },
        { name: "Andreas Aastroem", github: "mellanon" },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.manifest!.authors).toHaveLength(2);
    expect(result.manifest!.authors![0].name).toBe("Jens-Christian Fischer");
    expect(result.manifest!.author).toBeUndefined();
  });

  test("installs pipeline to pipelines directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "P_RSS_DIGEST",
      type: "pipeline",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("P_RSS_DIGEST");

    const pipelineLink = join(env.arc.pipelinesDir, "P_RSS_DIGEST");
    expect(existsSync(pipelineLink)).toBe(true);
    expect(lstatSync(pipelineLink).isSymbolicLink()).toBe(true);

    const skill = getSkill(env.db, "P_RSS_DIGEST");
    expect(skill).not.toBeNull();
    expect(skill!.artifact_type).toBe("pipeline");
  });

  test("removes pipeline and cleans up CLI shims", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "P_CLI_PIPE",
      type: "pipeline",
      withCli: true,
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // Verify installed
    const pipelineLink = join(env.arc.pipelinesDir, "P_CLI_PIPE");
    expect(existsSync(pipelineLink)).toBe(true);
    const binLink = join(env.host.paths.binDir, "p_cli_pipe");
    expect(existsSync(binLink)).toBe(true);

    // Remove
    const result = await remove(env.db, env.arc, env.host, "P_CLI_PIPE");
    expect(result.success).toBe(true);

    // Verify cleaned up
    expect(existsSync(pipelineLink)).toBe(false);
    expect(existsSync(binLink)).toBe(false);
    expect(getSkill(env.db, "P_CLI_PIPE")).toBeNull();
  });

  test("installs action to actions directory", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "A_DISCOVER_REPOS",
      type: "action",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("A_DISCOVER_REPOS");

    const actionLink = join(env.arc.actionsDir, "A_DISCOVER_REPOS");
    expect(existsSync(actionLink)).toBe(true);
    expect(lstatSync(actionLink).isSymbolicLink()).toBe(true);

    const skill = getSkill(env.db, "A_DISCOVER_REPOS");
    expect(skill).not.toBeNull();
    expect(skill!.artifact_type).toBe("action");

    // Remove
    const removeResult = await remove(env.db, env.arc, env.host, "A_DISCOVER_REPOS");
    expect(removeResult.success).toBe(true);
    expect(existsSync(actionLink)).toBe(false);
    expect(getSkill(env.db, "A_DISCOVER_REPOS")).toBeNull();
  });

  // arc#102 Phase 9.1 — type:agent install (git-URL path).
  test("installs canonical agent bundle (manifest at root, persona at agent/<name>.md)", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestAgent",
      type: "agent",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("TestAgent");

    // Bundle landed at the canonical reposDir path (the user-facing
    // contract from arc#102: `~/.config/metafactory/pkg/repos/<name>/`).
    const repoDir = join(env.arc.reposDir, "mock-TestAgent");
    expect(existsSync(repoDir)).toBe(true);
    expect(existsSync(join(repoDir, "arc-manifest.yaml"))).toBe(true);

    // DB row records the artifact_type so subsequent `arc list --type agent`
    // and host-side discovery can find this install.
    const skill = getSkill(env.db, "TestAgent");
    expect(skill).not.toBeNull();
    expect(skill!.artifact_type).toBe("agent");
    expect(skill!.status).toBe("active");

    // Symlink convenience: createArtifactSymlinks landed something under
    // agentsDir for legacy single-file discovery. The persona-driven
    // contract owned by the host (grove) does not depend on this, but
    // we keep the link-shape check so future regressions to the
    // artifact-installer agent case surface here.
    expect(existsSync(join(env.host.paths.agentsDir, "TestAgent.md"))).toBe(true);
  });

  // Persona-driven agent shape (arc#100 § 12) — no `capabilities` block.
  // Authority is declared in `guardrails`; the host enforces. Install
  // must succeed without forcing the publisher to declare capabilities.
  test("installs agent bundle without capabilities (persona-driven shape)", async () => {
    const repoDir = join(env.root, "mock-PersonaAgent");
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(join(repoDir, "agent"), { recursive: true });
    await writeFile(
      join(repoDir, "agent", "persona.md"),
      `# PersonaAgent\n\nVoice file. Host copies this to ~/.config/<host>/personas/<name>.md on install.\n`,
    );
    await writeFile(
      join(repoDir, "arc-manifest.yaml"),
      [
        `schema: pai/v1`,
        `name: PersonaAgent`,
        `version: 0.1.0`,
        `type: agent`,
        `tier: custom`,
        `description: Persona-driven agent (no capabilities block)`,
        `author:`,
        `  name: testuser`,
        `  github: testuser`,
        `persona:`,
        `  file: agent/persona.md`,
        `guardrails:`,
        `  allowedDirs:`,
        `    - "~/Developer/scope"`,
        `  disallowedTools:`,
        `    - Edit`,
        ``,
      ].join("\n"),
    );
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repoDir,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("PersonaAgent");

    const skill = getSkill(env.db, "PersonaAgent");
    expect(skill).not.toBeNull();
    expect(skill!.artifact_type).toBe("agent");
  });

  // Forge shape (arc#102): manifest nested under agent/ at the repo root.
  // The readManifest fallback discovers it; install lands the bundle at
  // ~/.config/metafactory/pkg/repos/<repo-name>/, with the manifest still
  // accessible at <bundle>/agent/arc-manifest.yaml — matching the smoke
  // test in arc#102.
  test("installs agent bundle with manifest nested under agent/ (forge shape)", async () => {
    const repoDir = join(env.root, "mock-NestedAgent");
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(join(repoDir, "agent"), { recursive: true });
    await writeFile(
      join(repoDir, "agent", "persona.md"),
      `# NestedAgent\n\nPersona.\n`,
    );
    await writeFile(
      join(repoDir, "agent", "scaffold-instance.sh"),
      `#!/bin/bash\necho "scaffolding $1"\n`,
    );
    await writeFile(
      join(repoDir, "agent", "CLAUDE.md"),
      `# Per-instance bridge\n`,
    );
    await writeFile(
      join(repoDir, "agent", "arc-manifest.yaml"),
      [
        `schema: pai/v1`,
        `name: NestedAgent`,
        `version: 0.1.0`,
        `type: agent`,
        `tier: custom`,
        `description: Agent bundle with manifest nested under agent/`,
        `author:`,
        `  name: testuser`,
        `  github: testuser`,
        `persona:`,
        `  file: persona.md`,
        ``,
      ].join("\n"),
    );
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repoDir,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.name).toBe("NestedAgent");

    // Bundle landed at canonical reposDir; manifest accessible at
    // <bundle>/agent/arc-manifest.yaml (matches arc#102 smoke test).
    const bundleRoot = join(env.arc.reposDir, "mock-NestedAgent");
    expect(existsSync(join(bundleRoot, "agent", "arc-manifest.yaml"))).toBe(true);
    expect(existsSync(join(bundleRoot, "agent", "persona.md"))).toBe(true);

    const skill = getSkill(env.db, "NestedAgent");
    expect(skill).not.toBeNull();
    expect(skill!.artifact_type).toBe("agent");
  });

  // Negative case: a non-agent manifest under agent/ must NOT be picked
  // up by the fallback. The fallback is gated to type: agent so we never
  // silently install a misplaced skill under the wrong layout.
  test("readManifest fallback into agent/ is gated to type: agent only", async () => {
    const repoDir = join(env.root, "mock-WrongTypeUnderAgent");
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(join(repoDir, "agent"), { recursive: true });
    await writeFile(
      join(repoDir, "agent", "arc-manifest.yaml"),
      [
        `name: WrongTypeUnderAgent`,
        `version: 0.1.0`,
        `type: skill`,
        `tier: custom`,
        `author:`,
        `  name: testuser`,
        `  github: testuser`,
        `provides:`,
        `  skill:`,
        `    - trigger: wrongtype`,
        `capabilities:`,
        `  filesystem: { read: [], write: [] }`,
        `  network: []`,
        `  bash: { allowed: false }`,
        `  secrets: []`,
        ``,
      ].join("\n"),
    );
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repoDir,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No arc-manifest.yaml");
  });

  test("arc#354: re-installing an already-installed skill is a no-op success", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
    });

    // First install
    const first = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });
    expect(first.success).toBe(true);

    // Second install is idempotent: harmless no-op success, not an error.
    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(result.name).toBe("TestSkill");
    expect(result.version).toBe(first.version);
    // Still exactly one DB row, still active.
    expect(getSkill(env.db, "TestSkill")?.status).toBe("active");
  });

  test("arc#354: re-install of a DISABLED skill still errors with an `arc enable` hint", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "DisabledReinstall",
    });

    await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });
    env.db.prepare("UPDATE skills SET status = 'disabled' WHERE name = ?").run("DisabledReinstall");

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // A disabled row is NOT silently "satisfied" — the operator must decide.
    expect(result.success).toBe(false);
    expect(result.error).toContain("status: disabled");
    expect(result.error).toContain("arc enable");
  });

  test("arc#158: rejects same-name install from a different repo URL without crashing", async () => {
    // Simulate the bug case: a row for the same name exists but with a
    // different repo_url (e.g., legacy tarball install registered as
    // "@scope/name@1.0.0", now the user tries a fresh git URL). Previously
    // this surfaced as a SQLite UNIQUE constraint stack trace from
    // recordInstall. The fix returns an actionable error instead.
    const now = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "DupeSkill",
        "0.1.3",
        "@metafactory/DupeSkill@0.1.3",
        "/legacy/path",
        "/legacy/path",
        "active",
        "skill",
        "official",
        now,
        now,
      );

    const repo = await createMockSkillRepo(env.root, {
      name: "DupeSkill",
      version: "0.1.4",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already installed");
    expect(result.error).toContain("0.1.3");
    expect(result.error).toMatch(/arc upgrade|arc remove/);

    // arc#158 review: clone leak — the install path we just cloned must be
    // cleaned up, mirroring the other early-exit paths in install.ts.
    const repoDir = join(env.arc.reposDir, "mock-DupeSkill");
    expect(existsSync(repoDir)).toBe(false);
  });

  test("arc#158: disabled-status duplicate hints at `arc enable`", async () => {
    const now = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "DisabledSkill",
        "0.1.0",
        "@metafactory/DisabledSkill@0.1.0",
        "/legacy/path",
        "/legacy/path",
        "disabled",
        "skill",
        "official",
        now,
        now,
      );

    const repo = await createMockSkillRepo(env.root, {
      name: "DisabledSkill",
      version: "0.2.0",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("status: disabled");
    expect(result.error).toContain("arc enable");
  });

  test("arc#354: same-name same-version active duplicate is a no-op success", async () => {
    const now = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "SameVersionSkill",
        "1.0.0",
        "@metafactory/SameVersionSkill@1.0.0",
        "/legacy/path",
        "/legacy/path",
        "active",
        "skill",
        "official",
        now,
        now,
      );

    const repo = await createMockSkillRepo(env.root, {
      name: "SameVersionSkill",
      version: "1.0.0",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
    });

    // arc#354: an active row at the SAME version means the install is already
    // satisfied — no-op success (was an "Already at v1.0.0, arc remove first"
    // error pre-#354).
    expect(result.success).toBe(true);
    expect(result.alreadyInstalled).toBe(true);
    expect(result.version).toBe("1.0.0");

    // The fresh clone made for the duplicate-name check is cleaned up, same
    // as the arc#158 error paths — no stray checkout left behind.
    const repoDir = join(env.arc.reposDir, "mock-SameVersionSkill");
    expect(existsSync(repoDir)).toBe(false);
  });

  test("installs pinned version by checking out git tag", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "VersionedSkill",
      version: "1.0.0",
    });

    // Create v1.0.0 tag on the initial commit
    Bun.spawnSync(
      ["git", "tag", "v1.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    // Make a new commit with v2.0.0
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await Bun.write(manifestPath, content.replace("1.0.0", "2.0.0"));
    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump to 2.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    Bun.spawnSync(
      ["git", "tag", "v2.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    // Install pinned to v1.0.0
    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "1.0.0",
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe("1.0.0");
  });

  test("fails when pinned version tag does not exist", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "NoTagSkill",
      version: "1.0.0",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "9.9.9",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Version 9.9.9 not found");
  });

  test("accepts version tag without v prefix", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "PlainTagSkill",
      version: "1.0.0",
    });

    // Create tag without v prefix
    Bun.spawnSync(
      ["git", "tag", "1.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "1.0.0",
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe("1.0.0");
  });

  test("installs a pinned branch as a live tracking branch, not detached", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "BranchSkill",
      version: "1.0.0",
    });

    const defaultBranchResult = Bun.spawnSync(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    const defaultBranch = defaultBranchResult.stdout.toString().trim();

    // Branch with a distinct manifest version, so we can tell which ref
    // landed.
    Bun.spawnSync(["git", "checkout", "-q", "-b", "feature/x"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await Bun.write(manifestPath, content.replace("1.0.0", "2.0.0"));
    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "branch bump"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    Bun.spawnSync(["git", "checkout", "-q", defaultBranch], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "feature/x",
    });

    expect(result.success).toBe(true);
    expect(result.version).toBe("2.0.0");

    const repoDir = join(env.arc.reposDir, "mock-BranchSkill");
    const branchResult = Bun.spawnSync(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    expect(branchResult.exitCode).toBe(0);
    expect(branchResult.stdout.toString().trim()).toBe("feature/x");
  });

  test("installs a pinned full commit SHA at exactly that commit", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "ShaSkill",
      version: "1.0.0",
    });

    const shaResult = Bun.spawnSync(
      ["git", "rev-parse", "HEAD"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    const sha = shaResult.stdout.toString().trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: sha,
    });

    expect(result.success).toBe(true);

    const repoDir = join(env.arc.reposDir, "mock-ShaSkill");
    const headResult = Bun.spawnSync(
      ["git", "rev-parse", "HEAD"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    expect(headResult.stdout.toString().trim()).toBe(sha);
  });

  test("installs a pinned short commit SHA at exactly the full commit", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "ShortShaSkill",
      version: "1.0.0",
    });

    const shaResult = Bun.spawnSync(
      ["git", "rev-parse", "HEAD"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    const sha = shaResult.stdout.toString().trim();
    const shortSha = sha.slice(0, 7);

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: shortSha,
    });

    expect(result.success).toBe(true);

    const repoDir = join(env.arc.reposDir, "mock-ShortShaSkill");
    const headResult = Bun.spawnSync(
      ["git", "rev-parse", "HEAD"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    expect(headResult.stdout.toString().trim()).toBe(sha);
  });

  test("fails with a clear message for an unresolvable ref", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "UnknownRefSkill",
      version: "1.0.0",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "no-such-ref",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ref "no-such-ref" not found');
  });

  test("does not strip the v prefix from a branch name (arc#387 regression guard)", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "VBranchSkill",
      version: "1.0.0",
    });

    const defaultBranchResult = Bun.spawnSync(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    const defaultBranch = defaultBranchResult.stdout.toString().trim();

    Bun.spawnSync(["git", "checkout", "-q", "-b", "v2-migration"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "checkout", "-q", defaultBranch], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "v2-migration",
    });

    expect(result.success).toBe(true);

    const repoDir = join(env.arc.reposDir, "mock-VBranchSkill");
    const branchResult = Bun.spawnSync(
      ["git", "symbolic-ref", "--short", "HEAD"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    expect(branchResult.exitCode).toBe(0);
    expect(branchResult.stdout.toString().trim()).toBe("v2-migration");
  });

  test("prefers the v-prefixed tag when both v-prefixed and bare tags exist", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "DualTagSkill",
      version: "1.0.0",
    });

    // v1.0.0 tags the initial commit (version 1.0.0).
    Bun.spawnSync(["git", "tag", "v1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    // A second commit, bumped to a distinct marker version, tagged with
    // the BARE name "1.0.0". If candidate order were bare-first (or
    // last-write-wins), pinning "1.0.0" would land here instead.
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await Bun.write(manifestPath, content.replace("1.0.0", "9.0.0"));
    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump to 9.0.0"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );
    Bun.spawnSync(["git", "tag", "1.0.0"], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "1.0.0",
    });

    expect(result.success).toBe(true);
    // Landed on the v1.0.0 tag (first commit), not the bare 1.0.0 tag
    // (second commit) — proves candidate order is v-prefixed first.
    expect(result.version).toBe("1.0.0");
  });

  test("rejects a --pin value that names a real file, not a ref (arc#387 pathspec-restore regression guard)", async () => {
    // git checkout <arg> silently accepts an <arg> that isn't a ref at all
    // but IS a path in the working tree — it reinterprets it as a pathspec
    // restore ("Updated 0 paths from the index"), exits 0, and leaves HEAD
    // untouched. Pre-#387 the semver-only regex made this collision
    // unlikely; post-#387 any string is a candidate, and every arc package
    // ships arc-manifest.yaml at its repo root. Without the rev-parse
    // --verify pre-check, this would come back success:true, silently
    // "pinned" to the default branch's HEAD instead of failing.
    const repo = await createMockSkillRepo(env.root, {
      name: "PathCollisionSkill",
      version: "1.0.0",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "arc-manifest.yaml",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ref "arc-manifest.yaml" not found');
  });

  test("rejects a --pin value that names a real directory, not a ref (arc#387 pathspec-restore regression guard)", async () => {
    // Same class as the file case above, but for a directory pathspec
    // (e.g. "skill", "docs", "src", "test") — git checkout treats a
    // directory argument the same way: silent no-op restore, exit 0.
    const repo = await createMockSkillRepo(env.root, {
      name: "DirCollisionSkill",
      version: "1.0.0",
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      pinnedRef: "skill",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ref "skill" not found');
  });
});

describe("install provides.files (issue #84)", () => {
  /**
   * Build a skill repo whose arc-manifest.yaml declares provides.files and/or
   * provides.hooks. Used to exercise the type-agnostic provides.files pass and
   * the hook-target validation gate.
   */
  async function buildRepoWithProvides(opts: {
    name: string;
    extraFiles?: Record<string, string>;
    providesFiles?: { source: string; target: string }[];
    providesHooks?: { event: string; command: string }[];
    providesCli?: { command: string; name: string }[];
    statuslineExtensions?: { name: string; source: string }[];
    postinstall?: { path: string; content: string };
  }): Promise<string> {
    const repoDir = join(env.root, `mock-${opts.name}`);
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(join(repoDir, "skill"), { recursive: true });
    await writeFile(
      join(repoDir, "skill", "SKILL.md"),
      `---\nname: ${opts.name}\ndescription: Test\n---\n# ${opts.name}\n`,
    );
    for (const [path, content] of Object.entries(opts.extraFiles ?? {})) {
      const abs = join(repoDir, path);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content);
    }
    const lines: string[] = [
      `name: ${opts.name}`,
      `version: 1.0.0`,
      `type: skill`,
      `tier: custom`,
      `author:`,
      `  name: testuser`,
      `  github: testuser`,
      `provides:`,
      `  skill:`,
      `    - trigger: ${opts.name.toLowerCase()}`,
    ];
    if (opts.providesFiles?.length) {
      lines.push(`  files:`);
      for (const f of opts.providesFiles) {
        lines.push(`    - source: ${JSON.stringify(f.source)}`);
        lines.push(`      target: ${JSON.stringify(f.target)}`);
      }
    }
    if (opts.providesHooks?.length) {
      lines.push(`  hooks:`);
      for (const h of opts.providesHooks) {
        lines.push(`    - event: ${h.event}`);
        lines.push(`      command: ${JSON.stringify(h.command)}`);
      }
    }
    if (opts.providesCli?.length) {
      lines.push(`  cli:`);
      for (const c of opts.providesCli) {
        lines.push(`    - command: ${JSON.stringify(c.command)}`);
        lines.push(`      name: ${c.name}`);
      }
    }
    if (opts.statuslineExtensions?.length) {
      lines.push(`extensions:`);
      lines.push(`  statusline:`);
      for (const ext of opts.statuslineExtensions) {
        lines.push(`    - name: ${ext.name}`);
        lines.push(`      source: ${JSON.stringify(ext.source)}`);
      }
    }
    if (opts.postinstall) {
      const scriptAbs = join(repoDir, opts.postinstall.path);
      await mkdir(join(scriptAbs, ".."), { recursive: true });
      await writeFile(scriptAbs, opts.postinstall.content);
      Bun.spawnSync(["chmod", "+x", scriptAbs], { stdout: "pipe", stderr: "pipe" });
      lines.push(`scripts:`);
      lines.push(`  postinstall: ${JSON.stringify(opts.postinstall.path)}`);
    }
    lines.push(`capabilities:`);
    lines.push(`  filesystem: { read: [], write: [] }`);
    lines.push(`  network: []`);
    lines.push(`  bash: { allowed: false }`);
    lines.push(`  secrets: []`);
    await writeFile(join(repoDir, "arc-manifest.yaml"), lines.join("\n") + "\n");
    Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=t@t.com", "commit", "-m", "init"],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
    );
    return repoDir;
  }

  test("honors provides.files entries on a skill-type package", async () => {
    const targetPath = join(env.root, "out", "handler.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "FileSkill",
      extraFiles: { "src/handler.ts": "// handler\n" },
      providesFiles: [{ source: "src/handler.ts", target: targetPath }],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(targetPath)).toBe(true);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(targetPath)).toContain("src/handler.ts");
  });

  test("fails install when provides.files source is missing from package", async () => {
    const targetPath = join(env.root, "out", "missing.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "MissingSourceSkill",
      providesFiles: [{ source: "src/missing.ts", target: targetPath }],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("provides.files");
    expect(result.error).toContain("src/missing.ts");
    expect(existsSync(targetPath)).toBe(false);
  });

  test("fails install when provides.hooks command points at non-existent file", async () => {
    const missingHandler = join(env.root, "ghost", "handler.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "GhostHookSkill",
      providesHooks: [
        { event: "Stop", command: missingHandler },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("hooks");
    expect(result.error).toContain(missingHandler);
    // settings.json must not have been written with the broken hook
    if (existsSync(env.host.paths.settingsPath)) {
      const settings = JSON.parse(await Bun.file(env.host.paths.settingsPath).text());
      const stopHooks = settings.hooks?.Stop ?? [];
      const ghostFound = stopHooks.some((g: { _arc_pkg?: string }) => g._arc_pkg === "GhostHookSkill");
      expect(ghostFound).toBe(false);
    }
  });

  test("provides.hooks with $PKG_DIR resolves to installed file and registers", async () => {
    const repoUrl = await buildRepoWithProvides({
      name: "GoodHookSkill",
      extraFiles: { "hooks/Stop.ts": "// stop\n" },
      providesHooks: [
        { event: "Stop", command: "${PKG_DIR}/hooks/Stop.ts" },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(true);
    const settings = JSON.parse(await Bun.file(env.host.paths.settingsPath).text());
    const stopHooks = settings.hooks?.Stop ?? [];
    const ours = stopHooks.find((g: { _arc_pkg?: string }) => g._arc_pkg === "GoodHookSkill");
    expect(ours).toBeDefined();
    expect(ours.hooks[0].command).toContain("hooks/Stop.ts");
    expect(ours.hooks[0].command).not.toContain("${PKG_DIR}");
  });

  // Issue #85 regression: caduceus shape — hook command uses ${PAI_DIR}/...
  // pointing at a file that was never landed at the target. Without
  // $PAI_DIR substitution upstream, the install gate would silently accept
  // the broken hook.
  test("fails install when ${PAI_DIR}-prefixed hook target was never landed", async () => {
    const repoUrl = await buildRepoWithProvides({
      name: "PaiDirGhostHook",
      providesHooks: [
        { event: "Stop", command: "${PAI_DIR}/hooks/handlers/SkillNudge.ts" },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("hooks");
    // Diagnostic should reference the resolved absolute path, not the literal ${PAI_DIR}.
    expect(result.error).toContain(env.host.paths.root);
    expect(result.error).toContain("SkillNudge.ts");
  });

  // Issue #89: rollback partial state on install failure.
  test("missing provides.files source: zero symlinks created (pre-validation)", async () => {
    const presentTarget = join(env.root, "out", "present.ts");
    const missingTarget = join(env.root, "out", "missing.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "RollbackPreValidate",
      extraFiles: { "src/present.ts": "// present\n" },
      providesFiles: [
        { source: "src/present.ts", target: presentTarget },
        { source: "src/missing.ts", target: missingTarget },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("provides.files");
    // Pre-validation kicked in BEFORE per-type symlinks: nothing landed
    // anywhere — neither the partial provides.files entry nor the skill dir.
    expect(existsSync(presentTarget)).toBe(false);
    expect(existsSync(missingTarget)).toBe(false);
    expect(existsSync(join(env.host.paths.skillsDir, "RollbackPreValidate"))).toBe(false);
  });

  test("hook gate failure rolls back per-type symlinks + provides.files targets + CLI shims", async () => {
    // Pre-validation passes (provides.files source exists), per-type primary
    // symlinks get created, CLI shim gets created, provides.files target
    // gets created. Then the hook gate trips on a separate
    // ${PAI_DIR}/Ghost.ts entry. Install must fail AND clean up everything
    // that was placed before the gate ran.
    const filesTarget = join(env.host.paths.root, "handlers", "Live.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "RollbackOnHookGate",
      extraFiles: {
        "handlers/Live.ts": "// live\n",
        "src/cli.ts": "#!/usr/bin/env bun\nconsole.log('hi');\n",
      },
      providesFiles: [{ source: "handlers/Live.ts", target: filesTarget }],
      providesCli: [{ command: "bun src/cli.ts", name: "rollbackgate" }],
      providesHooks: [
        // Live.ts will be landed by provides.files — fine.
        { event: "Stop", command: "${PAI_DIR}/handlers/Live.ts" },
        // Ghost.ts is NOT landed by anything — hook gate must reject.
        { event: "Stop", command: "${PAI_DIR}/handlers/Ghost.ts" },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("hooks");
    // Every artifact placed before the gate must be gone.
    expect(existsSync(join(env.host.paths.skillsDir, "RollbackOnHookGate"))).toBe(false);
    expect(existsSync(filesTarget)).toBe(false);
    // bin symlink + PATH shim for the declared CLI
    expect(existsSync(join(env.host.paths.binDir, "rollbackgate"))).toBe(false);
    expect(existsSync(join(env.arc.shimDir, "rollbackgate"))).toBe(false);
  });

  // Issue #97: postinstall script failure leaves the same partial-state shape
  // as the hook-validation gate (#89) PLUS hooks already registered in
  // settings.json (registerHooks runs before postinstall). Install must tear
  // down both before returning.
  test("postinstall failure rolls back symlinks AND unregisters hooks", async () => {
    const filesTarget = join(env.host.paths.root, "handlers", "Live.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "PostinstallRollback",
      extraFiles: { "handlers/Live.ts": "// live\n" },
      providesFiles: [{ source: "handlers/Live.ts", target: filesTarget }],
      providesCli: [{ command: "bun src/cli.ts", name: "postrollback" }],
      providesHooks: [
        { event: "Stop", command: "${PAI_DIR}/handlers/Live.ts" },
      ],
      postinstall: {
        path: "scripts/postinstall.sh",
        content: "#!/bin/bash\nexit 1\n",
      },
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Postinstall script failed");
    expect(result.evidence?.rollback.attempted).toBe(true);
    expect(result.evidence?.dbCommitted).toBe(false);
    expect(result.evidence?.landedArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "symlink",
          path: join(env.host.paths.skillsDir, "PostinstallRollback"),
        }),
        expect.objectContaining({
          kind: "shim",
          name: "postrollback",
        }),
        expect.objectContaining({
          kind: "hook",
          settingsPath: env.host.paths.settingsPath,
        }),
      ]),
    );

    // Symlink rollback assertions (same shape as #89 hook-gate test).
    expect(existsSync(join(env.host.paths.skillsDir, "PostinstallRollback"))).toBe(false);
    expect(existsSync(filesTarget)).toBe(false);
    expect(existsSync(join(env.host.paths.binDir, "postrollback"))).toBe(false);
    expect(existsSync(join(env.arc.shimDir, "postrollback"))).toBe(false);

    // Hook unregistration assertion: settings.json was written by
    // registerHooks earlier in the install flow, then the package's group
    // was removed by removeHooks on postinstall failure. The file must
    // exist (otherwise we'd be silently passing the assertion when
    // registerHooks didn't run) AND not contain our group.
    expect(existsSync(env.host.paths.settingsPath)).toBe(true);
    const settings = JSON.parse(await Bun.file(env.host.paths.settingsPath).text());
    const stopHooks = settings.hooks?.Stop ?? [];
    const ours = stopHooks.find(
      (g: { _arc_pkg?: string }) => g._arc_pkg === "PostinstallRollback",
    );
    expect(ours).toBeUndefined();

    // No DB row — recordInstall happens after postinstall.
    const fromDb = getSkill(env.db, "PostinstallRollback");
    expect(fromDb).toBeNull();
  });

  test("postinstall failure rolls back extension wiring", async () => {
    const repoUrl = await buildRepoWithProvides({
      name: "ExtensionRollback",
      extraFiles: { "statusline/extension.sh": "#!/bin/bash\necho status\n" },
      statuslineExtensions: [
        { name: "extension-rollback", source: "statusline/extension.sh" },
      ],
      postinstall: {
        path: "scripts/postinstall.sh",
        content: "#!/bin/bash\nexit 1\n",
      },
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    const extensionPath = join(
      env.host.paths.root,
      "statusline.d",
      "extension-rollback.sh",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Postinstall script failed");
    expect(result.evidence?.rollback.attempted).toBe(true);
    expect(result.evidence?.landedArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "extension",
          name: "statusline:extension-rollback",
        }),
      ]),
    );
    expect(existsSync(extensionPath)).toBe(false);
  });

  test("install succeeds when ${PAI_DIR} hook target is landed via provides.files", async () => {
    const targetPath = join(env.host.paths.root, "hooks", "handlers", "Live.ts");
    const repoUrl = await buildRepoWithProvides({
      name: "PaiDirLiveHook",
      extraFiles: { "hooks/handlers/Live.ts": "// live\n" },
      providesFiles: [{ source: "hooks/handlers/Live.ts", target: targetPath }],
      providesHooks: [
        { event: "Stop", command: "${PAI_DIR}/hooks/handlers/Live.ts" },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host,
      db: env.db,
      repoUrl,
      yes: true,
    });

    expect(result.success).toBe(true);
    const settings = JSON.parse(await Bun.file(env.host.paths.settingsPath).text());
    const stopHooks = settings.hooks?.Stop ?? [];
    const ours = stopHooks.find((g: { _arc_pkg?: string }) => g._arc_pkg === "PaiDirLiveHook");
    expect(ours).toBeDefined();
    // Settings.json should contain the substituted absolute path, not the literal ${PAI_DIR}.
    expect(ours.hooks[0].command).toBe(targetPath);
    expect(ours.hooks[0].command).not.toContain("${PAI_DIR}");
  });
});

describe("install command — depends_on.skills compat WARN (arc#284)", () => {
  /** Run `fn`, capturing everything written to process.stderr. */
  async function captureStderr(fn: () => Promise<void>): Promise<string> {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = orig;
    }
    return captured.join("");
  }

  test("warns (does not fail) when an installed dependency violates the declared range", async () => {
    const upstream = await createMockSkillRepo(env.root, {
      name: "cortex",
      version: "5.9.0",
    });
    const upstreamResult = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: upstream.url, yes: true,
    });
    expect(upstreamResult.success).toBe(true);

    const downstream = await createMockSkillRepo(env.root, {
      name: "DiscordPlugin",
      dependsOnSkills: [{ name: "cortex", version: ">=6.0.0", reason: "needs SURFACE_SDK_VERSION 2" }],
    });

    let result;
    const stderr = await captureStderr(async () => {
      result = await install({
        arc: env.arc, host: env.host, db: env.db, repoUrl: downstream.url, yes: true,
      });
    });

    // WARN, not hard-fail (burn-in posture) — the install still succeeds.
    expect(result!.success).toBe(true);
    expect(stderr).toContain("depends_on.skills: cortex@>=6.0.0");
    expect(stderr).toContain("installed cortex is v5.9.0");
    expect(stderr).toContain("needs SURFACE_SDK_VERSION 2");
  });

  test("stays silent when the installed dependency satisfies the declared range", async () => {
    const upstream = await createMockSkillRepo(env.root, {
      name: "cortex",
      version: "6.3.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: upstream.url, yes: true });

    const downstream = await createMockSkillRepo(env.root, {
      name: "SlackPlugin",
      dependsOnSkills: [{ name: "cortex", version: ">=6.0.0" }],
    });

    let result;
    const stderr = await captureStderr(async () => {
      result = await install({
        arc: env.arc, host: env.host, db: env.db, repoUrl: downstream.url, yes: true,
      });
    });

    expect(result!.success).toBe(true);
    expect(stderr).not.toContain("depends_on.skills");
  });

  test("stays silent when the declared dependency isn't installed at all (not this check's job)", async () => {
    const downstream = await createMockSkillRepo(env.root, {
      name: "OrphanPlugin",
      dependsOnSkills: [{ name: "cortex", version: ">=6.0.0" }],
    });

    let result;
    const stderr = await captureStderr(async () => {
      result = await install({
        arc: env.arc, host: env.host, db: env.db, repoUrl: downstream.url, yes: true,
      });
    });

    expect(result!.success).toBe(true);
    expect(stderr).not.toContain("depends_on.skills");
  });
});

describe("parseNameVersion", () => {
  test("parses name@version", () => {
    expect(parseNameVersion("MySkill@1.2.0")).toEqual({ name: "MySkill", version: "1.2.0" });
  });

  test("parses name@version with v prefix", () => {
    expect(parseNameVersion("MySkill@v2.0.0")).toEqual({ name: "MySkill", version: "2.0.0" });
  });

  test("returns null for bare name", () => {
    expect(parseNameVersion("MySkill")).toBeNull();
  });

  test("returns null for URLs", () => {
    expect(parseNameVersion("https://github.com/foo/bar")).toBeNull();
    expect(parseNameVersion("git@github.com:foo/bar.git")).toBeNull();
  });

  test("returns null for scoped refs", () => {
    expect(parseNameVersion("@scope/name@1.0.0")).toBeNull();
  });

  test("returns null for non-semver suffix", () => {
    expect(parseNameVersion("Skill@latest")).toBeNull();
    expect(parseNameVersion("Skill@main")).toBeNull();
  });

  test("handles minor-only semver", () => {
    expect(parseNameVersion("Skill@1.0")).toEqual({ name: "Skill", version: "1.0" });
  });
});
