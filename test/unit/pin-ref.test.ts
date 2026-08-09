import { describe, test, expect } from "bun:test";
import { isSafePinRef, isSemverShapedRef, pinRefCandidates } from "../../src/lib/pin-ref.js";

describe("isSafePinRef (arc#387 injection guard)", () => {
  test.each([
    "1.2.0",
    "v1.2.0",
    "feature/x",
    "5cdaa18",
    "5cdaa18595052e23e7be39223eae8ceb072c898b",
    "v2-migration",
  ])("accepts %s", (value) => {
    expect(isSafePinRef(value)).toBe(true);
  });

  test.each(["--exec=evil", "-x", "a b", "a..b", "a\nb"])(
    "rejects %s",
    (value) => {
      expect(isSafePinRef(value)).toBe(false);
    },
  );
});

describe("isSemverShapedRef", () => {
  test.each(["1.2.0", "v1.2.0", "1.2", "6.13.4", "0.44.3"])(
    "%s is semver-shaped",
    (value) => {
      expect(isSemverShapedRef(value)).toBe(true);
    },
  );

  test.each([
    "main",
    "feature/x",
    "v2-migration",
    "5cdaa18595052e23e7be39223eae8ceb072c898b",
    "5cdaa18",
  ])("%s is not semver-shaped", (value) => {
    expect(isSemverShapedRef(value)).toBe(false);
  });
});

describe("pinRefCandidates", () => {
  test("bare semver tries v-prefixed then bare, v-first", () => {
    expect(pinRefCandidates("1.2.0")).toEqual(["v1.2.0", "1.2.0"]);
  });

  test("v-prefixed semver tries the same pair (compat: byte-identical result)", () => {
    expect(pinRefCandidates("v1.2.0")).toEqual(["v1.2.0", "1.2.0"]);
  });

  test("a branch is a single candidate, used verbatim", () => {
    expect(pinRefCandidates("feature/x")).toEqual(["feature/x"]);
  });

  test("a v-prefixed non-semver ref is NOT v-stripped (arc#387 regression guard)", () => {
    expect(pinRefCandidates("v2-migration")).toEqual(["v2-migration"]);
  });

  test("a full commit SHA is a single verbatim candidate", () => {
    const sha = "5cdaa18595052e23e7be39223eae8ceb072c898b";
    expect(pinRefCandidates(sha)).toEqual([sha]);
  });

  test("a short commit SHA is a single verbatim candidate", () => {
    expect(pinRefCandidates("5cdaa18")).toEqual(["5cdaa18"]);
  });
});
