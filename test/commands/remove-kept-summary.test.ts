import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove, formatRemoveKeptSummary } from "../../src/commands/remove.js";

/** Materialise a `~/…` owns entry as a real dir under `home` (the test root),
 *  so the existence filter (cortex#2441 Note 2) sees it as present on disk. */
async function makeOwnsPath(home: string, tildeEntry: string): Promise<void> {
  await mkdir(join(home, tildeEntry.replace(/^~\//, "")), { recursive: true });
}

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("arc remove — owns kept-summary threading (arc#359)", () => {
  test("threads the owns declaration into the RemoveResult when declared", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Kept",
      owns: {
        config: ["~/.config/metafactory/kept"],
        state: ["~/.local/state/metafactory/kept"],
        userData: ["~/Developer/kept-workspace"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await remove(env.db, env.arc, env.host, "Kept", { yes: true });
    expect(result.success).toBe(true);
    expect(result.owns).toBeDefined();
    expect(result.owns?.config).toEqual(["~/.config/metafactory/kept"]);
    expect(result.owns?.userData).toEqual(["~/Developer/kept-workspace"]);
  });

  test("omits owns from the result when the package declares none (no behavior change)", async () => {
    const repo = await createMockSkillRepo(env.root, { name: "Plain" });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });

    const result = await remove(env.db, env.arc, env.host, "Plain", { yes: true });
    expect(result.success).toBe(true);
    expect(result.owns).toBeUndefined();
  });
});

describe("arc remove — kept-summary wording (arc#373 defect A)", () => {
  test("summary NEVER names `arc purge <name>` (the command that fails post-remove)", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Kept",
      owns: {
        config: ["~/.config/metafactory/kept"],
        state: ["~/.local/state/metafactory/kept"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const result = await remove(env.db, env.arc, env.host, "Kept", { yes: true });

    // Materialise the owns paths on disk so the existence filter names them.
    await makeOwnsPath(env.root, "~/.config/metafactory/kept");
    await makeOwnsPath(env.root, "~/.local/state/metafactory/kept");

    const summary = formatRemoveKeptSummary(result, env.root);
    const text = summary.join("\n");

    // The kept paths are still named so a manual sweep is possible.
    expect(text).toContain("~/.config/metafactory/kept");
    expect(text).toContain("~/.local/state/metafactory/kept");

    // REGRESSION GUARD: the old wording pointed at `arc purge Kept`, which errors
    // "not installed" because remove already deleted the manifest. It must be gone.
    expect(text).not.toContain("arc purge");
    expect(text).not.toMatch(/run:\s*arc purge/);

    // The actionable next step is the one-shot flag, which runs WITH remove.
    expect(text).toContain("arc remove --purge Kept");
  });

  test("no purge guidance when only userData (never-deletable) is declared", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "UserDataOnly",
      owns: { userData: ["~/Developer/udo-workspace"] },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const result = await remove(env.db, env.arc, env.host, "UserDataOnly", { yes: true });

    // userData is never purged — so there is nothing to suggest deleting.
    expect(formatRemoveKeptSummary(result, env.root)).toEqual([]);
  });

  test("returns no lines for a package that declares no owns at all", () => {
    expect(formatRemoveKeptSummary({ success: true, name: "Plain" })).toEqual([]);
  });
});

describe("arc remove — kept-summary existence filter (cortex#2441 Note 2)", () => {
  test("(a) an owns path that EXISTS on disk is named", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Exists",
      owns: {
        config: ["~/.config/metafactory/exists"],
        state: ["~/.local/state/metafactory/exists"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const result = await remove(env.db, env.arc, env.host, "Exists", { yes: true });

    // Only the config path exists on disk; the state path was never created.
    await makeOwnsPath(env.root, "~/.config/metafactory/exists");

    const text = formatRemoveKeptSummary(result, env.root).join("\n");
    expect(text).toContain("~/.config/metafactory/exists");
    // The absent state path is NOT named.
    expect(text).not.toContain("~/.local/state/metafactory/exists");
    // Something is kept → the --purge next-step is offered.
    expect(text).toContain("arc remove --purge Exists");
  });

  test("(b) an owns path that does NOT exist on disk is omitted", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Partial",
      owns: {
        config: ["~/.config/metafactory/present", "~/.config/metafactory/absent"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const result = await remove(env.db, env.arc, env.host, "Partial", { yes: true });

    await makeOwnsPath(env.root, "~/.config/metafactory/present");
    // "absent" is deliberately never created.

    const text = formatRemoveKeptSummary(result, env.root).join("\n");
    expect(text).toContain("~/.config/metafactory/present");
    expect(text).not.toContain("~/.config/metafactory/absent");
  });

  test("(c) NOTHING on disk → clean 'nothing kept' line, no misleading names, no purge suggestion", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Ghost",
      owns: {
        config: ["~/.config/metafactory/ghost"],
        state: ["~/.local/state/metafactory/ghost"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const result = await remove(env.db, env.arc, env.host, "Ghost", { yes: true });

    // No owns paths are created — this is the field scenario (install, never
    // stood a stack up, then remove).
    const summary = formatRemoveKeptSummary(result, env.root);
    const text = summary.join("\n");

    // Clean single "nothing kept" line.
    expect(summary).toHaveLength(1);
    expect(text).toContain("nothing kept");
    expect(text).toContain("Ghost");

    // No misleading path names.
    expect(text).not.toContain("~/.config/metafactory/ghost");
    expect(text).not.toContain("~/.local/state/metafactory/ghost");

    // No purge suggestion when there is nothing to purge.
    expect(text).not.toContain("--purge");
    expect(text).not.toContain("arc purge");
  });

  test("(d) a glob owns entry names only the matches that exist", async () => {
    const repo = await createMockSkillRepo(env.root, {
      name: "Globby",
      owns: {
        state: ["~/.local/state/metafactory/globby/*/workspace"],
      },
    });
    await install({ arc: env.arc, host: env.host, db: env.db, repoUrl: repo.url, yes: true });
    const result = await remove(env.db, env.arc, env.host, "Globby", { yes: true });

    // One matching stack dir exists, one sibling has no workspace child.
    await makeOwnsPath(env.root, "~/.local/state/metafactory/globby/alpha/workspace");
    await makeOwnsPath(env.root, "~/.local/state/metafactory/globby/beta");

    const text = formatRemoveKeptSummary(result, env.root).join("\n");
    expect(text).toContain("~/.local/state/metafactory/globby/alpha/workspace");
    // beta has no workspace child → the glob does not match it → not named.
    expect(text).not.toContain("globby/beta/workspace");
    expect(text).toContain("arc remove --purge Globby");
  });
});
