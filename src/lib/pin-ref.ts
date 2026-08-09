/**
 * Git ref grammar for `arc install --pin <ref>` (arc#387).
 *
 * Before arc#387, `--pin` accepted only a semver-shaped git tag: the value
 * was rejected by a regex before git ever ran, then resolved by trying
 * `v{x}` then `{x}` as tag names. That made it impossible to pin a commit
 * SHA, a branch, or anything in a repo with no tags at all — see arc#387
 * and the corroborating cost recorded in signal#174 (arc's `--pin` flag was
 * unusable there because the target repo had no tags, so signal minted `-rcN`
 * tags to work around it).
 *
 * `--pin <ref>` now accepts any git ref. Resolution builds a candidate list
 * and tries each with `git checkout` in order — first success wins:
 *
 * - A value matching the semver shape (`/^v?\d+\.\d+/` — today's tag
 *   convention) is tried as `[v{x}, {x}]`, `{x}` being the value with any
 *   leading `v` stripped. This is BYTE-IDENTICAL to arc's pre-#387
 *   behaviour and is a compatibility contract, not an implementation
 *   accident: a repo that tags a bare `1.2.0` (no `v`) must keep working
 *   (`test/commands/install.test.ts` — "accepts version tag without v
 *   prefix").
 * - Anything else — a branch, a full or short commit SHA, a non-semver tag
 *   — is tried as a single candidate: the value exactly as given, with no
 *   `v`-stripping and no prefixing. Unconditionally stripping a leading `v`
 *   (arc's pre-#387 behaviour) would corrupt a branch literally named e.g.
 *   `v2-migration` into `2-migration`.
 */

const SEMVER_SHAPE_RE = /^v?\d+\.\d+/;

/** Does `ref` match arc's semver-tag shape (`1.2`, `1.2.0`, `v1.2.0`, …)? */
export function isSemverShapedRef(ref: string): boolean {
  return SEMVER_SHAPE_RE.test(ref);
}

/**
 * Build the ordered list of `git checkout` candidates for a `--pin` ref,
 * per the grammar documented above. The caller tries each in order and
 * stops at the first successful checkout.
 */
export function pinRefCandidates(ref: string): string[] {
  if (isSemverShapedRef(ref)) {
    const bare = ref.startsWith("v") ? ref.slice(1) : ref;
    return [`v${bare}`, bare];
  }
  return [ref];
}

/**
 * Injection guard for a `--pin` value (arc#387). This is deliberately NOT a
 * git-refname syntax validator — git itself is the authority on what
 * refnames it accepts, and an unresolvable ref is already reported cleanly
 * by the checkout-and-report loop in `checkoutPinnedRef`. This guard exists
 * only to stop a value from being misinterpreted before it ever reaches
 * git:
 *
 * - a leading `-` would let `git checkout` parse the value as an option
 *   (e.g. `--pin --exec=evil` must not become `git checkout --exec=evil`);
 * - whitespace or an ASCII control character is never legal inside a
 *   single refname token and signals an argv-splitting mistake upstream;
 * - `..` is git range syntax (`a..b`) that `git checkout` would misread as
 *   a revision range instead of a single ref — and refnames may not
 *   contain `..` per git-check-ref-format(1) regardless.
 *
 * Everything else passes through, including a slash-namespaced branch name
 * (`feature/x`), a full 40-hex commit SHA, or a short SHA.
 */
export function isSafePinRef(value: string): boolean {
  if (value.startsWith("-")) return false;
  // Deliberately matching ASCII control characters (incl. whitespace) as
  // part of the injection guard — not a mistaken literal.
  // eslint-disable-next-line no-control-regex -- see comment above
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  if (value.includes("..")) return false;
  return true;
}
