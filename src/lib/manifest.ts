import { readFile } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { ArcManifest, HostId, RiskLevel } from "../types.js";
import { KNOWN_HOST_IDS } from "../types.js";
import { isErrno } from "./errors.js";
import { normalizeDeclaredSecrets } from "./secrets.js";
import { validateOwns } from "./owns.js";

/** Preferred manifest filename (new name). */
export const MANIFEST_FILENAME = "arc-manifest.yaml";

/** Legacy manifest filename (still recognized). */
export const LEGACY_MANIFEST_FILENAME = "pai-manifest.yaml";

/** Both manifest filenames, preferred first. */
export const MANIFEST_FILENAMES = [MANIFEST_FILENAME, LEGACY_MANIFEST_FILENAME] as const;

/**
 * Synchronously read the `version` field from arc's own bundled
 * arc-manifest.yaml — the single release source of truth (per the compass
 * versioning SOP). The CLI derives `arc --version` from this so the reported
 * version can never drift from the manifest the way an independently-maintained
 * `package.json` version can (which is exactly the drift this replaces:
 * manifest said 0.33.0 while package.json still said 0.30.5).
 *
 * Synchronous on purpose: `--version` is wired into commander at program
 * construction, before the async command handlers run.
 *
 * @param manifestPath absolute path to arc-manifest.yaml
 * @returns the version string, or `null` when the file is missing, unreadable,
 *          unparseable, or carries no string `version` — callers fall back to
 *          the compiled-in `package.json` version in that case.
 */
export function readManifestVersionSync(manifestPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (_err) {
    // Manifest not found alongside the running CLI (e.g. an unusual install
    // layout). Safe to ignore: the caller falls back to package.json.
    return null;
  }

  const parsed = YAML.parse(raw) as { version?: unknown } | null;
  const version = parsed?.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/**
 * Read and parse an arc-manifest.yaml (or legacy pai-manifest.yaml) from a directory.
 * Prefers arc-manifest.yaml; falls back to pai-manifest.yaml.
 *
 * Search order (arc#102):
 *   1. <dir>/arc-manifest.yaml
 *   2. <dir>/pai-manifest.yaml          (legacy)
 *   3. <dir>/agent/arc-manifest.yaml    (persona-driven-agent bundles whose
 *                                        source repo nests the agent files
 *                                        under agent/, e.g. the-metafactory/forge)
 *   4. <dir>/agent/pai-manifest.yaml
 *
 * Falling back into agent/ is gated to a manifest whose `type` is `agent`
 * — we never silently install something under a non-canonical layout for
 * other artifact types. Returns null if no manifest exists. Throws if a
 * file exists but is invalid.
 */
export async function readManifest(
  dir: string
): Promise<ArcManifest | null> {
  // Try root first (the canonical location for every artifact type).
  const rootResult = await readManifestFromDir(dir);
  if (rootResult) return rootResult;

  // Fallback: agent/<manifest> for persona-driven-agent source repos that
  // ship the agent files under agent/ at the repo root (forge layout).
  // Only honor the fallback when the manifest declares type: agent —
  // skills/tools/prompts must continue to fail at the root if missing.
  const agentDir = join(dir, "agent");
  const agentResult = await readManifestFromDir(agentDir);
  if (agentResult?.type === "agent") {
    return agentResult;
  }
  return null;
}

/**
 * Read a manifest from a single directory. Returns null if neither
 * arc-manifest.yaml nor pai-manifest.yaml is present in that directory.
 * Throws if a file is present but malformed.
 */
async function readManifestFromDir(
  dir: string,
): Promise<ArcManifest | null> {
  for (const filename of MANIFEST_FILENAMES) {
    const manifestPath = join(dir, filename);
    try {
      const content = await readFile(manifestPath, "utf-8");
      const parsed = YAML.parse(content) as ArcManifest;

      if (!parsed.name || !parsed.version) {
        throw new Error(
          `Invalid ${filename}: missing required fields (name, version)`
        );
      }

      // Fold the deprecated `schema: pai/v1` alias to the canonical `arc/v1`
      // once, before any type-specific branch returns (arc#280). Runs here so
      // the warning fires exactly once per manifest load, not per field access.
      normalizeSchema(parsed, filename);

      // Library-specific validation
      if (parsed.type === "library") {
        validateLibraryManifest(parsed, filename);
        validateCortexConfig(parsed, filename);
        return parsed;
      }

      // Process-specific validation (dev-loop F-6d, meta-factory#550). A
      // process declares its dependencies per-node, so the top-level
      // `capabilities` block is optional (like component/rules/agent).
      if (parsed.type === "process") {
        validateProcess(parsed, filename);
        validateTargets(parsed, filename);
        validateLifecycle(parsed, filename);
        validateCortexConfig(parsed, filename);
        validateOwnsField(parsed, filename);
        return parsed;
      }

      // capabilities optional for component, rules, agent and the reference-
      // composition types, required for others.
      // Persona-driven agents (arc#100 §12 / arc#102) declare authority via
      // `guardrails` instead of `capabilities` — the host enforces guardrails
      // through its own primitives (allowedDirs, disallowedTools, bashAllowlist),
      // so the per-package capabilities block does not apply.
      // bundle/factory (arc#399, docs/design-factory-type.md D1/D2) carry no
      // artifact payload of their own — a composition has nothing to declare.
      // Its capability surface is the UNION of its members', computed at install
      // from the resolved references and presented as one combined review (D2);
      // demanding an explicit-empty block here would assert the composition is
      // capability-free, which is exactly the wrong claim to make.
      if (
        !parsed.capabilities &&
        parsed.type !== "component" &&
        parsed.type !== "rules" &&
        parsed.type !== "agent" &&
        parsed.type !== "bundle" &&
        parsed.type !== "factory"
      ) {
        throw new Error(
          [
            `Invalid ${filename}: missing required field 'capabilities'`,
            `Required for type: skill, tool, prompt, pipeline, system (optional only for: component, rules, agent, process, bundle, factory).`,
            ``,
            `Minimal example:`,
            ``,
            `capabilities:`,
            `  filesystem:`,
            `    read: []                  # paths the package reads from`,
            `    write: []                 # paths the package writes to`,
            `  network:`,
            `    - domain: api.example.com`,
            `      reason: <what calls this domain>`,
            `  bash:`,
            `    allowed: false            # set true if the package shells out`,
            `  secrets: []                 # env vars or secret keys the package reads`,
            ``,
            `See: https://github.com/the-metafactory/arc/blob/main/README.md#capability-declarations`,
          ].join("\n"),
        );
      }

      normalizeCapabilities(parsed, filename);
      validateTargets(parsed, filename);
      validateLifecycle(parsed, filename);
      validateCortexConfig(parsed, filename);
      validateAgentState(parsed, filename);
      validateOwnsField(parsed, filename);

      return parsed;
    } catch (err) {
      if (isErrno(err) && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

/** Canonical manifest schema identifier. */
export const CANONICAL_SCHEMA = "arc/v1";

/** Deprecated manifest schema alias, folded to {@link CANONICAL_SCHEMA} on load. */
export const DEPRECATED_SCHEMA = "pai/v1";

/**
 * Fold the deprecated `schema: pai/v1` alias to the canonical `arc/v1` in
 * place (arc#280). `pai/v1` is residue from when arc was PAI's package
 * manager; the ecosystem has moved to metafactory naming.
 *
 * This is the deprecate step of a deprecate → migrate → remove path: the
 * loader keeps ACCEPTING `pai/v1` at the boundary (the type union is
 * unchanged) but normalizes it away so downstream code only ever observes
 * `arc/v1`. A future major removes `pai/v1` from the union and turns an
 * unknown schema into a validation error.
 *
 * Emits a single one-line stderr warning when a fold happens. No-op for a
 * manifest that already declares `arc/v1` or omits the field entirely.
 */
export function normalizeSchema(manifest: ArcManifest, filename: string): void {
  if (manifest.schema !== DEPRECATED_SCHEMA) return;

  manifest.schema = CANONICAL_SCHEMA;
  process.stderr.write(
    `arc: ${filename} declares schema ${DEPRECATED_SCHEMA} (deprecated) — ` +
      `folding to ${CANONICAL_SCHEMA}; update the manifest.\n`,
  );
}

/**
 * Normalize a single network-capability entry to the canonical `{host, reason}`
 * object form (spec §4.1, arc#335). Accepts, in order of preference:
 *   - the canonical `{host, reason}` object,
 *   - the deprecated `{domain, reason}` object (folded: `domain` → `host`),
 *   - the bare string shorthand `"example.com"` (→ `{host, reason: ""}`).
 * Returns null for anything else so the caller can surface a clear error.
 *
 * This is the lenient-loader half of the arc#335 contract: the strict validator
 * (validate-manifest.ts) requires `{host, reason}` and rejects `domain`, while
 * the loader keeps accepting the deprecated shape so un-migrated packages still
 * install — the same loader-lenient/validator-strict posture as the pai/v1
 * schema alias (arc#280).
 */
export function normalizeNetworkEntry(
  entry: unknown,
): { host: string; reason: string } | null {
  if (typeof entry === "string") {
    return { host: entry, reason: "" };
  }
  if (entry && typeof entry === "object") {
    const obj = entry as { host?: unknown; domain?: unknown; reason?: unknown };
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    // Canonical shape first.
    if (typeof obj.host === "string") {
      return { host: obj.host, reason };
    }
    // Deprecated { domain, reason } — fold `domain` into the canonical `host`.
    if (typeof obj.domain === "string") {
      return { host: obj.domain, reason };
    }
  }
  return null;
}

/**
 * Normalize `capabilities.network` in place to the canonical `{host, reason}`
 * shape (arc#335). Folds the deprecated `{domain, reason}` map and the bare
 * string shorthand (`- example.com`) into `{host, reason}`, and emits one-shot
 * stderr warnings naming the deprecated entries so publishers can migrate to
 * the canonical shape the strict validator requires. No-op when capabilities or
 * network are absent.
 */
export function normalizeCapabilities(manifest: ArcManifest, filename: string): void {
  const caps = manifest.capabilities;
  if (!caps || !Array.isArray(caps.network) || caps.network.length === 0) return;

  const shorthand: string[] = [];
  const deprecatedDomain: string[] = [];
  const invalid: unknown[] = [];
  const normalized: { host: string; reason: string }[] = [];

  for (const entry of caps.network as unknown[]) {
    if (typeof entry === "string") shorthand.push(entry);
    else if (
      entry && typeof entry === "object" &&
      typeof (entry as { host?: unknown }).host !== "string" &&
      typeof (entry as { domain?: unknown }).domain === "string"
    ) {
      deprecatedDomain.push((entry as { domain: string }).domain);
    }
    const result = normalizeNetworkEntry(entry);
    if (result === null) {
      invalid.push(entry);
      continue;
    }
    normalized.push(result);
  }

  if (invalid.length > 0) {
    throw new Error(
      `Invalid ${filename}: capabilities.network entries must be a {host, reason} object ` +
      `(the deprecated {domain, reason} map and a bare string are also accepted); got ${JSON.stringify(invalid)}`,
    );
  }

  caps.network = normalized;

  if (shorthand.length > 0) {
    process.stderr.write(
      `warning: ${filename} capabilities.network uses string shorthand for [${shorthand.join(", ")}] — ` +
      `add a reason for each host in the form {host: "${shorthand[0]}", reason: "why you need this"}.\n`,
    );
  }
  if (deprecatedDomain.length > 0) {
    process.stderr.write(
      `warning: ${filename} capabilities.network uses the deprecated {domain, reason} shape for ` +
      `[${deprecatedDomain.join(", ")}] — rename 'domain' to 'host' (the canonical shape; arc#335).\n`,
    );
  }
}

/**
 * Validate `targets:` on the manifest.
 *
 * - Each entry must be a member of `KNOWN_HOST_IDS` (claude-code | cortex |
 *   darwin-launchd | linux-systemd today).
 * - Duplicates are rejected — ambiguous semantics for multi-target install
 *   ordering.
 * - Empty array is rejected — declaring `targets: []` is more confusing than
 *   omitting the field. Omission means "default host".
 *
 * The membership check is purely schema-level. arc#140 P3 adds a
 * detection-time check ("target X listed but adapter not implemented") at
 * dispatch time.
 */
export function validateTargets(manifest: ArcManifest, filename: string): void {
  const targets = manifest.targets;
  if (targets === undefined) return;

  if (!Array.isArray(targets)) {
    throw new Error(
      `Invalid ${filename}: 'targets' must be an array of host IDs (got ${typeof targets})`,
    );
  }
  if (targets.length === 0) {
    throw new Error(
      `Invalid ${filename}: 'targets' is empty — omit the field to use the default host`,
    );
  }

  const seen = new Set<HostId>();
  for (const entry of targets) {
    if (typeof entry !== "string") {
      throw new Error(
        `Invalid ${filename}: targets entries must be strings, got ${JSON.stringify(entry)}`,
      );
    }
    if (!(KNOWN_HOST_IDS as readonly string[]).includes(entry)) {
      throw new Error(
        `Invalid ${filename}: unknown target host '${entry}'. Known: ${KNOWN_HOST_IDS.join(", ")}`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(
        `Invalid ${filename}: duplicate target '${entry}' in 'targets'`,
      );
    }
    seen.add(entry);
  }
}

/**
 * Validate `lifecycle:` arrays.
 *
 * - Each known phase (preinstall/postinstall/preuninstall/postuninstall) is
 *   an array of strings.
 * - Each script path is relative (no leading `/`) and contains no `..`
 *   segment — defense in depth against a package whose install root differs
 *   from the bundled-script root.
 * - Unknown phase keys are rejected so typos surface at parse time rather
 *   than silently no-op'ing at install.
 */
export function validateLifecycle(manifest: ArcManifest, filename: string): void {
  const lifecycle = manifest.lifecycle;
  if (lifecycle === undefined) return;

  if (typeof lifecycle !== "object" || Array.isArray(lifecycle)) {
    throw new Error(
      `Invalid ${filename}: 'lifecycle' must be an object with phase arrays`,
    );
  }

  const knownPhases = new Set([
    "preinstall",
    "postinstall",
    "preuninstall",
    "postuninstall",
  ]);

  for (const key of Object.keys(lifecycle)) {
    if (!knownPhases.has(key)) {
      throw new Error(
        `Invalid ${filename}: unknown lifecycle phase '${key}'. Known: ${[...knownPhases].join(", ")}`,
      );
    }
    const arr = (lifecycle as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) {
      throw new Error(
        `Invalid ${filename}: lifecycle.${key} must be an array of script paths`,
      );
    }
    for (const entry of arr) {
      if (typeof entry !== "string") {
        throw new Error(
          `Invalid ${filename}: lifecycle.${key} entries must be strings, got ${JSON.stringify(entry)}`,
        );
      }
      if (entry.startsWith("/")) {
        throw new Error(
          `Invalid ${filename}: lifecycle.${key} entry '${entry}' must be a relative path (no leading /)`,
        );
      }
      const segments = entry.split("/");
      if (segments.includes("..")) {
        throw new Error(
          `Invalid ${filename}: lifecycle.${key} entry '${entry}' must not contain '..'`,
        );
      }
    }
  }
}

/** The only top-level keys a `cortex_config` fragment may carry inline (besides
 *  the mutually-exclusive `path` pointer). Mirrors cortex's
 *  `CapabilityMergeFragmentSchema.strict()` boundary so a package can't smuggle
 *  a transport/identity change (`agents`, `principal`, `nats`, …) in through the
 *  merge path. cortex re-validates authoritatively at merge time; this is the
 *  structural pre-filter at arc's manifest edge. */
const CORTEX_CONFIG_INLINE_KEYS = new Set(["capabilities", "policy"]);

/**
 * Validate `cortex_config:` on the manifest (F-6a / cortex#858).
 *
 * The field is OPTIONAL. When present it must be one of two mutually-exclusive
 * forms:
 *   - Path pointer: `{ path: "<relative-file>" }` — a relative path (no leading
 *     `/`, no `..` segment, defense-in-depth against escaping the package root)
 *     to a YAML fragment file shipped in the package.
 *   - Inline fragment: at least one of `capabilities:` / `policy:`, and NO
 *     other top-level key.
 *
 * arc does NOT parse the fragment's deep contents — cortex's
 * `CapabilityMergeFragmentSchema` + `CortexConfigSchema` own that at merge time
 * (Anti-Abstraction Gate: trust the downstream validator, don't reimplement it).
 * arc's job here is to reject obviously-malformed manifests at read time so a
 * typo surfaces on install rather than as an opaque cortex-side error, and to
 * enforce the capability/policy-only boundary at the trust edge.
 */
export function validateCortexConfig(manifest: ArcManifest, filename: string): void {
  const cc = manifest.cortex_config as unknown;
  if (cc === undefined || cc === null) return;

  if (!isRecord(cc)) {
    throw new Error(
      `Invalid ${filename}: 'cortex_config' must be an object with a 'path' pointer or inline 'capabilities'/'policy' (got ${Array.isArray(cc) ? "array" : typeof cc})`,
    );
  }

  const keys = Object.keys(cc);
  if (keys.length === 0) {
    throw new Error(
      `Invalid ${filename}: 'cortex_config' is empty — declare a 'path' to a fragment file, or inline 'capabilities'/'policy'. Omit the field entirely if there is nothing to merge.`,
    );
  }

  const hasPath = "path" in cc;
  const inlineKeys = keys.filter((k) => k !== "path");

  // Path-pointer form: `path` + nothing else.
  if (hasPath) {
    if (inlineKeys.length > 0) {
      throw new Error(
        `Invalid ${filename}: 'cortex_config' is both a 'path' pointer and inline (${inlineKeys.join(", ")}) — choose one form, not both.`,
      );
    }
    const p = cc.path;
    if (typeof p !== "string" || p.length === 0) {
      throw new Error(
        `Invalid ${filename}: 'cortex_config.path' must be a non-empty relative path to a YAML fragment file.`,
      );
    }
    if (p.startsWith("/")) {
      throw new Error(
        `Invalid ${filename}: 'cortex_config.path' '${p}' must be a relative path (no leading /).`,
      );
    }
    if (p.split("/").includes("..")) {
      throw new Error(
        `Invalid ${filename}: 'cortex_config.path' '${p}' must not contain '..'.`,
      );
    }
    return;
  }

  // Inline form: only capabilities/policy, at least one present.
  const unknownKeys = inlineKeys.filter((k) => !CORTEX_CONFIG_INLINE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Invalid ${filename}: 'cortex_config' may only declare 'capabilities' and/or 'policy' (or a 'path' pointer); got unexpected key(s): ${unknownKeys.join(", ")}. ` +
        `A package may not declare transport/identity config (agents, principal, nats, …) — that is the stack's, not the package's.`,
    );
  }
  if (inlineKeys.length === 0) {
    throw new Error(
      `Invalid ${filename}: 'cortex_config' inline form must declare at least one of 'capabilities:' or 'policy:'.`,
    );
  }
  if ("capabilities" in cc && !Array.isArray(cc.capabilities)) {
    throw new Error(
      `Invalid ${filename}: 'cortex_config.capabilities' must be an array of capability declarations.`,
    );
  }
  if ("policy" in cc && !isRecord(cc.policy)) {
    throw new Error(
      `Invalid ${filename}: 'cortex_config.policy' must be an object with 'principals'/'roles' arrays.`,
    );
  }
}

/**
 * Validate `state:` on the manifest (arc#281, forge/design/agent-platform.md §state).
 *
 * The field is OPTIONAL and opts a `type: agent` package into an instance-state
 * scaffold at install (stateless by default — omit the field to stay stateless).
 * When present it must be an object declaring BOTH `blueprint` and `version` as
 * non-empty strings; a malformed shape rejects at manifest load so a typo
 * surfaces on read rather than silently skipping (or half-running) the scaffold.
 *
 * arc does not resolve the blueprint or check the version range here — that is
 * the install-time bundle-satisfaction concern; this is the structural guard at
 * the manifest edge (mirrors validateCortexConfig's trust-edge posture).
 *
 * A bare `state:` key parses to `null` in YAML — the most likely typo for
 * someone half-declaring the field. That is rejected explicitly (rather than
 * treated as "absent"), because the install-time gate opts into the scaffold on
 * PRESENCE and a null slip-through would opt in an agent with no blueprint.
 */
export function validateAgentState(manifest: ArcManifest, filename: string): void {
  const state = manifest.state as unknown;
  // Field absent → stateless, nothing to validate.
  if (state === undefined) return;

  // Bare `state:` (→ null) is a half-declaration, not "stateless". Reject it so
  // the typo surfaces at load rather than opting the agent into an empty scaffold.
  if (state === null) {
    throw new Error(
      `Invalid ${filename}: 'state' is empty (a bare 'state:' key) — declare ` +
        `'state: { blueprint: <AgentState bundle>, version: ">=x.y.z" }', or remove the ` +
        `'state' key entirely to make the agent stateless.`,
    );
  }

  if (!isRecord(state)) {
    throw new Error(
      `Invalid ${filename}: 'state' must be an object with 'blueprint' and 'version' string fields (got ${Array.isArray(state) ? "array" : typeof state})`,
    );
  }

  for (const field of ["blueprint", "version"] as const) {
    const value = state[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Invalid ${filename}: 'state.${field}' must be a non-empty string ` +
          `(declare 'state: { blueprint: <AgentState bundle>, version: ">=x.y.z" }', or omit 'state' to make the agent stateless).`,
      );
    }
  }
}

/**
 * Validate the OPTIONAL `owns:` purge-scope declaration at manifest-load time
 * (arc#359). The heavy lifting lives in `lib/owns.ts` `validateOwns` (shared
 * with the strict `arc validate` validator); the loader is fail-CLOSED — any
 * violation THROWS so a home-sweeping or otherwise-unsafe declaration can never
 * reach `arc purge`. No-op when the field is absent.
 */
export function validateOwnsField(manifest: ArcManifest, filename: string): void {
  const violations = validateOwns(manifest.owns);
  if (violations.length > 0) {
    throw new Error(
      `Invalid ${filename}: ${violations.map((v) => `${v.field} ${v.rule}`).join("; ")}`,
    );
  }
}

/** Step keywords arc understands. `agent`/`gate` carry the D/A/H surface arc
 *  validates; the rest are pulse composition primitives accepted opaquely. */
const KNOWN_PROCESS_STEP_KEYWORDS = new Set([
  "agent",
  "gate",
  "map",
  "filter",
  "reduce",
  "parallel",
  "retry",
]);

/**
 * Validate a `type: process` manifest (dev-loop F-6d, meta-factory#550).
 *
 * The schema DESCRIBES pulse's real process vocabulary, NOT the idealised
 * explicit-DAG (`nodes`/`startNode`/`endNodes`/`dependsOn`) sketched in the
 * issue body — that shape does not round-trip a real pulse pipeline. A process
 * is an ORDERED `actions:` array; sequencing is positional, there are no edge
 * declarations, so there is no DAG/cycle check to run. arc validates only the
 * D/A/H step surface and trusts pulse for runner semantics (DD-47 / Anti-
 * Abstraction Gate).
 *
 * Rules:
 *   1. `process` block present with a non-empty `actions` array.
 *   2. Every step is a string (D action ref) or a single-keyword map.
 *   3. The keyword is one arc recognises (agent/gate or a composition primitive).
 *   4. `agent:` steps declare `name` + `capability` + `prompt`.
 *   5. `gate:` steps declare `name` + `prompt`.
 *   6. `timeout_ms` (agent or gate), when present, is a positive number — pulse
 *      uses milliseconds, NOT ISO-8601 durations.
 */
export function validateProcess(manifest: ArcManifest, filename: string): void {
  // YAML is untyped at the parse boundary — treat the block as `unknown` and
  // validate it up to the typed ProcessSpec contract rather than trusting the
  // optimistic cast. This is what makes the guards below genuinely load-bearing.
  const proc = manifest.process as unknown;
  if (!isRecord(proc)) {
    throw new Error(
      `Invalid ${filename}: type 'process' requires a 'process' block with a 'name' and an 'actions' array.`,
    );
  }
  if (typeof proc.name !== "string" || proc.name.length === 0) {
    throw new Error(
      `Invalid ${filename}: process requires a 'name' (e.g. 'P_BUILD_JOURNAL').`,
    );
  }
  if (!Array.isArray(proc.actions) || proc.actions.length === 0) {
    throw new Error(
      `Invalid ${filename}: process 'actions' must be a non-empty array (at least one step).`,
    );
  }

  proc.actions.forEach((step: unknown, i: number) => {
    // A bare string is a deterministic [D] action reference.
    if (typeof step === "string") {
      if (step.length === 0) {
        throw new Error(
          `Invalid ${filename}: process action[${i}] is an empty string; a deterministic action ref must be named.`,
        );
      }
      return;
    }

    if (!isRecord(step)) {
      throw new Error(
        `Invalid ${filename}: process action[${i}] must be a string (deterministic action ref) or a single-keyword map (agent/gate/…), got ${JSON.stringify(step)}.`,
      );
    }

    const keys = Object.keys(step);
    if (keys.length !== 1) {
      throw new Error(
        `Invalid ${filename}: process action[${i}] must have exactly one keyword, got [${keys.join(", ")}].`,
      );
    }
    const keyword = keys[0];
    if (!KNOWN_PROCESS_STEP_KEYWORDS.has(keyword)) {
      throw new Error(
        `Invalid ${filename}: process action[${i}] has unknown step keyword '${keyword}'. Known: ${[...KNOWN_PROCESS_STEP_KEYWORDS].join(", ")}.`,
      );
    }

    if (keyword === "agent") {
      validateAgentStep(step.agent, i, filename);
    } else if (keyword === "gate") {
      validateGateStep(step.gate, i, filename);
    }
    // map/filter/reduce/parallel/retry: accepted opaquely — pulse owns their
    // runner semantics (Anti-Abstraction Gate). No further validation here.
  });
}

/** Narrow an `unknown` to a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an `agent:` step's required surface (name + capability + prompt). */
function validateAgentStep(value: unknown, i: number, filename: string): void {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${filename}: process action[${i}] 'agent' must be an object.`);
  }
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Invalid ${filename}: agent step at action[${i}] is missing required 'name'.`);
  }
  if (typeof value.capability !== "string" || value.capability.length === 0) {
    throw new Error(`Invalid ${filename}: agent step '${name}' is missing required 'capability'.`);
  }
  if (typeof value.prompt !== "string" || value.prompt.length === 0) {
    throw new Error(`Invalid ${filename}: agent step '${name}' is missing required 'prompt'.`);
  }
  assertPositiveTimeout(value.timeout_ms, `agent step '${name}'`, filename);
}

/** Validate a `gate:` step's required surface (name + prompt). */
function validateGateStep(value: unknown, i: number, filename: string): void {
  if (!isRecord(value)) {
    throw new Error(`Invalid ${filename}: process action[${i}] 'gate' must be an object.`);
  }
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Invalid ${filename}: gate step at action[${i}] is missing required 'name'.`);
  }
  if (typeof value.prompt !== "string" || value.prompt.length === 0) {
    throw new Error(`Invalid ${filename}: gate step '${name}' is missing required 'prompt'.`);
  }
  assertPositiveTimeout(value.timeout_ms, `gate step '${name}'`, filename);
}

/** Reject a present-but-non-positive `timeout_ms`. Pulse timeouts are in ms. */
function assertPositiveTimeout(
  timeout: unknown,
  where: string,
  filename: string,
): void {
  if (timeout === undefined) return;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(
      `Invalid ${filename}: ${where} timeout_ms must be a positive number of milliseconds, got ${JSON.stringify(timeout)}.`,
    );
  }
}

/**
 * Validate a library root manifest.
 * Libraries must have an artifacts array and must NOT have provides/capabilities/scripts.
 */
function validateLibraryManifest(parsed: ArcManifest, filename: string): void {
  if (!parsed.artifacts || !Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
    throw new Error(
      `Invalid ${filename}: library type requires a non-empty 'artifacts' array`
    );
  }

  // Root manifest must not contain per-artifact fields
  if (parsed.provides) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'provides' (belongs on per-artifact manifests)`
    );
  }
  if (parsed.capabilities) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'capabilities' (belongs on per-artifact manifests)`
    );
  }
  if (parsed.scripts) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'scripts' (belongs on per-artifact manifests)`
    );
  }
  if (parsed.lifecycle) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'lifecycle' (belongs on per-artifact manifests)`
    );
  }
  if (parsed.owns) {
    throw new Error(
      `Invalid ${filename}: library root manifest must not contain 'owns' (belongs on per-artifact manifests)`
    );
  }

  // Validate each artifact entry
  for (const artifact of parsed.artifacts) {
    if (!artifact.path || typeof artifact.path !== "string") {
      throw new Error(
        `Invalid ${filename}: each artifact must have a 'path' string`
      );
    }
    // Path traversal guard
    if (artifact.path.includes("..") || artifact.path.startsWith("/")) {
      throw new Error(
        `Invalid ${filename}: artifact path '${artifact.path}' must be relative and cannot contain '..'`
      );
    }
  }
}

/**
 * Read artifact manifests from a library repo.
 * Returns an array of [artifactEntry, manifest] pairs for valid artifacts.
 */
export async function readLibraryArtifacts(
  libraryDir: string,
  manifest: ArcManifest,
): Promise<{ entry: import("../types.js").LibraryArtifactEntry; manifest: ArcManifest }[]> {
  if (manifest.type !== "library" || !manifest.artifacts) {
    return [];
  }

  const results: { entry: import("../types.js").LibraryArtifactEntry; manifest: ArcManifest }[] = [];

  for (const entry of manifest.artifacts) {
    const artifactDir = join(libraryDir, entry.path);
    const artifactManifest = await readManifest(artifactDir);
    if (!artifactManifest) {
      throw new Error(
        `Library artifact '${entry.path}' has no arc-manifest.yaml`
      );
    }
    if (artifactManifest.type === "library") {
      throw new Error(
        `Library artifact '${entry.path}' cannot itself be a library`
      );
    }
    results.push({ entry, manifest: artifactManifest });
  }

  return results;
}

/**
 * Calculate risk level from capabilities.
 * - high: network + filesystem write, or secrets with network
 * - medium: network access, or secrets, or unrestricted bash
 * - low: filesystem only, or restricted bash
 */
export function assessRisk(manifest: ArcManifest): RiskLevel {
  const caps = manifest.capabilities ?? {};
  if (!manifest.capabilities) return "low";
  const hasNetwork = (caps.network?.length ?? 0) > 0;
  const hasFileWrite = (caps.filesystem?.write?.length ?? 0) > 0;
  const hasSecrets = (caps.secrets?.length ?? 0) > 0;
  const hasBash = caps.bash?.allowed === true;
  const bashRestricted = (caps.bash?.restricted_to?.length ?? 0) > 0;

  // High risk: network + write, or secrets + network
  if (hasNetwork && hasFileWrite) return "high";
  if (hasSecrets && hasNetwork) return "high";

  // Medium risk: network, secrets, or unrestricted bash
  if (hasNetwork) return "medium";
  if (hasSecrets) return "medium";
  if (hasBash && !bashRestricted) return "medium";

  return "low";
}

/**
 * Format capabilities for display with risk coloring.
 */
export function formatCapabilities(manifest: ArcManifest): string[] {
  const lines: string[] = [];
  const caps = manifest.capabilities ?? {};
  if (!manifest.capabilities) return lines;

  if (caps.filesystem?.read?.length) {
    for (const p of caps.filesystem.read) {
      lines.push(`  🟢 Read: ${p}`);
    }
  }
  if (caps.filesystem?.write?.length) {
    for (const p of caps.filesystem.write) {
      lines.push(`  🟡 Write: ${p}`);
    }
  }
  if (caps.network?.length) {
    for (const n of caps.network) {
      lines.push(`  🟡 Network: ${n.host} (${n.reason})`);
    }
  }
  if (caps.bash?.allowed) {
    if (caps.bash.restricted_to?.length) {
      for (const b of caps.bash.restricted_to) {
        lines.push(`  🟡 Bash: ${b}`);
      }
    } else {
      lines.push(`  🔴 Bash: unrestricted`);
    }
  }
  if (caps.secrets?.length) {
    // Fold both author shapes to the NAME (arc#363) so the risk display never
    // renders "[object Object]" for an object-form secret declaration.
    for (const s of normalizeDeclaredSecrets(caps.secrets)) {
      lines.push(`  🟡 Secret: ${s.name}`);
    }
  }

  return lines;
}

/**
 * Human-readable author line, tolerant of both manifest shapes seen in the
 * wild (arc#275):
 *   - `authors: ["Name", ...]` — a plain string array (e.g. cortex's
 *     arc-manifest.yaml) — every entry is joined with ", ".
 *   - `author` / `authors[0]` as an `{ name, github }` object — rendered as
 *     `name (github)` when github is present, else just `name`.
 * Returns null when no usable author info is present (absent, empty array,
 * or an object without a usable name) — callers must skip the Author line
 * entirely rather than print "undefined".
 */
export function formatAuthor(manifest: ArcManifest): string | null {
  // Singular `author` object wins when present (matches prior precedence
  // of `manifest.author ?? manifest.authors?.[0]`).
  if (manifest.author) {
    return formatAuthorObject(manifest.author);
  }

  // ArcManifest declares `authors` as an object array, but the YAML parser
  // gives no runtime guarantee that shape holds — real manifests declare a
  // plain string array too (e.g. cortex's arc-manifest.yaml: `authors:
  // ["Andreas Astrom", "Jens-Christian Fischer"]`). Read defensively.
  const authors = manifest.authors as unknown as
    | (string | { name?: string; github?: string })[]
    | undefined;
  if (!authors || authors.length === 0) return null;

  if (typeof authors[0] === "string") {
    const names = authors.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
    );
    return names.length > 0 ? names.join(", ") : null;
  }

  return formatAuthorObject(authors[0]);
}

function formatAuthorObject(
  author: { name?: string; github?: string } | undefined
): string | null {
  if (!author || typeof author.name !== "string" || author.name.trim().length === 0) {
    return null;
  }
  return typeof author.github === "string" && author.github.trim().length > 0
    ? `${author.name} (${author.github})`
    : author.name;
}
