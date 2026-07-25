/**
 * Test environment helper for arc.
 *
 * Creates isolated temp directories that simulate the arc directory structure.
 * Every test gets its own fresh environment — no cross-test contamination.
 */

import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import YAML from "yaml";
import {
  createArcPaths,
  ensureDirectories,
  getDefaultHost,
} from "../../src/lib/paths.js";
import { openDatabase } from "../../src/lib/db.js";
import type { ArcPaths, HostAdapter } from "../../src/types.js";

export interface TestEnv {
  /** Root temp directory for this test */
  root: string;
  /** arc's host-independent state paths (configRoot, dbPath, …). */
  arc: ArcPaths;
  /** Target host adapter (Claude Code by default, with paths rooted at the temp dir). */
  host: HostAdapter;
  /** Open database for this test */
  db: Database;
  /** Clean up temp directory and close database */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated test environment.
 * Call cleanup() when done.
 */
export async function createTestEnv(): Promise<TestEnv> {
  const root = await mkdtemp(join(tmpdir(), "arc-test-"));

  const claudeRoot = join(root, ".claude");
  const configRoot = join(root, ".config", "metafactory");

  const arc = createArcPaths({
    configRoot,
    // XDG class roots (#287 wave-1). Today all three collapse onto configRoot —
    // no separate dirs are created (see ensureDirectories).
    dataRoot: configRoot,
    stateRoot: configRoot,
    cacheRoot: configRoot,
    reposDir: join(configRoot, "pkg", "repos"),
    cachePath: join(configRoot, "pkg", "cache"),
    dbPath: join(configRoot, "packages.db"),
    sourcesPath: join(configRoot, "sources.yaml"),
    secretsDir: join(configRoot, "secrets"),
    runtimeDir: join(configRoot, "skills"),
    actionsDir: join(configRoot, "actions"),
    shimDir: join(root, "bin"),
    registryPath: join(root, "registry.yaml"),
  });
  const host = getDefaultHost({ root: claudeRoot });

  await ensureDirectories(arc, host);
  const db = openDatabase(arc.dbPath);

  return {
    root,
    arc,
    host,
    db,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface MockSkillRepo {
  /** Path to the mock skill repo */
  path: string;
  /** Git repo URL (local path, usable by git clone) */
  url: string;
}

/**
 * Create a mock skill repo with git initialized.
 * The repo has a skill/ dir, arc-manifest.yaml, and optionally src/.
 */
export async function createMockSkillRepo(
  root: string,
  opts: {
    name: string;
    version?: string;
    author?: string;
    /** Use authors array format instead of singular author */
    authors?: { name: string; github: string }[];
    /** Artifact type: skill (default), tool, agent, prompt, component, pipeline, action */
    type?: "skill" | "tool" | "agent" | "prompt" | "component" | "pipeline" | "action";
    withCli?: boolean;
    withoutManifest?: boolean;
    capabilities?: {
      network?: { domain: string; reason: string }[];
      filesystem?: { read?: string[]; write?: string[] };
      bash?: { allowed: boolean; restricted_to?: string[] };
      secrets?: string[];
    };
    /** Additional CLI entries beyond the default one */
    extraCli?: { name: string; command: string }[];
    /** Lifecycle scripts to declare in the manifest and create on disk */
    scripts?: {
      preinstall?: { path: string; content: string };
      postinstall?: { path: string; content: string };
      preupgrade?: { path: string; content: string };
      postupgrade?: { path: string; content: string };
      preremove?: { path: string; content: string };
      /** scripts.purge (arc#359) — runs during `arc purge` after owns deletion. */
      purge?: { path: string; content: string };
    };
    /** owns purge-scope declaration (arc#359). Rendered verbatim into the manifest. */
    owns?: { config?: string[]; state?: string[]; userData?: string[] };
    /** provides.files entries to declare in the manifest. Source files
     *  are created on disk so install can symlink them. */
    files?: { source: string; target: string; content?: string }[];
    /** Arbitrary extra files to materialise in the repo (committed), beyond
     *  what the manifest declares. Use for a purge hook's sibling helpers
     *  (e.g. `scripts/lib/*.sh`) that arc must snapshot alongside the hook
     *  (arc#372). Paths are relative to the repo root. */
    extraFiles?: { path: string; content: string }[];
    /**
     * Ordered lifecycle script arrays (arc#140). Each phase is an ordered
     * list of `{ path, content }`. The helper writes each script to disk
     * (executable) and the manifest's `lifecycle.<phase>` is rendered as
     * the array of paths in declared order.
     */
    lifecycle?: {
      preinstall?: { path: string; content: string }[];
      postinstall?: { path: string; content: string }[];
      preuninstall?: { path: string; content: string }[];
      postuninstall?: { path: string; content: string }[];
    };
    /** Runtime broker requirements (arc#152). e.g. `{ nats: true }`. */
    requires?: { nats?: boolean };
    /**
     * Instance-state opt-in (arc#281). type:agent only. When set, the manifest
     * declares `state: { blueprint, version }`, opting the agent into the
     * instance-state scaffold at install. Omit for a stateless agent.
     */
    state?: { blueprint: string; version: string };
    /**
     * depends_on.skills entries (arc#284 compat-surfacing WARN). Additive to
     * the fixed `depends_on.tools: [{ name: "bun", ... }]` this helper
     * always renders.
     */
    dependsOnSkills?: { name: string; version?: string; reason?: string }[];
    /**
     * depends_on.packages entries (arc#346 upgrade cascade / arc#306 install).
     * Each `{ name, repo }` names a first-party arc package this one pulls in —
     * e.g. cortex declaring its surface-adapter bundles. Rendered additively to
     * the fixed `depends_on.tools`.
     */
    dependsOnPackages?: { name: string; repo: string; version?: string }[];
  }
): Promise<MockSkillRepo> {
  const repoDir = join(root, `mock-${opts.name}`);
  const artifactType = opts.type ?? "skill";

  if (artifactType === "skill") {
    // Create skill directory
    const skillDir = join(repoDir, "skill");
    await Bun.write(
      join(skillDir, "SKILL.md"),
      `---\nname: ${opts.name}\ndescription: Mock skill for testing\n---\n\n# ${opts.name}\n\nTest skill.\n`
    );

    await Bun.write(
      join(skillDir, "workflows", "Main.md"),
      `# Main Workflow\n\n1. Do the thing\n`
    );
  } else if (artifactType === "tool") {
    // Tools: CLI entry point at root
    await Bun.write(
      join(repoDir, "src", "tool.ts"),
      `#!/usr/bin/env bun\nconsole.log("${opts.name} CLI tool");\n`
    );
    await Bun.write(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: `arc-tool-${opts.name.toLowerCase()}`,
          version: opts.version ?? "1.0.0",
          type: "module",
        },
        null,
        2
      ) + "\n"
    );
  } else if (artifactType === "agent") {
    // Agents: single markdown file in agent/ subdir
    const agentDir = join(repoDir, "agent");
    await Bun.write(
      join(agentDir, `${opts.name}.md`),
      `---\nname: ${opts.name}\ndescription: Mock agent for testing\nmodel: sonnet\n---\n\n# ${opts.name}\n\nTest agent persona.\n`
    );
  } else if (artifactType === "prompt") {
    // Prompts: single markdown file in prompt/ subdir
    const promptDir = join(repoDir, "prompt");
    await Bun.write(
      join(promptDir, `${opts.name}.md`),
      `---\nname: ${opts.name}\ndescription: Mock prompt for testing\n---\n\n# ${opts.name}\n\nTest prompt/command.\n`
    );
  }

  // Create lifecycle script files if declared
  if (opts.scripts) {
    for (const [, script] of Object.entries(opts.scripts)) {
      const scriptAbsPath = join(repoDir, script.path);
      await Bun.write(scriptAbsPath, script.content);
      // Make executable
      Bun.spawnSync(["chmod", "+x", scriptAbsPath], { stdout: "pipe", stderr: "pipe" });
    }
  }

  // Arbitrary extra files (e.g. a purge hook's sibling lib/*.sh — arc#372).
  if (opts.extraFiles?.length) {
    for (const f of opts.extraFiles) {
      await Bun.write(join(repoDir, f.path), f.content);
    }
  }

  // Create source files referenced by provides.files. install needs the
  // source to exist or it bails out via the pre-validation pass in
  // createArtifactSymlinks (#84).
  if (opts.files?.length) {
    for (const f of opts.files) {
      await Bun.write(join(repoDir, f.source), f.content ?? `// mock ${f.source}\n`);
    }
  }

  if (opts.lifecycle) {
    for (const phase of Object.values(opts.lifecycle)) {
      if (!phase) continue;
      for (const script of phase) {
        const scriptAbsPath = join(repoDir, script.path);
        await Bun.write(scriptAbsPath, script.content);
        Bun.spawnSync(["chmod", "+x", scriptAbsPath], { stdout: "pipe", stderr: "pipe" });
      }
    }
  }

  // Create arc-manifest.yaml (unless testing without it)
  if (!opts.withoutManifest) {
    const caps = opts.capabilities ?? {};
    const isTool = artifactType === "tool";
    const manifest = {
      name: opts.name,
      version: opts.version ?? "1.0.0",
      type: artifactType,
      tier: "custom",
      ...(opts.authors
        ? { authors: opts.authors }
        : { author: { name: opts.author ?? "testuser", github: opts.author ?? "testuser" } }),
      provides: {
        ...(artifactType === "skill"
          ? { skill: [{ trigger: opts.name.replace(/^_/, "").toLowerCase() }] }
          : {}),
        ...(opts.withCli || isTool
          ? { cli: [
              { command: `bun src/tool.ts`, name: opts.name.replace(/^_/, "").toLowerCase() },
              ...(opts.extraCli ?? []),
            ] }
          : {}),
        ...(opts.files?.length
          ? { files: opts.files.map((f) => ({ source: f.source, target: f.target })) }
          : {}),
      },
      depends_on: {
        tools: [{ name: "bun", version: ">=1.0.0" }],
        ...(opts.dependsOnSkills?.length ? { skills: opts.dependsOnSkills } : {}),
        ...(opts.dependsOnPackages?.length ? { packages: opts.dependsOnPackages } : {}),
      },
      capabilities: {
        filesystem: caps.filesystem ?? { read: [], write: [] },
        network: caps.network ?? [],
        bash: caps.bash ?? { allowed: false },
        secrets: caps.secrets ?? [],
      },
      ...(opts.scripts ? {
        scripts: Object.fromEntries(
          Object.entries(opts.scripts).map(([hook, s]) => [hook, s.path])
        ),
      } : {}),
      ...(opts.lifecycle ? {
        lifecycle: Object.fromEntries(
          Object.entries(opts.lifecycle)
            .filter(([, arr]) => arr && arr.length > 0)
            .map(([phase, arr]) => [phase, arr.map((s) => s.path)]),
        ),
      } : {}),
      ...(opts.requires ? { requires: opts.requires } : {}),
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.owns ? { owns: opts.owns } : {}),
    };

    // Write as YAML manually (avoid dependency on yaml in test helper)
    const yaml = buildYaml(manifest);
    await Bun.write(join(repoDir, "arc-manifest.yaml"), yaml);
  }

  // Create src/ if CLI tool (for skills with CLI)
  if (opts.withCli && artifactType === "skill") {
    await Bun.write(
      join(repoDir, "src", "tool.ts"),
      `#!/usr/bin/env bun\nconsole.log("${opts.name} CLI tool");\n`
    );

    await Bun.write(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: `arc-skill-${opts.name.replace(/^_/, "").toLowerCase()}`,
          version: opts.version ?? "1.0.0",
          type: "module",
        },
        null,
        2
      ) + "\n"
    );
  }

  // Initialize git repo and commit
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "Initial commit"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );

  return {
    path: repoDir,
    url: repoDir, // git clone accepts local paths
  };
}

export interface MockLibraryRepo {
  path: string;
  url: string;
}

/**
 * Create a mock library repo with multiple artifacts for testing.
 */
export async function createMockLibraryRepo(
  root: string,
  opts: {
    name: string;
    version?: string;
    author?: string;
    artifacts: {
      path: string;
      name: string;
      type: "skill" | "tool" | "agent" | "prompt" | "pipeline" | "component" | "action";
      version?: string;
      description?: string;
      /**
       * Names of OTHER artifacts in this library this one depends on (arc#227).
       * Rendered into `depends_on.packages` as `{ name, repo }` so the library
       * install toposort orders this artifact after its dependencies.
       */
      dependsOn?: string[];
      /**
       * Optional postinstall script (arc#227 rollback tests). Written to disk
       * and declared in the artifact manifest's `scripts.postinstall`. Use a
       * non-zero exit (`exit 1`) to simulate a mid-sequence install failure.
       */
      postinstall?: { path: string; content: string };
    }[];
  }
): Promise<MockLibraryRepo> {
  const repoDir = join(root, `mock-lib-${opts.name}`);

  // Create root manifest
  const rootManifest = {
    schema: "arc/v1",
    name: opts.name,
    version: opts.version ?? "1.0.0",
    type: "library",
    author: { name: opts.author ?? "testuser", github: opts.author ?? "testuser" },
    description: `Mock library ${opts.name}`,
    artifacts: opts.artifacts.map((a) => ({
      path: a.path,
      description: a.description ?? `${a.name} artifact`,
    })),
  };

  await Bun.write(join(repoDir, "arc-manifest.yaml"), buildYaml(rootManifest));

  // Create each artifact subdirectory with its own manifest
  for (const artifact of opts.artifacts) {
    const artifactDir = join(repoDir, artifact.path);

    // Intra-library package deps (arc#227) plus the default bun tool dep.
    const packageDeps = (artifact.dependsOn ?? []).map((name) => ({
      name,
      repo: `the-metafactory/${name}`,
    }));

    const artifactManifest: Record<string, unknown> = {
      schema: "arc/v1",
      name: artifact.name,
      version: artifact.version ?? "1.0.0",
      type: artifact.type,
      author: { name: opts.author ?? "testuser", github: opts.author ?? "testuser" },
      provides: artifact.type === "skill"
        ? { skill: [{ trigger: artifact.name.toLowerCase() }] }
        : {},
      depends_on: {
        tools: [{ name: "bun", version: ">=1.0.0" }],
        ...(packageDeps.length ? { packages: packageDeps } : {}),
      },
      ...(artifact.postinstall
        ? { scripts: { postinstall: artifact.postinstall.path } }
        : {}),
      capabilities: {
        filesystem: { read: ["./"], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    };

    await Bun.write(join(artifactDir, "arc-manifest.yaml"), buildYaml(artifactManifest));

    // Write the postinstall script (executable) when declared.
    if (artifact.postinstall) {
      const scriptAbsPath = join(artifactDir, artifact.postinstall.path);
      await Bun.write(scriptAbsPath, artifact.postinstall.content);
      Bun.spawnSync(["chmod", "+x", scriptAbsPath], { stdout: "pipe", stderr: "pipe" });
    }

    // Create type-specific content
    if (artifact.type === "skill") {
      await Bun.write(
        join(artifactDir, "skill", "SKILL.md"),
        `# ${artifact.name}\n\nTest skill.\n`
      );
    } else if (artifact.type === "agent") {
      await Bun.write(
        join(artifactDir, "agent", `${artifact.name}.md`),
        `# ${artifact.name}\n\nTest agent.\n`
      );
    } else if (artifact.type === "prompt") {
      await Bun.write(
        join(artifactDir, "prompt", `${artifact.name}.md`),
        `# ${artifact.name}\n\nTest prompt.\n`
      );
    }
  }

  // Initialize git repo
  Bun.spawnSync(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "add", "."], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "Initial commit"],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );

  return { path: repoDir, url: repoDir };
}

/**
 * Create an isolated package directory with an arc-manifest.yaml.
 * Used across bundle and publish tests to reduce boilerplate.
 */
export async function createPackageDir(
  dir: string,
  manifest: Record<string, any>,
  opts?: { withReadme?: boolean; withSkillDir?: boolean; extraFiles?: Record<string, string> },
): Promise<string> {
  const pkgDir = join(dir, "pkg");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "arc-manifest.yaml"), YAML.stringify(manifest));
  if (opts?.withSkillDir !== false) {
    await mkdir(join(pkgDir, "skill"), { recursive: true });
    await writeFile(join(pkgDir, "skill/SKILL.md"), "# Test\n\nSkill content.\n");
  }
  if (opts?.withReadme !== false) {
    await writeFile(join(pkgDir, "README.md"), "# Test Package\n");
  }
  if (opts?.extraFiles) {
    for (const [filePath, content] of Object.entries(opts.extraFiles)) {
      const fullPath = join(pkgDir, filePath);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content);
    }
  }
  return pkgDir;
}

/**
 * Simple YAML builder (avoids external dependency in test helper).
 * Only handles the specific arc-manifest structure.
 */
function buildYaml(obj: any, indent = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";

  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;

    if (Array.isArray(val)) {
      if (val.length === 0) {
        out += `${pad}${key}: []\n`;
      } else if (typeof val[0] === "object") {
        out += `${pad}${key}:\n`;
        for (const item of val) {
          const entries = Object.entries(item);
          out += `${pad}  - ${entries[0][0]}: ${JSON.stringify(entries[0][1])}\n`;
          for (let i = 1; i < entries.length; i++) {
            out += `${pad}    ${entries[i][0]}: ${JSON.stringify(entries[i][1])}\n`;
          }
        }
      } else {
        out += `${pad}${key}:\n`;
        for (const item of val) {
          out += `${pad}  - ${JSON.stringify(item)}\n`;
        }
      }
    } else if (typeof val === "object") {
      out += `${pad}${key}:\n`;
      out += buildYaml(val, indent + 1);
    } else if (typeof val === "boolean" || typeof val === "number") {
      out += `${pad}${key}: ${val}\n`;
    } else if (typeof val === "string") {
      // Quote strings that begin with a YAML-significant indicator (e.g. a
      // version range like ">=0.1.0", which YAML would otherwise read as a
      // block-scalar header). JSON.stringify gives a safe double-quoted form;
      // plain strings pass through unquoted to keep existing fixtures readable.
      const needsQuote = /^[>|&*!%@`"'#\-?:,[\]{}]/.test(val) || /[:#]\s/.test(val);
      out += `${pad}${key}: ${needsQuote ? JSON.stringify(val) : val}\n`;
    } else {
      // Fallback for unexpected types (bigint, symbol, function); JSON.stringify
      // gives a sensible "null"/quoted representation.
      out += `${pad}${key}: ${JSON.stringify(val)}\n`;
    }
  }

  return out;
}
