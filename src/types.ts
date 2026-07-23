// arc core types

// ── Artifact types ─────────────────────────────────────────────

/** The artifact classes arc installs. */
export type ArtifactType = "skill" | "system" | "agent" | "prompt" | "tool" | "component" | "pipeline" | "process" | "rules" | "library" | "action" | "governance";

// ── Registry types ────────────────────────────────────────────

/**
 * Registry entry SOURCE-TRUST level (arc#324). This is the trust axis — how much
 * the registry vouches for the entry's origin — and is DISTINCT from the manifest
 * `tier` (the package's own self-declared class). The field is named `trust:` in
 * REGISTRY.yaml so the two vocabularies are not conflated in one word set. See
 * docs/registry-schema.md.
 */
export type RegistryTrust = "builtin" | "community" | "system" | "custom";

/** A single entry in REGISTRY.yaml. See docs/registry-schema.md for the schema. */
export interface RegistryEntry {
  name: string;
  description: string;
  source: string;
  /** Source-trust level (NOT the manifest tier). Emitted as `trust:` (arc#324). */
  trust: RegistryTrust;
  has_cli?: boolean;
  /** Multi-artifact bundle repo (the single meaning of "bundle" — arc#63/#324). */
  bundle?: boolean;
  requires?: string[]; // typed refs: "skill:Thinking", "agent:Architect"
  author: string;
  version?: string;
  status: "shipped" | "beta" | "deprecated";
  reviewed_by?: string[];
}

/** Top-level registry.yaml structure */
export interface RegistryConfig {
  registry: {
    skills: RegistryEntry[];
    agents: RegistryEntry[];
    prompts: RegistryEntry[];
    tools: RegistryEntry[];
    components?: RegistryEntry[];
    rules?: RegistryEntry[];
  };
}

/** Resolved source — output of source-resolver */
export interface ResolvedSource {
  type: "local" | "github";
  /** For local: absolute path to the parent directory. For github: clone URL */
  cloneUrl: string;
  /** GitHub org (undefined for local) */
  org?: string;
  /** GitHub repo name (undefined for local) */
  repo?: string;
  /** Git branch (undefined for local) */
  branch?: string;
  /** Path within the repo to the parent directory of the referenced file */
  parentPath: string;
  /** The filename referenced in the source URL */
  filename: string;
  /** Artifact subdirectory within a library repo (undefined for standalone) */
  subPath?: string;
}

/** Capability declarations from arc-manifest.yaml */
export interface Capabilities {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  // Canonical shape (spec §4.1): { host, reason }. The loader folds the
  // deprecated { domain, reason } shape and the bare-string shorthand into
  // this form (normalizeNetworkEntry), so downstream always sees `host`.
  network?: { host: string; reason: string }[];
  bash?: {
    allowed: boolean;
    restricted_to?: string[];
  };
  // A declared secret is either a bare NAME shorthand or the richer object
  // form. Both forms are accepted by `arc validate` AND the installer — they
  // are folded to a NAME (+ optionality) via normalizeDeclaredSecrets so the
  // two never disagree (arc#363).
  secrets?: (string | SecretDeclaration)[];
  skills?: string[];
  mcp?: string[];
  hooks?: string[];
}

/**
 * The object form of a `capabilities.secrets` entry (arc#363). `name` is the
 * env-var-shaped identifier the agent reads at runtime; `reason` documents why
 * it is needed; `optional: true` means a missing value must NOT fail install
 * (the agent degrades or the secret is only read on a narrow code path).
 */
export interface SecretDeclaration {
  name: string;
  reason?: string;
  optional?: boolean;
}

/** Skill dependency declaration */
export interface SkillDependency {
  name: string;
  version?: string;
  reason?: string;
}

/** Tool dependency declaration */
export interface ToolDependency {
  name: string;
  version?: string;
  reason?: string;
}

/** Package dependency — another arc managed package */
export interface PackageDependency {
  name: string;
  repo: string;
  /**
   * Optional declared compat range (arc#354), e.g. ">=0.3.0". Checked when
   * the dependency is ALREADY installed: out-of-range surfaces a WARN naming
   * both versions (same warn-don't-fail posture as the arc#284
   * depends_on.skills check) — arc never silently upgrades an installed
   * package as a side effect of installing another one.
   */
  version?: string;
}

/** CLI tool provided by a skill */
export interface CliProvider {
  command: string;
  name?: string;
}

/** Skill trigger declaration */
export interface SkillTrigger {
  trigger: string;
}

/** Template declaration for rules packages */
export interface RulesTemplate {
  /** Path to template file within the package (e.g., "templates/CLAUDE.md.template") */
  source: string;
  /** Output file name in the consumer repo (e.g., "CLAUDE.md") */
  target: string;
  /** Config file in consumer repo (e.g., "claude-md.yaml") */
  config: string;
  /** Only generate if consumer opts in via their generate list */
  optional?: boolean;
}

/** Rules config schema (claude-md.yaml in consumer repo) */
export interface RulesConfig {
  template: string;
  generate?: { format: string }[];
  sections?: { position: string; file: string }[];
  extra_labels?: { name: string }[];
  /** Placeholder values — any key not in the above is a placeholder */
  [key: string]: unknown;
}

/**
 * Runtime declaration for type:agent packages.
 *
 * Per cortex `docs/design-arc-agent-bots.md` §4. Names the substrate
 * (claude-code / codex / pi-dev / custom) and the supervision mode
 * (in-process under cortex's runner, or standalone as its own daemon).
 * Capabilities are register-on-start values published to NATS KV by
 * the bot's daemon — listed here so cortex can scope credentials and
 * the dashboard can render an accurate provenance badge.
 */
export interface AgentRuntime {
  // The `& {}` trick preserves autocomplete for the known literals while
  // still accepting arbitrary strings (custom substrate names). Without it,
  // the union collapses to `string` and tooling loses the known-literal hints.
  substrate:
    | "claude-code"
    | "codex"
    | "pi-dev"
    | "custom-binary"
    | (string & {});
  mode: "in-process" | "standalone";
  capabilities?: string[];
}

/**
 * Identity declaration for type:agent packages.
 *
 * Rendered into the cortex fragment (`~/.config/cortex/agents.d/<id>.yaml`)
 * by the CortexHostAdapter. The `trust` list is propagated to the
 * runtime's `TrustResolver` — every id MUST resolve in the merged
 * `AgentRegistry` at construction time (cortex `docs/design-arc-agent-bots.md`
 * §9, registry.ts §9.3 rule 1).
 */
export interface AgentIdentity {
  id: string;
  did?: string;
  displayName?: string;
  roles?: string[];
  trust?: string[];
}

/**
 * Instance-state opt-in declaration for type:agent packages.
 *
 * The platform contract is STATELESS BY DEFAULT (bring your own grounding) —
 * `forge/design/agent-platform.md` §state. An agent that wants a persisted
 * instance-state directory (state.sqlite + dashboard/context/retros) opts in by
 * declaring this field; omitting it makes the agent stateless and skips the
 * scaffold entirely (cortex#1720/#1721 landed the same opt-in default cortex-
 * side, so arc and cortex now agree). Identity (NKey/DID) is provisioned
 * unconditionally regardless of this field.
 *
 * - `blueprint` — names the AgentState bundle that owns the on-disk schema
 *   (`state.sqlite` migrations). See github.com/the-metafactory/agent-state.
 * - `version`   — the semver range the agent needs that bundle to satisfy
 *   (e.g. ">=0.1.0"). Both subfields are required non-empty strings.
 */
export interface AgentState {
  blueprint: string;
  version: string;
}

/**
 * Ordered lifecycle script arrays for `type: agent` packages.
 *
 * Sister field to the existing `scripts.{preinstall,postinstall,…}` single-
 * script shape. The array form is required for standalone-bot install
 * sequences where order matters (cortex `docs/design-arc-agent-bots.md`
 * §8.1 / §8.2): drop fragment → signal cortex reload → issue NATS creds →
 * (standalone only) launchctl load. Uninstall reverses.
 *
 * Each entry is a path relative to the package install root, exactly like
 * the single-script `scripts` fields. Both shapes may be present on the
 * same manifest; arc runs `scripts.<phase>` first, then `lifecycle.<phase>`
 * in declared order. A failure in any entry aborts the install and
 * triggers the same rollback path as the single-script form.
 */
export interface LifecycleScripts {
  preinstall?: string[];
  postinstall?: string[];
  preuninstall?: string[];
  postuninstall?: string[];
}

/**
 * Runtime broker dependencies — declared by packages that route over a shared
 * message bus (NATS) and would silently fail without it. See arc#152.
 *
 * `nats: true` opts the package into the broker check at install/upgrade time.
 * arc probes `NATS_URL` (env or default `nats://127.0.0.1:4222`); if
 * unreachable AND no `NATS_URL` override is set, the bootstrap path runs:
 *   - macOS: `brew install nats-server` + `brew services start` (registers
 *     for auto-start across reboots).
 *   - Linux: requires an existing `nats-server` binary plus a systemd user
 *     unit; arc runs `systemctl --user enable --now nats-server.service`
 *     to start + register it. arc does NOT auto-`apt-get install` (would
 *     require root and surprise operators with custom install paths).
 * If `NATS_URL` is set but unreachable, arc surfaces a clear error instead
 * of overriding operator intent.
 */
export interface RuntimeRequirements {
  nats?: boolean;
}

/** Inline hook array format (e.g. Grove) */
export interface InlineHook {
  event: string;
  command: string;
  matcher?: string;
}

/** Config-file hook format (e.g. Miner) — references a JSON file */
export interface HooksConfigRef {
  claude_code: {
    config: string;
    description?: string;
  };
}

/** Union of both hook declaration formats in arc-manifest.yaml */
export type HooksDeclaration = InlineHook[] | HooksConfigRef;

/** An artifact entry in a library root manifest */
export interface LibraryArtifactEntry {
  path: string;
  description?: string;
}

/** Extension declaration in arc-manifest.yaml */
export interface ExtensionEntry {
  source: string;
  name: string;
}

// ── Process types (DD-47 D/A/H taxonomy, dev-loop F-6d, meta-factory#550) ──
//
// A `type: process` manifest packages a pulse process definition. The schema
// DESCRIBES pulse's real vocabulary (the-metafactory/pulse src/types/pipeline.ts
// + src/types/agent.ts), NOT the idealised explicit-DAG sketched in the issue
// body. A process is an ORDERED `actions:` array — sequencing is positional,
// there are no edge/`dependsOn` declarations. Each step is one of:
//   - a bare string           → Deterministic [D] action ref (e.g. "A_BUILD")
//   - `{ agent: AgentStep }`  → Agentic [A] step (capability-addressed LLM task)
//   - `{ gate: GateStep }`    → Human gate [H] step (approval pause)
// The composition primitives pulse also supports (map/filter/reduce/parallel/
// retry) are accepted as opaque pass-through objects — arc validates the D/A/H
// surface only and does not re-implement pulse's runner semantics (DD-47).

/**
 * Sovereignty constraints carried in an agent task envelope. Mirrors pulse
 * `AgentSovereignty` (src/types/agent.ts), itself mirroring the myelin v3
 * envelope schema. Declared by the process; enforced by the bus + fleet.
 */
export interface ProcessAgentSovereignty {
  classification?: "local" | "federated" | "public";
  data_residency?: string;
  max_hop?: number;
  frontier_ok?: boolean;
  model_class?: "local-only" | "frontier" | "any";
}

/** Cross-principal routing for a federated agent step (pulse `AgentFederation`). */
export interface ProcessAgentFederation {
  principal: string;
  stack?: string;
}

/**
 * Agentic [A] step — a capability-addressed, sovereignty-constrained LLM task.
 * Mirrors pulse `AgentStepSpec`. `capability` + `name` + `prompt` are required;
 * everything else is optional routing/sovereignty metadata.
 */
export interface ProcessAgentStep {
  name: string;
  capability: string;
  prompt: string;
  sovereignty?: ProcessAgentSovereignty;
  distribution_mode?: "offer" | "direct" | "delegate";
  target_assistant?: string;
  federate?: ProcessAgentFederation;
  /** Soft deadline in MILLISECONDS (pulse uses ms, not ISO-8601 durations). */
  timeout_ms?: number;
  collect?: string;
}

/**
 * Human gate [H] step — pauses execution for an operator verdict.
 * Mirrors pulse `GateStepSpec`. `name` + `prompt` are required.
 */
export interface ProcessGateStep {
  name: string;
  prompt: string;
  /** Optional timeout in MILLISECONDS. Omit for an indefinite wait. */
  timeout_ms?: number;
  collect?: string;
}

/**
 * A single process step (pulse `PipelineStep`). A bare string is a
 * Deterministic [D] action reference; the keyword maps select A/H steps;
 * the composition-primitive maps are accepted opaquely.
 */
export type ProcessStep =
  | string
  | { agent: ProcessAgentStep }
  | { gate: ProcessGateStep }
  | { map: Record<string, unknown> }
  | { filter: Record<string, unknown> }
  | { reduce: Record<string, unknown> }
  | { parallel: Record<string, unknown> }
  | { retry: Record<string, unknown> };

/**
 * The `process:` block on a `type: process` manifest — a named, ordered
 * pulse process definition. Mirrors the shape of a pulse pipeline.yaml.
 */
export interface ProcessSpec {
  /** Process name, e.g. "P_BUILD_JOURNAL". */
  name: string;
  description?: string;
  /** Ordered D/A/H steps. Sequencing is positional; non-empty. */
  actions: ProcessStep[];
}

/**
 * Purge-scope ownership declaration (arc#359).
 *
 * Three disjoint classes of runtime-created state a package's own runtime (not
 * arc) creates on disk. `arc purge` deletes `config` + `state`; it NEVER deletes
 * `userData` — that is the apt `/home` rule: workspace / user-authored content
 * is named and kept, never swept.
 *
 * Every entry is a `~`-rooted path or glob (`~/.config/metafactory/cortex`,
 * `~/.local/state/metafactory/cortex/**`). Absolute paths, a bare `~`/`~/`/`/`,
 * a leading `*`/`**` (home-root sweep), and any `..` segment are rejected at
 * manifest-load time — see `lib/owns.ts` `validateOwns`. `userData` entries may
 * not overlap `config`/`state`.
 */
export interface OwnsDeclaration {
  /** Config trees the package's runtime writes (apt conffiles). Deleted by purge. */
  config?: string[];
  /** Runtime/state trees (apt /var). Deleted by purge. */
  state?: string[];
  /** User-authored data (apt /home). NAMED and KEPT by purge — never deleted. */
  userData?: string[];
}

/** The full arc-manifest.yaml schema (also accepts legacy pai-manifest.yaml) */
export interface ArcManifest {
  schema?: "arc/v1" | "pai/v1";
  name: string;
  version: string;
  type: "skill" | "system" | "tool" | "agent" | "prompt" | "component" | "pipeline" | "process" | "rules" | "library" | "action" | "governance";
  /** Only present when type is "library" — lists contained artifacts */
  artifacts?: LibraryArtifactEntry[];
  /**
   * Only present when type is "process" — the packaged pulse process
   * definition (DD-47 D/A/H taxonomy, dev-loop F-6d). See ProcessSpec.
   */
  process?: ProcessSpec;
  /**
   * Multi-target install destinations (arc#117 multi-backend HostAdapter).
   *
   * When absent, arc routes to the single host adapter passed in
   * InstallOptions (today: claude-code). When present, arc dispatches
   * once per declared target in the order required by the artifact's
   * design contract — for `type: agent` standalone bots, that means
   * `cortex` FIRST, then the OS-supervision host (`darwin-launchd` or
   * `linux-systemd`) per cortex `docs/design-arc-agent-bots.md` §3.2.
   */
  targets?: HostId[];
  /**
   * Runtime declaration — type:agent only. Names substrate + supervision
   * mode + capabilities. Required for type:agent packages that declare
   * `targets: [cortex, …]`. See AgentRuntime.
   */
  runtime?: AgentRuntime;
  /**
   * Identity declaration — type:agent only. Rendered into the cortex
   * agent fragment. See AgentIdentity.
   */
  identity?: AgentIdentity;
  /**
   * Instance-state opt-in — type:agent only (forge/design/agent-platform.md
   * §state). When present, install scaffolds the agent's instance-state
   * directory; when absent, the agent is stateless and no dir is created.
   * Identity (NKey/DID) is provisioned regardless. See AgentState.
   */
  state?: AgentState;
  tier?: PackageTier;
  author?: {
    name: string;
    github: string;
    verified?: boolean;
  };
  authors?: {
    name: string;
    github: string;
    verified?: boolean;
  }[];
  provides?: {
    skill?: SkillTrigger[];
    cli?: CliProvider[];
    files?: { source: string; target: string }[];
    templates?: RulesTemplate[];
    hooks?: HooksDeclaration;
    /**
     * Standalone-bot daemon binary, relative to the package install root.
     * Rendered into the OS-supervision host's binDir (`~/bin/<binary>` on
     * darwin-launchd) at install time. type:agent + runtime.mode=standalone only.
     */
    binary?: string;
    /**
     * macOS launchd plist template, relative to the package install root.
     * Rendered into `~/Library/LaunchAgents/<label>.plist` by the
     * darwin-launchd HostAdapter, with token substitution (e.g.,
     * `{{NATS_URL}}`, `{{BIN}}`, `{{LOG_DIR}}`).
     */
    plist?: string;
    /**
     * Linux systemd user unit template, relative to the package install root.
     * Rendered into `~/.config/systemd/user/<unit>.service` by the
     * linux-systemd HostAdapter (post-P6).
     */
    systemdUnit?: string;
  };
  extensions?: {
    statusline?: ExtensionEntry[];
  };
  depends_on?: {
    skills?: SkillDependency[];
    tools?: ToolDependency[];
    packages?: PackageDependency[];
  };
  capabilities?: Capabilities;
  scripts?: {
    preinstall?: string;
    postinstall?: string;
    preupgrade?: string;
    postupgrade?: string;
    /** Runs before `arc remove` tears down symlinks / hooks / repo. Used to
     *  stop daemons, unload launchd plists, etc. */
    preremove?: string;
    /**
     * Runs during `arc purge` (arc#359), AFTER the package's declared
     * `owns.config`/`owns.state` trees are deleted. Handles the runtime-created
     * state a package CANNOT statically declare as an `owns` path — e.g.
     * disabling per-slug supervisor instances (`systemctl --user disable --now
     * 'cortex@*'`) that quickstart enabled but arc has no slug knowledge of.
     * Non-aborting: a failure warns and purge continues. Never runs on a plain
     * `arc remove`.
     */
    purge?: string;
  };
  /**
   * Purge-scope ownership declaration (arc#359). Names the runtime-created
   * config/state/user-data trees a package's RUNTIME (not arc) creates, so
   * `arc purge <name>` can remove them after `arc remove` tears down what arc
   * itself installed. Every entry is a `~`-rooted path or glob under the user's
   * OWN home trees; absolute paths, a bare `~`/`~/`/`/`, and `..` segments are
   * rejected at manifest-load time (a declaration that would sweep the whole
   * home tree is an error). See {@link OwnsDeclaration} and `lib/owns.ts`.
   */
  owns?: OwnsDeclaration;
  /**
   * Ordered lifecycle script arrays — for sequences where order matters
   * (e.g. type:agent standalone bots: signal-reload → issue-creds →
   * launchctl-load). Runs after the single-script `scripts` field of the
   * same phase. See LifecycleScripts.
   */
  lifecycle?: LifecycleScripts;
  /**
   * Runtime broker dependencies (arc#152). When `requires.nats: true`, arc
   * verifies a reachable NATS broker at install/upgrade time and bootstraps
   * a local one if `NATS_URL` is unset and no broker is found. Packages that
   * publish or subscribe on the message bus (sage, pilot, myelin-consumers)
   * declare this so the install chain — not the operator — is the load-bearing
   * piece for broker availability.
   */
  requires?: RuntimeRequirements;
  /** Optional namespace for publishing (alternative to account default) */
  namespace?: string;
  /** Bundle configuration for arc publish */
  bundle?: BundleConfig;
  /** Package description */
  description?: string;
  /** SPDX license identifier */
  license?: string;
  /**
   * Canonical source repository URL. Forwarded to the metafactory registry
   * at publish time so the package landing page can resolve relative README
   * image paths against the repo's raw content
   * (the-metafactory/meta-factory#501).
   *
   * Common shapes accepted by the registry's `extractRepoSlug`:
   *   - `https://github.com/owner/repo[.git]`
   *   - `git+https://github.com/owner/repo.git`
   *   - `git@github.com:owner/repo.git`
   *   - `github:owner/repo`
   *   - `owner/repo`
   */
  repository?: string;
  /** Optional public homepage / docs URL. Forwarded as-is to the registry. */
  homepage?: string;
  /** Free-form search keywords. Forwarded to the registry for discovery. */
  keywords?: string[];
  /**
   * Discovery category. The registry pins an enumeration —
   * `text-processing | security | api-integration | data-ops | devtools |
   * research | communication | infrastructure` — but arc forwards the raw
   * string and lets the server validate, so the source of truth stays in
   * one place.
   */
  category?: string;
  /**
   * Cortex-side config fragment to merge into the target stack at install
   * time (F-6a, cortex#858). When present AND the install target host is a
   * cortex stack, arc invokes `cortex config merge --fragment <…> --config
   * <stack-config-dir>` after the post-landing transaction, so the package's
   * declared capabilities/policy land in the stack's `stacks/<id>.yaml`
   * without the operator hand-editing it.
   *
   * This is the package's CORTEX capability/policy declaration — distinct from
   * `capabilities`, which is arc's OWN host-side capability enforcement (what
   * the package may read/write/network/shell on the local machine). A fragment
   * carries ONLY `capabilities` and/or `policy`; arc rejects any other
   * top-level key (`agents`, `principal`, `nats`, …) at manifest-read time so a
   * package can't smuggle a transport/identity change in through the merge
   * path. cortex's `CapabilityMergeFragmentSchema` is the authoritative
   * validator — arc's check is a structural pre-filter at the manifest edge.
   *
   * Either an inline fragment object, or a `{ path: <relative-file> }` pointer
   * to a YAML fragment file shipped inside the package.
   */
  cortex_config?: CortexConfigFragment;
}

/**
 * A cortex config fragment declared in arc-manifest.yaml (F-6a / cortex#858).
 *
 * Two forms:
 *   - Inline: `{ capabilities?: [...], policy?: {...} }` — the fragment body
 *     written verbatim to a temp file and passed to `cortex config merge
 *     --fragment`.
 *   - Path pointer: `{ path: "cortex-config.yaml" }` — a relative path (no
 *     leading `/`, no `..`) to a YAML fragment file shipped in the package;
 *     arc passes that file straight to `--fragment`.
 *
 * The two forms are mutually exclusive: a fragment is EITHER inline OR a path,
 * never both. cortex owns the deep semantics (id-keyed merge, idempotency,
 * CortexConfigSchema validation); arc only marshals the fragment to disk and
 * invokes the verb.
 */
export interface CortexConfigFragment {
  /**
   * Relative path to a YAML fragment file inside the package. Mutually
   * exclusive with the inline `capabilities`/`policy` keys.
   */
  path?: string;
  /** Inline cortex capability declarations (id-keyed). */
  capabilities?: unknown[];
  /** Inline cortex policy (principals + roles). */
  policy?: { principals?: unknown[]; roles?: unknown[] } & Record<string, unknown>;
}

/**
 * Per-artifact outcome state for a library install (arc#227 / F-6c).
 *
 * Distinguishes the four terminal states an artifact reaches inside a
 * library-install transaction so InstallResult can report partial state:
 *   - SKIPPED      — already installed before this run; left untouched.
 *   - SUCCESS      — installed cleanly in this run.
 *   - FAILED       — install attempt failed (this is where the sequence stops).
 *   - ROLLED_BACK  — installed in this run, then unwound because a LATER
 *                    artifact failed (atomic rollback).
 *
 * Canonical definition + the journal types live with the transaction in
 * `lib/install-transaction.ts`; re-exported here so the public manifest/result
 * surface stays in one place. (Defined there, not here, to keep the
 * lib → types dependency arrow one-directional — see arc#227 PR notes.)
 */
export {
  ArtifactInstallState,
  type ArtifactInstallDetail,
  type LibraryInstallJournal,
} from "./lib/install-transaction.js";

/** Trust tier for installed packages */
export type PackageTier = "official" | "community" | "custom";

/** Source type discriminator: registry (YAML file) or metafactory (API) */
export type SourceType = "registry" | "metafactory";

/** A configured registry source (apt-get style) */
export interface RegistrySource {
  name: string;
  url: string;
  tier: PackageTier;
  enabled: boolean;
  /** Source type. Defaults to "registry" when absent (backward compat). */
  type?: SourceType;
  /** Bearer token for authenticated API access. Only used with type "metafactory". */
  token?: string;
}

/** Top-level sources.yaml structure */
export interface SourcesConfig {
  sources: RegistrySource[];
}

/** Response from POST /api/v1/auth/cli/initiate */
export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** Response from POST /api/v1/auth/cli/verify */
export interface DeviceVerifyResponse {
  status: "pending" | "approved" | "denied";
  token?: string;
  token_id?: string;
  scope?: string;
  expires_at?: number;
  expires_in?: number;
}

/** Result of the complete device code auth flow */
export interface DeviceAuthResult {
  success: boolean;
  token?: string;
  expiresAt?: number;
  scope?: string;
  error?: string;
  errorCode?: "expired" | "denied" | "timeout" | "network" | "no_source" | "wrong_type";
}

/** Package summary from metafactory API list endpoint */
export interface MetafactoryPackageListItem {
  namespace: string;
  name: string;
  display_name: string | null;
  description: string | null;
  type: string;
  license: string;
  latest_version: string | null;
  publisher: {
    display_name: string | null;
    tier: string | null;
    mfa_enabled: boolean;
  };
  created_at: number;
  updated_at: number;
}

/** Paginated list response from metafactory API */
export interface MetafactoryPackageListResponse {
  packages: MetafactoryPackageListItem[];
  total: number;
  page: number;
  per_page: number;
}


/** Detailed package info from metafactory API */
export interface MetafactoryPackageDetail {
  namespace: string;
  name: string;
  display_name: string | null;
  description: string | null;
  type: string;
  license: string;
  latest_version: string | null;
  versions: string[];
  publisher: {
    display_name: string | null;
    tier: string | null;
    mfa_enabled: boolean;
    github_username: string | null;
  };
  sponsor: { display_name: string; tier: string; github_username: string | null } | null;
  created_at: number;
  updated_at: number;
}

/** A search result annotated with its source */
export interface SourcedSearchResult {
  entry: RegistryEntry;
  artifactType: ArtifactType;
  sourceName: string;
  sourceTier: PackageTier;
}

/** Search command options */
export interface SearchOptions {
  keyword?: string;
  json?: boolean;
  type?: ArtifactType;
  tier?: PackageTier;
}

/** Warning about a source that failed during search */
export interface SearchWarning {
  sourceName: string;
  reason: "unreachable" | "auth_required" | "rate_limited" | "malformed";
  message: string;
  usedStaleCache: boolean;
}

/** Search result with metadata and warnings */
export interface SearchResult {
  results: SourcedSearchResult[];
  warnings: SearchWarning[];
  totalSources: number;
  successfulSources: number;
}

/** Parsed package reference from CLI input */
export interface PackageRef {
  scope: string;
  name: string;
  version?: string;
}

/** SHA-256 verification result */
export interface VerifyResult {
  valid: boolean;
  expected: string;
  actual: string;
}

/** Installed package record in packages.db (skills and tools) */
export interface InstalledSkill {
  name: string;
  version: string;
  repo_url: string;
  install_path: string;
  skill_dir: string;
  status: "active" | "disabled";
  artifact_type: ArtifactType;
  tier: PackageTier;
  customization_path: string | null;
  install_source: string | null;
  /** Library name when this artifact was installed from a library (null for standalone) */
  library_name: string | null;
  installed_at: string;
  updated_at: string;
}

/** Capability entry in packages.db */
export interface CapabilityRecord {
  skill_name: string;
  type: "fs_read" | "fs_write" | "network" | "bash" | "secret" | "skill_dep";
  value: string;
  reason: string;
}

/** Risk level for capability display */
export type RiskLevel = "low" | "medium" | "high";

/** Audit warning for dangerous capability combinations */
export interface AuditWarning {
  skills: string[];
  capabilities: string[];
  description: string;
  risk: RiskLevel;
}

// ── Host adapter types (multi-backend support, see issue #117) ─────
// Two concerns:
//   - ArcPaths: arc's own state, host-independent
//   - HostPaths + HostAdapter: per-backend install dirs and behavior

/**
 * Supported agentic backends. The union expands when each adapter lands so
 * the type stays truthful: a value of `HostId` should always correspond to
 * an actually implemented `HostAdapter`. Phase 2 of #117 adds `"codex"`,
 * `"cursor"`, etc. as those adapters arrive.
 *
 * `darwin-launchd` and `linux-systemd` are OS-supervision hosts for
 * standalone-bot type:agent packages — they receive the daemon binary and
 * a launchd plist (macOS) or systemd user unit (Linux). See cortex
 * `docs/design-arc-agent-bots.md` §3.2 and arc#140. The adapter for
 * `darwin-launchd` lands in P2 of arc#140; `linux-systemd` later (Phase C
 * of the design doc). Schema declares the union so a `targets:` value can
 * be parsed and validated even before its adapter is registered.
 */
export type HostId =
  | "claude-code"
  | "cortex"
  | "darwin-launchd"
  | "linux-systemd";

/** Set of all known HostId values — for runtime validation of `targets:`. */
export const KNOWN_HOST_IDS: readonly HostId[] = [
  "claude-code",
  "cortex",
  "darwin-launchd",
  "linux-systemd",
] as const;

/** arc's own state — host-independent. Lives under ~/.config/metafactory/. */
export interface ArcPaths {
  /** Config root (~/.config/metafactory/) */
  configRoot: string;
  /**
   * Data class root — durable app data (packages.db, repos, sources).
   * #287 wave-1 seam: today collapses onto `configRoot` (no XDG split yet;
   * future `$XDG_DATA_HOME`).
   */
  dataRoot: string;
  /**
   * State class root — mutable runtime state. #287 wave-1 seam: today collapses
   * onto `configRoot` (future `$XDG_STATE_HOME`).
   */
  stateRoot: string;
  /**
   * Cache class root — regenerable data (remote-registry index cache).
   * #287 wave-1 seam: today collapses onto `configRoot` (future `$XDG_CACHE_HOME`).
   */
  cacheRoot: string;
  /** Package repos (~/.local/share/metafactory/arc/repos/) */
  reposDir: string;
  /** Remote registry cache directory (~/.config/metafactory/pkg/cache/) */
  cachePath: string;
  /** Database path (~/.config/metafactory/packages.db) */
  dbPath: string;
  /** Sources config path (~/.config/metafactory/sources.yaml) */
  sourcesPath: string;
  /** Secrets directory (~/.config/metafactory/secrets/) */
  secretsDir: string;
  /** Runtime state (~/.config/metafactory/skills/) */
  runtimeDir: string;
  /** Pipelines directory (~/.config/metafactory/pipelines/) */
  pipelinesDir: string;
  /** Actions directory (~/.config/metafactory/actions/) */
  actionsDir: string;
  /** PATH-accessible shim directory (~/.local/bin by default) — shared across hosts */
  shimDir: string;
  /** Registry file path (repo-root/registry.yaml) */
  registryPath: string;
}

/** Per-host install paths. Different backends place artifacts in different roots. */
export interface HostPaths {
  /** Host root (e.g. ~/.claude/, ~/.codex/, ~/.cursor/) */
  root: string;
  /** Skills directory (e.g. ~/.claude/skills/, ~/.codex/skills/) */
  skillsDir: string;
  /** Agents directory (Claude Code only today) */
  agentsDir: string;
  /** Slash commands/prompts directory */
  promptsDir: string;
  /** Tool bin directory (e.g. ~/.claude/bin/) */
  binDir: string;
  /** Host settings file (e.g. ~/.claude/settings.json, ~/.codex/config.toml) */
  settingsPath: string;
}

/**
 * Cortex-host-only path extensions. Not promoted to `HostPaths` because no
 * other backend has the same concepts (personas are cortex-specific; NATS
 * creds live in a NATS-conventional location). Cortex's adapter exposes
 * these as `HostPaths & CortexPaths` so cortex-aware callers see them while
 * generic dispatch (`hostPathFor`, `requireHostDir`) keeps working off the
 * base `HostPaths` surface.
 *
 * See cortex `docs/design-arc-agent-bots.md` §6.2 "Note on `HostPaths` extension".
 */
export interface CortexPaths {
  /** Persona markdown files for in-process bots (~/.config/cortex/personas/). */
  personasDir: string;
  /** Per-agent NATS user creds, daemon-written (~/.config/nats/creds/). */
  credsDir: string;
}

/**
 * Cortex host's concrete `paths` shape — base `HostPaths` plus cortex-only
 * extensions. Use this when you've already narrowed `host.id === "cortex"`.
 */
export type CortexHostPaths = HostPaths & CortexPaths;

/**
 * darwin-launchd-host-only path extensions. Standalone-bot daemons land
 * their plist into the user's `~/Library/LaunchAgents/` directory; arc
 * uses `plistDir` instead of overloading the base `settingsPath` because
 * the plist directory is a *collection*, not a single config file. The
 * binary lands in the base `binDir` field.
 *
 * Same pattern as `CortexPaths` — not promoted to `HostPaths` because no
 * other adapter has a comparable concept (cortex's `personasDir`,
 * `credsDir`; launchd's `plistDir`).
 *
 * See cortex `docs/design-arc-agent-bots.md` §3.2 and arc#140 P2.
 */
export interface LaunchdPaths {
  /** macOS user LaunchAgents directory (~/Library/LaunchAgents/). */
  plistDir: string;
}

/**
 * darwin-launchd host's concrete `paths` shape. Use this when you've
 * already narrowed `host.id === "darwin-launchd"`.
 */
export type DarwinLaunchdHostPaths = HostPaths & LaunchdPaths;

/**
 * linux-systemd-host-only path extensions. Sister to LaunchdPaths for the
 * macOS / Linux OS-supervision split. Standalone-bot daemons land their
 * unit file into the user-scope systemd directory (`~/.config/systemd/user/`).
 *
 * See cortex `docs/design-arc-agent-bots.md` §3.2 platform note and
 * arc#140 P6.
 */
export interface SystemdPaths {
  /** Linux user systemd directory (~/.config/systemd/user/). */
  unitDir: string;
}

/**
 * linux-systemd host's concrete `paths` shape. Use this when you've
 * already narrowed `host.id === "linux-systemd"`.
 */
export type LinuxSystemdHostPaths = HostPaths & SystemdPaths;

/**
 * Host adapter — describes one agentic backend (Claude Code, Codex CLI, Cursor, …).
 *
 * Phase 1 (this PR): interface + Claude-Code default implementation. No dispatch yet.
 * Phase 2: install/remove dispatch moves through `installArtifact()` and `removeArtifact()`.
 * Phase 3: per-host MCP writers (out of scope for #117).
 */
export interface HostAdapter {
  id: HostId;
  /** True when this host is installed/configured on the system. */
  detect(): boolean;
  /** Per-host install paths. */
  paths: HostPaths;
  /**
   * Whether this host *recognizes* the given artifact type.
   *
   * Note: `supports(type) === true` does NOT imply
   * `hostPathFor(host, type) !== null`. Some types (`component`, `rules`,
   * `library`) are recognized but don't install into a host directory —
   * `hostPathFor()` returns `null` for them. The two predicates answer
   * different questions; never bridge them.
   */
  supports(type: ArtifactType): boolean;
}

// ── Bundle and publish types ─────────────────────────────────

/** Bundle exclusion configuration (from arc-manifest.yaml) */
export interface BundleConfig {
  exclude?: string[];
  include?: string[];
}

/** Result of tarball creation */
export interface BundleResult {
  success: boolean;
  tarballPath: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  manifest: ArcManifest;
  warnings: string[];
  error?: string;
}

/** Manifest validation for publishing (stricter than install) */
export interface PublishValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  name: string;
  version: string;
}

/** Result of R2 storage upload */
export interface UploadResult {
  success: boolean;
  sha256: string;
  r2Key: string;
  sizeBytes: number;
  error?: string;
}

/** Result of version registration */
export interface RegisterResult {
  success: boolean;
  versionId?: string;
  submissionId?: string;
  submission?: {
    id?: string;
    status?: string;
    reviewComment?: string | null;
  };
  error?: string;
  statusCode?: number;
}

/** Result of package existence check/creation */
export interface EnsurePackageResult {
  exists: boolean;
  created: boolean;
  error?: string;
}
