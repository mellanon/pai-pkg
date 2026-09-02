import { describe, test, expect, afterEach } from "bun:test";
import {
  aggregateCapabilities,
  checkTools,
  combinedRisk,
  formatCombinedCapabilityReview,
  isCompositionType,
  isExactVersion,
  minimumTier,
  readCompositionReferences,
  readCompositionTools,
  tierMinWarning,
  validateCompositionFields,
  type CompositionMemberSurface,
} from "../../src/lib/composition.js";
import { recordComposition, compositionMembers, allCompositions } from "../../src/lib/db.js";
import { recordInstall } from "../../src/lib/db.js";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import type { ArcManifest } from "../../src/types.js";

/**
 * arc#400 slice 2 — the PURE half of reference-resolution install:
 * D4 (exact pins, re-checked at install), the `tools:` gate, D2's aggregation
 * rules, D5's tier MIN, and the DB shape the lifecycle slice (#401) consumes.
 *
 * Every refusal in the issue's ACs is pinned here at the unit level and again
 * end-to-end in composition-install.test.ts.
 */

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

function factoryManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "arc/v1",
    name: "software-factory",
    version: "0.1.0",
    type: "factory",
    tier: "custom",
    description: "The software factory composition.",
    license: "Apache-2.0",
    author: { name: "Jane Doe", github: "janedoe" },
    ...extra,
  };
}

/** A member manifest with the given capability block. */
function member(
  name: string,
  caps: ArcManifest["capabilities"],
  opts: { version?: string; tier?: "official" | "community" | "custom" } = {},
): CompositionMemberSurface {
  return {
    name,
    version: opts.version ?? "1.0.0",
    tier: opts.tier ?? "custom",
    manifest: {
      name,
      version: opts.version ?? "1.0.0",
      type: "skill",
      tier: opts.tier ?? "custom",
      capabilities: caps,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// D4 — exact pins, refused at INSTALL time too (not only at publish)
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 D4 — references[] versions must be EXACT", () => {
  test("isExactVersion accepts a fully-specified semver and nothing else", () => {
    for (const ok of ["1.0.0", "0.1.0", "10.20.30", "1.2.3-rc.1", "1.2.3+build.5"]) {
      expect(isExactVersion(ok)).toBe(true);
    }
    for (const bad of [">=1.0.0", "^1.2.0", "~1.2.0", "1.x", "1.2", "*", "latest", "", "  "]) {
      expect(isExactVersion(bad)).toBe(false);
    }
  });

  for (const range of [">=1.0.0", "^1.2.0", "~1.2.0", "1.x", "1.2", "*", "latest"]) {
    test(`a range version ${JSON.stringify(range)} is a LOUD validation error`, () => {
      const violations = validateCompositionFields(
        factoryManifest({ references: [{ name: "@metafactory/cortex", version: range }] }),
      );
      const hit = violations.find((v) => v.field === "references[0].version");
      expect(hit).toBeDefined();
      // The message has to name the offending value and say what is required —
      // a refusal an operator can act on without reading the source.
      expect(hit!.rule).toContain(range);
      expect(hit!.rule.toLowerCase()).toContain("exact");
    });
  }

  test("an exact pin passes", () => {
    expect(
      validateCompositionFields(
        factoryManifest({ references: [{ name: "@metafactory/cortex", version: "6.1.0" }] }),
      ),
    ).toEqual([]);
  });

  test("a reference missing its version is refused (no floating members — D4)", () => {
    const violations = validateCompositionFields(
      factoryManifest({ references: [{ name: "@metafactory/cortex" }] }),
    );
    expect(violations.some((v) => v.field === "references[0].version")).toBe(true);
  });

  test("a reference with no resolvable address is refused", () => {
    // A bare name with no `repo:` cannot be resolved to a published package.
    const violations = validateCompositionFields(
      factoryManifest({ references: [{ name: "cortex", version: "6.1.0" }] }),
    );
    expect(violations.some((v) => v.field === "references[0].name")).toBe(true);
  });

  test("a bare name WITH a repo URL resolves fine", () => {
    expect(
      validateCompositionFields(
        factoryManifest({
          references: [
            { name: "cortex", version: "6.1.0", repo: "https://github.com/the-metafactory/cortex" },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("unknown keys on a reference are refused (typo protection on the trust path)", () => {
    const violations = validateCompositionFields(
      factoryManifest({
        references: [{ name: "@metafactory/cortex", version: "6.1.0", verison: "6.1.0" }],
      }),
    );
    expect(violations.some((v) => v.field === "references[0]")).toBe(true);
  });

  test("references[] on a NON-composition type is refused (D1)", () => {
    const violations = validateCompositionFields(
      factoryManifest({ type: "skill", references: [{ name: "@a/b", version: "1.0.0" }] }),
    );
    expect(violations.some((v) => v.field === "references")).toBe(true);
  });

  test("tools:/produces: are factory-only (D1)", () => {
    const onBundle = validateCompositionFields(
      factoryManifest({ type: "bundle", tools: [{ name: "git" }], produces: "software" }),
    );
    expect(onBundle.some((v) => v.field === "tools")).toBe(true);
    expect(onBundle.some((v) => v.field === "produces")).toBe(true);

    expect(
      validateCompositionFields(factoryManifest({ tools: [{ name: "git" }], produces: "software" })),
    ).toEqual([]);
  });

  test("a tool name that is not a bare binary name is refused (it reaches a lookup)", () => {
    for (const bad of ["/usr/bin/git", "git rm -rf", "-git", ""]) {
      const violations = validateCompositionFields(factoryManifest({ tools: [{ name: bad }] }));
      expect(violations.some((v) => v.field === "tools[0].name")).toBe(true);
    }
  });

  test("readCompositionReferences/Tools return typed entries for a valid manifest", () => {
    const manifest = factoryManifest({
      references: [{ name: "@metafactory/cortex", version: "6.1.0" }],
      tools: [{ name: "git", version: ">=2.30.0" }],
    }) as unknown as ArcManifest;
    expect(readCompositionReferences(manifest)).toEqual([
      { name: "@metafactory/cortex", version: "6.1.0" },
    ]);
    expect(readCompositionTools(manifest)).toEqual([{ name: "git", version: ">=2.30.0" }]);
  });

  test("isCompositionType names exactly bundle + factory", () => {
    expect(isCompositionType("bundle")).toBe(true);
    expect(isCompositionType("factory")).toBe(true);
    for (const other of ["skill", "library", "tool", "agent"]) {
      expect(isCompositionType(other)).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// tools: — checked before anything, missing binary is a loud refusal
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 — the tools: gate", () => {
  test("a missing binary is a refusal that NAMES it", () => {
    const result = checkTools([{ name: "gh", reason: "PR automation" }], () => ({ found: false }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gh");
    expect(result.missing).toEqual(["gh"]);
  });

  test("every missing binary is named in one pass, not one at a time", () => {
    const result = checkTools(
      [{ name: "git" }, { name: "gh" }, { name: "bun" }],
      (name) => ({ found: name === "git" }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["gh", "bun"]);
    expect(result.error).toContain("gh");
    expect(result.error).toContain("bun");
  });

  test("a version below the declared floor is a refusal naming both versions", () => {
    const result = checkTools(
      [{ name: "bun", version: ">=1.2.0" }],
      () => ({ found: true, path: "/usr/local/bin/bun", version: "1.0.5" }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1.0.5");
    expect(result.error).toContain(">=1.2.0");
  });

  test("a satisfied floor passes", () => {
    const result = checkTools(
      [{ name: "bun", version: ">=1.2.0" }],
      () => ({ found: true, path: "/usr/local/bin/bun", version: "1.3.0" }),
    );
    expect(result.ok).toBe(true);
  });

  test("an unreadable version WARNS rather than refusing (fail-open, semver.ts posture)", () => {
    const result = checkTools(
      [{ name: "bun", version: ">=1.2.0" }],
      () => ({ found: true, path: "/usr/local/bin/bun" }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("bun");
  });

  test("no tools declared is a pass", () => {
    expect(checkTools(undefined, () => ({ found: false })).ok).toBe(true);
    expect(checkTools([], () => ({ found: false })).ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D2 — aggregation rules
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 D2 — combined capability surface", () => {
  test("filesystem read/write is the deduped union, grouped by member", () => {
    const surface = aggregateCapabilities([
      member("alpha", { filesystem: { read: ["~/a", "~/shared"], write: ["~/w"] } }),
      member("beta", { filesystem: { read: ["~/shared", "~/b"], write: [] } }),
    ]);

    expect(surface.read.map((e) => e.value)).toEqual(["~/a", "~/shared", "~/b"]);
    expect(surface.read.find((e) => e.value === "~/shared")!.members).toEqual(["alpha", "beta"]);
    expect(surface.read.find((e) => e.value === "~/a")!.members).toEqual(["alpha"]);
    expect(surface.write.map((e) => e.value)).toEqual(["~/w"]);
    expect(surface.write[0].members).toEqual(["alpha"]);
  });

  test("network is the deduped union and keeps every member's reason", () => {
    const surface = aggregateCapabilities([
      member("alpha", { network: [{ host: "api.example.com", reason: "publish" }] }),
      member("beta", {
        network: [
          { host: "api.example.com", reason: "poll" },
          { host: "cdn.example.com", reason: "assets" },
        ],
      }),
    ]);

    expect(surface.network.map((e) => e.value)).toEqual(["api.example.com", "cdn.example.com"]);
    const shared = surface.network.find((e) => e.value === "api.example.com")!;
    expect(shared.members).toEqual(["alpha", "beta"]);
    expect(shared.reason).toContain("publish");
    expect(shared.reason).toContain("poll");
  });

  test("bash allowed is an OR across members", () => {
    const none = aggregateCapabilities([
      member("alpha", { bash: { allowed: false } }),
      member("beta", { bash: { allowed: false } }),
    ]);
    expect(none.bash.allowed).toBe(false);

    const some = aggregateCapabilities([
      member("alpha", { bash: { allowed: false } }),
      member("beta", { bash: { allowed: true, restricted_to: ["git status"] } }),
    ]);
    expect(some.bash.allowed).toBe(true);
    expect(some.bash.unrestricted).toBe(false);
  });

  test("restricted_to is the union of member lists, attributed", () => {
    const surface = aggregateCapabilities([
      member("alpha", { bash: { allowed: true, restricted_to: ["git status", "bun test"] } }),
      member("beta", { bash: { allowed: true, restricted_to: ["bun test"] } }),
    ]);
    expect(surface.bash.restricted.map((e) => e.value)).toEqual(["git status", "bun test"]);
    expect(surface.bash.restricted.find((e) => e.value === "bun test")!.members).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("ONE member with unrestricted bash marks the WHOLE surface unrestricted, and is flagged", () => {
    const surface = aggregateCapabilities([
      member("alpha", { bash: { allowed: true, restricted_to: ["git status"] } }),
      member("beta", { bash: { allowed: true } }),
    ]);
    expect(surface.bash.allowed).toBe(true);
    expect(surface.bash.unrestricted).toBe(true);
    expect(surface.bash.unrestrictedMembers).toEqual(["beta"]);

    const lines = formatCombinedCapabilityReview({
      name: "software-factory",
      version: "0.1.0",
      surface,
      members: [],
    });
    const bashLine = lines.find((l) => l.includes("unrestricted"));
    expect(bashLine).toBeDefined();
    expect(bashLine).toContain("beta");
  });

  test("the recorded `bash: (unrestricted)` row shape (arc#403) aggregates as unrestricted", () => {
    // main records unrestricted bash as a first-class capability row with the
    // sentinel VALUE rather than as an absent row. Aggregation reads member
    // surfaces through the same `capabilityRows` walk, so the sentinel must
    // land in `unrestricted`, never in `restricted` as a literal command.
    const surface = aggregateCapabilities([member("alpha", { bash: { allowed: true } })]);
    expect(surface.bash.unrestricted).toBe(true);
    expect(surface.bash.restricted.map((e) => e.value)).not.toContain("(unrestricted)");
    expect(surface.bash.restricted).toEqual([]);
  });

  test("secrets are unioned and each is attributed to its member", () => {
    const surface = aggregateCapabilities([
      member("alpha", { secrets: ["GITHUB_TOKEN"] }),
      member("beta", {
        secrets: [{ name: "GITHUB_TOKEN", reason: "PR reads" }, { name: "DISCORD_TOKEN" }],
      }),
    ]);
    expect(surface.secrets.map((e) => e.value)).toEqual(["GITHUB_TOKEN", "DISCORD_TOKEN"]);
    expect(surface.secrets.find((e) => e.value === "GITHUB_TOKEN")!.members).toEqual([
      "alpha",
      "beta",
    ]);
    expect(surface.secrets.find((e) => e.value === "DISCORD_TOKEN")!.members).toEqual(["beta"]);
  });

  test("a member with NO capabilities block contributes nothing and does not crash", () => {
    const bare = member("bare", undefined);
    const surface = aggregateCapabilities([bare, member("alpha", { network: [{ host: "h", reason: "r" }] })]);
    expect(surface.network.map((e) => e.value)).toEqual(["h"]);
  });

  test("combined risk is computed over the UNION, not per member", () => {
    // Neither member is HIGH on its own; together they are network + write.
    const surface = aggregateCapabilities([
      member("alpha", { network: [{ host: "api.example.com", reason: "publish" }] }),
      member("beta", { filesystem: { read: [], write: ["~/w"] } }),
    ]);
    expect(combinedRisk(surface)).toBe("high");
    expect(surface.risk).toBe("high");
  });

  test("the review displays the FULL union — nothing summarised away (D2 honesty rule)", () => {
    const surface = aggregateCapabilities([
      member("alpha", { filesystem: { read: ["~/a"], write: ["~/w"] }, secrets: ["TOKEN_A"] }),
      member("beta", { network: [{ host: "api.example.com", reason: "publish" }] }),
    ]);
    const lines = formatCombinedCapabilityReview({
      name: "software-factory",
      version: "0.1.0",
      surface,
      members: [member("alpha", undefined), member("beta", undefined)],
    });
    const text = lines.join("\n");
    for (const shown of ["~/a", "~/w", "TOKEN_A", "api.example.com", "alpha", "beta"]) {
      expect(text).toContain(shown);
    }
    // Reuses the fresh-install display conventions (cli.ts / manifest.ts).
    expect(text).toContain("🟢 Read:");
    expect(text).toContain("🟡 Write:");
    expect(text).toContain("🟡 Network:");
    expect(text).toContain("🟡 Secret:");
    expect(text).toContain("Risk:");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D5 — tier MIN, re-checked at install
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 D5 — tier is the MIN of the members'", () => {
  test("trust never averages up", () => {
    expect(minimumTier(["official", "official"])).toBe("official");
    expect(minimumTier(["official", "community"])).toBe("community");
    expect(minimumTier(["official", "community", "custom"])).toBe("custom");
    expect(minimumTier([])).toBeNull();
  });

  test("a factory claiming a tier above its computed MIN WARNS, naming the member", () => {
    const warning = tierMinWarning("official", [
      member("alpha", undefined, { tier: "official" }),
      member("beta", undefined, { tier: "community" }),
    ]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("official");
    expect(warning).toContain("community");
    expect(warning).toContain("beta");
    // Extends audit.ts's warning style (arc#400 D5 / E9).
    expect(warning).toContain("WARN");
  });

  test("a factory at or below its computed MIN does not warn", () => {
    expect(
      tierMinWarning("community", [
        member("alpha", undefined, { tier: "official" }),
        member("beta", undefined, { tier: "community" }),
      ]),
    ).toBeNull();
    expect(tierMinWarning("custom", [member("alpha", undefined, { tier: "official" })])).toBeNull();
  });

  test("no members means nothing to compare", () => {
    expect(tierMinWarning("official", [])).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The recorded composition — #401's input
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 — the composition recorded in the DB (input to #401)", () => {
  test("members + pinned versions round-trip, ordered as declared", async () => {
    env = await createTestEnv();
    recordInstall(
      env.db,
      {
        name: "software-factory",
        version: "0.1.0",
        repo_url: "https://example.com/factory",
        install_path: "/tmp/factory",
        skill_dir: "/tmp/factory",
        status: "active",
        artifact_type: "factory",
        tier: "custom",
        customization_path: null,
        install_source: null,
        library_name: null,
        installed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { name: "software-factory", version: "0.1.0", type: "factory" },
    );

    recordComposition(env.db, "software-factory", [
      { name: "@metafactory/cortex", version: "6.1.0", source: "registry", ref: "@metafactory/cortex" },
      { name: "compass-core", version: "0.4.0", source: "repo", ref: "https://github.com/x/compass-core" },
    ]);

    const rows = compositionMembers(env.db, "software-factory");
    expect(rows.map((r) => r.member_name)).toEqual(["@metafactory/cortex", "compass-core"]);
    expect(rows.map((r) => r.member_version)).toEqual(["6.1.0", "0.4.0"]);
    expect(rows.map((r) => r.member_source)).toEqual(["registry", "repo"]);
    expect(rows[0].position).toBe(0);
    expect(rows[1].position).toBe(1);

    const all = allCompositions(env.db);
    expect(all.get("software-factory")!.length).toBe(2);
  });

  test("re-recording replaces rather than duplicates", async () => {
    env = await createTestEnv();
    recordInstall(
      env.db,
      {
        name: "f",
        version: "0.1.0",
        repo_url: "u",
        install_path: "/tmp/f",
        skill_dir: "/tmp/f",
        status: "active",
        artifact_type: "factory",
        tier: "custom",
        customization_path: null,
        install_source: null,
        library_name: null,
        installed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { name: "f", version: "0.1.0", type: "factory" },
    );
    const one = [{ name: "a", version: "1.0.0", source: "repo" as const, ref: "r" }];
    recordComposition(env.db, "f", one);
    recordComposition(env.db, "f", one);
    expect(compositionMembers(env.db, "f").length).toBe(1);
  });

  test("removing the composition removes its member rows (FK cascade)", async () => {
    env = await createTestEnv();
    recordInstall(
      env.db,
      {
        name: "f",
        version: "0.1.0",
        repo_url: "u",
        install_path: "/tmp/f",
        skill_dir: "/tmp/f",
        status: "active",
        artifact_type: "factory",
        tier: "custom",
        customization_path: null,
        install_source: null,
        library_name: null,
        installed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { name: "f", version: "0.1.0", type: "factory" },
    );
    recordComposition(env.db, "f", [{ name: "a", version: "1.0.0", source: "repo", ref: "r" }]);
    env.db.prepare("DELETE FROM skills WHERE name = ?").run("f");
    expect(compositionMembers(env.db, "f")).toEqual([]);
  });
});
