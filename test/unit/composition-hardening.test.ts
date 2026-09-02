import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import YAML from "yaml";
import { install, resolveRepoReference } from "../../src/commands/install.js";
import { list, formatListJson, formatList } from "../../src/commands/list.js";
import {
  listSkills,
  removeSkill,
  compositionMembers,
  compositionRecord,
  allCompositions,
} from "../../src/lib/db.js";
import {
  EXACT_PIN_RE,
  capabilitySurfaceDrift,
  isExactVersion,
  validateCompositionFields,
  type ToolProbe,
} from "../../src/lib/composition.js";
import { validateStrictManifest } from "../../src/lib/validate-manifest.js";
import { readManifest } from "../../src/lib/manifest.js";
import { createTestEnv, createMockSkillRepo, type TestEnv } from "../helpers/test-env.js";

/**
 * arc#400 review pass — the three confirmed adversarial findings (F1–F3) and
 * the adopted standard-review items (W2, W3, S1, S2, N2).
 *
 * F1 and F2 are CONSENT bypasses: each one lands capabilities the operator was
 * never shown. F3 is a bookkeeping hole that makes `arc list` lie by omission
 * after an interrupted install. Everything here is a regression guard on a
 * concrete repro, not a shape assertion.
 */

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

const allToolsPresent: ToolProbe = () => ({ found: true, path: "/usr/bin/stub", version: "9.9.9" });

async function writeFactoryRepo(
  root: string,
  name: string,
  extra: Record<string, unknown>,
): Promise<string> {
  const dir = join(root, `mock-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "arc-manifest.yaml"),
    YAML.stringify({
      schema: "arc/v1",
      name,
      version: "0.1.0",
      type: "factory",
      tier: "custom",
      description: `${name} composition`,
      license: "Apache-2.0",
      author: { name: "Test", github: "test" },
      ...extra,
    }),
  );
  Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@t.co", "commit", "-m", "init"],
    { cwd: dir, stdout: "pipe", stderr: "pipe" },
  );
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@t.co", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString().trim();
}

function recordingInstaller() {
  const calls: string[] = [];
  return {
    calls,
    installMember: async (m: { reference: { name: string } }) => {
      calls.push(m.reference.name);
      return { success: true, version: "1.0.0" };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// F1 — a composition member cannot itself be a composition
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 F1 — compositions do not nest (consent bypass)", () => {
  /**
   * The repro. A `factory` member contributes ZERO capability rows, because a
   * composition declares no surface of its own — so the parent's combined
   * review renders "Risk: LOW / (none)" while the member installer's
   * `yes: true` recursively installs the INNER members with no review at all.
   * Anything reachable through a nested composition is installed unseen.
   */
  test("a composition-typed member is REFUSED, before its inner members are touched", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "outer-factory", {
      references: [
        { name: "inner-factory", version: "1.0.0", repo: "file:///inner" },
        { name: "sibling", version: "1.0.0", repo: "file:///sibling" },
      ],
    });
    const rec = recordingInstaller();
    const resolved: string[] = [];

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        resolve: async (ref) => {
          resolved.push(ref.name);
          return {
            ok: true as const,
            member: {
              reference: ref,
              source: "repo" as const,
              ref: ref.repo!,
              manifest: {
                name: ref.name,
                version: ref.version,
                // The nested composition. No `capabilities:` — that is the
                // whole trick: a payload-less manifest contributes nothing to
                // the union, so the review shows an empty surface.
                type: ref.name === "inner-factory" ? "factory" : "skill",
                tier: "custom",
                ...(ref.name === "inner-factory"
                  ? { references: [{ name: "@evil/rootkit", version: "1.0.0" }] }
                  : {}),
              },
            },
          };
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("inner-factory");
    expect(result.error!.toLowerCase()).toContain("nest");
    // Nothing was installed, and the nested composition's OWN references were
    // never consulted — the refusal fires at resolution, not after.
    expect(rec.calls).toEqual([]);
    expect(resolved).not.toContain("@evil/rootkit");
    expect(listSkills(env.db)).toEqual([]);
  });

  test("a `bundle` member is refused for the same reason as a `factory` member", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "outer-bundle-factory", {
      references: [{ name: "inner-bundle", version: "1.0.0", repo: "file:///inner" }],
    });
    const rec = recordingInstaller();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        installMember: rec.installMember,
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: ref.repo!,
            manifest: { name: ref.name, version: ref.version, type: "bundle", tier: "custom" },
          },
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("inner-bundle");
    expect(rec.calls).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F2 — consent is bound to the bytes, not to a mutable tag
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 F2 — a repo member lands the COMMIT that was reviewed", () => {
  test("resolveRepoReference pins to the resolved SHA, not the tag name", async () => {
    env = await createTestEnv();
    const repo = await createMockSkillRepo(env.root, { name: "pinned", version: "1.0.0" });
    git(repo.path, "tag", "v1.0.0");
    const sha = git(repo.path, "rev-parse", "HEAD");

    const resolved = await resolveRepoReference(
      { name: "pinned", version: "1.0.0", repo: repo.url },
      repo.url,
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // A tag is a mutable label. The consent was given for these bytes.
    expect(resolved.member.pinnedRef).toBe(sha);
    expect(resolved.member.pinnedRef).not.toBe("v1.0.0");
  }, 30_000);

  /**
   * The repro. Consent is read from a scratch clone at tag `v1.0.0`; the member
   * then lands from a SECOND, independent clone. Move the tag in between and
   * the reviewed manifest and the landed code are different bytes — the
   * version-equality check does not bind content, only a number.
   */
  test("a tag moved between review and landing does NOT change what lands", async () => {
    env = await createTestEnv();
    const repo = await createMockSkillRepo(env.root, {
      name: "moved",
      version: "1.0.0",
      capabilities: { filesystem: { read: ["~/reviewed"], write: [] } },
    });
    git(repo.path, "tag", "v1.0.0");
    const consentedSha = git(repo.path, "rev-parse", "HEAD");

    const factory = await writeFactoryRepo(env.root, "moved-tag-factory", {
      references: [{ name: "moved", version: "1.0.0", repo: repo.url }],
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        // The REAL resolver runs; the attack lands between resolve and install.
        resolve: async (ref) => {
          const resolved = await resolveRepoReference(ref, ref.repo!);
          // The tag now points at code declaring a capability nobody reviewed.
          const manifestPath = join(repo.path, "arc-manifest.yaml");
          const manifest = YAML.parse(await Bun.file(manifestPath).text()) as Record<string, unknown>;
          (manifest.capabilities as { filesystem: { read: string[] } }).filesystem.read = [
            "~/never-reviewed",
          ];
          await writeFile(manifestPath, YAML.stringify(manifest));
          git(repo.path, "add", ".");
          git(repo.path, "commit", "-m", "moved tag payload");
          git(repo.path, "tag", "-f", "v1.0.0");
          return resolved;
        },
      },
    });

    expect(result.success).toBe(true);
    const landed = listSkills(env.db).find((s) => s.name === "moved");
    expect(landed).toBeDefined();
    expect(git(landed!.install_path, "rev-parse", "HEAD")).toBe(consentedSha);
  }, 60_000);

  test("capabilitySurfaceDrift names what appeared and what vanished", () => {
    const reviewed = [
      { type: "fs_read", value: "~/a", reason: "" },
      { type: "bash", value: "git status", reason: "" },
    ];
    const landed = [
      { type: "fs_read", value: "~/a", reason: "" },
      { type: "bash", value: "(unrestricted)", reason: "" },
    ];
    const drift = capabilitySurfaceDrift(reviewed, landed);
    expect(drift.join("\n")).toContain("(unrestricted)");
    expect(drift.join("\n")).toContain("git status");

    expect(capabilitySurfaceDrift(reviewed, [...reviewed])).toEqual([]);
    // Order is not drift.
    expect(capabilitySurfaceDrift(reviewed, [reviewed[1], reviewed[0]])).toEqual([]);
  });

  /**
   * Belt-and-braces: whatever route a member took, the surface arc RECORDS for
   * it after landing must be the surface the operator approved. This closes
   * the registry path for free — arc never has to prove the registry served
   * the same bytes twice.
   */
  test("a member whose LANDED surface differs from the reviewed one is refused", async () => {
    env = await createTestEnv();
    const actual = await createMockSkillRepo(env.root, {
      name: "swapped",
      version: "1.0.0",
      capabilities: { filesystem: { read: ["~/actually-landed"], write: [] } },
    });
    git(actual.path, "tag", "v1.0.0");

    const factory = await writeFactoryRepo(env.root, "drift-factory", {
      references: [{ name: "swapped", version: "1.0.0", repo: actual.url }],
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        // Review a surface that is NOT what the repo actually declares.
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: actual.url,
            pinnedRef: git(actual.path, "rev-parse", "HEAD"),
            manifest: {
              name: ref.name,
              version: ref.version,
              type: "skill",
              tier: "custom",
              capabilities: {
                filesystem: { read: ["~/what-was-reviewed"], write: [] },
                network: [],
                bash: { allowed: false },
                secrets: [],
              },
            },
          },
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("swapped");
    expect(result.error).toContain("~/actually-landed");
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// F3 — an interrupted composition install is VISIBLE, not silent debris
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 F3 — an interrupted composition leaves a pending record", () => {
  test("a member failing mid-sequence leaves a pending record naming what landed", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "interrupted-factory", {
      references: [
        { name: "first", version: "1.0.0", repo: "file:///first" },
        { name: "second", version: "1.0.0", repo: "file:///second" },
      ],
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: ref.repo!,
            manifest: { name: ref.name, version: ref.version, type: "skill", tier: "custom" },
          },
        }),
        installMember: async (m) =>
          m.reference.name === "second"
            ? { success: false, error: "postinstall exited 1" }
            : { success: true, name: m.reference.name, version: m.reference.version },
      },
    });

    expect(result.success).toBe(false);
    // S1 — the error names the debris, so the operator knows what to clean up.
    expect(result.error).toContain("second");
    expect(result.error).toContain("first");

    // F3 — the composition is on the record as INCOMPLETE, with per-member state.
    const header = compositionRecord(env.db, "interrupted-factory");
    expect(header).not.toBeNull();
    expect(header!.status).toBe("pending");

    const rows = compositionMembers(env.db, "interrupted-factory");
    expect(rows.map((r) => [r.member_name, r.state])).toEqual([
      ["first", "landed"],
      ["second", "pending"],
    ]);

    // ...and `arc list` says so, even though the factory itself never landed.
    const json = JSON.parse(formatListJson(list(env.db))) as {
      packages: { name: string }[];
      compositions: { name: string; status: string; members: { name: string; state: string }[] }[];
    };
    expect(json.packages.some((p) => p.name === "interrupted-factory")).toBe(false);
    const pending = json.compositions.find((c) => c.name === "interrupted-factory");
    expect(pending).toBeDefined();
    expect(pending!.status).toBe("pending");
    expect(pending!.members.find((m) => m.name === "first")!.state).toBe("landed");
    expect(formatList(list(env.db))).toContain("interrupted-factory");
  });

  test("a completed composition is recorded complete, with every member landed", async () => {
    env = await createTestEnv();
    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    git(alpha.path, "tag", "v1.0.0");
    const factory = await writeFactoryRepo(env.root, "complete-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    expect(result.success).toBe(true);
    expect(compositionRecord(env.db, "complete-factory")!.status).toBe("complete");
    expect(compositionMembers(env.db, "complete-factory").map((r) => r.state)).toEqual(["landed"]);
    expect(formatList(list(env.db))).not.toContain("Incomplete compositions");
  }, 60_000);

  test("removing the composition package removes its record and membership", async () => {
    env = await createTestEnv();
    const alpha = await createMockSkillRepo(env.root, { name: "alpha", version: "1.0.0" });
    git(alpha.path, "tag", "v1.0.0");
    const factory = await writeFactoryRepo(env.root, "removable-factory", {
      references: [{ name: "alpha", version: "1.0.0", repo: alpha.url }],
    });
    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent },
    });

    expect(compositionMembers(env.db, "removable-factory").length).toBe(1);
    removeSkill(env.db, "removable-factory");
    // The header is not FK'd to `skills` (it predates that row on purpose), so
    // removal must take it down explicitly; membership cascades off the header.
    expect(compositionRecord(env.db, "removable-factory")).toBeNull();
    expect(compositionMembers(env.db, "removable-factory")).toEqual([]);
    expect(allCompositions(env.db).size).toBe(0);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// W2 / W3 — staged directories
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 W2 — a registry member lands under the STANDALONE dir name", () => {
  test("the scratch `.compose-<scope>__<name>@<version>` is renamed to `<scope>__<name>`", async () => {
    env = await createTestEnv();

    const source = await createMockSkillRepo(env.root, { name: "staged", version: "1.0.0" });
    const staged = join(env.arc.reposDir, ".compose-scope__staged@1.0.0");

    const factory = await writeFactoryRepo(env.root, "rename-factory", {
      references: [{ name: "@scope/staged", version: "1.0.0" }],
    });

    // No installMember override — the REAL member installer runs, which is
    // where the rename lives. Staging happens INSIDE the resolver, as it does
    // in production: the W3 self-heal sweeps `.compose-*` before resolution
    // starts, so anything staged before that point is (correctly) gone.
    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        resolve: async (ref) => {
          Bun.spawnSync(["cp", "-R", source.path, staged], { stdout: "pipe", stderr: "pipe" });
          return {
            ok: true as const,
            member: {
              reference: ref,
              source: "registry" as const,
              ref: "@scope/staged",
              preExtractedPath: staged,
              manifest: (await readManifest(staged))!,
            },
          };
        },
      },
    });

    const landed = listSkills(env.db).find((s) => s.name === "staged");
    expect(landed).toBeDefined();
    // A version-stamped install dir goes stale the moment the member is
    // upgraded, and arc#401 walks these paths.
    expect(landed!.install_path).toBe(join(env.arc.reposDir, "scope__staged"));
    expect(existsSync(staged)).toBe(false);
  }, 60_000);
});

describe("arc#400 W3 — staged .compose-* dirs never outlive a refusal", () => {
  test("staged registry dirs are swept when a later member refuses", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "sweep-factory", {
      references: [
        { name: "@scope/staged", version: "1.0.0" },
        { name: "@scope/broken", version: "1.0.0" },
      ],
    });

    const stagedPath = join(env.arc.reposDir, ".compose-scope__staged@1.0.0");

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        resolve: async (ref) => {
          if (ref.name === "@scope/broken") {
            return { ok: false, error: "not found in any metafactory registry" };
          }
          // Simulate what the registry resolver stages on disk.
          await mkdir(stagedPath, { recursive: true });
          await writeFile(join(stagedPath, "arc-manifest.yaml"), "name: staged\n");
          return {
            ok: true as const,
            member: {
              reference: ref,
              source: "registry" as const,
              ref: "@scope/staged",
              preExtractedPath: stagedPath,
              manifest: { name: ref.name, version: ref.version, type: "skill", tier: "custom" },
            },
          };
        },
      },
    });

    expect(result.success).toBe(false);
    expect(existsSync(stagedPath)).toBe(false);
  });

  test("a leftover .compose-* dir from a crashed run is swept on the next attempt", async () => {
    env = await createTestEnv();
    const orphan = join(env.arc.reposDir, ".compose-scope__orphan@9.9.9");
    await mkdir(orphan, { recursive: true });

    const factory = await writeFactoryRepo(env.root, "self-heal-factory", {
      references: [{ name: "a", version: "1.0.0", repo: "file:///a" }],
    });

    await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: {
        probe: allToolsPresent,
        installMember: async () => ({ success: true }),
        resolve: async (ref) => ({
          ok: true as const,
          member: {
            reference: ref,
            source: "repo" as const,
            ref: ref.repo!,
            manifest: { name: ref.name, version: ref.version, type: "skill", tier: "custom" },
          },
        }),
      },
    });

    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(env.arc.reposDir).filter((d) => d.startsWith(".compose-"))).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// S2 — a composition declares no capabilities of its own
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 S2 — `capabilities:` on a composition is REFUSED", () => {
  for (const type of ["bundle", "factory"] as const) {
    test(`type: ${type} declaring a capabilities block is refused, not validated`, () => {
      const violations = validateCompositionFields({
        schema: "arc/v1",
        name: "c",
        version: "0.1.0",
        type,
        tier: "custom",
        capabilities: {
          filesystem: { read: [], write: [] },
          network: [],
          bash: { allowed: false },
          secrets: [],
        },
      });
      const hit = violations.find((v) => v.field === "capabilities");
      expect(hit).toBeDefined();
      expect(hit!.rule.toLowerCase()).toContain("union");
    });

    test(`type: ${type} without capabilities still passes`, () => {
      expect(
        validateCompositionFields({
          schema: "arc/v1",
          name: "c",
          version: "0.1.0",
          type,
          tier: "custom",
        }),
      ).toEqual([]);
    });
  }

  test("the refusal reaches `arc validate` through the shared validator", () => {
    const violations = validateStrictManifest({
      manifest: {
        schema: "arc/v1",
        name: "software-factory",
        version: "0.1.0",
        type: "factory",
        tier: "custom",
        description: "d",
        license: "Apache-2.0",
        author: { name: "J", github: "j" },
        capabilities: { filesystem: { read: [], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
      },
      repoDirName: "metafactory-bundle-software-factory",
    });
    expect(violations.some((v) => v.field === "capabilities")).toBe(true);
  });

  test("install refuses a composition manifest that declares capabilities", async () => {
    env = await createTestEnv();
    const factory = await writeFactoryRepo(env.root, "caps-factory", {
      capabilities: { filesystem: { read: ["~/x"], write: [] }, network: [], bash: { allowed: false }, secrets: [] },
      references: [{ name: "a", version: "1.0.0", repo: "file:///a" }],
    });
    const rec = recordingInstaller();

    const result = await install({
      arc: env.arc,
      host: env.host,
      db: env.db,
      repoUrl: factory,
      yes: true,
      composition: { probe: allToolsPresent, installMember: rec.installMember },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("capabilities");
    expect(rec.calls).toEqual([]);
  });

  test("a NON-composition type keeps its capabilities block untouched", () => {
    expect(
      validateCompositionFields({
        name: "s",
        version: "1.0.0",
        type: "skill",
        capabilities: { filesystem: { read: [], write: [] } },
      }),
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// N2 — the pin grammar is the registry's storage grammar, byte for byte
// ───────────────────────────────────────────────────────────────────────────

describe("arc#400 N2 — exact-pin grammar mirrors the registry (shared with arc#402)", () => {
  test("the regex IS the registry's stored-version grammar", () => {
    expect(EXACT_PIN_RE.source).toBe(String.raw`^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$`);
  });

  test("build metadata is excluded by construction — the registry cannot store it", () => {
    expect(isExactVersion("1.2.3+build.5")).toBe(false);
    const violations = validateCompositionFields({
      name: "f",
      version: "0.1.0",
      type: "factory",
      references: [{ name: "@a/b", version: "1.2.3+build.5" }],
    });
    expect(violations.some((v) => v.field === "references[0].version")).toBe(true);
  });

  test("a HYPHEN inside the prerelease is refused — such a pin could never resolve", () => {
    // Tighter than arc's first cut: the registry's prerelease class has no
    // hyphen, so `1.2.3-rc-1` names a version it can never hold.
    expect(isExactVersion("1.2.3-rc-1")).toBe(false);
    expect(isExactVersion("1.2.3-rc.1")).toBe(true);
    expect(isExactVersion("1.2.3-beta")).toBe(true);
  });

  test("leading zeros are TOLERATED — the registry stores them, so arc must not refuse", () => {
    // SemVer 2.0.0 forbids `1.02.3`; the registry's `\d+` does not. Refusing it
    // here would be a false refusal against a legitimately published version.
    expect(isExactVersion("1.02.3")).toBe(true);
    expect(
      validateCompositionFields({
        name: "f",
        version: "0.1.0",
        type: "factory",
        references: [{ name: "@a/b", version: "1.02.3" }],
      }),
    ).toEqual([]);
  });

  test("ranges are still refused, unchanged", () => {
    for (const bad of [">=1.0.0", "^1.2.0", "~1.2.0", "1.x", "1.2", "*", "latest", "v1.2.3"]) {
      expect(isExactVersion(bad)).toBe(false);
    }
  });

  test("`produces:` is a lowercase capability slug (shape shared with arc#402)", () => {
    const bad = validateCompositionFields({
      name: "f",
      version: "0.1.0",
      type: "factory",
      produces: "Software Factory",
    });
    expect(bad.some((v) => v.field === "produces")).toBe(true);
    expect(
      validateCompositionFields({ name: "f", version: "0.1.0", type: "factory", produces: "software" }),
    ).toEqual([]);
  });
});
