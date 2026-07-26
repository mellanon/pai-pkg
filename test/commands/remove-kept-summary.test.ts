import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestEnv,
  createMockSkillRepo,
  type TestEnv,
} from "../helpers/test-env.js";
import { install } from "../../src/commands/install.js";
import { remove, formatRemoveKeptSummary } from "../../src/commands/remove.js";

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

    const summary = formatRemoveKeptSummary(result);
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
    expect(formatRemoveKeptSummary(result)).toEqual([]);
  });

  test("returns no lines for a package that declares no owns at all", () => {
    expect(formatRemoveKeptSummary({ success: true, name: "Plain" })).toEqual([]);
  });
});
