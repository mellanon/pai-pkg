import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, sep } from "path";
import type {
  InstalledSkill,
  CapabilityRecord,
  ArcManifest,
} from "../types.js";
import { normalizeDeclaredSecrets } from "./secrets.js";

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

  return db;
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
  if (caps.bash?.restricted_to) {
    for (const b of caps.bash.restricted_to) rows.push({ type: "bash", value: b, reason: "" });
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
