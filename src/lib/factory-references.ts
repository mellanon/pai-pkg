/**
 * Publish-side composition rules for the reference types (arc#402,
 * `docs/design-factory-type.md` D1/D4/D5, anchor #365).
 *
 * A `factory` is a `bundle` with a job: its tarball carries no constituent
 * code, only a manifest whose `references[]` name published packages, plus
 * `tools:` (host binaries checked at install) and `produces:` (the capability
 * the composition exists to provide). Publishing one FREEZES a snapshot, so
 * this module owns the three things that make the snapshot trustworthy:
 *
 *   D4  every reference carries an EXACT version — a floating member
 *       reintroduces the integration project the type exists to delete.
 *   D5  the factory's tier is the MIN of its members' tiers. Trust never
 *       averages up, and publish is where that is enforced rather than
 *       warned about.
 *   D1  `tools:` / `produces:` are well-formed on a factory and REFUSED on
 *       anything else — a declaration nothing will read is silently ignored
 *       today and load-bearing the moment a reader is added.
 *
 * ## This file is a leaf on purpose
 *
 * It has no runtime imports. `src/types.ts` takes a TYPE-ONLY import of the
 * shapes below (erased at build), so nothing here can be caught in the
 * `types.ts` → `install-transaction` → `artifact-installer` cycle documented
 * on `src/artifact-types.ts`.
 *
 * ## Convergence with arc#400 (install side)
 *
 * `FactoryReference` and `FactoryToolRequirement` are declared MINIMALLY here
 * because publish needs them now; arc#400 owns the install-side schema for the
 * same fields and will converge on (or widen) these declarations. The shapes
 * mirror the registry's — meta-factory#574 `src/lib/manifest-validation.ts` —
 * so the two ends of the wire already agree.
 */

/**
 * One member of a composition: a published package at a pinned version.
 *
 * `scope` is optional. The registry's own reference carries `{scope, name,
 * version}` and renders `@scope/name`; arc#400's manifest schema specifies
 * `{name, version}` because an arc manifest resolves scope from the publish
 * source. Accepting both means an author can write either and the refusal
 * messages name the entry the way the author wrote it.
 */
export interface FactoryReference {
  name: string;
  version: string;
  scope?: string;
}

/** A host binary a factory checks at install time (D1). */
export interface FactoryToolRequirement {
  name: string;
  /** An EXACT semver floor. A range is not a floor — see TOOL_FLOOR below. */
  min_version?: string;
  justification?: string;
}

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
 * ## THE JUDGEMENT CALL (arc#402) — flagged for review
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
 */
export type MemberResolver = (ref: FactoryReference) => ResolvedMember | null | undefined;

export interface FactoryCompositionOptions {
  resolveMember?: MemberResolver;
}

export interface FactoryCompositionResult {
  errors: string[];
  warnings: string[];
  /** MIN of resolved member tiers, or null when nothing resolved. */
  computedTier: ManifestTier | null;
}

// ── Grammar ──────────────────────────────────────────────────

/**
 * An EXACT pin: BYTE-FOR-BYTE the registry's storage grammar, from
 * meta-factory `src/lib/semver.ts` —
 * `/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/` — read on 2026-09-02, not
 * assumed. A pin is exact when it names a version the registry can actually
 * hold, so the registry's grammar IS the definition; anything arc invents on
 * top is a place the two gates can disagree.
 *
 * Two consequences worth naming, because they point in opposite directions
 * (F7):
 *
 *   - TIGHTER than arc's first cut, which allowed a hyphen inside the
 *     prerelease (`1.2.3-rc-1`). The registry's prerelease class is
 *     `[a-zA-Z0-9.]+` with no hyphen, so arc was accepting pins that could
 *     never resolve — a real gap, now closed.
 *   - DELIBERATELY NOT tightened against leading zeros (`1.02.3`). The
 *     official SemVer 2.0.0 grammar forbids them; the registry's `\d+` does
 *     not, so `1.02.3` is a version it can store and resolve. Refusing it
 *     arc-side would invent a false refusal against a legitimately published
 *     version and break the exact property this mirror exists for. If the
 *     registry ever tightens, this follows it — that is the direction the
 *     dependency runs.
 *
 * Build metadata is excluded by construction rather than by a separate rule,
 * which is the same S2 derivation the registry made (see `isExactPin`).
 * No leading `v` — a stored registry version does not carry one.
 */
const EXACT_PIN_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/;

/**
 * A reference `name`: the grammar `arc publish` already enforces on a package
 * name (`VALID_NAME_RE`, lib/bundle.ts). Checked locally so a path-shaped or
 * otherwise junk name is refused before it is ever handed to a resolver — the
 * resolver will be a network client, and a name is not the place to find out.
 */
const REFERENCE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A reference `scope`: the BARE namespace, no `@` sigil (cf. arc#369). */
const REFERENCE_SCOPE_RE = /^[a-z0-9-]+$/;

/** `produces:` is a lowercase capability slug — `software`, `research`. */
const PRODUCES_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A `tools[].name` is a bare command name — no path, no arguments. */
const TOOL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A version floor is an exact semver. A range is not a floor.
 *
 * Deliberately NOT `EXACT_PIN_RE`: this is the version of a HOST BINARY
 * (`git 2.43.0`, `bun 1.2.0`), which the registry never stores, so the
 * registry's storage grammar has no authority over it. Real tools do ship
 * hyphenated prereleases, and refusing those would be arc inventing a rule
 * about software it does not distribute.
 */
const TOOL_FLOOR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const MAX_PRODUCES_LENGTH = 64;
const MAX_TOOL_NAME_LENGTH = 64;
/** Ceiling on `tools[]` — a factory checking more than this is not a factory. */
const MAX_FACTORY_TOOLS = 20;

/** The composition types: their tarball carries references, not code. */
const REFERENCE_COMPOSITION_TYPES = new Set(["bundle", "factory"]);

export function isReferenceComposition(type: string | undefined): boolean {
  return type !== undefined && REFERENCE_COMPOSITION_TYPES.has(type);
}

/**
 * Does `version` name exactly one published release?
 *
 * Build metadata is refused even though SemVer permits it, mirroring the
 * registry counterpart (meta-factory#574 `src/lib/factory-checks.ts`, finding
 * S2) for its two reasons, both of which hold identically arc-side: the
 * registry stores no version carrying `+build`, so such a pin can never
 * resolve; and SemVer ignores build metadata when comparing, so `1.0.0+a` and
 * `1.0.0+b` compare EQUAL and the value is not a unique pin either. arc's own
 * manifest-version grammar (bundle.ts, validate-manifest.ts) still accepts
 * build metadata — that is a different question (what a version may LOOK like)
 * from this one (what a pin may RESOLVE to), and widening it here would put
 * arc's gate out of step with the registry's.
 */
export function isExactPin(version: string): boolean {
  return EXACT_PIN_RE.test(version);
}

/** Does this version carry SemVer build metadata? */
function carriesBuildMetadata(version: string): boolean {
  return version.includes("+");
}

/** Render a reference the way its author wrote it: `@scope/name` or `name`. */
export function referenceLabel(ref: FactoryReference): string {
  return ref.scope ? `@${ref.scope}/${ref.name}` : ref.name;
}

/**
 * The identity key two references are the same package under: the scoped
 * label, lowercased.
 *
 * Both halves matter (F3/F4). SCOPED, because `@other/software-factory` is a
 * different package from `software-factory` and the self-reference check was
 * falsely refusing the former. LOWERCASED, because package names are lowercase
 * by grammar, so a case variant is the same package spelled wrong — and a
 * duplicate the author cannot see is worse than one they can.
 */
function referenceKey(ref: FactoryReference): string {
  return referenceLabel(ref).toLowerCase();
}

/** The composition's OWN identity key, in the same space as `referenceKey`. */
function selfKey(manifest: Record<string, unknown>): string | null {
  const name = manifest.name;
  if (typeof name !== "string" || name.length === 0) return null;
  const scope = manifest.namespace;
  return referenceKey({
    name,
    version: "",
    ...(typeof scope === "string" && scope.length > 0 ? { scope } : {}),
  });
}

/**
 * The least-trusted tier in `tiers`, or null for an empty list (D5).
 *
 * This ranks by index, so an unrecognized value would score -1 and drop
 * silently out of the MIN. That is why `isManifestTier` gates every value on
 * the way IN (see `resolveMembers`) rather than being trusted to be
 * type-correct: `ManifestTier` is erased at runtime and the resolver that
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── The composition gate ─────────────────────────────────────

/**
 * Validate the composition half of a manifest for publishing.
 *
 * Runs for EVERY type, not only compositions: half the contract is refusing a
 * composition field on a type that will never read it (the registry applies
 * the same discipline in `checkCompositionFieldPlacement`). Pure and
 * synchronous — resolution is injected, never performed here.
 */
export function validateFactoryComposition(
  manifest: Record<string, unknown>,
  options: FactoryCompositionOptions = {},
): FactoryCompositionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const type = typeof manifest.type === "string" ? manifest.type : undefined;

  // --- field placement: composition declarations only where they are read ---
  if (!isReferenceComposition(type)) {
    if (manifest.references !== undefined) {
      errors.push(
        `references is a composition-only field. A manifest of type "${type ?? "(none)"}" must not declare it — ` +
          `only bundle and factory carry references (docs/design-factory-type.md D1).`,
      );
    }
  }
  if (type !== "factory") {
    for (const field of ["tools", "produces"] as const) {
      if (manifest[field] !== undefined) {
        errors.push(
          `${field} is a factory-only field. A manifest of type "${type ?? "(none)"}" must not declare it — ` +
            `nothing reads it (docs/design-factory-type.md D1).`,
        );
      }
    }
  }

  if (!isReferenceComposition(type)) {
    return { errors, warnings, computedTier: null };
  }

  if (type === "factory") {
    errors.push(...validateFactoryFields(manifest));
  }

  const references = readReferences(manifest, errors);
  if (references === null) {
    return { errors, warnings, computedTier: null };
  }

  const { nameErrors, wellFormed } = checkReferenceNames(references);
  errors.push(...nameErrors);
  errors.push(...checkExactPins(references));
  errors.push(...checkDuplicates(references));

  // Only well-formed references reach the resolver. It will be a network
  // client, and "is this even a package name?" is not a question to answer
  // over the wire — nor a junk string to put in a URL.
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

/**
 * F4 — a reference name is checked against arc's own package-name grammar
 * before it goes anywhere near a resolver. The resolver is a network client;
 * "is this even a package name?" is not a question to answer over the wire.
 */
function checkReferenceNames(references: readonly FactoryReference[]): {
  nameErrors: string[];
  wellFormed: FactoryReference[];
} {
  const nameErrors: string[] = [];
  const wellFormed: FactoryReference[] = [];
  for (const ref of references) {
    let ok = true;
    if (!REFERENCE_NAME_RE.test(ref.name)) {
      ok = false;
      nameErrors.push(
        `Invalid reference name "${ref.name}". A package name is lowercase alphanumeric with ` +
          `hyphens, dots or underscores — the same grammar arc publishes names under.`,
      );
    }
    if (ref.scope !== undefined && !REFERENCE_SCOPE_RE.test(ref.scope)) {
      ok = false;
      nameErrors.push(
        `Invalid reference scope "${ref.scope}" (on "${ref.name}"). A scope is the BARE ` +
          `lowercase namespace — no "@" sigil, no slashes (arc#369).`,
      );
    }
    if (ok) wellFormed.push(ref);
  }
  return { nameErrors, wellFormed };
}

/** Read and shape-check `references[]`. Returns null when unusable. */
function readReferences(
  manifest: Record<string, unknown>,
  errors: string[],
): FactoryReference[] | null {
  const raw = manifest.references;
  if (!Array.isArray(raw)) {
    errors.push(
      `references is required for type "${String(manifest.type)}" and must be a list of ` +
        `{ name, version } entries — the composition's frozen member list (D4).`,
    );
    return null;
  }
  if (raw.length === 0) {
    errors.push(
      `references must name at least one member — a composition with no members composes nothing.`,
    );
    return null;
  }

  const refs: FactoryReference[] = [];
  let malformed = false;
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      errors.push(`references[${i}] must be an object with a "name" string.`);
      malformed = true;
      continue;
    }
    if (typeof entry.version !== "string" || entry.version.length === 0) {
      errors.push(
        `references[${i}] ("${entry.name}") must carry a "version" string — a factory release ` +
          `freezes its members at exact versions (D4).`,
      );
      malformed = true;
      continue;
    }
    refs.push({
      name: entry.name,
      version: entry.version,
      ...(typeof entry.scope === "string" && entry.scope.length > 0 ? { scope: entry.scope } : {}),
    });
  }

  return malformed && refs.length === 0 ? null : refs;
}

/** D4 — one refusal per offending entry, never one lumped message. */
function checkExactPins(references: readonly FactoryReference[]): string[] {
  const errors: string[] = [];
  for (const ref of references) {
    if (isExactPin(ref.version)) continue;
    // A build-metadata pin LOOKS exact, so "is not an exact version" would
    // read to its author as an arc bug. Say what is actually wrong with it.
    const why = carriesBuildMetadata(ref.version)
      ? `carries build metadata, which the registry does not store and which SemVer ignores when ` +
        `comparing versions (so "${ref.version}" does not name one release)`
      : `is not an exact version`;
    errors.push(
      `Reference "${referenceLabel(ref)}" is pinned to "${ref.version}", which ${why}. ` +
        `A factory release is a reproducible snapshot — every reference must carry an exact semver.`,
    );
  }
  return errors;
}

function checkDuplicates(references: readonly FactoryReference[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const ref of references) {
    // Keyed case-insensitively (F4): `cortex` and `Cortex` name one package,
    // and a duplicate the author cannot see is worse than one they can.
    const key = referenceKey(ref);
    if (seen.has(key)) {
      if (!reported.has(key)) {
        reported.add(key);
        errors.push(
          `Duplicate reference "${referenceLabel(ref)}". A member appears once in a composition — ` +
            `two pins for the same member make the frozen snapshot ambiguous.`,
        );
      }
      continue;
    }
    seen.add(key);
  }
  return errors;
}

function resolveMembers(
  references: readonly FactoryReference[],
  self: string | null,
  resolveMember: MemberResolver | undefined,
): { resolved: ResolvedMember[]; resolutionErrors: string[]; resolutionWarnings: string[] } {
  const resolutionErrors: string[] = [];
  const resolutionWarnings: string[] = [];

  for (const ref of references) {
    // Compared on the SCOPED key (F3). Bare-name comparison falsely refused
    // `@other/software-factory` from a manifest named `software-factory` —
    // a different package that happens to share a name.
    if (self !== null && referenceKey(ref) === self) {
      resolutionErrors.push(
        `Reference "${referenceLabel(ref)}" is the composition itself. A composition cannot ` +
          `reference itself.`,
      );
    }
  }

  if (!resolveMember) {
    // Refuse-with-reason, NOT skip. See the MemberResolver docstring: this is
    // the recorded judgement call, and it is the whole point of the seam.
    resolutionErrors.push(
      `Cannot resolve this composition's members: no publish-time member resolver is available. ` +
        `arc refuses to freeze a snapshot it cannot verify rather than publish an unchecked one ` +
        `(docs/design-factory-type.md D4/D5). This is not a fault in your manifest — composition ` +
        `publishing is not wired up yet: arc#366 stocks the shelf arc-side, and meta-factory#573 ` +
        `maps references[] onto the registry's intake envelope. Unresolved: ` +
        references.map((r) => `${referenceLabel(r)}@${r.version}`).join(", ") +
        `.`,
    );
    return { resolved: [], resolutionErrors, resolutionWarnings };
  }

  const resolved: ResolvedMember[] = [];
  for (const ref of references) {
    const member = resolveMember(ref);
    if (!member) {
      resolutionErrors.push(
        `Reference "${referenceLabel(ref)}"@${ref.version} could not be resolved at publish time — ` +
          `no such published version. A factory release freezes its members, so every reference ` +
          `must resolve before the snapshot is taken (D4).`,
      );
      continue;
    }
    // F1 — gate the tier ON THE WAY IN. `ManifestTier` is erased at runtime,
    // so the type annotation on ResolvedMember guarantees nothing about what a
    // real resolver returns, and a real resolver parses registry JSON. An
    // unrecognized value used to score -1 in `minTier` and drop silently out of
    // the MIN: one bad member weakened the check, and ALL bad members disabled
    // D5 outright while publish reported clean.
    //
    // REFUSE rather than clamp. Clamping to `custom` would invent a trust level
    // nobody declared; clamping to the member's claim would trust the very
    // string we failed to recognize. A resolver speaking a vocabulary arc does
    // not know is a seam failure, and a seam failure is not a package the
    // author can fix by editing their manifest — so it says so.
    if (!isManifestTier(member.tier)) {
      resolutionErrors.push(
        `Member "${referenceLabel(ref)}"@${ref.version} resolved with an unrecognized tier ` +
          `"${String(member.tier)}". A factory's tier is the MIN of its members' (D5) and arc ` +
          `cannot rank a tier it does not know, so it refuses rather than quietly dropping the ` +
          `member from the computation. Valid tiers: ${tierVocabulary()}.`,
      );
      continue;
    }
    if (member.revoked) {
      // WARN, not refuse — DD-108 publish-refresh posture.
      resolutionWarnings.push(
        `Member "${referenceLabel(ref)}"@${ref.version} is REVOKED in the registry. Publishing ` +
          `freezes a pin at a revoked version; prefer a released version before shipping this ` +
          `composition (DD-108).`,
      );
    }
    resolved.push(member);
  }
  return { resolved, resolutionErrors, resolutionWarnings };
}

/**
 * D5 — declared tier may equal or under-claim the MIN, never exceed it.
 *
 * Three cases, kept distinct (F2/F6). The original single
 * `!isManifestTier(declared) -> return` guard was written for the ABSENT case
 * and silently swallowed the MALFORMED one with it, so `tier: Official` sailed
 * past D5 entirely — the one typo that turns the check off.
 *
 *   - ABSENT: tolerated, because tier is an optional manifest field arc-wide
 *     and this slice is not the place to make it mandatory. But it WARNS with
 *     the computed value, so D5 is never silently vacuous (F6).
 *   - MALFORMED: refused, naming the valid vocabulary.
 *   - PRESENT and valid: ranked against the MIN as before.
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
      `Declared tier "${shown}" is not a recognized tier, so D5 cannot rank it ` +
        `against the members' computed MIN. Valid tiers: ${tierVocabulary()}.`,
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
    `Declared tier "${declaredRaw}" is above the computed tier "${computedTier}". A factory's tier ` +
      `is the MIN of its members' (docs/design-factory-type.md D5) — trust never averages up. ` +
      `Least-trusted member(s) at "${computedTier}": ${weakest.join(", ")}. ` +
      `Declare "${computedTier}" or raise the member.`,
  );
  return { tierErrors, tierWarnings };
}

// ── D1: tools + produces ─────────────────────────────────────

/**
 * The two declarations a factory owns. Mirrors the registry's
 * `validateFactoryFields` (meta-factory#574) field for field, so a manifest
 * that clears arc's publish gate clears the registry's intake for the same
 * reasons — the failure mode being designed out is arc accepting a manifest
 * the registry then rejects with a different vocabulary.
 */
function validateFactoryFields(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];

  const produces = manifest.produces;
  if (typeof produces !== "string" || produces.length === 0) {
    errors.push(
      `produces is required on a factory — declare the capability the composition provides ` +
        `(a lowercase slug, e.g. "software").`,
    );
  } else if (produces.length > MAX_PRODUCES_LENGTH) {
    errors.push(
      `produces must be ${MAX_PRODUCES_LENGTH} characters or fewer (got ${produces.length}).`,
    );
  } else if (!PRODUCES_RE.test(produces)) {
    errors.push(
      `Invalid produces "${produces}". Must be a lowercase slug (alphanumeric + hyphens), e.g. "software".`,
    );
  }

  const tools = manifest.tools;
  if (!Array.isArray(tools)) {
    errors.push(
      `tools is required on a factory — declare the host binaries checked at install as a list of ` +
        `{ name, min_version? } entries.`,
    );
    return errors;
  }
  if (tools.length === 0) {
    errors.push(`tools must declare at least one host binary.`);
  }
  if (tools.length > MAX_FACTORY_TOOLS) {
    errors.push(
      `tools declares ${tools.length} binaries, exceeding the maximum of ${MAX_FACTORY_TOOLS}.`,
    );
  }

  const seen = new Set<string>();
  for (let i = 0; i < tools.length; i++) {
    const entry: unknown = tools[i];
    const prefix = `tools[${i}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object with a name.`);
      continue;
    }
    const name = entry.name;
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${prefix}.name must be a string — a bare command, e.g. "git".`);
    } else if (name.length > MAX_TOOL_NAME_LENGTH) {
      errors.push(
        `${prefix}.name must be ${MAX_TOOL_NAME_LENGTH} characters or fewer (got ${name.length}).`,
      );
    } else if (!TOOL_NAME_RE.test(name)) {
      errors.push(
        `Invalid tool name "${name}" (${prefix}.name). Must be a bare lowercase command name — ` +
          `no path, no arguments.`,
      );
    } else if (seen.has(name)) {
      errors.push(`Duplicate tool "${name}" (${prefix}.name). Declare each host binary once.`);
    } else {
      seen.add(name);
    }

    if (entry.min_version !== undefined) {
      const floor: unknown = entry.min_version;
      if (typeof floor !== "string" || !TOOL_FLOOR_RE.test(floor)) {
        // A non-string floor is a schema mistake; render it as JSON rather than
        // `[object Object]` so the author can see what they actually wrote.
        const shown = typeof floor === "string" ? floor : JSON.stringify(floor);
        errors.push(
          `Invalid min_version "${shown}" (${prefix}.min_version). A version floor is an ` +
            `exact semver (major.minor.patch) — a range is not a floor.`,
        );
      }
    }
  }

  return errors;
}
