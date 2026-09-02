# Design: the `factory` composition type

**Status:** RATIFIED 2026-09-02 (D1–D8; the four open judgement calls
decided by Andreas — see PR discussion).
**Date:** 2026-09-02. Every `file:line` claim below was verified against the
named checkout on this date.
**Anchor:** #365 (Factory: first-class support for installable factory
compositions). This document answers its six design questions and adds the
two sections the 2026-09-02 findings comment demanded: taxonomy
reconciliation and the first factory's member list.
**Refs:** meta-factory `src/types/manifest.ts` +
`design/blueprint-lifecycle/seam-contracts.md` (registry side), arc
`src/types.ts` / `src/lib/validate-manifest.ts` / `src/lib/bundle.ts` /
`src/commands/install.ts` / `src/commands/purge.ts` / `src/commands/audit.ts`.

> **One line.** A factory is a package whose manifest declares other
> packages: `type: factory` reuses the registry's already-specified
> reference-composition semantics (DD-111 `bundle`), adds tool checks and a
> `produces:` capability declaration, and gets whole-composition install,
> audit, and purge — so `arc install <factory>` is one command, one combined
> capability review, and one reversible decision.

## Evidence base (verified 2026-09-02)

| # | Fact | Where |
|---|------|-------|
| E1 | Registry has TWO composition types spec'd: `library` (one tarball, N artifacts) and `bundle` (reference-manifest; install walks `references[]`) | meta-factory `src/types/manifest.ts:14-38` (grounding comment), `:40-56` (union + `VALID_PACKAGE_TYPES`) |
| E2 | `bundle` is in the registry DB schema | seam-contracts §refs: `migrations/0012_add_bundle_type.sql` ("bundle as 10th packages.type CHECK value") |
| E3 | arc has **no** `bundle`/`references[]` install handling | grep of `src/commands/install.ts` + `src/lib/manifest.ts`: zero hits |
| E4 | arc auto-installs declared package dependencies today | `src/commands/install.ts:250` `installPackageDependencies` walks `depends_on.packages` entries with `repo:` |
| E5 | arc's three type enums have drifted from each other AND from the registry | `src/types.ts:6` `ArtifactType` (12 values) = `src/lib/validate-manifest.ts:63` `VALID_TYPES` (12), but `src/lib/bundle.ts:101` publish `VALID_TYPES` has only 9 (missing `system`, `process`, `governance`); registry has 10 (`playbook`, `graph`, `bundle` unknown to arc; `system`, `component`, `pipeline`, `action`, `governance` unknown to registry) |
| E6 | arc doctrine says "bundle" is a REPO-NAME class, not a manifest type | `src/lib/validate-manifest.ts:53-62` comment: bundle-class repos (`metafactory-bundle-<name>`) declare `type: skill`/`tool` |
| E7 | Cascade removal precedent exists, refcounted | #349 (MERGED): "cascade removal to exclusively-owned depends_on.packages (refcounted)" |
| E8 | Purge refuses user data by name | `src/commands/purge.ts:448` "kept (user data): … — yours, arc will not touch it"; `:440` refused-escape guard |
| E9 | Cross-tier audit warnings exist between skills | `src/commands/audit.ts:18` ("Warnings only between skills of different tiers/authors"), `:57` |
| E10 | A type outside every enum is installed in the wild | `@the-metafactory/compass-metafactory` carries `type: governance-overlay` — legal in none of E5's enums; cf. #361 (governance type gap, CLOSED) |

## D1 — `factory` is a first-class manifest type, specializing `bundle` (Q1)

**Decision.** `factory` joins the type taxonomy as a third *composition*
type. Its grounding, in the registry's own idiom (E1): **the tarball
contains no constituent code — only the manifest, whose `references[]`
point at published packages — plus factory-specific declarations: `tools:`
(host binaries checked at install) and `produces:` (the capability the
composition exists to provide).**

**Against the alternatives** from #365 Q1:

- *A blueprint kind / curated install sequence* puts the composition
  outside the manifest schema — invisible to validation, to `arc list`,
  to the registry's type axis, and to audit. Everything in D2–D6 keys off
  the manifest; a sequence has no manifest to key off.
- *Reusing `bundle` unmodified* loses the factory-specific fields and the
  semantics D2/D6 attach — and would inherit the E6 naming collision
  (below) undisambiguated.

**The E6 collision, resolved.** arc's comment doctrine ("bundle is a
repo-name class") and the registry's `bundle` manifest type (E1/E2) use the
same word for different things. Both survive: the repo-name class
`metafactory-bundle-<name>` remains a *naming* convention whose members
declare ordinary installable types; the *manifest type* `bundle` (DD-111)
is the reference-composition. Implementation must reword the
`validate-manifest.ts:53-62` comment to name the distinction, and the docs
gain one table stating it. `factory` sidesteps the ambiguity by not
reusing the word.

## D2 — one command, one combined capability review (Q2)

**Decision.** `arc install <factory>` resolves `references[]` (each entry:
registry name + pinned version, D4), computes the **combined capability
surface before installing anything**, presents ONE confirmation, then
installs members via the existing dependency machinery (E4) extended to
reference-resolution.

Aggregation rule, per capability category of the manifest schema:

- `filesystem.read` / `filesystem.write`: union of member paths, deduped,
  displayed grouped by member (the operator sees *who* wants *what*).
- `network`: union, deduped.
- `bash`: `allowed` is OR; `restricted_to` is the union of member lists;
  any member with unrestricted bash marks the whole surface unrestricted —
  and is flagged in the confirmation.
- `secrets`: union, each attributed to its member.

Honesty rule: the combined review REPLACES per-member prompts (or the "one
command" promise dies by a thousand confirmations), so it must display the
full union — nothing summarized away. A member manifest that fails
validation aborts the whole install before any member lands.

## D3 — lifecycle cascades across the composition (Q3)

**Decision.**
- `arc upgrade <factory>` upgrades to the factory's new release and moves
  members to THAT release's pins (D4) — never to floating latest.
- `arc files <factory>` lists the union of member footprints plus the
  factory's own manifest install.
- `arc purge <factory>` cascades per D6.
- Member shared with another install (another factory, or standalone):
  refcounted exactly as #349 (E7) — removed only when the last referent
  goes.

## D4 — a factory release pins member versions (Q4)

**Decision.** `references[]` entries carry **exact versions** — a factory
release is a reproducible snapshot. Ranges are refused at publish time
(publish-side validation, E5's `bundle.ts` enum site). Rationale: the
factory's value is "this composition, known to work together"; a floating
member reintroduces the integration project the type exists to delete.
Registry relationship: publishing a factory version freezes its member
list+versions in the registry entry, so `arc install <factory>@1.2.0`
resolves identically forever (modulo revocations, which propagate per
DD-108).

## D5 — a factory's tier is the MIN of its members' (Q5)

**Decision.** Trust never averages up. A factory containing one
`community` member is `community` at best, whatever its own tier claims —
computed at publish AND re-checked at install (a member's tier can change
via revocation). `arc audit` extends E9's cross-tier warnings to
compositions: the factory's declared tier vs computed MIN, and member-pair
warnings as today.

## D6 — untangle symmetry: install is a reversible decision (Q6)

**Decision** (non-negotiable per #365).
- At install, arc records an `arc files`-style inventory snapshot of the
  composition.
- `arc purge <factory>` removes every member (refcounted, E7), every
  symlink, every declared config/state — user data refused by name exactly
  as today (E8).
- Verification is mechanical: post-purge `arc files` diff against the
  install-time inventory must be empty except user-data refusals —
  test-rig assertable, and the acceptance test for the MVP (#365's
  acceptance sketch).

## D7 — taxonomy reconciliation (the E5 drift)

**Decision.**
1. arc's single source of type truth becomes `src/types.ts` `ArtifactType`;
   `validate-manifest.ts:63` and `bundle.ts:101` derive from it (today they
   are hand-copied and have ALREADY diverged from each other — E5).
2. Add `bundle` and `factory` to that source (bundle install semantics land
   with the same machinery — E3 closes for both at once).
3. The registry adds `factory` (tracked: meta-factory#571); `playbook` and
   `graph` remain registry-only until an arc consumer exists (documented,
   not silently divergent).
4. arc-only values (`system`, `component`, `pipeline`, `action`,
   `governance`) get a documented mapping row each: publishable-to-registry
   or arc-local, decided per type in the implementation issue — the design
   constraint is only that the mapping be WRITTEN.
5. `governance-overlay` (E10) is acknowledged as an out-of-enum escapee:
   either added properly or migrated to `governance`, in the
   implementation issue for #361's successor.

## D8 — the first factory (member list + name)

Composition, merging #365's product view with the skills view. All
"exists" claims verified installable on 2026-09-02:

| Member | Role in the factory | MVP? |
|--------|--------------------|------|
| cortex | runtime | MVP |
| metafactory-cortex-adapter-discord | surface | MVP |
| compass-core | governance: SOPs (plan-breakdown, dev loop, code review), validators, CLAUDE.md engine | MVP |
| luna-lite (agent bundle) | the agent | optional |
| discord (skill) | narration surface | MVP |
| code-review (skill) | the review lane | MVP |
| pilot-review-loop (skill) | autonomous review cycle | optional |
| art (skill) | diagrams | optional |
| agent-state, soma | state / portable assistant core | optional |

`tools:` checks: `git`, `gh`, `bun` (presence + version floor — exact
floors set in the implementation issue from cortex's requirements).
`produces: software` — the capability declaration that makes this a
*software* factory on the registry's discovery surface.

**MVP rationale (ratified):** the factory ships runtime + governance +
skills; the agent is the operator's first choice on top of it, so "fresh
machine → agent replies" becomes "fresh machine → factory ready + agent
one install away." Note: #365's acceptance sketch includes an agent in its
MVP composition — the ratified MVP deliberately diverges for exactly this
reason; the sketch's end state is reached by one further `arc install` of
the operator's chosen agent bundle.

**Name — DECIDED (ratified 2026-09-02):** the repo is
**`metafactory-factory-software`** (component repo convention,
`metafactory-<kind>-<name>`); the manifest carries `name:
software-factory`. Per E6's precedent, repo-name class and manifest name
are independent axes — `arc install software-factory` is unaffected by the
repo's conventional name.

## Out of scope

Implementation (enums, resolver, cascade, audit — spawned as issues off
#365 after ratification) · registry deploy (HELD) · publishing to the live
registry (#366 "stock the shelf" owns it) · creating the factory repo
(waits on the D8 name decision).

## Implementation issues to spawn after ratification

1. arc: single-source type enum + `bundle`/`factory` values (D7.1–2).
2. arc: reference-resolution install + combined capability review (D2).
3. arc: composition lifecycle — upgrade/files/purge cascade + inventory
   snapshot (D3, D6).
4. arc: publish validation for factories — exact pins, tier MIN (D4, D5).
5. meta-factory#571 (exists): registry taxonomy.
6. compass-core#20 (exists): plan-breakdown skill ships with its SOP.
7. The factory repo itself: `metafactory-factory-software` (name
   ratified), manifest `name: software-factory`, MVP members per D8.

---

## Implementation record — arc#402 (publish side, D4 + D5)

Additive. Records what slice 4 built and the one judgement call it had to
make; it changes no ratified decision above.

**Where it lives (post-#400 rebase).** `lib/composition.ts`
`validateCompositionFields` is the single SHAPE authority for `references[]`,
`tools[]` and `produces`, shared by `arc validate`, `arc install` and now
`arc publish`. `src/lib/factory-references.ts` is a thin LAYER over it holding
only what publish alone enforces; `validateForPublish` (`src/lib/bundle.ts`)
calls that layer for EVERY type, and `createBundle` forwards the same options,
so `arc bundle` and `arc publish` apply one gate rather than two.

The publish-only rules, and why each is publish-only:

| Rule | Why not shared |
|---|---|
| Members must RESOLVE | Publish freezes the snapshot forever; an unresolvable member is fatal here in a way it is not at authoring time. |
| D5 tier arithmetic is an ERROR | Install re-checks tier and WARNs — a member's tier can change under an already-published factory, and refusing then would strand an operator over someone else's later act. Publish mints the claim, so publish refuses. |
| `tools:`/`produces:` REQUIRED on a factory | #400 validates them only when present, because install must tolerate a manifest published before the field existed. The registry requires both. |
| `references[]` must be non-empty | #400 leaves it optional so install tolerates a member-less manifest without crashing; publishing one puts an empty promise on the registry. |
| `tools[]` ceiling of 20 | Mirrors the registry's absurdity ceiling. Install has no business refusing a manifest the registry accepted. |
| Case-variant duplicate detection | The shared duplicate check compares names verbatim while the name grammar is case-INSENSITIVE, so `@metafactory/cortex` + `@MetaFactory/Cortex` slips through it as two members. |
| Build-metadata explanation | The shared grammar already refuses it; publish adds the targeted reason. |

Everything else arc#402 originally wrote — the pin regex, the reference-name
grammar, tool/produces shape, field placement — was DELETED at the rebase as
duplication of the shared validator.

**Convergence (#400 ↔ #402).** Both slices derived the exact-pin grammar
independently from the registry's storage regex and landed BYTE-IDENTICAL on
`/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/`; `PRODUCES_RE` likewise (#400 adopted
#402's verbatim). One of each survives, exported from `composition.ts`. Where
the two differed, #400's shape won by the rule that the shared validator owns
shape: a reference is a scoped-name string (`@scope/name`), not `{scope,
name}`; a tool declares `version` + `reason`, not `min_version` +
`justification`.

**Divergences from the REGISTRY, recorded not absorbed.** Three, all created
by #400's schema choices and all now visible from the publish side:

1. `tools[].version` is a RANGE floor in arc (`>=2.30.0`, the `satisfiesRange`
   grammar); the registry's `tools[].min_version` is an EXACT semver floor and
   refuses ranges outright ("a range is not a floor"). Different field NAME and
   different GRAMMAR. arc#402's first cut mirrored the registry and was
   superseded.
2. `produces` accepts a string OR an array of slugs in arc; the registry
   accepts a single string only.
3. `tools[].name` is case-INSENSITIVE in arc (a host binary, and mixed-case
   binaries exist on real PATHs); the registry's is lowercase-only.

Each means a manifest arc publishes could be refused by registry intake with a
different vocabulary. Not resolvable arc-side alone — it needs a registry-side
decision or an arc-side narrowing, and it is the open item for whoever wires
composition publishing (#366 / meta-factory#573).

**Grammar agreement with the registry.** The exact-pin grammar is not
mirrored by hand, it IS the registry's storage grammar — meta-factory
`src/lib/semver.ts`, `/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?$/`, read on
2026-09-02 rather than assumed. A pin is exact when it names a version the
registry can actually hold, so the registry's grammar is the definition;
anything arc invents on top is a place the two gates can disagree.

Two consequences, pointing in opposite directions, both deliberate:

- Build metadata is refused BY CONSTRUCTION (the grammar has no `+` branch)
  — the same S2 derivation meta-factory#574 made: the registry stores no
  `1.2.3+build` version so such a pin can never resolve, and SemVer compares
  `1.0.0+a` and `1.0.0+b` EQUAL so it is not a unique pin either. Both ends
  refuse it with a TARGETED message rather than a generic "not exact",
  because a build-metadata pin looks exact to its author.
- Leading zeros (`1.02.3`) are ACCEPTED, against the official SemVer 2.0.0
  grammar. The registry's per-component class is `\d+`, so `1.02.3` is a
  version it can store and resolve; refusing it arc-side would invent a false
  refusal against a legitimately published version and break the property
  this mirror exists for. If the registry tightens, arc follows — that is the
  direction the dependency runs.

Reading the registry's source also closed a real gap in the other direction:
arc's first cut allowed a hyphen inside the prerelease (`1.2.3-rc-1`), which
the registry's `[a-zA-Z0-9.]+` cannot store. arc was accepting pins that
could never resolve.

arc's own manifest-VERSION grammar (bundle.ts, validate-manifest.ts) still
accepts build metadata — a different question (what a version may look like)
from this one (what a pin may resolve to). So is `tools[].version`, which is a
HOST BINARY's version, which the registry never stores, and which #400 defines
as a range floor (see the divergence list above).

**Where member tiers come from at publish — the judgement call.** D5
computes the factory's tier from its members, so the source of member tiers
decides what the published tier MEANS. Decided: **the registry entry for the
pinned version is the only authority; it is injected as a `MemberResolver`;
and with no resolver available, publish REFUSES.**

| Candidate | Verdict |
|---|---|
| Installed DB rows (`arc list`) | REJECTED — describes the publisher's laptop, not the release. A member may be installed at a version other than the pinned one, or from a local path at `tier: custom` while the published package is `official`. The factory's tier would then depend on who typed `arc publish`. |
| Skip the check when members are unresolvable | REJECTED — publishes a factory whose declared tier was never checked against anything. D5 says trust never averages up; not computing it averages up by omission, silently. |
| The registry, injected; refuse when absent | CHOSEN — the only source that describes the release rather than a machine. |

Consequence, stated plainly: until a caller wires a registry-backed
resolver, `arc publish` / `arc bundle` of a `factory` or `bundle` FAILS
CLOSED with a message saying so. That matches the registry counterpart,
which is itself fail-closed for composition publishing until meta-factory#573
maps `manifest.references[]` onto the intake envelope — the two gates agree,
including on what they cannot yet do. Live-registry publishing of a real
factory is HELD under #366 regardless.

**The tier vocabulary is a seam, and it is checked.** `ManifestTier` is
erased at runtime, so the type annotation on a resolver's return value
guarantees nothing about what a real (registry-JSON-parsing) resolver
actually hands back. An unrecognized tier is REFUSED, naming the member and
the value — not clamped. Clamping to `custom` would invent a trust level
nobody declared, and clamping to the member's claim would trust the very
string arc failed to recognize. The failure this closes: because `minTier`
ranks by index, an unknown value scored -1 and dropped silently out of the
MIN, so one bad member weakened D5 and ALL bad members disabled it outright
while publish reported clean. A malformed DECLARED tier (`Official`) is
refused for the same reason — it used to fall through the guard written for
an absent one, which is the single typo that turns D5 off.

**Revocation.** A resolved-but-revoked member WARNs at publish-refresh and
does not refuse: the author may be publishing precisely to move off it. The
harder question — what a revocation means for an ALREADY-published pin at
install time (DD-108) — is recorded as #407 rather than decided silently
here.

**Not done here.** `PackageTier` (3 values) and the manifest tier vocabulary
(4, with `core`) remain two enums — reconciling them has its own blast radius
(`arc search --tier`, `sources.yaml`) and does not belong in a
publish-validation slice. The three arc↔registry divergences listed above are
recorded, not fixed. And no registry-backed `MemberResolver` is wired: the seam
exists and fails closed without one, which is the honest state until #366.

---

## Implementation record — arc#401 (lifecycle, D3 + D6)

Additive. Records what slice 3 built, the two judgement calls it had to make,
and the boundary it drew around `arc upgrade`. It changes no ratified decision
above.

**The snapshot schema, and the mistake it avoids.** `composition_inventory`
(one row per `arc files` line, cascading off the composition header) stores
each row as `{member, kind, owns_class, entry, present}`. The load-bearing
choice is that an `owns:` row stores the **declaration**
(`~/.config/metafactory/cortex`, globs included), re-expanded at diff time,
while every other row stores a resolved absolute path.

The obvious alternative — snapshot the list of paths that exist at install —
would have made the D6 acceptance test *vacuous*. `owns` names what a
package's RUNTIME writes, and at install almost none of it exists yet; that is
the same fact `remove.ts` already encodes for cortex#2441 ("naming an absent
declaration as kept on disk is misleading"). A snapshot of expansions records
nothing for those entries, so the post-purge diff comes back empty because it
looked at nothing. Storing the declaration puts every path the package created
*between install and purge* in scope, which is the only version of D6 worth
having. `present` records install-time liveness and the diff deliberately does
not gate on it: a leak is a leak whenever it appeared.

The snapshot is built from `filesListing` — the same walk `arc files
<factory>` prints — so the record and the command cannot hold two opinions
about what the composition put on the machine. `arc files <factory>` returns
the union (factory + members, each line attributed with `member`) plus the
per-member listings unmerged; a non-composition's output is byte-identical to
arc#359's.

**Refcount semantics — "exclusively owned", three referent classes.** A member
is purged with the factory only when, after the factory's own record is gone,
NOTHING holds it. Fail-safe throughout: an unanswerable question RETAINS.

| Referent | Register | Why it counts |
|---|---|---|
| Another composition lists it | `composition_members` | arc#349's shared-dependency rule with a different register. Pending compositions count: an interrupted install may yet be resumed, and taking a member out from under it turns a recoverable half-install into a broken one. |
| Another active package declares it in `depends_on.packages` | `packagesRequiring` (exported from `remove.ts`, not re-derived) | Literally arc#349's own denominator, including its "manifest unreadable ⇒ possible requirer" fail-safe. |
| The operator installed it FIRST | `composition_members.state = 'preexisting'` | Undoing the composition's install decision must not undo one the operator made separately. |

The third needed a schema addition, and the shape of it was the first
judgement call. `InstallResult.alreadyInstalled` is knowable only at install
and is worthless unless persisted, so it is persisted on the membership row.
But it must NOT be recorded merely because the member was already installed:
if another COMPOSITION is what installed it, that referent is already tracked
by row 1, and marking it here too would make the member **immortal** —
retained by the pre-existing rule long after the other composition went away,
in defiance of D3's "falls with the last referent". So install records
`preexisting` only when `compositionsReferencing(member, exclude: self)` is
empty. The rejected alternative was inferring it from `skills.installed_at <
compositions.started_at`: `beginComposition` re-stamps `started_at` on every
re-install, so a factory installed twice would read every member as
pre-existing and purge would quietly become a no-op forever.

**The interrupted install — decided, not left open.** `arc purge <factory>` on
a `pending` composition CLEANS THE DEBRIS: the landed members are cascaded
(refcounted exactly as above — an interrupted install's members can be shared
too) and the pending record is dropped. Without this the debris is
unreachable: the factory has no `skills` row, so `arc purge` refused with "not
installed" on the one name that could reach it, and the landed members look
like ordinary standalone packages. This is D6 serving the case D6 exists for.
Such a composition has no inventory snapshot (the snapshot is taken at
`complete`), so the purge reports `untangle: NOT VERIFIED` rather than a green
diff it did not earn.

**`arc upgrade <factory>` — what this slice supports.** The factory advances
to its new release and members to THAT release's pins, never floating latest.
The sequencing IS the safety property: the prospective manifest is read off
the remote (`git show @{u}:arc-manifest.yaml`), validated through the SAME
`validateCompositionFields` install and publish use, planned, and every member
pin pre-flighted (reachable? and does the manifest at it declare that version
— D4 re-checked at upgrade) — all before the factory's own code moves. A
factory recorded at v0.2.0 whose members never followed is a broken snapshot
every later command believes, so a refusal must arrive while the factory is
still on its old release.

Members move through the ordinary `arc install --pin` path, so each inherits
arc#396's dirty-tree, diverged-branch and capability-widening guards and its
`replaceCapabilities` — the recorded surface describes the code now checked
out. `yes: true` matches `createMemberInstaller`'s posture (`arc upgrade` is
non-interactive by design; a widening is WARNed, not silent).

Fail closed, by name, nothing moved:

| Case | Reason |
|---|---|
| Registry member whose pin must move | Live-registry operations are HELD (arc#366). `fetchAndVerifyRegistryPackage` does accept an exact version, so the mechanism is not the obstacle — the obstacle is that there is no published factory to exercise a verified pinned re-download + atomic swap against, and shipping that untested on the supply-chain-verification route is worse than a named refusal. A registry member whose pin did NOT change needs no move and is not refused. |
| Registry-sourced factory | Same, one level up. |
| New release ADDS a member | A new member brings a surface nobody reviewed. That decision belongs to the one combined review (D2) — arc#400's F1 argument applied to upgrade. |
| New release DROPS a member | Removal is the refcounted cascade above; upgrade does not make removal decisions. |
| Pin unreachable, or the manifest at the pin disagrees | D4, re-checked against the bytes. |

**Residual risk.** (a) The registry half of upgrade is unexercised by
construction and lands with #366. (b) A member move that fails AFTER the
factory has advanced leaves a genuine mixed state; it is reported per member
and the composition record is rewritten to name the versions actually
installed, so `arc list` shows the truth rather than a tidy fiction, but no
rollback is attempted (the same contract as arc#346's cascade). (c) The
untangle diff verifies the paths the snapshot NAMED — a package that writes
outside everything it declares is outside D6's reach by construction, which is
the same boundary `owns:` has had since arc#359.

### Review hardening (arc#401 second pass)

Two review lanes on the first implementation found three root causes and nine
adversarial findings, five of them with executed repros. All are closed; the
repros are committed as regressions
(`test/commands/composition-hardening-401.test.ts`). What changed, and why the
first answers were wrong:

**ROOT 1 — one identity for a member.** Membership was keyed on the raw
`references[].name` LABEL, while `skills.name` is the member's MANIFEST name.
Every `@scope/name` member differs across those two by construction, so the
snapshot, the purge cascade and the refcount all looked up a package that was
not there: `arc purge <factory>` printed `untangle: CLEAN` over a fully
installed member with its config still on disk, and a member shared under a
case-variant label was deleted out from under the composition that needed it.

The fix is a canonical key — scope-stripped, lowercased
(`lib/composition-identity.ts`) — plus storing BOTH names:
`composition_members.member_name` is now what landed, `member_label` what the
reference said. Scope-stripping rather than scope-preserving is the deliberate
half: `skills.name` is a primary key over bare manifest names, so arc cannot
hold `@a/foo` and `@b/foo` as two packages, and a key finer-grained than the
table it joins against is exactly how the label key failed. A GENUINE mismatch
(not a scope difference) is now a refusal at landing, because the combined
review attributed that member's surface to the label. `packagesRequiring`
(#349's own denominator) compares canonically too — a missed requirer is a
deletion, so widening the match only ever retains more.

**ROOT 2 — `preexisting` means nobody tracked installed it.** The predicate
was "does another composition MENTION this member", which is not "did another
composition PUT IT THERE". Under it, a second factory referencing a package the
operator had installed by hand recorded it `landed`, and purging the two
factories in order deleted the operator's package. `compositionsInstalling`
(state `landed` only) replaces `compositionsReferencing` at that call site.
Two more windows in the same predicate: a RESUMED install re-marked its own
members `preexisting` (immortal, and reported as residue forever) — closed by
reading the prior self-states before `beginComposition` wipes them; and
upgrade's two-step record rewrite exposed an all-`pending` intermediate whose
kill erased the fact permanently — closed by `replaceCompositionRecord`, one
transaction, which throws rather than write an ambiguous membership. The one
remaining case (a row still `pending` because an INSTALL was killed mid-flight)
has no recorded answer at all, so it falls back to `installed_at <
started_at` — evidence too weak for the general predicate, strictly better than
nothing here, and failing in the RETAIN direction.

**ROOT 3 — honest reports, and the rest.** A retained member's paths are
legitimately still on disk, and counting them as residue made CORRECT
refcounting render as a failed untangle; they are a third bucket now
(`InventoryDiff.retained`). The purge order is reversed — members first,
factory (and the record) LAST — because taking the record down first left a
window where a killed purge orphaned the members behind a name that then
refused, which is the state the command exists to prevent. Cross-member `owns`
overlap is refused before anything lands: two individually-valid manifests can
compose into a union where one member's `state` sits inside another's
`userData`, and purging then deleted user data while reporting it kept — the
`/home` guarantee failing while claiming to hold. It is refused at composition
time rather than repaired at purge time because at purge time there is no safe
choice between the two members. `arc upgrade` now refuses on an unreadable
remote (not knowing the plan is a reason to stop, never to do half of it), on a
member whose repo URL changed between releases (a pinned member is a
determinism claim about bytes, not a version number — checked even at an
unchanged pin), and in pre-flight on a dirty member worktree. A mixed-state
upgrade records `status: 'partial'` at the versions actually installed, so
`arc list` flags it and a retry re-plans instead of reporting "already at".
`arc install --pin` on a composition refuses and names `arc upgrade`; plain
`arc remove <factory>` now says which members it orphaned.

**Two follow-ups from verification.** Both are ROOT 1 consequences the first
hardening pass did not chase far enough, and both were found by probing the
NEW canonical key rather than the old code:

*F10 — the duplicate check was still verbatim.* `references[]` could name
`@a/dup` and `dup`, which the canonical key says are ONE member. Validation
passed them, resolution passed them, the first landed, and the second collided
on the `composition_members` primary key — an uncaught `SQLiteError` on the
trust path, with a member installed and a `pending` record behind it. The check
now keys on `canonicalMemberKey`. The message BRANCHES: a literal repeat keeps
arc#402's "declared more than once" vocabulary (the publish side asserts it as
the shared validator's contract), while two spellings of one member get their
own line naming both — an author looking at two visibly different strings would
read the generic message as a false positive and work around it.

*F11 — the identity refusal left UNREACHABLE debris.* Two halves. The "already
landed" pointer named reference LABELS, so `arc remove <label>` — the one
command the error hands the operator — failed with "not installed" for exactly
the members whose label differs from their manifest name. And the refusal
returned BEFORE `onMemberLanded` ran, so the row kept the label and a later
purge of the pending record stepped straight over an installed package: the
same invisible-member failure ROOT 1 exists to close, reintroduced on the
refusal path. The member is now RECORDED first — the caller's binding computes
`landed`/`preexisting` exactly as it would otherwise, because the member is on
disk either way — and the refusal comes second, with the pointer naming the
landed name and a per-member command.

**Residual risk after hardening.** The install-side `pending` window is
narrowed, not eliminated — a kill between opening the record and marking a
member leaves a row whose only evidence is a timestamp. `partial` compositions
are re-planned but never rolled back. And the canonical key collapses two
registry scopes that share a bare name, which is a distinction arc's `skills`
table has never been able to represent either.
