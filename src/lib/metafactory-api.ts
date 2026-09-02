import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type {
  RegistrySource,
  RegistryConfig,
  RegistryEntry,
  ArtifactType,
  MetafactoryPackageListItem,
  MetafactoryPackageListResponse,
  MetafactoryPackageDetail,
} from "../types.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PAGES = 5;
const REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Convert a metafactory API package to arc's RegistryEntry format */
export function mapApiPackageToRegistryEntry(pkg: MetafactoryPackageListItem): {
  entry: RegistryEntry;
  artifactType: ArtifactType;
} {
  const entry: RegistryEntry = {
    name: `${pkg.namespace}/${pkg.name}`,
    description: pkg.description ?? "",
    author: pkg.publisher.display_name ?? "unknown",
    version: pkg.latest_version ?? "0.0.0",
    source: "", // Not available from list endpoint; resolved in detail fetch
    trust: "community",
    status: "shipped",
  };

  // Map INBOUND registry type → arc ArtifactType. This is deliberately NOT the
  // arc type enum (ARTIFACT_TYPES) — it is the fold from the registry's
  // vocabulary into arc's, so registry-only values land on the nearest arc type
  // (D7.3: `playbook` and `graph` stay registry-only until an arc consumer
  // exists, so they fold rather than being added to arc's enum).
  const typeMap: Record<string, ArtifactType> = {
    skill: "skill",
    tool: "tool",
    agent: "agent",
    prompt: "prompt",
    component: "component",
    pipeline: "pipeline",
    action: "action",
    rules: "skill", // rules are a skill subtype in arc
    playbook: "skill",
    graph: "component",
    // arc#399: arc now has these types, so a registry bundle/factory keeps its
    // own identity instead of being displayed as a skill by the `?? "skill"`
    // fallback below.
    bundle: "bundle",
    factory: "factory",
  };
  const artifactType: ArtifactType = typeMap[pkg.type] ?? "skill";

  return { entry, artifactType };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function cacheFileName(source: RegistrySource): string {
  return `${source.name}-metafactory.json`;
}

async function isCacheFresh(cachePath: string, source: RegistrySource): Promise<boolean> {
  const filePath = join(cachePath, cacheFileName(source));
  if (!existsSync(filePath)) return false;
  try {
    const st = await stat(filePath);
    return Date.now() - st.mtimeMs < CACHE_TTL_MS;
  } catch (_err) {
    return false;
  }
}

async function readCachedRegistry(cachePath: string, source: RegistrySource): Promise<RegistryConfig | null> {
  const filePath = join(cachePath, cacheFileName(source));
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as RegistryConfig;
  } catch (_err) {
    return null;
  }
}

async function cacheRegistry(cachePath: string, source: RegistrySource, config: RegistryConfig): Promise<void> {
  if (!existsSync(cachePath)) {
    await mkdir(cachePath, { recursive: true });
  }
  const filePath = join(cachePath, cacheFileName(source));
  await writeFile(filePath, JSON.stringify(config), "utf-8");
}

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

function debugLog(msg: string): void {
  if (process.env.ARC_DEBUG === "1") {
    process.stderr.write(`[arc:metafactory] ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Build headers for read-only API requests (anonymous — no auth token). */
function buildReadHeaders(): Record<string, string> {
  return { Accept: "application/json" };
}

// NOTE: Authenticated headers (Bearer token) are only used by publish.ts,
// which manages its own auth header construction.
// All read operations (list, detail, search) are anonymous per DD-80.

// ---------------------------------------------------------------------------
// Convert API response to RegistryConfig
// ---------------------------------------------------------------------------

function convertToRegistryConfig(packages: MetafactoryPackageListItem[]): RegistryConfig {
  const config: RegistryConfig = {
    registry: {
      skills: [],
      tools: [],
      agents: [],
      prompts: [],
      components: [],
      rules: [],
    },
  };

  for (const pkg of packages) {
    const { entry, artifactType } = mapApiPackageToRegistryEntry(pkg);
    // pipeline, action, rules all route to skills — arc's registry model treats them
    // as skill subtypes. Separate arrays exist in RegistryConfig but are only used
    // by REGISTRY.yaml sources that explicitly categorize them.
    if (artifactType === "component") {
      config.registry.components ??= [];
    }
    const target = artifactType === "tool" ? config.registry.tools
      : artifactType === "agent" ? config.registry.agents
      : artifactType === "prompt" ? config.registry.prompts
      : artifactType === "component" ? config.registry.components ?? []
      : config.registry.skills;
    target.push(entry);
  }

  return config;
}

// ---------------------------------------------------------------------------
// fetchMetafactoryRegistry
// ---------------------------------------------------------------------------

/**
 * Fetch package list from metafactory API and return as RegistryConfig.
 * Caches for 1 hour. Falls back to stale cache on error.
 */
export async function fetchMetafactoryRegistry(
  source: RegistrySource,
  cachePath: string,
  forceRefresh?: boolean,
): Promise<RegistryConfig | null> {
  // Check cache
  if (!forceRefresh && await isCacheFresh(cachePath, source)) {
    const cached = await readCachedRegistry(cachePath, source);
    if (cached) {
      debugLog(`Using cached data for ${source.name}`);
      return cached;
    }
  }

  // Fetch from API (with pagination)
  const allPackages: MetafactoryPackageListItem[] = [];
  let page = 1;

  try {
    while (page <= MAX_PAGES) {
      const url = `${source.url}/api/v1/packages?per_page=100&page=${page}`;
      debugLog(`Fetching ${url} (anonymous)`);

      const response = await fetch(url, {
        headers: buildReadHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 401 || response.status === 403) {
        process.stderr.write(`Access denied by ${source.name}. The registry may require authentication for this endpoint.\n`);
        return await readCachedRegistry(cachePath, source);
      }

      if (response.status === 429) {
        process.stderr.write(`Rate limited by ${source.name}. Try again later.\n`);
        return await readCachedRegistry(cachePath, source);
      }

      if (!response.ok) {
        debugLog(`API error from ${source.name}: ${response.status}`);
        return await readCachedRegistry(cachePath, source);
      }

      const body = (await response.json()) as Partial<MetafactoryPackageListResponse>;
      if (!Array.isArray(body.packages)) {
        debugLog(`Invalid response from ${source.name}: missing packages array`);
        return await readCachedRegistry(cachePath, source);
      }
      allPackages.push(...body.packages);

      // Check if there are more pages
      const perPage = body.per_page ?? body.packages.length;
      const total = body.total ?? allPackages.length;
      if (body.packages.length < perPage || allPackages.length >= total) {
        break;
      }
      page++;
    }

    if (page > MAX_PAGES) {
      debugLog(`Hit MAX_PAGES (${MAX_PAGES}) for ${source.name} — ${allPackages.length} of ${allPackages.length}+ packages fetched. Some packages may be missing.`);
    }
  } catch (_err) {
    // Network error -- try stale cache
    debugLog(`Network error for ${source.name}, trying stale cache`);
    const stale = await readCachedRegistry(cachePath, source);
    if (stale) return stale;
    return null;
  }

  const config = convertToRegistryConfig(allPackages);
  debugLog(`Fetched ${allPackages.length} packages from ${source.name}`);

  // Cache the result
  await cacheRegistry(cachePath, source, config).catch((_err: unknown) => {
    // Cache write failure is non-fatal
    debugLog(`Failed to cache results for ${source.name}`);
  });

  return config;
}

// ---------------------------------------------------------------------------
// fetchMetafactoryPackageDetail
// ---------------------------------------------------------------------------

/**
 * Fetch detailed package info from metafactory API.
 * Used by install flow (F-4) to get versions, SHA-256, trust metadata.
 */
export async function fetchMetafactoryPackageDetail(
  source: RegistrySource,
  scope: string,
  name: string,
): Promise<MetafactoryPackageDetail | null> {
  const url = `${source.url}/api/v1/packages/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`;
  debugLog(`Fetching detail: ${url}`);

  try {
    const response = await fetch(url, {
      headers: buildReadHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      process.stderr.write(`Access denied fetching package detail from ${source.name}. The package may require authentication.\n`);
      return null;
    }

    if (!response.ok) {
      debugLog(`Package detail error: ${response.status}`);
      return null;
    }

    return (await response.json()) as MetafactoryPackageDetail;
  } catch (_err) {
    // Network error
    debugLog(`Network error fetching package detail from ${source.name}`);
    return null;
  }
}
