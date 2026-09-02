import type { Database } from "bun:sqlite";
import { allCompositions, listSkills, listByLibrary } from "../lib/db.js";
import type { CompositionMemberRow, CompositionRow } from "../lib/db.js";
import type { ArtifactType, InstalledSkill } from "../types.js";

/** A composition as `arc list` reports it: its header plus its membership. */
export interface ListedComposition {
  record: CompositionRow;
  members: CompositionMemberRow[];
}

export interface ListResult {
  skills: InstalledSkill[];
  /**
   * Every recorded composition — header plus membership — keyed by name
   * (arc#400 D2/D4).
   *
   * Includes `pending` ones, whose package row does not exist because the
   * install never finished. That inclusion is the point: an interrupted
   * composition is exactly the case `arc list` most needs to show, and it is
   * invisible in `skills` (arc#400 review, F3). Absent when a caller builds a
   * ListResult by hand — the formatters then omit both surfaces, so an older
   * caller's output stays byte-identical.
   */
  compositions?: Map<string, ListedComposition>;
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
 *
 * A top-level `compositions` array carries EVERY composition record, including
 * `pending` ones (arc#400 review, F3). An interrupted install has no package
 * row, so `packages[]` cannot represent it and the per-package key would hide
 * it entirely — which is the "arc list lies by omission" hole. Both surfaces
 * read the same rows; this one is the complete answer, and it is where arc#401's
 * sweep looks for compositions that need finishing or cleaning up.
 */
export function formatListJson(result: ListResult): string {
  // `name` is the name the member LANDED under — the `skills.name` a consumer
  // can join on (arc#401 review, ROOT 1). `label` is what `references[]` called
  // it, and appears ONLY when the two differ (which is every `@scope/name`
  // member), so a composition whose labels already are manifest names emits
  // byte-identical JSON to before.
  const memberJson = (m: CompositionMemberRow) => ({
    name: m.member_name,
    ...(m.member_label && m.member_label !== m.member_name ? { label: m.member_label } : {}),
    version: m.member_version,
    source: m.member_source,
    ref: m.member_ref,
    state: m.state,
  });

  const packages = result.skills.map((s) => {
    const composition = result.compositions?.get(s.name);
    return {
      name: s.name,
      version: s.version,
      type: s.artifact_type,
      status: s.status,
      tier: s.tier,
      repoUrl: s.repo_url,
      installPath: s.install_path,
      ...(s.library_name ? { library: s.library_name } : {}),
      ...(composition?.members.length
        ? {
            composition: {
              status: composition.record.status,
              members: composition.members.map(memberJson),
            },
          }
        : {}),
    };
  });

  if (!result.compositions) return JSON.stringify({ packages }, null, 2);

  const compositions = [...result.compositions.values()].map((c) => ({
    name: c.record.name,
    version: c.record.version,
    status: c.record.status,
    startedAt: c.record.started_at,
    updatedAt: c.record.updated_at,
    members: c.members.map(memberJson),
  }));
  return JSON.stringify({ packages, compositions }, null, 2);
}

/**
 * Format the list for console display.
 */
export function formatList(result: ListResult): string {
  // Compositions that never finished installing (arc#400 review, F3). Rendered
  // even when nothing else is installed: "No packages installed." while a
  // half-installed factory's members sit on disk is the lie F3 is about.
  const incomplete = [...(result.compositions?.values() ?? [])].filter(
    (c) => c.record.status !== "complete",
  );
  const incompleteLines: string[] = [];
  if (incomplete.length > 0) {
    incompleteLines.push("", `⚠️  Incomplete compositions (${incomplete.length}):`, "");
    for (const c of incomplete) {
      const landed = c.members.filter((m) => m.state === "landed");
      incompleteLines.push(
        `  ⏳ ${c.record.name} v${c.record.version} — ${landed.length}/${c.members.length} member(s) landed`,
      );
      for (const m of c.members) {
        incompleteLines.push(
          `       ${m.state === "landed" ? "✅" : "⬜"} ${m.member_name} v${m.member_version}`,
        );
      }
    }
    incompleteLines.push(
      "",
      "  Re-run the install to finish, or `arc remove <member>` to take the landed ones down.",
    );
  }

  if (result.skills.length === 0) {
    return incompleteLines.length > 0
      ? ["No packages installed.", ...incompleteLines].join("\n")
      : "No packages installed.";
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

  lines.push(...incompleteLines);

  return lines.join("\n");
}
