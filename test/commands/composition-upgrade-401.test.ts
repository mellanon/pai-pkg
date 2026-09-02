import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile, readFile } from "fs/promises";
import YAML from "yaml";
import { install } from "../../src/commands/install.js";
import { upgradePackage } from "../../src/commands/upgrade.js";
import { planMemberMoves } from "../../src/lib/composition-upgrade.js";
import {
  compositionInventory,
  compositionMembers,
  compositionRecord,
  getCapabilities,
  getSkill,
} from "../../src/lib/db.js";
import type { ToolProbe } from "../../src/lib/composition.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";

/**
 * arc#401 slice 3 — `arc upgrade <factory>` (docs/design-factory-type.md D3/D4).
 *
 * The one rule the whole command exists to keep: members move to the NEW
 * RELEASE'S PINS, never to floating latest. A factory release is a reproducible
 * snapshot (D4), so an upgrade that resolves "latest" for a member has silently
 * turned the factory back into the integration project the type deletes.
 *
 * The second rule is the honesty rule, borrowed from install: every refusal
 * fires BEFORE anything moves. A factory advertising v0.2.0 whose members are
 * still on v0.1.0's pins is a lie the DB would then tell forever.
 */

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

const allToolsPresent: ToolProbe = () => ({ found: true, path: "/usr/bin/stub", version: "9.9.9" });

async function writeFactoryRepo(
  root: string,
  name: string,
  extra: Record<string, unknown>,
  version = "0.1.0",
): Promise<string> {
  const dir = join(root, `mock-${name}`);
  await mkdir(dir, { recursive: true });
  await commitFactoryManifest(dir, name, version, extra, "init");
  return dir;
}

/** (Re)write a factory manifest and commit it — the shape of a new release. */
async function commitFactoryManifest(
  dir: string,
  name: string,
  version: string,
  extra: Record<string, unknown>,
  message: string,
): Promise<void> {
  const fresh = !Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  }).success;
  await writeFile(
    join(dir, "arc-manifest.yaml"),
    YAML.stringify({
      schema: "arc/v1",
      name,
      version,
      type: "factory",
      tier: "custom",
      description: `${name} composition`,
      license: "Apache-2.0",
      author: { name: "Test", github: "test" },
      ...extra,
    }),
  );
  if (fresh) Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@t.co", "commit", "-m", message],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
}

function tagRepo(path: string, version: string): void {
  Bun.spawnSync(["git", "tag", `v${version}`], { cwd: path, stdout: "pipe", stderr: "pipe" });
}

/** Publish a new member version: bump the manifest, commit, tag. */
async function releaseMember(
  path: string,
  version: string,
  mutate?: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = join(path, "arc-manifest.yaml");
  const manifest = YAML.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.version = version;
  mutate?.(manifest);
  await writeFile(manifestPath, YAML.stringify(manifest));
  Bun.spawnSync(["git", "add", "."], { cwd: path, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@t.co", "commit", "-m", `release ${version}`],
    { cwd: path, stdout: "pipe", stderr: "pipe" },
  );
  tagRepo(path, version);
}

// ───────────────────────────────────────────────────────────────────────────
// The planner — pure, and where every fail-closed rule lives
// ───────────────────────────────────────────────────────────────────────────

describe("arc#401 — planMemberMoves refuses rather than guesses", () => {
  const recorded = [
    {
      composition_name: "f",
      member_name: "alpha",
      member_version: "1.0.0",
      member_source: "repo",
      member_ref: "/tmp/alpha",
      position: 0,
      state: "landed",
    },
  ];

  test("a changed pin on a repo member is a move", () => {
    const plan = planMemberMoves(recorded, [{ name: "alpha", version: "1.1.0" }]);
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.moves).toEqual([
      { name: "alpha", from: "1.0.0", to: "1.1.0", ref: "/tmp/alpha" },
    ]);
  });

  test("an unchanged pin is not a move", () => {
    const plan = planMemberMoves(recorded, [{ name: "alpha", version: "1.0.0" }]);
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.moves).toEqual([]);
  });

  test("a REGISTRY member fails closed, naming arc#366", () => {
    const plan = planMemberMoves(
      [{ ...recorded[0], member_source: "registry", member_ref: "@scope/alpha" }],
      [{ name: "alpha", version: "1.1.0" }],
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain("366");
    expect(!plan.ok && plan.error).toContain("@scope/alpha");
  });

  test("a member ADDED by the new release fails closed — the combined review owns that decision", () => {
    const plan = planMemberMoves(recorded, [
      { name: "alpha", version: "1.0.0" },
      { name: "gamma", version: "3.0.0" },
    ]);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain("gamma");
    expect(!plan.ok && plan.error.toLowerCase()).toContain("adds");
  });

  test("a member DROPPED by the new release fails closed — removal is refcounted, not silent", () => {
    const plan = planMemberMoves(
      [
        recorded[0],
        { ...recorded[0], member_name: "beta", member_version: "2.0.0", position: 1 },
      ],
      [{ name: "alpha", version: "1.0.0" }],
    );
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain("beta");
    expect(!plan.ok && plan.error.toLowerCase()).toContain("drops");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The real move
// ───────────────────────────────────────────────────────────────────────────

describe("arc#401 D3/D4 — `arc upgrade <factory>` lands members on the new release's exact pins", () => {
  test("the factory and its member advance together; capability rows are refreshed", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      capabilities: { filesystem: { read: ["~/alpha"], write: [] } },
    });
    tagRepo(alpha.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "software-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    expect(
      (
        await install({
          arc: env.arc,
          host: env.host,
          db: env.db,
          repoUrl: factory,
          yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(true);

    // The new member release ADDS a network capability — the recorded surface
    // must follow the code that is now checked out.
    await releaseMember(alpha.path, "1.1.0", (m) => {
      (m.capabilities as Record<string, unknown>).network = [
        { host: "api.example.com", reason: "telemetry" },
      ];
    });
    // …and a LATER release exists that the factory does NOT pin. It must not land.
    await releaseMember(alpha.path, "2.0.0");

    await commitFactoryManifest(
      factory,
      "software-factory",
      "0.2.0",
      { references: [{ name: "alpha", version: "1.1.0", repo: alpha.url }] },
      "release 0.2.0",
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "software-factory");

    expect(result.success).toBe(true);
    expect(result.oldVersion).toBe("0.1.0");
    expect(result.newVersion).toBe("0.2.0");
    expect(result.members).toEqual([
      { success: true, name: "alpha", oldVersion: "1.0.0", newVersion: "1.1.0" },
    ]);

    // NEVER floating latest: 1.1.0, not 2.0.0.
    expect(getSkill(env.db, "alpha")!.version).toBe("1.1.0");
    expect(compositionMembers(env.db, "software-factory")).toHaveLength(1);
    expect(compositionMembers(env.db, "software-factory")[0].member_version).toBe("1.1.0");
    expect(compositionRecord(env.db, "software-factory")!.version).toBe("0.2.0");

    // Capabilities re-recorded per member (the replaceCapabilities pattern).
    const caps = getCapabilities(env.db, "alpha");
    expect(caps.some((c) => c.type === "network" && c.value === "api.example.com")).toBe(true);

    // The inventory snapshot is re-taken for the release now installed.
    const snapshot = compositionInventory(env.db, "software-factory");
    expect([...new Set(snapshot.map((e) => e.member))].sort()).toEqual([
      "alpha",
      "software-factory",
    ]);
  }, 180_000);

  test("a member pin with no reachable tag refuses BEFORE the factory moves", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "software-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    await commitFactoryManifest(
      factory,
      "software-factory",
      "0.2.0",
      { references: [{ name: "alpha", version: "9.9.9", repo: alpha.url }] },
      "release 0.2.0",
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "software-factory");

    expect(result.success).toBe(false);
    expect(result.error).toContain("9.9.9");
    // NOTHING moved.
    expect(getSkill(env.db, "software-factory")!.version).toBe("0.1.0");
    expect(getSkill(env.db, "alpha")!.version).toBe("1.0.0");
    expect(compositionMembers(env.db, "software-factory")[0].member_version).toBe("1.0.0");
  }, 180_000);

  test("a member whose manifest disagrees with its new pin refuses BEFORE the factory moves (D4)", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    // A tag that NAMES 1.1.0 but points at the commit whose manifest says 1.0.0.
    tagRepo(alpha.path, "1.1.0");

    const factory = await writeFactoryRepo(env.root, "software-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    await commitFactoryManifest(
      factory,
      "software-factory",
      "0.2.0",
      { references: [{ name: "alpha", version: "1.1.0", repo: alpha.url }] },
      "release 0.2.0",
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "software-factory");

    expect(result.success).toBe(false);
    expect(result.error).toContain("1.1.0");
    expect(result.error!.toLowerCase()).toContain("snapshot");
    expect(getSkill(env.db, "software-factory")!.version).toBe("0.1.0");
    expect(getSkill(env.db, "alpha")!.version).toBe("1.0.0");
  }, 180_000);

  test("a factory whose own source is the REGISTRY fails closed, naming arc#366", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "software-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    // DB truth: the factory reads as registry-sourced.
    env.db
      .prepare("UPDATE skills SET repo_url = ? WHERE name = ?")
      .run("@metafactory/software-factory@0.1.0", "software-factory");

    const result = await upgradePackage(env.db, env.arc, env.host, "software-factory");
    expect(result.success).toBe(false);
    expect(result.error).toContain("366");
    expect(getSkill(env.db, "software-factory")!.version).toBe("0.1.0");
  }, 180_000);

  test("an already-current factory is a clean no-op, not a member re-pin storm", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "software-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    const result = await upgradePackage(env.db, env.arc, env.host, "software-factory");
    expect(result.success).toBe(true);
    expect(result.oldVersion).toBe("0.1.0");
    expect(result.newVersion).toBe("0.1.0");
    expect(result.members ?? []).toEqual([]);
    expect(getSkill(env.db, "alpha")!.version).toBe("1.0.0");
  }, 180_000);
});
