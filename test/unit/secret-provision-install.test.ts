/**
 * Tests for F-6e (arc#229) install-time secret bridge
 * (`secret-provision-install.ts`) — the glue install.ts calls at the SECRETS
 * step. Hermetic via an injected FileBackend.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FileBackend } from "../../src/lib/secrets.js";
import {
  installTimeProvisionSecrets,
  buildSecretEnvForInstall,
} from "../../src/lib/secret-provision-install.js";
import type { ArcManifest, ArcPaths } from "../../src/types.js";

let tempDir: string;
let secretsRoot: string;
let arc: ArcPaths;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "arc-secret-install-test-"));
  secretsRoot = join(tempDir, "secrets");
  await mkdir(secretsRoot, { recursive: true });
  // Only secretsDir is read by the bridge; stub the rest minimally.
  arc = { secretsDir: secretsRoot } as unknown as ArcPaths;
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

describe("installTimeProvisionSecrets", () => {
  test("no-op success when no secrets declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const r = await installTimeProvisionSecrets(manifest(), { arc, backend, quiet: true });
    expect(r.success).toBe(true);
    expect(r.stored).toEqual([]);
  });

  test("fromEnv stores declared secrets and reports names only", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const r = await installTimeProvisionSecrets(manifest(["APPROVER_GH_TOKEN"]), {
      arc,
      backend,
      fromEnv: true,
      env: { APPROVER_GH_TOKEN: "gh_pat_value" },
      quiet: true,
    });
    expect(r.success).toBe(true);
    expect(r.stored).toEqual(["APPROVER_GH_TOKEN"]);
    expect(await backend.retrieve("APPROVER_GH_TOKEN")).toBe("gh_pat_value");
    expect(JSON.stringify(r)).not.toContain("gh_pat_value");
  });

  test("skipSecrets stores nothing and reports the declared as skipped", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const r = await installTimeProvisionSecrets(manifest(["GITHUB_TOKEN"]), {
      arc,
      backend,
      skipSecrets: true,
      quiet: true,
    });
    expect(r.success).toBe(true);
    expect(r.skipped).toEqual(["GITHUB_TOKEN"]);
    expect(await backend.retrieve("GITHUB_TOKEN")).toBeNull();
  });

  test("a backend store failure aborts the step (fail-closed)", async () => {
    const failing = new FileBackend(secretsRoot, "dev");
    failing.store = () => Promise.reject(new Error("boom"));
    const r = await installTimeProvisionSecrets(manifest(["GITHUB_TOKEN"]), {
      arc,
      backend: failing,
      fromEnv: true,
      env: { GITHUB_TOKEN: "v" },
      quiet: true,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Secret provisioning failed");
  });

  /**
   * arc#412 — the backend CONSTRUCTOR is fallible (`assertAgentName`), and it
   * used to run outside this function's try. A manifest with a scoped name
   * therefore crashed `arc install` with an unhandled throw instead of the
   * fail-closed-loud result the caller unwinds cleanly (and rolls back per
   * arc#373). Install still FAILS here — a declared secret it cannot store is a
   * genuinely unmet requirement — it just fails as a value, not as a crash.
   */
  test("an unbuildable backend fails closed rather than throwing (#412)", async () => {
    const scoped: ArcManifest = {
      name: "@the-metafactory/compass-core",
      version: "0.1.0",
      type: "agent",
      capabilities: { secrets: ["GITHUB_TOKEN"] },
    };

    // No injected backend: this must exercise the REAL construction.
    const r = await installTimeProvisionSecrets(scoped, {
      arc,
      platform: "linux", // FileBackend — no host keychain involved
      username: "tester",
      fromEnv: true,
      env: { GITHUB_TOKEN: "gh_pat_value" },
      quiet: true,
    });

    expect(r.success).toBe(false);
    expect(r.error).toContain("Secret provisioning failed");
    expect(r.error).toContain("invalid agent name");
    expect(r.stored).toEqual([]);
    expect(r.skipped).toEqual(["GITHUB_TOKEN"]);
    expect(JSON.stringify(r)).not.toContain("gh_pat_value");
  });
});

describe("buildSecretEnvForInstall", () => {
  test("merges stored secrets into the (empty) base env", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("APPROVER_GH_TOKEN", "gh_pat_inject");
    const env = await buildSecretEnvForInstall(manifest(["APPROVER_GH_TOKEN"]), {
      arc,
      backend,
    });
    expect(env.APPROVER_GH_TOKEN).toBe("gh_pat_inject");
  });

  test("returns the base env unchanged when nothing declared", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await buildSecretEnvForInstall(manifest(), {
      arc,
      backend,
      baseEnv: { FOO: "bar" },
    });
    expect(env).toEqual({ FOO: "bar" });
  });

  test("omits a declared-but-unstored secret", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const env = await buildSecretEnvForInstall(manifest(["MISSING"]), {
      arc,
      backend,
    });
    expect("MISSING" in env).toBe(false);
  });
});

// ── arc#363: object-form secrets + optional-missing warning discipline ──────
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

  test("installTimeProvisionSecrets stores an object-form secret by NAME", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const r = await installTimeProvisionSecrets(
      objManifest([{ name: "LLAMA_CLOUD_API_KEY", reason: "LlamaParse", optional: true }]),
      { arc, backend, fromEnv: true, env: { LLAMA_CLOUD_API_KEY: "llx-1" }, quiet: true },
    );
    expect(r.success).toBe(true);
    expect(r.stored).toEqual(["LLAMA_CLOUD_API_KEY"]);
    expect(await backend.retrieve("LLAMA_CLOUD_API_KEY")).toBe("llx-1");
  });

  test("buildSecretEnvForInstall retrieves object-form secret by NAME (no crash)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    await backend.store("LLAMA_CLOUD_API_KEY", "llx-env");
    const env = await buildSecretEnvForInstall(
      objManifest([{ name: "LLAMA_CLOUD_API_KEY", optional: true }]),
      { arc, backend, baseEnv: {} },
    );
    expect(env.LLAMA_CLOUD_API_KEY).toBe("llx-env");
  });

  test("a missing OPTIONAL secret succeeds and emits NO required-fail warning", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const r = await installTimeProvisionSecrets(
        objManifest([{ name: "LLAMA_CLOUD_API_KEY", optional: true }]),
        { arc, backend, fromEnv: true, env: {}, quiet: false },
      );
      expect(r.success).toBe(true);
      expect(r.skipped).toEqual(["LLAMA_CLOUD_API_KEY"]);
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.join("\n")).not.toContain("LLAMA_CLOUD_API_KEY");
  });

  test("a missing REQUIRED secret still warns (loud, not silent)", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const r = await installTimeProvisionSecrets(
        objManifest(["GITHUB_TOKEN", { name: "LLAMA_CLOUD_API_KEY", optional: true }]),
        { arc, backend, fromEnv: true, env: {}, quiet: false },
      );
      expect(r.success).toBe(true);
    } finally {
      console.warn = origWarn;
    }
    const joined = warnings.join("\n");
    expect(joined).toContain("GITHUB_TOKEN");
    // The optional one must NOT appear in the loud warning even when a required
    // sibling triggers it.
    expect(joined).not.toContain("LLAMA_CLOUD_API_KEY");
  });
});

// ── arc#358: questionnaire clarity — banner + explanatory warning ──────────
describe("secrets questionnaire clarity (arc#358)", () => {
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

  test("announces the storage mechanism BEFORE the first prompt", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      await installTimeProvisionSecrets(manifest(["GITHUB_TOKEN"]), {
        arc,
        backend,
        quiet: false,
        // Interactive path (no --from-env / --skip-secrets); skip so the test
        // never blocks on a real prompt.
        prompt: async () => "",
      });
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("arc secrets dev");
    expect(joined).toContain("arc secrets set dev <name>");
    // The banner precedes any per-secret "✓ Secret stored" line.
    expect(joined).toContain("skip");
  });

  test("no banner on the non-interactive --from-env path", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
    try {
      await installTimeProvisionSecrets(manifest(["GITHUB_TOKEN"]), {
        arc,
        backend,
        fromEnv: true,
        env: { GITHUB_TOKEN: "v" },
        quiet: false,
      });
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).not.toContain("arc secrets set dev");
  });

  test("warning carries a per-entry purpose + needed-now marker", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      await installTimeProvisionSecrets(
        objManifest([
          { name: "GH_TOKEN", reason: "cloud deploy + gh sync" },
          { name: "NATS_TOKEN", reason: "relay bus auth" },
        ]),
        { arc, backend, fromEnv: true, env: {}, quiet: false },
      );
    } finally {
      console.warn = origWarn;
    }
    const joined = warnings.join("\n");
    expect(joined).toContain("GH_TOKEN");
    expect(joined).toContain("cloud deploy + gh sync");
    expect(joined).toContain("NATS_TOKEN");
    expect(joined).toContain("relay bus auth");
    expect(joined).toContain("needed now");
    expect(joined).toContain("arc secrets set dev <name>");
  });

  test("optional skips are counted, never named, in the warning", async () => {
    const backend = new FileBackend(secretsRoot, "dev");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      await installTimeProvisionSecrets(
        objManifest([
          { name: "GH_TOKEN", reason: "cloud deploy" },
          { name: "LLAMA_CLOUD_API_KEY", reason: "LlamaParse", optional: true },
        ]),
        { arc, backend, fromEnv: true, env: {}, quiet: false },
      );
    } finally {
      console.warn = origWarn;
    }
    const joined = warnings.join("\n");
    expect(joined).toContain("1 optional secret(s) also unset");
    // The optional secret's NAME must never appear (arc#363 discipline).
    expect(joined).not.toContain("LLAMA_CLOUD_API_KEY");
  });
});
