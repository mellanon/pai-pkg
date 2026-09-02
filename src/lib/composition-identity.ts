/**
 * ONE identity for a composition member (arc#401 review, ROOT 1).
 *
 * A composition names its members twice, and the two names are not the same
 * string:
 *
 *   - the **reference label** in `references[].name` — `@metafactory/cortex`,
 *     or a bare `cortex` alongside a `repo:` URL;
 *   - the **recorded name**, which is the member's own `manifest.name` and is
 *     what lands in `skills.name`, the primary key every other command joins on.
 *
 * The first cut of arc#401 keyed `composition_members` on the LABEL. Every
 * `@scope/name` member has a label that differs from its manifest name by
 * construction, so the inventory snapshot, the purge cascade and the refcount
 * all looked up a package that was not there: `arc purge <factory>` reported
 * `untangle: CLEAN` while a fully installed member sat on disk with its config
 * intact, and a member shared under a case-variant label was deleted out from
 * under the composition that still needed it. Both were reproduced.
 *
 * ## The canonical key: scope-stripped, lowercased
 *
 * `@metafactory/compass-core`, `compass-core` and `Compass-Core` are ONE
 * member. The key is the name with any leading `@scope/` removed, trimmed and
 * lowercased.
 *
 * Stripping the scope rather than preserving it is the deliberate half.
 * `skills.name` is a PRIMARY KEY over bare manifest names, so arc physically
 * cannot hold `@a/foo` and `@b/foo` as two installed packages — the identity
 * model arc already has is the bare name, and a key that kept the scope would
 * be finer-grained than the table it exists to join against. That is precisely
 * how the label key failed: it drew a distinction `skills` does not have, then
 * looked for the result.
 *
 * Lowercasing matches the reference-name grammar, which is case-insensitive on
 * both the scoped and bare branches (`composition.ts`), and closes the
 * case-variant deletion.
 *
 * The cost, stated plainly: two DIFFERENT registry packages whose scopes differ
 * but whose names collide would canonicalise together. They already collide in
 * `skills`, so this changes nothing arc could otherwise represent — and the
 * landing check below turns a genuine mismatch into a refusal rather than a
 * silent merge.
 */

/** `@scope/name` → `name`; everything else passes through. */
const SCOPE_PREFIX_RE = /^@[^/]+\//;

/**
 * The identity two member names are THE SAME member under.
 *
 * Total and pure: safe on a label, on a manifest name, and on a value read
 * back out of the database.
 */
export function canonicalMemberKey(name: string): string {
  return name.trim().replace(SCOPE_PREFIX_RE, "").toLowerCase();
}

/** Do two member names denote the same member? */
export function sameMember(a: string, b: string): boolean {
  return canonicalMemberKey(a) === canonicalMemberKey(b);
}

/**
 * The refusal for a member that landed under a name the reference did not
 * name — a genuine mismatch, not the scoped/unscoped equivalence above.
 *
 * This is a trust event, not a bookkeeping detail. The operator approved ONE
 * combined capability review, and every line in it was attributed to a member
 * by its reference label (`composition.ts`, `formatCombinedCapabilityReview`).
 * A package that lands under a different identity is a package whose surface
 * was reviewed under someone else's name — and, downstream, a package the
 * untangle cannot find. Refusing keeps the review and the record talking about
 * the same thing.
 *
 * Returns null when the names agree canonically.
 */
export function memberIdentityRefusal(opts: {
  compositionName: string;
  label: string;
  landedName: string;
}): string | null {
  if (sameMember(opts.label, opts.landedName)) return null;
  return [
    `Refusing to continue '${opts.compositionName}': member '${opts.label}' landed as '${opts.landedName}'.`,
    `The combined capability review attributed that member's surface to '${opts.label}', and the composition record — which is what \`arc purge\` and \`arc upgrade\` walk — would key on a name nothing installed.`,
    `A scope difference is fine ('@scope/name' and 'name' are one member); a different name is not.`,
    `Fix the reference in references[] to name the package its manifest declares, or fix the manifest.`,
  ].join("\n");
}
