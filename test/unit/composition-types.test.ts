import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  createArtifactSymlinks,
  planArtifactSymlinks,
  resolveArtifactSourceDir,
} from "../../src/lib/artifact-installer.js";
import { readManifest } from "../../src/lib/manifest.js";
import { maybeProvisionAgentIdentity } from "../../src/lib/identity-provision.js";
import { hostPathFor } from "../../src/lib/hosts/dispatch.js";
import { validateStrictManifest } from "../../src/lib/validate-manifest.js";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";

/**
 * `bundle` and `factory` — the reference-composition types (arc#399,
 * docs/design-factory-type.md D1/D7.2).
 *
 * Slice 1 teaches arc's type vocabulary about them. It does NOT implement
 * reference resolution (that is the next slice), so the behavior pinned here is
 * deliberately narrow: a bundle/factory manifest must LOAD, VALIDATE and reach
 * the end of install WITHOUT throwing, and must plan no per-type drop — while
 * `provides.files` keeps working through the type-agnostic pass.
 *
 * The failure mode being locked out is arc#334's, in reverse: a type the
 * validator accepts that then throws `Unsupported artifact type` at install.
 */

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

const COMPOSITION_TYPES = ["bundle", "factory"] as const;

/** Write a minimal composition package (no capabilities block) to disk. */
async function writeCompositionPackage(
  root: string,
  opts: { name: string; type: "bundle" | "factory"; provides?: string },
): Promise<string> {
  const dir = join(root, opts.name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "arc-manifest.yaml"),
    [
      `schema: arc/v1`,
      `name: ${opts.name}`,
      `version: 0.1.0`,
      `type: ${opts.type}`,
      `tier: custom`,
      opts.provides ?? "",
      ``,
    ].join("\n"),
  );
  return dir;
}

describe("arc#399 — composition manifests load without a capabilities block", () => {
  for (const type of COMPOSITION_TYPES) {
    test(`readManifest accepts type: ${type} with no capabilities (D2 — the surface is the union of MEMBERS')`, async () => {
      env = await createTestEnv();
      const dir = await writeCompositionPackage(env.root, {
        name: `composition-${type}`,
        type,
      });

      const manifest = await readManifest(dir);
      expect(manifest).not.toBeNull();
      expect(manifest!.type).toBe(type);
      expect(manifest!.capabilities).toBeUndefined();
    });
  }
});

/**
 * A composition manifest that is strict-clean in every respect EXCEPT that it
 * declares no `capabilities:` block. The repo dir name is deliberately a
 * `metafactory-bundle-<name>` one carrying `type: factory`: D1's two axes are
 * independent, and the §4.2 name derivation must not care which is which.
 */
function strictCompositionManifest(type: "bundle" | "factory"): Record<string, unknown> {
  return {
    schema: "arc/v1",
    name: "software-factory",
    version: "0.1.0",
    type,
    tier: "custom",
    description: "The software factory composition.",
    license: "Apache-2.0",
    author: { name: "Jane Doe", github: "janedoe" },
  };
}

describe("arc#399 — the two gates agree on a minimal composition manifest (D2)", () => {
  for (const type of COMPOSITION_TYPES) {
    test(`type: ${type} without capabilities passes BOTH readManifest and strict validate`, async () => {
      env = await createTestEnv();
      const manifestObj = strictCompositionManifest(type);

      // Gate 1: the lenient loader `arc install` uses.
      const dir = join(env.root, "metafactory-bundle-software-factory");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "arc-manifest.yaml"), YAML.stringify(manifestObj));
      const loaded = await readManifest(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.capabilities).toBeUndefined();

      // Gate 2: the strict validator `arc validate` uses. Before arc#399 this
      // one rejected the exact manifest the loader had just accepted, with
      // arc#240's explicit-empties message.
      const violations = validateStrictManifest({
        manifest: manifestObj,
        repoDirName: "metafactory-bundle-software-factory",
      });
      expect(violations).toEqual([]);
    });

    test(`type: ${type} that DOES declare capabilities is still validated in full`, () => {
      // The exemption is about PRESENCE only. An author who makes the claim is
      // held to the arc#240 schema exactly like any other type — here the
      // rejected legacy `{ domain, reason }` network shape (arc#335).
      const violations = validateStrictManifest({
        manifest: {
          ...strictCompositionManifest(type),
          capabilities: {
            filesystem: { read: [], write: [] },
            network: [{ domain: "api.example.com", reason: "legacy shape" }],
            bash: { allowed: false },
            secrets: [],
          },
        },
        repoDirName: "metafactory-bundle-software-factory",
      });
      expect(violations.some((v) => v.field.startsWith("capabilities.network"))).toBe(true);
    });

    test(`type: ${type} with a malformed capabilities block is rejected, not exempted`, () => {
      const violations = validateStrictManifest({
        manifest: { ...strictCompositionManifest(type), capabilities: "none" },
        repoDirName: "metafactory-bundle-software-factory",
      });
      expect(violations.some((v) => v.field === "capabilities")).toBe(true);
    });
  }

  test("the exemption does NOT leak to non-composition types", () => {
    // arc#240 still bites every type that has a surface of its own. Strict mode
    // deliberately does not copy the loader's component/rules/agent exemptions.
    for (const type of ["skill", "tool", "component", "rules", "agent", "library"] as const) {
      const violations = validateStrictManifest({
        manifest: { ...strictCompositionManifest("factory"), type },
        repoDirName: "metafactory-bundle-software-factory",
      });
      expect(violations.some((v) => v.field === "capabilities")).toBe(true);
    }
  });
});

describe("arc#399 — resolveArtifactSourceDir names the composition types", () => {
  for (const type of COMPOSITION_TYPES) {
    test(`type: ${type} resolves to baseDir, not the default <baseDir>/skill`, () => {
      const baseDir = "/tmp/arc-399-base";
      expect(resolveArtifactSourceDir(type, baseDir)).toBe(baseDir);
      expect(resolveArtifactSourceDir(type, baseDir)).not.toBe(join(baseDir, "skill"));
    });
  }
});

describe("arc#399 — planArtifactSymlinks handles the composition types", () => {
  for (const type of COMPOSITION_TYPES) {
    test(`type: ${type} plans NO per-type symlink and does not throw`, async () => {
      env = await createTestEnv();
      const dir = await writeCompositionPackage(env.root, {
        name: `plan-${type}`,
        type,
      });
      const manifest = (await readManifest(dir))!;

      const plan = planArtifactSymlinks({
        type: manifest.type,
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: dir,
      });

      expect(plan.symlinkTargets).toEqual([]);
      expect(plan.shimNames).toEqual([]);
      expect(plan.filesMissingSource).toEqual([]);
    });

    test(`type: ${type} still honors provides.files (type-agnostic pass)`, async () => {
      env = await createTestEnv();
      const auxTarget = join(env.root, "aux", `${type}-notes.md`);
      const dir = await writeCompositionPackage(env.root, {
        name: `files-${type}`,
        type,
        provides: [
          `provides:`,
          `  files:`,
          `    - source: docs/notes.md`,
          `      target: ${auxTarget}`,
        ].join("\n"),
      });
      await mkdir(join(dir, "docs"), { recursive: true });
      await writeFile(join(dir, "docs", "notes.md"), "# composition notes\n");

      const manifest = (await readManifest(dir))!;
      const opts = {
        type: manifest.type,
        manifest,
        arc: env.arc,
        host: env.host,
        installDir: dir,
      };

      const plan = planArtifactSymlinks(opts);
      expect(plan.symlinkTargets.map((s) => s.target)).toEqual([auxTarget]);

      // Plan⇄apply parity, same invariant the other types get (arc#248).
      const applied = await createArtifactSymlinks(opts);
      expect(new Set(applied.record.symlinks)).toEqual(new Set([auxTarget]));
      expect(existsSync(auxTarget)).toBe(true);
    });
  }
});

describe("arc#399 — the other type-switched install paths tolerate the new values", () => {
  for (const type of COMPOSITION_TYPES) {
    test(`maybeProvisionAgentIdentity is a no-op for type: ${type} (no agent identity to provision)`, async () => {
      const result = await maybeProvisionAgentIdentity({
        name: `identity-${type}`,
        type,
      });
      expect(result).toBeNull();
    });

    test(`hostPathFor returns null for type: ${type} (no host directory, no throw)`, async () => {
      env = await createTestEnv();
      expect(hostPathFor(env.host, type)).toBeNull();
    });
  }
});
