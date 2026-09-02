import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import YAML from "yaml";
import { install } from "../../src/commands/install.js";
import { purge, formatPurge } from "../../src/commands/purge.js";
import { remove } from "../../src/commands/remove.js";
import { upgradePackage } from "../../src/commands/upgrade.js";
import { filesListing } from "../../src/commands/files.js";
import {
  compositionInventory,
  compositionMembers,
  compositionRecord,
  getSkill,
  listSkills,
  replaceCompositionRecord,
} from "../../src/lib/db.js";
import { canonicalMemberKey } from "../../src/lib/composition-identity.js";
import { compositionOwnsConflicts, validateCompositionFields } from "../../src/lib/composition.js";
import type { ToolProbe } from "../../src/lib/composition.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";

/**
 * arc#401 review hardening — the three root causes the standard and
 * adversarial lanes found on 58f25cc, each turned into a committed regression.
 *
 *   ROOT 1 (identity) — membership was keyed on the raw REFERENCE LABEL while
 *   `skills.name` is the MANIFEST name. Every `@scope/name` member has that
 *   shape by construction, so the snapshot, the purge cascade and the refcount
 *   all looked up a package that was not there and reported CLEAN over a fully
 *   installed member.
 *
 *   ROOT 2 (the `preexisting` predicate) — "another composition MENTIONS it"
 *   is not "another composition INSTALLED it", and a record rewritten in two
 *   steps has a window where every member reads `pending`. Both turn the
 *   operator's own hand-installed package into something `arc purge` deletes.
 *
 *   ROOT 3 (honest reports, and the rest) — a correctly retained member must
 *   not read as a failed untangle; a killed purge must be resumable; an
 *   upgrade must refuse rather than half-move.
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

async function commitFactoryManifest(
  dir: string,
  name: string,
  version: string,
  extra: Record<string, unknown>,
  message: string,
): Promise<void> {
  const fresh = !existsSync(join(dir, ".git"));
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

async function releaseMember(path: string, version: string): Promise<void> {
  const manifestPath = join(path, "arc-manifest.yaml");
  const manifest = YAML.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(manifestPath, YAML.stringify(manifest));
  Bun.spawnSync(["git", "add", "."], { cwd: path, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@t.co", "commit", "-m", `release ${version}`],
    { cwd: path, stdout: "pipe", stderr: "pipe" },
  );
  tagRepo(path, version);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOT 1 — IDENTITY
// ═══════════════════════════════════════════════════════════════════════════

describe("arc#401 ROOT 1 — membership is keyed on the LANDED name, canonically", () => {
  test("canonicalMemberKey strips scope and case — the documented equivalence", () => {
    expect(canonicalMemberKey("@metafactory/compass-core")).toBe("compass-core");
    expect(canonicalMemberKey("compass-core")).toBe("compass-core");
    expect(canonicalMemberKey("Shared-Core")).toBe("shared-core");
    expect(canonicalMemberKey("@MetaFactory/Cortex")).toBe("cortex");
    expect(canonicalMemberKey("  cortex  ")).toBe("cortex");
    // Different names stay different.
    expect(canonicalMemberKey("the-compass-core")).not.toBe(canonicalMemberKey("compass-core"));
  });

  test("R1a: a SCOPED reference label landing an unscoped manifest name is recorded, snapshotted and purged", async () => {
    env = await createTestEnv();

    // The registry member's shape: reference `@metafactory/compass-core`,
    // manifest `name: compass-core`. Equivalent under the canonical key.
    const member = await createMockSkillRepo(env.root, {
      name: "compass-core",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/compass"] },
    });
    tagRepo(member.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "label-factory", {
      references: [{ name: "@metafactory/compass-core", version: "1.0.0", repo: member.url }],
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

    // Membership records the LANDED name; the label is kept for display.
    const rows = compositionMembers(env.db, "label-factory");
    expect(rows.map((r) => r.member_name)).toEqual(["compass-core"]);
    expect(rows.map((r) => r.member_label)).toEqual(["@metafactory/compass-core"]);

    // The snapshot covers the member — the failure R1 proved was that it did not.
    const snapshot = compositionInventory(env.db, "label-factory");
    expect([...new Set(snapshot.map((e) => e.member))].sort()).toEqual([
      "compass-core",
      "label-factory",
    ]);
    expect(
      snapshot.some((e) => e.member === "compass-core" && e.kind === "owns"),
    ).toBe(true);

    await mkdir(join(env.root, ".config/metafactory/compass"), { recursive: true });
    await writeFile(join(env.root, ".config/metafactory/compass/system.yaml"), "x\n");

    const result = await purge(env.db, env.arc, env.host, "label-factory", {
      yes: true,
      quiet: true,
      home: env.root,
    });

    expect(result.success).toBe(true);
    expect(result.composition!.purged).toEqual(["compass-core"]);
    expect(listSkills(env.db)).toEqual([]);
    expect(existsSync(join(env.root, ".config/metafactory/compass"))).toBe(false);
    expect(result.composition!.diff.residue).toEqual([]);
  }, 120_000);

  test("R1b: a GENUINE label/manifest-name mismatch is refused, loudly, at landing", async () => {
    env = await createTestEnv();

    const member = await createMockSkillRepo(env.root, {
      name: "the-compass-core",
      version: "1.0.0",
    });
    tagRepo(member.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "label-factory", {
      references: [{ name: "compass-core", version: "1.0.0", repo: member.url }],
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("compass-core");
    expect(result.error).toContain("the-compass-core");
    // The factory itself never lands on a refusal.
    expect(getSkill(env.db, "label-factory")).toBeNull();
  }, 120_000);

  test("R2: a case-variant shared member is REFCOUNTED, not deleted out from under the other factory", async () => {
    env = await createTestEnv();

    const shared = await createMockSkillRepo(env.root, { name: "shared-core", version: "1.0.0" });
    tagRepo(shared.path, "1.0.0");

    const factoryA = await writeFactoryRepo(env.root, "factory-a", {
      references: [{ name: "shared-core", version: "1.0.0", repo: shared.url }],
    });
    const factoryB = await writeFactoryRepo(env.root, "factory-b", {
      references: [{ name: "Shared-Core", version: "1.0.0", repo: shared.url }],
    });

    expect(
      (
        await install({
          arc: env.arc, host: env.host, db: env.db, repoUrl: factoryA, yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await install({
          arc: env.arc, host: env.host, db: env.db, repoUrl: factoryB, yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(true);

    const result = await purge(env.db, env.arc, env.host, "factory-a", {
      yes: true,
      quiet: true,
      home: env.root,
    });

    expect(result.success).toBe(true);
    expect(result.composition!.purged).toEqual([]);
    expect(result.composition!.retained[0].name).toBe("shared-core");
    expect(result.composition!.retained[0].referents.join(" ")).toContain("factory-b");
    expect(getSkill(env.db, "shared-core")).not.toBeNull();
    expect(listSkills(env.db).map((s) => s.name).sort()).toEqual(["factory-b", "shared-core"]);
  }, 180_000);
});

describe("arc#401 F10 — two labels for ONE member are refused at validation, never at the DB", () => {
  test("validateCompositionFields catches the canonical duplicate and names both labels", () => {
    const violations = validateCompositionFields({
      name: "dup-factory",
      version: "0.1.0",
      type: "factory",
      references: [
        { name: "@a/dup", version: "1.0.0", repo: "/tmp/dup" },
        { name: "dup", version: "1.0.0", repo: "/tmp/dup" },
      ],
    });
    const duplicate = violations.filter((v) => v.rule.includes("same member"));
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].field).toBe("references[1].name");
    expect(duplicate[0].rule).toContain("@a/dup");
    expect(duplicate[0].rule).toContain("dup");
  });

  test("a case-variant duplicate is caught too", () => {
    const violations = validateCompositionFields({
      name: "dup-factory",
      version: "0.1.0",
      type: "factory",
      references: [
        { name: "Cortex", version: "1.0.0", repo: "/tmp/c" },
        { name: "cortex", version: "1.0.0", repo: "/tmp/c" },
      ],
    });
    expect(violations.some((v) => v.rule.includes("same member"))).toBe(true);
  });

  test("install REFUSES — no crash, no landed member, no pending debris", async () => {
    env = await createTestEnv();

    const dup = await createMockSkillRepo(env.root, { name: "dup", version: "1.0.0" });
    tagRepo(dup.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "dup-factory", {
      references: [
        { name: "@a/dup", version: "1.0.0", repo: dup.url },
        { name: "dup", version: "1.0.0", repo: dup.url },
      ],
    });

    // The failure mode being locked out is a THROW: the two labels used to pass
    // validation, resolve, land, and then collide on the composition_members
    // primary key — an uncaught SQLiteError on the trust path.
    let threw: unknown = null;
    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    }).catch((err: unknown) => {
      threw = err;
      return { success: false, error: "THREW" };
    });

    expect(threw).toBeNull();
    expect(result.success).toBe(false);
    expect(result.error).toContain("@a/dup");
    // Refused at validation, so nothing was even resolved.
    expect(listSkills(env.db)).toEqual([]);
    expect(compositionRecord(env.db, "dup-factory")).toBeNull();
  }, 120_000);
});

describe("arc#401 F11 — an identity refusal leaves REACHABLE debris", () => {
  test("the remove pointer names the LANDED name, and that command works", async () => {
    env = await createTestEnv();

    const member = await createMockSkillRepo(env.root, {
      name: "the-compass-core",
      version: "1.0.0",
    });
    tagRepo(member.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "label-factory", {
      references: [{ name: "compass-core", version: "1.0.0", repo: member.url }],
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });
    expect(result.success).toBe(false);

    // The debris pointer must name the package that IS installed. Naming the
    // label hands the operator a command that fails.
    expect(result.error).toContain("arc remove the-compass-core");

    // …and it really works.
    const removed = await remove(env.db, env.arc, env.host, "the-compass-core", {
      yes: true,
      quiet: true,
    });
    expect(removed.success).toBe(true);
    expect(getSkill(env.db, "the-compass-core")).toBeNull();
  }, 120_000);

  test("purging the pending record REACHES the member the refusal left behind", async () => {
    env = await createTestEnv();

    const member = await createMockSkillRepo(env.root, {
      name: "the-compass-core",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/compass"] },
    });
    tagRepo(member.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "label-factory", {
      references: [{ name: "compass-core", version: "1.0.0", repo: member.url }],
    });

    expect(
      (
        await install({
          arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(false);

    // The row must carry the LANDED name — otherwise the pending record points
    // at a package that does not exist and the cascade silently skips it.
    const rows = compositionMembers(env.db, "label-factory");
    expect(rows.map((r) => r.member_name)).toEqual(["the-compass-core"]);
    expect(rows.map((r) => r.member_label)).toEqual(["compass-core"]);
    expect(compositionRecord(env.db, "label-factory")!.status).toBe("pending");

    await mkdir(join(env.root, ".config/metafactory/compass"), { recursive: true });

    const purged = await purge(env.db, env.arc, env.host, "label-factory", {
      yes: true, quiet: true, home: env.root,
    });
    expect(purged.success).toBe(true);
    expect(purged.composition!.purged).toEqual(["the-compass-core"]);
    expect(listSkills(env.db)).toEqual([]);
    expect(compositionRecord(env.db, "label-factory")).toBeNull();
    expect(existsSync(join(env.root, ".config/metafactory/compass"))).toBe(false);
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// ROOT 2 — THE preexisting PREDICATE
// ═══════════════════════════════════════════════════════════════════════════

describe("arc#401 ROOT 2 — 'preexisting' means nobody tracked installed it", () => {
  test("C1: a hand-installed member survives a TWO-factory purge in either order", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");

    // The operator's own install, first.
    expect(
      (await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: alpha.url, yes: true }))
        .success,
    ).toBe(true);

    for (const name of ["factory-one", "factory-two"]) {
      const dir = await writeFactoryRepo(env.root, name, {
        references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
      });
      expect(
        (
          await install({
            arc: env.arc, host: env.host, db: env.db, repoUrl: dir, yes: true,
            composition: { probe: allToolsPresent },
          })
        ).success,
      ).toBe(true);
    }

    // NEITHER factory installed alpha — mere membership in factory-one is not
    // "factory-one put it there", which is the substitution C1 exploited.
    expect(compositionMembers(env.db, "factory-one")[0].state).toBe("preexisting");
    expect(compositionMembers(env.db, "factory-two")[0].state).toBe("preexisting");

    const first = await purge(env.db, env.arc, env.host, "factory-one", {
      yes: true, quiet: true, home: env.root,
    });
    expect(first.composition!.purged).toEqual([]);

    const second = await purge(env.db, env.arc, env.host, "factory-two", {
      yes: true, quiet: true, home: env.root,
    });
    expect(second.composition!.purged).toEqual([]);
    expect(second.composition!.retained[0].referents.join(" ")).toContain("already installed");

    // The operator's package is still there.
    expect(listSkills(env.db).map((s) => s.name)).toEqual(["alpha"]);
  }, 240_000);

  test("W1: a RESUMED install keeps its members 'landed' — it installed them, on the first attempt", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const betaFail = await createMockSkillRepo(env.root, {
      name: "beta",
      version: "1.0.0",
      scripts: { postinstall: { path: "scripts/postinstall.sh", content: "#!/bin/bash\nexit 1\n" } },
    });
    tagRepo(betaFail.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "resume-factory", {
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "1.0.0", repo: betaFail.url },
      ],
    });

    // Attempt 1: alpha lands, beta fails → pending.
    expect(
      (
        await install({
          arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(false);
    expect(compositionMembers(env.db, "resume-factory")[0].state).toBe("landed");

    // Fix beta and re-run — the RESUME. alpha is already installed, but this
    // composition is what installed it, so it must stay 'landed'.
    await writeFile(join(betaFail.path, "scripts/postinstall.sh"), "#!/bin/bash\nexit 0\n");
    Bun.spawnSync(["git", "add", "."], { cwd: betaFail.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=T", "-c", "user.email=t@t.co", "commit", "-m", "fix"],
      { cwd: betaFail.path, stdout: "pipe", stderr: "pipe" },
    );
    Bun.spawnSync(["git", "tag", "-f", "v1.0.0"], { cwd: betaFail.path, stdout: "pipe", stderr: "pipe" });

    expect(
      (
        await install({
          arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(true);

    const states = Object.fromEntries(
      compositionMembers(env.db, "resume-factory").map((m) => [m.member_name, m.state]),
    );
    expect(states).toEqual({ alpha: "landed", beta: "landed" });

    // …and the resumed composition can therefore still be untangled.
    const result = await purge(env.db, env.arc, env.host, "resume-factory", {
      yes: true, quiet: true, home: env.root,
    });
    expect(result.composition!.purged.sort()).toEqual(["alpha", "beta"]);
    expect(result.composition!.diff.residue).toEqual([]);
    expect(listSkills(env.db)).toEqual([]);
  }, 240_000);

  test("R3: a member row still PENDING falls back to 'who was here first', not to deletion", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    // The operator's own install, before any composition exists.
    expect(
      (await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: alpha.url, yes: true }))
        .success,
    ).toBe(true);

    const factory = await writeFactoryRepo(env.root, "window-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    // The bytes a kill between opening the record and marking the member
    // leaves: the row is `pending`, so nothing recorded who installed alpha.
    env.db
      .prepare("UPDATE composition_members SET state = 'pending' WHERE composition_name = ?")
      .run("window-factory");

    const result = await purge(env.db, env.arc, env.host, "window-factory", {
      yes: true, quiet: true, home: env.root,
    });
    expect(result.success).toBe(true);
    expect(result.composition!.purged).toEqual([]);
    expect(result.composition!.retained[0].name).toBe("alpha");
    expect(result.composition!.retained[0].referents.join(" ")).toContain("interrupted install");
    expect(getSkill(env.db, "alpha")).not.toBeNull();
  }, 120_000);

  test("F3: the composition record is rewritten ATOMICALLY — no window shows every member pending", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    expect(
      (await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: alpha.url, yes: true }))
        .success,
    ).toBe(true);

    const factory = await writeFactoryRepo(env.root, "atomic-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });
    expect(compositionMembers(env.db, "atomic-factory")[0].state).toBe("preexisting");

    // A rewrite that FAILS must leave the prior record exactly as it was —
    // never the all-pending intermediate the two-call sequence exposed.
    expect(() =>
      replaceCompositionRecord(env.db, "atomic-factory", "0.2.0", [
        { label: "alpha", name: "alpha", version: "1.1.0", source: "repo", ref: alpha.url, state: "landed" },
        { label: "@x/alpha", name: "alpha", version: "1.1.0", source: "repo", ref: alpha.url, state: "landed" },
      ], "complete"),
    ).toThrow();

    const rows = compositionMembers(env.db, "atomic-factory");
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("preexisting");
    expect(rows[0].member_version).toBe("1.0.0");
    expect(compositionRecord(env.db, "atomic-factory")!.version).toBe("0.1.0");
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// ROOT 3 — HONEST REPORTS AND THE REMAINING CONFIRMED FINDINGS
// ═══════════════════════════════════════════════════════════════════════════

describe("arc#401 ROOT 3 — W2: a retained member is not a failed untangle", () => {
  test("its paths are classified 'retained', never residue", async () => {
    env = await createTestEnv();

    const shared = await createMockSkillRepo(env.root, {
      name: "shared",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/shared"] },
    });
    tagRepo(shared.path, "1.0.0");

    for (const name of ["keeper-a", "keeper-b"]) {
      const dir = await writeFactoryRepo(env.root, name, {
        references: [{ name: "shared", version: "1.0.0", repo: shared.url }],
      });
      await install({
        arc: env.arc, host: env.host, db: env.db, repoUrl: dir, yes: true,
        composition: { probe: allToolsPresent },
      });
    }
    await mkdir(join(env.root, ".config/metafactory/shared"), { recursive: true });

    const result = await purge(env.db, env.arc, env.host, "keeper-a", {
      yes: true, quiet: true, home: env.root,
    });

    expect(result.composition!.retained[0].name).toBe("shared");
    // The shared member's symlink and config are still on disk, correctly.
    expect(result.composition!.diff.residue).toEqual([]);
    expect(result.composition!.diff.retained.length).toBeGreaterThan(0);
    expect(result.composition!.diff.retained.every((r) => r.member === "shared")).toBe(true);

    const report = formatPurge(result);
    expect(report).toContain("untangle: CLEAN");
    expect(report).toContain("retained by design");
  }, 180_000);
});

describe("arc#401 ROOT 3 — F4: cross-member owns overlap is refused before anything lands", () => {
  test("compositionOwnsConflicts names both members and both paths", () => {
    const conflicts = compositionOwnsConflicts([
      {
        name: "alpha",
        version: "1.0.0",
        tier: "custom",
        manifest: { name: "alpha", version: "1.0.0", type: "skill", owns: { userData: ["~/alpha-workspace"] } },
      },
      {
        name: "beta",
        version: "1.0.0",
        tier: "custom",
        manifest: { name: "beta", version: "1.0.0", type: "skill", owns: { state: ["~/alpha-workspace/cache"] } },
      },
    ] as never);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("alpha");
    expect(conflicts[0]).toContain("beta");
    expect(conflicts[0]).toContain("~/alpha-workspace");
    expect(conflicts[0]).toContain("~/alpha-workspace/cache");
  });

  test("R4: the install is refused, and the user data is never at risk", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: { userData: ["~/alpha-workspace"] },
    });
    tagRepo(alpha.path, "1.0.0");
    const beta = await createMockSkillRepo(env.root, {
      name: "beta",
      version: "1.0.0",
      owns: { state: ["~/alpha-workspace/cache"] },
    });
    tagRepo(beta.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "overlap-factory", {
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "1.0.0", repo: beta.url },
      ],
    });

    const result = await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("alpha-workspace");
    expect(result.error).toContain("userData");
    // Nothing landed — the refusal is before installation, per D2's honesty rule.
    expect(listSkills(env.db)).toEqual([]);
  }, 120_000);
});

describe("arc#401 ROOT 3 — F5: a killed purge is resumable by name", () => {
  test("the composition record dies LAST, so a re-run finishes the cascade", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/alpha"] },
    });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "killed-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    // A purge killed after the MEMBERS came down but before the factory did.
    // Under the old order the factory (and the record) went first, which
    // orphaned the members behind a name that then refused.
    const result = await purge(env.db, env.arc, env.host, "killed-factory", {
      yes: true, quiet: true, home: env.root,
    });
    expect(result.success).toBe(true);
    expect(listSkills(env.db)).toEqual([]);

    // The ordering property itself: with the factory package removed by hand
    // but the record intact, the name still resumes rather than refusing.
    const alpha2 = await createMockSkillRepo(env.root, { name: "alpha2", version: "1.0.0" });
    tagRepo(alpha2.path, "1.0.0");
    const f2 = await writeFactoryRepo(env.root, "resumable-factory", {
      references: [{ name: "alpha2", version: "1.0.0", repo: alpha2.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: f2, yes: true,
      composition: { probe: allToolsPresent },
    });
    await remove(env.db, env.arc, env.host, "resumable-factory", { yes: true, quiet: true });
    // `remove` took the record with the package; the members are orphaned and
    // the operator is TOLD so (S2) rather than left to discover it.
    const rerun = await purge(env.db, env.arc, env.host, "alpha2", {
      yes: true, quiet: true, home: env.root,
    });
    expect(rerun.success).toBe(true);
  }, 180_000);
});

describe("arc#401 ROOT 3 — S2: plain `arc remove <factory>` says it orphans the members", () => {
  test("the result names them and points at purge", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "orphan-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    const result = await remove(env.db, env.arc, env.host, "orphan-factory", {
      yes: true,
      quiet: true,
    });
    expect(result.success).toBe(true);
    expect(result.orphanedMembers).toEqual(["alpha"]);
    expect(getSkill(env.db, "alpha")).not.toBeNull();
  }, 120_000);
});

describe("arc#401 ROOT 3 — upgrade refuses rather than half-moves", () => {
  test("F6: an unreadable remote is a REFUSAL naming the read failure, not a factory-only advance", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "offline-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    // The remote goes away.
    await rm(factory, { recursive: true, force: true });

    const result = await upgradePackage(env.db, env.arc, env.host, "offline-factory");
    expect(result.success).toBe(false);
    expect(result.error!.toLowerCase()).toContain("could not read");
    expect(getSkill(env.db, "offline-factory")!.version).toBe("0.1.0");
    expect(getSkill(env.db, "alpha")!.version).toBe("1.0.0");
  }, 180_000);

  test("F7: a member whose repo URL changed between releases is a refusal naming both", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const impostor = await createMockSkillRepo(env.root, { name: "alpha-elsewhere", version: "1.0.0" });
    tagRepo(impostor.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "moved-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    await releaseMember(alpha.path, "1.1.0");
    await commitFactoryManifest(
      factory,
      "moved-factory",
      "0.2.0",
      { references: [{ name: "alpha", version: "1.1.0", repo: impostor.url }] },
      "release 0.2.0",
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "moved-factory");
    expect(result.success).toBe(false);
    expect(result.error).toContain(alpha.url);
    expect(result.error).toContain(impostor.url);
    expect(getSkill(env.db, "moved-factory")!.version).toBe("0.1.0");
  }, 180_000);

  test("S1: a member with a dirty worktree refuses in PRE-FLIGHT, before the factory moves", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "dirty-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    await releaseMember(alpha.path, "1.1.0");
    await commitFactoryManifest(
      factory,
      "dirty-factory",
      "0.2.0",
      { references: [{ name: "alpha", version: "1.1.0", repo: alpha.url }] },
      "release 0.2.0",
    );

    // The operator has edits in the member's checkout.
    const member = getSkill(env.db, "alpha")!;
    await writeFile(join(member.install_path, "arc-manifest.yaml"), "name: tampered\n");

    const result = await upgradePackage(env.db, env.arc, env.host, "dirty-factory");
    expect(result.success).toBe(false);
    expect(result.error!.toLowerCase()).toContain("uncommitted");
    expect(getSkill(env.db, "dirty-factory")!.version).toBe("0.1.0");
  }, 180_000);

  test("F8: a mixed-state upgrade records 'partial' and a later run RE-PLANS", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "partial-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    await releaseMember(alpha.path, "1.1.0");
    await commitFactoryManifest(
      factory,
      "partial-factory",
      "0.2.0",
      { references: [{ name: "alpha", version: "1.1.0", repo: alpha.url }] },
      "release 0.2.0",
    );

    // The member move fails for a reason pre-flight cannot see.
    const failed = await upgradePackage(env.db, env.arc, env.host, "partial-factory", {
      _moveMember: async () => ({ success: false, error: "simulated member move failure" }),
    });

    expect(failed.success).toBe(false);
    expect(failed.error).toContain("alpha");
    expect(failed.members).toEqual([
      { success: false, name: "alpha", oldVersion: "1.0.0", error: "simulated member move failure" },
    ]);
    // The record is HONEST: the factory moved, the member did not.
    expect(compositionRecord(env.db, "partial-factory")!.status).toBe("partial");
    expect(compositionMembers(env.db, "partial-factory")[0].member_version).toBe("1.0.0");

    // …and a later run RE-PLANS the move rather than reporting "already at".
    const retry = await upgradePackage(env.db, env.arc, env.host, "partial-factory");
    expect(retry.success).toBe(true);
    expect(retry.members).toEqual([
      { success: true, name: "alpha", oldVersion: "1.0.0", newVersion: "1.1.0" },
    ]);
    expect(compositionRecord(env.db, "partial-factory")!.status).toBe("complete");
    expect(getSkill(env.db, "alpha")!.version).toBe("1.1.0");
  }, 240_000);

  test("W3: `arc install --pin` on an installed factory refuses and points at `arc upgrade`", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "pinned-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });
    Bun.spawnSync(["git", "tag", "v0.2.0"], { cwd: factory, stdout: "pipe", stderr: "pipe" });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      pinnedRef: "0.2.0",
      yes: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("arc upgrade pinned-factory");
    expect(getSkill(env.db, "pinned-factory")!.version).toBe("0.1.0");
    // The members are untouched — a re-pin that moved the factory alone is the
    // broken snapshot this refusal exists to prevent.
    expect(compositionMembers(env.db, "pinned-factory")[0].member_version).toBe("1.0.0");
  }, 180_000);
});

describe("arc#401 ROOT 3 — N1/F9: the report says what it verified", () => {
  test("a pending composition's purge says NOT VERIFIED, not a green diff it did not earn", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    tagRepo(alpha.path, "1.0.0");
    const beta = await createMockSkillRepo(env.root, {
      name: "beta",
      version: "1.0.0",
      scripts: { postinstall: { path: "scripts/postinstall.sh", content: "#!/bin/bash\nexit 1\n" } },
    });
    tagRepo(beta.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "half-factory", {
      references: [
        { name: "alpha", version: "1.0.0", repo: alpha.url },
        { name: "beta", version: "1.0.0", repo: beta.url },
      ],
    });
    expect(
      (
        await install({
          arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
          composition: { probe: allToolsPresent },
        })
      ).success,
    ).toBe(false);

    const result = await purge(env.db, env.arc, env.host, "half-factory", {
      yes: true, quiet: true, home: env.root,
    });
    expect(result.composition!.snapshotMissing).toBe(true);
    const report = formatPurge(result);
    expect(report).toContain("untangle: NOT VERIFIED");
    expect(report).not.toContain("untangle: CLEAN");
  }, 120_000);

  test("F9: the kept-user-data lines say which side of the purge they describe", async () => {
    env = await createTestEnv();

    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: { userData: ["~/Developer/alpha-workspace"] },
    });
    tagRepo(alpha.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "kept-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });
    await mkdir(join(env.root, "Developer/alpha-workspace"), { recursive: true });

    const result = await purge(env.db, env.arc, env.host, "kept-factory", {
      yes: true, quiet: true, home: env.root,
    });
    const report = formatPurge(result);
    // The DECLARED plan line…
    expect(report).toContain("declared user data");
    // …and the line that says arc went back and LOOKED.
    expect(report).toContain("verified still present");
  }, 120_000);
});

describe("arc#401 ROOT 1 — `arc files <factory>` follows the landed name too", () => {
  test("a scoped-label member's footprint is in the union", async () => {
    env = await createTestEnv();

    const member = await createMockSkillRepo(env.root, { name: "cortex", version: "1.0.0" });
    tagRepo(member.path, "1.0.0");
    const factory = await writeFactoryRepo(env.root, "files-factory", {
      references: [{ name: "@metafactory/cortex", version: "1.0.0", repo: member.url }],
    });
    await install({
      arc: env.arc, host: env.host, db: env.db, repoUrl: factory, yes: true,
      composition: { probe: allToolsPresent },
    });

    const listing = await filesListing(env.db, env.arc, env.host, "files-factory", {
      home: env.root,
    });
    expect(listing.composition!.members.map((m) => m.name)).toEqual(["cortex"]);
    expect(listing.composition!.members[0].installed).toBe(true);
    expect(listing.artifacts.map((a) => a.path)).toContain(
      join(env.host.paths.skillsDir, "cortex"),
    );
  }, 120_000);
});
