#!/usr/bin/env bun

import { Command } from "commander";
import { createArcPaths, ensureDirectories, getDefaultHost, isDirOnPath, isArcDefaultLayout } from "./lib/paths.js";
import { migrateArcDirsIfNeeded, legacyArcLayout, toArcDirLayout } from "./lib/xdg-migrate.js";
import { openDatabase, getSkill } from "./lib/db.js";
import { extractAllCliInfo } from "./lib/symlinks.js";
import { install, parseNameVersion } from "./commands/install.js";
import { buildCortexInstallSteering } from "./lib/hosts/cortex-config-split.js";
import {
  secretsList,
  secretsCheck,
  secretsSet,
  secretsRotate,
  secretsRemove,
} from "./commands/secrets.js";
import { readManifest, readManifestVersionSync, MANIFEST_FILENAME } from "./lib/manifest.js";
import { validate as validateManifest } from "./commands/validate.js";
import { resolveSecretBackend, type SecretBackend, type SecretBackendChoice } from "./lib/secrets.js";
import { list, formatList, formatListJson } from "./commands/list.js";
import { info, formatInfo, formatInfoJson } from "./commands/info.js";
import { audit, formatAudit } from "./commands/audit.js";
import { disable } from "./commands/disable.js";
import { enable } from "./commands/enable.js";
import { remove, removeLibrary } from "./commands/remove.js";
import { purge, formatPurge } from "./commands/purge.js";
import { filesListing, formatFiles, formatFilesJson } from "./commands/files.js";
import { hasOwns, purgeableEntries } from "./lib/owns.js";
import { verify, formatVerify } from "./commands/verify.js";
import { init, resolveInitTarget } from "./commands/init.js";
import { upgradeCore, formatUpgrade } from "./commands/upgrade-core.js";
import { selfUpdate, formatSelfUpdate, checkSelfUpdate, formatSelfUpdateCheck } from "./commands/self-update.js";
import {
  checkUpgrades,
  upgradePackage,
  upgradeAll,
  upgradeLibrary,
  formatCheckResults,
  formatUpgradeResults,
} from "./commands/upgrade.js";
import type { ArcManifest, ArtifactType, PackageTier, RegistrySource, SourceType } from "./types.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import { addBot, reissueBot, listBots, removeBot, setupOperator, addFederationExport, initOperator, addAccount, addFederatedUser, reissueFederatedUser, revokeFederatedUser, exportAccount, exportOperator, exportSystem } from "./commands/nats.js";
import { provisionStreams, provisionConsumer } from "./commands/jetstream.js";
import {
  ARC_NATS_SCHEMA,
  ARC_NATS_FEDERATION_SCHEMA,
  ARC_NATS_OPERATOR_SCHEMA,
  ARC_NATS_FEDERATED_USER_SCHEMA,
  emitJson,
  classifyError,
  type AddBotJson,
  type ReissueBotJson,
  type RemoveBotJson,
  type SetupOperatorJson,
  type ProvisionJson,
  type AddFederationExportJson,
  type InitOperatorJson,
  type AddAccountJson,
  type AddFederatedUserJson,
  type ReissueFederatedUserJson,
  type RevokeFederatedUserJson,
  type ExportAccountJson,
  type ExportOperatorJson,
  type ExportSystemJson,
} from "./lib/json-response.js";
import { generateIdentity, exportPrincipals, importPrincipals, listPrincipals } from "./commands/identity.js";
import { bundle, formatBundle } from "./commands/bundle.js";
import { publish, formatPublish } from "./commands/publish.js";
import {
  reviewList,
  reviewShow,
  reviewApprove,
  reviewReject,
  reviewRequestChanges,
  formatReviewList,
  formatReviewShow,
  formatReviewAction,
} from "./commands/review.js";
import {
  searchAcrossSources,
  formatSearch,
  formatSearchJson,
  formatWarnings,
  parseArtifactType,
  parsePackageTier,
} from "./commands/search.js";
import {
  parsePackageRef,
  formatPackageRef,
  resolveFromRegistry,
  downloadPackage,
  verifyChecksum,
  extractPackage,
  formatQuarantineMessage,
  QUARANTINE_EXIT_CODE,
} from "./lib/registry-install.js";
import { verifyVersionSignature } from "./lib/registry-signing.js";
import { verifyPackageSigstore } from "./lib/cosign-verify.js";
import {
  loadSources,
  saveSources,
  addSource,
  removeSource,
  formatSourceList,
  validateSource,
} from "./lib/sources.js";
import { loadUserConfig, normalizeUserPath, saveUserConfig } from "./lib/config.js";
import {
  findInAllSources,
  updateAllSources,
} from "./lib/remote-registry.js";
import { homedir, userInfo } from "os";
import { join } from "path";
import { parseLibraryRef } from "./lib/artifact-installer.js";
import { errorMessage } from "./lib/errors.js";
import pkg from "../package.json" with { type: "json" };

const program = new Command();

// Single source of truth for the version: arc-manifest.yaml is the release
// source of truth (compass versioning SOP). Derive `arc --version` from it so
// it can never drift from the manifest. Fall back to the compiled-in
// package.json version only if the manifest can't be read at runtime.
const CLI_VERSION =
  readManifestVersionSync(join(import.meta.dir, "..", MANIFEST_FILENAME)) ??
  pkg.version;

function createInstallPaths(opts: { binDir?: string }): ReturnType<typeof createArcPaths> {
  return createArcPaths(
    opts.binDir
      ? { shimDir: normalizeUserPath(opts.binDir) }
      : undefined,
  );
}

function quoteForSingleQuotedShell(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function formatPathRepairCommand(shimDir: string, shell = process.env.SHELL ?? ""): string {
  if (shell.endsWith("/fish")) {
    return `fish_add_path ${shimDir}`;
  }

  const exportLine = `export PATH="${shimDir}:$PATH"`;
  if (shell.endsWith("/bash")) {
    return `echo '${quoteForSingleQuotedShell(exportLine)}' >> ~/.bashrc`;
  }
  if (shell.endsWith("/zsh") || shell === "") {
    return `echo '${quoteForSingleQuotedShell(exportLine)}' >> ~/.zshrc`;
  }
  return exportLine;
}

function installResultProvidesCli(result: Awaited<ReturnType<typeof install>>): boolean {
  const manifests = [
    result.manifest,
    ...(result.artifacts?.map((artifact) => artifact.manifest) ?? []),
  ].filter((manifest): manifest is ArcManifest => Boolean(manifest));

  return manifests.some((manifest) => extractAllCliInfo(manifest).length > 0);
}

function printShimPathNotice(paths: ReturnType<typeof createArcPaths>, result: Awaited<ReturnType<typeof install>>): void {
  if (!installResultProvidesCli(result) || isDirOnPath(paths.shimDir)) return;

  console.log(`\nCommand shims were installed in ${paths.shimDir}, but that directory is not on PATH.`);
  console.log(`Add it with: ${formatPathRepairCommand(paths.shimDir)}`);
}

program
  .name("arc")
  .description("Agentic component package manager")
  .version(CLI_VERSION);

program
  .command("install <name-or-url>")
  .description("Install a skill from git URL, or by name from the registry")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--pin <version>", "Pin to a specific version (git tag)")
  .option("--bin-dir <path>", "Directory for PATH-accessible command shims")
  .option("--strict-signing", "Refuse to install if Sigstore signature is missing on an official-tier package")
  .option("--skip-secrets", "Install without provisioning declared secrets (daemon fails at first use with a clear message)")
  .option("--from-env", "Resolve declared secrets from the current environment instead of prompting")
  .option("--secret-backend <choice>", "Secret storage backend: auto (default) | keychain | file. 'auto' uses the chmod-600 file backend on shared/CI hosts to avoid the macOS Keychain argv-exposure window")
  .option("--config-dir <path>", "Target a config-split cortex stack by its config dir (or its pointer file). Roots cortex agents.d/ + personas/ at the stack subdir. (arc#244)")
  .option("--stack <name>", "Target a config-split cortex stack by name (resolves to <name> under the live cortex config dir — legacy ~/.config/cortex on a pre-cutover box, canonical ~/.config/metafactory/cortex on a migrated one). (arc#244)")
  .action(async (nameOrUrl: string, opts: { yes?: boolean; pin?: string; binDir?: string; strictSigning?: boolean; skipSecrets?: boolean; fromEnv?: boolean; secretBackend?: string; configDir?: string; stack?: string }) => {
    // Non-TTY guard: fail loud rather than silently half-installing
    if (!opts.yes && !process.stdin.isTTY) {
      console.error("Error: arc install requires an interactive terminal for capability confirmation.");
      console.error("Pass --yes (-y) to approve non-interactively.");
      process.exit(1);
    }

    // Validate --secret-backend (F-6e). `auto` applies the shared-host
    // heuristic; `keychain` forces the macOS Keychain (accepting its argv
    // exposure); `file` forces the chmod-600 file backend.
    const secretBackend = parseSecretBackendChoice(opts.secretBackend);

    // S1 (arc#244 / cortex#1133): resolve config-split stack targeting from
    // --config-dir / --stack into install steering. No flag → undefined
    // hostOverrides + empty env → byte-identical legacy `~/.config/cortex`
    // behavior. A flag → cortex host roots agents.d/ + personas/ at the stack
    // subdir, and reload/creds postinstall scripts see CORTEX_CONFIG.
    let cortexSteering: ReturnType<typeof buildCortexInstallSteering>;
    try {
      cortexSteering = buildCortexInstallSteering({
        configDir: opts.configDir,
        stack: opts.stack,
      });
    } catch (err) {
      console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const paths = createInstallPaths(opts);
    const host = getDefaultHost();
    await ensureDirectories(paths, host);
    const db = openDatabase(paths.dbPath);

    // Check if input is a registry package ref (@scope/name[@version])
    const pkgRef = parsePackageRef(nameOrUrl);

    // Parse library:artifact colon syntax (only for non-URL names)
    const isUrl =
      nameOrUrl.startsWith("git@") ||
      nameOrUrl.startsWith("http") ||
      nameOrUrl.startsWith("file://");

    let libraryName: string | undefined;
    let artifactName: string | undefined;
    // Validate --pin flag: must look like semver (same check as @version suffix)
    if (opts.pin && !/^v?\d+\.\d+/.test(opts.pin)) {
      console.error(`Invalid version "${opts.pin}". Expected semver (e.g., 1.2.0).`);
      process.exit(1);
    }
    let pinnedVersion: string | undefined = opts.pin?.replace(/^v/, "");
    let lookupName = nameOrUrl;

    if (!isUrl && !pkgRef) {
      // Check for version suffix: MySkill@1.2.0
      const nameVer = parseNameVersion(nameOrUrl);
      if (nameVer) {
        pinnedVersion ??= nameVer.version;
        lookupName = nameVer.name;
      }

      const libRef = parseLibraryRef(lookupName);
      if (libRef?.artifactName) {
        libraryName = libRef.libraryName;
        artifactName = libRef.artifactName;
        lookupName = libRef.libraryName;
      }
    }

    if (pkgRef) {
      // Registry install: @scope/name[@version] → download from metafactory API
      const sources = await loadSources(paths.sourcesPath);
      const resolved = await resolveFromRegistry(pkgRef, sources.sources);

      if (!resolved) {
        console.error(`Package "${formatPackageRef(pkgRef)}" not found in any metafactory registry.`);
        console.error(`Try: arc search ${pkgRef.name}`);
        process.exit(1);
      }

      console.log(`Found ${formatPackageRef(pkgRef)} v${resolved.version} in ${resolved.source.name} [${resolved.source.tier}]`);

      // arc#158: bail before download if a row already exists for this name.
      // Resolved name is known here (no clone needed), so we save the bytes.
      const existingRow = getSkill(db, resolved.name);
      if (existingRow && !existingRow.library_name) {
        // arc#354: active at the resolved version → re-running install is a
        // harmless no-op success, not an error. Disabled or version-mismatch
        // rows keep the arc#158 actionable-hint error.
        if (existingRow.status === "active" && existingRow.version === resolved.version) {
          console.log(`✓ '${resolved.name}' v${existingRow.version} already installed — nothing to do`);
          db.close();
          return;
        }
        const hint =
          existingRow.status === "disabled"
            ? `Run \`arc enable ${resolved.name}\` to re-enable it, or \`arc remove ${resolved.name}\` first if you want a clean install.`
            : `Run \`arc upgrade ${resolved.name}\`, or \`arc remove ${resolved.name}\` first if the existing install can't be upgraded in place.`;
        console.error(`'${resolved.name}' v${existingRow.version} is already installed (status: ${existingRow.status}). ${hint}`);
        process.exit(1);
      }

      // Download. Anonymous by default (DD-80); the resolved source is passed
      // through so an auth-gated metafactory storage endpoint receives the
      // bearer token from `arc login` (issue #83).
      console.log(`Downloading...`);
      const download = await downloadPackage(resolved.downloadUrl, paths.reposDir, resolved.source);
      if (!download.success || !download.tempPath) {
        // 451 quarantine (mf#76 / arc#105) gets dedicated UX + a distinct
        // exit code so scripts can tell deliberate-removal apart from
        // missing/network failures.
        if (download.quarantine) {
          const colorEnabled = process.stderr.isTTY;
          for (const line of formatQuarantineMessage(
            formatPackageRef(pkgRef),
            download.quarantine,
            colorEnabled,
          )) {
            console.error(line);
          }
          process.exit(QUARANTINE_EXIT_CODE);
        }
        console.error(`${download.error}`);
        process.exit(1);
      }
      console.log(`Downloaded ${((download.bytesDownloaded ?? 0) / 1024).toFixed(0)} KB`);

      // Verify SHA-256
      const verify = await verifyChecksum(download.tempPath, resolved.sha256);
      if (!verify.valid) {
        console.error(`Checksum verification failed!`);
        console.error(`  Expected: ${verify.expected}`);
        console.error(`  Actual:   ${verify.actual}`);
        console.error(`This could indicate a corrupted download or compromised package.`);
        if (await Bun.file(download.tempPath).exists()) {
          Bun.spawnSync(["rm", "-f", download.tempPath]);
        }
        process.exit(1);
      }
      console.log(`SHA-256 verified`);

      // A-504: verify registry-level Ed25519 signature over manifest bytes.
      // Blocks install on any verified=false. verified=null means the
      // version is unsigned (legacy / registry in degraded mode at publish
      // time) — arc proceeds with a warning, consistent with meta-factory's
      // own graceful degradation.
      const sigResult = await verifyVersionSignature(
        resolved.source,
        {
          registry_signature: resolved.registrySignature,
          registry_key_id: resolved.registryKeyId,
        },
        resolved.manifestCanonical,
      );
      if (sigResult.verified === false) {
        // Distinguish infrastructure unavailability from a genuine
        // signature mismatch. Both fail-closed, but the user-facing
        // framing differs: "try again later" vs "investigate now".
        const infraFailure = /public key unavailable|manifest_canonical missing/i.test(
          sigResult.reason,
        );
        console.error(`Registry signature verification failed: ${sigResult.reason}`);
        if (infraFailure) {
          console.error(`The registry may be temporarily unreachable or misconfigured. Try again later.`);
        } else {
          console.error(`This could indicate a compromised registry or a tampered manifest.`);
        }
        if (await Bun.file(download.tempPath).exists()) {
          Bun.spawnSync(["rm", "-f", download.tempPath]);
        }
        process.exit(1);
      }
      if (sigResult.verified === true) {
        console.log(`Registry signature verified (${sigResult.reason})`);
      } else {
        console.warn(`Registry signature: ${sigResult.reason}`);
      }

      // A-503: verify Sigstore bundle (cosign) when signature_bundle_key is
      // present. Scope OQ-14: GitHub Actions OIDC only. verified=null means
      // the version predates Sigstore signing — proceed with a warning.
      const sigstoreResult = await verifyPackageSigstore({
        source: resolved.source,
        sha256: resolved.sha256,
        signing: {
          signature_bundle_key: resolved.signatureBundleKey,
          signer_identity: resolved.signerIdentity,
        },
        artifactPath: download.tempPath,
        tempDir: paths.reposDir,
      });
      if (sigstoreResult.verified === false) {
        console.error(`Sigstore verification failed: ${sigstoreResult.reason}`);
        console.error(`This could indicate a tampered artifact or an unexpected signer.`);
        if (await Bun.file(download.tempPath).exists()) {
          Bun.spawnSync(["rm", "-f", download.tempPath]);
        }
        process.exit(1);
      }
      // arc#160: a missing Sigstore signature on an official-tier source is
      // a real risk, not a side note. Promote it to a prominent warning, and
      // let --strict-signing turn it into a hard failure.
      let sigstoreVerified = false;
      if (sigstoreResult.verified === true) {
        console.log(`Sigstore signature verified (${sigstoreResult.reason})`);
        sigstoreVerified = true;
      } else if (resolved.source.tier === "official") {
        console.warn(`⚠️  Sigstore signature MISSING for official-tier package`);
        console.warn(`   ${sigstoreResult.reason}`);
        console.warn(`   SHA-256 and registry signature are verified, but the package itself is not Sigstore-signed.`);
        console.warn(`   This means the identity that produced the bytes cannot be cryptographically attested.`);
        if (opts.strictSigning) {
          console.error(`Refusing to install: --strict-signing is set and Sigstore signature is missing.`);
          if (await Bun.file(download.tempPath).exists()) {
            Bun.spawnSync(["rm", "-f", download.tempPath]);
          }
          process.exit(1);
        }
      } else {
        console.warn(`Sigstore signature: ${sigstoreResult.reason}`);
      }

      // Extract
      const packageDir = `${resolved.scope}__${resolved.name}`;
      const extract = await extractPackage(download.tempPath, paths.reposDir, packageDir);
      if (!extract.success) {
        console.error(`${extract.error}`);
        process.exit(1);
      }

      // Continue with standard install flow (manifest, symlinks, hooks, DB).
      // Use preExtractedPath so install() skips git clone.
      const result = await install({
        arc: paths,
        host,
        db,
        repoUrl: formatPackageRef({ scope: resolved.scope, name: resolved.name, version: resolved.version }),
        yes: opts.yes,
        preExtractedPath: extract.extractedPath,
        sourceName: resolved.source.name,
        sourceTier: resolved.source.tier,
        skipSecrets: opts.skipSecrets,
        fromEnv: opts.fromEnv,
        secretBackend,
        hostOverrides: cortexSteering.hostOverrides,
        cortexConfigEnv: cortexSteering.cortexConfigEnv,
      });
      if (result.success) {
        if (result.alreadyInstalled) {
          // arc#354: duplicate row surfaced past the pre-download check
          // (e.g. matched by repo URL under a different name) — no-op.
          console.log(`✓ '${result.name}' v${result.version} already installed — nothing to do`);
        } else {
          // arc#160: don't claim "(verified)" on the final line when only the
          // registry signature and checksum were validated — Sigstore is the
          // signature that attests to producer identity.
          const verifyLabel = sigstoreVerified
            ? "(verified)"
            : "(SHA-256 + registry signature verified; Sigstore signature MISSING)";
          console.log(`Installed ${result.name} v${result.version} ${verifyLabel}`);
          printShimPathNotice(paths, result);
        }
      } else {
        console.error(`${result.error}`);
        process.exit(1);
      }
    } else if (isUrl) {
      // Direct git install
      const result = await install({ arc: paths, host, db, repoUrl: nameOrUrl, yes: opts.yes, artifactName, pinnedVersion, skipSecrets: opts.skipSecrets, fromEnv: opts.fromEnv, secretBackend, hostOverrides: cortexSteering.hostOverrides, cortexConfigEnv: cortexSteering.cortexConfigEnv });
      if (result.success) {
        if (result.alreadyInstalled) {
          // arc#354: re-running install on an installed package is a no-op.
          console.log(`\n✓ '${result.name}' v${result.version} already installed — nothing to do`);
        } else if (result.artifacts?.length) {
          console.log(`\n✅ Installed ${result.artifacts.filter(a => a.success).length} artifact(s) from ${result.name}`);
          printShimPathNotice(paths, result);
        } else {
          console.log(`\n✅ Installed ${result.name} v${result.version}`);
          printShimPathNotice(paths, result);
        }
      } else {
        console.error(`\n❌ ${result.error}`);
        process.exit(1);
      }
    } else {
      // Name-based: search all configured sources → install
      const sources = await loadSources(paths.sourcesPath);
      const found = await findInAllSources(sources, lookupName, paths.cachePath);

      if (!found) {
        console.error(`"${lookupName}" not found in any source. Try: arc search <keyword>`);
        process.exit(1);
      }

      const versionLabel = pinnedVersion ? ` (pinned: v${pinnedVersion})` : "";
      console.log(`Found ${lookupName} [${found.artifactType}] in ${found.sourceName} [${found.sourceTier}]${versionLabel}`);

      // Install directly from the source URL
      const result = await install({
        arc: paths,
        host,
        db,
        repoUrl: found.entry.source,
        yes: opts.yes,
        sourceName: found.sourceName,
        sourceTier: found.sourceTier,
        artifactName,
        libraryName,
        pinnedVersion,
        skipSecrets: opts.skipSecrets,
        fromEnv: opts.fromEnv,
        secretBackend,
        hostOverrides: cortexSteering.hostOverrides,
        cortexConfigEnv: cortexSteering.cortexConfigEnv,
      });
      if (result.success) {
        if (result.alreadyInstalled) {
          // arc#354: re-running install on an installed package is a no-op.
          console.log(`✓ '${result.name}' v${result.version} already installed — nothing to do`);
        } else if (result.artifacts?.length) {
          console.log(`✅ Installed ${result.artifacts.filter(a => a.success).length} artifact(s) from ${result.name}`);
          printShimPathNotice(paths, result);
        } else {
          console.log(`✅ Installed ${result.name} v${result.version}`);
          printShimPathNotice(paths, result);
        }
      } else {
        console.error(`${result.error}`);
        process.exit(1);
      }
    }

    db.close();
  });

program
  .command("list")
  .description("List installed packages")
  .option("--json", "Output as JSON")
  .option("--type <type>", "Filter by artifact type (skill, tool, agent, prompt, pipeline, rules, governance)")
  .option("--library <name>", "Filter by library name")
  .action((opts: { json?: boolean; type?: string; library?: string }) => {
    const validTypes = ["skill", "system", "tool", "agent", "prompt", "component", "pipeline", "rules", "action", "governance"];
    if (opts.type && !validTypes.includes(opts.type)) {
      console.error(`\n❌ Unknown type "${opts.type}". Valid types: ${validTypes.join(", ")}`);
      process.exit(1);
    }
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const result = list(db, { type: opts.type as ArtifactType | undefined, library: opts.library });
    console.log(opts.json ? formatListJson(result) : formatList(result));
    db.close();
  });

program
  .command("info <name>")
  .description("Show details about a package (installed or from registry)")
  .option("--json", "Output as JSON")
  .action(async (name: string, opts: { json?: boolean }) => {
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const result = await info(db, name, paths);
    console.log(opts.json ? formatInfoJson(result) : formatInfo(result));
    db.close();
  });

program
  .command("audit")
  .description("Audit total capability surface of installed skills")
  .option("--verbose", "Show all pairwise capability warnings")
  .action((opts: { verbose?: boolean }) => {
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const result = audit(db);
    console.log(formatAudit(result, opts.verbose));
    db.close();
  });

program
  .command("disable <name>")
  .description("Disable an installed skill (preserves repo)")
  .action(async (name: string) => {
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const host = getDefaultHost();
    const result = await disable(db, paths, host, name);

    if (result.success) {
      console.log(`⏸️  Disabled ${result.name}`);
    } else {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

program
  .command("enable <name>")
  .description("Re-enable a disabled skill")
  .action(async (name: string) => {
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const host = getDefaultHost();
    const result = await enable(db, paths, host, name);

    if (result.success) {
      console.log(`✅ Enabled ${result.name}`);
    } else {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }

    db.close();
  });

program
  .command("remove <name>")
  .description("Completely uninstall a skill (supports library:artifact syntax)")
  .option("--library <name>", "Remove all artifacts from a library")
  .option("-y, --yes", "Run non-interactively, suppress prompts")
  .option(
    "--keep-deps",
    "Do not cascade removal to exclusively-owned depends_on.packages (arc#348)",
  )
  .action(async (name: string, opts: { library?: string; yes?: boolean; keepDeps?: boolean }) => {
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const host = getDefaultHost();
    const removeOpts = { yes: opts.yes, keepDeps: opts.keepDeps };

    if (opts.library) {
      // Remove all artifacts from a library
      const { listByLibrary } = await import("./lib/db.js");
      const libArtifacts = listByLibrary(db, opts.library);
      if (libArtifacts.length) {
        for (const art of libArtifacts) {
          const result = await remove(db, paths, host, art.name, removeOpts);
          if (result.success) {
            console.log(`🗑️  Removed ${result.name}`);
          }
        }
      } else {
        console.error(`❌ No artifacts found for library '${opts.library}'`);
        process.exit(1);
      }
    } else {
      // Parse library:artifact syntax
      const libRef = parseLibraryRef(name);
      const removeName = libRef?.artifactName ?? name;

      const result = await remove(db, paths, host, removeName, removeOpts);

      if (result.success) {
        console.log(`🗑️  Removed ${result.name}`);
        // arc#348: report the dependency-removal cascade.
        for (const dep of result.cascaded ?? []) {
          if (dep.success) {
            console.log(`   ↳ removed dependency ${dep.name} (no longer required)`);
          } else {
            console.log(`   ⚠ dependency ${dep.name} could not be removed: ${dep.error}`);
          }
        }
        for (const kept of result.retained ?? []) {
          console.log(
            `   ↳ kept dependency ${kept.name} (still required by: ${kept.requiredBy.join(", ")})`,
          );
        }
        // arc#359: name the runtime-created config/state remove leaves behind,
        // and the purge command that clears it.
        if (hasOwns(result.owns)) {
          const entries = purgeableEntries(result.owns);
          if (entries.length > 0) {
            console.log(`   ↳ kept (config/state): ${entries.join(", ")}`);
          }
          console.log(`   run: arc purge ${result.name}   # to also delete the above`);
        }
      } else {
        // Artifact not found — check if name matches a library
        const libResult = await removeLibrary(db, paths, host, removeName, removeOpts);
        if (libResult.success) {
          console.log(`🗑️  Removed ${libResult.removedCount} artifact(s) from library '${removeName}'`);
        } else {
          console.error(`❌ ${libResult.error}`);
          process.exit(1);
        }
      }
    }

    db.close();
  });

/**
 * Minimal y/N confirmation prompt on stdin. Returns true only on an explicit
 * yes. A non-interactive stdin (piped/closed) resolves false — callers must pass
 * `--yes` for unattended runs.
 */
async function confirmPrompt(question: string): Promise<boolean> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

program
  .command("files <name>")
  .description("List every artifact an installed package put on disk, plus its owns declarations (dpkg -L)")
  .option("--json", "Machine-readable output")
  .action(async (name: string, opts: { json?: boolean }) => {
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const host = getDefaultHost();
    const result = await filesListing(db, paths, host, name);
    db.close();
    console.log(opts.json ? formatFilesJson(result) : formatFiles(result));
    if (!result.installed) process.exit(1);
  });

program
  .command("purge <name>")
  .description("Remove a package AND delete the runtime-created config/state it declares it owns (apt-get purge). Never deletes owns.userData.")
  .option("-y, --yes", "Run non-interactively (skip the confirmation prompt)")
  .option("--dry-run", "Show the full deletion plan and delete nothing")
  .option("--keep-deps", "Do not cascade removal to exclusively-owned depends_on.packages (arc#348)")
  .action(async (name: string, opts: { yes?: boolean; dryRun?: boolean; keepDeps?: boolean }) => {
    const paths = createArcPaths();
    const db = openDatabase(paths.dbPath);
    const host = getDefaultHost();

    // Preview first (dry run mutates nothing) so we can both surface a not-
    // installed error early AND render the confirmation plan.
    const preview = await purge(db, paths, host, name, {
      dryRun: true,
      keepDeps: opts.keepDeps,
    });
    if (!preview.success) {
      console.error(`❌ ${preview.error}`);
      db.close();
      process.exit(1);
    }

    if (opts.dryRun) {
      console.log(formatPurge(preview));
      db.close();
      return;
    }

    if (!opts.yes) {
      console.log(formatPurge(preview));
      const ok = await confirmPrompt(`\nProceed with purge of '${name}'? [y/N] `);
      if (!ok) {
        console.log("Aborted; nothing deleted.");
        db.close();
        return;
      }
    }

    const result = await purge(db, paths, host, name, {
      yes: opts.yes,
      keepDeps: opts.keepDeps,
    });
    db.close();
    console.log(formatPurge(result));
    if (!result.success) process.exit(1);
  });

program
  .command("verify <name>")
  .description("Verify integrity of an installed skill")
  .action(async (name: string) => {
    const paths = createArcPaths();
    const host = getDefaultHost();
    const db = openDatabase(paths.dbPath);
    const result = await verify(db, paths, host, name);
    console.log(formatVerify(result));
    db.close();
  });

program
  .command("validate [path]")
  .description("Strictly validate an arc/v1 manifest against the skill-repo migration contract (arc#317)")
  .action(async (path?: string) => {
    const result = await validateManifest(path ?? process.cwd());
    for (const line of result.lines) {
      if (result.exitCode === 0) {
        console.log(line);
      } else {
        console.error(line);
      }
    }
    process.exit(result.exitCode);
  });

// ── Config / doctor commands ─────────────────────────────────

const config = program
  .command("config")
  .description("Manage Arc configuration");

config
  .command("get <key>")
  .description("Read a configuration value")
  .action(async (key: string) => {
    if (key !== "bin-dir") {
      console.error(`Unknown config key "${key}". Supported keys: bin-dir`);
      process.exit(1);
    }

    const paths = createArcPaths();
    const userConfig = await loadUserConfig(paths.configRoot);
    console.log(userConfig.binDir ?? paths.shimDir);
  });

config
  .command("set <key> <value>")
  .description("Set a configuration value")
  .action(async (key: string, value: string) => {
    if (key !== "bin-dir") {
      console.error(`Unknown config key "${key}". Supported keys: bin-dir`);
      process.exit(1);
    }

    const paths = createArcPaths();
    const userConfig = await loadUserConfig(paths.configRoot);
    const binDir = normalizeUserPath(value);
    await saveUserConfig(paths.configRoot, { ...userConfig, binDir });
    console.log(`bin-dir = ${binDir}`);
  });

const doctor = program
  .command("doctor")
  .description("Check local Arc setup");

doctor
  .command("path")
  .description("Check whether Arc command shims are on PATH")
  .action(() => {
    const paths = createArcPaths();
    if (isDirOnPath(paths.shimDir)) {
      console.log(`OK: ${paths.shimDir} is on PATH`);
      return;
    }

    console.log(`Arc command shims are installed in ${paths.shimDir}, but that directory is not on PATH.`);
    console.log(`Add it with: ${formatPathRepairCommand(paths.shimDir)}`);
  });

program
  .command("upgrade [name]")
  .description("Upgrade installed packages to latest version")
  .option("--check", "Only check for available upgrades, don't install")
  .option("--force", "Re-run upgrade pipeline even if already at latest version")
  .action(async (name: string | undefined, opts: { check?: boolean; force?: boolean }) => {
    const paths = createArcPaths();
    const host = getDefaultHost();
    await ensureDirectories(paths, host);
    const db = openDatabase(paths.dbPath);

    if (opts.check || (!name && !opts.force)) {
      // Check mode or upgrade-all (without force): first show what's available
      const checks = await checkUpgrades(db, paths, host);

      if (opts.check) {
        // Also check if arc itself has an update
        const selfCheck = checkSelfUpdate();
        const selfMsg = formatSelfUpdateCheck(selfCheck);
        if (selfMsg) console.log(selfMsg + "\n");
        console.log(formatCheckResults(checks));
      } else {
        // No name = upgrade all
        const upgradable = checks.filter((c) => c.upgradable);
        if (!upgradable.length) {
          console.log("All packages are up to date.");
        } else {
          console.log(`Upgrading ${upgradable.length} package(s)...\n`);
          const results = await upgradeAll(db, paths, host);
          console.log(formatUpgradeResults(results));
        }
      }
    } else if (!name && opts.force) {
      // Force upgrade all
      const results = await upgradeAll(db, paths, host, { force: true });
      if (!results.length) {
        console.log("No packages installed.");
      } else {
        console.log(formatUpgradeResults(results, { force: true }));
      }
    } else if (name) {
      // Single-package path: prior branches handled the !name cases.
      const libRef = parseLibraryRef(name);
      const upgradeName = libRef?.artifactName ?? name;
      let isLibraryUpgrade = false;

      if (!libRef?.artifactName) {
        // No colon — check if name matches a library
        const { listByLibrary } = await import("./lib/db.js");
        const libArtifacts = listByLibrary(db, name);
        if (libArtifacts.length > 0) {
          isLibraryUpgrade = true;
        }
      }

      if (isLibraryUpgrade) {
        const results = await upgradeLibrary(db, paths, host, name, { force: opts.force });
        console.log(formatUpgradeResults(results, { force: opts.force }));
      } else {
        const result = await upgradePackage(db, paths, host, upgradeName, { force: opts.force });
        if (result.success) {
          if (result.oldVersion === result.newVersion) {
            if (opts.force) {
              console.log(`${result.name}: force-upgraded at ${result.oldVersion}`);
            } else {
              console.log(`${result.name} is already at ${result.oldVersion}`);
            }
          } else {
            console.log(`${result.name}: ${result.oldVersion} → ${result.newVersion}`);
          }
          // Show any cascaded surface-adapter / dependency upgrades (arc#346).
          if (result.cascaded?.length) {
            console.log("Cascaded dependency upgrades:");
            console.log(formatUpgradeResults(result.cascaded, { force: opts.force }));
          }
        } else {
          console.error(`${result.error}`);
          process.exit(1);
        }
      }
    }

    db.close();
  });

program
  .command("init [name]")
  .description("Scaffold a new skill, tool, agent, or prompt repo")
  .option("-d, --dir <path>", "Target directory")
  .option("-a, --author <name>", "Author GitHub username")
  .option(
    "--type <type>",
    "Artifact type: skill, tool, agent, prompt, pipeline (default: skill)"
  )
  .action(
    async (
      name: string | undefined,
      opts: { dir?: string; author?: string; type?: string }
    ) => {
      const validTypes = ["skill", "tool", "agent", "prompt", "pipeline"] as const;
      type ArtifactInitType = (typeof validTypes)[number];

      const artifactType: ArtifactInitType =
        opts.type && (validTypes as readonly string[]).includes(opts.type)
          ? (opts.type as ArtifactInitType)
          : "skill";

      if (opts.type && !(validTypes as readonly string[]).includes(opts.type)) {
        console.error(
          `\n❌ Unknown type "${opts.type}". Valid types: ${validTypes.join(", ")}`
        );
        process.exit(1);
      }

      // arc#107 — resolve name + targetDir with init-in-place semantics.
      // See `resolveInitTarget` for the matrix; logic lives there as a pure
      // function so it's unit-testable.
      const resolved = resolveInitTarget({
        argName: name,
        cwd: process.cwd(),
        dirOverride: opts.dir,
      });
      if (!resolved.ok) {
        console.error(`\n❌ ${resolved.detail}`);
        process.exit(1);
      }

      const result = await init(resolved.targetDir, resolved.name, opts.author, artifactType);

      if (result.success) {
        console.log(`\n✅ Scaffolded ${artifactType} at ${result.path}`);
        console.log(`\nFiles created:`);
        for (const f of result.files ?? []) {
          console.log(`  ${f}`);
        }
      } else {
        console.error(`\n❌ ${result.error}`);
        process.exit(1);
      }
    }
  );

program
  .command("upgrade-core <version>")
  .description("Upgrade PAI core to a new version (symlink management)")
  .option(
    "--versions-dir <path>",
    "PAI versions directory",
    join(homedir(), "Developer", "pai", "versions")
  )
  .option("--branch <name>", "Branch directory name", "4.0-develop")
  .option(
    "--personal-data <path>",
    "Personal data repo path",
    join(homedir(), "Developer", "pai-personal-data")
  )
  .action(
    async (
      version: string,
      opts: {
        versionsDir: string;
        branch: string;
        personalData: string;
      }
    ) => {
      const home = homedir();
      const paths = createArcPaths();
      const db = openDatabase(paths.dbPath);

      const result = await upgradeCore(
        db,
        {
          versionsDir: opts.versionsDir,
          branch: opts.branch,
          personalDataDir: opts.personalData,
          configRoot: paths.configRoot,
          homeDir: home,
          claudeSymlink: join(home, ".claude"),
        },
        version
      );

      console.log(formatUpgrade(result));
      db.close();

      if (!result.success) process.exit(1);
    }
  );

program
  .command("self-upgrade")
  .alias("self-update")
  .description("Update arc itself (git pull + bun install)")
  .action(async () => {
    const result = await selfUpdate();
    console.log(formatSelfUpdate(result));
    if (!result.success) process.exit(1);
  });

// ── Registry search (top-level) ─────────────────────────────

program
  .command("search [keyword]")
  .description("Search all configured sources (omit keyword to list all)")
  .option("--json", "Output as JSON for machine consumption")
  .option("--type <type>", "Filter by artifact type (skill, tool, agent, prompt, component, pipeline, action)")
  .option("--tier <tier>", "Filter by source tier (official, community, custom)")
  .action(async (keyword: string | undefined, opts: { json?: boolean; type?: string; tier?: string }) => {
    const paths = createArcPaths();
    const sources = await loadSources(paths.sourcesPath);

    // Validate filters
    let typeFilter;
    if (opts.type) {
      typeFilter = parseArtifactType(opts.type);
      if (!typeFilter) {
        console.error(`Error: invalid --type "${opts.type}". Valid: skill, tool, agent, prompt, component, pipeline, action`);
        process.exit(1);
      }
    }
    let tierFilter;
    if (opts.tier) {
      tierFilter = parsePackageTier(opts.tier);
      if (!tierFilter) {
        console.error(`Error: invalid --tier "${opts.tier}". Valid: official, community, custom`);
        process.exit(1);
      }
    }

    const result = await searchAcrossSources(sources, paths.cachePath, {
      keyword,
      type: typeFilter,
      tier: tierFilter,
    });

    // Emit warnings to stderr
    const warnings = formatWarnings(result);
    if (warnings) console.error(warnings);

    if (opts.json) {
      console.log(formatSearchJson(result));
    } else {
      console.log(formatSearch(result));
    }
  });

// ── Source commands ─────────────────────────────────────────

const source = program
  .command("source")
  .description("Manage registry sources (apt-get style)");

source
  .command("list")
  .description("List configured registry sources")
  .action(async () => {
    const paths = createArcPaths();
    const config = await loadSources(paths.sourcesPath);
    console.log(formatSourceList(config));
  });

source
  .command("add <name> <url>")
  .description("Add a new registry source")
  .option("-t, --tier <tier>", "Trust tier (official|community|custom)", "community")
  .option("--type <type>", "Source type (registry|metafactory)", "registry")
  .action(async (name: string, url: string, opts: { tier: string; type: string }) => {
    const paths = createArcPaths();
    const config = await loadSources(paths.sourcesPath);

    const newSource: RegistrySource = {
      name,
      url,
      tier: opts.tier as PackageTier,
      enabled: true,
      ...(opts.type !== "registry" ? { type: opts.type as SourceType } : {}),
    };

    const validation = validateSource(newSource);
    if (!validation.valid) {
      console.error(`Error: ${validation.error}`);
      process.exit(1);
    }

    try {
      addSource(config, newSource);
      await saveSources(paths.sourcesPath, config);
      console.log(`Added source "${name}" [${opts.tier}] (${opts.type})`);
    } catch (err) {
      console.error(`Error: ${errorMessage(err)}`);
      process.exit(1);
    }
  });

source
  .command("update")
  .description("Refresh cached package indexes from all sources (like apt update)")
  .action(async () => {
    const paths = createArcPaths();
    const sources = await loadSources(paths.sourcesPath);
    const results = await updateAllSources(sources, paths.cachePath);

    for (const r of results) {
      if (r.status === "ok") {
        console.log(`  ${r.name}: ${r.count} packages`);
      } else {
        console.error(`  ${r.name}: failed`);
      }
    }
  });

source
  .command("remove <name>")
  .description("Remove a registry source")
  .action(async (name: string) => {
    const paths = createArcPaths();
    const config = await loadSources(paths.sourcesPath);

    try {
      removeSource(config, name);
      await saveSources(paths.sourcesPath, config);
      console.log(`Removed source "${name}"`);
    } catch (err) {
      console.error(`Error: ${errorMessage(err)}`);
      process.exit(1);
    }
  });

// ── Auth commands ──────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with metafactory registry (required for installs and publishing)")
  .option("-s, --source <name>", "Target source name (default: first metafactory source)")
  .option("-f, --force", "Re-authenticate even if already logged in")
  .option(
    "--token-scope <scope>",
    "Requested token scope (e.g. packages:read, packages:write). Server defaults to packages:read. Named --token-scope to avoid collision with `arc publish --scope <namespace>`.",
  )
  .action(async (opts: { source?: string; force?: boolean; tokenScope?: string }) => {
    const paths = createArcPaths();
    const result = await login({
      paths,
      sourceName: opts.source,
      force: opts.force,
      scope: opts.tokenScope,
    });

    if (result.success) {
      console.log(`Logged in to ${result.sourceName}`);
      if (result.scope) console.log(`  Scope: ${result.scope}`);
      if (result.expiresAt) console.log(`  Expires: ${new Date(result.expiresAt * 1000).toISOString()}`);
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Remove authentication from metafactory source (signed-in installs and publishing will require re-login)")
  .option("-s, --source <name>", "Target source name (default: first metafactory source)")
  .action(async (opts: { source?: string }) => {
    const paths = createArcPaths();
    const result = await logout({ paths, sourceName: opts.source });

    if (result.success) {
      console.log(`Logged out from ${result.sourceName}`);
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  });

// ── Bundle and publish commands ────────────────────────────

// `arc pack` — produce a distributable tarball from a package directory. Renamed
// from `arc bundle` (arc#63/#324): "bundle" is reserved for the multi-artifact
// repo taxonomy term, so the packaging VERB uses `pack` (npm-familiar). The old
// name stays as a deprecated hidden alias for one release.
async function runPack(path: string | undefined, opts: { output?: string }) {
  const paths = createArcPaths();
  const result = await bundle({
    paths,
    packageDir: path ?? process.cwd(),
    outputPath: opts.output,
  });
  console.log(formatBundle(result));
  if (!result.success) process.exit(1);
}

program
  .command("pack [path]")
  .description("Create a distributable tarball from a package directory. For monorepos, pass a subdirectory (e.g. `arc pack packages/my-pkg`) or use the library pattern at the repo root.")
  .option("-o, --output <path>", "Output path for the tarball")
  .action(runPack);

// Deprecated alias — `arc bundle` collided with the registry "bundle" taxonomy
// term (arc#63). Kept working for one release; warns and delegates to `arc pack`.
program
  .command("bundle [path]", { hidden: true })
  .description("Deprecated alias for `arc pack`.")
  .option("-o, --output <path>", "Output path for the tarball")
  .action(async (path: string | undefined, opts: { output?: string }) => {
    console.error("arc: `arc bundle` is deprecated and will be removed — use `arc pack`.");
    await runPack(path, opts);
  });

program
  .command("publish [path]")
  .description("Publish a package to the metafactory registry")
  .option("-t, --tarball <path>", "Publish from existing tarball (skip bundling)")
  .option("--dry-run", "Validate and show what would be published without uploading")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--scope <namespace>", "Override publish scope/namespace")
  .option("--allow-unsigned-official", "Legacy rollout escape hatch: publish to an official source without Sigstore signing")
  .action(async (path: string | undefined, opts: { tarball?: string; dryRun?: boolean; source?: string; scope?: string; allowUnsignedOfficial?: boolean }) => {
    const paths = createArcPaths();
    const result = await publish({
      paths,
      packageDir: path ?? process.cwd(),
      tarballPath: opts.tarball,
      dryRun: opts.dryRun,
      sourceName: opts.source,
      scope: opts.scope,
      allowUnsignedOfficial: opts.allowUnsignedOfficial,
    });

    console.log(formatPublish(result));
    if (!result.success) process.exit(1);
  });

// ── Review commands (sponsor/steward triage) ────────────────

const review = program
  .command("review")
  .description("Review pending package submissions (sponsor/steward)");

review
  .command("list")
  .description("List pending submissions assigned to you")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("-p, --page <number>", "Page number", "1")
  .option("--per-page <number>", "Items per page (max 100)", "20")
  .option("--json", "Output raw JSON")
  .action(async (opts: { source?: string; page: string; perPage: string; json?: boolean }) => {
    const paths = createArcPaths();
    const result = await reviewList({
      paths,
      sourceName: opts.source,
      page: parseInt(opts.page, 10) || 1,
      perPage: parseInt(opts.perPage, 10) || 20,
      json: opts.json,
    });
    console.log(formatReviewList(result));
    if (!result.success) process.exit(1);
  });

review
  .command("show <id>")
  .description("Show submission detail")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; json?: boolean }) => {
    const paths = createArcPaths();
    const result = await reviewShow({ paths, sourceName: opts.source, id, json: opts.json });
    console.log(formatReviewShow(result));
    if (!result.success) process.exit(1);
  });

review
  .command("approve <id>")
  .description("Approve a submission")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; json?: boolean }) => {
    const paths = createArcPaths();
    const result = await reviewApprove({ paths, sourceName: opts.source, id, json: opts.json });
    console.log(formatReviewAction(result));
    if (!result.success) process.exit(1);
  });

review
  .command("reject <id>")
  .description("Reject a submission (requires --reason)")
  .requiredOption("-r, --reason <text>", "Rejection reason (shown to publisher)")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; reason: string; json?: boolean }) => {
    const paths = createArcPaths();
    const result = await reviewReject({
      paths,
      sourceName: opts.source,
      id,
      reason: opts.reason,
      json: opts.json,
    });
    console.log(formatReviewAction(result));
    if (!result.success) process.exit(1);
  });

review
  .command("request-changes <id>")
  .description("Request changes from publisher (requires --message)")
  .requiredOption("-m, --message <text>", "Change request comment (shown to publisher)")
  .option("-s, --source <name>", "Use a specific metafactory source")
  .option("--json", "Output raw JSON")
  .action(async (id: string, opts: { source?: string; message: string; json?: boolean }) => {
    const paths = createArcPaths();
    const result = await reviewRequestChanges({
      paths,
      sourceName: opts.source,
      id,
      comment: opts.message,
      json: opts.json,
    });
    console.log(formatReviewAction(result));
    if (!result.success) process.exit(1);
  });

// ── NATS bot identity commands ─────────────────────────────

const nats = program
  .command("nats")
  .description("NATS bot identity management — provision per-bot users");

nats
  .command("add-bot <name>")
  .description("Issue a new per-bot NATS user with credentials")
  .option("-a, --account <account>", "NSC account name (default: active account)")
  .option("--pub <subjects>", "Comma-separated publish permissions")
  .option("--sub <subjects>", "Comma-separated subscribe permissions")
  .option("-o, --output <path>", "Credentials output path")
  .option("--force", "Overwrite existing user")
  .option("--with-identity", "Also generate Myelin signing keypair + register principal")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.v1)")
  .action(async (name: string, opts: { account?: string; pub?: string; sub?: string; output?: string; force?: boolean; withIdentity?: boolean; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = await addBot(name, { ...opts, json: true });
        const payload: AddBotJson = {
          schema: ARC_NATS_SCHEMA,
          ok: true,
          bot: r.bot,
          account: r.account,
          credsPath: r.credsPath,
          jwt: r.jwt,
          pubKey: r.pubKey,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
    }
    await addBot(name, opts);
  });

nats
  .command("reissue-bot <name>")
  .description("Revoke and re-issue credentials for a bot user")
  .option("-a, --account <account>", "NSC account name")
  .option("-o, --output <path>", "Credentials output path")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.v1)")
  .action((name: string, opts: { account?: string; output?: string; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = reissueBot(name, { ...opts, json: true });
        const payload: ReissueBotJson = {
          schema: ARC_NATS_SCHEMA,
          ok: true,
          bot: r.bot,
          account: r.account,
          credsPath: r.credsPath,
          newPubKey: r.newPubKey,
          revokedPubKey: r.revokedPubKey,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    reissueBot(name, opts);
  });

nats
  .command("list-bots")
  .description("List bot users under current operator account")
  .option("-a, --account <account>", "NSC account name")
  .action((opts: { account?: string }) => {
    listBots(opts.account);
  });

nats
  .command("remove-bot <name>")
  .description("Revoke a bot user and optionally delete credentials")
  .option("-a, --account <account>", "NSC account name")
  .option("-o, --output <path>", "Credentials file path to delete (if --delete-creds)")
  .option("--delete-creds", "Also delete the credentials file")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.v1)")
  .action((name: string, opts: { account?: string; output?: string; deleteCreds?: boolean; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = removeBot(name, { ...opts, json: true });
        const payload: RemoveBotJson = {
          schema: ARC_NATS_SCHEMA,
          ok: true,
          bot: r.bot,
          account: r.account,
          revokedPubKey: r.revokedPubKey,
          credsFileDeleted: r.credsFileDeleted,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    removeBot(name, opts);
  });

nats
  .command("setup-operator <account>")
  .description("Provision multiple bots with NATS creds + signing identity in one command")
  .requiredOption("--bots <names>", "Comma-separated bot names (e.g. jc-pilot,jc-luna,jc-ivy)")
  .option("--force", "Overwrite existing users and keys")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.v1)")
  .action(async (account: string, opts: { bots: string; force?: boolean; json?: boolean }) => {
    const botNames = opts.bots.split(",").map(s => s.trim()).filter(Boolean);
    if (botNames.length === 0) {
      if (opts.json) {
        emitJson({
          schema: ARC_NATS_SCHEMA,
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "--bots requires at least one bot name" },
        });
        process.exit(1);
      }
      console.error("Error: --bots requires at least one bot name");
      process.exit(1);
    }
    if (opts.json) {
      try {
        const r = await setupOperator(account, botNames, { force: opts.force, json: true });
        const payload: SetupOperatorJson = {
          schema: ARC_NATS_SCHEMA,
          ok: true,
          account: r.account,
          bots: r.bots,
          summary: r.summary,
        };
        emitJson(payload);
        // Exit code: 0 only if every bot succeeded. Cortex can rely on this.
        process.exit(r.summary.failed === 0 ? 0 : 1);
      } catch (err) {
        emitJson({ schema: ARC_NATS_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    await setupOperator(account, botNames, { force: opts.force });
  });

// ── F-6e (arc#229) secret provisioning commands ───────────────────
//
// `arc secrets <verb> <agent> [<secret>]` manages the per-agent secrets a
// `type: agent` package declares in `capabilities.secrets`. Storage is the
// platform backend (Keychain on macOS, chmod-600 file fallback). The verbs
// print NAMES only — a secret value never reaches stdout/stderr (issue §E).

/**
 * Resolve an installed agent's manifest from the package DB, plus a storage
 * backend scoped to that agent. Exits the process with a clear message when
 * the agent isn't installed (no value is ever involved here).
 */
async function resolveAgentSecretContext(
  agent: string,
  backendChoice?: SecretBackendChoice,
): Promise<{ manifest: ArcManifest; backend: SecretBackend }> {
  const paths = createArcPaths();
  const db = openDatabase(paths.dbPath);
  const skill = getSkill(db, agent);
  db.close();
  if (!skill) {
    console.error(`No installed package named '${agent}'. Run \`arc list\` to see installed agents.`);
    process.exit(1);
  }
  const manifest = await readManifest(skill.install_path);
  if (!manifest) {
    console.error(`Could not read the manifest for '${agent}' at ${skill.install_path}.`);
    process.exit(1);
  }
  const backend = resolveSecretBackend(agent, {
    platform: process.platform,
    secretsRoot: paths.secretsDir,
    username: secretUsername(),
    backendChoice,
  });
  return { manifest, backend };
}

/**
 * Validate a `--secret-backend` flag value into a {@link SecretBackendChoice}.
 * Exits with a clear message on an unknown value. `undefined` → `auto`.
 */
function parseSecretBackendChoice(value: string | undefined): SecretBackendChoice {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "keychain" || value === "file") return value;
  console.error(`Invalid --secret-backend "${value}". Expected: auto | keychain | file.`);
  process.exit(1);
}

/** Best-effort current username for the Keychain account scope. */
function secretUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return homedir().split("/").filter(Boolean).pop() ?? "user";
  }
}

const secrets = program
  .command("secrets")
  .description("Provision and manage per-agent secrets (capabilities.secrets)");

// All five verbs accept `--secret-backend` so an operator who provisioned with
// a forced backend (e.g. `file` on a shared host) reads/rotates/removes against
// that same backend. Omitted → `auto`.
const SECRET_BACKEND_OPT = "--secret-backend <choice>";
const SECRET_BACKEND_DESC =
  "Secret storage backend: auto (default) | keychain | file";

secrets
  .command("list <agent>")
  .description("List the secret names stored for an agent (never values)")
  .option(SECRET_BACKEND_OPT, SECRET_BACKEND_DESC)
  .action(async (agent: string, opts: { secretBackend?: string }) => {
    const { backend } = await resolveAgentSecretContext(
      agent,
      parseSecretBackendChoice(opts.secretBackend),
    );
    process.exit(await secretsList({ agent, backend }));
  });

secrets
  .command("check <agent>")
  .description("Verify every declared secret is stored; exit 1 if any missing")
  .option(SECRET_BACKEND_OPT, SECRET_BACKEND_DESC)
  .action(async (agent: string, opts: { secretBackend?: string }) => {
    const { manifest, backend } = await resolveAgentSecretContext(
      agent,
      parseSecretBackendChoice(opts.secretBackend),
    );
    process.exit(await secretsCheck(manifest, { agent, backend }));
  });

secrets
  .command("set <agent> <secret>")
  .description("Store a secret (prompts securely, or use --from-env)")
  .option("--from-env", "Take the value from the env var of the same name")
  .option(SECRET_BACKEND_OPT, SECRET_BACKEND_DESC)
  .action(async (agent: string, secret: string, opts: { fromEnv?: boolean; secretBackend?: string }) => {
    const { backend } = await resolveAgentSecretContext(
      agent,
      parseSecretBackendChoice(opts.secretBackend),
    );
    process.exit(await secretsSet(secret, { agent, backend, fromEnv: opts.fromEnv }));
  });

secrets
  .command("rotate <agent> <secret>")
  .description("Replace a secret with no in-place overwrite (delete then add)")
  .option("--from-env", "Take the new value from the env var of the same name")
  .option(SECRET_BACKEND_OPT, SECRET_BACKEND_DESC)
  .action(async (agent: string, secret: string, opts: { fromEnv?: boolean; secretBackend?: string }) => {
    const { backend } = await resolveAgentSecretContext(
      agent,
      parseSecretBackendChoice(opts.secretBackend),
    );
    process.exit(await secretsRotate(secret, { agent, backend, fromEnv: opts.fromEnv }));
  });

secrets
  .command("remove <agent> [secret]")
  .description("Remove one secret, or all declared secrets when none is named")
  .option(SECRET_BACKEND_OPT, SECRET_BACKEND_DESC)
  .action(async (agent: string, secret: string | undefined, opts: { secretBackend?: string }) => {
    const { manifest, backend } = await resolveAgentSecretContext(
      agent,
      parseSecretBackendChoice(opts.secretBackend),
    );
    process.exit(await secretsRemove({ agent, backend, name: secret, manifest }));
  });

/**
 * Shared dispatch helper for the JetStream provisioning verbs. The two
 * verbs differ only in (a) the orchestrator they call and (b) how the
 * success payload maps to the {@link ProvisionJson} envelope; everything
 * else — the try/catch shape, the dual JSON / human output path, the
 * `emitJson` + `process.exit` choreography — is identical. Extracted so
 * the next change to exit-code mapping or `classifyError` handling
 * applies to both verbs in one place (Sage cycle-1 Maintainability finding).
 */
async function runNatsProvisionCommand<R>(args: {
  json: boolean | undefined;
  run: () => Promise<R>;
  toResources: (r: R) => { resources: ProvisionJson["resources"]; natsUrl: string };
  printHuman: (r: R) => void;
}): Promise<never> {
  if (args.json) {
    try {
      const r = await args.run();
      const { resources, natsUrl } = args.toResources(r);
      emitJson({ schema: ARC_NATS_SCHEMA, ok: true, resources, natsUrl });
      process.exit(0);
    } catch (err) {
      emitJson({ schema: ARC_NATS_SCHEMA, ok: false, error: classifyError(err) });
      process.exit(1);
    }
  }
  try {
    const r = await args.run();
    args.printHuman(r);
    process.exit(0);
  } catch (err) {
    const classified = classifyError(err);
    console.error(`Error: ${classified.message}`);
    process.exit(1);
  }
}

nats
  .command("provision-streams")
  .description("Idempotently create the CODE_REVIEW JetStream stream + optional per-agent consumer")
  .option("--nats-url <url>", "NATS broker URL (defaults to $NATS_URL or nats://127.0.0.1:4222)")
  .option("--stream <name>", "Stream name override (default: CODE_REVIEW)")
  .option("--network <network>", "Network segment of the consumer name (with --agent)")
  .option("--agent <agent>", "Agent segment of the consumer name (with --network)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.v1)")
  .action(async (opts: { natsUrl?: string; stream?: string; network?: string; agent?: string; json?: boolean }) => {
    if ((opts.network && !opts.agent) || (!opts.network && opts.agent)) {
      const msg = "--network and --agent must be supplied together";
      if (opts.json) {
        emitJson({ schema: ARC_NATS_SCHEMA, ok: false, error: { code: "VALIDATION_ERROR", message: msg } });
        process.exit(1);
      }
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
    const callOpts = {
      ...(opts.natsUrl !== undefined && { natsUrl: opts.natsUrl }),
      ...(opts.stream !== undefined && { streamName: opts.stream }),
      ...(opts.network && opts.agent && { consumer: { network: opts.network, agent: opts.agent } }),
    };
    await runNatsProvisionCommand({
      json: opts.json,
      run: () => provisionStreams(callOpts),
      toResources: (r) => ({ resources: r.resources, natsUrl: r.natsUrl }),
      printHuman: (r) => {
        for (const res of r.resources) {
          const tag = res.created ? "created" : "exists";
          const where = res.stream ? ` (stream=${res.stream})` : "";
          console.log(`  ${tag} ${res.kind} ${res.name}${where}`);
        }
        console.log(`Provisioning complete against ${r.natsUrl}.`);
      },
    });
  });

nats
  .command("provision-consumer")
  .description("Idempotently create a per-(network, agent) durable consumer on the CODE_REVIEW stream")
  .requiredOption("--network <network>", "Network segment of the consumer name")
  .requiredOption("--agent <agent>", "Agent segment of the consumer name")
  .option("--nats-url <url>", "NATS broker URL (defaults to $NATS_URL or nats://127.0.0.1:4222)")
  .option("--stream <name>", "Stream name override (default: CODE_REVIEW)")
  .option("--filter-subject <subject>", "Optional consumer filter subject")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.v1)")
  .action(async (opts: {
    network: string; agent: string;
    natsUrl?: string; stream?: string; filterSubject?: string;
    json?: boolean;
  }) => {
    const callOpts = {
      network: opts.network,
      agent: opts.agent,
      ...(opts.natsUrl !== undefined && { natsUrl: opts.natsUrl }),
      ...(opts.stream !== undefined && { stream: opts.stream }),
      ...(opts.filterSubject !== undefined && { filterSubject: opts.filterSubject }),
    };
    await runNatsProvisionCommand({
      json: opts.json,
      run: () => provisionConsumer(callOpts),
      toResources: (r) => ({ resources: [r.resource], natsUrl: r.natsUrl }),
      printHuman: (r) => {
        const tag = r.resource.created ? "created" : "exists";
        console.log(`  ${tag} consumer ${r.resource.name} (stream=${r.resource.stream})`);
        console.log(`Provisioning complete against ${r.natsUrl}.`);
      },
    });
  });

// ── G1b: cross-account federation export/import (cortex#1117) ─────────────
//
// `arc nats add-federation-export` wires the federated.> subject-export from
// the leaf-bound NSC account (`--from-account`) into the hub's stack account
// (`--to-account`). Both the nsc add export and nsc add import are performed
// atomically, then both accounts are pushed so the JWT resolver picks up the
// changes without a server restart.
//
// Dry-run by default (prints the nsc commands that would run); --apply executes.
// JSON output uses schema `arc.nats.federation.v1` — a separate namespace from
// `arc.nats.v1` so existing consumers that guard on ARC_NATS_SCHEMA are unaffected.

nats
  .command("add-federation-export")
  .description("Wire federated.> cross-account export/import on the hub (G1b — cortex#1117)")
  .requiredOption("--from-account <account>", "Leaf-bound NSC account (exporting side, e.g. OP_JC)")
  .requiredOption("--to-account <account>", "Hub destination NSC account (importing side, e.g. OP_ANDREAS)")
  .option("--subject <pattern>", "Subject pattern to export/import (default: \"federated.>\")")
  .option("--service", "Add --service to nsc add export (for request/reply patterns; rarely needed)")
  .option("--apply", "Execute the nsc mutations and push both accounts (default: dry-run)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.federation.v1)")
  .action((opts: {
    fromAccount: string;
    toAccount: string;
    subject?: string;
    service?: boolean;
    apply?: boolean;
    json?: boolean;
  }) => {
    if (opts.json) {
      try {
        const r = addFederationExport({ ...opts, json: true });
        const payload: AddFederationExportJson = {
          schema: ARC_NATS_FEDERATION_SCHEMA,
          ok: true,
          fromAccount: r.fromAccount,
          toAccount: r.toAccount,
          subject: r.subject,
          exportAdded: r.exportAdded,
          importAdded: r.importAdded,
          exportAlreadyPresent: r.exportAlreadyPresent,
          importAlreadyPresent: r.importAlreadyPresent,
          ...(r.pushResult !== undefined && { pushResult: r.pushResult }),
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_FEDERATION_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    addFederationExport(opts);
  });

// ── arc#252: sovereign-operator topology (init-operator + add-account) ────────
//
// The two primitives `cortex network provision <stack>` wraps (alongside add-bot
// + add-federation-export) so a principal can stand up their OWN nsc operator and
// mint their own accounts — no raw nsc. Each is idempotent and supports --json
// (schema arc.nats.operator.v1, a separate namespace from arc.nats.v1 /
// arc.nats.federation.v1 so existing consumers are unaffected).

nats
  .command("init-operator")
  .description("Create the principal's nsc operator if absent (idempotent; arc#252)")
  .option("--name <operator>", "Operator name to create (default: current nsc operator)")
  .option("--force", "Recreate even if it exists — DESTRUCTIVE: regenerates the operator identity key")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.operator.v1)")
  .action((opts: { name?: string; force?: boolean; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = initOperator({ ...opts, json: true });
        const payload: InitOperatorJson = {
          schema: ARC_NATS_OPERATOR_SCHEMA,
          ok: true,
          operator: r.operator,
          pubKey: r.pubKey,
          created: r.created,
          alreadyExisted: r.alreadyExisted,
          seedPath: r.seedPath,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_OPERATOR_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    initOperator(opts);
  });

nats
  .command("add-account <name>")
  .description("Create an account under the current nsc operator if absent (idempotent; arc#252)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.operator.v1)")
  .action((name: string, opts: { json?: boolean }) => {
    if (opts.json) {
      try {
        const r = addAccount(name, { json: true });
        const payload: AddAccountJson = {
          schema: ARC_NATS_OPERATOR_SCHEMA,
          ok: true,
          account: r.account,
          pubKey: r.pubKey,
          created: r.created,
          alreadyExisted: r.alreadyExisted,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_OPERATOR_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    addAccount(name, opts);
  });

nats
  .command("add-federated-user <name>")
  .description(
    "Mint a subject-scoped hub-transport user under an account's federated scoped signing key " +
      "(idempotent; permissions are hardwired templates, never flags; cortex#1598)",
  )
  .requiredOption("--account <ACCOUNT>", "The hub federation account (any-case nsc name, e.g. metafactory). Required — hub topology is never inferred.")
  .option("--output <path>", "Creds output path (default: ~/.config/nats/<name>.creds)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.federated-user.v1)")
  .action((name: string, opts: { account: string; output?: string; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = addFederatedUser(name, {
          account: opts.account,
          ...(opts.output !== undefined && { output: opts.output }),
          json: true,
        });
        // Field names match AddFederatedUserResult 1:1 — spread so a new field
        // is added in two places (result + json interface), not three.
        const payload: AddFederatedUserJson = {
          schema: ARC_NATS_FEDERATED_USER_SCHEMA,
          ok: true,
          ...r,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_FEDERATED_USER_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    addFederatedUser(name, {
      account: opts.account,
      ...(opts.output !== undefined && { output: opts.output }),
    });
  });

nats
  .command("reissue-federated-user <name>")
  .description(
    "Rotate a subject-scoped federated user: revoke + push the old key, re-mint fresh material " +
      "under the same scoped signing key (no hub restart; cortex#1599)",
  )
  .requiredOption("--account <ACCOUNT>", "The hub federation account (any-case nsc name, e.g. metafactory). Required — hub topology is never inferred.")
  .option("--output <path>", "Creds output path (default: ~/.config/nats/<name>.creds)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.federated-user.v1)")
  .action((name: string, opts: { account: string; output?: string; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = reissueFederatedUser(name, {
          account: opts.account,
          ...(opts.output !== undefined && { output: opts.output }),
          json: true,
        });
        const payload: ReissueFederatedUserJson = {
          schema: ARC_NATS_FEDERATED_USER_SCHEMA,
          ok: true,
          ...r,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_FEDERATED_USER_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    reissueFederatedUser(name, {
      account: opts.account,
      ...(opts.output !== undefined && { output: opts.output }),
    });
  });

nats
  .command("revoke-federated-user <name>")
  .description(
    "Revoke a subject-scoped federated user: add to the account revocation map + push, cutting " +
      "the leaf at runtime (no hub restart; cortex#1599)",
  )
  .requiredOption("--account <ACCOUNT>", "The hub federation account (any-case nsc name, e.g. metafactory). Required — hub topology is never inferred.")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.federated-user.v1)")
  .action((name: string, opts: { account: string; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = revokeFederatedUser(name, { account: opts.account, json: true });
        const payload: RevokeFederatedUserJson = {
          schema: ARC_NATS_FEDERATED_USER_SCHEMA,
          ok: true,
          ...r,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_FEDERATED_USER_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    revokeFederatedUser(name, { account: opts.account });
  });

nats
  .command("export-account <name>")
  .description("Export an account's JWT + identity seed path (read-only; cortex#1257 make-live)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.operator.v1)")
  .action((name: string, opts: { json?: boolean }) => {
    if (opts.json) {
      try {
        const r = exportAccount(name, { json: true });
        const payload: ExportAccountJson = {
          schema: ARC_NATS_OPERATOR_SCHEMA,
          ok: true,
          account: r.account,
          pubKey: r.pubKey,
          jwt: r.jwt,
          seedPath: r.seedPath,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_OPERATOR_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    exportAccount(name, opts);
  });

nats
  .command("export-operator")
  .description("Export the operator JWT + identity seed path (read-only; cortex#1265 server-config)")
  .option("--name <operator>", "Operator name (default: the current nsc operator)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.operator.v1)")
  .action((opts: { name?: string; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = exportOperator({ ...opts, json: true });
        const payload: ExportOperatorJson = {
          schema: ARC_NATS_OPERATOR_SCHEMA,
          ok: true,
          operator: r.operator,
          pubKey: r.pubKey,
          jwt: r.jwt,
          seedPath: r.seedPath,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_OPERATOR_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    exportOperator(opts);
  });

nats
  .command("export-system")
  .description("Export the operator's SYS account pubkey + JWT (read-only; cortex#1265 server-config)")
  .option("--name <account>", "System-account name (default: SYS)")
  .option("--json", "Emit a single line of stable JSON (schema: arc.nats.operator.v1)")
  .action((opts: { name?: string; json?: boolean }) => {
    if (opts.json) {
      try {
        const r = exportSystem({ ...opts, json: true });
        const payload: ExportSystemJson = {
          schema: ARC_NATS_OPERATOR_SCHEMA,
          ok: true,
          account: r.account,
          pubKey: r.pubKey,
          jwt: r.jwt,
          seedPath: r.seedPath,
        };
        emitJson(payload);
        process.exit(0);
      } catch (err) {
        emitJson({ schema: ARC_NATS_OPERATOR_SCHEMA, ok: false, error: classifyError(err) });
        process.exit(1);
      }
      return;
    }
    exportSystem(opts);
  });

// ── Identity management commands ──────────────────────────

const identity = program
  .command("identity")
  .description("Myelin signing identity — keypairs, principals, export/import");

identity
  .command("generate <name>")
  .description("Generate Ed25519 signing keypair and register principal")
  .requiredOption("-a, --account <account>", "Operator account (used as principal.operator)")
  .option("--force", "Overwrite existing key")
  .action(async (name: string, opts: { account: string; force?: boolean }) => {
    await generateIdentity(name, opts.account, { force: opts.force });
  });

identity
  .command("list")
  .description("List registered principals")
  .action(() => {
    listPrincipals();
  });

identity
  .command("export")
  .description("Export principals to stdout (pipe to file for sharing)")
  .option("-a, --account <account>", "Filter to one operator's principals")
  .action((opts: { account?: string }) => {
    exportPrincipals(opts.account);
  });

identity
  .command("import <file>")
  .description("Import principals from another operator's export file")
  .action((file: string) => {
    importPrincipals(file);
  });

// #287 (P2): migration-on-touch. The first time ANY arc command runs after the
// XDG cutover, relocate arc's own dirs (repos → data, cache → cache, config
// children → config, packages.db → data) from the legacy `~/.config/metafactory`
// tree to the XDG layout — copy-keep-source, rewrite the db path rows, and
// re-point every `~/.claude/{skills,agents,commands,bin}` symlink in lockstep.
// Gated to the default layout: a relocated (ARC_CONFIG_ROOT) or test-overridden
// tree keeps the legacy single-tree layout and this is a no-op. Never blocks the
// command — on any failure the legacy tree is intact and still in use.
program.hook("preAction", () => {
  try {
    if (!isArcDefaultLayout()) return;
    const arc = createArcPaths();
    migrateArcDirsIfNeeded({
      legacy: legacyArcLayout(),
      next: toArcDirLayout(arc),
      host: getDefaultHost(),
    });
  } catch (err) {
    console.warn(
      `arc: XDG migration check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
});

await program.parseAsync();
