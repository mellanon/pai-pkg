import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import YAML from "yaml";
import { install } from "../../src/commands/install.js";
import { purge, formatPurge } from "../../src/commands/purge.js";
import { listSkills } from "../../src/lib/db.js";
import type { ToolProbe } from "../../src/lib/composition.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";

/**
 * arc#412 — the secret backend must never be able to abort the purge cascade.
 *
 * Found by the factory E2E gate: `clearSecrets` built the backend OUTSIDE its
 * try/catch, and both backends `assertAgentName` in their constructor. A member
 * carrying a scoped manifest name (`@the-metafactory/compass-core` — compass-core's
 * documented, deliberate arc/v1 name violation) threw `invalid agent name` from
 * the CONSTRUCTOR, which propagated out of `purge(member)` → `purgeComposition`
 * → the caller, leaving the rest of the composition installed.
 *
 * The contract this file pins: a package whose secret namespace cannot be opened
 * has no secrets to purge. That is a REPORTED degradation, not a fatal one, and
 * not a silent one — the cascade finishes and the report names the package and
 * the reason.
 */

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

const allToolsPresent: ToolProbe = () => ({ found: true, path: "/usr/bin/stub", version: "9.9.9" });

/** The scoped name that trips `assertAgentName` — compass-core's real shape. */
const SCOPED = "@the-metafactory/compass-core";

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

function tagRepo(path: string, version: string): void {
  Bun.spawnSync(["git", "tag", `v${version}`], { cwd: path, stdout: "pipe", stderr: "pipe" });
}

describe("arc#412 — an unconstructible secret backend degrades, never aborts", () => {
  test("a composition purge whose member has a scoped name completes the whole cascade", async () => {
    env = await createTestEnv();

    // The member arc CAN scope secrets for. It is purged in the same cascade,
    // so it is the proof the cascade did not stop at the scoped member.
    const alpha = await createMockSkillRepo(env.root, {
      name: "alpha",
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/alpha"] },
    });
    tagRepo(alpha.path, "1.0.0");

    // The member arc CANNOT: `@` and `/` are rejected by assertAgentName,
    // which is the storage-layer path-escape guard, not an oversight.
    const scoped = await createMockSkillRepo(env.root, {
      name: SCOPED,
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/compass-core"] },
    });
    tagRepo(scoped.path, "1.0.0");

    const factory = await writeFactoryRepo(env.root, "software-factory", {
      produces: "software",
      references: [
        { name: SCOPED, version: "1.0.0", repo: scoped.url },
        { name: "alpha", version: "1.0.0", repo: alpha.url },
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
    expect(listSkills(env.db).map((s) => s.name).sort()).toEqual(
      [SCOPED, "alpha", "software-factory"].sort(),
    );

    // No `makeSecretBackend` seam: this must exercise the REAL construction.
    // `file` keeps it off the host keychain while still hitting assertAgentName.
    const result = await purge(env.db, env.arc, env.host, "software-factory", {
      yes: true,
      quiet: true,
      home: env.root,
      secretBackend: "file",
    });

    // 1. The cascade completed rather than throwing mid-flight.
    expect(result.success).toBe(true);

    // 2. Every member came down — including the one whose backend is unbuildable,
    //    and including the member ordered AFTER it in the teardown.
    expect(result.composition).toBeDefined();
    expect(result.composition!.failed).toEqual([]);
    expect(result.composition!.purged.sort()).toEqual([SCOPED, "alpha"].sort());
    expect(listSkills(env.db)).toEqual([]);

    // 3. The degradation is REPORTED, not silent: the package is named and so
    //    is the reason it had no secrets to purge.
    expect(result.secretsSkipped).toEqual([
      { name: SCOPED, reason: expect.stringContaining("invalid agent name") },
    ]);
    const report = formatPurge(result);
    expect(report).toContain(`no secrets to purge for ${SCOPED}`);
    expect(report).toContain("invalid agent name");
  });

  test("a single-package purge of a scoped name still succeeds and reports the skip", async () => {
    env = await createTestEnv();

    const scoped = await createMockSkillRepo(env.root, {
      name: SCOPED,
      version: "1.0.0",
      owns: { config: ["~/.config/metafactory/compass-core"] },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: scoped.url, yes: true });

    const result = await purge(env.db, env.arc, env.host, SCOPED, {
      yes: true,
      quiet: true,
      home: env.root,
      secretBackend: "file",
    });

    expect(result.success).toBe(true);
    expect(result.secretsCleared).toEqual([]);
    expect(result.secretsSkipped).toHaveLength(1);
    expect(result.secretsSkipped[0].name).toBe(SCOPED);
    expect(formatPurge(result)).toContain(`no secrets to purge for ${SCOPED}`);
  });

  test("a buildable backend reports no skip at all", async () => {
    env = await createTestEnv();

    const repo = await createMockSkillRepo(env.root, {
      name: "plainpkg",
      owns: { config: ["~/.config/metafactory/plainpkg"] },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await purge(env.db, env.arc, env.host, "plainpkg", {
      yes: true,
      quiet: true,
      home: env.root,
      secretBackend: "file",
    });

    expect(result.success).toBe(true);
    expect(result.secretsSkipped).toEqual([]);
    expect(formatPurge(result)).not.toContain("no secrets to purge");
  });
});
