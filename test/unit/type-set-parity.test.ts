import { describe, test, expect } from "bun:test";
import { ARTIFACT_TYPES } from "../../src/types.js";
import { VALID_TYPES } from "../../src/lib/validate-manifest.js";
import { INSTALLABLE_ARTIFACT_TYPES } from "../../src/lib/artifact-installer.js";
import { validateForPublish } from "../../src/lib/bundle.js";

/**
 * TYPE-ENUM PARITY across all three arc-side sites (arc#399,
 * docs/design-factory-type.md D7.1) — the successor to the arc#334
 * validator↔installer invariant, widened to include the publish validator.
 *
 * arc had THREE hand-copied type lists and they had drifted:
 *   - src/types.ts            ArtifactType          — 12 values
 *   - validate-manifest.ts    VALID_TYPES           — the same 12, copied
 *   - bundle.ts               VALID_TYPES (publish) — only 9
 *
 * The missing three (`system`, `process`, `governance`) are arc#397: types that
 * installed fine but could not be published. All three sites now DERIVE from
 * `ARTIFACT_TYPES`, so the set equalities below are true by construction. That
 * is the point — the tests are not here to catch a stale copy, they are here to
 * fail the moment someone reintroduces one.
 *
 * The publish assertions go through `validateForPublish` rather than the (now
 * private) publish-side list, so they test the BEHAVIOR arc#397 was about, not
 * the shape of a constant.
 */
describe("arc#399 — type-enum parity across all three sites", () => {
  test("validator VALID_TYPES === the source enum", () => {
    expect([...VALID_TYPES].sort()).toEqual([...ARTIFACT_TYPES].sort());
  });

  test("installer INSTALLABLE_ARTIFACT_TYPES === the source enum", () => {
    expect([...INSTALLABLE_ARTIFACT_TYPES].sort()).toEqual([...ARTIFACT_TYPES].sort());
  });

  test("validator === installer (the arc#334 invariant, still held)", () => {
    expect([...VALID_TYPES].sort()).toEqual([...INSTALLABLE_ARTIFACT_TYPES].sort());
  });

  test("every source-enum value is accepted by publish validation", () => {
    const rejected = ARTIFACT_TYPES.filter((type) => {
      const result = validateForPublish({ name: "p", version: "1.0.0", type });
      return result.errors.some((e) => e.includes("not a recognized artifact type"));
    });
    expect(rejected).toEqual([]);
  });

  test("arc#397 — system, process and governance are publishable", () => {
    for (const type of ["system", "process", "governance"] as const) {
      const result = validateForPublish({ name: "p", version: "1.0.0", type });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  test("publish still rejects a type outside the enum", () => {
    const result = validateForPublish({
      name: "p",
      version: "1.0.0",
      // `governance-overlay` is the real out-of-enum escapee in the wild
      // (design-factory-type.md E10) — it must NOT validate.
      type: "governance-overlay" as never,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not a recognized artifact type"))).toBe(true);
  });
});

describe("arc#399 — bundle and factory are manifest types (D7.2)", () => {
  test("both are in the source enum", () => {
    expect((ARTIFACT_TYPES as readonly string[]).includes("bundle")).toBe(true);
    expect((ARTIFACT_TYPES as readonly string[]).includes("factory")).toBe(true);
  });

  test("both are accepted by the strict validator and the installer set", () => {
    for (const type of ["bundle", "factory"] as const) {
      expect((VALID_TYPES as readonly string[]).includes(type)).toBe(true);
      expect((INSTALLABLE_ARTIFACT_TYPES as readonly string[]).includes(type)).toBe(true);
    }
  });

  test("both are accepted by publish validation", () => {
    for (const type of ["bundle", "factory"] as const) {
      expect(validateForPublish({ name: "p", version: "1.0.0", type }).valid).toBe(true);
    }
  });
});
