import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { validateForPublish, createBundle } from "../../src/lib/bundle.js";
import {
  minTier,
  isExactPin,
  referenceLabel,
  TIER_TRUST_ORDER,
  type MemberResolver,
  type ResolvedMember,
} from "../../src/lib/factory-references.js";

/**
 * arc#402 — publish-side validation for the composition types (`factory`,
 * `bundle`), per `docs/design-factory-type.md` D4 (exact pins) and D5 (a
 * factory's tier is the MIN of its members').
 *
 * RED-first. Every test here failed before `src/lib/factory-references.ts`
 * existed and before `validateForPublish` learned the composition rules.
 *
 * The four refusals the issue names, plus the build-metadata refusal mirrored
 * from the registry counterpart (meta-factory#574), all assert on the MESSAGE
 * as well as the verdict: a publish refusal that does not name the offending
 * entry makes the author guess, and the acceptance criterion is explicit
 * ("Publish refusals name the exact offending entries").
 */

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "arc-402-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────

/** A factory manifest that is valid in every respect the test does not vary. */
function factoryManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "arc/v1",
    name: "software-factory",
    version: "0.1.0",
    type: "factory",
    tier: "community",
    description: "The software factory composition.",
    produces: "software",
    tools: [{ name: "git" }, { name: "bun", min_version: "1.2.0" }],
    references: [
      { name: "cortex", version: "6.1.0" },
      { name: "compass-core", version: "0.9.3" },
    ],
    ...over,
  };
}

/** Resolve every reference as an `official`, non-revoked member. */
const resolveAllOfficial: MemberResolver = (ref) => ({
  name: ref.name,
  version: ref.version,
  tier: "official",
});

/** Resolve from an explicit table; anything absent is unresolvable (null). */
function tableResolver(table: Record<string, ResolvedMember>): MemberResolver {
  return (ref) => table[ref.name] ?? null;
}

// ── D4: exact pins ───────────────────────────────────────────

describe("arc#402 D4 — references must carry exact versions", () => {
  test("a range pin is refused, and the refusal lists EVERY offending entry", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: "cortex", version: "^6.1.0" },
          { name: "compass-core", version: "0.9.3" },
          { name: "discord", version: ">=1.0.0 <2.0.0" },
          { name: "luna-lite", version: "1.x" },
        ],
      }),
      { resolveMember: resolveAllOfficial },
    );

    expect(result.valid).toBe(false);
    const joined = result.errors.join("\n");
    // Each offending entry named, with its offending value.
    expect(joined).toContain("cortex");
    expect(joined).toContain("^6.1.0");
    expect(joined).toContain("discord");
    expect(joined).toContain(">=1.0.0 <2.0.0");
    expect(joined).toContain("luna-lite");
    expect(joined).toContain("1.x");
    // The one exact pin is NOT accused.
    expect(joined).not.toContain("compass-core");
    // Three refusals, one per offending entry — not one lumped message.
    expect(result.errors.filter((e) => e.includes("exact semver"))).toHaveLength(3);
  });

  test("an OR range is refused", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ name: "cortex", version: "1.0.0 || 2.0.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("1.0.0 || 2.0.0"))).toBe(true);
  });

  test("an exact prerelease pin is accepted (it names one release)", () => {
    expect(isExactPin("1.0.0-rc.1")).toBe(true);
    expect(isExactPin("1.0.0")).toBe(true);
    expect(isExactPin("v1.0.0")).toBe(false); // a stored version carries no `v`
    expect(isExactPin("1.0")).toBe(false);
    expect(isExactPin("*")).toBe(false);
    expect(isExactPin("~1.2.0")).toBe(false);
  });
});

// ── D4/S2: build metadata (mirrors meta-factory#574) ─────────

describe("arc#402 — a pin carrying build metadata is refused with a targeted message", () => {
  test("`1.2.3+build.5` is refused, and the message explains WHY it is not a pin", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ name: "cortex", version: "1.2.3+build.5" }] }),
      { resolveMember: resolveAllOfficial },
    );

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => e.includes("1.2.3+build.5"));
    expect(offender).toBeDefined();
    // Targeted: it LOOKS exact, so "not an exact version" would read as a bug.
    expect(offender).toContain("build metadata");
    expect(offender).toContain("cortex");
  });

  test("isExactPin refuses build metadata even on an otherwise exact version", () => {
    expect(isExactPin("1.2.3+build.5")).toBe(false);
    expect(isExactPin("1.2.3-rc.1+build.5")).toBe(false);
  });
});

// ── Reference resolution ─────────────────────────────────────

describe("arc#402 — every referenced member must resolve at publish time", () => {
  test("an unresolvable reference is refused, naming it", () => {
    const result = validateForPublish(factoryManifest(), {
      resolveMember: tableResolver({
        cortex: { name: "cortex", version: "6.1.0", tier: "official" },
        // compass-core deliberately absent
      }),
    });

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => e.includes("compass-core"));
    expect(offender).toBeDefined();
    expect(offender).toContain("0.9.3");
    expect(offender).toMatch(/resolve/i);
    expect(result.errors.some((e) => e.includes("cortex"))).toBe(false);
  });

  test("with NO resolver available, publish REFUSES rather than skipping the check", () => {
    // The judgement call, pinned as behavior: a composition whose members arc
    // cannot resolve is not published with the check silently skipped.
    const result = validateForPublish(factoryManifest());

    expect(result.valid).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toMatch(/resolve/i);
    expect(joined).toContain("cortex");
    expect(joined).toContain("compass-core");
  });

  test("a resolved-but-REVOKED member warns, it does not refuse (DD-108 publish-refresh)", () => {
    const result = validateForPublish(factoryManifest({ tier: "official" }), {
      resolveMember: tableResolver({
        cortex: { name: "cortex", version: "6.1.0", tier: "official" },
        "compass-core": {
          name: "compass-core",
          version: "0.9.3",
          tier: "official",
          revoked: true,
        },
      }),
    });

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("compass-core") && /revoked/i.test(w))).toBe(true);
  });

  test("a duplicate reference is refused, naming it once", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: "cortex", version: "6.1.0" },
          { name: "cortex", version: "6.2.0" },
        ],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate/i.test(e) && e.includes("cortex"))).toBe(true);
  });

  test("a composition with an empty references list is refused", () => {
    const result = validateForPublish(factoryManifest({ references: [] }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("references"))).toBe(true);
  });
});

// ── D5: tier = MIN of members ────────────────────────────────

describe("arc#402 D5 — a factory's tier is the MIN of its members'", () => {
  test("minTier picks the least-trusted member tier", () => {
    expect(minTier(["official", "community"])).toBe("community");
    expect(minTier(["core", "official"])).toBe("official");
    expect(minTier(["official", "official"])).toBe("official");
    expect(minTier(["community", "custom", "core"])).toBe("custom");
    expect(minTier([])).toBeNull();
    // Trust order, most-trusted first — the ranking the MIN is taken over.
    expect([...TIER_TRUST_ORDER]).toEqual(["core", "official", "community", "custom"]);
  });

  test("a declared tier ABOVE the computed MIN is refused, naming BOTH", () => {
    const result = validateForPublish(factoryManifest({ tier: "official" }), {
      resolveMember: tableResolver({
        cortex: { name: "cortex", version: "6.1.0", tier: "official" },
        "compass-core": { name: "compass-core", version: "0.9.3", tier: "community" },
      }),
    });

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => /tier/i.test(e));
    expect(offender).toBeDefined();
    expect(offender).toContain("official"); // the declared tier
    expect(offender).toContain("community"); // the computed MIN
    expect(offender).toContain("compass-core"); // the member that pulled it down
  });

  test("a declared tier BELOW the computed MIN is allowed (trust may under-claim)", () => {
    const result = validateForPublish(factoryManifest({ tier: "custom" }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(true);
  });

  test("a declared tier EQUAL to the computed MIN is allowed", () => {
    const result = validateForPublish(factoryManifest({ tier: "official" }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(true);
  });
});

// ── D1: tools + produces well-formedness ─────────────────────

describe("arc#402 D1 — factory `tools:` and `produces:` are well-formed", () => {
  test("a factory with no `produces` is refused", () => {
    const m = factoryManifest();
    delete m.produces;
    const result = validateForPublish(m, { resolveMember: resolveAllOfficial });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("produces"))).toBe(true);
  });

  test("a non-slug `produces` is refused", () => {
    const result = validateForPublish(factoryManifest({ produces: "Software Factory" }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("produces"))).toBe(true);
  });

  test("a factory with no `tools` is refused", () => {
    const m = factoryManifest();
    delete m.tools;
    const result = validateForPublish(m, { resolveMember: resolveAllOfficial });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("tools"))).toBe(true);
  });

  test("a tool name that is a path or carries arguments is refused, naming it", () => {
    const result = validateForPublish(
      factoryManifest({ tools: [{ name: "/usr/bin/git --version" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("/usr/bin/git --version"))).toBe(true);
  });

  test("a RANGE min_version is refused — a range is not a floor", () => {
    const result = validateForPublish(
      factoryManifest({ tools: [{ name: "bun", min_version: "^1.2.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("^1.2.0"))).toBe(true);
  });

  test("`tools`/`produces` on a NON-factory type are refused (declarations nothing reads)", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "x",
      produces: "software",
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("produces"))).toBe(true);
  });

  test("`references` on a NON-composition type are refused", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "x",
      references: [{ name: "cortex", version: "6.1.0" }],
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("references"))).toBe(true);
  });

  test("a `bundle` needs references but NOT tools/produces (factory-only, D1)", () => {
    const result = validateForPublish(
      {
        name: "a-bundle",
        version: "1.0.0",
        type: "bundle",
        description: "x",
        tier: "official",
        references: [{ name: "cortex", version: "6.1.0" }],
      } as never,
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(true);
  });
});

// ── referenceLabel ───────────────────────────────────────────

describe("arc#402 — reference labels", () => {
  test("a scoped reference renders with its scope, an unscoped one bare", () => {
    expect(referenceLabel({ name: "cortex", version: "6.1.0" })).toBe("cortex");
    expect(referenceLabel({ scope: "metafactory", name: "cortex", version: "6.1.0" })).toBe(
      "@metafactory/cortex",
    );
  });
});

// ── Happy path, end to end through createBundle ──────────────

describe("arc#402 — happy path: a well-formed factory publishes", () => {
  test("validateForPublish accepts a fully-pinned, fully-resolved factory", () => {
    const result = validateForPublish(factoryManifest(), { resolveMember: resolveAllOfficial });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.name).toBe("software-factory");
    expect(result.version).toBe("0.1.0");
  });

  test("createBundle bundles a factory package when a resolver is supplied", async () => {
    const dir = join(testDir, "metafactory-factory-software");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "arc-manifest.yaml"), YAML.stringify(factoryManifest()));
    await writeFile(join(dir, "README.md"), "# software factory\n");

    const result = await createBundle(dir, join(testDir, "out.tar.gz"), {
      resolveMember: resolveAllOfficial,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("createBundle REFUSES a factory whose pins are ranges, naming the entry", async () => {
    const dir = join(testDir, "bad-factory");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "arc-manifest.yaml"),
      YAML.stringify(factoryManifest({ references: [{ name: "cortex", version: "^6.1.0" }] })),
    );

    const result = await createBundle(dir, join(testDir, "bad.tar.gz"), {
      resolveMember: resolveAllOfficial,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("cortex");
    expect(result.error).toContain("^6.1.0");
  });
});
