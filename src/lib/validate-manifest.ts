/**
 * Strict arc/v1 manifest validation (arc#317, skill-estate-migration spec
 * §4.1/§4.2). This is the WS2 gate every WS5 migration must pass.
 *
 * Distinct from the lenient loader in manifest.ts: `readManifest` folds the
 * `pai/v1` alias, tolerates a missing `capabilities` block for some types, and
 * accepts both author shapes so old packages keep installing. This validator is
 * the opposite posture — it REJECTS every legacy affordance so a repo can be
 * certified migration-clean before publish. It never mutates and never throws on
 * a rule violation; it collects EVERY violation (the CLI prints one line each)
 * so a publisher fixes the whole manifest in one pass rather than one error at a
 * time.
 *
 * Scope discipline (arc#317): this module is opt-in via `arc validate`. It does
 * NOT touch install/parse behavior and it does NOT remove the `pai/v1` alias
 * from the loader — that alias removal is arc#280.
 */

import { toStrictName } from "./repo-name.js";
import { validateOwns } from "./owns.js";

/** One rule failure. The CLI renders it as `<field>: <rule>` on its own line. */
export interface Violation {
  /** Dotted manifest path the rule is about (e.g. `capabilities.network`). */
  field: string;
  /** Human-readable statement of the rule that failed. */
  rule: string;
}

/** Everything the pure validator needs — no filesystem access of its own. */
export interface StrictValidationInput {
  /** Raw parsed YAML. Treated as `unknown`: the whole point is to prove shape. */
  manifest: unknown;
  /** Basename of the directory being validated (for the §4.2 derivation rule). */
  repoDirName: string;
  /**
   * `name:` from the package's SKILL.md frontmatter, when a SKILL.md was found.
   * `undefined` means "no SKILL.md present" → the PascalCase check is skipped
   * (not every package is a skill). `null` means "SKILL.md present but no name
   * field" → that is itself a violation.
   */
  skillFrontmatterName?: string | null;
}

/** The canonical schema literal strict mode accepts. */
const REQUIRED_SCHEMA = "arc/v1";
/** The deprecated alias strict mode REJECTS (loader still folds it — arc#280). */
const REJECTED_SCHEMA = "pai/v1";

/**
 * Package types strict mode accepts — the canonical `ArcManifest.type` set arc
 * can actually install (with `action` — arc#95). These MUST stay in lockstep
 * with the installer's supported set (`INSTALLABLE_ARTIFACT_TYPES` in
 * artifact-installer.ts); a parity test asserts it so they can't drift (arc#334).
 *
 * `bundle` is deliberately NOT here (arc#334, decision b): the installer has no
 * `bundle` case, so accepting it here let a manifest validate green yet throw at
 * `arc install`. `bundle` is a REPO-NAME class (metafactory-bundle-<name>), not
 * a manifest type — bundle-class repos declare an installable type (the
 * class-choice rule maps them to skill/tool; e.g. metafactory-bundle-discord is
 * `type: skill`, metafactory-bundle-content-filter is `type: tool`).
 */
export const VALID_TYPES = [
  "skill",
  "system",
  "tool",
  "agent",
  "prompt",
  "component",
  "pipeline",
  "process",
  "rules",
  "library",
  "action",
  "governance",
] as const;

/** Trust tiers strict mode accepts (issue #317 adds `core` over spec §4.1). */
const VALID_TIERS = ["official", "community", "custom", "core"] as const;

/** lowercase-hyphenated: `code-review`, `foo`, `a1-b2`. No leading/trailing/double dash. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** semver from 0.1.0, optional prerelease/build metadata. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** namespace: `@scope`, lowercase-hyphenated scope. */
const NAMESPACE_RE = /^@[a-z0-9-]+$/;
/** A hostname (not a URL). No scheme, no path, no whitespace. */
const HOST_RE = /^[a-z0-9.-]+$/i;
/**
 * A secret NAME is an env-var-shaped identifier (arc#363). Mirrors the storage
 * layer's guard (secrets.ts NAME_RE) so validate rejects exactly what the
 * backend would — the two ends of the same schema.
 */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Narrow an `unknown` to a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Convert a lowercase-hyphenated package name to PascalCase for the SKILL.md
 * frontmatter `name:` (spec §4.2): `code-review` → `CodeReview`, `foo` → `Foo`.
 */
export function toPascalCase(name: string): string {
  return name
    .split("-")
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
}

/**
 * Validate a parsed manifest against the strict arc/v1 contract. Pure: returns
 * the full list of violations (empty ⇒ valid). Order is stable and roughly
 * top-to-bottom through the manifest so CLI output reads predictably.
 */
export function validateStrictManifest(input: StrictValidationInput): Violation[] {
  const violations: Violation[] = [];
  const add = (field: string, rule: string) => violations.push({ field, rule });

  const manifest = input.manifest;
  if (!isRecord(manifest)) {
    add(
      "manifest",
      `must be a YAML mapping (got ${
        manifest === null ? "null" : Array.isArray(manifest) ? "array" : typeof manifest
      })`,
    );
    return violations;
  }

  validateSchema(manifest, add);
  const derivedName = validateName(manifest, input.repoDirName, add);
  validateVersion(manifest, add);
  validateType(manifest, add);
  validateTier(manifest, add);
  validateScalar(manifest, "description", add);
  validateScalar(manifest, "license", add);
  validateAuthor(manifest, add);
  validateCapabilities(manifest, add);
  validateNamespace(manifest, add);
  validateSkillFrontmatterName(input.skillFrontmatterName, derivedName, manifest, add);
  // owns: shared shape/safety gate (arc#359). Reuses the same pure validator the
  // lenient loader throws on, so `arc validate` and install agree byte-for-byte.
  for (const v of validateOwns(manifest.owns)) add(v.field, v.rule);

  return violations;
}

type Add = (field: string, rule: string) => void;

function validateSchema(manifest: Record<string, unknown>, add: Add): void {
  const schema = manifest.schema;
  if (schema === REQUIRED_SCHEMA) return;
  if (schema === REJECTED_SCHEMA) {
    add(
      "schema",
      `must be '${REQUIRED_SCHEMA}' — the '${REJECTED_SCHEMA}' alias is rejected in strict mode (alias removal tracked in arc#280)`,
    );
    return;
  }
  if (schema === undefined) {
    add("schema", `is required and must be the literal '${REQUIRED_SCHEMA}' (arc#280)`);
    return;
  }
  add("schema", `must be the literal '${REQUIRED_SCHEMA}' (got ${JSON.stringify(schema)})`);
}

/**
 * Validate `name` and the §4.2 derivation rule. Returns the derived `<name>`
 * (from the repo dir grammar) so the SKILL.md PascalCase check can reuse it, or
 * the manifest name as a fallback, or null when neither is usable.
 */
function validateName(
  manifest: Record<string, unknown>,
  repoDirName: string,
  add: Add,
): string | null {
  const name = manifest.name;
  const derived = toStrictName(repoDirName);

  if (!isNonEmptyString(name)) {
    add("name", "is required and must be a lowercase-hyphenated string");
    return derived;
  }
  if (!NAME_RE.test(name)) {
    add(
      "name",
      `must be lowercase-hyphenated (^[a-z0-9]+(-[a-z0-9]+)*$); got ${JSON.stringify(name)}`,
    );
  }

  // §4.2: when the repo dir matches the metafactory naming grammar, the manifest
  // name MUST equal the dir name minus its prefix. When the dir does not match
  // the grammar (e.g. a mktemp dir, a legacy repo name), the rule does not apply.
  if (derived !== null && name !== derived) {
    add(
      "name",
      `must derive from repo directory '${repoDirName}' → '${derived}' (spec §4.2); got '${name}'`,
    );
  }

  return derived ?? name;
}

function validateVersion(manifest: Record<string, unknown>, add: Add): void {
  const version = manifest.version;
  if (!isNonEmptyString(version)) {
    add("version", "is required and must be a semver string (from 0.1.0)");
    return;
  }
  if (!SEMVER_RE.test(version)) {
    add("version", `must be semver (major.minor.patch); got ${JSON.stringify(version)}`);
  }
}

function validateType(manifest: Record<string, unknown>, add: Add): void {
  const type = manifest.type;
  if (type === undefined) {
    add("type", `is required; one of ${VALID_TYPES.join(" | ")}`);
    return;
  }
  if (typeof type !== "string" || !(VALID_TYPES as readonly string[]).includes(type)) {
    add("type", `must be one of ${VALID_TYPES.join(" | ")}; got ${JSON.stringify(type)}`);
  }
}

function validateTier(manifest: Record<string, unknown>, add: Add): void {
  const tier = manifest.tier;
  if (tier === undefined) {
    add("tier", `is required; one of ${VALID_TIERS.join(" | ")}`);
    return;
  }
  if (typeof tier !== "string" || !(VALID_TIERS as readonly string[]).includes(tier)) {
    add("tier", `must be one of ${VALID_TIERS.join(" | ")}; got ${JSON.stringify(tier)}`);
  }
}

function validateScalar(manifest: Record<string, unknown>, field: string, add: Add): void {
  if (!isNonEmptyString(manifest[field])) {
    add(field, "is required and must be a non-empty string");
  }
}

function validateAuthor(manifest: Record<string, unknown>, add: Add): void {
  // The plural `authors:` list shape is rejected at the source (arc#278/#275):
  // it is the shape behind the authors-list display bug.
  if ("authors" in manifest) {
    add(
      "authors",
      "the 'authors:' list shape is rejected — use the singular 'author: {name, github}' map (arc#278)",
    );
  }

  const author = manifest.author;
  if (author === undefined) {
    add("author", "is required as a singular map { name, github }");
    return;
  }
  if (!isRecord(author)) {
    add("author", `must be a singular map { name, github }; got ${Array.isArray(author) ? "array" : typeof author}`);
    return;
  }
  if (!isNonEmptyString(author.name)) {
    add("author.name", "is required and must be a non-empty string");
  }
  if (!isNonEmptyString(author.github)) {
    add("author.github", "is required and must be a non-empty string");
  }
}

/**
 * Validate the REQUIRED `capabilities` block (spec §4.1, arc#240). The block
 * must be present with its four canonical sub-blocks declared as explicit
 * empties — "never omitted" — so risk is never silently defaulted to `low`.
 * Network entries use the standardized `{ host, reason }` shape ONLY: the
 * string shorthand and the legacy `{ domain, reason }` shape are both rejected.
 */
function validateCapabilities(manifest: Record<string, unknown>, add: Add): void {
  const caps = manifest.capabilities;
  if (caps === undefined || caps === null) {
    add(
      "capabilities",
      "is a required block with explicit empties (filesystem/network/bash/secrets) — never omitted (arc#240)",
    );
    return;
  }
  if (!isRecord(caps)) {
    add("capabilities", `must be a map with filesystem/network/bash/secrets; got ${Array.isArray(caps) ? "array" : typeof caps}`);
    return;
  }

  // filesystem: { read: [], write: [] } — both arrays, explicit.
  const fs = caps.filesystem;
  if (!isRecord(fs)) {
    add("capabilities.filesystem", "is required as { read: [], write: [] } (explicit empties)");
  } else {
    if (!Array.isArray(fs.read)) add("capabilities.filesystem.read", "is required as an array (explicit empty allowed)");
    if (!Array.isArray(fs.write)) add("capabilities.filesystem.write", "is required as an array (explicit empty allowed)");
  }

  // network: [] — array of { host, reason }, explicit.
  const network = caps.network;
  if (!Array.isArray(network)) {
    add("capabilities.network", "is required as an array of { host, reason } (explicit empty allowed)");
  } else {
    network.forEach((entry, i) => {
      if (!isRecord(entry)) {
        add(
          `capabilities.network[${i}]`,
          `must be a { host, reason } object only — string shorthand is rejected; got ${JSON.stringify(entry)}`,
        );
        return;
      }
      const keys = Object.keys(entry);
      const extra = keys.filter((k) => k !== "host" && k !== "reason");
      if (!isNonEmptyString(entry.host)) {
        // Catches the legacy { domain, reason } shape as well: no `host` present.
        add(`capabilities.network[${i}].host`, "is required (the { domain, reason } shape is rejected — use 'host')");
      }
      if (!isNonEmptyString(entry.reason)) {
        add(`capabilities.network[${i}].reason`, "is required — declare why the host is contacted");
      }
      if (isNonEmptyString(entry.host) && !HOST_RE.test(entry.host)) {
        add(`capabilities.network[${i}].host`, `must be a bare hostname, not a URL; got ${JSON.stringify(entry.host)}`);
      }
      if (extra.length > 0) {
        add(`capabilities.network[${i}]`, `may only declare 'host' and 'reason'; unexpected key(s): ${extra.join(", ")}`);
      }
    });
  }

  // bash: { allowed: false } — explicit boolean.
  const bash = caps.bash;
  if (!isRecord(bash)) {
    add("capabilities.bash", "is required as { allowed: <bool> } (explicit)");
  } else if (typeof bash.allowed !== "boolean") {
    add("capabilities.bash.allowed", "is required and must be a boolean");
  }

  // secrets: [] — array, explicit. Each entry is EITHER a bare NAME string OR
  // the object form { name, reason?, optional? } (arc#363). Both forms must be
  // accepted here so validate and install agree — install used to crash on the
  // object form validate let through. A bare/object NAME must be env-var-shaped.
  if (!Array.isArray(caps.secrets)) {
    add("capabilities.secrets", "is required as an array (explicit empty allowed)");
  } else {
    caps.secrets.forEach((entry, i) => {
      if (typeof entry === "string") {
        if (!SECRET_NAME_RE.test(entry)) {
          add(
            `capabilities.secrets[${i}]`,
            `NAME must be an env-var-shaped identifier ([A-Za-z_][A-Za-z0-9_]*); got ${JSON.stringify(entry)}`,
          );
        }
        return;
      }
      if (!isRecord(entry)) {
        add(
          `capabilities.secrets[${i}]`,
          `must be a NAME string or a { name, reason?, optional? } object; got ${Array.isArray(entry) ? "array" : typeof entry}`,
        );
        return;
      }
      if (typeof entry.name !== "string" || !SECRET_NAME_RE.test(entry.name)) {
        add(
          `capabilities.secrets[${i}].name`,
          `is required and must be an env-var-shaped identifier ([A-Za-z_][A-Za-z0-9_]*); got ${JSON.stringify(entry.name)}`,
        );
      }
      if (entry.reason !== undefined && typeof entry.reason !== "string") {
        add(`capabilities.secrets[${i}].reason`, "must be a string when present");
      }
      if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
        add(`capabilities.secrets[${i}].optional`, "must be a boolean when present");
      }
      const extra = Object.keys(entry).filter((k) => k !== "name" && k !== "reason" && k !== "optional");
      if (extra.length > 0) {
        add(`capabilities.secrets[${i}]`, `may only declare 'name', 'reason', and 'optional'; unexpected key(s): ${extra.join(", ")}`);
      }
    });
  }
}

function validateNamespace(manifest: Record<string, unknown>, add: Add): void {
  const namespace = manifest.namespace;
  if (namespace === undefined) return; // optional
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    add("namespace", `when present must match ^@[a-z0-9-]+$; got ${JSON.stringify(namespace)}`);
  }
}

/**
 * §4.2 SKILL.md frontmatter rule: when a SKILL.md is present its frontmatter
 * `name:` must be the PascalCase of the package name. `undefined` frontmatter
 * name ⇒ no SKILL.md was found ⇒ rule skipped (not every package is a skill).
 */
function validateSkillFrontmatterName(
  frontmatterName: string | null | undefined,
  derivedName: string | null,
  manifest: Record<string, unknown>,
  add: Add,
): void {
  if (frontmatterName === undefined) return; // no SKILL.md → nothing to check

  // Prefer the §4.2-derived name; fall back to the manifest name so the rule
  // still fires for packages whose dir doesn't match the grammar.
  const base = derivedName ?? (isNonEmptyString(manifest.name) ? manifest.name : null);
  if (base === null) return; // can't compute an expectation without a base name

  const expected = toPascalCase(base);
  if (frontmatterName === null) {
    add("SKILL.md:name", `is required and must be PascalCase '${expected}' (spec §4.2)`);
    return;
  }
  if (frontmatterName !== expected) {
    add(
      "SKILL.md:name",
      `must be PascalCase of '${base}' → '${expected}' (spec §4.2); got '${frontmatterName}'`,
    );
  }
}
