import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import YAML from "yaml";
import { install } from "../../src/commands/install.js";
import { purge } from "../../src/commands/purge.js";
import { filesListing } from "../../src/commands/files.js";
import {
  compositionInventory,
  compositionMembers,
  compositionRecord,
  listSkills,
} from "../../src/lib/db.js";
import { diffCompositionInventory } from "../../src/lib/composition-inventory.js";
import type { ToolProbe } from "../../src/lib/composition.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";

/**
 * arc#401 slice 3 — composition LIFECYCLE (docs/design-factory-type.md D3/D6).
 *
 * D6 is #365's non-negotiable: install is a reversible decision. The
 * acceptance test IS the mechanical diff — post-purge, every path the
 * install-time inventory snapshot named must be gone, EXCEPT the user data
 * arc refuses by name. Everything else here defends the two ways that
 * guarantee can be wrong: taking down a member somebody else still needs, and
 * leaving an interrupted install's debris behind forever.
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
  version = "0.1.0",
): Promise<string> {
  const dir = join(root, `mock-${name}`);
  await mkdir(dir, { recursive: true });
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

// ───────────────────────────────────────────────────────────────────────────
// D6 — the acceptance diff
// ───────────────────────────────────────────────────────────────────────────

describe("arc#401 D6 — post-purge diff vs the install-time snapshot is EMPTY except user-data refusals", () => {
  test("the whole composition comes down; only the named workspace survives", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: {
        config: ["~/.config/metafactory/alpha"],
        state: ["~/.local/state/metafactory/alpha"],
        userData: ["~/Developer/alpha-workspace"],
      },
      files: [{ source: "files/drop", target: join(env.root, "fake-home", "alpha-drop.txt") }],
    });
    tagRepo(alpha.path, "1.0.0");

    const beta = await createMockSkillRepo(env.root, {
      name: "beta",
      version: "2.1.0",
      owns: { config: ["~/.config/metafactory/beta"] },
    });
    tagRepo(beta.path, "2.1.0");

    const factory = await writeFactoryRepo(env.root, "software-factory", {
      produces: "software",
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "2.1.0", repo: beta.url },
      ],
    });

    const installed = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });
    expect(installed.success).toBe(true);

    // The snapshot is taken at install and is the thing the diff is against.
    const snapshot = compositionInventory(env.db, "software-factory");
    expect(snapshot.length).toBeGreaterThan(0);
    // It covers the factory AND both members — the union, not just the factory.
    expect([...new Set(snapshot.map((e) => e.member))].sort()).toEqual([
      "alpha",
      "beta",
      "software-factory",
    ]);
    // The owns DECLARATIONS are snapshotted, not only their install-time
    // expansions — runtime creates config/state/userData AFTER install, so a
    // snapshot of expansions alone could never see them.
    expect(
      snapshot.some((e) => e.kind === "owns" && e.ownsClass === "userData" && e.member === "alpha"),
    ).toBe(true);

    // Runtime writes its config, its state, and the operator's workspace.
    await mkdir(join(env.root, ".config/metafactory/alpha"), { recursive: true });
    await writeFile(join(env.root, ".config/metafactory/alpha/system.yaml"), "x\n");
    await mkdir(join(env.root, ".local/state/metafactory/alpha"), { recursive: true });
    await writeFile(join(env.root, ".local/state/metafactory/alpha/db"), "x\n");
    await mkdir(join(env.root, ".config/metafactory/beta"), { recursive: true });
    await writeFile(join(env.root, ".config/metafactory/beta/system.yaml"), "x\n");
    await mkdir(join(env.root, "Developer/alpha-workspace"), { recursive: true });
    await writeFile(join(env.root, "Developer/alpha-workspace/notes.md"), "mine\n");

    const result = await purge(env.db, env.arc, env.host, "software-factory", {
      yes: true,
      quiet: true,
      home: env.root,
    });

    expect(result.success).toBe(true);
    // Nothing of the composition is left installed.
    expect(listSkills(env.db)).toEqual([]);
    expect(compositionRecord(env.db, "software-factory")).toBeNull();

    // THE ACCEPTANCE TEST: the diff is empty except the user-data refusals.
    const diff = result.composition!.diff;
    expect(diff.residue).toEqual([]);
    expect(diff.refusals.map((r) => r.path)).toEqual([join(env.root, "Developer/alpha-workspace")]);
    expect(diff.refusals[0].ownsClass).toBe("userData");

    // …and the same diff is computable by a test rig from the snapshot alone.
    const rigDiff = diffCompositionInventory(snapshot, {
      home: env.root,
      settingsPath: env.host.paths.settingsPath,
    });
    expect(rigDiff.residue).toEqual([]);
    expect(rigDiff.refusals.map((r) => r.path)).toEqual([
      join(env.root, "Developer/alpha-workspace"),
    ]);

    // The refusal is real on disk, and the config/state are really gone.
    expect(existsSync(join(env.root, "Developer/alpha-workspace/notes.md"))).toBe(true);
    expect(existsSync(join(env.root, ".config/metafactory/alpha"))).toBe(false);
    expect(existsSync(join(env.root, ".local/state/metafactory/alpha"))).toBe(false);
    expect(existsSync(join(env.root, ".config/metafactory/beta"))).toBe(false);
    // And the member's provides.files drop went with it.
    expect(existsSync(join(env.root, "fake-home", "alpha-drop.txt"))).toBe(false);
  }, 120_000);

  test("a leaked path shows up as residue — the diff is not vacuously empty", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/alpha"] },
    });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "leaky-factory", {
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

    const snapshot = compositionInventory(env.db, "leaky-factory");
    await purge(env.db, env.arc, env.host, "leaky-factory", {
      yes: true,
      quiet: true,
      home: env.root,
    });

    // Something re-creates a config path purge deleted. The diff must SEE it.
    await mkdir(join(env.root, ".config/metafactory/alpha"), { recursive: true });
    const diff = diffCompositionInventory(snapshot, {
      home: env.root,
      settingsPath: env.host.paths.settingsPath,
    });
    expect(diff.residue.map((r) => r.path)).toContain(join(env.root, ".config/metafactory/alpha"));
    expect(diff.refusals).toEqual([]);
  }, 120_000);
});

// ───────────────────────────────────────────────────────────────────────────
// `arc files <factory>` — the union (D3)
// ───────────────────────────────────────────────────────────────────────────

describe("arc#401 D3 — `arc files <factory>` lists the union of member footprints", () => {
  test("the factory's own install PLUS every member's, attributed", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/alpha"] },
    });
    tagRepo(alpha.path, "1.0.0");
    const beta = await createMockSkillRepo(env.root, { name: "beta", version: "2.1.0" });
    tagRepo(beta.path, "2.1.0");

    const factory = await writeFactoryRepo(env.root, "software-factory", {
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "2.1.0", repo: beta.url },
      ],
    });
    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    const result = await filesListing(env.db, env.arc, env.host, "software-factory", {
      home: env.root,
    });

    expect(result.installed).toBe(true);
    expect(result.composition).toBeDefined();
    expect(result.composition!.status).toBe("complete");
    expect(result.composition!.members.map((m) => m.name)).toEqual(["alpha", "beta"]);

    // The UNION is the top-level listing: every member's symlink is in it,
    // attributed to the member that owns it.
    const paths = result.artifacts.map((a) => a.path);
    expect(paths).toContain(join(env.host.paths.skillsDir, "software-factory"));
    expect(paths).toContain(join(env.host.paths.skillsDir, "alpha"));
    expect(paths).toContain(join(env.host.paths.skillsDir, "beta"));
    const alphaLink = result.artifacts.find(
      (a) => a.path === join(env.host.paths.skillsDir, "alpha"),
    )!;
    expect(alphaLink.member).toBe("alpha");
    expect(alphaLink.liveness).toBe("present");

    // owns declarations union too, attributed.
    const alphaOwns = result.owns.find((o) => o.entry === "~/.config/metafactory/alpha");
    expect(alphaOwns?.member).toBe("alpha");

    // A non-composition package still carries no composition key at all.
    const plain = await filesListing(env.db, env.arc, env.host, "alpha", { home: env.root });
    expect(plain.composition).toBeUndefined();
    expect(plain.artifacts.every((a) => a.member === undefined)).toBe(true);
  }, 120_000);
});

// ───────────────────────────────────────────────────────────────────────────
// Refcounting (D3 / #349) — a shared member outlives one factory's purge
// ───────────────────────────────────────────────────────────────────────────

describe("arc#401 D3 — a member shared with another factory survives, and falls with the last referent", () => {
  test("purging factory-one keeps alpha (factory-two needs it); purging factory-two takes it", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const beta = await createMockSkillRepo(env.root, { name: "beta", version: "2.1.0" });
    tagRepo(beta.path, "2.1.0");

    const one = await writeFactoryRepo(env.root, "factory-one", {
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "2.1.0", repo: beta.url },
      ],
    });
    const two = await writeFactoryRepo(env.root, "factory-two", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });

    expect(
      (
        await install({
          arc: env.arc,
          host: env.host,
          db: env.db,
          repoUrl: one,
          yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await install({
          arc: env.arc,
          host: env.host,
          db: env.db,
          repoUrl: two,
          yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(true);

    const first = await purge(env.db, env.arc, env.host, "factory-one", {
      yes: true,
      quiet: true,
      home: env.root,
    });
    expect(first.success).toBe(true);
    expect(first.composition!.purged.sort()).toEqual(["beta"]);
    expect(first.composition!.retained).toEqual([
      { name: "alpha", referents: ["factory-two (composition member)"] },
    ]);
    expect(listSkills(env.db).map((s) => s.name).sort()).toEqual(["alpha", "factory-two"]);

    const second = await purge(env.db, env.arc, env.host, "factory-two", {
      yes: true,
      quiet: true,
      home: env.root,
    });
    expect(second.success).toBe(true);
    expect(second.composition!.purged).toEqual(["alpha"]);
    expect(second.composition!.retained).toEqual([]);
    expect(listSkills(env.db)).toEqual([]);
  }, 180_000);

  test("a member the operator installed by hand FIRST is retained — the factory did not put it there", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");

    // Hand install, before any factory exists.
    expect(
      (await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: alpha.url, yes: true }))
        .success,
    ).toBe(true);

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

    // The membership records that this member pre-dated the composition.
    expect(compositionMembers(env.db, "software-factory")[0].state).toBe("preexisting");

    const result = await purge(env.db, env.arc, env.host, "software-factory", {
      yes: true,
      quiet: true,
      home: env.root,
    });
    expect(result.success).toBe(true);
    expect(result.composition!.purged).toEqual([]);
    expect(result.composition!.retained[0].name).toBe("alpha");
    expect(result.composition!.retained[0].referents.join(" ")).toContain("already installed");
    expect(listSkills(env.db).map((s) => s.name)).toEqual(["alpha"]);
  }, 120_000);
});

// ───────────────────────────────────────────────────────────────────────────
// The interrupted install — pending debris
// ───────────────────────────────────────────────────────────────────────────

describe("arc#401 D6 — `arc purge <factory>` cleans an INTERRUPTED install's debris", () => {
  test("a pending composition purges its landed members and drops the pending record", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const beta = await createMockSkillRepo(env.root, {
      name: "beta",
      version: "2.1.0",
      scripts: { postinstall: { path: "scripts/postinstall.sh", content: "#!/bin/bash\nexit 1\n" } },
    });
    tagRepo(beta.path, "2.1.0");

    const factory = await writeFactoryRepo(env.root, "half-factory", {
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "2.1.0", repo: beta.url },
      ],
    });

    const installed = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });
    expect(installed.success).toBe(false);

    // The debris: alpha landed, the factory never did, the record says pending.
    expect(compositionRecord(env.db, "half-factory")!.status).toBe("pending");
    expect(listSkills(env.db).map((s) => s.name)).toEqual(["alpha"]);

    const result = await purge(env.db, env.arc, env.host, "half-factory", {
      yes: true,
      quiet: true,
      home: env.root,
    });

    expect(result.success).toBe(true);
    expect(result.composition!.status).toBe("pending");
    expect(result.composition!.purged).toEqual(["alpha"]);
    expect(listSkills(env.db)).toEqual([]);
    expect(compositionRecord(env.db, "half-factory")).toBeNull();
    expect(compositionMembers(env.db, "half-factory")).toEqual([]);
  }, 120_000);

  test("pending debris is refcounted too — a member another factory needs survives", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const beta = await createMockSkillRepo(env.root, {
      name: "beta",
      version: "2.1.0",
      scripts: { postinstall: { path: "scripts/postinstall.sh", content: "#!/bin/bash\nexit 1\n" } },
    });
    tagRepo(beta.path, "2.1.0");

    const good = await writeFactoryRepo(env.root, "good-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    expect(
      (
        await install({
          arc: env.arc,
          host: env.host,
          db: env.db,
          repoUrl: good,
          yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(true);

    const half = await writeFactoryRepo(env.root, "half-factory", {
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "2.1.0", repo: beta.url },
      ],
    });
    expect(
      (
        await install({
          arc: env.arc,
          host: env.host,
          db: env.db,
          repoUrl: half,
          yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(false);

    const result = await purge(env.db, env.arc, env.host, "half-factory", {
      yes: true,
      quiet: true,
      home: env.root,
    });
    expect(result.success).toBe(true);
    expect(result.composition!.purged).toEqual([]);
    expect(result.composition!.retained[0].name).toBe("alpha");
    expect(listSkills(env.db).map((s) => s.name).sort()).toEqual(["alpha", "good-factory"]);
    expect(compositionRecord(env.db, "half-factory")).toBeNull();
  }, 180_000);
});

// ───────────────────────────────────────────────────────────────────────────
// --dry-run mutates nothing (the CLI renders its confirmation from this)
// ───────────────────────────────────────────────────────────────────────────

describe("arc#401 — `arc purge <factory> --dry-run` plans the whole cascade and mutates nothing", () => {
  test("the plan names every member's disposition; the install is untouched", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/alpha"], userData: ["~/Developer/alpha-workspace"] },
    });
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
    await mkdir(join(env.root, ".config/metafactory/alpha"), { recursive: true });

    const preview = await purge(env.db, env.arc, env.host, "software-factory", {
      dryRun: true,
      home: env.root,
    });

    expect(preview.success).toBe(true);
    expect(preview.dryRun).toBe(true);
    expect(preview.composition!.purged).toEqual(["alpha"]);
    // The member's own config deletion is in the PLAN.
    expect(preview.deletions.some((d) => d.path.endsWith(".config/metafactory/alpha"))).toBe(true);
    expect(preview.keptUserData.some((k) => k.entry === "~/Developer/alpha-workspace")).toBe(true);

    // Nothing moved.
    expect(listSkills(env.db).map((s) => s.name).sort()).toEqual(["alpha", "software-factory"]);
    expect(compositionRecord(env.db, "software-factory")!.status).toBe("complete");
    expect(existsSync(join(env.root, ".config/metafactory/alpha"))).toBe(true);
  }, 120_000);
});
