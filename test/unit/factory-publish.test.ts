import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";
import { validateForPublish, createBundle } from "../../src/lib/bundle.js";
import { isExactVersion, EXACT_PIN_RE } from "../../src/lib/composition.js";
import {
  minTier,
  referenceKey,
  TIER_TRUST_ORDER,
  type ManifestTier,
  type MemberResolver,
  type ResolvedMember,
} from "../../src/lib/factory-references.js";

/**
 * arc#402 — PUBLISH-side validation for the composition types (`factory`,
 * `bundle`), per `docs/design-factory-type.md` D4 (exact pins) and D5 (a
 * factory's tier is the MIN of its members').
 *
 * ## What this file owns after the arc#400 rebase
 *
 * Since #400 landed, `lib/composition.ts` `validateCompositionFields` is the
 * single SHAPE authority for `references[]` / `tools[]` / `produces`, shared by
 * `arc validate`, `arc install` and now `arc publish`. The shape assertions
 * below are therefore CONTRACT tests on the publish path — they prove publish
 * runs the shared gate — not duplicate coverage of the grammar, which
 * `test/unit/composition-*.test.ts` owns. Each is labelled `(shared validator)`.
 *
 * What is genuinely this file's is the publish-ONLY layer: members must
 * resolve, D5's tier arithmetic as an ERROR, `tools:`/`produces:` REQUIRED on a
 * factory, a composition must have members, and the build-metadata,
 * case-variant-duplicate, revocation and computed-tier behaviours.
 */

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "arc-402-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────

const CORTEX = "@metafactory/cortex";
const COMPASS = "@metafactory/compass-core";

/**
 * A factory manifest valid in every respect the test does not vary.
 *
 * Reference names are SCOPED strings and tools carry `version` (a range floor)
 * — arc#400's shapes, adopted wholesale at the rebase.
 */
function factoryManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "arc/v1",
    name: "software-factory",
    namespace: "metafactory",
    version: "0.1.0",
    type: "factory",
    tier: "community",
    description: "The software factory composition.",
    produces: "software",
    tools: [{ name: "git" }, { name: "bun", version: ">=1.2.0" }],
    references: [
      { name: CORTEX, version: "6.1.0" },
      { name: COMPASS, version: "0.9.3" },
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
  test("a range pin is refused, and the refusal names EVERY offending entry", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: CORTEX, version: "^6.1.0" },
          { name: COMPASS, version: "0.9.3" },
          { name: "@metafactory/discord", version: ">=1.0.0 <2.0.0" },
          { name: "@metafactory/luna-lite", version: "1.x" },
        ],
      }),
      { resolveMember: resolveAllOfficial },
    );

    expect(result.valid).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain("^6.1.0");
    expect(joined).toContain(">=1.0.0 <2.0.0");
    expect(joined).toContain("1.x");
    // One refusal per offending entry, addressed by index — not one lumped
    // message. `compass-core` (index 1) is never accused.
    expect(result.errors.filter((e) => e.startsWith("references[0].version:"))).toHaveLength(1);
    expect(result.errors.filter((e) => e.startsWith("references[2].version:"))).toHaveLength(1);
    expect(result.errors.filter((e) => e.startsWith("references[3].version:"))).toHaveLength(1);
    expect(result.errors.filter((e) => e.startsWith("references[1]"))).toHaveLength(0);
  });

  test("an OR range is refused", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ name: CORTEX, version: "1.0.0 || 2.0.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("1.0.0 || 2.0.0"))).toBe(true);
  });

  test("an exact prerelease pin is accepted; partials and ranges are not", () => {
    expect(isExactVersion("1.0.0-rc.1")).toBe(true);
    expect(isExactVersion("1.0.0")).toBe(true);
    expect(isExactVersion("v1.0.0")).toBe(false); // a stored version carries no `v`
    expect(isExactVersion("1.0")).toBe(false);
    expect(isExactVersion("*")).toBe(false);
    expect(isExactVersion("~1.2.0")).toBe(false);
  });
});

// ── D4/S2: build metadata ────────────────────────────────────

describe("arc#402 — a pin carrying build metadata is refused, and EXPLAINED", () => {
  test("`1.2.3+build.5` is refused by the shared grammar AND explained by publish", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ name: CORTEX, version: "1.2.3+build.5" }] }),
      { resolveMember: resolveAllOfficial },
    );

    expect(result.valid).toBe(false);
    // The shared validator supplies the refusal...
    expect(result.errors.some((e) => e.startsWith("references[0].version:"))).toBe(true);
    // ...and publish supplies the reason, because a build-metadata pin LOOKS
    // exact and "must be an EXACT version" reads as an arc bug to its author.
    const note = result.errors.find((e) => e.includes("build metadata"));
    expect(note).toBeDefined();
    expect(note).toContain(CORTEX);
    expect(note).toContain("1.2.3+build.5");
  });

  test("the shared grammar excludes build metadata by construction", () => {
    expect(isExactVersion("1.2.3+build.5")).toBe(false);
    expect(isExactVersion("1.2.3-rc.1+build.5")).toBe(false);
  });
});

// ── Reference resolution (publish-only) ──────────────────────

describe("arc#402 — every referenced member must resolve at publish time", () => {
  test("an unresolvable reference is refused, naming it", () => {
    const result = validateForPublish(factoryManifest(), {
      resolveMember: tableResolver({
        [CORTEX]: { name: CORTEX, version: "6.1.0", tier: "official" },
        // compass-core deliberately absent
      }),
    });

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => e.includes(COMPASS));
    expect(offender).toBeDefined();
    expect(offender).toContain("0.9.3");
    expect(offender).toMatch(/resolve/i);
    expect(result.errors.some((e) => e.includes(CORTEX))).toBe(false);
  });

  test("with NO resolver available, publish REFUSES rather than skipping the check", () => {
    // The judgement call, pinned as behavior: a composition whose members arc
    // cannot resolve is not published with the check silently skipped.
    const result = validateForPublish(factoryManifest());

    expect(result.valid).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toMatch(/resolve/i);
    expect(joined).toContain(CORTEX);
    expect(joined).toContain(COMPASS);
  });

  test("a resolved-but-REVOKED member warns, it does not refuse (DD-108 publish-refresh)", () => {
    const result = validateForPublish(factoryManifest({ tier: "official" }), {
      resolveMember: tableResolver({
        [CORTEX]: { name: CORTEX, version: "6.1.0", tier: "official" },
        [COMPASS]: { name: COMPASS, version: "0.9.3", tier: "official", revoked: true },
      }),
    });

    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes(COMPASS) && /revoked/i.test(w))).toBe(true);
  });

  test("an exact duplicate reference is refused (shared validator)", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: CORTEX, version: "6.1.0" },
          { name: CORTEX, version: "6.2.0" },
        ],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /more than once/i.test(e) && e.includes(CORTEX))).toBe(true);
  });

  test("a composition with an empty references list is refused (publish-only)", () => {
    // #400 leaves references OPTIONAL so an install tolerates a member-less
    // manifest; publishing one puts an empty promise on the registry.
    const result = validateForPublish(factoryManifest({ references: [] }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("references:"))).toBe(true);
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
        [CORTEX]: { name: CORTEX, version: "6.1.0", tier: "official" },
        [COMPASS]: { name: COMPASS, version: "0.9.3", tier: "community" },
      }),
    });

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => e.startsWith("tier:"));
    expect(offender).toBeDefined();
    expect(offender).toContain("official"); // the declared tier
    expect(offender).toContain("community"); // the computed MIN
    expect(offender).toContain(COMPASS); // the member that pulled it down
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

// ── D1: tools + produces ─────────────────────────────────────

describe("arc#402 D1 — factory `tools:` and `produces:` at publish", () => {
  test("a factory with no `produces` is refused (publish-only: it is REQUIRED)", () => {
    const m = factoryManifest();
    delete m.produces;
    const result = validateForPublish(m, { resolveMember: resolveAllOfficial });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("produces:"))).toBe(true);
  });

  test("a non-slug `produces` is refused (shared validator)", () => {
    const result = validateForPublish(factoryManifest({ produces: "Software Factory" }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("produces"))).toBe(true);
  });

  test("a factory with no `tools` is refused (publish-only: it is REQUIRED)", () => {
    const m = factoryManifest();
    delete m.tools;
    const result = validateForPublish(m, { resolveMember: resolveAllOfficial });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("tools:"))).toBe(true);
  });

  test("an empty `tools` list is refused", () => {
    const result = validateForPublish(factoryManifest({ tools: [] }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("tools:"))).toBe(true);
  });

  test("more than 20 tools is refused (publish-only absurdity ceiling)", () => {
    const tools = Array.from({ length: 21 }, (_, i) => ({ name: `tool-${i}` }));
    const result = validateForPublish(factoryManifest({ tools }), {
      resolveMember: resolveAllOfficial,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("21") && e.includes("20"))).toBe(true);
  });

  test("a tool name that is a path or carries arguments is refused (shared validator)", () => {
    const result = validateForPublish(
      factoryManifest({ tools: [{ name: "/usr/bin/git --version" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("/usr/bin/git --version"))).toBe(true);
  });

  /**
   * SUPERSEDED at the arc#400 rebase — recorded here rather than deleted.
   *
   * arc#402's first cut called this field `min_version` and required an EXACT
   * semver floor, refusing `^1.2.0` with "a range is not a floor" — mirroring
   * the REGISTRY, which still says exactly that. #400 named the field `version`
   * and defined it as a RANGE floor in the `satisfiesRange` grammar
   * (">=2.30.0"), which is what arc actually checks a host binary against.
   *
   * #400's shape wins (the shared validator owns shape), and the old test would
   * now assert the opposite of the truth, so it is replaced by this one. The
   * arc↔registry divergence it exposes is flagged in
   * `docs/design-factory-type.md`, not silently absorbed.
   */
  test("a RANGE version floor is ACCEPTED — converged on arc#400's range-floor semantics", () => {
    const result = validateForPublish(
      factoryManifest({ tools: [{ name: "bun", version: ">=1.2.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("`tools`/`produces` on a NON-factory type are refused (shared validator)", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "x",
      produces: "software",
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("produces:"))).toBe(true);
  });

  test("`references` on a NON-composition type are refused (shared validator)", () => {
    const result = validateForPublish({
      name: "my-skill",
      version: "1.0.0",
      type: "skill",
      description: "x",
      references: [{ name: CORTEX, version: "6.1.0" }],
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("references:"))).toBe(true);
  });

  test("a `bundle` needs references but NOT tools/produces (factory-only, D1)", () => {
    const result = validateForPublish(
      {
        name: "a-bundle",
        version: "1.0.0",
        type: "bundle",
        description: "x",
        tier: "official",
        references: [{ name: CORTEX, version: "6.1.0" }],
      } as never,
      { resolveMember: resolveAllOfficial },
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
// Review round 2 (F1–F7), carried through the arc#400 rebase
// ═════════════════════════════════════════════════════════════

/**
 * F1 — the tier vocabulary is a SEAM, and a seam that accepts an unknown value
 * silently is not a seam. `minTier` ranks by index into TIER_TRUST_ORDER, so a
 * resolver returning `experimental` scored -1 and dropped out of the MIN. The
 * real resolver will wrap registry JSON, which is exactly where an
 * unrecognized string arrives from. Refuse, do not clamp.
 */
describe("arc#402 F1 — an unrecognized member tier is refused, not dropped", () => {
  test("ONE unknown tier: the member is named with its bad value, and D5 is not skipped", () => {
    const result = validateForPublish(factoryManifest({ tier: "official" }), {
      resolveMember: tableResolver({
        [CORTEX]: { name: CORTEX, version: "6.1.0", tier: "official" },
        [COMPASS]: { name: COMPASS, version: "0.9.3", tier: "experimental" as ManifestTier },
      }),
    });

    expect(result.valid).toBe(false);
    const offender = result.errors.find((e) => e.includes("experimental"));
    expect(offender).toBeDefined();
    expect(offender).toContain(COMPASS);
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
    const offender = result.errors.find((e) => e.startsWith("tier:"));
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
 * F3 — self-reference is decided on the composition's SCOPED identity.
 *
 * The original bug was a bare-name compare that falsely refused
 * `@other/software-factory` from a manifest named `software-factory`. #400's
 * reference name IS the scoped address, so the comparison is now
 * scope-inclusive by construction — these tests hold the property through the
 * shape change rather than re-finding the bug.
 */
describe("arc#402 F3 — self-reference is decided on the scoped identity", () => {
  test("the same name in a DIFFERENT scope is a different package, and is allowed", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ name: "@other/software-factory", version: "1.0.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.errors.filter((e) => /itself/i.test(e))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("a scoped self-reference matching the manifest's own namespace is refused", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [{ name: "@metafactory/software-factory", version: "1.0.0" }],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /itself/i.test(e))).toBe(true);
  });

  test("the self key is matched case-insensitively", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [{ name: "@MetaFactory/Software-Factory", version: "1.0.0" }],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /itself/i.test(e))).toBe(true);
  });
});

/**
 * F4 — reference names are validated (now by the shared validator) and the
 * duplicate/self checks are case-insensitive (still publish's, because the
 * shared duplicate check compares names verbatim while the name grammar itself
 * is case-insensitive — so a case variant slips through it).
 */
describe("arc#402 F4 — names are validated, and identity is case-insensitive", () => {
  test("a CASE-VARIANT duplicate is caught (publish-only — the shared check is verbatim)", () => {
    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: CORTEX, version: "6.1.0" },
          { name: "@MetaFactory/Cortex", version: "6.2.0" },
        ],
      }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /differ only in case/i.test(e))).toBe(true);
  });

  test("a path-shaped reference name is refused, and never reaches the resolver", () => {
    // The resolver will be a network client; a junk name must not become part
    // of a URL. Asserted, not assumed — the malformed entry is withheld using
    // the shared validator's own violation fields, not a second name grammar.
    const seen: string[] = [];
    const spy: MemberResolver = (ref) => {
      seen.push(ref.name);
      return { name: ref.name, version: ref.version, tier: "official" };
    };

    const result = validateForPublish(
      factoryManifest({
        references: [
          { name: "../../etc/passwd", version: "1.0.0" },
          { name: CORTEX, version: "6.1.0" },
        ],
      }),
      { resolveMember: spy },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("../../etc/passwd"))).toBe(true);
    expect(seen).toEqual([CORTEX]);
  });

  test("an unscoped bare name is refused without a repo: URL (shared validator)", () => {
    const result = validateForPublish(
      factoryManifest({ references: [{ name: "cortex", version: "6.1.0" }] }),
      { resolveMember: resolveAllOfficial },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("references[0].name:"))).toBe(true);
  });

  test("referenceKey lowercases and trims the scoped address", () => {
    expect(referenceKey("@MetaFactory/Cortex")).toBe("@metafactory/cortex");
    expect(referenceKey("  @metafactory/cortex  ")).toBe("@metafactory/cortex");
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
        [CORTEX]: { name: CORTEX, version: "6.1.0", tier: "official" },
        [COMPASS]: { name: COMPASS, version: "0.9.3", tier: "community" },
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
 * F7 — the pin grammar. arc#402 derived it from the registry's storage regex
 * (meta-factory `src/lib/semver.ts`); arc#400 derived it from the same source;
 * the two landed BYTE-IDENTICAL and one survives, exported by
 * `lib/composition.ts`. These assertions now guard that SHARED constant, which
 * is worth more than guarding a publish-local copy would have been.
 */
describe("arc#402 F7 — the shared pin grammar matches the registry's storage grammar", () => {
  test("arc#400 and arc#402 converged on the same regex", () => {
    expect(EXACT_PIN_RE.source).toBe(String.raw`^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$`);
  });

  test("a HYPHENATED prerelease is refused — the registry cannot store it", () => {
    // The real gap #402 found: arc's first cut was LOOSER than the registry
    // here, so it would have accepted a pin that could never resolve.
    expect(isExactVersion("1.2.3-rc-1")).toBe(false);
    expect(isExactVersion("1.2.3-rc.1")).toBe(true);
  });

  test("an empty prerelease is refused", () => {
    expect(isExactVersion("1.2.3-")).toBe(false);
  });

  test("a leading zero is ACCEPTED, deliberately — the registry stores it", () => {
    // Not a tightening. The registry's storage grammar is `\d+` per component,
    // so `1.02.3` is a version it can hold and resolve. Refusing it arc-side
    // would invent a false refusal and break the property the mirror exists
    // for: the two gates agreeing.
    expect(isExactVersion("1.02.3")).toBe(true);
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
    expect(result.computedTier).toBe("official");
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
      YAML.stringify(factoryManifest({ references: [{ name: CORTEX, version: "^6.1.0" }] })),
    );

    const result = await createBundle(dir, join(testDir, "bad.tar.gz"), {
      resolveMember: resolveAllOfficial,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("^6.1.0");
  });
});
