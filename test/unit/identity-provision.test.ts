import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, readFile, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  agentDidFromId,
  nkeyPathForAgent,
  instanceDirForAgent,
  provisionSidecarPathForAgent,
  provisionAgentIdentity,
  maybeProvisionAgentIdentity,
  reportProvisioningResult,
} from "../../src/lib/identity-provision.js";

/** Capture everything written to process.stderr during `fn`. */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return buf;
}

async function sandbox(): Promise<{
  root: string;
  natsDir: string;
  agentsDir: string;
  sidecarDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "arc-f6b-"));
  return {
    root,
    natsDir: join(root, "nats"),
    agentsDir: join(root, "agents"),
    sidecarDir: join(root, "sidecar"),
  };
}

/** Read + parse an agent's provisioning sidecar JSON. */
function readSidecar(sidecarDir: string, agentId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sidecarDir, `${agentId}.provision.json`), "utf-8"));
}

function readMetadata(instanceDir: string): Record<string, string> {
  const db = new Database(join(instanceDir, "state.sqlite"), { readonly: true });
  try {
    const rows = db
      .query("SELECT key, value FROM provisioning_metadata")
      .all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } finally {
    db.close();
  }
}

describe("agentDidFromId", () => {
  test("derives did:mf:<id> with no principal segment", () => {
    expect(agentDidFromId("forge")).toBe("did:mf:forge");
    expect(agentDidFromId("dev")).toBe("did:mf:dev");
    expect(agentDidFromId("approver")).toBe("did:mf:approver");
  });
});

describe("path resolution", () => {
  test("nkeyPathForAgent honors override base", () => {
    expect(nkeyPathForAgent("forge", "/tmp/nats")).toBe("/tmp/nats/forge.nk");
  });
  test("instanceDirForAgent honors override base", () => {
    expect(instanceDirForAgent("forge", "/tmp/agents")).toBe("/tmp/agents/forge");
  });
  test("provisionSidecarPathForAgent honors override base", () => {
    expect(provisionSidecarPathForAgent("forge", "/tmp/sidecar")).toBe(
      "/tmp/sidecar/forge.provision.json",
    );
  });
  test("default nkey path lives under ~/.config/nats", () => {
    expect(nkeyPathForAgent("forge")).toMatch(/\.config\/nats\/forge\.nk$/);
  });
  test("default sidecar path lives under ~/.config/metafactory/agents", () => {
    expect(provisionSidecarPathForAgent("forge")).toMatch(
      /\.config\/metafactory\/agents\/forge\.provision\.json$/,
    );
  });
});

describe("provisionAgentIdentity — happy path (stateful, opt-in)", () => {
  test("creates NKey seed (chmod 600), scaffolds state, records metadata + sidecar", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");

    const result = await provisionAgentIdentity({
      agentId: "forge",
      scaffoldState: true,
      instanceDir,
      natsDir,
      sidecarDir,
      quiet: true,
    });

    expect(result.provisioned).toBe(true);
    expect(result.stateScaffolded).toBe(true);
    expect(result.did).toBe("did:mf:forge");
    expect(result.warning).toBeUndefined();

    // NKey seed exists at the canonical path with mode 600.
    const seedPath = join(natsDir, "forge.nk");
    expect(result.nkeySeedPath).toBe(seedPath);
    expect(existsSync(seedPath)).toBe(true);
    const seedStat = await stat(seedPath);
    expect(seedStat.mode & 0o777).toBe(0o600);
    // The seed content is an NKey user seed ('SU…' prefix).
    const seed = (await readFile(seedPath, "utf-8")).trim();
    expect(seed.startsWith("SU")).toBe(true);
    // Pubkey is derived self-contained ('U…' prefix) and returned.
    expect(result.nkeyPub.startsWith("U")).toBe(true);

    // Instance-state scaffold — four-folder layout.
    expect(result.instanceDir).toBe(instanceDir);
    expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(true);
    expect(existsSync(join(instanceDir, "dashboard.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "context", "repos.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "context", "channels.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "retros"))).toBe(true);

    // state.sqlite metadata records provisioning facts (kept for stateful agents).
    const meta = readMetadata(instanceDir);
    expect(meta.provisioned).toBe("1");
    expect(meta.did).toBe("did:mf:forge");
    expect(meta.nkey_seed_path).toBe(seedPath);
    expect(meta.nkey_pub).toBe(result.nkeyPub);
    expect(meta.provisioned_at).toBeTruthy();

    // Sidecar is the canonical record — written, chmod 600, state_scaffolded true.
    const sidecarPath = join(sidecarDir, "forge.provision.json");
    expect(result.sidecarPath).toBe(sidecarPath);
    expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
    const sidecar = readSidecar(sidecarDir, "forge");
    expect(sidecar.provisioned).toBe(true);
    expect(sidecar.did).toBe("did:mf:forge");
    expect(sidecar.nkey_seed_path).toBe(seedPath);
    expect(sidecar.nkey_pub).toBe(result.nkeyPub);
    expect(sidecar.state_scaffolded).toBe(true);
    expect(sidecar.instance_dir).toBe(instanceDir);
  });
});

describe("provisionAgentIdentity — stateless (default, no opt-in)", () => {
  test("provisions identity + sidecar but creates NO instance dir", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");

    const result = await provisionAgentIdentity({
      agentId: "forge",
      // scaffoldState omitted → stateless
      instanceDir, // provided but must be ignored
      natsDir,
      sidecarDir,
      quiet: true,
    });

    expect(result.provisioned).toBe(true);
    expect(result.stateScaffolded).toBe(false);
    expect(result.warning).toBeUndefined();

    // Identity still provisioned — NKey seed exists, chmod 600.
    const seedPath = join(natsDir, "forge.nk");
    expect(existsSync(seedPath)).toBe(true);
    expect((await stat(seedPath)).mode & 0o777).toBe(0o600);
    expect(result.nkeyPub.startsWith("U")).toBe(true);

    // NO instance dir created at all — result reports an empty instanceDir.
    expect(result.instanceDir).toBe("");
    expect(existsSync(instanceDir)).toBe(false);

    // Sidecar IS written (canonical record for every agent), state_scaffolded false.
    const sidecar = readSidecar(sidecarDir, "forge");
    expect(sidecar.provisioned).toBe(true);
    expect(sidecar.did).toBe("did:mf:forge");
    expect(sidecar.state_scaffolded).toBe(false);
    expect(sidecar.instance_dir).toBeUndefined();

    // Action log records the state scaffold was intentionally skipped.
    expect(result.actions.find((a) => a.what === "instance-state")?.kind).toBe("skipped");
  });

  test("stateless re-run is idempotent (seed reused, sidecar re-written)", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");

    const first = await provisionAgentIdentity({ agentId: "forge", instanceDir, natsDir, sidecarDir, quiet: true });
    const seedBefore = await readFile(first.nkeySeedPath, "utf-8");

    const second = await provisionAgentIdentity({ agentId: "forge", instanceDir, natsDir, sidecarDir, quiet: true });
    expect(second.provisioned).toBe(true);
    expect(second.stateScaffolded).toBe(false);
    expect(await readFile(second.nkeySeedPath, "utf-8")).toBe(seedBefore);
    expect(second.actions.find((a) => a.what === "nkey-seed")?.kind).toBe("skipped");
    expect(second.actions.find((a) => a.what === "provision-sidecar")?.kind).toBe("updated");
    expect(existsSync(instanceDir)).toBe(false);
  });
});

describe("provisionAgentIdentity — idempotency (Rule 2, stateful)", () => {
  test("second run reuses the seed and skips operator-edited files", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");

    const first = await provisionAgentIdentity({ agentId: "forge", scaffoldState: true, instanceDir, natsDir, sidecarDir, quiet: true });
    const seedBefore = await readFile(first.nkeySeedPath, "utf-8");

    // Operator edits dashboard.md — must survive a re-run.
    const dashboardPath = join(instanceDir, "dashboard.md");
    await Bun.write(dashboardPath, "# operator-edited dashboard\n");

    const second = await provisionAgentIdentity({ agentId: "forge", scaffoldState: true, instanceDir, natsDir, sidecarDir, quiet: true });

    expect(second.provisioned).toBe(true);
    // Seed is byte-identical (reused, not regenerated).
    const seedAfter = await readFile(second.nkeySeedPath, "utf-8");
    expect(seedAfter).toBe(seedBefore);
    // Re-run reports the seed as skipped/exists.
    expect(second.actions.find((a) => a.what === "nkey-seed")?.kind).toBe("skipped");
    // Operator-edited dashboard is untouched.
    expect(await readFile(dashboardPath, "utf-8")).toBe("# operator-edited dashboard\n");
  });
});

describe("provisionAgentIdentity — fail-closed (Rule 1, arc#281 sidecar anchor)", () => {
  test("invalid agent id is refused, nothing written", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const result = await provisionAgentIdentity({
      agentId: "Bad_ID",
      scaffoldState: true,
      instanceDir: join(agentsDir, "bad"),
      natsDir,
      sidecarDir,
      quiet: true,
    });
    expect(result.provisioned).toBe(false);
    expect(result.warning).toContain("invalid agent id");
    expect(existsSync(join(natsDir, "Bad_ID.nk"))).toBe(false);
    expect(existsSync(join(sidecarDir, "Bad_ID.provision.json"))).toBe(false);
  });

  test("uncreatable SIDECAR dir refuses to wire identity (no orphan seed)", async () => {
    // arc#281: identity now anchors to the arc-owned sidecar dir, not the
    // (optional) instance dir. A sidecar dir that can't be created trips Rule 1.
    const { natsDir, agentsDir, root } = await sandbox();
    const lockedParent = join(root, "locked");
    await Bun.write(join(lockedParent, ".keep"), "");
    await chmod(lockedParent, 0o500);
    try {
      const sidecarDir = join(lockedParent, "child", "sidecar");
      const result = await provisionAgentIdentity({
        agentId: "forge",
        scaffoldState: true,
        instanceDir: join(agentsDir, "forge"),
        natsDir,
        sidecarDir,
        quiet: true,
      });
      expect(result.provisioned).toBe(false);
      expect(result.warning).toMatch(/cannot create agent provisioning dir|refusing to wire identity/);
      // Fail-closed: no NKey seed orphaned when the anchor can't be created.
      expect(existsSync(join(natsDir, "forge.nk"))).toBe(false);
    } finally {
      await chmod(lockedParent, 0o700); // allow cleanup
    }
  });

  test("opted-in state but uncreatable instance dir fails closed — NO orphan seed", async () => {
    // arc#281 fix: the instance dir is pre-flighted BEFORE seed generation, so a
    // stateful agent whose instance dir is unwritable fails closed with NO seed,
    // NO state.sqlite, and NO sidecar left orphaned (cortex#563 orphan-prevention).
    const { natsDir, sidecarDir, root } = await sandbox();
    const lockedParent = join(root, "locked");
    await Bun.write(join(lockedParent, ".keep"), "");
    await chmod(lockedParent, 0o500);
    try {
      const instanceDir = join(lockedParent, "child", "forge");
      const result = await provisionAgentIdentity({
        agentId: "forge",
        scaffoldState: true,
        instanceDir,
        natsDir,
        sidecarDir,
        quiet: true,
      });
      expect(result.provisioned).toBe(false);
      expect(result.warning).toMatch(/cannot create agent instance dir|scaffold could not be laid down/);
      // Fail-closed: nothing written anywhere — no seed, no state, no sidecar.
      expect(existsSync(join(natsDir, "forge.nk"))).toBe(false);
      expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(false);
      expect(existsSync(join(sidecarDir, "forge.provision.json"))).toBe(false);
    } finally {
      await chmod(lockedParent, 0o700);
    }
  });

  test("legacy stateful dir on disk + stateless re-install records legacy reality", async () => {
    // A pre-#281 stateful agent re-installed WITHOUT a manifest `state` field:
    // its existing instance dir + state.sqlite must be reflected in the sidecar
    // (state_scaffolded true + legacy marker), not misrepresented as absent.
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");

    // First: a stateful provision lays down the instance dir + state.sqlite.
    await provisionAgentIdentity({ agentId: "forge", scaffoldState: true, instanceDir, natsDir, sidecarDir, quiet: true });
    expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(true);

    // Then: a stateless re-install (no scaffoldState) with the SAME instance dir.
    const second = await provisionAgentIdentity({ agentId: "forge", instanceDir, natsDir, sidecarDir, quiet: true });
    expect(second.provisioned).toBe(true);
    // Result still reports stateScaffolded false (no opt-in this run)…
    expect(second.stateScaffolded).toBe(false);
    // …but the sidecar reflects the legacy dir honestly.
    const sidecar = readSidecar(sidecarDir, "forge");
    expect(sidecar.state_scaffolded).toBe(true);
    expect(sidecar.instance_dir).toBe(instanceDir);
    expect(sidecar.legacy_instance_state).toBe(true);
  });
});

describe("maybeProvisionAgentIdentity — install.ts hook", () => {
  /**
   * Run `fn` with the three sandbox env overrides set (and restored after), so
   * seeds/instances/sidecars never touch the real ~/.config.
   */
  async function withSandboxEnv(
    env: { natsDir: string; instanceDir: string; sidecarDir: string; agentId?: string },
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = {
      instance: process.env.MF_INSTANCE_DIR,
      nats: process.env.MF_NATS_DIR,
      sidecar: process.env.MF_SIDECAR_DIR,
      agent: process.env.MF_AGENT_ID,
    };
    try {
      process.env.MF_INSTANCE_DIR = env.instanceDir;
      process.env.MF_NATS_DIR = env.natsDir;
      process.env.MF_SIDECAR_DIR = env.sidecarDir;
      if (env.agentId !== undefined) process.env.MF_AGENT_ID = env.agentId;
      await fn();
    } finally {
      // Restore by DELETING what was originally unset.
      //
      // This used to assign `undefined` and lean on bun's process.env proxy to
      // unset the variable. Bun 1.4.0 stringifies instead, so the restore set
      // `MF_AGENT_ID="undefined"` — a perfectly legal agent id — and leaked it
      // into every later test in the process: agent ids resolved to
      // "undefined", seeds landed at `undefined.nk`, and eight tests across
      // this file, install-identity-f6b, and install-library-botpack-fanout
      // failed on CI while passing on any machine still running bun 1.3.x.
      // The guarded form below is what the sibling test files already use and
      // does not depend on the proxy's behaviour either way.
      //
      // Spelled out per key rather than through a helper: a dynamic
      // `delete process.env[key]` trips @typescript-eslint/no-dynamic-delete,
      // which is what pushed the original to the `= undefined` shortcut in the
      // first place. The sibling test files spell it out the same way.
      if (prev.instance === undefined) delete process.env.MF_INSTANCE_DIR;
      else process.env.MF_INSTANCE_DIR = prev.instance;
      if (prev.nats === undefined) delete process.env.MF_NATS_DIR;
      else process.env.MF_NATS_DIR = prev.nats;
      if (prev.sidecar === undefined) delete process.env.MF_SIDECAR_DIR;
      else process.env.MF_SIDECAR_DIR = prev.sidecar;
      if (prev.agent === undefined) delete process.env.MF_AGENT_ID;
      else process.env.MF_AGENT_ID = prev.agent;
    }
  }

  test("the sandbox helper leaves no env residue behind (arc#396 CI regression guard)", async () => {
    // The leak above was invisible to every assertion in this file: each test
    // sandboxes its own dirs, so a stale MF_AGENT_ID only shows up as a
    // baffling failure somewhere downstream. Assert the helper's own contract.
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const before = process.env.MF_AGENT_ID;
    await withSandboxEnv(
      { natsDir, instanceDir: join(agentsDir, "residue"), sidecarDir, agentId: "residue" },
      async () => {
        expect(process.env.MF_AGENT_ID).toBe("residue");
      },
    );
    expect(process.env.MF_AGENT_ID).toBe(before);
    if (before === undefined) {
      // Not just falsy — the key must be GONE, never the string "undefined".
      expect("MF_AGENT_ID" in process.env).toBe(false);
    }
    for (const key of ["MF_INSTANCE_DIR", "MF_NATS_DIR", "MF_SIDECAR_DIR"]) {
      expect(process.env[key]).not.toBe("undefined");
    }
  });

  test("no-op for non-agent packages", async () => {
    expect(await maybeProvisionAgentIdentity({ type: "skill", name: "Thinking" })).toBeNull();
  });

  test("agent WITH state scaffolds instance (honors MF_INSTANCE_DIR + MF_SIDECAR_DIR)", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");
    await withSandboxEnv({ natsDir, instanceDir, sidecarDir }, async () => {
      const result = await maybeProvisionAgentIdentity(
        {
          type: "agent",
          name: "Forge Bot",
          identity: { id: "forge", displayName: "Forge" },
          state: { blueprint: "AgentState", version: ">=0.1.0" },
        },
        { quiet: true },
      );
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe("forge");
      expect(result!.did).toBe("did:mf:forge");
      expect(result!.stateScaffolded).toBe(true);
      expect(result!.instanceDir).toBe(instanceDir);
      expect(result!.nkeySeedPath).toBe(join(natsDir, "forge.nk"));
      expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(true);
      expect(existsSync(join(natsDir, "forge.nk"))).toBe(true);
      const meta = readMetadata(instanceDir);
      expect(meta.did).toBe("did:mf:forge");
      expect(readSidecar(sidecarDir, "forge").state_scaffolded).toBe(true);
    });
  });

  test("agent WITHOUT state is stateless — no instance dir, sidecar still written", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");
    await withSandboxEnv({ natsDir, instanceDir, sidecarDir }, async () => {
      const result = await maybeProvisionAgentIdentity(
        { type: "agent", name: "Forge Bot", identity: { id: "forge" } },
        { quiet: true },
      );
      expect(result!.stateScaffolded).toBe(false);
      expect(result!.instanceDir).toBe("");
      expect(existsSync(instanceDir)).toBe(false);
      // Identity + sidecar still provisioned.
      expect(existsSync(join(natsDir, "forge.nk"))).toBe(true);
      expect(readSidecar(sidecarDir, "forge").state_scaffolded).toBe(false);
    });
  });

  test("state: null (bare `state:` YAML) does NOT opt into the scaffold", async () => {
    // Defense-in-depth against the gate: even if a null `state` reaches the hook
    // (e.g. a caller bypassing the manifest loader), `!= null` keeps it stateless.
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "forge");
    await withSandboxEnv({ natsDir, instanceDir, sidecarDir }, async () => {
      const result = await maybeProvisionAgentIdentity(
        { type: "agent", name: "Forge Bot", identity: { id: "forge" }, state: null },
        { quiet: true },
      );
      expect(result!.stateScaffolded).toBe(false);
      expect(existsSync(instanceDir)).toBe(false);
    });
  });

  test("MF_AGENT_ID overrides the manifest id", async () => {
    const { agentsDir, natsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "override");
    await withSandboxEnv({ natsDir, instanceDir, sidecarDir, agentId: "override" }, async () => {
      const result = await maybeProvisionAgentIdentity(
        { type: "agent", name: "Some Agent", identity: { id: "ignored" } },
        { quiet: true },
      );
      expect(result!.agentId).toBe("override");
      expect(result!.did).toBe("did:mf:override");
    });
  });

  test("falls back to a slug of manifest.name when no id is declared", async () => {
    const { agentsDir, natsDir, sidecarDir } = await sandbox();
    const instanceDir = join(agentsDir, "dev-loop-bot");
    await withSandboxEnv({ natsDir, instanceDir, sidecarDir }, async () => {
      const result = await maybeProvisionAgentIdentity(
        { type: "agent", name: "Dev Loop Bot" },
        { quiet: true },
      );
      expect(result!.agentId).toBe("dev-loop-bot");
      expect(result!.did).toBe("did:mf:dev-loop-bot");
    });
  });
});

describe("reportProvisioningResult — failure visibility (MAJOR)", () => {
  test("null result (non-agent) writes nothing", async () => {
    const out = await captureStderr(() => reportProvisioningResult(null));
    expect(out).toBe("");
  });

  test("successful provision writes nothing", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    const result = await provisionAgentIdentity({
      agentId: "forge",
      scaffoldState: true,
      instanceDir: join(agentsDir, "forge"),
      natsDir,
      sidecarDir,
      quiet: true,
    });
    const out = await captureStderr(() => reportProvisioningResult(result));
    expect(out).toBe("");
  });

  test("fail-closed SKIP with quiet=true STILL surfaces a stderr warning", async () => {
    const { natsDir, agentsDir, sidecarDir } = await sandbox();
    // quiet:true suppresses the per-action record() lines, but a fail-closed
    // outcome (here: invalid id) must remain visible on the install log.
    const result = await provisionAgentIdentity({
      agentId: "Bad_ID",
      instanceDir: join(agentsDir, "bad"),
      natsDir,
      sidecarDir,
      quiet: true,
    });
    expect(result.provisioned).toBe(false);

    const out = await captureStderr(() => reportProvisioningResult(result));
    expect(out).toContain("agent identity NOT provisioned");
    expect(out).toContain("Bad_ID");
    expect(out).toContain(result.warning!);
  });

  test("EACCES fail-closed under quiet=true surfaces a stderr warning", async () => {
    const { natsDir, root } = await sandbox();
    const lockedParent = join(root, "locked");
    await Bun.write(join(lockedParent, ".keep"), "");
    await chmod(lockedParent, 0o500);
    try {
      // Lock the SIDECAR dir (the arc#281 identity anchor) to trip Rule 1.
      const result = await provisionAgentIdentity({
        agentId: "forge",
        natsDir,
        sidecarDir: join(lockedParent, "child", "sidecar"),
        quiet: true,
      });
      expect(result.provisioned).toBe(false);
      const out = await captureStderr(() => reportProvisioningResult(result));
      expect(out).toContain("agent identity NOT provisioned for forge");
    } finally {
      await chmod(lockedParent, 0o700);
    }
  });
});
