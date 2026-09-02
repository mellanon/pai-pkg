/**
 * `arc files <name>` (arc#359) — dpkg -L for an installed package.
 *
 * Lists every artifact the package put on disk, grouped, each with a liveness
 * marker, PLUS the package's `owns:` purge-scope declarations. Read-only: it
 * never touches disk beyond stat. Gives testers the diffable inventory (what a
 * reset must account for) without a hand-maintained doc.
 *
 * Two audiences, one source of truth:
 *   - `formatFiles`     — human table.
 *   - `formatFilesJson` — machine-readable (`--json`).
 */

import { join } from "path";
import { homedir } from "os";
import type { Database } from "bun:sqlite";
import type { ArcManifest, ArcPaths, HostAdapter, InstalledSkill } from "../types.js";
import {
  compositionMembers,
  compositionRecord,
  getSkill,
  recordCompositionInventory,
  type CompositionStatus,
} from "../lib/db.js";
import { inventoryFromListings } from "../lib/composition-inventory.js";
import { readManifest } from "../lib/manifest.js";
import { extractAllCliInfo } from "../lib/symlinks.js";
import { resolveProvidesTarget } from "../lib/provides-target.js";
import { listPackageHooks } from "../lib/hooks.js";
import { resolveHost } from "../lib/hosts/registry.js";
import { isDarwinLaunchdHost } from "../lib/hosts/darwin-launchd.js";
import { isLinuxSystemdHost } from "../lib/hosts/linux-systemd.js";
import { basename } from "path";
import {
  OWNS_CLASSES,
  type OwnsClass,
  expandOwnsEntry,
  pathLiveness,
} from "../lib/owns.js";

/** Liveness of a filesystem artifact. */
export type Liveness = "present" | "absent";

/** One installed-artifact line. */
export interface FileArtifact {
  /** Group label: "artifact symlink", "cli shim", "bin symlink", "provides.files", "hook", "unit". */
  kind: string;
  /** The path (or, for a hook, a `settings.json` descriptor). */
  path: string;
  liveness: Liveness;
  /** Hook-only: the event the command is registered under. */
  event?: string;
  /**
   * arc#401 D3: on a COMPOSITION's listing (the union of its members'
   * footprints), the member that contributed this line. Absent on an ordinary
   * package's listing, so a non-composition's JSON is byte-identical to what
   * arc#359 emitted.
   */
  member?: string;
}

/** One owns declaration + its resolved matches. */
export interface OwnsListing {
  class: OwnsClass;
  entry: string;
  /** "purge deletes" for config/state; "kept always" for userData. */
  disposition: "purge deletes" | "kept always";
  matches: { path: string; liveness: Liveness }[];
  /** arc#401 D3: the contributing member, on a composition's union. */
  member?: string;
}

export interface FilesResult {
  name: string;
  installed: boolean;
  error?: string;
  artifacts: FileArtifact[];
  owns: OwnsListing[];
  /**
   * arc#401 D3 — present only for a recorded `bundle`/`factory`.
   *
   * `artifacts`/`owns` above are then the UNION (the factory's own install plus
   * every member's), each line attributed via `member`; this block carries the
   * per-member listings unmerged, so an operator can read either the whole
   * composition's footprint or one member's.
   */
  composition?: {
    status: CompositionStatus;
    /** Per-member listings, in the composition's declaration order. */
    members: FilesResult[];
  };
}

export interface FilesOptions {
  /** Home root for `~`-rooted owns expansion. Defaults to `homedir()`. Tests inject a temp home. */
  home?: string;
}

/**
 * Build the file inventory for an installed package.
 *
 * For a recorded composition (arc#401 D3) this is the UNION: the factory's own
 * manifest install plus every member's footprint, each line attributed to the
 * member that contributed it. That union is what `arc purge <factory>` has to
 * account for, so it is also what the install-time inventory snapshot is built
 * from — one walk, two consumers, no second opinion about what a composition
 * put on the machine.
 *
 * Errors cleanly (never throws) when the package is not installed — except for
 * the one case where "not installed" is itself the story: an INTERRUPTED
 * composition install has landed members but no `skills` row for the factory.
 * That still lists, with `installed: false` on the factory's own line and the
 * landed members enumerated, because a listing that said only "not installed"
 * would hide exactly the debris the operator is looking for.
 */
export async function filesListing(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: FilesOptions = {},
): Promise<FilesResult> {
  const own = await ownFilesListing(db, arc, host, name, opts);

  const record = compositionRecord(db, name);
  if (!record) return own;

  const members: FilesResult[] = [];
  for (const row of compositionMembers(db, name)) {
    members.push(await ownFilesListing(db, arc, host, row.member_name, opts));
  }

  const attribute = (listing: FilesResult): FilesResult => ({
    ...listing,
    artifacts: listing.artifacts.map((a) => ({ ...a, member: listing.name })),
    owns: listing.owns.map((o) => ({ ...o, member: listing.name })),
  });
  const attributed = [attribute(own), ...members.map(attribute)];

  return {
    ...own,
    artifacts: attributed.flatMap((l) => l.artifacts),
    owns: attributed.flatMap((l) => l.owns),
    composition: { status: record.status, members },
  };
}

/** One package's own footprint — the arc#359 listing, unchanged. */
async function ownFilesListing(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: FilesOptions = {},
): Promise<FilesResult> {
  const home = opts.home ?? homedir();
  const skill = getSkill(db, name);
  if (!skill) {
    return {
      name,
      installed: false,
      error: `'${name}' is not installed. Run \`arc list\` to see installed packages.`,
      artifacts: [],
      owns: [],
    };
  }

  const manifest = await readManifest(skill.install_path).catch(() => null);
  const artifacts: FileArtifact[] = [];

  // 1. Primary artifact symlink (type-conventional).
  for (const p of primaryArtifactPaths(skill, host, arc)) {
    artifacts.push({ kind: "artifact symlink", path: p, liveness: pathLiveness(p) });
  }

  // 2. CLI shims + bin symlinks.
  if (manifest) {
    for (const cli of extractAllCliInfo(manifest)) {
      const shim = join(arc.shimDir, cli.binName);
      const bin = join(host.paths.binDir, cli.binName);
      artifacts.push({ kind: "cli shim", path: shim, liveness: pathLiveness(shim) });
      artifacts.push({ kind: "bin symlink", path: bin, liveness: pathLiveness(bin) });
    }
  }

  // 3. provides.files targets.
  for (const f of manifest?.provides?.files ?? []) {
    const target = resolveProvidesTarget(f.target, { home });
    artifacts.push({ kind: "provides.files", path: target, liveness: pathLiveness(target) });
  }

  // 4. Per-target units / plists (standalone-bot agents).
  if (manifest) {
    for (const t of manifest.targets ?? []) {
      const unit = perTargetUnitPath(t, manifest);
      if (unit) artifacts.push({ kind: "unit", path: unit, liveness: pathLiveness(unit) });
    }
  }

  // 5. Hooks (settings.json, tag-keyed). Their presence IS the settings.json entry.
  for (const hook of listPackageHooks(name, host.paths.settingsPath)) {
    artifacts.push({
      kind: "hook",
      path: `${host.paths.settingsPath} :: ${hook.command}`,
      liveness: "present",
      event: hook.event,
    });
  }

  // 6. owns declarations (config/state deleted by purge; userData kept).
  const owns: OwnsListing[] = [];
  for (const cls of OWNS_CLASSES) {
    const entries = manifest?.owns?.[cls] ?? [];
    for (const entry of entries) {
      const matches = expandOwnsEntry(entry, home).map((path) => ({
        path,
        liveness: pathLiveness(path),
      }));
      owns.push({
        class: cls,
        entry,
        disposition: cls === "userData" ? "kept always" : "purge deletes",
        matches,
      });
    }
  }

  return { name, installed: true, artifacts, owns };
}

/**
 * Take the composition's install-time INVENTORY SNAPSHOT and persist it
 * (arc#401 D6). Called by `install` once the composition is complete, and by
 * `upgrade` once it has moved to a new release.
 *
 * The snapshot is built from `filesListing` — the SAME walk `arc files
 * <factory>` prints — so the record and the command can never disagree about
 * what the composition put on the machine. That is the whole reason the union
 * lives in `filesListing` rather than in a private helper here.
 *
 * `home` only decides the install-time `present` flag: owns rows store the
 * DECLARATION (`~/.config/…`), which is home-independent and re-expanded
 * against the caller's home at diff time. So a snapshot taken under one home
 * still diffs correctly under another — which is exactly what lets a test rig
 * inject a temp home for the verification half.
 */
export async function recordCompositionSnapshot(
  db: Database,
  arc: ArcPaths,
  host: HostAdapter,
  name: string,
  opts: FilesOptions = {},
): Promise<void> {
  const listing = await filesListing(db, arc, host, name, opts);
  if (!listing.composition) return;
  // The per-member listings, unmerged — the union's attribution is for display;
  // the snapshot wants each package's own footprint keyed by its own name.
  recordCompositionInventory(
    db,
    name,
    inventoryFromListings([
      await ownFilesListing(db, arc, host, name, opts),
      ...listing.composition.members,
    ]),
  );
}

/** Type-conventional primary symlink path(s) — mirrors remove.ts dispatch. */
function primaryArtifactPaths(
  skill: InstalledSkill,
  host: HostAdapter,
  arc: ArcPaths,
): string[] {
  switch (skill.artifact_type) {
    case "agent":
      return [join(host.paths.agentsDir, `${skill.name}.md`), join(host.paths.agentsDir, skill.name)];
    case "prompt":
      return [join(host.paths.promptsDir, `${skill.name}.md`), join(host.paths.promptsDir, skill.name)];
    case "tool":
      return [join(host.paths.binDir, skill.name)];
    case "action":
      return [join(arc.actionsDir, skill.name)];
    case "pipeline":
      return [join(arc.pipelinesDir, skill.name)];
    default:
      return [join(host.paths.skillsDir, skill.name)];
  }
}

/** Resolve the unit/plist target path for a supervision target, if the manifest
 *  declares one. Returns null for non-supervision targets or when undeclared. */
function perTargetUnitPath(target: string, manifest: ArcManifest): string | null {
  if (target === "darwin-launchd" && manifest.provides?.plist) {
    const h = resolveHost(target);
    if (isDarwinLaunchdHost(h)) return join(h.paths.plistDir, basename(manifest.provides.plist));
  }
  if (target === "linux-systemd" && manifest.provides?.systemdUnit) {
    const h = resolveHost(target);
    if (isLinuxSystemdHost(h)) return join(h.paths.unitDir, basename(manifest.provides.systemdUnit));
  }
  return null;
}

const MARK = { present: "●", absent: "○" } as const;

/** Human-readable table. */
export function formatFiles(result: FilesResult): string {
  // A composition still lists when its own package is missing: that is the
  // INTERRUPTED install, and the landed members are the point (arc#401).
  if (!result.installed && !result.composition) return `Error: ${result.error}`;

  const composition = result.composition;
  const lines: string[] = [
    composition
      ? `Files for composition '${result.name}' (${composition.status}; ${composition.members.length} member(s) — union below):`
      : `Files for '${result.name}':`,
  ];
  if (composition && !result.installed) {
    lines.push(`  ⚠ the composition's own package is NOT installed — ${result.error}`);
  }

  if (result.artifacts.length === 0) {
    lines.push("  (no arc-installed artifacts on disk)");
  } else {
    lines.push("", "  Installed by arc (arc remove tears these down):");
    for (const a of result.artifacts) {
      const mark = MARK[a.liveness];
      const label = a.event ? `${a.kind} [${a.event}]` : a.kind;
      const from = a.member ? `${a.member}: ` : "";
      lines.push(`    ${mark} ${a.liveness.padEnd(7)} ${label.padEnd(16)} ${from}${a.path}`);
    }
  }

  if (result.owns.length > 0) {
    lines.push("", "  Declared owns (runtime-created; arc purge acts on these):");
    for (const o of result.owns) {
      const tag = o.class === "userData" ? "(owns) kept always" : "(owns) purge deletes";
      const from = o.member ? `${o.member}: ` : "";
      lines.push(`    ${from}${o.class}: ${o.entry}  — ${tag}`);
      if (o.matches.length === 0) {
        lines.push(`        ${MARK.absent} absent  (no match on disk)`);
      } else {
        for (const m of o.matches) {
          lines.push(`        ${MARK[m.liveness]} ${m.liveness.padEnd(7)} ${m.path}`);
        }
      }
    }
  }

  if (composition) {
    lines.push("", "  Members:");
    for (const member of composition.members) {
      lines.push(
        `    ${member.installed ? MARK.present : MARK.absent} ${member.name}` +
          (member.installed ? "" : " — not installed"),
      );
    }
  }

  return lines.join("\n");
}

/** Machine-readable (`--json`). */
export function formatFilesJson(result: FilesResult): string {
  if (!result.installed && !result.composition) {
    return JSON.stringify({ name: result.name, installed: false, error: result.error }, null, 2);
  }
  return JSON.stringify(
    {
      name: result.name,
      installed: result.installed,
      ...(result.error ? { error: result.error } : {}),
      artifacts: result.artifacts,
      owns: result.owns,
      ...(result.composition
        ? {
            composition: {
              status: result.composition.status,
              members: result.composition.members.map((m) => ({
                name: m.name,
                installed: m.installed,
                artifacts: m.artifacts,
                owns: m.owns,
              })),
            },
          }
        : {}),
    },
    null,
    2,
  );
}
