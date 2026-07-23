/**
 * arc#361 — first-class `type: governance` install lifecycle.
 *
 * A governance package (e.g. compass-core) has NO per-type primary layout:
 * its drops are declared entirely via `provides.files` (a skill directory +
 * an agent .md, symlinked to the targets the manifest names) and its
 * `provides.templates` render into the consumer repo at INSTALL time,
 * exactly like `type: rules` (artifact-installer.ts apply step).
 *
 * The mock repo mirrors compass-core's real manifest shape: a skill dir under
 * claude/skills/governance, an agent file under claude/agents/governance.md,
 * and a CLAUDE.md.template keyed off compass.config.yaml.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove } from "../../src/commands/remove.js";
import { getSkill } from "../../src/lib/db.js";
import { mkdir, lstat, writeFile } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { join } from "path";
import YAML from "yaml";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

/**
 * Build + git-commit a mock governance package mirroring compass-core:
 * provides.files (skill dir + agent md) + provides.templates (CLAUDE.md).
 * Targets are absolute paths into the ISOLATED test host (never real ~).
 */
async function createMockGovernanceRepo(
  root: string,
  opts: {
    name: string;
    version?: string;
    skillTarget: string;
    agentTarget: string;
  },
): Promise<{ path: string; url: string }> {
  const repoDir = join(root, `mock-${opts.name}`);

  // Skill directory (compass-core: claude/skills/governance)
  await mkdir(join(repoDir, "claude", "skills", "governance", "workflows"), { recursive: true });
  await writeFile(
    join(repoDir, "claude", "skills", "governance", "SKILL.md"),
    `---\nname: Governance\ndescription: Mock governance skill\n---\n\n# Governance\n`,
  );
  await writeFile(
    join(repoDir, "claude", "skills", "governance", "workflows", "main.md"),
    `# Main workflow\n`,
  );

  // Agent persona (compass-core: claude/agents/governance.md)
  await mkdir(join(repoDir, "claude", "agents"), { recursive: true });
  await writeFile(
    join(repoDir, "claude", "agents", "governance.md"),
    `---\nname: governance\ndescription: Mock governance agent\n---\n\n# governance\n`,
  );

  // CLAUDE.md template rendered into consumers carrying compass.config.yaml
  await mkdir(join(repoDir, "templates"), { recursive: true });
  await writeFile(
    join(repoDir, "templates", "CLAUDE.md.template"),
    "# {PROJECT_NAME}\n\nGOVERNANCE-SENTINEL: rendered at install.\n",
  );

  const manifest = {
    name: opts.name,
    version: opts.version ?? "1.0.0",
    type: "governance",
    tier: "custom",
    description: "Mock governance engine (compass-core shape)",
    author: { name: "tester", github: "tester" },
    provides: {
      files: [
        { source: "claude/skills/governance", target: opts.skillTarget },
        { source: "claude/agents/governance.md", target: opts.agentTarget },
      ],
      templates: [
        {
          source: "templates/CLAUDE.md.template",
          target: "CLAUDE.md",
          config: "compass.config.yaml",
        },
      ],
    },
    depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
    capabilities: {
      filesystem: { read: [], write: [] },
      network: [],
      bash: { allowed: false },
      secrets: [],
    },
  };
  await writeFile(join(repoDir, "arc-manifest.yaml"), YAML.stringify(manifest));

  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "Initial commit"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
  return { path: repoDir, url: repoDir };
}

describe("arc#361 — type:governance install lifecycle", () => {
  test("install drops provides.files symlinks + renders templates; remove leaves no orphans", async () => {
    // Declared drop targets — the isolated host's skills/agents dirs, the
    // same shape compass-core targets on a real box (~/.claude/skills/… etc).
    const skillTarget = join(env.host.paths.skillsDir, "Governance");
    const agentTarget = join(env.host.paths.agentsDir, "governance.md");

    // Consumer repo opted into the template via compass.config.yaml.
    const consumerDir = join(env.root, "consumer-repo");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, "compass.config.yaml"),
      YAML.stringify({ project_name: "Consumer" }),
    );

    const repo = await createMockGovernanceRepo(env.root, {
      name: "GovCore",
      version: "1.0.0",
      skillTarget,
      agentTarget,
    });

    // 1. Install exits clean.
    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      consumerDir,
    });
    expect(result.success).toBe(true);

    // 2. Both provides.files symlinks exist at the declared targets and
    //    resolve into the cloned repo (symlink discipline — never hardcopy).
    expect((await lstat(skillTarget)).isSymbolicLink()).toBe(true);
    expect((await lstat(agentTarget)).isSymbolicLink()).toBe(true);
    const clonePath = join(env.arc.reposDir, "mock-GovCore");
    expect(realpathSync(skillTarget)).toBe(
      realpathSync(join(clonePath, "claude", "skills", "governance")),
    );
    expect(realpathSync(agentTarget)).toBe(
      realpathSync(join(clonePath, "claude", "agents", "governance.md")),
    );
    // The linked skill dir is readable through the symlink.
    expect(existsSync(join(skillTarget, "SKILL.md"))).toBe(true);

    // 3. Template rendered into the consumer at INSTALL time (rules parity —
    //    the arc#361 trigger extension in createArtifactSymlinks).
    const rendered = join(consumerDir, "CLAUDE.md");
    expect(existsSync(rendered)).toBe(true);
    const body = await Bun.file(rendered).text();
    expect(body).toContain("GOVERNANCE-SENTINEL: rendered at install.");
    expect(body).toContain("# Consumer"); // placeholder substitution ran

    // 4. DB row records the canonical type.
    const row = getSkill(env.db, "GovCore");
    expect(row).not.toBeNull();
    expect(row!.artifact_type).toBe("governance");
    expect(row!.status).toBe("active");

    // 5. Remove tears down BOTH provides.files links — no orphans — and
    //    deletes the DB row + clone.
    const removed = await remove(env.db, env.arc, env.host, "GovCore", { yes: true });
    expect(removed.success).toBe(true);
    expect(existsSync(skillTarget)).toBe(false);
    expect(existsSync(agentTarget)).toBe(false);
    expect(getSkill(env.db, "GovCore")).toBeNull();
    expect(existsSync(clonePath)).toBe(false);
  });

  test("governance package with no consumer config installs clean (template skipped, drops still land)", async () => {
    const skillTarget = join(env.host.paths.skillsDir, "Governance");
    const agentTarget = join(env.host.paths.agentsDir, "governance.md");
    const consumerDir = join(env.root, "bare-consumer");
    await mkdir(consumerDir, { recursive: true });

    const repo = await createMockGovernanceRepo(env.root, {
      name: "GovBare",
      skillTarget,
      agentTarget,
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: repo.url,
      yes: true,
      consumerDir,
    });
    expect(result.success).toBe(true);

    // Drops landed; the template render is a per-template soft failure
    // (config not found), never an install failure.
    expect((await lstat(skillTarget)).isSymbolicLink()).toBe(true);
    expect((await lstat(agentTarget)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(consumerDir, "CLAUDE.md"))).toBe(false);
  });
});
