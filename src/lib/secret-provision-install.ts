/**
 * F-6e (arc#229) — install-time secret bridge.
 *
 * Thin glue between `commands/install.ts` and the storage + flow modules
 * (`secrets.ts`, `secret-provision.ts`). Keeps install.ts to two clearly
 * commented hook calls (provision + env-build) at the SECRETS step.
 *
 * Backend selection: Keychain on macOS when the `security` CLI is available,
 * else the chmod-600 FileBackend under `arc.secretsDir/<agent>/`. The agent
 * scope is the manifest name (an installed `type: agent` package's name is its
 * agent id; dev-loop's agents install as named library artifacts).
 *
 * NEVER-LOG (issue §E): nothing here logs a value. Skip warnings list NAMES.
 */

import { homedir, userInfo } from "os";
import type { ArcManifest, ArcPaths } from "../types.js";
import {
  normalizeDeclaredSecrets,
  resolveSecretBackend,
  type SecretBackend,
  type SecretBackendChoice,
} from "./secrets.js";
import {
  provisionSecrets,
  injectSecretsIntoEnv,
} from "./secret-provision.js";

/** Resolve the storage backend for a manifest's agent scope. */
export function backendForManifest(
  manifest: ArcManifest,
  arc: ArcPaths,
  overrides?: {
    platform?: string;
    username?: string;
    backend?: SecretBackend;
    backendChoice?: SecretBackendChoice;
  },
): SecretBackend {
  if (overrides?.backend) return overrides.backend;
  return resolveSecretBackend(manifest.name, {
    platform: overrides?.platform ?? process.platform,
    secretsRoot: arc.secretsDir,
    username: overrides?.username ?? safeUsername(),
    backendChoice: overrides?.backendChoice,
  });
}

/** Best-effort current username for Keychain account scoping. */
function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    // userInfo throws on some sandboxes with no passwd entry — fall back to a
    // stable, non-secret value (the home dir basename). Never throws.
    return homedir().split("/").filter(Boolean).pop() ?? "user";
  }
}

/** Outcome of the install-time SECRETS step. */
export interface SecretStepResult {
  success: boolean;
  error?: string;
  /** Stored secret NAMES (never values). */
  stored: string[];
  /** Declared-but-unstored NAMES (skip / from-env-absent / empty input). */
  skipped: string[];
}

/** Options for {@link installTimeProvisionSecrets}. */
export interface InstallSecretStepOpts {
  arc: ArcPaths;
  skipSecrets?: boolean;
  fromEnv?: boolean;
  quiet?: boolean;
  /** Test seams — injected platform / username / backend / env / prompt. */
  platform?: string;
  username?: string;
  backend?: SecretBackend;
  env?: Record<string, string | undefined>;
  prompt?: (name: string) => Promise<string>;
  /**
   * `--secret-backend` override. MUST match the choice used by
   * {@link buildSecretEnvForInstall} for the same install, or a secret stored
   * to one backend won't be retrieved from the other.
   */
  backendChoice?: SecretBackendChoice;
}

/**
 * The install.ts SECRETS hook: provision the manifest's declared secrets and
 * surface a skip warning. Fail-closed-loud: a storage failure returns
 * `success: false` so the install aborts cleanly; a skip just WARNs (the
 * daemon will fail at first use with a clear message — issue §A.4).
 */
export async function installTimeProvisionSecrets(
  manifest: ArcManifest,
  opts: InstallSecretStepOpts,
): Promise<SecretStepResult> {
  const declared = normalizeDeclaredSecrets(manifest.capabilities?.secrets);
  if (declared.length === 0) {
    return { success: true, stored: [], skipped: [] };
  }

  // arc#358: announce the storage mechanism BEFORE the first prompt so the
  // questionnaire is not opaque — the operator should know these values are
  // stored via `arc secrets <pkg>`, that any can be skipped, and that they can
  // be added later. Only on the interactive prompt path (`--from-env` /
  // `--skip-secrets` don't prompt, and `quiet` suppresses install chatter).
  if (!opts.quiet && !opts.skipSecrets && !opts.fromEnv) {
    console.log(
      `\nThis package will now ask for its secrets, stored via \`arc secrets ${manifest.name}\`. ` +
        `Press Return to skip any you don't have — you can add them later with ` +
        `\`arc secrets set ${manifest.name} <name>\`.`,
    );
  }

  try {
    // arc#412 — CONSTRUCTION IS PART OF THE FALLIBLE WORK, here too. Both
    // backends `assertAgentName` in their constructor, so a manifest whose name
    // is not a package-name slug (a scoped `@scope/pkg`) throws from `new
    // FileBackend`. Built outside this try, that throw escaped
    // `installTimeProvisionSecrets` entirely and crashed `arc install` — past
    // the fail-closed-loud contract documented above, and past install's own
    // postinstall rollback (arc#373). Inside it, the same failure returns the
    // clean `success: false` the caller already knows how to unwind.
    //
    // Unlike the purge path (which degrades — a namespace that cannot be opened
    // has nothing to clear), install FAILS CLOSED: a declared secret that cannot
    // be stored is a real, unmet install requirement.
    const backend = backendForManifest(manifest, opts.arc, {
      platform: opts.platform,
      username: opts.username,
      backend: opts.backend,
      backendChoice: opts.backendChoice,
    });

    const result = await provisionSecrets(manifest, {
      agent: manifest.name,
      backend,
      skipSecrets: opts.skipSecrets,
      fromEnv: opts.fromEnv,
      env: opts.env,
      prompt: opts.prompt,
      quiet: opts.quiet,
    });

    // An OPTIONAL declared secret that goes unprovisioned is expected, not a
    // gap — it must never fail install AND must not raise the loud "will fail
    // at first use" warning (arc#363). Only REQUIRED skips warn.
    const declaredByName = new Map(declared.map((d) => [d.name, d] as const));
    const optionalNames = new Set(declared.filter((d) => d.optional).map((d) => d.name));
    const requiredSkipped = result.skipped.filter((name) => !optionalNames.has(name));
    const optionalSkippedCount = result.skipped.filter((name) => optionalNames.has(name)).length;

    if (!opts.quiet && requiredSkipped.length > 0) {
      // arc#358: the old warning was a bare comma-joined name list with zero
      // context. Give each unmet secret its own line with a purpose (the
      // manifest's declared `reason`) and a needed-now marker, plus the storage
      // mechanism (matching the pre-prompt banner) so a solo/MVP operator can
      // act. Loud, not silent — these DO fail at first use.
      //
      // OPTIONAL skips are NEVER named here (arc#363 — they don't fail at first
      // use); we only note HOW MANY were skipped so the operator sees at a
      // glance that the rest are safe to leave unset. NAMES only, never values.
      const lines: string[] = [
        `  ⚠ ${manifest.name}: ${requiredSkipped.length} secret(s) needed now are not set — ` +
          `the agent will fail at first use until you set them.`,
        `    Stored via \`arc secrets\`; add any later with \`arc secrets set ${manifest.name} <name>\`.`,
      ];
      for (const name of requiredSkipped) {
        const reason = declaredByName.get(name)?.reason;
        lines.push(`    • ${name} [needed now]${reason ? ` — ${reason}` : ""}`);
      }
      if (optionalSkippedCount > 0) {
        lines.push(
          `    (${optionalSkippedCount} optional secret(s) also unset — safe to leave; ` +
            `add later if you use those features.)`,
        );
      }
      console.warn(lines.join("\n"));
    }

    return { success: true, stored: result.stored, skipped: result.skipped };
  } catch (err) {
    // errorMessage is name-scoped (the storage layer never embeds a value).
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Secret provisioning failed: ${message}`,
      stored: [],
      skipped: declared.map((d) => d.name),
    };
  }
}

/**
 * Build the postinstall env for a manifest: arc's process env plus the agent's
 * stored secrets. A fresh object scoped to the child invocation; arc's own
 * process env is never mutated, so the secrets are gone when postinstall exits
 * (issue §E "unset after postinstall").
 */
export async function buildSecretEnvForInstall(
  manifest: ArcManifest,
  opts: {
    arc: ArcPaths;
    platform?: string;
    username?: string;
    backend?: SecretBackend;
    baseEnv?: Record<string, string>;
    backendChoice?: SecretBackendChoice;
  },
): Promise<Record<string, string>> {
  const declared = normalizeDeclaredSecrets(manifest.capabilities?.secrets);
  // The runScript runner already spreads `process.env` first, then `opts.env`.
  // We pass ONLY the secrets here so we never re-materialize the whole
  // environment into a logged object — runScript merges it in.
  const baseEnv = opts.baseEnv ?? {};
  if (declared.length === 0) return baseEnv;

  const backend = backendForManifest(manifest, opts.arc, {
    platform: opts.platform,
    username: opts.username,
    backend: opts.backend,
    backendChoice: opts.backendChoice,
  });

  return injectSecretsIntoEnv(manifest, {
    agent: manifest.name,
    backend,
    baseEnv,
  });
}
