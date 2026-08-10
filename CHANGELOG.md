# Changelog

## Unreleased

## 0.45.0 — 2026-08-10

Determinism chain, wave 1 ([#388](https://github.com/the-metafactory/arc/issues/388)) — reproducible installs and pinnable commits.

### Fixed

- **`bun.lock` is tracked, so the `--frozen-lockfile` CI gates are real** ([#386](https://github.com/the-metafactory/arc/issues/386)). arc had a lockfile; it was in `.gitignore`. A frozen install with nothing tracked to freeze against exits 0 and writes nothing, so all four `bun install --frozen-lockfile` call sites in CI ran and **could not fail** — 28 of 99 packages floated, and `self-update` ran a bare `bun install`, leaving arc's own updates unpinned. arc was the only ecosystem repo that gitignored its lockfile. The lockfile is now committed (a **pin, not an upgrade** — it captures what CI was already silently resolving; no dependency version moved), and CI additionally asserts the lockfile is *tracked* before the frozen install runs, so the precondition that makes the other gates meaningful cannot silently regress.
- **`--pin` accepts any git ref — SHA, branch, or tag** ([#387](https://github.com/the-metafactory/arc/issues/387)). `arc install --pin` rejected anything non-semver at three separate layers, so pinning a commit for dev testing was impossible and downstream repos were minting throwaway `-rcN` tags on public repos to work around it (see signal#174). `--pin` now takes a full SHA, a short SHA, a branch name, or a tag; a bare `1.0.0` still resolves `v1.0.0` first, unchanged.
- **A `--pin` value that names a path no longer silently installs the default branch** ([#387](https://github.com/the-metafactory/arc/issues/387)). `git checkout <arg>` exits 0 **without checking anything out** when `<arg>` is not a ref but *is* a path in the working tree — it reinterprets the argument as a pathspec restore. `checkoutPinnedRef` read that exit 0 as "ref checked out". The semver regex had made collisions unlikely; widening `--pin` made every string a candidate, including `arc-manifest.yaml`, which every arc package ships at its repo root — so `--pin arc-manifest.yaml` reported a plausible pinned commit, printed a success tick, and left HEAD on the default branch. Fixed by passing `git checkout <ref> --`, which forces revision interpretation while leaving checkout's own branch DWIM intact (a `rev-parse --verify` pre-check was tried first and rejected: it does not perform checkout's remote-tracking resolution and broke branch pinning). Guarded by two regression tests — pinning a real file and a real directory must both fail.

## 0.44.3 — 2026-07-26

### Fixed

- **`arc remove`'s kept-summary only names paths that exist on disk** (cortex#2441 Note 2, [#379](https://github.com/the-metafactory/arc/pull/379)).

## 0.44.2 — 2026-07-26

### Fixed

- **`arc remove` suggests `--purge`, and a failed postinstall rolls the clone back** ([#373](https://github.com/the-metafactory/arc/issues/373), [#376](https://github.com/the-metafactory/arc/pull/376)).

## 0.44.1 — 2026-07-26

### Added

- **First-class `governance` artifact type** ([#361](https://github.com/the-metafactory/arc/issues/361), [#362](https://github.com/the-metafactory/arc/pull/362)) — fixes the compass-core install throw.

### Fixed

- **Object-form `capabilities.secrets` accepted; `validate` and `install` aligned** ([#363](https://github.com/the-metafactory/arc/issues/363), [#364](https://github.com/the-metafactory/arc/pull/364)).
- **`namespace` is the bare scope, not `@scope`** ([#369](https://github.com/the-metafactory/arc/issues/369), [#370](https://github.com/the-metafactory/arc/pull/370)).
- **Clearer secrets questionnaire** — banner, deduped GitHub prompt, explained warning ([#358](https://github.com/the-metafactory/arc/issues/358), [#375](https://github.com/the-metafactory/arc/pull/375)).
- **The purge hook snapshots its scripts dir so it can source lib siblings** ([#372](https://github.com/the-metafactory/arc/issues/372), [#374](https://github.com/the-metafactory/arc/pull/374)).

## 0.44.0 — 2026-07-23

### Added

- **`arc purge`, `owns` declarations, and `arc files` listing** ([#359](https://github.com/the-metafactory/arc/issues/359), [#360](https://github.com/the-metafactory/arc/pull/360)).
- **`arc remove` cascades to exclusively-owned `depends_on.packages`** (refcounted, [#349](https://github.com/the-metafactory/arc/pull/349)).

### Fixed

- **Already-installed is now the success case — install is idempotent** ([#354](https://github.com/the-metafactory/arc/issues/354)). `arc install <pkg>` aborted mid-way when a declared `depends_on.packages` entry was already installed ("Failed to install dependency 'agent-state': Skill 'AgentState' is already installed (status: active)") — the clone landed but skill projection never ran, leaving a half-installed state. Three changes: (1) the dependency loop resolves the installed row by declared name **or repo URL** (the declared dep name is the author's label and can differ from the installed manifest name — `agent-state` vs `AgentState`), treats an active row with its host drop present as **satisfied**, and when the arc#248 re-install path fires, removes the stale row by its *recorded* name; (2) `install()`'s duplicate guards return a **no-op success** (`alreadyInstalled: true`) for an active row (same repo URL, or same name at the same version) instead of an error — so re-running `arc install X` is harmless; a **disabled** row or a same-name **version mismatch** still errors with the arc#158 actionable hints (`arc enable` / `arc upgrade` / `arc remove`); (3) `depends_on.packages` entries may now declare an optional `version` range, checked when the dependency is already installed — out-of-range surfaces a WARN naming both versions and proceeds (the arc#284 warn-don't-fail posture; arc never silently upgrades an installed package as a side effect of installing its dependent).
- **arc's own manifest migrated off the deprecated `{domain, reason}` network shape** ([#335](https://github.com/the-metafactory/arc/issues/335)): `arc-manifest.yaml` capabilities.network entries renamed `domain:` → `host:` (canonical shape).

> No `0.43.x` was ever released — the line goes `0.42.1` → `0.44.0`.

## 0.42.1 — 2026-07-18

### Added

- **`arc upgrade` cascades to installed `depends_on.packages`** — adapters and surfaces upgrade with cortex ([#347](https://github.com/the-metafactory/arc/pull/347)).

### Changed

- **`self-upgrade` is the canonical command**; `self-update` kept as an alias ([#345](https://github.com/the-metafactory/arc/pull/345)).

## 0.42.0 — 2026-07-17

### Changed

- **Registry vocabulary de-conflated + `arc bundle` → `arc pack`** ([#324](https://github.com/the-metafactory/arc/issues/324), [#63](https://github.com/the-metafactory/arc/issues/63); skill-estate migration epic [#315](https://github.com/the-metafactory/arc/issues/315)). REGISTRY.yaml entries stored the registry's **source-trust** in a field named `type:` that reused the manifest **`tier`** words — one word set meaning two things. The field is now **`trust:`** (`RegistryEntry.trust`, type `RegistryTrust`); the generator emits it, `metafactory-api` produces it, and a one-time migration folds any legacy `type:` into `trust:` on regeneration. Documented in the new [`docs/registry-schema.md`](docs/registry-schema.md), which fixes the two-axis model: **artifact class** = the entry's section (mirrors manifest `type`), **source trust** = `trust:`, and **`bundle`** now means exactly one thing — a multi-artifact repo (the `bundle: true` flag), never a packaging verb.
- To keep `bundle` on that single meaning, the packaging command **`arc bundle` is renamed to `arc pack`** (npm-familiar). `arc bundle` remains as a hidden, deprecated alias for one release — it warns and delegates to `arc pack`. Internal function/file names (`bundle()`, `createBundle`, `lib/bundle.ts`) are unchanged as an implementation detail; the manifest `bundle.exclude`/`bundle.include` fields are unchanged. Decision recorded on #63.

## 0.41.0 — 2026-07-17

### Removed

- **Retired `catalog.yaml` and the `arc catalog` command surface** ([#323](https://github.com/the-metafactory/arc/issues/323), skill-estate migration epic [#315](https://github.com/the-metafactory/arc/issues/315)). `catalog.yaml` (entries typed `builtin`, pointing at raw PAI-era GitHub URLs) predated `REGISTRY.yaml`; discovery now has one path (sources + registry). Deleted the data file, `src/lib/catalog.ts`, `src/commands/catalog.ts`, the `arc catalog *` commands (list/search/add/remove/use/sync/push/push-catalog), the `registry.ts` → catalog bridge (`addFromRegistry`, used only by those commands), and `ArcPaths.catalogPath`. The `CatalogEntry`/`CatalogEntryType`/`CatalogConfig` types were removed; `RegistryEntry` now stands alone (its `type` is `RegistryEntryType`). `arc search` / `arc install` / `arc source` are unaffected — they never read `catalog.yaml`. Full suite green.

## 0.40.3 — 2026-07-17

### Changed

- **PackageBuilder now ships via a dependency edge, not in-tree** ([#319](https://github.com/the-metafactory/arc/issues/319), WS3 of the skill-estate migration epic [#315](https://github.com/the-metafactory/arc/issues/315); ADR-0024 D2). The canonical PackageBuilder skill (the 985-line `SKILL.md` + four workflows) moved to its own repo, `the-metafactory/metafactory-skill-package-builder`, and arc consumes it as a dependency — the same auto-install pattern cortex uses for its surface-plugin bundles ([cortex#2028](https://github.com/the-metafactory/cortex/issues/2028)). arc's `arc-manifest.yaml` now declares it under `depends_on.packages` (`{name, repo}`), which arc's installer clones + installs on `arc install arc` / `arc upgrade arc`; the `provides.skill` PackageBuilder entries and the in-tree `skill/` directory are removed in this same release, with no fallback copy (no component keeps two sources of truth). No user-facing capability change — PackageBuilder is still installed after an upgrade, now from its own repo.

## 0.40.0 — 2026-07-14

### Added

- **Existence-gated cortex-host config resolver + `{cortex-config}` provides token** (XDG epic cortex#1867, G-18). arc's cortex host no longer hardcodes the legacy `~/.config/cortex` config root — it now resolves cortex's config dir the SAME way cortex does (new `src/lib/hosts/cortex-config-dir.ts`, byte-mirroring cortex's `resolveConfigDir`: `CORTEX_CONFIG_DIR` verbatim > canonical `~/.config/metafactory/cortex` if present > legacy `~/.config/cortex` > `~/.config/grove` > canonical default). So arc always provisions into whichever tree the live cortex reads — a pre-cutover box gets legacy, a migrated box gets canonical — instead of silently writing to a tree the migrated cortex ignores. `ARC_CONFIG_ROOT` / explicit `configRoot` / `--config-dir` overrides keep precedence above the default; `--stack <name>` now resolves its base through the gated resolver too. New **`{cortex-config}`** provides token resolves to the live cortex config dir (distinct from arc's own `{config}` → `metafactory/arc`), so a package's `provides.files` can drop into cortex's config tree by intent (e.g. `{cortex-config}/agents.d/<id>.yaml`) instead of hardcoding a path that breaks after the config move. Pure resolution — arc does not move or migrate cortex's config (cortex owns that).

## 0.39.0 — 2026-07-14

### Added

- **XDG Base Directory adoption — phase 2: arc adopts XDG for its own dirs + `{config}`/`{bin}` provides tokens** (epic cortex#1867, [#287](https://github.com/the-metafactory/arc/issues/287)). arc's own storage now routes through the `xdg-paths` resolver: pkg repos + `packages.db` → `dataDir("arc")` (`$XDG_DATA_HOME`), pkg cache → `cacheDir("arc")` (`$XDG_CACHE_HOME`), config/`sources.yaml`/`config.yaml` → `configDir("arc")` honoring `$XDG_CONFIG_HOME` (precedence `ARC_CONFIG_ROOT` > `$XDG_CONFIG_HOME` > spec fallback). Existing installs **migrate on first touch** — copy-keep-source (legacy tree never deleted), completion-marker gated, atomic temp-then-rename per class, and a three-part relink lockstep (move repos → rewrite `packages.db` path rows → re-create every `~/.claude/{skills,agents,commands,bin}` symlink) so installed packages keep resolving. A failed/partial migration leaves the legacy tree fully working. New `provides.files` tokens `{bin}`/`{config}`/`{data}`/`{state}`/`{cache}` let manifests declare intent instead of hardcoding paths (`{bin}` → `~/.local/bin`, generalizes cortex#1866).

## 0.38.0 — 2026-07-13

### Added

- **XDG Base Directory adoption — phase 1: resolver, seams, bin cutover** (epic cortex#1867). Shared vendorable `xdg-paths` resolver ([#288](https://github.com/the-metafactory/arc/pull/288)); injectable `{home,env}` seam + `data`/`state`/`cache` class roots on `ArcPaths` ([#292](https://github.com/the-metafactory/arc/pull/294)); host-adapter `binDir` now defaults to `~/.local/bin` (Linux PATH), and the symlink installer backs an occupying regular file aside to a timestamped `.pre-arc` sidecar instead of throwing `SymlinkConflictError` ([#293](https://github.com/the-metafactory/arc/pull/295)). Additive — no directory moves yet; existing installs unaffected.
- **Opt-in agent instance state via the manifest `state` field** ([#281](https://github.com/the-metafactory/arc/issues/281)). A `type: agent` package now declares `state: { blueprint, version }` to opt into an instance-state scaffold at install; both subfields are validated (non-empty strings) at manifest load. The field is typed on the agent manifest (`AgentState` in `src/types.ts`).
- **`arc nats add-federated-user <name> --account <A>` — scoped hub-transport user mint** (cortex#1598). Ensures ONE `federated`-role scoped signing key per account (subject-templated `federated.{{name()}}.>` sub scope + `federated.>` pub, hardwired — no permission flags), mints the user signed by it with no own permissions, exports 0600 creds. Probe-first idempotent on both halves; refuses to export a user signed by any other key (`USER_NOT_SCOPED`). New schema `arc.nats.federated-user.v1`; new error codes `SIGNING_KEY_FAILED`, `USER_NOT_SCOPED`. Documented in `docs/integrations/cortex-creds.md`.

### Changed

- **Instance-state scaffold is now stateless-by-default** ([#281](https://github.com/the-metafactory/arc/issues/281)). Previously every `type: agent` install scaffolded `~/.config/cortex/agents/<id>/` + `state.sqlite`; now the scaffold runs **only** when the manifest declares `state`. Identity (NKey seed + DID) is still provisioned unconditionally for every agent. Aligns arc with cortex#1720/#1721 and `forge/design/agent-platform.md` §state. The provisioning record moved from `state.sqlite` metadata (which stateless agents lack) to an arc-owned sidecar at `~/.config/metafactory/agents/<id>.provision.json`, written for all agents; stateful agents retain the `state.sqlite` metadata copy too. New `MF_SIDECAR_DIR` env override redirects the sidecar base for hosts/tests.

  **Migration reality (read before rolling this out):**
  - **Existing installed agents are untouched.** `arc upgrade` does **not** re-run identity/state provisioning, so an already-installed agent keeps its current directory and gains a sidecar only on an explicit **re-install** (`arc install`). On such a re-install, if a pre-#281 instance dir is already on disk for a manifest that does *not* yet declare `state`, the sidecar reflects that reality honestly (`state_scaffolded: true` + `instance_dir` + `legacy_instance_state: true`) rather than claiming the agent is stateless.
  - **Fresh installs of bundles that don't yet declare `state` become stateless.** Bundles whose manifests predate this change (e.g. `luna`, the `dev-loop` members) will install **without** an instance dir until their manifests add the `state` field. That manifest sweep is a **merge-ordering prerequisite** for those bundles — land the per-bundle `state` declarations before (or together with) rolling this out, or those agents ship stateless.

### Fixed

- **`extractJwt` no longer captures a stray dash from real nsc creds output.** The decorated creds format uses six-dash END markers (`------END NATS USER JWT------`); the previous five-dash pattern lazily matched inside the marker and appended a `-` to the returned JWT (affects the `jwt` field of `add-bot`/`reissue-bot` JSON envelopes on real nsc output).

## 0.30.5

### Added

- **`type: process` is now a valid manifest type** ([#230](https://github.com/the-metafactory/arc/pull/230)). The arc manifest schema accepts process packages alongside the existing package types.
- **Library installs now respect artifact dependency ordering with atomic rollback** ([#231](https://github.com/the-metafactory/arc/pull/231)). Multi-artifact installs topologically order artifacts and roll back partial work when a later artifact fails.

### Fixed

- **Windows local repository paths no longer false-reject during install** ([#222](https://github.com/the-metafactory/arc/pull/222)). `extractRepoName` now treats Windows absolute paths as local paths and derives names with the active path flavor instead of POSIX-only `/` splitting.
- **Windows CLI shims are generated as `.cmd` launchers** ([#224](https://github.com/the-metafactory/arc/pull/224)). Installed tools are runnable through Windows `PATHEXT`, non-bun shim commands resolve relative to the bin directory, and removal cleans up both current `.cmd` shims and legacy extensionless shims.
- **PATH membership checks use platform-specific rules** ([#226](https://github.com/the-metafactory/arc/pull/226)). Windows shim-dir detection now splits on `;`, handles drive letters correctly, and compares path entries case-insensitively while preserving POSIX byte-sensitive behavior.

## 0.30.3

### Fixed

- **`arc install` of Sigstore-signed packages no longer fails on Windows** (closes [#216](https://github.com/the-metafactory/arc/issues/216), [#217](https://github.com/the-metafactory/arc/pull/217)). Two bugs in the cosign verification path:
  - `detectPlatform` excluded `win32` and built the binary name as `cosign-<process.platform>-<arch>` with no `win32`→`windows` mapping and no `.exe` suffix, so it never matched the real sigstore/cosign release asset (`cosign-windows-amd64.exe` / `cosign-windows-arm64.exe`). It now maps `win32`→`windows`, appends `.exe`, and accepts Windows as a supported target. `SUPPORTED_PLATFORMS` is derived from the os-name map's keys so the two can never drift.
  - A genuinely unsupported platform turned a verification *capability* gap into a hard install *failure* — `detectPlatform`'s throw propagated uncaught through `verifyPackageSigstore` and aborted the whole install. The verifier path now degrades to `verified: null` (warn-and-proceed, the same contract as unsigned and the soma#303 missing-identity case) while `--strict-signing` still escalates to a refusal. A genuine cosign rejection still returns `verified: false`.

## 0.30.0

### Fixed

- **Registry-extracted packages are upgradable again** (closes [#187](https://github.com/the-metafactory/arc/issues/187), [#188](https://github.com/the-metafactory/arc/pull/188)). Packages installed via `@scope/name` (e.g. `@metafactory/soma`) could not be upgraded three ways:
  - `arc upgrade <pkg> --check` falsely reported "up to date" — it resolved the advertised version through the YAML registry index (`findInAllSources`), but registry packages are published to the metafactory HTTP API. `checkUpgrades` now resolves those via `resolveFromRegistry`; git / YAML-registry packages keep the old path.
  - `arc upgrade <pkg> --force` errored `git pull failed: not a git repository` — a registry tarball has no `.git`. `upgradePackage` now detects registry packages and upgrades them by clean re-download + atomic swap. The new `fetchAndVerifyRegistryPackage` helper verifies with install parity (SHA-256 + Ed25519 registry signature + Sigstore).
  - The documented `remove`+`install` fallback could strand the user (remove succeeds, reinstall fails on a stale token). The registry upgrade now downloads and verifies **before** touching the working install and restores it on any failure, so an upgrade can never leave the user with no install.

- **CI green on Linux + eslint gate** ([#189](https://github.com/the-metafactory/arc/pull/189)). `createBundle` wrote the tarball into the package dir while archiving `.`, tripping GNU tar's "file changed as we read it" (exit 1) on Linux CI (bsdtar/macOS tolerated it); the archive is now staged in a temp dir outside the source tree and moved into place. Plus 8 mechanical eslint-gate fixes (unnecessary assertions/conditions, `Array<T>`→`T[]`, regex→`String#startsWith`).

## 0.27.1

### Fixed

- **`arc login` help text and install-time error are now actionable** (closes [#156](https://github.com/the-metafactory/arc/issues/156)).
  - `arc login` description previously claimed "required for publishing only"; install also needs authentication. Updated to "required for installs and publishing".
  - `arc logout` description likewise expanded to acknowledge that signed-in installs are affected.
  - 401/403 from a metafactory storage endpoint now hints at the next step: if no bearer was sent, `Run \`arc login\` first`; if a bearer was sent and rejected, `Token rejected — run \`arc login --force\` to refresh.` HTTP status code included for diagnosis.

## 0.24.0

### Changed

- **Multi-backend host adapter foundation (closes [#117](https://github.com/the-metafactory/arc/issues/117)).** 12-PR series ([#118–#129](https://github.com/the-metafactory/arc/pull/129)) splits the monolithic `PaiPaths` into two concerns: `ArcPaths` for arc's own host-independent state (config, db, repos, catalog) and `HostAdapter` + `HostPaths` for per-backend install dirs (Claude Code, Cortex). Phase 1 added the types and the Claude-Code adapter; Phase 2 introduced `hostPathFor()`/`requireHostDir()` dispatch and the Cortex adapter; Phase 3b migrated every production command (`verify`, `upgrade`, `install`, `remove`, `enable`, `disable`, `catalog`) command-by-command; this release (Phase 3d) deletes the deprecated `PaiPaths` type, `createPaths()` factory, and `TestEnv.paths` back-compat field, plus migrates the 5 remaining non-command callers (`info`, `login`, `logout`, `publish`, `review`, `bundle`).

### Removed

- **Breaking (TS only):** `PaiPaths` type, `createPaths()` factory, `TestEnv.paths` field. Replace with `ArcPaths` + `HostAdapter`. See `src/types.ts` and `test/helpers/test-env.ts` for the new shape.

### Notes

- Runtime behavior unchanged. Multi-host dispatch is wired but Claude Code remains the only default; future host adapters (Codex, Cursor) plug in via the `HostAdapter` interface without further surgery to commands.
- `ensureDirectories()` signature changed from `(paths: PaiPaths)` to `(arc: ArcPaths, host: HostAdapter)`.

## 0.22.0

### Added

- `PackageBuilder` § 12: **Persona-Driven Agents (Authoring Convention)**. Codifies the four-layer split (persona / skill bundle / built bundle / instance state), bundle-and-persona decoupling, blueprint contents, composition rules, authority-via-host-primitives, two-phase gates for irreversible operations, conformance checklist, and instance-vs-bundle separation. Aligns with the metafactory agent-platform design at [`forge/design/agent-platform.md`](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md). Closes [arc#100](https://github.com/the-metafactory/arc/issues/100), pairs with [grove#230](https://github.com/the-metafactory/grove/issues/230), part of [mf#390](https://github.com/the-metafactory/meta-factory/issues/390) Phase 4.
- New workflow `skill/Workflows/PublishBundle.md`: walks `arc bundle` -> `arc publish --dry-run` -> operator confirm -> `arc publish` -> `arc verify` round-trip. Two-phase gate at the dry-run step (halt for confirmation). Sha256 verification at the end; halt on mismatch.
- New workflow `skill/Workflows/AuthorPersonaAgent.md`: six-step walk (decide new vs reusable, scaffold new bundles, write workflow MDs, write persona, write manifest, wire host, verify conformance) for composing a persona-driven agent on top of one or more existing skill bundles.
- `triggers:` extended in `skill/SKILL.md` frontmatter with `author persona agent`, `persona-driven agent`, `compose blueprints`, `publish bundle`.

### Notes

- Docs-only release: no test suite covers SKILL.md or workflow markdown content. Existing `bun test` suite continues to pass; no behavior change in arc CLI.
- Out of scope (post-MVP): manifest signing (SkillSeal), `arc install --type agent` runtime flow. Tracked separately under [the-metafactory/meta-factory#389](https://github.com/the-metafactory/meta-factory/issues/389).

## 0.21.0

### Added
- `arc review` command family for sponsor / steward submission triage while the metafactory reviewer UI ([the-metafactory/meta-factory#114](https://github.com/the-metafactory/meta-factory/issues/114)) is still spec-only:
  - `arc review list` — pending submissions assigned to you (paginated, `--per-page` capped at 100 client-side, `--json` for scripting)
  - `arc review show <id>` — full submission detail; pretty-prints nested `validation_result` JSON
  - `arc review approve <id>` — advance submission to `approved` (first approval promotes package `draft` → `active`)
  - `arc review reject <id> -r <reason>` — reject with reason shown to publisher
  - `arc review request-changes <id> -m <message>` — request changes with comment to publisher
- All action commands accept `--json` for machine output.
- Reuses existing `arc login` bearer-token auth; `-s, --source <name>` selects a metafactory source. Server enforces tier-gating (`trusted+`), sponsor-only queue scoping, and DD-9 self-review prevention.

## 0.19.3

### Fixed
- `arc publish` rendered server errors as `[object Object]` when the registry returned a non-string `error` field (e.g. `{"error":{"message":"Internal server error"}}`). Added `formatServerError()` helper in `src/lib/publish.ts` that extracts `message`/`error` string fields or falls back to JSON — applied to uploadBundle, ensurePackageExists, and registerVersion error paths.

### Added
- `arc-manifest.yaml` at arc repo root (schema: arc/v1, type: tool), with `bundle.exclude` for `vendor/` (128MB cosign binary, fetched at build time via `scripts/fetch-cosign.ts`).

## 0.5.0

### Added
- **Lifecycle hooks**: `preinstall`, `preupgrade`, and `postupgrade` scripts in `arc-manifest.yaml`
  - `preinstall` runs before symlinks are created during first install
  - `preupgrade` runs before symlinks are updated during upgrade
  - `postupgrade` runs after symlinks + bun install during upgrade (falls back to `postinstall` if not declared)
  - Scripts receive `PAI_INSTALL_PATH` and `PAI_HOOK` env vars
  - Upgrade hooks also receive `PAI_OLD_VERSION` and `PAI_NEW_VERSION`
- Shared script runner (`src/lib/scripts.ts`) for consistent hook execution
- 10 new tests covering all lifecycle hook paths

### Fixed
- `upgrade.ts` crash when upgrading components without `capabilities` field (undefined guard)

## 0.4.0

### Added
- `scripts.postinstall` support in `arc-manifest.yaml`
- Component artifact type (`type: component`) for file-to-target symlink packages
- Optional `capabilities` field for components

## 0.3.0

### Added
- `arc self-update` command
- `arc upgrade --check` shows self-update availability
- Remote registry sources (apt-get style)

## 0.2.0

### Added
- Agent, prompt, and tool artifact types
- CLI shim generation for tools
- Path traversal guards
- Case-insensitive install lookup
- Comprehensive audit command

## 0.1.0

### Added
- Initial release: install, list, info, disable, enable, remove, verify
- Capability-based security model
- SQLite package database
