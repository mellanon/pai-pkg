/**
 * Reference-composition install: `type: bundle` / `type: factory` (arc#400,
 * `docs/design-factory-type.md` D2/D4/D5).
 *
 * Slice 1 (arc#399) taught arc's type vocabulary about the composition types;
 * a composition manifest loaded, validated and installed as a manifest-only
 * no-op. This module is slice 2: it resolves `references[]`, computes ONE
 * combined capability surface from the resolved members, and refuses — loudly,
 * and BEFORE anything lands — when the composition cannot be trusted.
 *
 * ## Why this module owns no git, no network, and no database
 *
 * Everything here is either pure or driven through an injected seam
 * (`ReferenceResolver`, `ToolProbe`, `CompositionConfirm`, `MemberInstaller`).
 * Two reasons, both load-bearing:
 *
 *   1. This is the TRUST PATH. Every refusal in arc#400's acceptance criteria
 *      is a behaviour an adversary would like to skip, so each one has to be
 *      assertable without a network, a registry, or a real clone. A seam is
 *      what makes "the resolver was never called" a testable claim rather than
 *      a comment.
 *   2. `src/commands/install.ts` imports this module. If this module imported
 *      `install()` back — which a built-in `MemberInstaller` default would
 *      require — the two would form an import cycle. The seams have no
 *      defaults ON PURPOSE; install.ts constructs them (see
 *      `defaultCompositionSeams` there) and this module stays a leaf.
 *
 * ## Order of operations, and why it is this order (D2)
 *
 *   validate manifest → check `tools:` → resolve every reference → aggregate →
 *   ONE confirmation → install members
 *
 * Validation is first because it is free and catches the authoring mistakes
 * (a range pin, a typo'd key). `tools:` is next because a host missing `gh` is
 * a fact about the machine, knowable before a single byte is fetched — the
 * issue's "tools: check before anything" means before resolution, and
 * resolution is the first step that touches the network. Only then are
 * references resolved, and only after EVERY member has resolved and validated
 * is the operator asked anything. A member manifest that fails validation
 * aborts the whole install before any member lands (D2's honesty rule) — which
 * is only possible because resolution and installation are separate phases.
 */

import type {
  ArcManifest,
  PackageReference,
  PackageTier,
  RiskLevel,
  ToolRequirement,
} from "../types.js";
import { BASH_UNRESTRICTED, capabilityRows } from "./db.js";
import { canonicalMemberKey } from "./composition-identity.js";
import { PURGEABLE_OWNS_CLASSES, ownsEntriesOverlap } from "./owns.js";
import { satisfiesRange } from "./semver.js";
import type { Violation } from "./validate-manifest.js";

export type { PackageReference, ToolRequirement };

// ───────────────────────────────────────────────────────────────────────────
// The composition types
// ───────────────────────────────────────────────────────────────────────────

/**
 * The REFERENCE-composition types (`docs/design-factory-type.md` D1).
 *
 * `library` is deliberately absent: it is a composition too, but of the other
 * kind — one tarball with N artifacts inside it, walked by `readManifest`.
 * These two carry no payload at all; their members are named, published
 * packages resolved at install.
 */
export const COMPOSITION_TYPES = ["bundle", "factory"] as const;
export type CompositionType = (typeof COMPOSITION_TYPES)[number];

export function isCompositionType(type: string | undefined): type is CompositionType {
  return type === "bundle" || type === "factory";
}

// ───────────────────────────────────────────────────────────────────────────
// The schema additions: references[], tools[], produces
// ───────────────────────────────────────────────────────────────────────────

/**
 * An EXACT pin: BYTE-FOR-BYTE the registry's storage grammar, from
 * meta-factory `src/lib/semver.ts` — `/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/`
 * — read on 2026-09-02, not assumed.
 *
 * A pin is "exact" when it names a version the registry can actually HOLD, so
 * the registry's grammar IS the definition; anything arc invents on top is a
 * place the two gates can disagree. Two consequences, pointing in opposite
 * directions, and both deliberate:
 *
 *   - TIGHTER than arc's first cut, which allowed a hyphen inside the
 *     prerelease (`1.2.3-rc-1`). The registry's prerelease class is
 *     `[a-zA-Z0-9.]+` with no hyphen, so arc was accepting pins that could
 *     never resolve.
 *   - DELIBERATELY NOT tightened against leading zeros (`1.02.3`). SemVer 2.0.0
 *     forbids them; the registry's `\d+` does not, so `1.02.3` is a version it
 *     can store and resolve. Refusing it arc-side would be a false refusal
 *     against a legitimately published version and would break the exactness
 *     property this mirror exists for. If the registry tightens, this follows —
 *     that is the direction the dependency runs.
 *
 * Build metadata is excluded by construction rather than by a separate rule
 * (the registry made the same derivation): a `+build` suffix simply has nowhere
 * to match. No leading `v` — a stored registry version does not carry one.
 *
 * ## Shared with the publish side (arc#402)
 *
 * arc#402 enforces the same rule at `arc publish` and rebases onto this module
 * as the single shape authority, so this constant is EXPORTED rather than
 * copied. A second literal is exactly the drift arc#399 spent a slice deleting
 * from the type enum; the pin grammar is not going to reintroduce it.
 */
export const EXACT_PIN_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/;

/** Is `value` an exact pin (D4)? Ranges, X-ranges and `latest` are not. */
export function isExactVersion(value: unknown): boolean {
  return typeof value === "string" && EXACT_PIN_RE.test(value.trim());
}

/** `@scope/name` — the registry addressing form arc already uses. */
const SCOPED_REF_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
/** A bare package name, only legal alongside a `repo:` URL. */
const BARE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
/**
 * A bare binary name. No path separator, no whitespace, no leading dash — the
 * value reaches a binary lookup, so the same argv-safety posture as
 * `isSafePinRef` applies.
 *
 * Case-INSENSITIVE, unlike arc#402's publish-side copy: this names a host
 * binary, not a registry package, and mixed-case binaries exist on real PATHs.
 * Flagged for the rebase — publish may legitimately be stricter about what it
 * will let an author ship, but install must not refuse a binary the host has.
 */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `produces:` is a lowercase capability slug — `software`, `research`. Same
 * grammar and ceiling as arc#402's publish-side check, so a factory that
 * validates here publishes there.
 */
const PRODUCES_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_PRODUCES_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the composition-specific manifest fields: `references[]`, `tools[]`
 * and `produces`.
 *
 * Pure and total, in `validate-manifest.ts`'s idiom: it collects EVERY
 * violation rather than throwing on the first, so an author fixes the whole
 * manifest in one pass. Called from BOTH ends of the contract — `arc validate`
 * (through `validateStrictManifest`) and `arc install` — because D4 says exact
 * pins are re-checked at install, not only at publish. The two gates share this
 * one function so they can never drift into disagreeing about the same
 * manifest, which is the failure arc#399 spent a slice closing.
 */
export function validateCompositionFields(manifest: unknown): Violation[] {
  const violations: Violation[] = [];
  const add = (field: string, rule: string) => violations.push({ field, rule });
  if (!isRecord(manifest)) return violations;

  const type = typeof manifest.type === "string" ? manifest.type : undefined;
  const composition = isCompositionType(type);

  validateReferences(manifest.references, composition, add);
  validateTools(manifest.tools, type, add);
  validateProduces(manifest.produces, type, add);
  validateNoOwnCapabilities(manifest.capabilities, composition, add);

  return violations;
}

/**
 * A composition declares NO capability block of its own (arc#400 review, S2).
 *
 * arc#399 made the block OPTIONAL for `bundle`/`factory`; this makes declaring
 * one an error. The doctrine is the same one that motivated the exemption, taken
 * to its conclusion: a composition ships no code, so it has no surface to
 * declare, and its real surface is the UNION of its members', computed at
 * install and shown in one review (D2). A composition that ALSO declares a
 * block creates two answers to "what can this do" — the declared one and the
 * computed one — and the declared one is the one an operator reads in the repo
 * while the computed one is the one that governs. That gap is worth more as a
 * refusal than as a validated-in-full nicety, and it matches the registry's own
 * gate (meta-factory PR #574 §8).
 *
 * This supersedes arc#399's "the exemption covers PRESENCE only; a composition
 * that DOES declare a block has it validated in full" — see the note on
 * `validateCapabilities` in validate-manifest.ts, which now defers here.
 */
function validateNoOwnCapabilities(capabilities: unknown, composition: boolean, add: Add): void {
  if (!composition || capabilities === undefined || capabilities === null) return;
  add(
    "capabilities",
    "must not be declared on a reference-composition — a composition ships no code of its own, so its surface is the UNION of its members', computed at install and shown in one combined review (docs/design-factory-type.md D2). Remove the block.",
  );
}

type Add = (field: string, rule: string) => void;

function validateReferences(references: unknown, composition: boolean, add: Add): void {
  if (references === undefined) return; // optional — a composition may declare none
  if (!composition) {
    add(
      "references",
      `is only valid on the reference-composition types (${COMPOSITION_TYPES.join(" | ")}) — a package that ships a payload names its dependencies in depends_on (docs/design-factory-type.md D1)`,
    );
    return;
  }
  if (!Array.isArray(references)) {
    add("references", `must be an array of { name, version } entries; got ${typeof references}`);
    return;
  }

  // Canonical key → the FIRST label that claimed it, so a duplicate can name
  // both spellings rather than only the one it tripped over.
  const seenByKey = new Map<string, string>();
  references.forEach((entry, i) => {
    if (!isRecord(entry)) {
      add(`references[${i}]`, `must be a { name, version } object; got ${JSON.stringify(entry)}`);
      return;
    }

    const extra = Object.keys(entry).filter((k) => k !== "name" && k !== "version" && k !== "repo");
    if (extra.length > 0) {
      // A typo'd key on the trust path is how a pin silently becomes absent.
      add(`references[${i}]`, `may only declare 'name', 'version' and 'repo'; unexpected key(s): ${extra.join(", ")}`);
    }

    const name = entry.name;
    if (!isNonEmptyString(name)) {
      add(`references[${i}].name`, "is required and names the member package");
    } else if (isNonEmptyString(entry.repo)) {
      if (!BARE_NAME_RE.test(name) && !SCOPED_REF_RE.test(name)) {
        add(`references[${i}].name`, `must be a package name; got ${JSON.stringify(name)}`);
      }
    } else if (!SCOPED_REF_RE.test(name)) {
      // No repo URL ⇒ the member must be addressable in the registry, and the
      // registry's address is scoped. A bare name would need arc to guess a
      // source, and a guess on the trust path is how the wrong package lands.
      add(
        `references[${i}].name`,
        `must be a scoped registry reference '@scope/name' (or carry a 'repo:' URL); got ${JSON.stringify(name)}`,
      );
    }

    // Duplicate detection keys on the CANONICAL member key, not the literal
    // string (arc#401 review, F10). `@a/dup` and `dup` are two labels for ONE
    // member — `skills.name` cannot hold both, and `composition_members` is
    // keyed on the landed name — so a verbatim check let them through
    // validation, through resolution, through landing, and into a PRIMARY KEY
    // collision: an uncaught SQLiteError on the trust path, with the first
    // member already installed and a `pending` record behind it. A refusal is
    // the only acceptable outcome, and it names BOTH labels because the author
    // is looking at two lines that do not obviously say the same thing.
    if (isNonEmptyString(name)) {
      const key = canonicalMemberKey(name);
      const first = seenByKey.get(key);
      if (first === name) {
        // The literal repeat. Kept verbatim: arc#402's publish side asserts
        // this vocabulary as the shared validator's contract, and an author
        // looking at two identical lines needs no explanation of why.
        add(`references[${i}].name`, `is declared more than once: ${JSON.stringify(name)}`);
      } else if (first !== undefined) {
        // Two SPELLINGS of one member — the case F10 found. Worth its own
        // message, because the author is looking at two lines that do not
        // obviously say the same thing, so "declared more than once" would read
        // as a false positive and get worked around.
        add(
          `references[${i}].name`,
          `names the same member as ${JSON.stringify(first)}: ${JSON.stringify(name)} — scope and case do not distinguish members ` +
            `('@scope/name' and 'name' are one package, and arc can install only one of them), so both entries resolve to a single install. Keep one.`,
        );
      } else {
        seenByKey.set(key, name);
      }
    }

    const version = entry.version;
    if (version === undefined) {
      add(
        `references[${i}].version`,
        "is required and must be an EXACT version — a factory release is a reproducible snapshot (docs/design-factory-type.md D4)",
      );
    } else if (!isExactVersion(version)) {
      add(
        `references[${i}].version`,
        `must be an EXACT version (major.minor.patch), never a range — a floating member reintroduces the integration project the type exists to delete (docs/design-factory-type.md D4); got ${JSON.stringify(version)}`,
      );
    }

    if (entry.repo !== undefined && !isNonEmptyString(entry.repo)) {
      add(`references[${i}].repo`, "must be a non-empty git URL when present");
    }
  });
}

function validateTools(tools: unknown, type: string | undefined, add: Add): void {
  if (tools === undefined) return;
  if (type !== "factory") {
    add(
      "tools",
      "is factory-only — a bundle is the plain reference-composition; the host-binary check is what a factory adds (docs/design-factory-type.md D1)",
    );
    return;
  }
  if (!Array.isArray(tools)) {
    add("tools", `must be an array of { name, version? } entries; got ${typeof tools}`);
    return;
  }
  tools.forEach((entry, i) => {
    if (!isRecord(entry)) {
      add(`tools[${i}]`, `must be a { name, version? } object; got ${JSON.stringify(entry)}`);
      return;
    }
    const extra = Object.keys(entry).filter((k) => k !== "name" && k !== "version" && k !== "reason");
    if (extra.length > 0) {
      add(`tools[${i}]`, `may only declare 'name', 'version' and 'reason'; unexpected key(s): ${extra.join(", ")}`);
    }
    if (!isNonEmptyString(entry.name) || !TOOL_NAME_RE.test(entry.name)) {
      add(
        `tools[${i}].name`,
        `must be a bare binary name (no path, no whitespace, no leading dash) — the value reaches a binary lookup; got ${JSON.stringify(entry.name)}`,
      );
    }
    if (entry.version !== undefined && !isNonEmptyString(entry.version)) {
      add(`tools[${i}].version`, "must be a non-empty version floor when present (e.g. '>=2.30.0')");
    }
  });
}

function validateProduces(produces: unknown, type: string | undefined, add: Add): void {
  if (produces === undefined) return;
  if (type !== "factory") {
    add(
      "produces",
      "is factory-only — it declares the capability the composition exists to provide (docs/design-factory-type.md D1)",
    );
    return;
  }
  const values = Array.isArray(produces) ? produces : [produces];
  if (values.length === 0) {
    add("produces", "must name at least one capability slug");
    return;
  }
  for (const value of values) {
    if (!isNonEmptyString(value) || !PRODUCES_RE.test(value) || value.length > MAX_PRODUCES_LENGTH) {
      add(
        "produces",
        `must be a lowercase capability slug (^[a-z0-9][a-z0-9-]*$, max ${MAX_PRODUCES_LENGTH} chars) — e.g. 'software'; got ${JSON.stringify(value)}`,
      );
    }
  }
}

/** The composition's members, typed. Assumes the manifest already validated. */
export function readCompositionReferences(manifest: ArcManifest): PackageReference[] {
  const refs = manifest.references;
  if (!Array.isArray(refs)) return [];
  return refs.map((r) => ({
    name: r.name,
    version: r.version,
    ...(r.repo ? { repo: r.repo } : {}),
  }));
}

/** The composition's host-binary requirements, typed. */
export function readCompositionTools(manifest: ArcManifest): ToolRequirement[] {
  const tools = manifest.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => ({
    name: t.name,
    ...(t.version ? { version: t.version } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// The tools: gate
// ───────────────────────────────────────────────────────────────────────────

/** What a host-binary lookup reports back. */
export interface ToolProbeResult {
  found: boolean;
  path?: string;
  /** The binary's own version, when it could be read AND parsed. */
  version?: string;
}

/** Injected host-binary lookup. install.ts supplies the real one. */
export type ToolProbe = (name: string) => ToolProbeResult;

export interface ToolCheckResult {
  ok: boolean;
  /** Binaries that are not on PATH at all, in declaration order. */
  missing: string[];
  /** Binaries present but below their declared floor. */
  belowFloor: { name: string; found: string; required: string }[];
  /** Non-fatal notes (an unreadable version — see the fail-open rationale). */
  warnings: string[];
  error?: string;
}

/**
 * Check a factory's declared `tools:` against the host, BEFORE any reference
 * is resolved (D1/D8; arc#400 "tools: check before anything").
 *
 * Every miss is collected and named in ONE message rather than failing at the
 * first: an operator on a fresh machine is usually missing several, and a gate
 * that reveals them one `arc install` at a time is a gate that gets worked
 * around.
 *
 * Fail-open on an UNREADABLE version, closed on a readable one below the floor.
 * That split matches `semver.ts`'s documented posture: refusing an install
 * because a binary printed its version in a shape this code did not anticipate
 * would be a false refusal, and false refusals on a security gate teach
 * operators to reach for `--yes`. A version arc CAN read and that IS too old is
 * a fact, and is refused.
 */
export function checkTools(
  tools: ToolRequirement[] | undefined,
  probe: ToolProbe,
): ToolCheckResult {
  const missing: string[] = [];
  const belowFloor: { name: string; found: string; required: string }[] = [];
  const warnings: string[] = [];

  for (const tool of tools ?? []) {
    const result = probe(tool.name);
    if (!result.found) {
      missing.push(tool.name);
      continue;
    }
    if (!tool.version) continue;
    if (!result.version) {
      warnings.push(
        `arc: WARN — could not read a version from '${tool.name}' to check the declared floor ${tool.version}; proceeding.`,
      );
      continue;
    }
    if (!satisfiesRange(result.version, tool.version)) {
      belowFloor.push({ name: tool.name, found: result.version, required: tool.version });
    }
  }

  if (missing.length === 0 && belowFloor.length === 0) {
    return { ok: true, missing, belowFloor, warnings };
  }

  const lines: string[] = ["Refusing to install: the composition's declared tools are not satisfied on this host."];
  for (const name of missing) {
    const reason = (tools ?? []).find((t) => t.name === name)?.reason;
    lines.push(`  ✗ ${name} — not found on PATH${reason ? ` (needed for: ${reason})` : ""}`);
  }
  for (const entry of belowFloor) {
    lines.push(`  ✗ ${entry.name} — found ${entry.found}, requires ${entry.required}`);
  }
  lines.push("Nothing was installed. Install the missing tools and re-run.");

  return { ok: false, missing, belowFloor, warnings, error: lines.join("\n") };
}

// ───────────────────────────────────────────────────────────────────────────
// D2 — the combined capability surface
// ───────────────────────────────────────────────────────────────────────────

/** A resolved member, reduced to what the capability review needs. */
export interface CompositionMemberSurface {
  name: string;
  version: string;
  tier: PackageTier;
  manifest: ArcManifest;
}

/** One deduped capability, carrying the members that asked for it. */
export interface AttributedCapability {
  value: string;
  /** Every member declaring it, in composition order. */
  members: string[];
  /** The members' reasons, joined — empty when none declared one. */
  reason: string;
}

/** The union of the members' capability surfaces (D2's aggregation rules). */
export interface CombinedCapabilitySurface {
  read: AttributedCapability[];
  write: AttributedCapability[];
  network: AttributedCapability[];
  bash: {
    /** OR across members. */
    allowed: boolean;
    /** True when ANY member has bash with no restriction — infects the whole surface. */
    unrestricted: boolean;
    /** The members responsible for that, named so the flag is actionable. */
    unrestrictedMembers: string[];
    /** Union of every member's `restricted_to` list. */
    restricted: AttributedCapability[];
  };
  secrets: AttributedCapability[];
  /** Risk of the UNION — see `combinedRisk`. */
  risk: RiskLevel;
}

/** Accumulate deduped, attributed entries while preserving first-seen order. */
class Attributor {
  private readonly order: string[] = [];
  private readonly byValue = new Map<string, { members: string[]; reasons: string[] }>();

  add(value: string, member: string, reason: string): void {
    let entry = this.byValue.get(value);
    if (!entry) {
      entry = { members: [], reasons: [] };
      this.byValue.set(value, entry);
      this.order.push(value);
    }
    if (!entry.members.includes(member)) entry.members.push(member);
    if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason);
  }

  entries(): AttributedCapability[] {
    const out: AttributedCapability[] = [];
    for (const value of this.order) {
      const entry = this.byValue.get(value);
      // `order` and `byValue` are written together in add(), so this is
      // unreachable — narrowed rather than asserted so the invariant is
      // enforced by the compiler instead of promised in a comment.
      if (!entry) continue;
      out.push({ value, members: entry.members, reason: entry.reasons.join("; ") });
    }
    return out;
  }
}

/**
 * Compute the composition's combined capability surface (D2).
 *
 * Reads each member through `capabilityRows()` — the SAME walk `recordInstall`
 * and `arc audit` use — rather than re-reading `manifest.capabilities` here.
 * That is deliberate: `capabilityRows` is where arc#403 made unrestricted bash
 * a first-class row carrying the `(unrestricted)` sentinel instead of an absent
 * row, and re-deriving the surface from the raw manifest would quietly opt the
 * composition review out of that fix. Reading through the same walk means the
 * review shows what arc will RECORD, not a parallel opinion of it.
 *
 * Aggregation, per D2:
 *   - filesystem read/write: union, deduped, attributed to every member.
 *   - network: union, deduped; the members' reasons are joined, not dropped.
 *   - bash: `allowed` is OR; `restricted_to` is the union; ANY member with
 *     unrestricted bash marks the whole surface unrestricted, and is FLAGGED.
 *   - secrets: union, each attributed to its member.
 */
export function aggregateCapabilities(
  members: CompositionMemberSurface[],
): CombinedCapabilitySurface {
  const read = new Attributor();
  const write = new Attributor();
  const network = new Attributor();
  const restricted = new Attributor();
  const secrets = new Attributor();

  let allowed = false;
  const unrestrictedMembers: string[] = [];

  for (const member of members) {
    for (const row of capabilityRows(member.manifest)) {
      switch (row.type) {
        case "fs_read":
          read.add(row.value, member.name, row.reason);
          break;
        case "fs_write":
          write.add(row.value, member.name, row.reason);
          break;
        case "network":
          network.add(row.value, member.name, row.reason);
          break;
        case "bash":
          allowed = true;
          if (row.value === BASH_UNRESTRICTED) {
            if (!unrestrictedMembers.includes(member.name)) unrestrictedMembers.push(member.name);
          } else {
            restricted.add(row.value, member.name, row.reason);
          }
          break;
        case "secret":
          secrets.add(row.value, member.name, row.reason);
          break;
      }
    }
  }

  const surface: CombinedCapabilitySurface = {
    read: read.entries(),
    write: write.entries(),
    network: network.entries(),
    bash: {
      allowed,
      unrestricted: unrestrictedMembers.length > 0,
      unrestrictedMembers,
      restricted: restricted.entries(),
    },
    secrets: secrets.entries(),
    risk: "low",
  };
  surface.risk = combinedRisk(surface);
  return surface;
}

/**
 * Risk of the COMBINED surface, by `assessRisk`'s rules applied to the union.
 *
 * The distinction matters and is the whole reason D2 asks for one review: two
 * members that are each individually MEDIUM — one with network, one with
 * filesystem write — compose into a HIGH download-and-write surface that
 * neither member's own risk line would ever show. `arc audit` has made this
 * argument across installed skills since E9; a composition is the same argument
 * at install time, before the operator has agreed to anything.
 */
export function combinedRisk(surface: CombinedCapabilitySurface): RiskLevel {
  const hasNetwork = surface.network.length > 0;
  const hasWrite = surface.write.length > 0;
  const hasSecrets = surface.secrets.length > 0;

  if (hasNetwork && hasWrite) return "high";
  if (hasSecrets && hasNetwork) return "high";
  if (hasNetwork) return "medium";
  if (hasSecrets) return "medium";
  if (surface.bash.unrestricted) return "medium";
  return "low";
}

/**
 * Render the ONE combined capability review (D2's honesty rule).
 *
 * Reuses the fresh-install display conventions verbatim — the same 🟢/🟡/🔴
 * markers and `Read:`/`Write:`/`Network:`/`Bash:`/`Secret:` labels
 * `formatCapabilities` prints, and the same `Risk:` line install.ts prints
 * under them — so an operator reads a composition review with the vocabulary
 * a single-package install already taught them. What is ADDED is attribution:
 * every line names the member(s) that asked for it, because a union with no
 * attribution answers "what will this do" while hiding "who wants it".
 *
 * Nothing is summarised away. No "and 12 more", no elision behind a --verbose
 * flag: this single confirmation REPLACES the per-member prompts, so anything
 * it omits is something no one is ever asked about.
 */
export function formatCombinedCapabilityReview(opts: {
  name: string;
  version: string;
  surface: CombinedCapabilitySurface;
  members: CompositionMemberSurface[];
  /** The factory's declared tier, shown alongside the computed MIN. */
  tier?: PackageTier;
}): string[] {
  const { name, version, surface, members } = opts;
  const lines: string[] = [];

  lines.push("");
  lines.push(`Install composition: ${name} v${version} — ${members.length} member(s)`);
  for (const member of members) {
    lines.push(`  • ${member.name} v${member.version} [${member.tier}]`);
  }

  const computedTier = minimumTier(members.map((m) => m.tier));
  if (computedTier) {
    const declared = opts.tier;
    lines.push(
      declared && declared !== computedTier
        ? `Tier: ${declared} declared, ${computedTier} computed (MIN of members — docs/design-factory-type.md D5)`
        : `Tier: ${computedTier} (MIN of members)`,
    );
  }

  lines.push(`Risk: ${surface.risk.toUpperCase()} (combined)`);
  lines.push("");
  lines.push("Combined capabilities (the union of every member's — nothing omitted):");

  const attributed = (entry: AttributedCapability) => `[${entry.members.join(", ")}]`;

  for (const entry of surface.read) {
    lines.push(`  🟢 Read: ${entry.value} ${attributed(entry)}`);
  }
  for (const entry of surface.write) {
    lines.push(`  🟡 Write: ${entry.value} ${attributed(entry)}`);
  }
  for (const entry of surface.network) {
    const reason = entry.reason ? ` (${entry.reason})` : "";
    lines.push(`  🟡 Network: ${entry.value}${reason} ${attributed(entry)}`);
  }
  if (surface.bash.unrestricted) {
    lines.push(
      `  🔴 Bash: unrestricted [${surface.bash.unrestrictedMembers.join(", ")}] — one member with unrestricted bash makes the WHOLE composition unrestricted`,
    );
  }
  for (const entry of surface.bash.restricted) {
    lines.push(`  🟡 Bash: ${entry.value} ${attributed(entry)}`);
  }
  for (const entry of surface.secrets) {
    const reason = entry.reason ? ` (${entry.reason})` : "";
    lines.push(`  🟡 Secret: ${entry.value}${reason} ${attributed(entry)}`);
  }

  const empty =
    surface.read.length === 0 &&
    surface.write.length === 0 &&
    surface.network.length === 0 &&
    surface.secrets.length === 0 &&
    !surface.bash.allowed;
  if (empty) {
    lines.push("  (none — no member declares a capability)");
  }

  return lines;
}

// ───────────────────────────────────────────────────────────────────────────
// D6 — cross-member owns overlap (arc#401 review, F4)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Does any member's DELETABLE `owns` entry overlap another member's
 * `owns.userData`? (arc#401 review, F4.)
 *
 * `validateOwns` already refuses this WITHIN one manifest, on the rule that
 * userData is never deleted and so must not overlap a class purge deletes. A
 * composition breaks the assumption that manifest holds: each member can be
 * individually valid while the union is not. Reproduced — member A declares
 * `~/alpha-workspace` as userData, member B declares
 * `~/alpha-workspace/cache` as state; `arc purge <factory>` then deletes
 * inside A's user data and reports that same path KEPT in the very same
 * report. That is the apt `/home` guarantee failing while claiming to hold,
 * which is worse than failing loudly.
 *
 * Refused at composition time (before anything lands) rather than repaired at
 * purge time. A purge-time fix would have to decide which member wins, and
 * there is no safe answer: skipping B's deletion leaves state a purge promised
 * to remove, honouring it deletes A's user data. The authors have to
 * reconcile the paths, and the earliest arc can say so is while it still costs
 * the operator nothing.
 *
 * Both directions of containment count, and equality counts, for the same
 * reason `validateOwns` takes both: nesting either way puts a deletable path
 * and a never-delete path in one subtree. Comparison is segment-aware on
 * tilde-expanded, glob-stripped roots — the identical primitive, imported
 * rather than re-derived, so the single-manifest gate and this one cannot
 * disagree about what "overlaps" means.
 *
 * Pure: returns one human line per conflict, naming BOTH members and BOTH
 * paths, and empty when there is nothing to say.
 */
export function compositionOwnsConflicts(
  members: readonly CompositionMemberSurface[],
): string[] {
  const conflicts: string[] = [];

  for (const keeper of members) {
    for (const ud of keeper.manifest.owns?.userData ?? []) {
      for (const deleter of members) {
        if (deleter.name === keeper.name) continue; // same-manifest overlap is validateOwns' job
        for (const cls of PURGEABLE_OWNS_CLASSES) {
          for (const entry of deleter.manifest.owns?.[cls] ?? []) {
            if (!ownsEntriesOverlap(ud, entry)) continue;
            conflicts.push(
              `'${keeper.name}' declares userData '${ud}' and '${deleter.name}' declares ${cls} '${entry}' — ` +
                `they overlap on disk. userData is NEVER deleted, so purging this composition would delete inside ` +
                `'${keeper.name}'s user data while reporting it kept. Reconcile the paths in the two manifests.`,
            );
          }
        }
      }
    }
  }

  return conflicts;
}

// ───────────────────────────────────────────────────────────────────────────
// D5 — tier is the MIN of the members'
// ───────────────────────────────────────────────────────────────────────────

/**
 * Trust, most-trusted first. `PackageTier` has no `core` value (that tier
 * exists only in `arc validate`'s tier list), so this is the whole axis.
 */
const TIER_TRUST_ORDER: readonly PackageTier[] = ["official", "community", "custom"];

/** The LEAST-trusted tier among `tiers`, or null when there are none. */
export function minimumTier(tiers: readonly PackageTier[]): PackageTier | null {
  let worst: PackageTier | null = null;
  for (const tier of tiers) {
    const index = TIER_TRUST_ORDER.indexOf(tier);
    if (index === -1) continue;
    if (worst === null || index > TIER_TRUST_ORDER.indexOf(worst)) worst = tier;
  }
  return worst;
}

/**
 * The D5 re-check, run at INSTALL as well as publish.
 *
 * Trust never averages up: a factory containing one `community` member is
 * `community` at best, whatever its own manifest claims. A member's tier can
 * change between publish and install (a revocation), which is precisely why
 * this is re-computed here rather than trusted from the release.
 *
 * WARNs — it does not refuse. That is `arc audit`'s posture for the cross-tier
 * warnings this extends (audit.ts:18,57): the mismatch is information the
 * operator needs, not a claim that the install is unsafe. Returns null when
 * there is nothing to say.
 */
export function tierMinWarning(
  declared: PackageTier | undefined,
  members: readonly CompositionMemberSurface[],
): string | null {
  if (!declared || members.length === 0) return null;
  const computed = minimumTier(members.map((m) => m.tier));
  if (!computed || computed === declared) return null;

  const declaredIndex = TIER_TRUST_ORDER.indexOf(declared);
  const computedIndex = TIER_TRUST_ORDER.indexOf(computed);
  if (declaredIndex === -1 || computedIndex === -1) return null;
  // Only an over-claim is worth saying. A factory declaring LESS trust than its
  // members carry is being conservative, which needs no warning.
  if (declaredIndex >= computedIndex) return null;

  const atMin = members.filter((m) => m.tier === computed).map((m) => m.name);
  return (
    `arc: WARN — composition declares tier '${declared}' but its members compute to '${computed}' ` +
    `(MIN of member tiers; docs/design-factory-type.md D5) — ${atMin.join(", ")} ${atMin.length === 1 ? "is" : "are"} '${computed}'. ` +
    `Trust never averages up; treat the composition as '${computed}'.`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The orchestrator
// ───────────────────────────────────────────────────────────────────────────

/** Where a member was located. Recorded in the DB for the lifecycle slice. */
export type MemberSource = "registry" | "repo";

/** A reference resolved to a concrete, staged member — nothing landed yet. */
export interface ResolvedCompositionMember {
  reference: PackageReference;
  /** The member's own manifest, read from the resolved package. */
  manifest: ArcManifest;
  source: MemberSource;
  /** The address used: `@scope/name` for the registry, the URL for a repo. */
  ref: string;
  /**
   * A verified, already-extracted package directory (registry path) that the
   * member installer hands straight to `install({ preExtractedPath })` — so a
   * registry member is downloaded and verified exactly once, not twice.
   */
  preExtractedPath?: string;
  /** The git ref the member installer must check out (repo path). */
  pinnedRef?: string;
}

export type ReferenceResolver = (
  reference: PackageReference,
) => Promise<{ ok: true; member: ResolvedCompositionMember } | { ok: false; error: string }>;

export type MemberInstaller = (member: ResolvedCompositionMember) => Promise<{
  success: boolean;
  error?: string;
  /**
   * The name the member was RECORDED under. Needed for the post-landing
   * surface check (F2): a package's recorded name is its manifest's, which can
   * differ from the reference's label. Absent ⇒ the check is skipped, because
   * there is nothing to look the recorded surface up by.
   */
  name?: string;
  version?: string;
  /**
   * The member was already installed and nothing was done. A pre-existing
   * install was consented to separately, so a surface difference against it is
   * reported but is NOT this composition's refusal to make — see
   * `installCompositionMembers`.
   */
  alreadyInstalled?: boolean;
}>;

/** Present the combined review and return the operator's answer. */
export type CompositionConfirm = (reviewLines: string[]) => Promise<boolean>;

/** The seams install.ts fills in (and tests replace). None have defaults. */
export interface CompositionSeams {
  resolve?: ReferenceResolver;
  probe?: ToolProbe;
  confirm?: CompositionConfirm;
  installMember?: MemberInstaller;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** Everything decided before a single member is installed. */
export interface CompositionPlan {
  manifest: ArcManifest;
  members: ResolvedCompositionMember[];
  surfaces: CompositionMemberSurface[];
  surface: CombinedCapabilitySurface;
  /** True when the combined review was shown and approved. */
  reviewed: boolean;
}

export type PrepareResult =
  | { ok: true; plan: CompositionPlan }
  | {
      ok: false;
      error: string;
      /**
       * Members that had already been STAGED on disk when the refusal fired
       * (arc#400 review, W3).
       *
       * Staging is not landing — a scratch clone or a verified tarball extracted
       * to a scratch dir places no symlink, no DB row and no host drop — but it
       * does place bytes, and bytes a refusal leaves behind become the next
       * run's confusing state. composition.ts cannot delete them (it owns no
       * filesystem, deliberately), so it HANDS THEM BACK and install.ts sweeps.
       */
      staged: ResolvedCompositionMember[];
    };

function memberSurface(member: ResolvedCompositionMember): CompositionMemberSurface {
  return {
    name: member.reference.name,
    version: member.reference.version,
    tier: member.manifest.tier ?? "custom",
    manifest: member.manifest,
  };
}

/**
 * Everything that must happen BEFORE any member lands (D2).
 *
 * On any refusal this returns `{ ok: false }` having installed nothing — that
 * is the honesty rule, and it is why resolution is a distinct phase from
 * installation. A resolver may STAGE bytes (a shallow clone, a verified
 * tarball extracted to a scratch dir); staging is not landing, and a refusal
 * after staging still leaves no symlink, no DB row, and no host drop.
 */
export async function prepareComposition(opts: {
  manifest: ArcManifest;
  seams: CompositionSeams;
  /** `--yes`: approve non-interactively. The review is still put on the record. */
  yes?: boolean;
}): Promise<PrepareResult> {
  const { manifest, seams } = opts;
  const log = seams.log ?? ((line: string) => { console.log(line); });
  const warn = seams.warn ?? ((line: string) => process.stderr.write(`${line}\n`));

  // Members staged on disk so far. Handed back on every refusal path so the
  // caller can sweep them (W3) — see PrepareResult.
  const members: ResolvedCompositionMember[] = [];
  const refuse = (error: string): PrepareResult => ({ ok: false, error, staged: [...members] });

  // 1. VALIDATE the composition manifest. Free, and it catches the authoring
  //    mistakes — a range pin above all (D4), and a composition that tries to
  //    declare a capability surface of its own (S2).
  const violations = validateCompositionFields(manifest);
  if (violations.length > 0) {
    return refuse(
      [
        `Refusing to install '${manifest.name}': its composition declarations are invalid.`,
        ...violations.map((v) => `  ${v.field}: ${v.rule}`),
        "Nothing was installed.",
      ].join("\n"),
    );
  }

  const references = readCompositionReferences(manifest);

  // 2. TOOLS, before anything is fetched. A host missing `gh` is knowable
  //    without touching the network, and the operator should learn it before
  //    arc spends bandwidth on members that cannot be used.
  const toolCheck = checkTools(
    readCompositionTools(manifest),
    seams.probe ?? (() => ({ found: false })),
  );
  for (const line of toolCheck.warnings) warn(line);
  if (!toolCheck.ok) {
    return refuse(toolCheck.error ?? "declared tools are not satisfied");
  }

  // A composition with no references is slice 1's manifest-only install. Say
  // nothing, plan nothing, and let install() proceed exactly as before.
  if (references.length === 0) {
    return {
      ok: true,
      plan: {
        manifest,
        members: [],
        surfaces: [],
        surface: aggregateCapabilities([]),
        reviewed: false,
      },
    };
  }

  const resolve = seams.resolve;
  if (!resolve) {
    return refuse(
      `Refusing to install '${manifest.name}': no reference resolver is configured (internal error).`,
    );
  }

  // 3. RESOLVE every reference and read every member manifest. All of them,
  //    before any of them installs — a failure on the LAST member must prevent
  //    the FIRST from landing.
  if (!opts.yes) log(`\nResolving ${references.length} reference(s) for '${manifest.name}'…`);
  for (const reference of references) {
    const resolved = await resolve(reference);
    if (!resolved.ok) {
      return refuse(
        [
          `Refusing to install '${manifest.name}': member '${reference.name}@${reference.version}' could not be resolved.`,
          `  ${resolved.error}`,
          "Nothing was installed — a composition is one decision, so one bad member aborts all of it (docs/design-factory-type.md D2).",
        ].join("\n"),
      );
    }

    // The member is staged from here on: record it BEFORE any further refusal
    // so W3's sweep can reach it.
    members.push(resolved.member);

    // ── F1 (arc#400 review) — COMPOSITIONS DO NOT NEST ────────────────────
    //
    // A composition-typed member is a consent bypass, not a layering nicety.
    // A `bundle`/`factory` manifest declares no capabilities of its own, so it
    // contributes ZERO rows to the union: the combined review renders "Risk:
    // LOW / (none)" — a truthful summary of the member's own manifest and a
    // completely false summary of what installing it does. The member
    // installer then runs with `yes: true` (correctly: this member WAS
    // approved), and the nested composition's own members install with no
    // review at all. Everything reachable through the nesting arrives unseen.
    //
    // The fix is refusal rather than recursion. Recursing would mean flattening
    // an unbounded graph into one review, which brings cycle detection, a depth
    // ceiling, and a review long enough that nobody reads it — while the
    // registry has already ruled the other way (BUNDLE_RECURSIVE; meta-factory
    // PR #574 §8) and the design's no-nesting extension says the same. arc
    // refusing what the registry refuses keeps one answer in the ecosystem.
    if (isCompositionType(resolved.member.manifest.type)) {
      return refuse(
        [
          `Refusing to install '${manifest.name}': member '${reference.name}' is itself a '${resolved.member.manifest.type}' — compositions cannot nest.`,
          "A composition declares no capability surface of its own, so a nested one would contribute NOTHING to the combined review while installing its own members unreviewed — the review would say 'no capabilities' about an install that has them.",
          "Flatten the members into this composition's own references[]. Nothing was installed.",
        ].join("\n"),
      );
    }

    // D4, re-checked against the bytes actually resolved: a pin that does not
    // match the member's own manifest version is a broken snapshot, however it
    // came about (a moved tag, a registry that served the wrong version).
    const declared = resolved.member.manifest.version;
    if (declared !== reference.version) {
      return refuse(
        [
          `Refusing to install '${manifest.name}': member '${reference.name}' is pinned to ${reference.version} but its manifest declares ${declared}.`,
          "A factory release is a reproducible snapshot (docs/design-factory-type.md D4). Nothing was installed.",
        ].join("\n"),
      );
    }

    if (!opts.yes) log(`  ✓ ${reference.name}@${reference.version}`);
  }

  // 4. AGGREGATE, and re-check the tier MIN (D5) against what actually resolved.
  const surfaces = members.map(memberSurface);
  const surface = aggregateCapabilities(surfaces);

  // 4a. CROSS-MEMBER owns overlap (arc#401 review, F4). Each member's own
  //     manifest already passed `validateOwns`; the UNION is a different
  //     question, and the answer to it decides whether `arc purge` can keep the
  //     never-touch promise it prints. Refused here — before the operator is
  //     asked anything, and long before anything lands — because at purge time
  //     there is no safe way to choose between deleting a member's declared
  //     state and preserving another member's user data.
  const ownsConflicts = compositionOwnsConflicts(surfaces);
  if (ownsConflicts.length > 0) {
    return refuse(
      [
        `Refusing to install '${manifest.name}': its members' owns declarations overlap across the composition.`,
        ...ownsConflicts.map((c) => `  ${c}`),
        "userData is the one thing arc promises never to delete (docs/design-factory-type.md D6). Nothing was installed.",
      ].join("\n"),
    );
  }

  const tierWarning = tierMinWarning(manifest.tier, surfaces);
  if (tierWarning) warn(tierWarning);

  // 5. ONE confirmation. It REPLACES the per-member prompts, so it shows the
  //    full union — see formatCombinedCapabilityReview.
  const reviewLines = formatCombinedCapabilityReview({
    name: manifest.name,
    version: manifest.version,
    surface,
    members: surfaces,
    tier: manifest.tier,
  });

  if (opts.yes) {
    // Approved non-interactively — but still put the surface on the record, the
    // same posture confirmCapabilityWidening takes under --yes: an operator
    // reading a CI log must be able to see what was approved on their behalf.
    warn(
      `arc: '${manifest.name}' composition approved non-interactively (--yes). Combined surface:\n${reviewLines.join("\n")}`,
    );
    return { ok: true, plan: { manifest, members, surfaces, surface, reviewed: true } };
  }

  const confirm = seams.confirm;
  if (!confirm) {
    return refuse(
      `Refusing to install '${manifest.name}': no confirmation channel is available for the combined capability review.`,
    );
  }
  const approved = await confirm(reviewLines);
  if (!approved) {
    return refuse(
      [
        `Refusing to install '${manifest.name}': the combined capability review was not approved.`,
        "Nothing was installed. Re-run with --yes to approve non-interactively.",
      ].join("\n"),
    );
  }

  return { ok: true, plan: { manifest, members, surfaces, surface, reviewed: true } };
}

/** A capability row, as `db.capabilityRows` / `db.recordedCapabilityRows` shape it. */
export interface CapabilityRowLike {
  type: string;
  value: string;
  reason?: string;
}

/** `type:value`, the identity two capability rows are the same grant under. */
function rowKey(row: CapabilityRowLike): string {
  return `${row.type}:${row.value}`;
}

/**
 * How a landed capability surface differs from the one that was REVIEWED.
 *
 * Set difference on `type:value`, both directions, order-insensitive — a
 * reordered surface is the same surface. Returns one human line per difference,
 * empty when they agree.
 *
 * `reason` is deliberately not compared: it is documentation, not a grant, and
 * a reworded reason is not a capability change worth refusing an install over.
 */
export function capabilitySurfaceDrift(
  reviewed: readonly CapabilityRowLike[],
  landed: readonly CapabilityRowLike[],
): string[] {
  const reviewedKeys = new Set(reviewed.map(rowKey));
  const landedKeys = new Set(landed.map(rowKey));
  const drift: string[] = [];
  for (const row of landed) {
    if (!reviewedKeys.has(rowKey(row))) drift.push(`  + ${row.type}: ${row.value} (never reviewed)`);
  }
  for (const row of reviewed) {
    if (!landedKeys.has(rowKey(row))) drift.push(`  - ${row.type}: ${row.value} (reviewed, absent)`);
  }
  return drift;
}

/**
 * Install the plan's members, in declaration order.
 *
 * Runs only after `prepareComposition` returned ok — i.e. after every refusal
 * has had its chance. A failure HERE is a runtime failure of an already-
 * approved member (a postinstall that exits non-zero, say), not a trust
 * decision, and it propagates exactly like a failed `depends_on.packages`
 * dependency does today: loud, naming the member, with the members that
 * already landed left in place for `arc remove` to take down. Undoing a
 * partial composition is the lifecycle slice's job (arc#401, D6). The error
 * NAMES those already-landed members, because "some of it installed" is
 * useless to an operator who cannot see which parts (arc#400 review, S1).
 *
 * ## The post-landing surface check (arc#400 review, F2)
 *
 * Consent was given for a surface read from RESOLVED bytes. Landing is a
 * separate act, and for a repo member it is a separate clone. Pinning to the
 * resolved commit (see `resolveRepoReference`) closes the moved-tag window at
 * the source; this is the belt to that pair of braces, and it generalises: it
 * asks the only question that actually matters — *is what arc RECORDED for this
 * member the surface the operator approved?* — without arc having to prove
 * anything about how the bytes travelled. It covers the registry path for free.
 *
 * A drift on a member that FRESHLY landed is a refusal: the bytes on disk are
 * not the bytes reviewed. A drift against a member that was ALREADY installed
 * is reported as a warning instead — that install was consented to separately
 * and this composition did not put it there, so refusing would make re-running
 * `arc install <factory>` fail on state it did not create.
 */
export async function installCompositionMembers(
  plan: CompositionPlan,
  installMember: MemberInstaller,
  opts: {
    yes?: boolean;
    log?: (line: string) => void;
    warn?: (line: string) => void;
    /**
     * Read back the surface arc RECORDED for a landed package. install.ts binds
     * this to `recordedCapabilityRows(db, name)`; composition.ts stays
     * database-free. Absent ⇒ the F2 post-landing check is skipped.
     */
    recordedRowsFor?: (name: string) => CapabilityRowLike[];
    /**
     * The rows that were REVIEWED for a member, keyed by reference name. Bound
     * to `capabilityRows(member.manifest)` — the same walk the review used.
     */
    reviewedRowsFor?: (member: ResolvedCompositionMember) => CapabilityRowLike[];
    /**
     * Called after each member lands, so the caller can mark it on the record
     * (F3). `alreadyInstalled` threads the one fact arc#401's purge cascade
     * cannot recover later: whether THIS composition put the member there, or
     * merely found it. A member it found is not a member its removal may take
     * away (D6) — see `markCompositionMemberLanded`.
     */
    onMemberLanded?: (
      member: ResolvedCompositionMember,
      landedName?: string,
      alreadyInstalled?: boolean,
    ) => void;
    /**
     * Does the name a member LANDED under disagree with the name the reference
     * gave it? (arc#401 review, ROOT 1.) Returns a refusal message, or null.
     *
     * Bound by install.ts to `memberIdentityRefusal`. This module stays free of
     * the identity policy for the same reason it stays free of the database:
     * the comparison is one line and its justification is a page, and the page
     * belongs where the canonical key is defined. Absent ⇒ the check is
     * skipped, which is what keeps a stub installer (one that reports no landed
     * name at all) working unchanged.
     */
    identityRefusalFor?: (
      member: ResolvedCompositionMember,
      landedName: string,
    ) => string | null;
  } = {},
): Promise<{ success: boolean; error?: string; landed: string[] }> {
  const log = opts.log ?? ((line: string) => { console.log(line); });
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const landed: string[] = [];
  // The names those members are INSTALLED under (arc#401 review, F11).
  //
  // `landed` holds reference LABELS, because that is what the caller's staging
  // sweep filters on. The debris pointer must not: a member's label can differ
  // from its manifest name (every `@scope/name` member, by construction), and
  // `arc remove <label>` then fails with "not installed" — the one command the
  // error hands an operator who is already having a bad day. Falls back to the
  // label when the installer reported no name, which is the stub-installer case
  // in tests and the only case where arc has nothing better to say.
  const landedNames: string[] = [];

  const withDebris = (message: string): string =>
    landedNames.length === 0
      ? `${message}\nNo member had landed yet — nothing to clean up.`
      : `${message}\nAlready landed (left in place; take one down with \`arc remove <name>\`): ${landedNames
          .map((n) => `${n} (\`arc remove ${n}\`)`)
          .join(", ")}`;

  for (const member of plan.members) {
    const label = `${member.reference.name}@${member.reference.version}`;
    if (!opts.yes) log(`\nInstalling member: ${label}`);

    const result = await installMember(member);
    if (!result.success) {
      return {
        success: false,
        landed,
        error: withDebris(
          `Failed to install composition member '${label}': ${result.error ?? "unknown error"}`,
        ),
      };
    }

    landed.push(member.reference.name);
    landedNames.push(result.name ?? member.reference.name);

    // RECORD THE MEMBER FIRST, then decide whether to refuse (arc#401 review,
    // F11). The member is on disk either way, and the row is what makes it
    // REACHABLE: `arc purge <factory>` walks `composition_members` by the
    // LANDED name, so a refusal that skipped this left the row carrying the
    // label and the cascade silently stepped over an installed package. The
    // caller's binding computes the right state (`landed` / `preexisting`) for
    // a member that landed, and that reasoning does not change because the
    // composition is about to be refused for a different reason.
    opts.onMemberLanded?.(member, result.name, result.alreadyInstalled);

    // ROOT 1 — IDENTITY. A package that landed under a different name than the
    // reference gave it was reviewed under someone else's name, and the record
    // every lifecycle command walks would key on a name nothing installed. Both
    // halves are worse than a refusal, and the second is what made `arc purge`
    // report a clean untangle over an installed member. Checked inside the loop
    // so the members that already landed are named in the error, like every
    // other failure here.
    if (result.name && opts.identityRefusalFor) {
      const refusal = opts.identityRefusalFor(member, result.name);
      if (refusal) return { success: false, landed, error: withDebris(refusal) };
    }

    // F2 — did what landed match what was approved?
    if (opts.recordedRowsFor && opts.reviewedRowsFor && result.name) {
      const drift = capabilitySurfaceDrift(
        opts.reviewedRowsFor(member),
        opts.recordedRowsFor(result.name),
      );
      if (drift.length > 0) {
        if (result.alreadyInstalled) {
          warn(
            `arc: WARN — composition member '${label}' was already installed and its recorded capability surface differs from the reviewed one:\n${drift.join("\n")}\n` +
              `Nothing was changed. That install was approved separately; run \`arc info ${result.name}\` to inspect it.`,
          );
        } else {
          return {
            success: false,
            landed,
            error: withDebris(
              [
                `Refusing to continue '${plan.manifest.name}': member '${label}' landed a DIFFERENT capability surface than the one reviewed.`,
                ...drift,
                "The bytes that installed are not the bytes that were approved — treat this as a supply-chain event, not a glitch.",
              ].join("\n"),
            ),
          };
        }
      }
    }

    if (!opts.yes) log(`  ✓ ${label}`);
  }

  return { success: true, landed };
}

/** The composition rows recorded at install — the lifecycle slice's input. */
export interface CompositionMemberRecord {
  name: string;
  version: string;
  source: MemberSource;
  ref: string;
}

/** Reduce a plan to the rows `recordComposition` persists. */
export function compositionRecordFor(plan: CompositionPlan): CompositionMemberRecord[] {
  return plan.members.map((member) => ({
    name: member.reference.name,
    version: member.reference.version,
    source: member.source,
    ref: member.ref,
  }));
}
