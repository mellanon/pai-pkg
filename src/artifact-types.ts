/**
 * THE single source of arc's manifest `type` vocabulary (arc#399,
 * `docs/design-factory-type.md` D7.1).
 *
 * This module has ZERO imports ON PURPOSE. `src/types.ts` re-exports
 * `ArtifactInstallState` from `lib/install-transaction.js`, which imports
 * `lib/artifact-installer.js`, which imports the enum back — a cycle that is
 * invisible for erased type declarations but a temporal-dead-zone crash for a
 * runtime `const`. A leaf module cannot be caught in that cycle. Import
 * `ARTIFACT_TYPES` / `ArtifactType` from `../types.js` as usual; this file is
 * the definition, not the interface.
 */

/**
 * THE single source of arc's manifest `type` vocabulary (arc#399,
 * `docs/design-factory-type.md` D7.1).
 *
 * Before this array existed the same list was hand-copied into three places —
 * `ArcManifest["type"]`, the strict validator's `VALID_TYPES`, and the publish
 * validator's `VALID_TYPES` — and they had already drifted: the publish copy was
 * missing `system`, `process` and `governance`, so those three types installed
 * fine but could not be published (arc#397). Every one of those sites now
 * DERIVES from this array; adding a value here is the only edit needed.
 *
 * Ordering is meaning-free — parity is asserted as a set
 * (`test/unit/type-set-parity.test.ts`), never as a sequence.
 *
 * ## Composition types
 *
 * `library`, `bundle` and `factory` are COMPOSITION types: they package other
 * packages rather than an artifact payload of their own.
 *
 *   - `library` — one tarball, N artifacts inside it (arc's own long-standing
 *     form; `readManifest` intercepts it and walks `artifacts[]`).
 *   - `bundle`  — the registry's reference-composition (DD-111, registry DB
 *     migration `0012_add_bundle_type.sql`): the tarball carries only the
 *     manifest, whose `references[]` name published packages.
 *   - `factory` — a `bundle` specialization that adds `tools:` (host binaries
 *     checked at install) and `produces:` (the capability the composition
 *     exists to provide). See `docs/design-factory-type.md` D1.
 *
 * Reference RESOLUTION for `bundle`/`factory` is deliberately not implemented
 * here — this slice only teaches the type vocabulary about them (D7.1–D7.2).
 * Until the resolver lands they install as a manifest-only no-op: no per-type
 * symlinks are planned (see `planArtifactSymlinks`), and `provides.files` is
 * still honored by the type-agnostic pass.
 *
 * ## D7.4 — per-type registry mapping (WRITTEN here, DECIDED later)
 *
 * D7.4 requires that the mapping be written down, and the ratification
 * deliberately DEFERRED deciding it. arc's publish validator accepts every
 * value below (that is arc#397's fix — arc no longer refuses to publish a type
 * it can install); the registry is the authority on what it will actually
 * accept, and a rejection surfaces there rather than being pre-empted here.
 *
 * | arc type     | Known to registry?             | Publishable-to-registry vs arc-local |
 * |--------------|--------------------------------|--------------------------------------|
 * | `skill`      | yes                            | publishable                          |
 * | `tool`       | yes                            | publishable                          |
 * | `agent`      | yes                            | publishable                          |
 * | `prompt`     | yes                            | publishable                          |
 * | `rules`      | yes (registry maps → skill)    | publishable                          |
 * | `library`    | yes                            | publishable                          |
 * | `bundle`     | yes (DD-111, migration 0012)   | publishable                          |
 * | `factory`    | pending — meta-factory#571     | publishable once #571 lands          |
 * | `system`     | NO — arc-only                  | DEFERRED (D7.4)                      |
 * | `component`  | NO — arc-only                  | DEFERRED (D7.4)                      |
 * | `pipeline`   | NO — arc-only                  | DEFERRED (D7.4)                      |
 * | `process`    | NO — arc-only                  | DEFERRED (D7.4)                      |
 * | `action`     | NO — arc-only                  | DEFERRED (D7.4)                      |
 * | `governance` | NO — arc-only                  | DEFERRED (D7.4)                      |
 *
 * Registry-only values `playbook` and `graph` stay registry-only until an arc
 * consumer exists (D7.3) — they are folded to arc types by
 * `metafactory-api.ts`'s inbound type map, not added here.
 */
export const ARTIFACT_TYPES = [
  "skill",
  "system",
  "agent",
  "prompt",
  "tool",
  "component",
  "pipeline",
  "process",
  "rules",
  "library",
  "action",
  "governance",
  "bundle",
  "factory",
] as const;

/** The artifact classes arc installs. Derived from {@link ARTIFACT_TYPES}. */
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
