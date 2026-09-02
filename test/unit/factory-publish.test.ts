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
  type ManifestTier,
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

// ═════════════════════════════════════════════════════════════
// Review round 2 on 8e5010a (F1–F7)
// ═════════════════════════════════════════════════════════════

/**
 * F1 — the tier vocabulary is a SEAM, and a seam that accepts an unknown value
 * silently is not a seam. `minTier` ranks by index into TIER_TRUST_ORDER, so a
 * resolver returning `experimental` scored -1 and simply dropped out of the
 * MIN. The real resolver will wrap registry JSON, which is exactly where an
 * unrecognized string arrives from. Refuse, do not clamp: clamping invents a
 * trust level nobody declared.
 */
describe("arc#402 F1 — an unrecognized member tier is refused, not dropped", () => {
  test("ONE unknown tier: the member is named with its bad value, and D5 is not skipped", () => {
    const result = validateForPublish(factoryManifest({ tier: "official" }), {
      resolveMember: tableResolver({
        cortex: { name: "cortex", version: "6.1.0", tier: "official" },
        "compass-core": {
          name: "compass-core",
          version: "0.9.3",
          tier: "experimental" as ManifestTier,
        },
      }),
    });

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => e.includes("experimental"));
    expect(offender).toBeDefined();
    expect(offender).toContain("compass-core");
    // The valid vocabulary is spelled out — the resolver author has to know it.
    expect(offender).toContain("official");
  });

  test("EVERY tier unknown: publish is refused rather than skipping D5 entirely", () => {
    // The nastier probe. With every member unrecognized the computed MIN was
    // null, checkDeclaredTier returned early, and a factory declaring
    // `official` published clean with its tier never checked against anything.
    const result = validateForPublish(factoryManifest({ tier: "official" }), {
      resolveMember: (ref) => ({
        name: ref.name,
        version: ref.version,
        tier: "experimental" as ManifestTier,
      }),
    });

    expect(result.valid).toBe(false);
    expect(result.errors.filter((e) => e.includes("experimental")).length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * F2 — the `!isManifestTier(declared)` guard was written for an ABSENT tier and
 * silently swallowed a MALFORMED one too, so `tier: Official` skipped D5.
 */
describe("arc#402 F2 — a malformed declared tier is refused, an absent one is not", () => {
  test("`Official` is refused, naming the valid tiers", () => {
    const result = validateForPublish(factoryManifest({ tier: "Official" }), {
      resolveMember: resolveAllOfficial,
    });

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => e.includes("Official"));
    expect(offender).toBeDefined();
    for (const tier of TIER_TRUST_ORDER) expect(offender).toContain(tier);
  });

  test("an ABSENT tier stays tolerated — F6's warning covers it, not a refusal", () => {
    const m = factoryManifest();
    delete m.tier;
    const result = validateForPublish(m, { resolveMember: resolveAllOfficial });
    expect(result.valid).toBe(true);
  });
});

/**
 * F3 — the self-reference check compared bare names, so a genuinely different
 * package that happens to share a name in another scope was falsely refused.
 */
describe("arc#402 F3 — self-reference is decided on the scoped label", () => {
  test("the same name in a DIFFERENT scope is a different package, and is allowed", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [{ scope: "other", name: "software-factory", version: "1.0.0" }],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.errors.filter((e) => /itself/i.test(e))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("a true self-reference is still refused", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ name: "software-factory", version: "1.0.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /itself/i.test(e))).toBe(true);
  });

  test("a scoped self-reference matching the manifest's own namespace is refused", () => {
    const result = validateForPublish(
      factoryManifest({
        namespace: "metafactory",
        references: [{ scope: "metafactory", name: "software-factory", version: "1.0.0" }],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /itself/i.test(e))).toBe(true);
  });
});

/**
 * F4 — reference names were never checked against a name grammar, and the
 * duplicate/self checks were case-sensitive.
 */
describe("arc#402 F4 — reference names are validated locally and matched case-insensitively", () => {
  test("a case-variant duplicate is caught", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: "cortex", version: "6.1.0" },
          { name: "Cortex", version: "6.2.0" },
        ],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /duplicate/i.test(e))).toBe(true);
  });

  test("a path-shaped reference name is refused, and never reaches the resolver", () => {
    // The resolver will be a network client; a junk name must not become part
    // of a URL. Asserted, not assumed.
    const seen: string[] = [];
    const spy: MemberResolver = (ref) => {
      seen.push(ref.name);
      return { name: ref.name, version: ref.version, tier: "official" };
    };

    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: "../../etc/passwd", version: "1.0.0" },
          { name: "cortex", version: "6.1.0" },
        ],
      }),
      { resolveMember: spy },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("../../etc/passwd"))).toBe(true);
    expect(seen).toEqual(["cortex"]);
  });

  test("a malformed scope is refused", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ scope: "Not A Scope", name: "cortex", version: "1.0.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Not A Scope"))).toBe(true);
  });
});

/** F5 — a refusal an operator cannot act on is a dead end. */
describe("arc#402 F5 — the no-resolver refusal says what unblocks it", () => {
  test("the message names the tracking issues", () => {
    const result = validateForPublish(factoryManifest());
    const offender = result.errors.find((e) => /resolve/i.test(e));
    expect(offender).toBeDefined();
    expect(offender).toContain("#366");
    expect(offender).toContain("meta-factory#573");
  });
});

/** F6 — D5 must not be silently vacuous when no tier is declared. */
describe("arc#402 F6 — the computed tier is surfaced", () => {
  test("PublishValidation carries computedTier", () => {
    const result = validateForPublish(factoryManifest(), { resolveMember: resolveAllOfficial });
    expect(result.valid).toBe(true);
    expect(result.computedTier).toBe("official");
  });

  test("an ABSENT declared tier warns, naming the computed MIN", () => {
    const m = factoryManifest();
    delete m.tier;
    const result = validateForPublish(m, {
      resolveMember: tableResolver({
        cortex: { name: "cortex", version: "6.1.0", tier: "official" },
        "compass-core": { name: "compass-core", version: "0.9.3", tier: "community" },
      }),
    });

    expect(result.valid).toBe(true);
    expect(result.computedTier).toBe("community");
    expect(result.warnings.some((w) => /tier/i.test(w) && w.includes("community"))).toBe(true);
  });

  test("a non-composition publish leaves computedTier null", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "x",
    });
    expect(result.valid).toBe(true);
    expect(result.computedTier).toBeNull();
  });
});

/**
 * F7 — the pin grammar is DERIVED from what the registry can store, and the
 * registry's storage grammar was read rather than assumed:
 * meta-factory `src/lib/semver.ts` — `/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/`.
 */
describe("arc#402 F7 — the pin grammar matches the registry's storage grammar exactly", () => {
  test("a HYPHENATED prerelease is refused — the registry cannot store it", () => {
    // The real gap this found: arc was LOOSER than the registry here, so it
    // would have accepted a pin that could never resolve.
    expect(isExactPin("1.2.3-rc-1")).toBe(false);
    expect(isExactPin("1.2.3-rc.1")).toBe(true);
  });

  test("an empty prerelease is refused", () => {
    expect(isExactPin("1.2.3-")).toBe(false);
  });

  test("a leading zero is ACCEPTED, deliberately — the registry stores it", () => {
    // Not a tightening. The registry's storage grammar is `\d+` per component,
    // so `1.02.3` is a version it can hold and resolve. Refusing it arc-side
    // would invent a false refusal and break the property the whole mirror
    // exists for: the two gates agreeing.
    expect(isExactPin("1.02.3")).toBe(true);
  });
});
