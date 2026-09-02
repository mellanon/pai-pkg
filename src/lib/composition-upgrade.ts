/**
 * `arc upgrade <factory>` — moving a composition to a new release
 * (arc#401, `docs/design-factory-type.md` D3 + D4).
 *
 * D3 says the factory advances to its NEW RELEASE and its members to THAT
 * RELEASE'S PINS — *never to floating latest*. D4 says why: a factory release
 * is a reproducible snapshot, and a member that floats reintroduces the
 * integration project the type exists to delete. So the new release's
 * `references[]` are the instruction set, and this module turns them into a
 * plan.
 *
 * ## Fail closed, and fail BEFORE anything moves
 *
 * The honesty rule `prepareComposition` keeps at install applies here with more
 * force, because an upgrade has an installed factory to lie about. A factory
 * whose `skills` row says v0.2.0 while its members sit on v0.1.0's pins is a
 * broken snapshot that every later command believes. So the whole plan —
 * including "does this tag exist, and does the manifest at it agree with the
 * pin" — is settled before the factory's own code is touched, and any doubt is
 * a REFUSAL naming what arc could not establish rather than a guess.
 *
 * ## What this slice supports, and what waits for arc#366
 *
 * Supported: a factory whose own source is a **git repo**, with members
 * recorded as `member_source: 'repo'`. Both move by resolving the pin to a
 * commit and checking it out — offline-capable, and exercised end to end by
 * `test/commands/composition-upgrade-401.test.ts`.
 *
 * Refused, by name:
 *  - a **registry** member that must move. `fetchAndVerifyRegistryPackage` does
 *    take an exact version, so the mechanism is not the obstacle; the obstacle
 *    is that live-registry operations are HELD under arc#366 and there is no
 *    published factory to exercise a verified pinned re-download + atomic swap
 *    against. Shipping that path untested on the supply-chain-verification
 *    route is a worse answer than a refusal that names the issue. (A registry
 *    member whose pin did NOT change needs no move and is not refused.)
 *  - a factory whose own source is the registry, for the same reason.
 *  - a new release that **adds or drops** a member. Membership change is a
 *    capability decision: adding a member widens the surface the operator
 *    approved in the one combined review (D2), and dropping one is a removal
 *    that must go through the refcounted cascade (D3/#349). Neither belongs to
 *    a command whose job is "move the pins", and doing either silently is
 *    exactly the unreviewed-arrival failure arc#400's F1 refusal exists to stop.
 */

import { existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { PackageReference } from "../types.js";
import type { CompositionMemberRow } from "./db.js";
import { pinRefCandidates } from "./pin-ref.js";

/** One member the new release moves to a different pin. */
export interface MemberMove {
  name: string;
  /** The pin recorded for the release currently installed. */
  from: string;
  /** The pin the NEW release names. */
  to: string;
  /** The member's recorded address — a git URL on the supported path. */
  ref: string;
}

export type MemberMovePlan =
  | { ok: true; moves: MemberMove[] }
  | { ok: false; error: string };

/**
 * Diff the recorded membership against the new release's `references[]`.
 *
 * Pure: no git, no database, no filesystem. Every fail-closed rule in the
 * module header lives here, which is what makes each of them assertable
 * without a repo — the same reason `composition.ts` keeps its refusals pure.
 */
export function planMemberMoves(
  recorded: readonly CompositionMemberRow[],
  references: readonly PackageReference[],
): MemberMovePlan {
  const recordedByName = new Map(recorded.map((row) => [row.member_name, row]));
  const referencedNames = new Set(references.map((r) => r.name));

  const added = references.filter((r) => !recordedByName.has(r.name)).map((r) => r.name);
  if (added.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to upgrade: the new release ADDS member(s) ${added.join(", ")}. ` +
        `A new member brings a capability surface nobody has reviewed — that decision belongs to the ONE combined review an install shows (docs/design-factory-type.md D2), not to a command whose job is to move pins. ` +
        `Nothing was moved. \`arc purge\` the composition and install the new release to review it as a whole.`,
    };
  }

  const dropped = recorded
    .filter((row) => !referencedNames.has(row.member_name))
    .map((row) => row.member_name);
  if (dropped.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to upgrade: the new release DROPS member(s) ${dropped.join(", ")}. ` +
        `Removing a member is a refcounted cascade — it may be shared with another composition or required by another package (docs/design-factory-type.md D3, arc#349) — and upgrade does not make removal decisions. ` +
        `Nothing was moved. \`arc purge\` the composition and install the new release instead.`,
    };
  }

  const moves: MemberMove[] = [];
  for (const reference of references) {
    // Every name is recorded — the `added` check above returned otherwise.
    const row = recordedByName.get(reference.name);
    if (!row) continue;
    if (row.member_version === reference.version) continue;

    if (row.member_source !== "repo") {
      return {
        ok: false,
        error:
          `Refusing to upgrade: member '${row.member_ref}' resolves through the REGISTRY, and moving a registry member to an exact pin needs live-registry operations that are HELD (arc#366). ` +
          `Nothing was moved — a factory recorded at the new release with members still on the old pins would be a broken snapshot (docs/design-factory-type.md D4). ` +
          `Re-run once arc#366 lands, or publish the member with a 'repo:' URL in references[].`,
      };
    }

    moves.push({
      name: row.member_name,
      from: row.member_version,
      to: reference.version,
      ref: row.member_ref,
    });
  }

  return { ok: true, moves };
}

/** What a pin resolved to in a member's checkout, or why it could not. */
export type PinResolution =
  | { ok: true; sha: string; candidate: string }
  | { ok: false; error: string };

/**
 * Resolve a member's NEW pin inside its existing clone, without moving it.
 *
 * Two questions, both answered before the factory advances:
 *  1. Is the pin REACHABLE? `--force --tags` on the fetch is the same
 *     load-bearing flag `repinInstalledCheckout` documents: a plain `--tags`
 *     leaves a re-tagged version pointing at its stale commit, and a pin that
 *     resolves to the wrong bytes while reporting success is arc#396 again.
 *  2. Does the manifest AT that commit declare the pinned version? This is D4
 *     re-checked at upgrade, the same check `prepareComposition` runs at
 *     install against the bytes that actually resolved. A tag that names 1.1.0
 *     while its manifest says 1.0.0 is a broken snapshot however it came about.
 *
 * Read-only: nothing but `git fetch` (which touches refs, not the working
 * tree). The move itself goes through the ordinary `arc install --pin` path so
 * it inherits arc#396's dirty-tree, diverged-branch and capability-widening
 * guards rather than a second, weaker copy of them.
 */
export function resolveMemberPin(installPath: string, version: string): PinResolution {
  if (!existsSync(join(installPath, ".git"))) {
    return {
      ok: false,
      error: `no git checkout at ${installPath} — a repo member must be movable to its pin`,
    };
  }

  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: installPath, stdout: "pipe", stderr: "pipe" });

  const fetch = git("fetch", "--quiet", "--force", "--tags");
  const fetchNote =
    fetch.exitCode === 0
      ? ""
      : ` (note: \`git fetch\` failed first — ${fetch.stderr.toString().trim() || `exit ${fetch.exitCode}`})`;

  const candidates = pinRefCandidates(version);
  for (const candidate of candidates) {
    const rev = git("rev-parse", "--verify", "--quiet", `${candidate}^{commit}`);
    const sha = rev.exitCode === 0 ? rev.stdout.toString().trim() : "";
    if (!sha) continue;

    const declared = manifestVersionAtRef(installPath, sha);
    if (declared === null) {
      return {
        ok: false,
        error: `no readable arc-manifest.yaml at ${candidate} (${sha.slice(0, 7)})`,
      };
    }
    if (declared !== version) {
      return {
        ok: false,
        error:
          `pinned to ${version} but the manifest at ${candidate} declares ${declared} — ` +
          `a factory release is a reproducible snapshot (docs/design-factory-type.md D4)`,
      };
    }
    return { ok: true, sha, candidate };
  }

  return {
    ok: false,
    error: `no tag for the pinned version ${version} (tried ${candidates.join(", ")})${fetchNote}`,
  };
}

/** The `version` a manifest declares at `ref`, or null when unreadable. */
function manifestVersionAtRef(repoPath: string, ref: string): string | null {
  for (const file of ["arc-manifest.yaml", "pai-manifest.yaml"]) {
    const show = Bun.spawnSync(["git", "show", `${ref}:${file}`], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (show.exitCode !== 0) continue;
    try {
      const parsed = YAML.parse(show.stdout.toString()) as { version?: unknown } | null;
      if (parsed && typeof parsed.version === "string") return parsed.version;
    } catch {
      // Unparseable at this ref — try the other filename, then report unreadable.
    }
  }
  return null;
}
