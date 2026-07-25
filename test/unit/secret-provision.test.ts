/**
 * Tests for F-6e (arc#229) install-time secret provisioning flow.
 *
 * provisionSecrets — prompt / --from-env / --skip-secrets resolution.
 * validateSecretPresence — which declared secrets are stored vs missing.
 * injectSecretsIntoEnv — retrieve from storage, merge into a child-process env.
 *
 * All exercised with an injected backend + injected prompt so the suite is
 * hermetic. NEVER-LOG: a value must never reach stdout — the prompt is the
 * only ingress and injection the only egress.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FileBackend } from "../../src/lib/secrets.js";
import {
  provisionSecrets,
  validateSecretPresence,
  injectSecretsIntoEnv,
  githubAliasCanonical,
} from "../../src/lib/secret-provision.js";
import type { ArcManifest } from "../../src/types.js";

let tempDir: string;
let secretsRoot: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-secret-provision-test-"));
  secretsRoot = join(tempDir, "secrets");
  await mkdir(secretsRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function manifest(secrets?: string[]): ArcManifest {
  return {
    name: "dev",
    version: "0.1.0",
    type: "agent",
    capabilities: secrets ? { secrets } : undefined,
  };
}

describe("provisionSecrets", () => {
  test("no-op when the manifest declares no secrets", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(), {
      agent: "dev",
      backend,
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("skipSecrets stores nothing and reports all declared as skipped", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["APPROVER_GH_TOKEN"]), {
      agent: "dev",
      backend,
      skipSecrets: true,
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["APPROVER_GH_TOKEN"]);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBeNull();
  });

  test("fromEnv reads existing env vars without prompting", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["APPROVER_GH_TOKEN"]), {
      agent: "dev",
      backend,
      fromEnv: true,
      env: { APPROVER_GH_TOKEN: "gh_pat_from_env" },
    });
    expect(result.stored).toEqual(["APPROVER_GH_TOKEN"]);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBe("gh_pat_from_env");
  });

  test("fromEnv skips a secret absent from the env (reported as skipped)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["CORTEX_DEV_GH_TOKEN"]), {
      agent: "dev",
      backend,
      fromEnv: true,
      env: {},
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["CORTEX_DEV_GH_TOKEN"]);
  });

  test("interactive prompt stores the entered value", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async (name) => {
        expect(name).toBe("GITHUB_TOKEN");
        return "typed-value";
      },
    });
    expect(result.stored).toEqual(["GITHUB_TOKEN"]);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("typed-value");
  });

  test("interactive prompt returning empty string skips that secret", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async () => "", // user pressed Return to skip
    });
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["GITHUB_TOKEN"]);
  });

  test("never echoes a secret value through the result struct keys", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async () => "super-secret-value",
    });
    // The result reports NAMES only — never the value.
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });
});

// ── arc#358: dedupe the GitHub credential prompt ───────────────────────────
// The cortex manifest declares the same GitHub credential under both `GH_TOKEN`
// and `GITHUB_TOKEN` (alternate gh auth vars, same surface). The questionnaire
// must ask ONCE and store the entered value under every declared spelling —
// never prompt twice for one credential.
describe("GitHub credential dedupe (arc#358)", () => {
  test("prompts once for GH_TOKEN/GITHUB_TOKEN aliases and stores both", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    let prompts = 0;
    const result = await provisionSecrets(manifest(["GH_TOKEN", "GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async () => {
        prompts += 1;
        return "ghp_shared";
      },
    });
    expect(prompts).toBe(1); // asked ONCE, not twice
    expect(result.stored).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
    expect(await backend.retrieve("GH_TOKEN")).toBe("ghp_shared");
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("ghp_shared");
  });

  test("skipping the single prompt skips every alias spelling", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    let prompts = 0;
    const result = await provisionSecrets(manifest(["GH_TOKEN", "GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async () => {
        prompts += 1;
        return ""; // Return-to-skip
      },
    });
    expect(prompts).toBe(1);
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
  });

  test("fromEnv seeds every spelling from whichever one is present", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(manifest(["GH_TOKEN", "GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      fromEnv: true,
      env: { GITHUB_TOKEN: "ghp_env" }, // only ONE spelling set
    });
    expect(result.stored).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
    expect(await backend.retrieve("GH_TOKEN")).toBe("ghp_env");
    expect(await backend.retrieve("GITHUB_TOKEN")).toBe("ghp_env");
  });

  test("distinct prefixed GitHub credentials are NOT merged", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const seen: string[] = [];
    await provisionSecrets(manifest(["APPROVER_GH_TOKEN", "GITHUB_TOKEN"]), {
      agent: "dev",
      backend,
      prompt: async (name) => {
        seen.push(name);
        return "v";
      },
    });
    // Two genuinely different credentials → two prompts, never collapsed.
    expect(seen.length).toBe(2);
  });

  test("githubAliasCanonical folds GH↔GITHUB segments only, never substrings", () => {
    expect(githubAliasCanonical("GH_TOKEN")).toBe("GITHUB_TOKEN");
    expect(githubAliasCanonical("GITHUB_TOKEN")).toBe("GITHUB_TOKEN");
    expect(githubAliasCanonical("APPROVER_GH_TOKEN")).toBe("APPROVER_GITHUB_TOKEN");
    expect(githubAliasCanonical("NATS_TOKEN")).toBe("NATS_TOKEN");
    // A distinct prefixed credential must NOT canonicalize to bare GITHUB_TOKEN.
    expect(githubAliasCanonical("APPROVER_GH_TOKEN")).not.toBe("GITHUB_TOKEN");
  });
});

describe("validateSecretPresence", () => {
  test("reports present and missing declared secrets", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("HAVE_TOKEN", "v");
    const report = await validateSecretPresence(
      manifest(["HAVE_TOKEN", "MISSING_TOKEN"]),
      { agent: "dev", backend },
    );
    expect(report.present).toEqual(["HAVE_TOKEN"]);
    expect(report.missing).toEqual(["MISSING_TOKEN"]);
    expect(report.ok).toBe(false);
  });

  test("ok=true when every declared secret is stored", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("HAVE_TOKEN", "v");
    const report = await validateSecretPresence(manifest(["HAVE_TOKEN"]), {
      agent: "dev",
      backend,
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  test("ok=true and empty lists when nothing is declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const report = await validateSecretPresence(manifest(), {
      agent: "dev",
      backend,
    });
    expect(report.ok).toBe(true);
    expect(report.present).toEqual([]);
    expect(report.missing).toEqual([]);
  });
});

describe("injectSecretsIntoEnv", () => {
  test("merges stored secrets into a base env", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("APPROVER_GH_TOKEN", "gh_pat_inject");
    const env = await injectSecretsIntoEnv(manifest(["APPROVER_GH_TOKEN"]), {
      agent: "dev",
      backend,
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.APPROVER_GH_TOKEN).toBe("gh_pat_inject");
  });

  test("omits a declared-but-unstored secret (does not inject undefined)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await injectSecretsIntoEnv(manifest(["MISSING"]), {
      agent: "dev",
      backend,
      baseEnv: {},
    });
    expect("MISSING" in env).toBe(false);
  });

  test("returns the base env unchanged when nothing is declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await injectSecretsIntoEnv(manifest(), {
      agent: "dev",
      backend,
      baseEnv: { FOO: "bar" },
    });
    expect(env).toEqual({ FOO: "bar" });
  });
});

// ── arc#363: object-form capabilities.secrets ──────────────────────────────
// A manifest may declare secrets as the richer object form
// ({ name, reason?, optional? }) that `arc validate` accepts. Before the fix,
// declaredSecrets() returned these objects raw and passed them to the backend,
// crashing with `invalid secret name "[object Object]"`. Both forms must now
// flow through the same NAME-based path.
describe("object-form secrets (arc#363)", () => {
  function objManifest(
    secrets: (string | { name: string; reason?: string; optional?: boolean })[],
  ): ArcManifest {
    return {
      name: "dev",
      version: "0.1.0",
      type: "agent",
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets,
      },
    };
  }

  test("provisionSecrets stores an object-form secret by its NAME (fromEnv)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(
      objManifest([{ name: "LLAMA_CLOUD_API_KEY", reason: "LlamaParse", optional: true }]),
      { agent: "dev", backend, fromEnv: true, env: { LLAMA_CLOUD_API_KEY: "llx-123" } },
    );
    expect(result.stored).toEqual(["LLAMA_CLOUD_API_KEY"]);
    expect(await backend.retrieve("LLAMA_CLOUD_API_KEY")).toBe("llx-123");
  });

  test("mixed string + object forms both provision by NAME", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(
      objManifest(["GITHUB_TOKEN", { name: "LLAMA_CLOUD_API_KEY", optional: true }]),
      {
        agent: "dev",
        backend,
        fromEnv: true,
        env: { GITHUB_TOKEN: "ghp_1", LLAMA_CLOUD_API_KEY: "llx-2" },
      },
    );
    expect(result.stored).toEqual(["GITHUB_TOKEN", "LLAMA_CLOUD_API_KEY"]);
  });

  test("an optional object-form secret absent from env is skipped, never a crash", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const result = await provisionSecrets(
      objManifest([{ name: "LLAMA_CLOUD_API_KEY", optional: true }]),
      { agent: "dev", backend, fromEnv: true, env: {} },
    );
    expect(result.stored).toEqual([]);
    expect(result.skipped).toEqual(["LLAMA_CLOUD_API_KEY"]);
  });

  test("injectSecretsIntoEnv retrieves an object-form secret by NAME (no crash)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("LLAMA_CLOUD_API_KEY", "llx-inject");
    const env = await injectSecretsIntoEnv(
      objManifest([{ name: "LLAMA_CLOUD_API_KEY", optional: true }]),
      { agent: "dev", backend, baseEnv: {} },
    );
    expect(env.LLAMA_CLOUD_API_KEY).toBe("llx-inject");
  });

  test("validateSecretPresence reports an object-form secret by NAME", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("GITHUB_TOKEN", "ghp_present");
    const report = await validateSecretPresence(
      objManifest(["GITHUB_TOKEN", { name: "LLAMA_CLOUD_API_KEY", optional: true }]),
      { agent: "dev", backend },
    );
    expect(report.present).toEqual(["GITHUB_TOKEN"]);
    expect(report.missing).toEqual(["LLAMA_CLOUD_API_KEY"]);
  });
});
