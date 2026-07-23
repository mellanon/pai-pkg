import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import {
  checkUpgrades,
  upgradePackage,
  upgradeAll,
  upgradeLibrary,
  formatCheckResults,
  formatUpgradeResults,
  type UpgradeResult,
} from "../../src/commands/upgrade.js";
import { saveSources } from "../../src/lib/sources.js";
import { getSkill } from "../../src/lib/db.js";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { RegistryConfig, SourcesConfig } from "../../src/types.js";
import { installFakeSoma } from "../helpers/fake-soma.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("checkUpgrades", () => {
  test("detects when registry version is newer than installed", async () => {
    // Install a skill at v1.0.0
    const repo = await createMockSkillRepo(env.root, {
      name: "TestSkill",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Set up a source with registry advertising v1.1.0
    const registry: RegistryConfig = {
      registry: {
        skills: [
          {
            name: "TestSkill",
            description: "A test skill",
            author: "tester",
            version: "1.1.0",
            source: repo.url,
            trust: "community",
            status: "shipped",
          },
        ],
        agents: [],
        prompts: [],
        tools: [],
      },
    };

    // Write as a file:// source
    const regPath = join(env.root, "test-registry.yaml");
    await writeFile(regPath, YAML.stringify(registry));

    const sources: SourcesConfig = {
      sources: [
        { name: "test", url: `file://${regPath}`, tier: "community", enabled: true },
      ],
    };
    await saveSources(env.arc.sourcesPath, sources);

    const results = await checkUpgrades(env.db, env.arc, env.host);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("TestSkill");
    expect(results[0].installedVersion).toBe("1.0.0");
    expect(results[0].registryVersion).toBe("1.1.0");
    expect(results[0].upgradable).toBe(true);
  });

  test("reports up-to-date when versions match", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "UpToDate",
      version: "2.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const registry: RegistryConfig = {
      registry: {
        skills: [
          {
            name: "UpToDate",
            description: "A current skill",
            author: "tester",
            version: "2.0.0",
            source: repo.url,
            trust: "community",
            status: "shipped",
          },
        ],
        agents: [],
        prompts: [],
        tools: [],
      },
    };

    const regPath = join(env.root, "test-registry.yaml");
    await writeFile(regPath, YAML.stringify(registry));
    await saveSources(env.arc.sourcesPath, {
      sources: [{ name: "test", url: `file://${regPath}`, tier: "community", enabled: true }],
    });

    const results = await checkUpgrades(env.db, env.arc, env.host);
    expect(results[0].upgradable).toBe(false);
  });

  test("detects a remote version bump for a git-cloned repo-first package (arc#305)", async () => {
    // Repo-first (git-cloned, NOT on a registry, e.g. cortex): the AVAILABLE
    // version lives on the REMOTE, not the local clone. Previously checkUpgrades
    // read the clone's own manifest → compared the installed version to itself
    // → never detected a pushed bump. Now it fetches the remote.
    const repo = await createMockSkillRepo(env.root, { name: "RepoFirst", version: "1.0.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Bump the ORIGIN's manifest + commit. No registry source configured.
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, content.replace("version: 1.0.0", "version: 1.1.0"));
    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    const results = await checkUpgrades(env.db, env.arc, env.host);
    const r = results.find((x) => x.name === "RepoFirst");
    expect(r?.installedVersion).toBe("1.0.0");
    expect(r?.registryVersion).toBeNull(); // not on any registry
    expect(r?.repoVersion).toBe("1.1.0"); // read from the REMOTE, not the stale clone
    expect(r?.upgradable).toBe(true);
  });

  test("no false-positive when a git-cloned repo-first remote has no new version (arc#305)", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "RepoFirstCurrent", version: "1.0.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    // No bump, no registry → remote version == installed → not upgradable.
    const results = await checkUpgrades(env.db, env.arc, env.host);
    const r = results.find((x) => x.name === "RepoFirstCurrent");
    expect(r?.repoVersion).toBe("1.0.0");
    expect(r?.upgradable).toBe(false);
  });
});

describe("upgradePackage", () => {
  test("pulls latest and updates DB version", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Upgradeable",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Simulate a new version: update manifest in source repo and commit
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, content.replace("version: 1.0.0", "version: 1.1.0"));

    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump version"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" }
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "Upgradeable");
    expect(result.success).toBe(true);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.1.0");

    // Verify DB was updated
    const skill = env.db
      .prepare("SELECT version FROM skills WHERE name = ?")
      .get("Upgradeable") as { version: string };
    expect(skill.version).toBe("1.1.0");
  });

  test("reports already up to date when no new commits", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Current",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await upgradePackage(env.db, env.arc, env.host, "Current");
    expect(result.success).toBe(true);
    expect(result.oldVersion).toBe("1.0.0");
    expect(result.newVersion).toBe("1.0.0");
  });

  test("returns error for unknown package", async () => {
    const result = await upgradePackage(env.db, env.arc, env.host, "NotInstalled");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });

  test(
    "genuine bun install failure during upgrade does not record success (arc#289)",
    async () => {
      const repo = await createMockSkillRepo(env.root, {
        name: "NodeDepsUpgrade",
        version: "1.0.0",
      });
      await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

      // Bump the version AND add a package.json with an unresolvable
      // dependency at the repo root — installNodeDependencies runs at the
      // git-root install path during upgrade, same as a real bundle repo.
      const manifestPath = join(repo.path, "arc-manifest.yaml");
      const content = await Bun.file(manifestPath).text();
      await writeFile(manifestPath, content.replace("version: 1.0.0", "version: 1.1.0"));
      await writeFile(
        join(repo.path, "package.json"),
        JSON.stringify({
          name: "node-deps-upgrade",
          version: "1.1.0",
          dependencies: { "arc-284-fixture-does-not-exist-xyz": "^1.0.0" },
        }),
      );

      Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
      Bun.spawnSync(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump + unresolvable dep"],
        { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
      );

      const result = await upgradePackage(env.db, env.arc, env.host, "NodeDepsUpgrade");

      expect(result.success).toBe(false);
      expect(result.error).toContain("bun install failed for NodeDepsUpgrade");

      // The DB row must still read the OLD version — the upgrade did not
      // silently record success on a broken node_modules.
      const skill = env.db
        .prepare("SELECT version FROM skills WHERE name = ?")
        .get("NodeDepsUpgrade") as { version: string };
      expect(skill.version).toBe("1.0.0");
    },
    30_000,
  );

  test("with force flag, re-runs upgrade pipeline and updates DB", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "ForceUpgrade",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Without force: returns success with same version (short-circuit)
    const normalResult = await upgradePackage(env.db, env.arc, env.host, "ForceUpgrade");
    expect(normalResult.success).toBe(true);
    expect(normalResult.oldVersion).toBe("1.0.0");
    expect(normalResult.newVersion).toBe("1.0.0");

    // Manually set DB version to something old to prove the pipeline restores it
    env.db.prepare("UPDATE skills SET version = ? WHERE name = ?").run("0.9.0", "ForceUpgrade");

    // Verify DB was actually changed
    const before = env.db
      .prepare("SELECT version FROM skills WHERE name = ?")
      .get("ForceUpgrade") as { version: string };
    expect(before.version).toBe("0.9.0");

    // With force: runs the full upgrade pipeline, updates DB back to manifest version
    const forceResult = await upgradePackage(env.db, env.arc, env.host, "ForceUpgrade", { force: true });
    expect(forceResult.success).toBe(true);
    expect(forceResult.oldVersion).toBe("0.9.0");
    expect(forceResult.newVersion).toBe("1.0.0");

    // Verify DB version was restored by the pipeline
    const after = env.db
      .prepare("SELECT version FROM skills WHERE name = ?")
      .get("ForceUpgrade") as { version: string };
    expect(after.version).toBe("1.0.0");
  });
});

describe("formatCheckResults", () => {
  test("formats upgradable packages", () => {
    const output = formatCheckResults([
      {
        name: "Foo",
        installedVersion: "1.0.0",
        registryVersion: "1.1.0",
        repoVersion: null,
        upgradable: true,
      },
      {
        name: "Bar",
        installedVersion: "2.0.0",
        registryVersion: "2.0.0",
        repoVersion: null,
        upgradable: false,
      },
    ]);
    expect(output).toContain("1 package(s)");
    expect(output).toContain("Foo");
    expect(output).toContain("1.0.0 → 1.1.0");
    expect(output).not.toContain("Bar");
  });

  test("shows all up to date message", () => {
    const output = formatCheckResults([
      {
        name: "Current",
        installedVersion: "1.0.0",
        registryVersion: "1.0.0",
        repoVersion: null,
        upgradable: false,
      },
    ]);
    expect(output).toContain("up to date");
  });
});

describe("formatUpgradeResults", () => {
  test("formats successful upgrade", () => {
    const output = formatUpgradeResults([
      { success: true, name: "Foo", oldVersion: "1.0.0", newVersion: "1.1.0" },
    ]);
    expect(output).toContain("Foo");
    expect(output).toContain("1.0.0 → 1.1.0");
  });

  test("formats failed upgrade", () => {
    const output = formatUpgradeResults([
      { success: false, name: "Bar", oldVersion: "1.0.0", error: "git pull failed" },
    ]);
    expect(output).toContain("Bar");
    expect(output).toContain("failed");
  });

  test("returns nothing message for empty", () => {
    expect(formatUpgradeResults([])).toContain("Nothing to upgrade");
  });
});

describe("upgradeAll", () => {
  test("with force upgrades packages already at latest", async () => {
    // Install a package at v1.0.0 (no registry advertising a newer version)
    const repo = await createMockSkillRepo(env.root, {
      name: "ForceAll",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Without force, upgradeAll would return empty (nothing upgradable)
    const normalResults = await upgradeAll(env.db, env.arc, env.host);
    expect(normalResults).toHaveLength(0);

    // With force, upgradeAll should include all active packages
    const forceResults = await upgradeAll(env.db, env.arc, env.host, { force: true });
    expect(forceResults).toHaveLength(1);
    expect(forceResults[0].name).toBe("ForceAll");
    expect(forceResults[0].success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// arc#187 — registry-extracted package upgrade path
// ---------------------------------------------------------------------------

function mockFetch(handler: (input: any, init?: any) => Promise<Response>): typeof fetch {
  const fn = handler as typeof fetch;
  (fn as any).preconnect = () => {};
  return fn;
}

/**
 * Build a real gzipped package tarball (single top-level dir containing
 * arc-manifest.yaml) and return its bytes + sha256 so a mocked metafactory
 * registry can advertise and serve it. extractPackage strips one path
 * component, so the manifest must live one level deep.
 */
async function buildRegistryFixture(
  baseDir: string,
  name: string,
  version: string,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const stageRoot = join(baseDir, `__fixture-${name}-${version}`);
  const topDir = join(stageRoot, "pkg");
  await mkdir(join(topDir, "skill"), { recursive: true });
  await writeFile(join(topDir, "skill", "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`);
  await writeFile(
    join(topDir, "arc-manifest.yaml"),
    YAML.stringify({
      name,
      version,
      type: "skill",
      tier: "custom",
      author: { name: "t", github: "t" },
      provides: { skill: [{ trigger: name.toLowerCase() }] },
      depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    }),
  );
  const tarPath = join(baseDir, `__fixture-${name}-${version}.tar.gz`);
  Bun.spawnSync(["tar", "czf", tarPath, "-C", stageRoot, "pkg"], { stdout: "pipe", stderr: "pipe" });
  const buf = await Bun.file(tarPath).arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buf);
  return { bytes: new Uint8Array(buf), sha256: hasher.digest("hex") };
}

function metafactoryRegistryHandler(opts: {
  scope: string;
  name: string;
  latestVersion: string;
  sha256: string;
  tarball?: Uint8Array;
}) {
  return async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/storage/download/")) {
      return new Response((opts.tarball ?? new Uint8Array()) as unknown as BodyInit, { status: 200 });
    }
    // version detail: /packages/<scope>/<name>@<version>
    if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
      return new Response(JSON.stringify({
        version: opts.latestVersion,
        sha256: opts.sha256,
        manifest_canonical: `{"name":"@${opts.scope}/${opts.name}","version":"${opts.latestVersion}"}`,
        signing: { registry_signature: null, registry_key_id: null },
      }), { status: 200 });
    }
    // package detail
    return new Response(JSON.stringify({
      namespace: `@${opts.scope}`, name: opts.name,
      display_name: null, description: "", type: "skill", license: "MIT",
      latest_version: opts.latestVersion, versions: [opts.latestVersion],
      publisher: { display_name: "T", tier: "official", mfa_enabled: true, github_username: null },
      sponsor: null, created_at: 0, updated_at: 0,
    }), { status: 200 });
  };
}

async function addMetafactorySource(env: TestEnv): Promise<void> {
  await saveSources(env.arc.sourcesPath, {
    sources: [
      { name: "mf", url: "https://meta-factory.test", tier: "official", enabled: true, type: "metafactory" },
    ],
  });
}

describe("checkUpgrades — registry-extracted package (arc#187)", () => {
  test("resolves newer version via metafactory API, not the YAML index", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.6.4" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    // Simulate a registry-extracted install: repo_url is a package ref.
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.6.4", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.7.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({ scope: "metafactory", name: "soma", latestVersion: "0.7.1", sha256: fixture.sha256 }));
    try {
      const results = await checkUpgrades(env.db, env.arc, env.host);
      const soma = results.find((r) => r.name === "soma")!;
      expect(soma.installedVersion).toBe("0.6.4");
      expect(soma.registryVersion).toBe("0.7.1");
      expect(soma.upgradable).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("upgradePackage — registry-extracted package (arc#187)", () => {
  test("force-upgrades via clean re-download — no git pull error, DB updated", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.6.4" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.6.4", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.7.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({
      scope: "metafactory", name: "soma", latestVersion: "0.7.1", sha256: fixture.sha256, tarball: fixture.bytes,
    }));
    try {
      const result = await upgradePackage(env.db, env.arc, env.host, "soma", { force: true });
      expect(result.success).toBe(true);
      expect(result.oldVersion).toBe("0.6.4");
      expect(result.newVersion).toBe("0.7.1");
      // The defining symptom of bug 2 must be gone.
      expect(result.error ?? "").not.toContain("git pull failed");
      expect(result.error ?? "").not.toContain("not a git repository");

      const row = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("soma") as { version: string };
      expect(row.version).toBe("0.7.1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("registry upgrade preserves user overlay files and re-projects Soma skills", async () => {
    const fakeSoma = await installFakeSoma({
      root: env.root,
      shimDir: env.arc.shimDir,
      scriptForCallsPath: (path) => `#!/bin/sh\necho "$@" >> "${path}"\nexit 0\n`,
    });

    try {
      const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.6.4" });
      await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
      const installPath = (env.db.prepare("SELECT install_path FROM skills WHERE name = ?").get("soma") as { install_path: string }).install_path;
      const overlayPath = join(installPath, "skill", "EXTEND.yaml");
      const statePath = join(installPath, ".soma-projection-state.json");
      const stalePayloadPath = join(installPath, "skill", "removed-package-file.txt");
      await writeFile(overlayPath, "user: overlay\n");
      await writeFile(statePath, '{"projected":true}\n');
      await writeFile(stalePayloadPath, "removed by publisher\n");

      env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.6.4", "soma");
      await addMetafactorySource(env);

      const fixture = await buildRegistryFixture(env.root, "soma", "0.7.1");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch(metafactoryRegistryHandler({
        scope: "metafactory",
        name: "soma",
        latestVersion: "0.7.1",
        sha256: fixture.sha256,
        tarball: fixture.bytes,
      }));

      try {
        const result = await upgradePackage(env.db, env.arc, env.host, "soma");
        expect(result.success).toBe(true);
        expect(result.oldVersion).toBe("0.6.4");
        expect(result.newVersion).toBe("0.7.1");

        expect(await readFile(overlayPath, "utf8")).toBe("user: overlay\n");
        expect(await readFile(statePath, "utf8")).toBe('{"projected":true}\n');
        expect(existsSync(stalePayloadPath)).toBe(false);

        const upgradedManifest = YAML.parse(await readFile(join(installPath, "arc-manifest.yaml"), "utf8"));
        expect(upgradedManifest.version).toBe("0.7.1");

        const calls = (await readFile(fakeSoma.callsPath, "utf8")).trim().split("\n");
        expect(calls).toEqual([
          expect.stringMatching(/^project-skill .+\/skill --apply$/),
          expect.stringMatching(/^project-skill .+\/skill --apply$/),
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      fakeSoma.restore();
    }
  });

  test("never strands the user: a failed download leaves the prior install intact", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.6.4" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const installPath = (env.db.prepare("SELECT install_path FROM skills WHERE name = ?").get("soma") as { install_path: string }).install_path;
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.6.4", "soma");
    await addMetafactorySource(env);

    const originalFetch = globalThis.fetch;
    // Storage download returns 401 (stale token) — the exact remove+install hazard.
    globalThis.fetch = mockFetch(async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/storage/download/")) return new Response("denied", { status: 401 });
      if (/\/packages\/[^/]+\/[^/]+@/.test(url)) {
        return new Response(JSON.stringify({ version: "0.7.1", sha256: "deadbeef", manifest_canonical: "{}", signing: { registry_signature: null, registry_key_id: null } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        namespace: "@metafactory", name: "soma", display_name: null, description: "", type: "skill", license: "MIT",
        latest_version: "0.7.1", versions: ["0.7.1"],
        publisher: { display_name: "T", tier: "official", mfa_enabled: true, github_username: null }, sponsor: null, created_at: 0, updated_at: 0,
      }), { status: 200 });
    });
    try {
      const result = await upgradePackage(env.db, env.arc, env.host, "soma", { force: true });
      expect(result.success).toBe(false);
      // The working install is still on disk — not removed.
      expect(existsSync(installPath)).toBe(true);
      expect(existsSync(join(installPath, "arc-manifest.yaml"))).toBe(true);
      // DB still records the old version (no drift).
      const row = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("soma") as { version: string };
      expect(row.version).toBe("0.6.4");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// arc#184 — soma tarball upgrade reproducer
// ---------------------------------------------------------------------------

describe("arc#184 — extracted-tarball upgrade and check", () => {
  test("upgrade --check reports the metafactory-available soma version", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.5.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.5.0", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.5.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({
      scope: "metafactory",
      name: "soma",
      latestVersion: "0.5.1",
      sha256: fixture.sha256,
    }));

    try {
      const results = await checkUpgrades(env.db, env.arc, env.host);
      const output = formatCheckResults(results);

      expect(output).toContain("soma: 0.5.0 → 0.5.1");
      expect(output).not.toContain("All packages are up to date.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("upgrade soma re-downloads a tarball extract instead of running git pull", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "soma", version: "0.5.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    env.db.prepare("UPDATE skills SET repo_url = ? WHERE name = ?").run("@metafactory/soma@0.5.0", "soma");
    await addMetafactorySource(env);

    const fixture = await buildRegistryFixture(env.root, "soma", "0.5.1");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(metafactoryRegistryHandler({
      scope: "metafactory",
      name: "soma",
      latestVersion: "0.5.1",
      sha256: fixture.sha256,
      tarball: fixture.bytes,
    }));

    try {
      const result = await upgradePackage(env.db, env.arc, env.host, "soma");

      expect(result.success).toBe(true);
      expect(result.oldVersion).toBe("0.5.0");
      expect(result.newVersion).toBe("0.5.1");
      expect(result.error ?? "").not.toContain("git pull failed");
      expect(result.error ?? "").not.toContain("not a git repository");

      const row = env.db.prepare("SELECT version FROM skills WHERE name = ?").get("soma") as { version: string };
      expect(row.version).toBe("0.5.1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// arc#203 — template regen is keyed off provides.templates, NOT type:rules.
// A governance package (compass) that declares provides.templates must
// regenerate its consumers' CLAUDE.md on upgrade, exactly like a type:rules
// package would. (Spelling: `governance` is canonical per arc#361. One fixture
// below deliberately keeps the retired off-union `governance-overlay` string —
// compass proper's live on-disk state — to guard the unknown-type regen path.)
// ---------------------------------------------------------------------------

/**
 * Build + git-commit a package repo that declares `provides.templates` under
 * the given `type`. Ships a CLAUDE.md.template under templates/ + a
 * capabilities block, mirroring compass.
 */
async function createMockTemplateRepo(
  root: string,
  opts: { name: string; version: string; type: string; templateBody: string },
): Promise<{ path: string; url: string }> {
  const repoDir = join(root, `mock-${opts.name}`);
  await mkdir(join(repoDir, "templates"), { recursive: true });
  await writeFile(join(repoDir, "templates", "CLAUDE.md.template"), opts.templateBody);

  const manifest = {
    name: opts.name,
    version: opts.version,
    type: opts.type,
    tier: "custom",
    author: { name: "tester", github: "tester" },
    provides: {
      templates: [
        { source: "templates/CLAUDE.md.template", target: "CLAUDE.md", config: "agents-md.yaml" },
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

/**
 * Flip the on-disk manifest `type` and commit, mirroring the LIVE compass
 * scenario: compass was installed while it was `type: rules` (the DB still
 * records artifact_type:rules), then its manifest later changed on disk.
 * upgradePackage re-reads the manifest from disk, so the regen guard sees the
 * flipped type. This is the exact condition arc#203 fixed — regen keys off
 * provides.templates, not the recorded (or even a recognized) type.
 *
 * Callers use both the canonical `governance` spelling (arc#361) AND the
 * retired off-union `governance-overlay` string — the latter is compass
 * proper's live on-disk state until its spelling follow-up lands, so the
 * unknown-type regen path must stay guarded.
 */
function flipManifestType(repoPath: string, type: string): void {
  const manifestPath = join(repoPath, "arc-manifest.yaml");
  const raw = readFileSync(manifestPath, "utf-8");
  const parsed = YAML.parse(raw);
  parsed.type = type;
  writeFileSync(manifestPath, YAML.stringify(parsed));
  Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", `flip to ${type}`],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
}

/**
 * Run `fn` with findConsumerRepos pinned to a sandbox so it can NEVER touch a
 * real repo. findConsumerRepos resolves consumers from two sources: the
 * BLUEPRINT_DEV_ROOT scan AND an always-on `process.cwd()` inclusion. A test
 * that ignored either would regenerate the running repo's own CLAUDE.md (the
 * worktree carries agents-md.yaml) — destructive and a cross-test race. So we
 * pin BOTH: dev-root scan → `devRoot`, cwd → `consumerDir`. Both globals are
 * restored in finally even if `fn` throws.
 */
async function withConsumerSandbox<T>(
  devRoot: string,
  consumerDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prevDevRoot = process.env.BLUEPRINT_DEV_ROOT;
  const prevCwd = process.cwd();
  process.env.BLUEPRINT_DEV_ROOT = devRoot;
  process.chdir(consumerDir);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevDevRoot === undefined) delete process.env.BLUEPRINT_DEV_ROOT;
    else process.env.BLUEPRINT_DEV_ROOT = prevDevRoot;
  }
}

describe("upgradePackage — template regen for governance (arc#203)", () => {
  test("a governance package with provides.templates regenerates a consumer's CLAUDE.md on force-upgrade", async () => {
    // A consumer repo (sibling under the dev root) that opts into the template
    // via agents-md.yaml. withConsumerSandbox pins findConsumerRepos to this dir.
    const devRoot = join(env.root, "dev-root");
    const consumerDir = join(devRoot, "consumer-repo");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, "agents-md.yaml"),
      YAML.stringify({ project_name: "Consumer" }),
    );

    // Install while the package is type:rules (compass's original DB state),
    // then flip the live manifest to type:governance before upgrade —
    // reproducing the exact live drift behind arc#203.
    const repo = await createMockTemplateRepo(env.root, {
      name: "OverlayPkg",
      version: "1.0.0",
      type: "rules",
      templateBody: "# {PROJECT_NAME}\n\nSENTINEL-ROW: a freshly-added SOP line.\n",
    });
    // Pass consumerDir so the install-time rules render targets the sandbox
    // consumer (default would be process.cwd() = the running repo).
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, consumerDir });
    flipManifestType(repo.path, "governance");

    // Prove the upgrade — not the install — is what regenerates: clear the
    // install-time render, then assert the upgrade rebuilds it.
    await rm(join(consumerDir, "CLAUDE.md"), { force: true });
    expect(existsSync(join(consumerDir, "CLAUDE.md"))).toBe(false);

    await withConsumerSandbox(devRoot, consumerDir, async () => {
      // force-upgrade re-runs the pipeline; the regen must fire despite the
      // package being governance (not type:rules) — this is the arc#203 fix.
      const result = await upgradePackage(env.db, env.arc, env.host, "OverlayPkg", { force: true });
      expect(result.success).toBe(true);
    });

    // The consumer's CLAUDE.md was generated from the overlay's template.
    const generated = join(consumerDir, "CLAUDE.md");
    expect(existsSync(generated)).toBe(true);
    const body = await Bun.file(generated).text();
    expect(body).toContain("SENTINEL-ROW: a freshly-added SOP line.");
    expect(body).toContain("# Consumer"); // placeholder substitution ran
  });

  test("same-version (non-force) upgrade still regenerates templates for an off-union on-disk type (governance-overlay — compass proper's live state)", async () => {
    const devRoot = join(env.root, "dev-root-2");
    const consumerDir = join(devRoot, "consumer-repo");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, "agents-md.yaml"),
      YAML.stringify({ project_name: "Consumer2" }),
    );

    const repo = await createMockTemplateRepo(env.root, {
      name: "OverlayPkg2",
      version: "1.0.0",
      type: "rules",
      templateBody: "# {PROJECT_NAME}\n\nSAME-VERSION-ROW: regen on matching version.\n",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true, consumerDir });
    // Deliberately OFF-UNION: compass proper's on-disk manifest still says
    // `governance-overlay` until its spelling follow-up lands. Regen keys off
    // provides.templates, so even an unrecognized type string must regenerate.
    flipManifestType(repo.path, "governance-overlay");
    await rm(join(consumerDir, "CLAUDE.md"), { force: true });

    await withConsumerSandbox(devRoot, consumerDir, async () => {
      // No force, no newer version: hits the same-version short-circuit branch
      // (upgrade.ts ~L309), which must regenerate regardless of type spelling.
      const result = await upgradePackage(env.db, env.arc, env.host, "OverlayPkg2");
      expect(result.success).toBe(true);
    });

    const generated = join(consumerDir, "CLAUDE.md");
    expect(existsSync(generated)).toBe(true);
    const body = await Bun.file(generated).text();
    expect(body).toContain("SAME-VERSION-ROW: regen on matching version.");
  });
});

// ---------------------------------------------------------------------------
// arc#361 — provides.files re-drop on upgrade for type:governance. governance
// is the first type whose ENTIRE install payload is provides.files (no primary
// per-type symlink), so upgrade must re-drop declared files exactly like it
// does for type:component — otherwise a new/moved drop between versions never
// lands on upgrade.
// ---------------------------------------------------------------------------

/** Build + git-commit a governance package whose payload is provides.files. */
async function createMockGovernanceFilesRepo(
  root: string,
  opts: {
    name: string;
    version: string;
    files: { source: string; target: string; content: string }[];
  },
): Promise<{ path: string; url: string }> {
  const repoDir = join(root, `mock-${opts.name}`);
  await mkdir(repoDir, { recursive: true });
  for (const f of opts.files) {
    await mkdir(join(repoDir, f.source, ".."), { recursive: true });
    await writeFile(join(repoDir, f.source), f.content);
  }
  await writeFile(
    join(repoDir, "arc-manifest.yaml"),
    YAML.stringify({
      name: opts.name,
      version: opts.version,
      type: "governance",
      tier: "custom",
      author: { name: "tester", github: "tester" },
      provides: { files: opts.files.map((f) => ({ source: f.source, target: f.target })) },
      depends_on: { tools: [{ name: "bun", version: ">=1.0.0" }] },
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    }),
  );
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "Initial commit"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" },
  );
  return { path: repoDir, url: repoDir };
}

describe("upgradePackage — provides.files re-drop for governance (arc#361)", () => {
  test("a drop added in a new version lands on upgrade", async () => {
    const targetA = join(env.root, "fake-home", "drop-a.md");
    const targetB = join(env.root, "fake-home", "drop-b.md");

    const repo = await createMockGovernanceFilesRepo(env.root, {
      name: "GovFiles",
      version: "1.0.0",
      files: [{ source: "files/drop-a.md", target: targetA, content: "drop A\n" }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    expect(lstatSync(targetA).isSymbolicLink()).toBe(true);
    expect(existsSync(targetB)).toBe(false);

    // v1.1.0 declares a SECOND drop (the compass-core "adds/moves a file
    // between versions" scenario).
    await writeFile(join(repo.path, "files", "drop-b.md"), "drop B\n");
    const manifestPath = join(repo.path, "arc-manifest.yaml");
    const parsed = YAML.parse(readFileSync(manifestPath, "utf-8"));
    parsed.version = "1.1.0";
    parsed.provides.files.push({ source: "files/drop-b.md", target: targetB });
    writeFileSync(manifestPath, YAML.stringify(parsed));
    Bun.spawnSync(["git", "add", "."], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "v1.1.0 adds drop-b"],
      { cwd: repo.path, stdout: "pipe", stderr: "pipe" },
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "GovFiles");
    expect(result.success).toBe(true);
    expect(result.newVersion).toBe("1.1.0");

    // The NEW drop landed on upgrade — this is the arc#361 re-drop branch
    // (previously component-only). The original drop is still live.
    expect(lstatSync(targetB).isSymbolicLink()).toBe(true);
    expect(lstatSync(targetA).isSymbolicLink()).toBe(true);
  });
});

describe("upgradeLibrary", () => {
  test("with force re-runs upgrade for library artifacts", async () => {
    // Install a regular package and set its library_name in the DB
    const repo = await createMockSkillRepo(env.root, {
      name: "LibArtifact",
      version: "1.0.0",
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Set a library_name so upgradeLibrary can find it
    env.db.prepare("UPDATE skills SET library_name = ? WHERE name = ?").run("my-lib", "LibArtifact");

    // upgradeLibrary with force should process the artifact without error
    const results = await upgradeLibrary(env.db, env.arc, env.host, "my-lib", { force: true });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("LibArtifact");
    expect(results[0].success).toBe(true);
  });

  test("returns error for unknown library", async () => {
    const results = await upgradeLibrary(env.db, env.arc, env.host, "nonexistent-lib");
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain("No artifacts installed");
  });
});

/**
 * arc#306 — `arc upgrade` must install `depends_on.packages` too.
 *
 * The bug: on a fresh `arc install`, step 2b installs a package's declared
 * `depends_on.packages`. `arc upgrade` pulled new code + ran `bun install` but
 * NEVER installed newly-declared package dependencies — so an upgrade across an
 * extraction boundary (cortex moving its platform adapters to 5 first-party
 * surface bundles) landed new code with none of its dependency bundles: no
 * adapters + the renderer-coverage boot guard hard-failing.
 *
 * The fix extracts the step-2b loop into installPackageDependencies() and calls
 * it from BOTH install() and upgradePackage() so the two paths can't drift.
 */
describe("upgradePackage — installs depends_on.packages (arc#306)", () => {
  /**
   * Rewrite a git-cloned mock repo's manifest: optionally bump the version and
   * add `depends_on.packages` entries, then commit so `git pull` picks it up.
   */
  async function bumpAndAddPackageDeps(
    repoPath: string,
    opts: { toVersion?: string; packages?: { name: string; repo: string }[] },
  ): Promise<void> {
    const manifestPath = join(repoPath, "arc-manifest.yaml");
    const parsed = YAML.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
    if (opts.toVersion) parsed.version = opts.toVersion;
    if (opts.packages) {
      const dependsOn = (parsed.depends_on ?? {}) as Record<string, unknown>;
      dependsOn.packages = opts.packages;
      parsed.depends_on = dependsOn;
    }
    await writeFile(manifestPath, YAML.stringify(parsed));
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "bump + deps"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
  }

  test("install path still installs declared depends_on.packages (no step-2b regression)", async () => {
    // Dependency bundle B (plain, no deps of its own).
    const depB = await createMockSkillRepo(env.root, { name: "DepB", version: "1.0.0" });
    // Package A declares depends_on.packages: [DepB] at install time.
    const pkgA = await createMockSkillRepo(env.root, { name: "PkgA", version: "1.0.0" });
    await bumpAndAddPackageDeps(pkgA.path, { packages: [{ name: "DepB", repo: depB.url }] });

    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkgA.url, yes: true });
    expect(result.success).toBe(true);

    // The dependency was installed transitively by step 2b (via the shared helper).
    const b = getSkill(env.db, "DepB");
    expect(b?.status).toBe("active");
    expect(existsSync(b!.install_path)).toBe(true);
  });

  test("upgrade installs a newly-declared depends_on.packages bundle (the regression-proof)", async () => {
    // A installed at v1.0.0 with NO package dependencies.
    const pkgA = await createMockSkillRepo(env.root, { name: "UpgA", version: "1.0.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkgA.url, yes: true });

    // The dependency bundle does not exist yet in the DB.
    expect(getSkill(env.db, "UpgDepB")).toBeNull();

    // A new dependency bundle B is created, and A's source is bumped to v1.1.0
    // AND now declares depends_on.packages: [B] — exactly the extraction-era
    // shape (new code + a new dependency the installed version never had).
    const depB = await createMockSkillRepo(env.root, { name: "UpgDepB", version: "1.0.0" });
    await bumpAndAddPackageDeps(pkgA.path, {
      toVersion: "1.1.0",
      packages: [{ name: "UpgDepB", repo: depB.url }],
    });

    const result = await upgradePackage(env.db, env.arc, env.host, "UpgA");
    expect(result.success).toBe(true);
    expect(result.newVersion).toBe("1.1.0");

    // The core assertion: the newly-declared dependency is now installed.
    const b = getSkill(env.db, "UpgDepB");
    expect(b?.status).toBe("active");
    expect(existsSync(b!.install_path)).toBe(true);
  });

  test("upgrade with an unresolvable dependency fails and rolls the code pull back", async () => {
    const pkgA = await createMockSkillRepo(env.root, { name: "RollbackA", version: "1.0.0" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: pkgA.url, yes: true });

    const installedA = getSkill(env.db, "RollbackA");
    expect(installedA?.version).toBe("1.0.0");

    // Bump to 1.1.0 AND declare a dependency whose repo cannot be cloned.
    await bumpAndAddPackageDeps(pkgA.path, {
      toVersion: "1.1.0",
      packages: [{ name: "MissingDep", repo: join(env.root, "does-not-exist-repo") }],
    });

    const result = await upgradePackage(env.db, env.arc, env.host, "RollbackA");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to install dependency 'MissingDep'");

    // DB version is unchanged — the failed upgrade did not record success.
    expect(getSkill(env.db, "RollbackA")?.version).toBe("1.0.0");

    // The on-disk code pull was rolled back: the installed clone's manifest
    // reads the OLD version again (git reset --hard to the pre-pull HEAD).
    const revertedManifest = YAML.parse(
      await Bun.file(join(installedA!.install_path, "arc-manifest.yaml")).text(),
    ) as { version: string };
    expect(revertedManifest.version).toBe("1.0.0");

    // The bogus dependency was never recorded.
    expect(getSkill(env.db, "MissingDep")).toBeNull();
  });
});

describe("upgradePackage — dependency upgrade cascade (arc#346)", () => {
  // Bump a mock repo's version in its SOURCE repo + commit, so the installed
  // clone's `git pull --ff-only` advances it (mirrors the existing upgrade tests).
  async function bumpRepo(repoPath: string, from: string, to: string): Promise<void> {
    const manifestPath = join(repoPath, "arc-manifest.yaml");
    const content = await Bun.file(manifestPath).text();
    await writeFile(manifestPath, content.replace(`version: ${from}`, `version: ${to}`));
    Bun.spawnSync(["git", "add", "."], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", `bump ${to}`],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
    );
  }

  // Count every occurrence of a package name across the result tree (top-level
  // + nested cascaded), so "upgraded at most once" is order-independent.
  function countOccurrences(rs: UpgradeResult[], name: string): number {
    return rs.reduce(
      (n, r) => n + (r.name === name ? 1 : 0) + countOccurrences(r.cascaded ?? [], name),
      0,
    );
  }

  test("upgrading a component cascades to its already-installed depends_on.packages", async () => {
    const child = await createMockSkillRepo(env.root, { name: "adapter-child", version: "1.0.0" });
    const parent = await createMockSkillRepo(env.root, {
      name: "parent-comp",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-child", repo: child.url }],
    });
    // Installing the parent installs the declared dependency too (arc#306).
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });
    expect(getSkill(env.db, "adapter-child")?.status).toBe("active");

    // Bump BOTH upstreams.
    await bumpRepo(parent.path, "1.0.0", "1.1.0");
    await bumpRepo(child.path, "1.0.0", "1.1.0");

    const result = await upgradePackage(env.db, env.arc, env.host, "parent-comp");
    expect(result.success).toBe(true);
    expect(result.newVersion).toBe("1.1.0");
    // The adapter cascaded up with it.
    expect(result.cascaded?.length).toBe(1);
    expect(result.cascaded?.[0]).toMatchObject({
      name: "adapter-child",
      oldVersion: "1.0.0",
      newVersion: "1.1.0",
      success: true,
    });
    expect(getSkill(env.db, "adapter-child")?.version).toBe("1.1.0");
  });

  test("cascade runs even when the parent is already current", async () => {
    const child = await createMockSkillRepo(env.root, { name: "adapter-only", version: "1.0.0" });
    const parent = await createMockSkillRepo(env.root, {
      name: "parent-current",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-only", repo: child.url }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });

    // Only the CHILD has a new version; the parent stays at 1.0.0.
    await bumpRepo(child.path, "1.0.0", "1.2.0");

    const result = await upgradePackage(env.db, env.arc, env.host, "parent-current");
    expect(result.success).toBe(true);
    expect(result.newVersion).toBe(result.oldVersion); // parent unchanged
    expect(result.cascaded?.[0]).toMatchObject({ name: "adapter-only", newVersion: "1.2.0" });
    expect(getSkill(env.db, "adapter-only")?.version).toBe("1.2.0");
  });

  test("a failed dependency upgrade is reported but does NOT fail the parent", async () => {
    const child = await createMockSkillRepo(env.root, { name: "adapter-brk", version: "1.0.0" });
    const parent = await createMockSkillRepo(env.root, {
      name: "parent-brk",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-brk", repo: child.url }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });

    await bumpRepo(parent.path, "1.0.0", "1.1.0");
    // Rewrite the child's upstream history so the installed clone can't
    // fast-forward → its upgrade's `git pull --ff-only` fails.
    Bun.spawnSync(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "--amend", "-m", "diverge"],
      { cwd: child.path, stdout: "pipe", stderr: "pipe" },
    );

    const result = await upgradePackage(env.db, env.arc, env.host, "parent-brk");
    expect(result.success).toBe(true); // parent still succeeds
    expect(result.newVersion).toBe("1.1.0");
    expect(result.cascaded?.length).toBe(1);
    expect(result.cascaded?.[0].success).toBe(false); // dep failure surfaced, not swallowed
    expect(result.cascaded?.[0].name).toBe("adapter-brk");
  });

  test("upgradeAll upgrades a shared dependency at most once (no double-upgrade)", async () => {
    const child = await createMockSkillRepo(env.root, { name: "adapter-shared", version: "1.0.0" });
    const parent = await createMockSkillRepo(env.root, {
      name: "parent-all",
      version: "1.0.0",
      dependsOnPackages: [{ name: "adapter-shared", repo: child.url }],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: parent.url, yes: true });
    await bumpRepo(parent.path, "1.0.0", "1.1.0");
    await bumpRepo(child.path, "1.0.0", "1.1.0");

    const results = await upgradeAll(env.db, env.arc, env.host, { force: true });
    // Upgraded exactly once across the whole tree (top-level OR nested, never both).
    expect(countOccurrences(results, "adapter-shared")).toBe(1);
    expect(countOccurrences(results, "parent-all")).toBe(1);
    expect(getSkill(env.db, "adapter-shared")?.version).toBe("1.1.0");
  });

  test("formatUpgradeResults renders cascaded upgrades as an indented tree", () => {
    const out = formatUpgradeResults([
      {
        success: true,
        name: "cortex",
        oldVersion: "6.10.0",
        newVersion: "6.11.0",
        cascaded: [
          {
            success: true,
            name: "metafactory-cortex-adapter-web",
            oldVersion: "1.2.0",
            newVersion: "1.3.0",
          },
        ],
      },
    ]);
    expect(out).toContain("cortex: 6.10.0 → 6.11.0");
    expect(out).toContain("↳ metafactory-cortex-adapter-web: 1.2.0 → 1.3.0");
  });
});
