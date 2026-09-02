import type { Database } from "bun:sqlite";
import { allCompositions, listSkills, listByLibrary } from "../lib/db.js";
import type { CompositionMemberRow } from "../lib/db.js";
import type { ArtifactType, InstalledSkill } from "../types.js";

export interface ListResult {
  skills: InstalledSkill[];
  /**
   * Resolved membership for every installed `bundle`/`factory`, keyed by
   * composition name (arc#400 D2/D4). Absent when a caller built a ListResult
   * without one — `formatListJson` then simply omits the key, so an older
   * caller keeps its exact previous output.
   */
  compositions?: Map<string, CompositionMemberRow[]>;
}

export interface ListOptions {
  /** Filter by artifact type */
  type?: ArtifactType;
  /** Filter by library name */
  library?: string;
}

/**
 * List all installed skills with version and status.
 */
export function list(db: Database, opts?: ListOptions): ListResult {
  let skills: InstalledSkill[];
  if (opts?.library) {
    skills = listByLibrary(db, opts.library);
  } else {
    skills = listSkills(db);
  }
  if (opts?.type) {
    skills = skills.filter((s) => s.artifact_type === opts.type);
  }
  return { skills, compositions: allCompositions(db) };
}

/**
 * Format installed packages as JSON for machine consumption.
 *
 * A `bundle`/`factory` gains a `composition` object naming its resolved
 * members and the version each is PINNED to, in declaration order (arc#400
 * D2/D4). This is the machine-readable half of "the composition is recorded":
 * `arc list --json | jq '.packages[] | select(.composition)'` answers "what is
 * this factory made of, exactly" without opening the database — and it is the
 * surface the lifecycle slice (arc#401) reads for upgrade/files/purge cascade.
 *
 * The key is OMITTED for a package with no recorded members, so every existing
 * consumer of this output sees byte-identical JSON for a non-composition
 * package.
 */
export function formatListJson(result: ListResult): string {
  const packages = result.skills.map((s) => {
    const members = result.compositions?.get(s.name);
    return {
      name: s.name,
      version: s.version,
      type: s.artifact_type,
      status: s.status,
      tier: s.tier,
      repoUrl: s.repo_url,
      installPath: s.install_path,
      ...(s.library_name ? { library: s.library_name } : {}),
      ...(members?.length
        ? {
            composition: {
              members: members.map((m) => ({
                name: m.member_name,
                version: m.member_version,
                source: m.member_source,
                ref: m.member_ref,
              })),
            },
          }
        : {}),
    };
  });
  return JSON.stringify({ packages }, null, 2);
}

/**
 * Format the list for console display.
 */
export function formatList(result: ListResult): string {
  if (result.skills.length === 0) {
    return "No packages installed.";
  }

  const skills = result.skills.filter((s) => !["tool", "pipeline", "action"].includes(s.artifact_type));
  const tools = result.skills.filter((s) => s.artifact_type === "tool");
  const actions = result.skills.filter((s) => s.artifact_type === "action");
  const pipelines = result.skills.filter((s) => s.artifact_type === "pipeline");
  const lines: string[] = [];
  let sectionCount = 0;

  const formatSection = (items: InstalledSkill[], label: string) => {
    if (!items.length) return;
    if (sectionCount > 0) lines.push("");
    lines.push(`Installed ${label} (${items.length}):`, "");
    for (const s of items) {
      const statusBadge = s.status === "active" ? "✅" : "⏸️";
      const tierBadge = s.tier === "official" ? " (official)" : s.tier === "community" ? " (community)" : "";
      const customBadge = s.customization_path ? " *" : "";
      const libraryBadge = s.library_name ? ` 📚${s.library_name}` : "";
      lines.push(`  ${statusBadge} ${s.name} v${s.version} [${s.status}]${tierBadge}${customBadge}${libraryBadge}`);
    }
    sectionCount++;
  };

  formatSection(skills, "skills");
  formatSection(tools, "tools");
  formatSection(actions, "actions");
  formatSection(pipelines, "pipelines");

  if (result.skills.some((s) => s.customization_path)) {
    lines.push("", "  * = has local customizations");
  }

  return lines.join("\n");
}
