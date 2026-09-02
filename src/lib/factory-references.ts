/**
 * PUBLISH-SIDE composition rules (arc#402, `docs/design-factory-type.md`
 * D4/D5) — a thin LAYER over arc#400's shared validator, not a second copy of
 * it.
 *
 * ## The split, and why it is this split
 *
 * `lib/composition.ts` (`validateCompositionFields`) is the single SHAPE
 * authority for `references[]`, `tools[]` and `produces`. It runs at
 * `arc validate` and at `arc install`; this module calls it so `arc publish`
 * runs the identical gate. Every rule about what those fields may LOOK like
 * lives there and nowhere else — the exact-pin grammar included. arc#399 spent
 * a whole slice deleting three hand-copied type enums; re-typing the pin regex
 * here would have reintroduced exactly that, in the one place where a drift
 * means a package publishes and then refuses to install.
 *
 * What is left here is what only PUBLISH can know, or only publish should
 * enforce:
 *
 *   - members must EXIST. Publish freezes them forever, so an unresolvable
 *     member is fatal here.
 *   - D5's tier arithmetic AS AN ERROR. Install re-checks tier and WARNs — a
 *     member's tier can change under an already-published factory, and
 *     refusing then would strand an operator over someone else's later act.
 *     Publish is the moment the claim is minted, so publish refuses.
 *   - `tools:`/`produces:` are REQUIRED on a factory. #400 validates them only
 *     when present, because an install must tolerate a manifest published
 *     before the field existed; the registry requires both, so publish does.
 *   - a composition must have at least one member.
 *   - the targeted build-metadata explanation, the case-variant duplicate
 *     check, the revocation WARN, and the computed-tier reporting.
 *
 * ## Convergence note (arc#400 ↔ arc#402)
 *
 * Both slices derived the exact-pin grammar independently — each from the
 * registry's storage regex — and landed on the byte-identical
 * `/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/`. One survives, exported by
 * `composition.ts`. `PRODUCES_RE` likewise: #400 adopted #402's verbatim.
 * Where the two DID differ, #400's shape wins by the rule that the shared
 * validator owns shape:
 *
 *   - a reference is a scoped-name string (`@scope/name`), not `{scope, name}`;
 *   - a tool declares `version` (a RANGE floor, `>=2.30.0`) + `reason`, not
 *     `min_version` (an EXACT floor) + `justification`.
 *
 * Both of those diverge from the REGISTRY's own schema. That is a real open
 * question, recorded in `docs/design-factory-type.md` rather than silently
 * absorbed here.
 */

import { validateCompositionFields, isCompositionType } from "./composition.js";
import type { ArcManifest, PackageReference } from "../types.js";

/**
 * The manifest `tier` vocabulary, most-trusted FIRST — the ranking D5's MIN is
 * taken over.
 *
 * NOTE the drift this deliberately does not paper over: `PackageTier`
 * (src/types.ts) is the SOURCE trust level and has three values, while
 * `VALID_TIERS` (src/lib/validate-manifest.ts) is the MANIFEST tier and has
 * four — arc#317 added `core` to the manifest side only. D5 is about the
 * manifest tier, so this list is the four-value one. Reconciling the two enums
 * is a separate change with its own blast radius (`arc search --tier`,
 * `sources.yaml`); doing it inside a publish-validation slice would be exactly
 * the kind of drive-by that makes a diff unreviewable.
 */
export const TIER_TRUST_ORDER = ["core", "official", "community", "custom"] as const;

export type ManifestTier = (typeof TIER_TRUST_ORDER)[number];

/** A member as the publish-time resolver reports it. */
export interface ResolvedMember {
  name: string;
  version: string;
  tier: ManifestTier;
  /**
   * The registry has revoked this exact version. WARN, do not refuse: the
   * factory author may be publishing a refresh precisely to move off it, and
   * the harder question — what a revoked member means for an ALREADY-published
   * pin at install time — is recorded as arc#407 rather than decided here
   * (DD-108; `docs/design-factory-type.md` D4 "modulo revocations").
   */
  revoked?: boolean;
}

/**
 * Resolve one reference to the member the registry actually holds, or `null`
 * when no such published version exists.
 *
 * ## THE JUDGEMENT CALL (arc#402) — reviewed and upheld
 *
 * The tier a factory publishes at is computed from its members, so "where do
 * member tiers come from at publish time?" decides what the published tier
 * MEANS. Three candidates were on the table; the decision is that **the
 * registry entry for the pinned version is the only authority, it is injected
 * as this resolver, and with no resolver available publish REFUSES.**
 *
 *   - REJECTED — installed DB rows (`arc list`). They describe the publisher's
 *     laptop, not the release. A member may be installed at a version other
 *     than the pinned one, or installed from a local path at `tier: custom`
 *     while the published package is `official`. The factory's tier would then
 *     depend on who typed `arc publish`, which is not a trust computation.
 *   - REJECTED — skip the check when members are unresolvable. That publishes
 *     a factory whose declared tier was never checked against anything. D5
 *     says trust never averages up; not computing it averages up by omission,
 *     silently, which is the worst of the three outcomes.
 *   - CHOSEN — the registry, injected. Refuse-with-reason when absent.
 *
 * Consequence, stated plainly: until a caller wires a registry-backed
 * resolver, `arc publish` / `arc bundle` of a factory or bundle FAILS CLOSED
 * with a message saying so. That is deliberate and it matches the registry
 * counterpart, which is itself fail-closed for composition publishing until
 * meta-factory#573 maps `manifest.references[]` onto the intake envelope —
 * the two gates agree, including on what they cannot yet do. Live-registry
 * publishing of a real factory is HELD under #366 regardless.
 *
 * Note this seam has install's shape too: `lib/composition.ts` takes a
 * `ReferenceResolver` for the same reason (a trust path has to be assertable
 * without a network). They stay separate because they answer different
 * questions — install needs a member's MANIFEST, publish needs its registry
 * TIER — but they are the same idea, and #366 will likely feed both.
 */
export type MemberResolver = (ref: PackageReference) => ResolvedMember | null | undefined;

export interface FactoryCompositionOptions {
  resolveMember?: MemberResolver;
}

export interface FactoryCompositionResult {
  errors: string[];
  warnings: string[];
  /** MIN of resolved member tiers, or null when nothing resolved. */
  computedTier: ManifestTier | null;
}

// ── Publish-only constants ───────────────────────────────────

/**
 * Ceiling on `tools[]` — a factory checking more than this is not a factory.
 * Publish-only: it mirrors the registry's absurdity ceiling
 * (meta-factory#574), and an install has no business refusing a manifest the
 * registry already accepted.
 */
const MAX_FACTORY_TOOLS = 20;

/** Pull the `references[i]` index out of a shared-validator violation field. */
const REFERENCE_INDEX_RE = /^references\[(\d+)\]/;

// ── Small helpers ────────────────────────────────────────────

/**
 * The identity key two references name the same package under.
 *
 * #400's reference name is already the full scoped address (`@scope/name`), so
 * the scoping half of arc#402's original `referenceLabel` is now free — the bug
 * it fixed (a bare-name compare falsely calling `@other/software-factory` a
 * self-reference) cannot be expressed in this shape. What is still needed is
 * the LOWERCASING: `SCOPED_REF_RE` is case-insensitive, so `@metafactory/cortex`
 * and `@MetaFactory/Cortex` are both legal spellings of one package, while the
 * shared validator's duplicate check compares them verbatim.
 */
export function referenceKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The composition's OWN scoped identity, in the same space as `referenceKey`.
 * `null` when the manifest does not carry enough to form one.
 */
function selfKey(manifest: Partial<ArcManifest>): string | null {
  const name = manifest.name;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  const scope = (manifest as { namespace?: unknown }).namespace;
  return referenceKey(
    typeof scope === "string" && scope.trim().length > 0 ? `@${scope}/${name}` : name,
  );
}

/**
 * The least-trusted tier in `tiers`, or null for an empty list (D5).
 *
 * This ranks by index, so an unrecognized value would score -1 and drop
 * silently out of the MIN. That is why `isManifestTier` gates every value on
 * the way IN (see `resolveMembers`) rather than being trusted to be
 * type-correct: `ManifestTier` is erased at runtime, and the resolver that
 * feeds this will be parsing registry JSON.
 */
export function minTier(tiers: readonly ManifestTier[]): ManifestTier | null {
  let worstRank = -1;
  for (const tier of tiers) {
    const rank = TIER_TRUST_ORDER.indexOf(tier);
    if (rank > worstRank) worstRank = rank;
  }
  return worstRank === -1 ? null : TIER_TRUST_ORDER[worstRank];
}

export function isManifestTier(value: unknown): value is ManifestTier {
  return typeof value === "string" && (TIER_TRUST_ORDER as readonly string[]).includes(value);
}

/** `"core", "official", "community", "custom"` — for a refusal message. */
function tierVocabulary(): string {
  return TIER_TRUST_ORDER.map((t) => `"${t}"`).join(", ");
}

// ── The publish gate ─────────────────────────────────────────

/**
 * Validate the composition half of a manifest for PUBLISHING.
 *
 * Step 1 delegates every shape rule to `validateCompositionFields` — the same
 * function `arc validate` and `arc install` call, so the three gates cannot
 * drift. The rest adds only what publish alone enforces.
 */
export function validateFactoryComposition(
  manifest: Partial<ArcManifest>,
  options: FactoryCompositionOptions = {},
): FactoryCompositionResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. SHARED shape gate (arc#400). Owns: field placement, reference name and
  //    exact-pin grammar, exact duplicate names, tool/produces shape, and the
  //    no-own-capabilities rule. Rendered in validate-manifest's `field: rule`
  //    idiom so a publish refusal reads like an `arc validate` one.
  const shapeViolations = validateCompositionFields(manifest);
  for (const v of shapeViolations) errors.push(`${v.field}: ${v.rule}`);

  const type = typeof manifest.type === "string" ? manifest.type : undefined;
  if (!isCompositionType(type)) {
    return { errors, warnings, computedTier: null };
  }

  // 2. A factory MUST declare tools + produces (publish-only — see the module
  //    docstring). Their SHAPE, when present, was step 1's job.
  if (type === "factory") {
    errors.push(...checkFactoryDeclarationsPresent(manifest));
  }

  // 3. A composition must actually compose something. #400 leaves references
  //    optional so an install tolerates a member-less manifest without
  //    crashing; publishing one is a different act — it puts an empty promise
  //    on the registry.
  const references = Array.isArray(manifest.references) ? manifest.references : [];
  if (references.length === 0) {
    errors.push(
      `references: must name at least one member to publish a ${type} — a composition with no ` +
        `members composes nothing.`,
    );
    return { errors, warnings, computedTier: null };
  }

  errors.push(...buildMetadataNotes(references));
  errors.push(...checkCaseVariantDuplicates(references));

  // 4. Only SHAPE-VALID references reach the resolver. The resolver is a
  //    network client, and a name the shared validator already rejected has no
  //    business in a URL. Driven off step 1's violation fields rather than a
  //    second copy of the name grammar.
  const malformed = malformedReferenceIndices(shapeViolations);
  const wellFormed = references.filter((_, i) => !malformed.has(i));
  if (wellFormed.length === 0) {
    return { errors, warnings, computedTier: null };
  }

  const { resolved, resolutionErrors, resolutionWarnings } = resolveMembers(
    wellFormed,
    selfKey(manifest),
    options.resolveMember,
  );
  errors.push(...resolutionErrors);
  warnings.push(...resolutionWarnings);

  const computedTier = minTier(resolved.map((m) => m.tier));
  const { tierErrors, tierWarnings } = checkDeclaredTier(manifest.tier, computedTier, resolved);
  errors.push(...tierErrors);
  warnings.push(...tierWarnings);

  return { errors, warnings, computedTier };
}

/** A factory declares its host-tool checks and its capability, or it is not one. */
function checkFactoryDeclarationsPresent(manifest: Partial<ArcManifest>): string[] {
  const errors: string[] = [];

  if (manifest.tools === undefined) {
    errors.push(
      `tools: is required on a factory at publish — declare the host binaries the composition ` +
        `checks at install, as a list of { name, version? } entries ` +
        `(docs/design-factory-type.md D1).`,
    );
  } else if (Array.isArray(manifest.tools)) {
    if (manifest.tools.length === 0) {
      errors.push(`tools: must declare at least one host binary.`);
    } else if (manifest.tools.length > MAX_FACTORY_TOOLS) {
      errors.push(
        `tools: declares ${manifest.tools.length} binaries, exceeding the publish maximum of ` +
          `${MAX_FACTORY_TOOLS}.`,
      );
    }
  }

  if (manifest.produces === undefined) {
    errors.push(
      `produces: is required on a factory at publish — declare the capability the composition ` +
        `provides (a lowercase slug, e.g. "software").`,
    );
  }

  return errors;
}

/** Which `references[i]` did the shared validator reject? */
function malformedReferenceIndices(violations: readonly { field: string }[]): Set<number> {
  const indices = new Set<number>();
  for (const v of violations) {
    const match = REFERENCE_INDEX_RE.exec(v.field);
    if (match?.[1] !== undefined) indices.add(Number.parseInt(match[1], 10));
  }
  return indices;
}

/**
 * The shared validator already REFUSES a build-metadata pin — its grammar has
 * no `+` branch, so `1.2.3+build.5` simply fails to match. What it SAYS is the
 * generic "must be an EXACT version", and to an author whose pin looks exact
 * that reads as an arc bug. This adds the explanation, mirroring the registry's
 * targeted message (meta-factory#574 finding S2) without re-deciding anything.
 */
function buildMetadataNotes(references: readonly PackageReference[]): string[] {
  const notes: string[] = [];
  for (const ref of references) {
    if (typeof ref.version !== "string" || !ref.version.includes("+")) continue;
    notes.push(
      `references: "${ref.name}" is pinned to "${ref.version}", which carries build metadata. ` +
        `The registry does not store it, and SemVer ignores it when comparing versions ` +
        `(so "${ref.version}" does not name one release) — which is why it is not an exact pin ` +
        `even though it looks like one.`,
    );
  }
  return notes;
}

/**
 * `SCOPED_REF_RE` is case-INSENSITIVE, so `@metafactory/cortex` and
 * `@MetaFactory/Cortex` are both legal spellings of one package — while the
 * shared validator's duplicate check compares names verbatim and so sees two
 * distinct members. Publish refuses the pair.
 *
 * Only fires when the keys collide and the raw strings DIFFER; an exact
 * duplicate is step 1's to report, and reporting it twice helps nobody.
 */
function checkCaseVariantDuplicates(references: readonly PackageReference[]): string[] {
  const errors: string[] = [];
  const firstSpelling = new Map<string, string>();
  const reported = new Set<string>();
  for (const ref of references) {
    if (typeof ref.name !== "string") continue;
    const key = referenceKey(ref.name);
    const seen = firstSpelling.get(key);
    if (seen === undefined) {
      firstSpelling.set(key, ref.name);
      continue;
    }
    if (seen === ref.name || reported.has(key)) continue;
    reported.add(key);
    errors.push(
      `references: "${seen}" and "${ref.name}" differ only in case and name the same package. ` +
        `A member appears once in a composition — two pins for it make the frozen snapshot ` +
        `ambiguous.`,
    );
  }
  return errors;
}

function resolveMembers(
  references: readonly PackageReference[],
  self: string | null,
  resolveMember: MemberResolver | undefined,
): { resolved: ResolvedMember[]; resolutionErrors: string[]; resolutionWarnings: string[] } {
  const resolutionErrors: string[] = [];
  const resolutionWarnings: string[] = [];

  for (const ref of references) {
    if (self !== null && referenceKey(ref.name) === self) {
      resolutionErrors.push(
        `references: "${ref.name}" is the composition itself. A composition cannot reference ` +
          `itself.`,
      );
    }
  }

  if (!resolveMember) {
    // Refuse-with-reason, NOT skip. See the MemberResolver docstring: this is
    // the recorded judgement call, and it is the whole point of the seam.
    resolutionErrors.push(
      `references: cannot resolve this composition's members — no publish-time member resolver ` +
        `is available. arc refuses to freeze a snapshot it cannot verify rather than publish an ` +
        `unchecked one (docs/design-factory-type.md D4/D5). This is not a fault in your ` +
        `manifest: composition publishing is not wired up yet — arc#366 stocks the shelf ` +
        `arc-side, and meta-factory#573 maps references[] onto the registry's intake envelope. ` +
        `Unresolved: ` +
        references.map((r) => `${r.name}@${r.version}`).join(", ") +
        `.`,
    );
    return { resolved: [], resolutionErrors, resolutionWarnings };
  }

  const resolved: ResolvedMember[] = [];
  for (const ref of references) {
    const member = resolveMember(ref);
    if (!member) {
      resolutionErrors.push(
        `references: "${ref.name}"@${ref.version} could not be resolved at publish time — no ` +
          `such published version. A factory release freezes its members, so every reference ` +
          `must resolve before the snapshot is taken (D4).`,
      );
      continue;
    }

    // Gate the tier ON THE WAY IN. `ManifestTier` is erased at runtime, so the
    // annotation on ResolvedMember guarantees nothing about what a real
    // resolver returns, and a real resolver parses registry JSON. An
    // unrecognized value used to score -1 in `minTier` and drop silently out of
    // the MIN: one bad member weakened the check, and ALL bad members disabled
    // D5 outright while publish reported clean.
    //
    // REFUSE rather than clamp. Clamping to `custom` would invent a trust level
    // nobody declared; clamping to the member's claim would trust the very
    // string arc failed to recognize. A resolver speaking a vocabulary arc does
    // not know is a seam failure, and a seam failure is not something the
    // author can fix by editing their manifest — so it says so.
    if (!isManifestTier(member.tier)) {
      resolutionErrors.push(
        `references: "${ref.name}"@${ref.version} resolved with an unrecognized tier ` +
          `"${String(member.tier)}". A factory's tier is the MIN of its members' (D5) and arc ` +
          `cannot rank a tier it does not know, so it refuses rather than quietly dropping the ` +
          `member from the computation. Valid tiers: ${tierVocabulary()}.`,
      );
      continue;
    }
    if (member.revoked) {
      // WARN, not refuse — DD-108 publish-refresh posture.
      resolutionWarnings.push(
        `Member "${ref.name}"@${ref.version} is REVOKED in the registry. Publishing freezes a pin ` +
          `at a revoked version; prefer a released version before shipping this composition ` +
          `(DD-108, arc#407).`,
      );
    }
    resolved.push(member);
  }
  return { resolved, resolutionErrors, resolutionWarnings };
}

/**
 * D5 — declared tier may equal or under-claim the MIN, never exceed it.
 *
 * Three cases, kept distinct. A single `!isManifestTier(declared) -> return`
 * guard was written for the ABSENT case and silently swallowed the MALFORMED
 * one with it, so `tier: Official` sailed past D5 entirely — the one typo that
 * turns the check off.
 *
 *   - ABSENT: tolerated, because tier is an optional manifest field arc-wide
 *     and this slice is not the place to make it mandatory. But it WARNS with
 *     the computed value, so D5 is never silently vacuous.
 *   - MALFORMED: refused, naming the valid vocabulary.
 *   - PRESENT and valid: ranked against the MIN.
 *
 * Install's counterpart WARNs where this refuses, deliberately: a member's tier
 * can change under an already-published factory, and refusing the install then
 * would strand an operator over someone else's later act. Publish is where the
 * claim is minted, so publish is where it is refused.
 */
function checkDeclaredTier(
  declaredRaw: unknown,
  computedTier: ManifestTier | null,
  resolved: readonly ResolvedMember[],
): { tierErrors: string[]; tierWarnings: string[] } {
  const tierErrors: string[] = [];
  const tierWarnings: string[] = [];

  if (declaredRaw !== undefined && declaredRaw !== null && !isManifestTier(declaredRaw)) {
    // A non-string tier is a schema mistake; render it as JSON rather than
    // `[object Object]` so the author sees what they actually wrote.
    const shown = typeof declaredRaw === "string" ? declaredRaw : JSON.stringify(declaredRaw);
    tierErrors.push(
      `tier: "${shown}" is not a recognized tier, so D5 cannot rank it against the members' ` +
        `computed MIN. Valid tiers: ${tierVocabulary()}.`,
    );
    return { tierErrors, tierWarnings };
  }

  if (computedTier === null) return { tierErrors, tierWarnings };

  if (!isManifestTier(declaredRaw)) {
    // Absent. Say what the composition WOULD be, so the omission is visible.
    tierWarnings.push(
      `No tier declared. Computed from members, this composition's tier is "${computedTier}" ` +
        `(the MIN of its members', D5). Declare it explicitly so the manifest says what the ` +
        `registry will publish.`,
    );
    return { tierErrors, tierWarnings };
  }

  const declaredRank = TIER_TRUST_ORDER.indexOf(declaredRaw);
  const computedRank = TIER_TRUST_ORDER.indexOf(computedTier);
  if (declaredRank >= computedRank) return { tierErrors, tierWarnings };

  const weakest = resolved
    .filter((m) => m.tier === computedTier)
    .map((m) => `"${m.name}"@${m.version}`);
  tierErrors.push(
    `tier: declared "${declaredRaw}" is above the computed tier "${computedTier}". A factory's ` +
      `tier is the MIN of its members' (docs/design-factory-type.md D5) — trust never averages ` +
      `up. Least-trusted member(s) at "${computedTier}": ${weakest.join(", ")}. ` +
      `Declare "${computedTier}" or raise the member.`,
  );
  return { tierErrors, tierWarnings };
}
