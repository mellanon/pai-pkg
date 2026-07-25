import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { mkdir, writeFile, symlink } from "fs/promises";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { purge } from "../../src/commands/purge.js";
import { getSkill } from "../../src/lib/db.js";
import { FileBackend } from "../../src/lib/secrets.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

/** Install a mock package that declares owns, then materialise its runtime
 *  leftovers under the injected home (env.root). */
async function installWithOwns(name: string): Promise<void> {
  const repo = await createMockSkillRepo(env.root, {
    name,
    owns: {
      config: ["~/.config/metafactory/cortex"],
      state: ["~/.local/state/metafactory/cortex"],
      userData: ["~/Developer/workspace"],
    },
  });
  await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

  // Runtime-created leftovers arc never installed.
  await mkdir(join(env.root, ".config/metafactory/cortex"), { recursive: true });
  await writeFile(join(env.root, ".config/metafactory/cortex/system.yaml"), "stack: work\n");
  await mkdir(join(env.root, ".local/state/metafactory/cortex"), { recursive: true });
  await writeFile(join(env.root, ".local/state/metafactory/cortex/db.sqlite"), "state");
  // User data (the workspace) — MUST survive.
  await mkdir(join(env.root, "Developer/workspace"), { recursive: true });
  await writeFile(join(env.root, "Developer/workspace/README.md"), "my work");
}

describe("arc purge — happy path", () => {
  test("deletes declared config + state, KEEPS userData", async () => {
    await installWithOwns("Cortex");

    const configDir = join(env.root, ".config/metafactory/cortex");
    const stateDir = join(env.root, ".local/state/metafactory/cortex");
    const workspace = join(env.root, "Developer/workspace");
    expect(existsSync(configDir)).toBe(true);

    const result = await purge(env.db, env.arc, env.host, "Cortex", { yes: true, home: env.root });

    expect(result.success).toBe(true);
    // Package removed (remove() reused).
    expect(getSkill(env.db, "Cortex")).toBeNull();
    // config + state gone.
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
    // userData survives, and is NAMED as kept.
    expect(existsSync(join(workspace, "README.md"))).toBe(true);
    const keptPaths = result.keptUserData.flatMap((k) => k.paths);
    expect(keptPaths).toContain(workspace);
  });

  test("the CRITICAL guarantee: a userData path survives purge with the kept message", async () => {
    await installWithOwns("Luna");
    const workspace = join(env.root, "Developer/workspace");

    const result = await purge(env.db, env.arc, env.host, "Luna", { yes: true, home: env.root });

    // Never listed among deletions.
    expect(result.deletions.some((d) => d.path === workspace)).toBe(false);
    // Present in keptUserData and still on disk.
    expect(result.keptUserData.some((k) => k.paths.includes(workspace))).toBe(true);
    expect(existsSync(join(workspace, "README.md"))).toBe(true);
  });
});

describe("arc purge — F1: a containing config/userData manifest is unrepresentable", () => {
  test("a manifest whose config dir CONTAINS a userData subdir now FAILS at load/validate", async () => {
    // config sweeps ~/Developer/workspace; userData names a subdir of it. Before
    // the containment fix this passed string-equality and userData would sit
    // inside a directory purge deletes. It must now be rejected at load.
    const repo = await createMockSkillRepo(env.root, {
      name: "Overlapping",
      owns: {
        config: ["~/Developer/workspace"],
        userData: ["~/Developer/workspace/repo"],
      },
    });

    // install catches the fail-closed manifest-load throw and surfaces it as a
    // failed result rather than rejecting.
    const result = await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/owns\.userData.*overlaps|overlaps deletable/i);

    // The package never installed, so there is nothing for purge to act on.
    expect(getSkill(env.db, "Overlapping")).toBeNull();
  });
});

describe("arc purge — dry run", () => {
  test("deletes NOTHING and returns the plan", async () => {
    await installWithOwns("Cortex");
    const configDir = join(env.root, ".config/metafactory/cortex");

    const result = await purge(env.db, env.arc, env.host, "Cortex", { dryRun: true, home: env.root });

    expect(result.dryRun).toBe(true);
    // Nothing mutated: package still installed, files still present.
    expect(getSkill(env.db, "Cortex")).not.toBeNull();
    expect(existsSync(configDir)).toBe(true);
    // Plan names the config/state paths as "planned".
    expect(result.deletions.some((d) => d.path === configDir && d.status === "planned")).toBe(true);
  });
});

describe("arc purge — errors + guards", () => {
  test("refuses when the package is not installed", async () => {
    const result = await purge(env.db, env.arc, env.host, "Nope", { yes: true, home: env.root });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
    expect(result.error).toContain("purge requires the manifest");
  });

  test("an owns entry matching nothing on disk is reported absent, not an error", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Empty",
      owns: { config: ["~/.config/metafactory/empty-thing"] },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await purge(env.db, env.arc, env.host, "Empty", { yes: true, home: env.root });
    expect(result.success).toBe(true);
    expect(result.deletions.every((d) => d.status === "absent")).toBe(true);
  });

  test("refuses to delete THROUGH a symlink that escapes home (unlinks the link only)", async () => {
    // The declared config path is itself a symlink to an outside tree.
    const outside = join(env.root, "OUTSIDE-not-home");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "precious.txt"), "keep me");

    const repo = await createMockSkillRepo(env.root, {
      name: "Sneaky",
      owns: { config: ["~/.config/metafactory/escape"] },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    await mkdir(join(env.root, ".config/metafactory"), { recursive: true });
    await symlink(outside, join(env.root, ".config/metafactory/escape"));

    const result = await purge(env.db, env.arc, env.host, "Sneaky", { yes: true, home: env.root });
    expect(result.success).toBe(true);
    // The symlink itself is unlinked, but the target tree survives.
    expect(result.deletions.some((d) => d.status === "deleted-symlink")).toBe(true);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });
});

describe("arc purge — scripts.purge hook", () => {
  test("runs scripts.purge AFTER deletion (non-declarable cleanup)", async () => {
    const marker = join(env.root, "purge-ran.marker");
    const repo = await createMockSkillRepo(env.root, {
      name: "Hooked",
      owns: { config: ["~/.config/metafactory/hooked"] },
      scripts: {
        purge: { path: "./scripts/purge.sh", content: `#!/bin/bash\necho ran > "${marker}"\n` },
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    await mkdir(join(env.root, ".config/metafactory/hooked"), { recursive: true });

    const result = await purge(env.db, env.arc, env.host, "Hooked", { yes: true, home: env.root });
    expect(result.success).toBe(true);
    expect(result.purgeScript).toBe("ran");
    expect(existsSync(marker)).toBe(true);
    // And the config dir was still deleted.
    expect(existsSync(join(env.root, ".config/metafactory/hooked"))).toBe(false);
  });

  test("a multi-file purge hook can source a sibling lib/*.sh (arc#372)", async () => {
    // Regression for arc#372: the snapshot copies the hook's whole scripts/
    // subtree, so `source "$(dirname "$0")/lib/helper.sh"` resolves. Before the
    // fix only the single hook file was copied → the source failed with
    // "No such file or directory" and the hook exited 1.
    const marker = join(env.root, "purge-sibling.marker");
    const repo = await createMockSkillRepo(env.root, {
      name: "MultiFileHook",
      owns: { config: ["~/.config/metafactory/multifilehook"] },
      scripts: {
        purge: {
          path: "./scripts/purge.sh",
          // Resolve the sibling via `$(dirname "$0")` — the same pattern
          // cortex#2338's real purge.sh uses. (No `${…}` so it doesn't collide
          // with JS template interpolation.)
          content:
            `#!/bin/bash\nset -e\n` +
            `source "$(cd "$(dirname "$0")" && pwd)/lib/helper.sh"\n` +
            `write_marker "${marker}"\n`,
        },
      },
      // The sibling helper the hook sources — must be snapshotted alongside it.
      extraFiles: [
        {
          path: "scripts/lib/helper.sh",
          content: `#!/bin/bash\nwrite_marker() { echo helped > "$1"; }\n`,
        },
      ],
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    await mkdir(join(env.root, ".config/metafactory/multifilehook"), { recursive: true });

    const result = await purge(env.db, env.arc, env.host, "MultiFileHook", { yes: true, home: env.root });

    expect(result.success).toBe(true);
    // The hook ran cleanly (would be "failed" if the source could not resolve).
    expect(result.purgeScript).toBe("ran");
    // The sibling-sourced function actually executed.
    expect(existsSync(marker)).toBe(true);
    expect((await Bun.file(marker).text()).trim()).toBe("helped");
  });
});

describe("arc purge — secrets namespace", () => {
  test("clears the package's secrets via the store API", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "SecretPkg",
      owns: { config: ["~/.config/metafactory/secretpkg"] },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    // Provision a secret in the file backend namespace <secretsDir>/SecretPkg/.
    const backend = new FileBackend(env.arc.secretsDir, "SecretPkg");
    await backend.store("GITHUB_TOKEN", "shhh");
    expect(existsSync(join(env.arc.secretsDir, "SecretPkg", "GITHUB_TOKEN"))).toBe(true);

    const result = await purge(env.db, env.arc, env.host, "SecretPkg", {
      yes: true,
      home: env.root,
      makeSecretBackend: () => new FileBackend(env.arc.secretsDir, "SecretPkg"),
    });

    expect(result.success).toBe(true);
    expect(result.secretsCleared).toContain("GITHUB_TOKEN");
    // The whole per-package namespace dir is swept.
    expect(existsSync(join(env.arc.secretsDir, "SecretPkg"))).toBe(false);
  });
});
