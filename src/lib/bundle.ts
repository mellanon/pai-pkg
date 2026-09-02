import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { existsSync } from "fs";
import { readManifest } from "./manifest.js";
import { ARTIFACT_TYPES } from "../types.js";
import {
  validateFactoryComposition,
  type FactoryCompositionOptions,
} from "./factory-references.js";
import type { ArcManifest, BundleResult, PublishValidation } from "../types.js";

export const README_VARIANTS = ["README.md", "readme.md", "Readme.md"];

// ── Constants ────────────────────────────────────────────────

export const DEFAULT_EXCLUSIONS = [
  // VCS / editor / OS
  ".git",
  ".DS_Store",
  "Thumbs.db",
  // Secrets
  ".env",
  ".env.*",
  // Databases / logs
  "*.db",
  "*.sqlite",
  "*.log",
  // Node / JS / TS build + caches
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".nyc_output",
  ".next",
  ".turbo",
  ".parcel-cache",
  ".pnpm-store",
  // Bun compiled-binary cache
  ".*.bun-build",
  // Rust
  "target",
  // Python
  ".venv",
  "__pycache__",
  "*.pyc",
  // Prior bundle artefacts
  "*.tar.gz",
  "*.tgz",
  // arc / Cloudflare / Claude local state
  ".specify",
  ".wrangler",
  ".claude",
  // Test directories (override via bundle.include if your package ships tests)
  "test",
  "tests",
];

const MAX_PACKAGE_SIZE = 50 * 1024 * 1024; // 50MB
const WARN_PACKAGE_SIZE = 10 * 1024 * 1024; // 10MB

// ── Checksum ─────────────────────────────────────────────────

/** Compute SHA-256 hex digest of a file */
export async function computeChecksum(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(buffer);
  return hasher.digest("hex");
}

// ── Temp directory lifecycle ─────────────────────────────────

/** Execute a function with a temp directory that is cleaned up afterward */
export async function withTempDir<T>(
  fn: (tempDir: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "arc-publish-"));
  try {
    return await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}

// ── Exclusion patterns ───────────────────────────────────────

/** Merge default exclusions with manifest overrides */
export function getExclusionPatterns(manifest: ArcManifest): string[] {
  const patterns = [...DEFAULT_EXCLUSIONS];
  if (manifest.bundle?.exclude) {
    patterns.push(...manifest.bundle.exclude);
  }
  return patterns;
}

// ── Publish validation ───────────────────────────────────────

const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/;

/**
 * Package types `arc publish` accepts — DERIVED from the single source
 * `ARTIFACT_TYPES` (src/types.ts) since arc#399, per
 * `docs/design-factory-type.md` D7.1.
 *
 * This was the WORST of the three hand copies and the one that was actually
 * broken (arc#397): it omitted `system`, `process` and `governance`, so those
 * three types installed fine and then failed at `arc publish` with "type … is
 * not a recognized artifact type" — a package arc could install but its author
 * could not ship. Deriving fixes all three at once and makes the class of bug
 * unrepeatable; test/unit/type-set-parity.test.ts is its regression test.
 *
 * Publishability policy note (D7.4): arc's publish gate accepts every type arc
 * can install. Whether the REGISTRY accepts a given arc-only value
 * (`system`/`component`/`pipeline`/`process`/`action`/`governance`) is a
 * separate, deliberately deferred decision — see the mapping table on
 * `ARTIFACT_TYPES`. arc does not pre-empt the registry's answer here; a
 * registry-side rejection surfaces at the register step with the registry's own
 * message, which is more truthful than arc guessing.
 */
const VALID_TYPES: readonly string[] = ARTIFACT_TYPES;

/** Validate a manifest for publishing (stricter than install validation).
 * Accepts Partial because YAML may produce a structurally-incomplete object
 * even when the type pretends every field is present.
 *
 * `options` carries the publish-time member resolver used by the composition
 * rules (arc#402 / D4 / D5). It is optional so every existing caller keeps
 * working unchanged; for a `factory` or `bundle` manifest its ABSENCE is
 * itself a refusal — see `MemberResolver` in lib/factory-references.ts for the
 * recorded reasoning. Non-composition types are unaffected either way. */
export function validateForPublish(
  manifest: Partial<ArcManifest>,
  options: FactoryCompositionOptions = {},
): PublishValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest.name) {
    errors.push("name is required");
  } else if (!VALID_NAME_RE.test(manifest.name)) {
    errors.push("name must be lowercase alphanumeric with hyphens, dots, or underscores");
  }

  if (!manifest.version) {
    errors.push("version is required");
  } else if (!SEMVER_RE.test(manifest.version)) {
    errors.push(`version "${manifest.version}" is not valid semver`);
  }

  if (!manifest.type) {
    errors.push("type is required");
  } else if (!VALID_TYPES.includes(manifest.type)) {
    errors.push(`type "${manifest.type}" is not a recognized artifact type`);
  }

  if (!manifest.description) {
    warnings.push("description is missing (recommended for registry listing)");
  }

  // Composition rules (arc#402, docs/design-factory-type.md D1/D4/D5). Runs for
  // EVERY type: half the contract is refusing a composition declaration on a
  // type that will never read it.
  const composition = validateFactoryComposition(manifest, options);
  errors.push(...composition.errors);
  warnings.push(...composition.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    name: manifest.name ?? "",
    version: manifest.version ?? "",
  };
}

// ── Tarball helpers ──────────────────────────────────────────

/** Build tar --exclude args from exclusion/include pattern lists */
function buildTarArgs(exclusions: string[], includePatterns: string[]): string[] {
  const args: string[] = [];
  for (const pattern of exclusions) {
    if (!includePatterns.includes(pattern)) {
      args.push("--exclude", pattern);
    }
  }
  return args;
}

/** Compute checksum, size, and file count for a tarball */
async function getBundleStats(tarballPath: string): Promise<{ sha256: string; sizeBytes: number; fileCount: number }> {
  const sha256 = await computeChecksum(tarballPath);
  const sizeBytes = Bun.file(tarballPath).size;
  const listResult = Bun.spawnSync(["tar", "tzf", tarballPath], { stdout: "pipe", stderr: "pipe" });
  const fileCount = listResult.stdout.toString().trim().split("\n").filter(Boolean).length;
  return { sha256, sizeBytes, fileCount };
}

// ── Tarball creation ─────────────────────────────────────────

/** Create a .tar.gz bundle from a package directory.
 *
 * `options` is forwarded verbatim to `validateForPublish` so a caller that can
 * resolve composition members (arc#402) supplies the resolver here. A caller
 * that cannot — `arc bundle`, which is deliberately offline — supplies nothing
 * and a composition package is refused with a message saying exactly that. */
export async function createBundle(
  packageDir: string,
  outputPath?: string,
  options: FactoryCompositionOptions = {},
): Promise<BundleResult> {
  const warnings: string[] = [];

  const manifest = await readManifest(packageDir);
  if (!manifest) {
    return { success: false, tarballPath: "", sha256: "", sizeBytes: 0, fileCount: 0, manifest: {} as ArcManifest, warnings: [], error: "No arc-manifest.yaml found in package directory" };
  }

  const validation = validateForPublish(manifest, options);
  if (!validation.valid) {
    return { success: false, tarballPath: "", sha256: "", sizeBytes: 0, fileCount: 0, manifest, warnings: validation.warnings, error: `Manifest validation failed: ${validation.errors.join(", ")}` };
  }
  warnings.push(...validation.warnings);

  const hasReadme = README_VARIANTS.some((v) => existsSync(join(packageDir, v)));
  if (!hasReadme) {
    warnings.push("No README.md found (recommended for registry listing)");
  }

  const tarballName = outputPath ?? join(packageDir, `${manifest.name}-${manifest.version}.tar.gz`);
  const exclusions = getExclusionPatterns(manifest);
  const includePatterns = manifest.bundle?.include ?? [];

  // Warn when include entries don't cancel any exclusion (default OR user-defined).
  // include only cancels matching exclusions — it is not a tar-level allowlist.
  const orphanIncludes = includePatterns.filter((p) => !exclusions.includes(p));
  if (orphanIncludes.length > 0) {
    warnings.push(
      `bundle.include has no effect for [${orphanIncludes.join(", ")}] — ` +
      `bundle.include only cancels matching exclusions, it is not an allowlist. ` +
      `To filter the bundle, use bundle.exclude or pass a package subdirectory (e.g. arc bundle packages/my-pkg).`,
    );
  }

  const excludeArgs = buildTarArgs(exclusions, includePatterns);

  // Write the archive to a temp dir OUTSIDE packageDir, then move it into
  // place. Writing the tarball directly into packageDir while archiving `.`
  // makes the directory change as tar reads it: GNU tar (Linux CI) aborts
  // with "file changed as we read it" (exit 1), while bsdtar (macOS) tolerates
  // it — which is exactly why this passed locally but failed in CI. Staging
  // outside the source tree keeps the read set stable on every platform.
  const stageDir = await mkdtemp(join(tmpdir(), "arc-bundle-"));
  const stagedTarball = join(stageDir, "bundle.tar.gz");

  const result = Bun.spawnSync(
    ["tar", "czf", stagedTarball, ...excludeArgs, "."],
    { cwd: packageDir, stdout: "pipe", stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    return { success: false, tarballPath: tarballName, sha256: "", sizeBytes: 0, fileCount: 0, manifest, warnings, error: `tar failed: ${result.stderr.toString().trim()}` };
  }

  // Move the finished archive into its final location, then drop the temp dir.
  // `mv` (not fs.rename) so a cross-filesystem tmpdir → packageDir move works.
  const moveResult = Bun.spawnSync(["mv", stagedTarball, tarballName], { stdout: "pipe", stderr: "pipe" });
  await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  if (moveResult.exitCode !== 0) {
    return { success: false, tarballPath: tarballName, sha256: "", sizeBytes: 0, fileCount: 0, manifest, warnings, error: `failed to finalize bundle: ${moveResult.stderr.toString().trim()}` };
  }

  const { sha256, sizeBytes, fileCount } = await getBundleStats(tarballName);

  if (sizeBytes > MAX_PACKAGE_SIZE) {
    await rm(tarballName).catch(() => {
      // best-effort cleanup
    });
    const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
    const hint =
      "If this is a monorepo, pass a package subdirectory (e.g. `arc bundle packages/my-pkg`), " +
      "or use the library pattern (type: library with artifacts: at the repo root). " +
      "Also check for large caches that should be added to bundle.exclude (e.g. .*.bun-build, target, .venv).";
    return {
      success: false,
      tarballPath: tarballName,
      sha256,
      sizeBytes,
      fileCount,
      manifest,
      warnings,
      error: `Package tarball exceeds 50MB limit (${sizeMb}MB). ${hint}`,
    };
  }

  if (sizeBytes > WARN_PACKAGE_SIZE) {
    warnings.push(`Tarball is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB (consider reducing size)`);
  }

  return { success: true, tarballPath: tarballName, sha256, sizeBytes, fileCount, manifest, warnings };
}
