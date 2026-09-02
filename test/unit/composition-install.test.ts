import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import YAML from "yaml";
import { install } from "../../src/commands/install.js";
import { list, formatListJson } from "../../src/commands/list.js";
import { listSkills, compositionMembers } from "../../src/lib/db.js";
import type { ToolProbe } from "../../src/lib/composition.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";

/**
 * arc#400 slice 2 — the TRUST PATH, end to end through `install()`.
 *
 * The invariant every test here defends: a refusal fires BEFORE any member
 * lands. "Lands" is measured the only way that matters to an operator — rows
 * in the skills table and drops on disk — not by whether some internal step
 * ran. D2's honesty rule is that a composition install is ONE reversible
 * decision, so a half-installed composition is the failure mode being locked
 * out.
 */

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

/** A probe that finds every binary — the "tools are fine" baseline. */
const allToolsPresent: ToolProbe = () => ({ found: true, path: "/usr/bin/stub", version: "9.9.9" });

/** Write a factory package repo (manifest only — a composition ships no payload). */
async function writeFactoryRepo(
  root: string,
  name: string,
  extra: Record<string, unknown>,
): Promise<string> {
  const dir = join(root, `mock-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "arc-manifest.yaml"),
    YAML.stringify({
      schema: "arc/v1",
      name,
      version: "0.1.0",
      type: "factory",
      tier: "custom",
      description: `${name} composition`,
      license: "Apache-2.0",
      author: { name: "Test", github: "test" },
      ...extra,
    }),
  );
  Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@t.co", "commit", "-m", "init"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  return dir;
}

/** Tag a mock repo so a pinned reference (D4 exact version) can be checked out. */
function tagRepo(path: string, version: string): void {
  Bun.spawnSync(["git", "tag", `v${version}`], { cwd: path, stdout: "pipe", stderr: "pipe" });
}

/** Records every member install attempt so "nothing landed" is assertable. */
function recordingInstaller() {
  const calls: string[] = [];
  return {
    calls,
    installMember: async (m: { reference: { name: string } }) => {
      calls.push(m.reference.name);
      return { success: true, version: "1.0.0" };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Refusal R1 — a range version in references[]
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 AC — a range version in references[] is a loud refusal", () => {
  test("install aborts, names the range, and lands NOTHING", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "range-factory", {
      references: [{ name: "@metafactory/cortex", version: ">=6.0.0" }],
    });
    const rec = recordingInstaller();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        resolve: async () => {
          throw new Error("resolution must never be reached for a range version");
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(">=6.0.0");
    expect(result.error!.toLowerCase()).toContain("exact");
    expect(rec.calls).toEqual([]);
    expect(listSkills(env.db)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refusal R2 — a missing tool, before any install
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 AC — a missing tool is a refusal BEFORE any install", () => {
  test("install aborts naming the binary; no reference is even resolved", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "tools-factory", {
      tools: [{ name: "gh", reason: "PR automation" }],
      references: [{ name: "@metafactory/cortex", version: "6.1.0" }],
    });
    const rec = recordingInstaller();
    let resolveCalls = 0;

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: (name) => ({ found: name !== "gh" }),
        installMember: rec.installMember,
        resolve: async () => {
          resolveCalls++;
          throw new Error("tools must be checked before any reference is resolved");
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("gh");
    expect(resolveCalls).toBe(0);
    expect(rec.calls).toEqual([]);
    expect(listSkills(env.db)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refusal R3 — a member manifest that fails validation
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 AC — a member manifest failing validation installs NOTHING (D2 honesty rule)", () => {
  test("the second member's failure prevents the FIRST from landing", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "bad-member-factory", {
      references: [
        { name: "good", version: "1.0.0", repo: "file:///good" },
        { name: "bad", version: "1.0.0", repo: "file:///bad" },
      ],
    });
    const rec = recordingInstaller();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        resolve: async (ref) => {
          if (ref.name === "bad") {
            return { ok: false, error: `member 'bad': Invalid arc-manifest.yaml: missing required field 'capabilities'` };
          }
          return {
            ok: true,
            member: {
              reference: ref,
              source: "repo" as const,
              ref: ref.repo!,
              manifest: {
                name: ref.name,
                version: ref.version,
                type: "skill",
                tier: "custom",
                capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
              },
            },
          };
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("bad");
    expect(result.error).toContain("capabilities");
    // The whole point: the GOOD member never landed either.
    expect(rec.calls).toEqual([]);
    expect(listSkills(env.db)).toEqual([]);
  });

  test("a member whose manifest version disagrees with its pin is refused (D4 at install)", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "pin-drift-factory", {
      references: [{ name: "drifted", version: "1.0.0", repo: "file:///drifted" }],
    });
    const rec = recordingInstaller();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: ref.repo!,
            manifest: { name: ref.name, version: "2.0.0", type: "skill", tier: "custom" },
          },
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("1.0.0");
    expect(result.error).toContain("2.0.0");
    expect(rec.calls).toEqual([]);
    expect(listSkills(env.db)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refusal R4 — the operator declines the ONE combined review
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 D2 — ONE confirmation replaces per-member prompts", () => {
  test("declining the combined review installs nothing", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "declined-factory", {
      references: [
        { name: "a", version: "1.0.0", repo: "file:///a" },
        { name: "b", version: "1.0.0", repo: "file:///b" },
      ],
    });
    const rec = recordingInstaller();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      // NOT --yes: the review runs and is declined.
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        confirm: async () => false,
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: ref.repo!,
            manifest: { name: ref.name, version: ref.version, type: "skill", tier: "custom" },
          },
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(rec.calls).toEqual([]);
    expect(listSkills(env.db)).toEqual([]);
  });

  test("the confirmation is asked EXACTLY ONCE for a three-member composition", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "one-prompt-factory", {
      references: [
        { name: "a", version: "1.0.0", repo: "file:///a" },
        { name: "b", version: "1.0.0", repo: "file:///b" },
        { name: "c", version: "1.0.0", repo: "file:///c" },
      ],
    });
    const rec = recordingInstaller();
    const reviews: string[][] = [];

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        confirm: async (lines) => {
          reviews.push(lines);
          return true;
        },
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: ref.repo!,
            manifest: {
              name: ref.name,
              version: ref.version,
              type: "skill",
              tier: "custom",
              capabilities: {
                filesystem: { read: [`~/${ref.name}`], write: [] },
                network: [],
                bash: { allowed: false },
                secrets: [],
              },
            },
          },
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(reviews.length).toBe(1);
    expect(rec.calls).toEqual(["a", "b", "c"]);
    // The single review shows the FULL union, attributed per member.
    const text = reviews[0].join("\n");
    for (const shown of ["~/a", "~/b", "~/c"]) expect(text).toContain(shown);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The happy path — one command, all members land, composition recorded
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 AC — one command installs the whole composition", () => {
  test("real members land, and the pinned composition is readable via `arc list --json`", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      capabilities: { filesystem: { read: ["~/alpha"], write: [] } },
    });
    tagRepo(alpha.path, "1.0.0");
    const beta = await createMockSkillRepo(env.root, {
      name: "beta",
      version: "2.1.0",
      capabilities: { bash: { allowed: true } },
    });
    tagRepo(beta.path, "2.1.0");

    const factory = await writeFactoryRepo(env.root, "software-factory", {
      produces: "software",
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "2.1.0", repo: beta.url },
      ],
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    expect(result.success).toBe(true);

    const installed = listSkills(env.db).map((s) => s.name).sort();
    expect(installed).toEqual(["alpha", "beta", "software-factory"]);

    const rows = compositionMembers(env.db, "software-factory");
    expect(rows.map((r) => `${r.member_name}@${r.member_version}`)).toEqual([
      "alpha@1.0.0",
      "beta@2.1.0",
    ]);

    // `arc list --json` exposes the composition — the shape #401 consumes.
    const json = JSON.parse(formatListJson(list(env.db))) as {
      packages: {
        name: string;
        composition?: { status: string; members: Record<string, string>[] };
      }[];
    };
    const factoryEntry = json.packages.find((p) => p.name === "software-factory")!;
    expect(factoryEntry.composition).toBeDefined();
    expect(factoryEntry.composition!.status).toBe("complete");
    expect(factoryEntry.composition!.members).toEqual([
      { name: "alpha", version: "1.0.0", source: "repo", ref: alpha.url, state: "landed" },
      { name: "beta", version: "2.1.0", source: "repo", ref: beta.url, state: "landed" },
    ]);
    // A non-composition package carries no composition key at all.
    expect(json.packages.find((p) => p.name === "alpha")!.composition).toBeUndefined();
  }, 60_000);

  test("a composition with NO references installs exactly as before (slice-1 no-op)", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "empty-factory", {});

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
    });

    expect(result.success).toBe(true);
    expect(listSkills(env.db).map((s) => s.name)).toEqual(["empty-factory"]);
    expect(compositionMembers(env.db, "empty-factory")).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D5 — tier MIN re-check at install (a WARNING, not a refusal)
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 D5 — the tier MIN re-check warns at install", () => {
  test("a factory declaring a tier above its members' MIN warns but still installs", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "tier-factory", {
      tier: "official",
      references: [{ name: "a", version: "1.0.0", repo: "file:///a" }],
    });
    const rec = recordingInstaller();
    const warnings: string[] = [];

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        warn: (line) => warnings.push(line),
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: ref.repo!,
            manifest: { name: ref.name, version: ref.version, type: "skill", tier: "community" },
          },
        }),
      },
    });

    expect(result.success).toBe(true);
    expect(rec.calls).toEqual(["a"]);
    expect(warnings.join("\n")).toContain("community");
  });
});
