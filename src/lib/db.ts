import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, sep } from "path";
import type {
  InstalledSkill,
  CapabilityRecord,
  ArcManifest,
} from "../types.js";
import { normalizeDeclaredSecrets } from "./secrets.js";
import type { InventoryEntry } from "./composition-inventory.js";
import type { OwnsClass } from "./owns.js";

/**
 * Initialize (or open) the packages database.
 * Creates tables if they don't exist.
 *
 * Ensures the parent directory exists first: since #287 the db lives under the
 * XDG data root (`~/.local/share/metafactory/arc/`), which read-only commands
 * (`list`, `info`, …) may reach before any `ensureDirectories` call has created
 * it. `new Database(path, {create:true})` creates the FILE but not parent DIRs,
 * so without this a first-touch read command would throw ENOENT.
 */
export function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA foreign_keys=ON;");

  db.run(`
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      install_path TEXT NOT NULL,
      skill_dir TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      artifact_type TEXT NOT NULL DEFAULT 'skill',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration: add artifact_type column to existing databases
  try {
    db.run(`ALTER TABLE skills ADD COLUMN artifact_type TEXT NOT NULL DEFAULT 'skill'`);
  } catch {
    // Column already exists — expected for new or already-migrated databases
  }

  // Migration: add tier and customization_path columns
  try {
    db.run(`ALTER TABLE skills ADD COLUMN tier TEXT NOT NULL DEFAULT 'custom'`);
  } catch {
    // Column already exists
  }
  try {
    db.run(`ALTER TABLE skills ADD COLUMN customization_path TEXT`);
  } catch {
    // Column already exists
  }
  try {
    db.run(`ALTER TABLE skills ADD COLUMN install_source TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add library_name column for library-sourced artifacts
  try {
    db.run(`ALTER TABLE skills ADD COLUMN library_name TEXT`);
  } catch {
    // Column already exists
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (skill_name) REFERENCES skills(name) ON DELETE CASCADE
    );
  `);

  // The COMPOSITION a `type: bundle` / `type: factory` install resolved
  // (arc#400, docs/design-factory-type.md D2/D4).
  //
  // Deliberately minimal: the member list plus the version each was PINNED to,
  // in declaration order, with the address that resolved it. That is exactly
  // what makes a factory release a reproducible snapshot (D4) and exactly what
  // the lifecycle slice needs.
  //
  // ── INPUT TO arc#401 ──────────────────────────────────────────────────────
  // #401 (upgrade / files / purge cascade, D3+D6) reads these rows as its
  // membership source of truth: `arc upgrade <factory>` moves members to the
  // NEW release's pins by diffing against these; `arc files <factory>` unions
  // the member footprints these name; `arc purge <factory>` cascades over them,
  // refcounted per arc#349. Nothing else is stored here on purpose — the
  // install-time inventory snapshot D6 asks for is #401's to design, and a
  // half-guessed schema for it now would be one #401 has to migrate away from.
  //
  // ── WHY THE HEADER IS NOT FK'd TO `skills` (arc#400 review, F3) ───────────
  // The composition record is written BEFORE the first member installs and
  // finalized after the composition's own row commits, so that a run killed in
  // between — or a member failing at runtime — leaves a visible INCOMPLETE
  // composition rather than a set of member packages that look standalone and a
  // factory that was never here. A FK to `skills` would forbid exactly that:
  // the skills row does not exist yet at the moment the record must be written.
  // `removeSkill` therefore deletes the header explicitly; membership cascades
  // off the header, so `arc remove <factory>` still leaves nothing orphaned.
  db.run(`
    CREATE TABLE IF NOT EXISTS compositions (
      name TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS composition_members (
      composition_name TEXT NOT NULL,
      member_name TEXT NOT NULL,
      member_version TEXT NOT NULL,
      member_source TEXT NOT NULL,
      member_ref TEXT NOT NULL,
      position INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (composition_name, member_name),
      FOREIGN KEY (composition_name) REFERENCES compositions(name) ON DELETE CASCADE
    );
  `);

  // The install-time INVENTORY SNAPSHOT of the whole composition (arc#401,
  // docs/design-factory-type.md D6 — #365's NON-NEGOTIABLE).
  //
  // `composition_members` says WHAT the composition is; this says what it PUT
  // ON THE MACHINE. `arc purge <factory>` re-checks every row against disk
  // afterwards, and the resulting diff — empty except user-data refusals — is
  // the acceptance test for untangle symmetry.
  //
  // The shape is `arc files`' output, one row per line it would print: an
  // `owns:` row stores the DECLARATION (re-expanded at diff time, because a
  // package's runtime creates those paths AFTER install — see the header of
  // lib/composition-inventory.ts, which owns the semantics), every other row a
  // resolved absolute path. `present` is liveness at install.
  //
  // Cascades off the composition header, like membership: a composition that
  // has been purged has no inventory, and `arc purge` computes its diff from
  // the rows it read into memory BEFORE tearing the record down.
  db.run(`
    CREATE TABLE IF NOT EXISTS composition_inventory (
      composition_name TEXT NOT NULL,
      member_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      -- '' rather than NULL for a non-owns row: SQLite permits NULLs in the
      -- PRIMARY KEY of a rowid table, so a nullable column here would silently
      -- stop de-duplicating the very rows the diff walks.
      owns_class TEXT NOT NULL DEFAULT '',
      entry TEXT NOT NULL,
      present INTEGER NOT NULL,
      PRIMARY KEY (composition_name, member_name, kind, owns_class, entry),
      FOREIGN KEY (composition_name) REFERENCES compositions(name) ON DELETE CASCADE
    );
  `);

  return db;
}

/** Lifecycle of a composition install: in flight, or finished. */
export type CompositionStatus = "pending" | "complete";

/** The header row for a composition install (arc#400). */
export interface CompositionRow {
  name: string;
  version: string;
  /**
   * `pending` — members are landing, or the install was interrupted before the
   * composition's own row committed. `complete` — everything landed.
   */
  status: CompositionStatus;
  started_at: string;
  updated_at: string;
}

/** One row of `composition_members` — a pinned member of a bundle/factory. */
export interface CompositionMemberRow {
  composition_name: string;
  member_name: string;
  member_version: string;
  /** How the member was addressed: "registry" (`@scope/name`) or "repo" (URL). */
  member_source: string;
  /** The address itself, so a re-resolve does not have to guess. */
  member_ref: string;
  /** Declaration order in `references[]`, preserved for reproducibility. */
  position: number;
  /** `pending` until the member actually lands, then `landed` (arc#400 F3). */
  state: string;
}

/**
 * OPEN a composition install: write the header and the intended membership as
 * `pending`, BEFORE the first member lands (arc#400 review, F3).
 *
 * This is the whole point of the two-phase record. Members land one at a time
 * and the composition's own `skills` row commits last, so the window between
 * them is real: a kill, a power loss, or a member failing at runtime used to
 * leave the landed members looking like ordinary standalone packages and no
 * trace that a composition was ever attempted. `arc list` then lied by
 * omission, and arc#401's cascade had nothing to sweep. Now that window is a
 * `pending` record naming exactly which members landed and which did not.
 *
 * Replace-not-merge: a re-run after a failed attempt starts a fresh record,
 * because the composition IS the release's member list.
 */
export function beginComposition(
  db: Database,
  compositionName: string,
  version: string,
  members: readonly { name: string; version: string; source: string; ref: string }[],
): void {
  const now = new Date().toISOString();
  const insertMember = db.prepare(`
    INSERT INTO composition_members
      (composition_name, member_name, member_version, member_source, member_ref, position, state)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);
  const tx = db.transaction(() => {
    // Membership cascades off the header, but delete it explicitly so the order
    // is obvious rather than relying on the cascade firing mid-transaction.
    db.prepare("DELETE FROM composition_members WHERE composition_name = ?").run(compositionName);
    db.prepare("DELETE FROM compositions WHERE name = ?").run(compositionName);
    db.prepare(
      "INSERT INTO compositions (name, version, status, started_at, updated_at) VALUES (?, ?, 'pending', ?, ?)",
    ).run(compositionName, version, now, now);
    members.forEach((member, position) => {
      insertMember.run(
        compositionName,
        member.name,
        member.version,
        member.source,
        member.ref,
        position,
      );
    });
  });
  tx();
}

/**
 * What a member row's `state` means once the member has been dealt with.
 *
 * `landed` — this composition installed it. `preexisting` — it was ALREADY
 * installed, by something arc does not otherwise track, and this composition
 * merely referenced it (arc#401).
 */
export type CompositionMemberState = "pending" | "landed" | "preexisting";

/**
 * Mark one member as dealt with (arc#400 F3; the `preexisting` state is
 * arc#401's addition). No-op for an unknown member.
 *
 * ## Why `preexisting` is recorded, and recorded HERE
 *
 * `arc purge <factory>` cascades to the members the factory installed
 * (refcounted per arc#349). "The members the factory installed" is not the
 * same set as "the members the factory references": a package the operator had
 * installed by hand before the factory existed was not put there by this
 * decision, so undoing the decision must not take it away. That fact is only
 * knowable at install (`InstallResult.alreadyInstalled`), and is worthless
 * unless persisted — so it is persisted, on the row that already exists for it.
 *
 * The caller must NOT mark a member `preexisting` merely because it was already
 * installed: another COMPOSITION may have installed it, and that referent is
 * already tracked in `composition_members`. Marking it here too would make the
 * member immortal — retained by the pre-existing rule long after the other
 * composition went away, which is precisely the "falls with the last referent"
 * guarantee D3 asks for. install.ts resolves that with
 * {@link compositionsReferencing} before choosing the state.
 */
export function markCompositionMemberLanded(
  db: Database,
  compositionName: string,
  memberName: string,
  state: CompositionMemberState = "landed",
): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE composition_members SET state = ? WHERE composition_name = ? AND member_name = ?",
  ).run(state, compositionName, memberName);
  db.prepare("UPDATE compositions SET updated_at = ? WHERE name = ?").run(now, compositionName);
}

/**
 * The compositions that list `memberName` as a member — the refcount
 * denominator for arc#401's cascade, and the guard install.ts uses before
 * recording a member as `preexisting`.
 *
 * `exclude` drops one composition from the answer (the caller's own). Pending
 * compositions COUNT: an interrupted install is a referent whose members may
 * yet be resumed or explicitly purged, and arc#349's posture on a refcount it
 * cannot be sure about is to RETAIN. Ordered by name so the reason string a
 * caller renders is stable.
 */
export function compositionsReferencing(
  db: Database,
  memberName: string,
  opts: { exclude?: string } = {},
): string[] {
  const rows = db
    .prepare(
      "SELECT composition_name FROM composition_members WHERE member_name = ? ORDER BY composition_name",
    )
    .all(memberName) as { composition_name: string }[];
  return rows
    .map((r) => r.composition_name)
    .filter((name) => name !== opts.exclude);
}

/**
 * Delete a composition record outright — header, membership and inventory
 * (arc#401).
 *
 * `removeSkill` already does this as part of removing the composition's own
 * package. This is the path for the case that has no package to remove: an
 * INTERRUPTED install, whose `skills` row never committed, leaves a `pending`
 * header that nothing else can reach. Purging that debris is D6 serving the
 * interrupted case.
 */
export function removeComposition(db: Database, compositionName: string): void {
  db.prepare("DELETE FROM compositions WHERE name = ?").run(compositionName);
}

/**
 * One row of the install-time inventory snapshot (arc#401 D6).
 *
 * The SHAPE is owned by `lib/composition-inventory.ts` (which knows what an
 * owns class is and how to re-check one against disk); db.ts only persists it.
 * A type-only import, so the two modules cannot form a runtime cycle.
 */
export type CompositionInventoryRow = InventoryEntry;

/**
 * Record the composition's install-time inventory (arc#401 D6).
 *
 * Replace-not-merge, exactly like `beginComposition`: the snapshot describes
 * ONE release's footprint, so a re-install or an upgrade replaces it rather
 * than accumulating the union of every release that was ever installed — a
 * union whose diff would report long-deleted paths as leaks forever.
 */
export function recordCompositionInventory(
  db: Database,
  compositionName: string,
  entries: readonly CompositionInventoryRow[],
): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO composition_inventory
      (composition_name, member_name, kind, owns_class, entry, present)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM composition_inventory WHERE composition_name = ?").run(compositionName);
    for (const row of entries) {
      insert.run(
        compositionName,
        row.member,
        row.kind,
        row.ownsClass ?? "",
        row.entry,
        row.present ? 1 : 0,
      );
    }
  });
  tx();
}

/** The install-time inventory recorded for `compositionName` (arc#401 D6). */
export function compositionInventory(
  db: Database,
  compositionName: string,
): CompositionInventoryRow[] {
  const rows = db
    .prepare(
      "SELECT member_name, kind, owns_class, entry, present FROM composition_inventory WHERE composition_name = ? ORDER BY member_name, kind, entry",
    )
    .all(compositionName) as {
    member_name: string;
    kind: string;
    owns_class: string;
    entry: string;
    present: number;
  }[];
  return rows.map((r) => ({
    member: r.member_name,
    kind: r.kind,
    // The column is a plain TEXT; the writer only ever puts an OwnsClass or ''
    // in it, and the diff treats anything non-userData as purgeable, so a
    // hand-edited value degrades to "must be gone" rather than to a crash.
    ownsClass: r.owns_class === "" ? null : (r.owns_class as OwnsClass),
    entry: r.entry,
    present: r.present === 1,
  }));
}

/**
 * CLOSE a composition install: everything landed and the composition's own row
 * has committed (arc#400 review, F3).
 */
export function completeComposition(db: Database, compositionName: string): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE compositions SET status = 'complete', updated_at = ? WHERE name = ?").run(
    now,
    compositionName,
  );
}

/** The header row for `compositionName`, or null when there is none. */
export function compositionRecord(db: Database, compositionName: string): CompositionRow | null {
  return db
    .prepare("SELECT * FROM compositions WHERE name = ?")
    .get(compositionName) as CompositionRow | null;
}

/** The pinned members of `compositionName`, in declaration order. */
export function compositionMembers(db: Database, compositionName: string): CompositionMemberRow[] {
  return db
    .prepare(
      "SELECT * FROM composition_members WHERE composition_name = ? ORDER BY position",
    )
    .all(compositionName) as CompositionMemberRow[];
}

/**
 * Every recorded composition — header plus membership — keyed by name.
 *
 * Includes `pending` ones, which is the point: an interrupted install has no
 * `skills` row, so this is the ONLY place `arc list` can see it (F3).
 */
export function allCompositions(
  db: Database,
): Map<string, { record: CompositionRow; members: CompositionMemberRow[] }> {
  const headers = db.prepare("SELECT * FROM compositions ORDER BY name").all() as CompositionRow[];
  const rows = db
    .prepare("SELECT * FROM composition_members ORDER BY composition_name, position")
    .all() as CompositionMemberRow[];

  const byName = new Map<string, { record: CompositionRow; members: CompositionMemberRow[] }>();
  for (const header of headers) byName.set(header.name, { record: header, members: [] });
  for (const row of rows) {
    byName.get(row.composition_name)?.members.push(row);
  }
  return byName;
}

/**
 * Record an installed skill in the database.
 */
export function recordInstall(
  db: Database,
  skill: InstalledSkill,
  manifest: ArcManifest
): void {
  const now = new Date().toISOString();

  const insertSkill = db.prepare(`
    INSERT INTO skills (name, version, repo_url, install_path, skill_dir, status, artifact_type, tier, customization_path, install_source, library_name, installed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSkill.run(
    skill.name,
    skill.version,
    skill.repo_url,
    skill.install_path,
    skill.skill_dir,
    skill.status,
    skill.artifact_type,
    skill.tier,
    skill.customization_path,
    skill.install_source,
    skill.library_name,
    skill.installed_at || now,
    skill.updated_at || now
  );

  // Record capabilities
  insertCapabilities(db, skill.name, manifest);
}

/**
 * Recorded value for "this package may run any bash command".
 *
 * A sentinel rather than an absent row: absence is indistinguishable from "no
 * bash at all", which is precisely how an unrestricted grant became invisible
 * (arc#396 review, F7). Parenthesised so it cannot collide with a real command
 * string in `restricted_to`.
 */
export const BASH_UNRESTRICTED = "(unrestricted)";

/** One row of the `capabilities` table, before it is bound to a skill. */
export interface CapabilityRow {
  type: string;
  value: string;
  reason: string;
}

/**
 * The capability rows a manifest declares, in one place.
 *
 * Extracted (arc#396) because this walk existed verbatim in `recordInstall`
 * and again in `upgradePackage`, and the arc#396 re-pin needed a third copy —
 * plus a way to COMPARE a manifest's surface against what is already recorded,
 * which a walk that inserts as it goes cannot give you.
 */
export function capabilityRows(manifest: ArcManifest): CapabilityRow[] {
  const caps = manifest.capabilities;
  if (!caps) return [];

  const rows: CapabilityRow[] = [];
  if (caps.filesystem?.read) {
    for (const p of caps.filesystem.read) rows.push({ type: "fs_read", value: p, reason: "" });
  }
  if (caps.filesystem?.write) {
    for (const p of caps.filesystem.write) rows.push({ type: "fs_write", value: p, reason: "" });
  }
  if (caps.network) {
    for (const n of caps.network) rows.push({ type: "network", value: n.host, reason: n.reason });
  }
  if (caps.bash?.allowed) {
    // Bash is recorded as a capability whenever it is ALLOWED, not only when
    // it is restricted (arc#396 review, F7). Emitting rows per `restricted_to`
    // entry alone meant the widest possible grant — `bash: {allowed: true}`
    // with no restriction — recorded ZERO rows, so the recorded surface said
    // "no bash" for a package with unrestricted bash, and a
    // restricted→unrestricted change read as a NARROWING to any set-diff over
    // these rows. The sentinel value makes de-restriction a visible event.
    if (caps.bash.restricted_to?.length) {
      for (const b of caps.bash.restricted_to) rows.push({ type: "bash", value: b, reason: "" });
    } else {
      rows.push({ type: "bash", value: BASH_UNRESTRICTED, reason: "" });
    }
  }
  if (caps.secrets) {
    // Fold both author shapes (bare NAME / object form) to NAME + reason so a
    // manifest declaring the object form records the same rows as the shorthand
    // (arc#363) — the value column is always a string, never "[object Object]".
    for (const s of normalizeDeclaredSecrets(caps.secrets)) {
      rows.push({ type: "secret", value: s.name, reason: s.reason });
    }
  }
  return rows;
}

/** Insert a manifest's capability rows for `name` (no delete first). */
export function insertCapabilities(
  db: Database,
  name: string,
  manifest: ArcManifest
): void {
  const insertCap = db.prepare(`
    INSERT INTO capabilities (skill_name, type, value, reason)
    VALUES (?, ?, ?, ?)
  `);
  for (const row of capabilityRows(manifest)) {
    insertCap.run(name, row.type, row.value, row.reason);
  }
}

/**
 * Replace the recorded capability surface for `name` with the manifest's.
 *
 * The recorded surface is what `arc audit` / `arc info` show an operator, so
 * it has to describe the code that is actually checked out. Any command that
 * moves a package's code (upgrade, arc#396's re-pin) owes this call.
 */
export function replaceCapabilities(
  db: Database,
  name: string,
  manifest: ArcManifest
): void {
  db.prepare("DELETE FROM capabilities WHERE skill_name = ?").run(name);
  insertCapabilities(db, name, manifest);
}

/** The capability surface currently RECORDED for `name`. */
export function recordedCapabilityRows(db: Database, name: string): CapabilityRow[] {
  return db
    .prepare("SELECT type, value, reason FROM capabilities WHERE skill_name = ?")
    .all(name) as CapabilityRow[];
}

/**
 * Get all installed skills.
 */
export function listSkills(db: Database): InstalledSkill[] {
  return db
    .prepare("SELECT * FROM skills ORDER BY name")
    .all() as InstalledSkill[];
}

/**
 * Get a specific skill by name.
 */
export function getSkill(
  db: Database,
  name: string
): InstalledSkill | null {
  return db
    .prepare("SELECT * FROM skills WHERE name = ?")
    .get(name) as InstalledSkill | null;
}

/**
 * Update skill status (active/disabled).
 */
export function updateSkillStatus(
  db: Database,
  name: string,
  status: "active" | "disabled"
): void {
  db.prepare(
    "UPDATE skills SET status = ?, updated_at = ? WHERE name = ?"
  ).run(status, new Date().toISOString(), name);
}

/**
 * Remove a skill and its capabilities from the database.
 */
export function removeSkill(db: Database, name: string): void {
  db.prepare("DELETE FROM skills WHERE name = ?").run(name);
  // arc#400: a composition's header row is deliberately NOT FK'd to `skills`
  // (it must exist before that row does, so an interrupted install stays
  // visible — see the schema comment), so removing the package has to remove it
  // explicitly. Membership cascades off the header, so this is the whole
  // teardown. A no-op for every non-composition package.
  db.prepare("DELETE FROM compositions WHERE name = ?").run(name);
}

/**
 * Get all capabilities for a specific skill.
 */
export function getCapabilities(
  db: Database,
  skillName: string
): CapabilityRecord[] {
  return db
    .prepare("SELECT * FROM capabilities WHERE skill_name = ?")
    .all(skillName) as CapabilityRecord[];
}

/**
 * List all installed skills from a specific library.
 */
export function listByLibrary(db: Database, libraryName: string): InstalledSkill[] {
  return db
    .prepare("SELECT * FROM skills WHERE library_name = ? ORDER BY name")
    .all(libraryName) as InstalledSkill[];
}


/**
 * Rewrite every absolute repo path stored on `skills` rows whose value lives
 * under `oldPrefix`, re-rooting it at `newPrefix`. Covers `install_path`,
 * `skill_dir`, and `customization_path` — the three columns that hold absolute
 * paths into the cloned package repos (`reposDir`).
 *
 * This is the DB half of the #287 repos-relocation lockstep: after the repos
 * dir is copied to its new XDG data location the DB must point at the new tree
 * or every installed package is orphaned. Runs in a single transaction (all
 * rows swap or none do). Idempotent: a second run finds no `oldPrefix` rows and
 * changes nothing. Returns the number of rows rewritten.
 *
 * Prefix match is exact-segment: a value equal to `oldPrefix` or beginning with
 * `oldPrefix + sep` is rewritten; a merely string-prefixed sibling (e.g.
 * `…/repos-backup`) is left untouched.
 */
export function rewriteInstallPathPrefix(
  db: Database,
  oldPrefix: string,
  newPrefix: string,
): number {
  const swapNonNull = (value: string): string => {
    if (value === oldPrefix) return newPrefix;
    if (value.startsWith(oldPrefix + sep)) return newPrefix + value.slice(oldPrefix.length);
    return value;
  };
  const swapNullable = (value: string | null): string | null =>
    value == null ? value : swapNonNull(value);

  const rows = db
    .prepare("SELECT name, install_path, skill_dir, customization_path FROM skills")
    .all() as {
    name: string;
    install_path: string;
    skill_dir: string;
    customization_path: string | null;
  }[];

  const update = db.prepare(
    "UPDATE skills SET install_path = ?, skill_dir = ?, customization_path = ? WHERE name = ?",
  );

  let changed = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const installPath = swapNonNull(row.install_path);
      const skillDir = swapNonNull(row.skill_dir);
      const customizationPath = swapNullable(row.customization_path);
      if (
        installPath !== row.install_path ||
        skillDir !== row.skill_dir ||
        customizationPath !== row.customization_path
      ) {
        update.run(installPath, skillDir, customizationPath, row.name);
        changed++;
      }
    }
  });
  tx();
  return changed;
}

/**
 * Get all capabilities across all active skills (for audit).
 */
export function getAllActiveCapabilities(
  db: Database
): CapabilityRecord[] {
  return db
    .prepare(
      `SELECT c.* FROM capabilities c
       JOIN skills s ON c.skill_name = s.name
       WHERE s.status = 'active'
       ORDER BY c.type, c.skill_name`
    )
    .all() as CapabilityRecord[];
}
