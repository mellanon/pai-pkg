# Arc as a Trust Gate — Component Signing, Scanning, and Existing Controls

**Status:** Design draft (for discussion)
**Created:** 2026-07-17
**Provenance:** community discussion (Robert Chuvala's sovereignty/verification question re: distributing infra blueprints as metafactory.ai components) + the PRINCIPLES set in cortex#1381 (#8–#12). This note applies that doctrine to the supply chain.
**Related:** the published trust model at **meta-factory.ai/trust** (six-mechanic identity-anchored network — see below); `src/lib/manifest.ts` (capability declaration), `src/lib/cosign.ts`, `src/lib/source-resolver.ts` + trust tiers, the confidentiality-gate scan engine.

## Where we are: pre-go-live

Today, **arc installs from git** (`arc install <git-url>`) — arc still owns the install, but the *source* is a git repo rather than a signed release registry. This is a **pre-go-live development approach**: source-transparent and fork-friendly by design for the current phase, but **not** the production distribution model — no published registry, no release artifacts, no signature verification in the path yet. It is the bootstrap, not the destination.

The **destination** is the published trust model below. This note is about the *go-live* distribution — how signing and scanning compose with the identity-anchored model — not about hardening the dev-time git clone.

## The published go-live trust model (meta-factory.ai/trust)

The go-live trust model is **identity-anchored** — six mechanics, all oriented around *who* and *is-it-sealed*:

1. **Identity verification** — publishers are named humans; a five-tier system (○ ◐ ● ◆ ★) with permanent attribution.
2. **Sponsorship gate** — a first blueprint from an unknown operator never ships alone; a sponsor reads the code and stakes their own reputation.
3. **Capability manifests** — every power (filesystem, shell, network, secrets, subagent) declared with plain-language justification + an audit panel.
4. **Content addressing** — every release sealed; a cryptographic fingerprint at publish time is tamper evidence.
5. **Registry signing** — release indices signed by metafactory (anti-MITM / anti-index-manipulation).
6. **Publisher provenance** — attestations tied to author identity in a public transparency log, independent of metafactory's signing authority.

And it is honest about its edge: it is **"not a sandbox, not a code audit service, and not a guarantee of correctness"** — purely identity-anchored trust infrastructure.

**So Robert's "signed component + capability manifest" is substantially already specified** (mechanics 3–6 cover provenance, sealing, and declared reach). The open seam is precisely what the page *says it does not do*: **check what is actually inside, and whether it matches the declaration.** That is where scanning fits — as the addition, not a replacement.

---

## The problem

A distributed component runs in the **deployer's** tenant, with the deployer's credentials. The deployer must be able to answer, *before it touches their account*: is this really from who it claims, has it been tampered with, what can it reach, and does its actual content match that claim — **without trusting the publisher, the marketplace operator, or any model's account of the artifact.**

This is not a new trust model. It is PRINCIPLES #9, #10, and #12 applied to "installing someone else's code":

- **#9 — gate on what happened, not what it claims.** A signature and a scan are *observable facts* (cryptographic / deterministic), never the author's or a model's word.
- **#10 — controls live where the agent has no hands.** Verification runs in the **deployer's** arc, on the deployer's machine — where the *publishing* agent has no reach. That is what makes it "a scan the model can't forge": the publishing model is not in the trust path at all.
- **#12 — deterministic gates; the model only advises.** A model may flag "this capability combination is unusual"; it is never the install condition.

## Four questions, four independent controls

Each control answers a **different** question. None is sufficient alone; the composition is defence in depth. arc is the composition point.

| # | Question | Control | What it does NOT prove | State |
|---|----------|---------|------------------------|-------|
| 1 | Who is behind it, and how far up the tier ladder? | **Identity + tier + sponsorship** — publishers are named humans; five-tier attribution; an unknown operator's first blueprint needs a sponsor who reads the code and stakes their reputation. | Anything about the artifact's *content*. A high-tier, well-sponsored publisher can still ship a compromised release. | ✅ meta-factory.ai/trust |
| 2 | Is it authentically that, unmodified? | **Sealing + signing + provenance** — content-addressed fingerprint (tamper evidence), metafactory-signed release index (anti-MITM), and publisher provenance in a public transparency log (proof of *who built it*). | **Safety.** A validly signed, correctly attested package can be hostile — sealing/signing a payload does not sanitise it. | ✅ spec'd (mechanics 4–6) |
| 3 | What does it declare it can reach? | **Capability manifest** — filesystem / shell / network / secrets / subagent powers declared with justification + audit panel; an *undeclared* capability is a security bug. | That the declaration is *true*. It is a promise, not a proof, until something checks it. | ✅ meta-factory.ai/trust |
| 4 | Does the artifact match its claim — and is it free of known-bad? | **Scan** (deterministic, unforgeable) — (a) content scan for secrets / known-bad patterns (the confidentiality-gate engine); (b) declared-vs-actual capability check (does the code only reach what the manifest declares?). Turns the manifest from a promise into a checked fact. | Novel / obfuscated malice; correctness. Scanning is a *bounded* check, not a safety guarantee (see below). | ⏳ the seam — content-scan ✅, capability-diff = frontier |

### Scanning fits *inside* the identity-anchored model — and respects its stated limit

meta-factory.ai/trust is deliberately honest that it is **"not a code audit service, not a guarantee of correctness."** That honesty is correct and must be preserved: full malice/correctness detection is undecidable, and a gate that *promised* safety would be the very "gate you can satisfy by assertion" the doctrine forbids. So scanning is added **as a bounded, deterministic check, never as a safety promise**:

- It verifies a **fact you can observe** (#9): "this artifact contains no known-bad pattern" and "its imports/network/syscall reach does not exceed capability *X*, *Y*, *Z* it declared." Both are decidable, deterministic passes over bytes — not a judgement about whether the code is *good*.
- A model may **advise** on top ("this capability combination is unusual for a component of this kind") but is never the gate (#12).
- It does **not** upgrade the model's promise from "identity-anchored" to "audited/safe." It closes the specific, checkable gap between *declared* reach and *actual* reach — the "diff-review gate on what it actually deploys" from the originating discussion — and nothing more.

In one line: **identity says *who*, sealing says *unmodified*, the manifest says *what it claims*, and the scan checks the claim against the bytes — without any of them pretending to certify the code is safe.**

Then, above these:

- **The human at the reversibility line (#8)** — for anything that touches credentials, deploys to the deployer's tenant, or is otherwise irreversible, a human tick. Below the line (a component that only reads, or writes within its own sandbox) can be auto.
- **A named receipt + append-only log (#9 / #10)** — every install records what was installed, from what source, which signature verified, and what the scan found, in a place the installing agent cannot rewrite.

## Why the layers compose (each covers the others' blind spots)

- The **signature** catches tampering a scan might miss (a modified-but-plausible artifact).
- The **scan** catches malice a valid signature cannot see (the signature says *who*, not *what*).
- The **manifest + capability-diff** catches reach the signature and tier don't (an authentic, clean-scanning package that still declares — or exercises — more than it should).
- The **human at the line** catches what all of them miss on the actions that can't be undone.

Signing and scanning are therefore **complementary, not substitutes**: signing answers *who + unmodified*; scanning answers *what's inside*. Shipping one without the other is a common and dangerous shortcut — a signed-only pipeline vouches for provenance while saying nothing about content; a scanned-only pipeline can be fed a tampered artifact.

## Sovereign by construction

All of this executes in the **deployer's** arc, in the deployer's tenant. The marketplace operator never holds the deployer's state **or their trust decision**. arc-as-trust-gate is #10 restated for distribution: the controls sit in the *deployer's* hands, not the publisher's. A blueprint that deployed onto the operator's substrate instead — recentralising everyone's infra on one account — is the exact failure mode the agentic-work thesis exists to avoid.

## What we are NOT

Consistent with the "What we refuse to become" list:

- **A gate the publisher can satisfy by assertion.** No control here accepts "I signed it, trust me" or "the manifest says so" — provenance is verified by math, capability by a deterministic diff.
- **An LLM as the install condition.** Model review is a filter/second opinion, never the receipt. The gate is deterministic (signature verify + scan + human-at-line).
- **A registry that holds your trust decision.** Verification is client-side, in the deployer's arc; the operator is not a trusted third party.

## Current state vs frontier

- **Dev-time today (pre-go-live):** **arc install from git** — arc-managed, but git as the source rather than a signed release registry. Source-transparent, fork-friendly; no release artifacts, no signature verification in the path. Deliberate for the bootstrap phase.
- **Published go-live model (designed, partly built):** the six identity-anchored mechanics at meta-factory.ai/trust; the capability manifest already exists in `arc-manifest.yaml`; `cosign.ts` and a deterministic content-scan engine (gitleaks + denylist + shape patterns) already exist and gate this ecosystem's own repos.
- **Frontier (this note's design work — go-live distribution):** (1) a **registry + release-artifact** install path (the thing signing/scanning gate); (2) **signature + provenance verify** wired *into* that install path (verify before symlink; tier × signature-validity as the composed posture); (3) the **declared-vs-actual capability diff** — the "unforgeable" half of the scan that checks code reach against the manifest, the piece meta-factory.ai/trust explicitly does not yet do; (4) the **receipt + append-only install log**; (5) the **human-at-the-line** policy table (per PRINCIPLES #8/#11 — the auto/propose/approve mapping the installing agent inherits and cannot edit).

## Open questions

1. Where is the signature root of trust — per-publisher keys (keyless Sigstore/OIDC identities) vs a metafactory keyring? Revocation flow.
2. Capability-diff fidelity: how much of "actual reach" can be checked deterministically (imports/syscalls/network) before it becomes a model judgement (which, per #12, can only advise)?
3. Does the receipt log warrant an independent observer process (never the installing agent — #10/"a system that audits itself"), and when does it earn its keep?
4. Per-install grants (raise the posture for one install, logged, one-way) vs standing per-tier policy — or both.
