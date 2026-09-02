import { ARTIFACT_TYPES } from "../types.js";
import type {
  SearchOptions,
  SearchResult,
  SourcesConfig,
  SourcedSearchResult,
  ArtifactType,
  PackageTier,
} from "../types.js";
import { fetchRemoteRegistry } from "../lib/remote-registry.js";
import { searchRegistry } from "../lib/registry.js";

/**
 * Search across all enabled sources and return results with metadata.
 * Captures per-source success/failure for actionable warnings.
 */
export async function searchAcrossSources(
  sources: SourcesConfig,
  cachePath: string,
  opts?: SearchOptions,
): Promise<SearchResult> {
  const enabledSources = sources.sources.filter((s) => s.enabled);
  const totalSources = enabledSources.length;
  const keyword = opts?.keyword ?? "";

  const results: SourcedSearchResult[] = [];
  const warnings: SearchResult["warnings"] = [];
  let successfulSources = 0;

  const fetches = enabledSources.map(async (source) => {
    try {
      const registry = await fetchRemoteRegistry(source, cachePath);
      if (!registry) {
        warnings.push({
          sourceName: source.name,
          reason: "unreachable",
          message: `Source "${source.name}" unreachable`,
          usedStaleCache: false,
        });
        return;
      }

      successfulSources++;

      const matches = searchRegistry(registry, keyword);
      for (const m of matches) {
        results.push({
          entry: m.entry,
          artifactType: m.artifactType,
          sourceName: source.name,
          sourceTier: source.tier,
        });
      }
    } catch (_err) {
      warnings.push({
        sourceName: source.name,
        reason: "malformed",
        message: `Source "${source.name}" returned malformed data`,
        usedStaleCache: false,
      });
    }
  });

  await Promise.all(fetches);

  // Apply filters
  let filtered = results;
  if (opts?.type) {
    filtered = filtered.filter((r) => r.artifactType === opts.type);
  }
  if (opts?.tier) {
    filtered = filtered.filter((r) => r.sourceTier === opts.tier);
  }

  return {
    results: filtered,
    warnings,
    totalSources,
    successfulSources,
  };
}

/** Format search results for human-readable terminal output */
export function formatSearch(result: SearchResult): string {
  if (!result.results.length) {
    if (result.totalSources === 0) {
      return "No sources configured. Run: arc source add metafactory https://meta-factory.ai --type metafactory";
    }
    return "No matches found across any source.";
  }

  const lines: string[] = [
    `Found ${result.results.length} match(es) across ${result.successfulSources}/${result.totalSources} sources:`,
    "",
  ];

  for (const r of result.results) {
    const statusBadge =
      r.entry.status === "shipped"
        ? ""
        : r.entry.status === "beta"
          ? " (beta)"
          : " (deprecated)";
    const tierBadge = `[${r.sourceTier}]`;

    lines.push(
      `  ${r.entry.name} [${r.artifactType}]${statusBadge} ${tierBadge} — ${r.entry.description}`,
    );
    lines.push(`    by ${r.entry.author} | source: ${r.sourceName}`);
    if (r.entry.reviewed_by?.length) {
      lines.push(`    reviewed by: ${r.entry.reviewed_by.join(", ")}`);
    }
  }

  return lines.join("\n");
}

/** Format search warnings for stderr output */
export function formatWarnings(result: SearchResult): string {
  if (!result.warnings.length) return "";
  return result.warnings
    .map((w) => {
      const staleSuffix = w.usedStaleCache ? " (using stale cache)" : "";
      return `Warning: ${w.message}${staleSuffix}`;
    })
    .join("\n");
}

/** Format search results as JSON for machine consumption */
export function formatSearchJson(result: SearchResult): string {
  const output = {
    results: result.results.map((r) => ({
      name: r.entry.name,
      description: r.entry.description,
      type: r.artifactType,
      author: r.entry.author,
      version: r.entry.version,
      status: r.entry.status,
      source: {
        name: r.sourceName,
        tier: r.sourceTier,
        url: r.entry.source,
      },
      reviewedBy: r.entry.reviewed_by ?? [],
    })),
    meta: {
      total: result.results.length,
      sources: {
        total: result.totalSources,
        successful: result.successfulSources,
        failed: result.warnings.length,
      },
      warnings: result.warnings,
    },
  };
  return JSON.stringify(output, null, 2);
}

/**
 * Parse and validate an ArtifactType string from CLI.
 *
 * Derived from the single source `ARTIFACT_TYPES` (arc#399 / D7.1) — this was a
 * hand-copied list that had silently drifted, rejecting `--type system`,
 * `--type rules`, `--type library`, `--type process` and `--type governance`
 * even though packages of those types are installed and listed.
 */
export function parseArtifactType(input: string): ArtifactType | null {
  return (ARTIFACT_TYPES as readonly string[]).includes(input)
    ? (input as ArtifactType)
    : null;
}

/** Parse and validate a PackageTier string from CLI */
export function parsePackageTier(input: string): PackageTier | null {
  const valid: PackageTier[] = ["official", "community", "custom"];
  return valid.includes(input as PackageTier) ? (input as PackageTier) : null;
}
