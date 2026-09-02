import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  createArtifactSymlinks,
  planArtifactSymlinks,
} from "../../src/lib/artifact-installer.js";
import { readManifest } from "../../src/lib/manifest.js";
import { maybeProvisionAgentIdentity } from "../../src/lib/identity-provision.js";
import { hostPathFor } from "../../src/lib/hosts/dispatch.js";
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
