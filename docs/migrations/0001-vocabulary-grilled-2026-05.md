# arc — Vocabulary Migration Manifest (2026-05)

**Status:** draft for review · deterministic ground truth · **iteration 2** (hard-review fixes applied: 2-segment durable, subject grammar, carve-outs)
**Source:** `CONTEXT.md` (cortex) + `CONTEXT.md` (myelin) + `CONTEXT-MAP.md` (compass/ecosystem) — grill-with-docs sessions, May 2026
**Method:** every entry below was produced by `grep -rn` against arc `main` (commit `c4435df`, 2026-05-17 — re-pinned for iteration 2 against current arc `main` HEAD, unchanged). Each cited line is a real occurrence in the codebase at that commit; nothing is inferred. Where an entry depends on a decision still open, it is flagged **FOR REVIEW** and does not change a line until the decision lands.

**Iteration 2 changelog (hard review — 2 criticals, 4 important, 2 carve-outs, 1 flag-decision tightening):**
- **C1 (architectural)** — A1's durable template corrected from a **3-segment** `${principal}-${stack}-${assistant}` form to the **2-segment** `${stack}-${assistant}` form. The agent-addressing key is `(stack, assistant)` (`cortex/CONTEXT.md:30, :93`), and a stack is principal-scoped by definition (`:16, :44`). See the explicit Assumption note in "The core defect".
- **C2** — A4's subject-grammar rewrite fixed: `{org}`→`{principal}` **and** the `{stack?}` optional marker dropped — stack is a mandatory segment of the 6-segment grammar (`cortex/CONTEXT.md:40`).
- **Carve-outs** — `Principal.operator` (NSC account) and `capabilities.network` (skill-manifest capability type) given explicit carve-out paragraphs so re-greppers see they were considered and excluded.
- **`--network` flag** — hard break kept, plus a mandatory pre-flight caller enumeration and a one-release error-with-guidance shim added.
- **I1–I4 + cross-manifest timing** — see the dedicated notes inline.

Read this as the script: each PR claims one rename or one file/cluster, performs every listed change, runs `bunx tsc --noEmit && bun test`, opens for review.

arc is a **small** manifest — one core defect (a malformed JetStream consumer-name template) and a thin halo of `{org}` / `operator` prose. The companion myelin manifest (`myelin-migration-manifest/docs/migrations/0001-vocabulary-grilled-2026-05.md`, 4-round-reviewed) carries the heavy schema/type renames; arc consumes myelin's published grammar and must not drift from it.

---

## The core defect (read this first)

arc derives a JetStream durable-consumer name with the template:

```
cortex-review-consumer-${network}-${agent}
```

Per the **grilled cortex domain model** (`cortex/CONTEXT.md`), a JetStream consumer belongs to an **agent**, and an agent "**is reached via the assistant it hosts plus the stack it runs on**" (`cortex/CONTEXT.md:30`) — "the hosting agent is resolved from `(stack, assistant)`" (`:93`). A **network** is *deployment topology* — "**not a subject segment**" and, by the same reasoning, **never an addressing segment** of a durable name. The wrong segment is load-bearing:

- The handover string `cortex-review-consumer-metafactory-echo` (cited at `src/lib/jetstream.ts:239`) puts `metafactory` — the **network** — in the first segment. `metafactory` is the network, not part of the agent-addressing key.
- This is the exact shape of the cortex grill's "there's the bug" dialogue: a name built with `metafactory` where a stack/assistant token belongs.
- A durable name that addresses by `(network, agent)` cannot distinguish two agents under the same network — the network token carries no addressing information the broker can act on.

**The fix:** rename the template to address by `(stack, assistant)` — the documented agent-addressing key:

```
cortex-review-consumer-${stack}-${assistant}
```

This is **still a two-segment template** (was two, stays two) — the defect is *which two segments*, not how many. The old `${network}` segment is replaced by `${stack}`, and the old `${agent}` segment is replaced by `${assistant}`. The bus routes to an **assistant** (`@echo`, `@sage`), and the agent is resolved from `(stack, assistant)` — it "carries no wire name" (`cortex/CONTEXT.md:30,93`, Agent entry). So `${network}` → `${stack}` and `${agent}` → `${assistant}`.

> **Assumption (stated explicitly per the architecture-wins rule).** The 2-segment `(stack, assistant)` key is correct **if each principal runs its own NATS account/broker** — which is exactly what `cortex/CONTEXT.md` implies: a **stack** is "one running cortex deployment under a **principal**" (`:16`), and `local` scope "never leaves the **principal** boundary" (`:44`). Under that topology a stack name is unique within a principal's broker, so `(stack, assistant)` uniquely identifies an agent's durable. **If** cross-principal broker sharing with colliding stack names is ever a real deployment, the durable would need a `principal` segment back — **but** that is an architecture change: `cortex/CONTEXT.md` would have to be updated *first* (the agent-addressing key is `(stack, assistant)` there today), and only then would arc follow. This manifest does not pre-empt that; it implements the documented model.

> **I1 — separable changes.** A1 bundles two independent edits: (1) the **segment-content correction** — `network`→`stack` — which is the *defect fix* (a `metafactory` network token never belonged in an agent-addressing slot), and (2) the `agent`→`assistant` **vocabulary rename** — cosmetic, aligning the second segment's name with the wire vocabulary. They could land in separate PRs; this manifest lands them together because they touch the same one-line template, but a reviewer should understand the segment-content correction is load-bearing and the vocab rename is not.

This is an **operator-facing, on-the-wire change** (durable consumer names are persisted broker state). It is Tier 3. See Risk tiers and the operational re-provisioning step.

---

## Rename inventory (canonical)

| #   | Old | New | Tier | Scope | Source |
|-----|---|---|---|---|---|
| A1  | `reviewConsumerName(network, agent)` template `cortex-review-consumer-${network}-${agent}` | `cortex-review-consumer-${stack}-${assistant}` | **3 (wire — durable name)** | code + tests + prose | cortex-CONTEXT:30,93 (agent addressed by `(stack, assistant)`); :16,44 (stack is principal-scoped) |
| A2  | `--network` CLI flag on `arc nats provision-streams` / `provision-consumer` | `--stack` (+ new `--assistant` via A3); see flag decision | **3 (operator-facing CLI)** | code + prose | cortex-CONTEXT (network is never an addressing segment; stack is the addressing segment) |
| A3  | `--agent` CLI flag (the durable's being-segment) | `--assistant` | 3 (operator-facing CLI) | code + prose | cortex-CONTEXT:30,93 (bus routes to assistant; agent has no wire name) |
| A4  | `{org}` subject-grammar token in comments | `{principal}` | 1 | prose (comments) | cortex-Q3 / myelin owns grammar |
| A5  | `operator` prose meaning the human / the deployment-owner | `principal` | 1 | prose (comments) | cortex-Q2 |
| A6a | `operator` prose — mechanically resolvable, every line decided here | `principal` | 1 | prose | cortex-Q2 |
| A6b | `operator` prose — genuinely ambiguous (deferred, listed) | TBD by follow-up grill | — | prose | cortex-Q2 |

### Renames this manifest does NOT make — the NSC carve-out

arc has legitimate **NSC operator-account** terminology. NSC (the NATS `nsc` CLI) models a trust hierarchy `operator → account → user`; arc's `arc nats add-bot` / `arc nats setup-operator` provision NATS users under an NSC *operator account*. This `operator` is **NATS infrastructure**, **not** the cortex `operator`-the-human concept. It is left entirely unchanged:

- **`setup-operator` command name** — `src/cli.ts:1373` `.command("setup-operator <account>")`. NSC term. Unchanged.
- **`SetupOperator*` types** — `setupOperator`, `SetupOperatorOptions`, `SetupOperatorResult`, `SetupOperatorBotResult`, `SetupOperatorJson` across `src/commands/nats.ts:551,557,563`, `src/lib/json-response.ts:102,110,112,149`, `src/cli.ts:41,50,1394,1395`. NSC API surface. Unchanged.
- **`nsc`, `nsc.json`, `NSC_NOT_INSTALLED`, `NSC_COMMAND_FAILED`** — `src/commands/nats.ts` passim, `src/lib/json-response.ts:26,27`. NSC tooling. Unchanged.
- **"operator account" prose** — `src/lib/json-response.ts:29`, `src/cli.ts:1336`, `docs/integrations/cortex-creds.md:14,34,55,57,61,133,152,153,172,175`. Every one describes an NSC operator account. Unchanged. (See A6a/A6b for the precise per-line decisions.)
- **`OP_*` account identifiers** — `OP_TEST`, `OP_LOCAL`, `OP_ATTACKER`, `OP_OTHER`, `"OP"` in `test/commands/identity.test.ts`. NSC account names. Unchanged.

### Carve-out: `Principal.operator` — DO NOT rename (resolved by review)

The review loop resolved the previously-deferred `Principal.operator` question: **it is carved out — not renamed.** `src/commands/identity.ts:21-29` defines a local `Principal` interface with `operator: string;` (`:24`). `arc identity generate` populates it from the `-a, --account` flag — `src/cli.ts:1531` describes that flag verbatim as `"Operator account (used as principal.operator)"`, and `generateIdentity(name, operator, …)` (`identity.ts:82-84`) threads `--account` straight into `Principal.operator` (`identity.ts:113-116`). Every test value is an NSC account name (`OP_TEST` / `OP_LOCAL` / `OP_ATTACKER` in `test/commands/identity.test.ts`).

This `operator` is the **NSC account** — a node in the NATS `operator → account → user` trust hierarchy — **not** the cortex *principal-the-human*. It must **NOT** be renamed by myelin's `operator`→`network` rename: asserting `metafactory` where the data is `OP_TEST` would be factually wrong and would break the `importPrincipals` cross-account-overwrite security check's semantics. `Principal.operator` **stays** as part of the NSC infrastructure carve-out — no lines changed. (A future *cosmetic* rename to `Principal.nsc_account` would be defensible — it is honestly an NSC account — but it is a **config-file-format change**: `principals.json` on disk carries the `operator` key, so it would need a back-compat read window accepting both `operator` and `nsc_account` and a registry-version bump. That is explicitly **out of scope** for this vocabulary migration; if pursued it is its own follow-up issue.)

### Carve-out: `capabilities.network` — DO NOT rename (skill-manifest capability type)

`network` is also a **skill-manifest capability type** in arc — the "network-access capability" a published skill declares — and is **entirely unrelated** to the NATS network, the consumer-name segment, or the subject grammar. It is carved out and unchanged. Sites considered and intentionally excluded (~40 lines):

- **`src/types.ts`** — `network?: { domain: string; reason: string }[]` on the capabilities shape (`:91`); the `"network"` literal in the capability-`type` union `"fs_read" | "fs_write" | "network" | "bash" | "secret" | "skill_dep"` (`:572`).
- **`src/lib/manifest.ts`** — ~16 occurrences parsing/validating the `network` capability block.
- **`src/lib/publish.ts:84-110`** — `networkEntries` / `network` / `serverCaps.network` building the published capability payload.
- **`src/lib/db.ts:126-128`** — `caps.network` rows inserted into the capability table as `("network", n.domain, n.reason)`.
- **`src/commands/upgrade.ts:343`** — `caps.network` → `insertCap.run(name, "network", n.domain, n.reason)`.
- **`src/commands/audit.ts`** — capability audit reads the same `network` type.

This is "skill requests network access", not "the NATS network". Listed so a reviewer re-grepping `network` across arc sees these were considered and deliberately excluded from the vocabulary migration.

### Renames FLAGGED FOR REVIEW (not made in this draft)

- **`Principal.operator` field in `src/commands/identity.ts`** — **RESOLVED by the review loop: carved out, not renamed.** See the **Carve-out: `Principal.operator`** section above. The field is populated from the NSC `--account` flag (`cli.ts:1531` "Operator account (used as principal.operator)"; `generateIdentity` threads it at `identity.ts:82-84,113-116`; tests set it to `OP_TEST`/`OP_LOCAL`). It is an **NSC operator account**, not the cortex network — renaming it `.network` would be *wrong*. It stays unchanged. A cosmetic future `.nsc_account` rename is out of scope (config-format change; needs a `principals.json` back-compat window).
- **`Principal` type name / `PrincipalRegistryFile` / `principals.json`** in `src/commands/identity.ts` — myelin's R1 renames the `Principal` *type* → `Identity`. arc has a local, structurally-similar `Principal` interface (`identity.ts:21`). Whether arc's copy should track myelin's rename, or import myelin's type outright, is an **architecture question for the review loop**, not a mechanical rename. Deferred — no lines changed. (Note: arc's `Principal.type: "agent" | "service" | "operator"` at `identity.ts:26` carries the same `"operator"` literal myelin's R5 renamed to `"hub"`; same deferral applies.)

---

## The `--network` flag decision (A2 / A3)

`arc nats provision-streams` and `arc nats provision-consumer` take `--network <X>` + `--agent <Y>` and feed them straight into `reviewConsumerName`. Once A1 changes the template to `(stack, assistant)`, the flags that feed it must change too — a flag named `--network` that supplies the *stack* segment is a lie on the CLI surface.

**Decision (proposed — confirm in review):**

- **Rename `--network` → `--stack`.** The flag supplies the consumer name's first segment, which is now the **stack** (the durable addressing key is `(stack, assistant)` per A1). `--network` as a name is actively misleading and must not survive.
- **Rename `--agent` → `--assistant`.** Same reasoning as A3 — the durable addresses an assistant. (The template is two-segment; no third `--principal`/`--stack`-extra flag is needed — A1 corrected which two segments, it did not widen the template.)
- **No back-compat alias for `--network`. KEEP the hard break.** Rationale: `--network` fed a *wrong* segment. An alias `--network → stack` would let an operator keep typing `--network metafactory` and silently get `cortex-review-consumer-metafactory-…` — i.e. reproduce the exact defect A1 fixes. The flag fed a wrong value; an alias would *reproduce the defect*. A hard removal forces the operator to reconsider what value belongs there. The CLI is pre-1.0 surface for these subcommands (no `arc.nats.v1` schema guarantee covers *flag names*, only the `--json` payload — see `docs/integrations/cortex-creds.md:28`), so a clean break is acceptable.
- **NATS topology:** there is currently **no** separate use of `--network` for NATS leaf-node / federation topology in these commands — the flag's *only* job was the consumer-name segment. So there is nothing to "keep `--network` for". If a future federation-topology flag is needed it can be added then, cleanly named.

**Mandatory pre-flight: enumerate every external caller BEFORE the flag PR.** A hard break is only safe once you can *see* what breaks. Before opening PR-2, run an explicit enumeration and list every external caller in the PR description:

```bash
# cortex repo — bootstrap scripts, launchd plists, docs
grep -rn 'arc nats provision-streams\|arc nats provision-consumer\|--network' \
  ~/Developer/cortex/src/services/ ~/Developer/cortex/docs/ ~/Developer/cortex/scripts/ 2>/dev/null
```

Iteration-2 enumeration (run against cortex `main`): **no launchd plist or bootstrap script invokes `provision-streams`/`provision-consumer`** — cortex's `src/cli/cortex/commands/creds.ts` only shells `arc nats add-bot` / `reissue-bot` / `remove-bot`. The `--network` flag is referenced in **cortex documentation only**: `docs/design-bus-addressing.md:30, :159, :199` describe `arc nats provision-streams --network <X>`. Those doc lines must be updated in the same release window (they already flag the malformed `cortex-review-consumer-metafactory-*` shape as the defect to fix). **If the enumeration at PR-2 time finds new callers (scripts, CI fixtures), they must be listed and fixed in the same window** — the manifest must not assert "automation updates in the same window" without naming the automation.

**One-release error-with-guidance shim (NOT back-compat).** PR-2 adds a `commander` `.action`-level (or arg pre-check) detector: if the legacy `--network` token is present on `provision-streams`/`provision-consumer`, the command **exits non-zero with a clear message** rather than silently doing the wrong thing:

```
error: `--network` was renamed to `--stack` (and `--agent` to `--assistant`).
       The old flag fed a wrong value into the durable name. See CHANGELOG.md.
```

This is a **loud failure**, not an alias — it never produces a durable name; it refuses and instructs. It ships for one release, then is removed. `commander` strips unknown options before `.action`, so the detector reads `process.argv` (or uses `.allowUnknownOption(false)` plus a `--network`-specific pre-parse) to catch the legacy token explicitly.

**FOR REVIEW:** confirm (a) hard-removal + one-release error-shim vs a longer shim window, (b) `--assistant` vs keeping `--agent` as the flag name even though the segment is the assistant (the manifest recommends `--assistant` for consistency with the wire vocabulary).

---

## Per-file changes

### `src/lib/jetstream.ts` — the consumer-name source of truth (A1, A4, A5 — A4 lines split to PR-1b, see PR ordering)

**Land this file first.** `reviewConsumerName` is the single point where the durable name is constructed; `src/commands/jetstream.ts` calls it. Changing the template here changes every derived name by construction.

- **A1 — the template function** (the load-bearing change — stays a **2-arg, 2-segment** template):
  - L246 `export function reviewConsumerName(network: string, agent: string): string {` → `export function reviewConsumerName(stack: string, assistant: string): string {`
  - L247 `  return \`cortex-review-consumer-${network}-${agent}\`;` → `  return \`cortex-review-consumer-${stack}-${assistant}\`;`
- **A1 — doc comments naming the old shape:**
  - L12 ` * provisioning of CODE_REVIEW stream + \`cortex-review-consumer-<network>-<agent>\`` → `cortex-review-consumer-<stack>-<assistant>`
  - L180 ` * \`cortex-review-consumer-<network>-<agent>\` — pilot operators picking` → `cortex-review-consumer-<stack>-<assistant>` — **also A5/A6 prose**: "pilot operators" here means the humans running pilot → "pilot **principals**" (A6a — see prose table).
  - L181 ` * sage/echo per-network land on distinct durables.` → `sage/echo per-(stack, assistant) land on distinct durables.`
  - L237 ` * Derive the canonical cortex review-consumer durable name from network +` → `… from stack +`
  - L238 ` * agent. Centralises the format so pilot's reference to` → `assistant. Centralises …`
  - L239 ` * \`cortex-review-consumer-metafactory-echo\` in the P-VERIFY handover and` — **the malformed exemplar.** `metafactory` is the network, not a stack. Rewrite to a correct example: `cortex-review-consumer-meta-factory-echo` (stack `meta-factory`, assistant `echo`). Add a half-sentence: "the historical `…-metafactory-echo` form was malformed — `metafactory` is the network, never an addressing segment; the agent is addressed by `(stack, assistant)`."
  - L242 ` * Format: \`cortex-review-consumer-<network>-<agent>\`. Both segments must` → `Format: \`cortex-review-consumer-<stack>-<assistant>\`. Both segments must`
- **A4 — `{org}` subject-grammar tokens in comments (C2 — fix the grammar, not just the token):**
  - L40 ` * Broadcast grammar \`local.{org}.{stack?}.tasks.code-review.{flavor}\` so` → `local.{principal}.{stack}.tasks.code-review.{flavor}` — **two corrections, not one:** (1) `{org}`→`{principal}` (the vocab rename), **and** (2) **drop the `?` on `{stack?}`**. The canonical subject grammar is `{scope}.{principal}.{stack}.{domain}.{entity}.{action}` — **6 mandatory segments** (`cortex/CONTEXT.md:40`; myelin owns the grammar). **`stack` is mandatory** (`cortex/CONTEXT.md:16` — every stack has its own subject sub-namespace; `:30` the second segment is `local.{principal}.{stack}.…`). The `{stack?}` optional marker in the original comment is simply **wrong** and must not survive the rename. Result: `local.{principal}.{stack}.tasks.code-review.{flavor}` (6 segments, all mandatory). **NB:** "Broadcast grammar" — `Broadcast` is myelin's R11 / cortex-Q13 dispatch-mode rename to `Offer`. arc only references it in prose; align: "Offer grammar". Flag in A6/cross-ref to myelin R11.
  - L41 ` * the sage subscription \`local.{org}.{stack}.tasks.code-review.>\` lands` → `local.{principal}.{stack}.tasks.code-review.>` — already mandatory-`{stack}` here; only `{org}`→`{principal}`.
- **A4 — stream-subject wildcard verification (`jetstream.ts:55-58`):** `CODE_REVIEW_STREAM_SUBJECTS` is `["local.*.tasks.code-review.>", "local.*.*.tasks.code-review.>"]`. Against the **fixed-6-segment** grammar `{scope}.{principal}.{stack}.{domain}.{entity}.{action}`, the canonical review subject is `local.{principal}.{stack}.tasks.code-review.{flavor}` = exactly 6 segments. The second wildcard `local.*.*.tasks.code-review.>` matches this: `local` + `*`(principal) + `*`(stack) + `tasks` + `code-review` + `>`(≥1 flavor segment) = 6+. The **first** wildcard `local.*.tasks.code-review.>` is a **5-segment-minimum** pattern — it only matches subjects with the stack segment *absent*, which the fixed grammar never produces. It is a **vestige of the now-deleted `{stack?}` optional-stack assumption**. Recommendation: **note in PR-1 that the first wildcard is dead under the fixed grammar** and either (a) drop it, or (b) keep it as defensive width but comment it as "matches no canonical subject — stack is mandatory; retained only to catch malformed publishers". This is a comment/const observation, not a vocab rename; flag it for the reviewer rather than silently editing the subject list.
- **A5/A6a — `operator` prose meaning the human/deployment-owner:**
  - L13 ` * durable was operator-manual. New operators hit silent timeouts because` → "durable was **principal**-manual. New **principals** hit silent timeouts …"
  - L48 ` * span every operator-id, every stack, and every code-review flavor so` → "span every **principal**, every stack, and every code-review flavor …" (the wildcard set spans principals — the subject's second segment).
  - L66 ` * operator logs surface the difference for "did I actually fix it" diagnosis.` → "**principal** logs surface the difference …"
  - L78 ` * verb invoked deliberately by the operator).` → "… deliberately by the **principal**)."
  - L133 ` * We default to leave-existing-alone — the operator changes config via` → "… the **principal** changes config via …"

### `src/commands/jetstream.ts` — the consumer-name callers (A1, A2/A3, A4, A5)

`provisionStreams` / `provisionConsumer` / `provisionConsumerInternal` thread the `(network, agent)` pair into `reviewConsumerName`. Every parameter, field, and comment on that path renames — but **the arity stays 2** (`(stack, assistant)`); no new parameter is added.

- **A1/A2/A3 — `ProvisionStreamsOpts.consumer`:**
  - L62 ` /** When true, \`addPerNetworkConsumer\` is also invoked for the given (network, agent) pair. */` → `… for the given (stack, assistant) pair. */` — note `addPerNetworkConsumer` is a *stale name in prose* (no such function exists; the real path is `provisionConsumerInternal`). Rewrite to: "When set, a per-(stack, assistant) consumer is also provisioned."
  - L63 ` consumer?: { network: string; agent: string };` → `consumer?: { stack: string; assistant: string };`
- **A1 — `provisionStreams` doc + call:**
  - L69 ` * Provision the CODE_REVIEW stream and optionally a per-(network, agent)` → `… per-(stack, assistant)`
  - L115 `        opts.consumer.network,` → `opts.consumer.stack,`
  - L116 `        opts.consumer.agent,` → `opts.consumer.assistant,`
- **A1/A2/A3 — `ProvisionConsumerOpts`:**
  - L134 ` /** Network segment of the consumer name (\`cortex-review-consumer-<network>-<agent>\`). */` → ` /** Stack segment of the consumer name (\`cortex-review-consumer-<stack>-<assistant>\`). */`
  - L135 ` network: string;` → ` stack: string;`
  - L136 ` /** Agent segment of the consumer name. */` → ` /** Assistant segment of the consumer name. */`
  - L137 ` agent: string;` → ` assistant: string;`
- **A1 — `provisionConsumer` doc + call:**
  - L145 ` * Provision a single per-(network, agent) durable consumer on an existing` → `… per-(stack, assistant) durable consumer …`
  - L169 `      opts.network,` → `opts.stack,`
  - L170 `      opts.agent,` → `opts.assistant,`
- **A1 — `provisionConsumerInternal`:**
  - L186-191 signature `async function provisionConsumerInternal(jsm, stream, network: string, agent: string, filterSubject?: string)` → `(jsm, stream, stack: string, assistant: string, filterSubject?: string)`
  - L193 `  const durable = reviewConsumerName(network, agent);` → `reviewConsumerName(stack, assistant);`
  - **I4 (observed, out of vocab scope — note it):** `provisionConsumerInternal` casts `ack_policy: "explicit" as ConsumerAckPolicy` at `jetstream.ts:197`, where `type ConsumerAckPolicy = "explicit"` is declared *later* in the file at `jetstream.ts:219`. PR-1 changes `provisionConsumerInternal`'s signature (drops the `network` param, renames to `stack`/`assistant`) but **must not touch the `ack_policy` cast or the late type declaration** — that forward-reference works today and is unrelated to vocabulary. Do not regress it while editing the signature.
- **A5/A6a — `operator` prose:**
  - L7 ` * those three layers make a fresh-operator install reach a state where` → "… make a fresh-**principal** install reach a state where" (a fresh install by a principal).
  - L12 ` *   - First-install: run after broker comes up to create CODE_REVIEW + per-agent durables` → "per-**assistant** durables" (the durable is the assistant's; A3 vocabulary).

### `src/cli.ts` — the operator-facing flags (A2, A3)

The `provision-streams` and `provision-consumer` subcommands. Every `--network` / `--agent` flag, its description, its options-object type, and the paired-flag validation rename. Per the flag decision: `--network`→`--stack`, `--agent`→`--assistant`. **No third flag is added** — the durable template is 2-segment `(stack, assistant)`. The paired-flag all-or-none guard stays a **2-flag** guard.

- **`provision-streams` (L1452–1487):**
  - L1456 `  .option("--network <network>", "Network segment of the consumer name (with --agent)")` → `.option("--stack <stack>", "Stack segment of the consumer name (with --assistant)")`
  - L1457 `  .option("--agent <agent>", "Agent segment of the consumer name (with --network)")` → `.option("--assistant <assistant>", "Assistant segment of the consumer name (with --stack)")`
  - L1459 action type `{ natsUrl?: string; stream?: string; network?: string; agent?: string; json?: boolean }` → `{ …; stack?: string; assistant?: string; json?: boolean }`
  - L1460 `if ((opts.network && !opts.agent) || (!opts.network && opts.agent)) {` → the all-or-none guard stays **2-flag**, only the names change: `if ((opts.stack && !opts.assistant) || (!opts.stack && opts.assistant)) {`
  - L1461 `const msg = "--network and --agent must be supplied together";` → `"--stack and --assistant must be supplied together";`
  - L1472 `...(opts.network && opts.agent && { consumer: { network: opts.network, agent: opts.agent } }),` → `...(opts.stack && opts.assistant && { consumer: { stack: opts.stack, assistant: opts.assistant } }),`
  - **add** the `--network` legacy-flag detector (error-with-guidance shim — see flag decision): a pre-`.action` check that exits non-zero with the rename message if `--network` is present.
- **`provision-consumer` (L1490–1520):**
  - L1491 `  .description("Idempotently create a per-(network, agent) durable consumer on the CODE_REVIEW stream")` → `… per-(stack, assistant) durable consumer …`
  - L1492 `  .requiredOption("--network <network>", "Network segment of the consumer name")` → `.requiredOption("--stack <stack>", "Stack segment of the consumer name")`
  - L1493 `  .requiredOption("--agent <agent>", "Agent segment of the consumer name")` → `.requiredOption("--assistant <assistant>", "Assistant segment of the consumer name")`
  - L1498-1502 action type `{ network: string; agent: string; natsUrl?: string; … }` → `{ stack: string; assistant: string; natsUrl?: string; … }`
  - L1503-1505 `const callOpts = { network: opts.network, agent: opts.agent, … }` → `{ stack: opts.stack, assistant: opts.assistant, … }`
  - **add** the same `--network` legacy-flag error-with-guidance shim.

> **I3 — caller register completeness.** Every consumer-name-template caller and every `--network`-flag site is enumerated above: `reviewConsumerName` is called only by `provisionConsumerInternal` (`commands/jetstream.ts:193`), reached via `provisionStreams` (`:112`) and `provisionConsumer` (`:166`). The `--network`/`--agent` flag sites are exactly `cli.ts:1456,1457,1460,1461,1472` (`provision-streams`) and `cli.ts:1492,1493,1498-1505` (`provision-consumer`). `grep -n 'opts.network\|opts.agent\|--network\|--agent' src/cli.ts` and `grep -rn 'reviewConsumerName' src/` at PR time must return exactly this set — if either grep finds a site not listed here, the register is incomplete and the PR is blocked until it is reconciled.

### `test/unit/jetstream.test.ts` — consumer-name + orchestrator tests (A1)

Every `reviewConsumerName` call, every `provisionStreams`/`provisionConsumer` `consumer:`/option object, and every expected durable string. The expected strings **stay 2-segment** — the fix is *which two segments*, so `cortex-review-consumer-<stack>-<assistant>`.

- **`reviewConsumerName` describe block:**
  - L49 `test("composes the canonical cortex-review-consumer-<network>-<agent> format", …)` → `… <stack>-<assistant> format`
  - L50 `expect(reviewConsumerName("metafactory", "echo")).toBe("cortex-review-consumer-metafactory-echo");` → `expect(reviewConsumerName("meta-factory", "echo")).toBe("cortex-review-consumer-meta-factory-echo");` — **NB: replace the `metafactory`-first-segment fixture with a correct `(stack, assistant)` pair.** This test currently *encodes the bug as the expected behaviour* (a `metafactory` network token in the addressing slot); it must be rewritten, not just re-typed. The stack is `meta-factory` (a stack name), not `metafactory` (the network).
  - L51 `expect(reviewConsumerName("local", "sage")).toBe("cortex-review-consumer-local-sage");` → `expect(reviewConsumerName("work", "sage")).toBe("cortex-review-consumer-work-sage");` — first arg is a *stack* name (`work`), not the `local` scope token.
- **`ensureConsumer` durable fixtures** — L115, L119, L131 use `"cortex-review-consumer-net-echo"`. These exercise `ensureConsumer` directly (a generic durable-name passthrough — not derived via `reviewConsumerName`), so they are not strictly part of A1. **Recommend** updating the literal to a well-formed `cortex-review-consumer-meta-factory-echo` for consistency so no reader copies the malformed `-net-echo` shape. Low-risk cosmetic; flag in review.
- **`provisionStreams orchestrator`:**
  - L148 `test("happy path: stream + per-(network, agent) consumer both created", …)` → `… per-(stack, assistant) consumer …`
  - L152 `consumer: { network: "metafactory", agent: "echo" },` → `consumer: { stack: "meta-factory", assistant: "echo" },`
  - L159 `name: "cortex-review-consumer-metafactory-echo",` → `name: "cortex-review-consumer-meta-factory-echo",`
  - L172 `consumer: { network: "metafactory", agent: "echo" },` → `consumer: { stack: "meta-factory", assistant: "echo" },`
  - L178 `test("no consumer when caller omits the {network, agent} pair", …)` → `… omits the {stack, assistant} pair`
- **`provisionConsumer orchestrator`:**
  - L219 `test("derives the canonical durable name from (network, agent)", …)` → `… from (stack, assistant)`
  - L229-230 `network: "metafactory", agent: "echo",` → `stack: "meta-factory", assistant: "echo",`
  - L233 `expect(capturedDurable).toBe("cortex-review-consumer-metafactory-echo");` → `… "cortex-review-consumer-meta-factory-echo"`
  - L234 `expect(r.resource.name).toBe("cortex-review-consumer-metafactory-echo");` → same new string
  - L248-249 `network: "net-a", agent: "echo",` → `stack: "meta-factory", assistant: "echo",`

### `src/lib/source-resolver.ts` — `org` — NO CHANGE (carve-out)

`org` appears at L10, L11, L44, L47, L53, L57, L61, L73, L74, L83, L86, L91, L95, L99, L111, L112 — every one is a **GitHub URL path segment** (`https://github.com/{org}/{repo}`). GitHub's `org` is a real, correct term for a GitHub organisation; it is **not** the cortex `{org}` subject token. **No change.** Same for `org` in `src/commands/catalog.ts:319,354,594,745`, `src/lib/artifact-installer.ts:347`, and `org?: string` on the `Source` type (`src/types.ts:72`) — all GitHub-org metadata. Listed here so a reviewer sees they were considered and deliberately excluded.

---

## RESOLVED (iteration 2): the `Principal.operator` field (`src/commands/identity.ts`)

> **Iteration-2 resolution: carve it out — DO NOT rename.** The review loop resolved this previously-ambiguous cluster. `Principal.operator` is an **NSC operator account** (NATS trust hierarchy), not the cortex *principal-the-human*; it must NOT be touched by myelin's `operator`→`network` rename. See the **Carve-out: `Principal.operator`** paragraph in the carve-out section above for the binding decision. The detail below is retained as the evidence base. **No lines are changed.** A cosmetic future `.nsc_account` rename is out of scope (config-format change requiring a `principals.json` back-compat window).

The facts:

- `src/commands/identity.ts:21-29` defines a local `Principal` interface with `operator: string;` (L24) and `type: "agent" | "service" | "operator"` (L26).
- `arc identity generate` populates `Principal.operator` from the `-a, --account` flag — `src/cli.ts:1531` describes it verbatim as `"Operator account (used as principal.operator)"`.
- Tests confirm the values are NSC account names: `OP_TEST` (`identity.test.ts:46,55`), `OP_LOCAL` / `OP_ATTACKER` (`:105,110,118`), `OP_OTHER` (`:127`), `"OP"` (`:143`).
- `loadRegistry` validates it (`identity.ts:55` `principals[${index}].operator: required`) and `importPrincipals` uses it for a security check (`:214-219` cross-operator key-overwrite rejection).

**Why this is NOT a mechanical `operator → network` rename:**

- myelin's manifest renames `Identity.operator → .network` because in myelin that field held *the org that runs the hub*. arc's field holds an **NSC operator account** — `OP_TEST`, an NATS trust-hierarchy node. Renaming it `.network` would assert "metafactory" where the data is "OP_TEST". That is factually wrong and would break the `importPrincipals` security check's semantics.
- The cross-operator-overwrite test (`identity.test.ts:103` "rejects cross-operator key overwrite") is an **NSC-account** security boundary. It belongs to the NSC carve-out.

**Options for the review loop:**

1. **Rename `Principal.operator → Principal.nsc_account`** (and `type: "operator"` literal review separately). Most honest: the field *is* an NSC account. Touches `identity.ts` (interface + validator + 4 prose uses), `identity.test.ts` (6 uses), `cli.ts:1531`. This is a **config-file-format change** — `principals.json` on disk carries the `operator` key; a rename needs a back-compat read window (accept both `operator` and `nsc_account`, emit only the new key, bump a registry version).
2. **Leave `Principal.operator` unchanged**, treat it as part of the NSC carve-out, and only document the distinction. Cheapest; defensible since it genuinely is NSC vocabulary.
3. **Adopt myelin's `Identity` type wholesale** — delete arc's local `Principal` and import `Identity` from the myelin package. Largest change; correct long-term; depends on myelin's R1 landing first and on whether myelin's `Identity` models an NSC account at all (it does not — myelin's `.network` ≠ NSC account). Likely *rejected* on that mismatch.

**Manifest recommendation:** option 1 or 2 — **not** option 3, and **never** `operator → network` here. Carried to the review loop as the headline open question. The same deferral covers the `Principal` type-name rename and the `type: "operator"` string literal (`identity.ts:26,56`, `identity.test.ts` `type: "agent"` fixtures are unaffected).

---

## `operator` prose — the A6 line-by-line resolution

Every `operator` occurrence in arc, classified. **A6a** = mechanically resolved here. **A6b** = deferred. **NSC** = carve-out, no change.

### A6a — resolved to `principal` (the human / deployment-owner)

| File:Line | Old fragment | New |
|---|---|---|
| `src/lib/jetstream.ts:13` | "durable was operator-manual. New operators hit…" | "principal-manual. New principals hit…" |
| `src/lib/jetstream.ts:48` | "span every operator-id, every stack…" | "span every principal, every stack…" |
| `src/lib/jetstream.ts:66` | "operator logs surface the difference…" | "principal logs surface…" |
| `src/lib/jetstream.ts:78` | "verb invoked deliberately by the operator)." | "…by the principal)." |
| `src/lib/jetstream.ts:133` | "the operator changes config via…" | "the principal changes config via…" |
| `src/lib/jetstream.ts:180` | "pilot operators picking sage/echo…" | "pilot principals picking sage/echo…" |
| `src/commands/jetstream.ts:7` | "make a fresh-operator install reach…" | "make a fresh-principal install reach…" |
| `src/lib/symlinks.ts:29` | "operator-owned state, so install must too." | "principal-owned state…" |
| `src/commands/init.ts:61` | "silent clobber of operator content" | "…of principal content" |
| `src/commands/init.ts:84` | "arc never overwrites operator [content]" | "arc never overwrites principal [content]" |
| `docs/agents-md/core-concepts.md:17` | "operator intent wins over auto-bootstrap." | "principal intent wins…" |
| `src/types.ts:230` | "surprise operators with custom install paths" | "surprise principals with custom install paths" |
| `src/types.ts:232` | "of overriding operator intent." | "of overriding principal intent." |
| `src/types.ts:365` | "the install chain — not the operator — is…" | "…not the principal…" |
| `src/lib/nats-broker.ts:18` | "that would need root and surprise operators…" | "…surprise principals…" |
| `src/lib/nats-broker.ts:21` | "The operator [must resolve]…" | "The principal…" |
| `src/lib/nats-broker.ts:116` | "operator-supplied URLs with embedded credentials" | "principal-supplied URLs…" |
| `src/lib/nats-broker.ts:172` | "Operators piping stderr into log [files]…" | "Principals piping stderr…" |
| `src/lib/nats-broker.ts:207` | "True when NATS_URL was set… (operator-specified remote)." | "(principal-specified remote)." |
| `src/lib/nats-broker.ts:383` | "operators who keep nats-server in a non-package location" | "principals who keep nats-server…" |
| `src/lib/nats-broker.ts:414` | "operators that install via the OS package" | "principals that install via the OS package" |
| `src/lib/hosts/darwin-launchd.ts:22` | "operator runbook tools on a server" | "principal runbook tools…" |
| `src/lib/hosts/cortex.ts:25` | "Operators on a fresh install" | "Principals on a fresh install" |
| `src/commands/remove.ts:61` | "the operator can investigate and retry." | "the principal can investigate…" |
| `src/commands/remove.ts:96` | "surfaced to the operator [as warnings]" | "surfaced to the principal" |
| `src/commands/remove.ts:175` | "the operator can clean up manually." | "the principal can clean up…" |
| `src/commands/remove.ts:402` | "operator may have replaced an arc-installed file" | "principal may have replaced…" |
| `src/commands/remove.ts:456` | "surfaced via a console warning so an operator who has…" | "…so a principal who has…" |
| `src/commands/remove.ts:474` | "leave it for the operator to inspect" | "leave it for the principal to inspect" |
| `src/commands/install.ts:856` | "so an operator on macOS doesn't see…" | "so a principal on macOS…" |
| `src/commands/upgrade.ts:208` | "operator sees both. Without preHeadSha…" | "principal sees both…" |
| `src/commands/catalog.ts:32` | "drift there reflects real operator intent." | "…real principal intent." |
| `src/commands/catalog.ts:549` | "which would clobber operator state." | "…clobber principal state." |
| `src/lib/registry-install.ts:196` | "the reason field is operator-typed text on the other side" | **A6b — see below** |

### A6b — deferred (genuinely ambiguous)

| File:Line | Fragment | Why deferred |
|---|---|---|
| `src/lib/registry-install.ts:196` | "the marketplace `reason` field is operator-typed text on the other side" | "operator" here = whoever *authored the marketplace listing* — could be a third-party publisher, not the local principal. Not clearly the human-who-runs-arc. Needs a grill: is "marketplace operator" a `principal`, a `publisher`, or its own term? |
| `src/lib/registry-install.ts:202` | "the other end is the marketplace operator — the operator can be compromised" | Same "marketplace operator" concept — the *adversary model* names a remote party. Renaming to `principal` would wrongly imply the local human. Deferred with `registry-install.ts:196`. |

### NSC — no change (carve-out, listed for completeness)

`src/lib/json-response.ts:29`; `src/cli.ts:1336,1373,1394,1395`; `src/commands/nats.ts:4,5,255,551,557,563,566,567,571,573,615,616,646`; `src/lib/json-response.ts:102,110,112,149`; `docs/integrations/cortex-creds.md:14,34,55,57,61,133,152,153,172,175`; `test/commands/identity.test.ts` `OP_*` values. All NSC operator-account terminology. Plus `src/lib/hooks.ts:169` ("shell redirect/pipe operator") — that is a *programming-language operator*, unrelated to either sense; no change.

---

## Risk tiers

**Tier 1 — internal / prose only.** Comment + doc-string text. No wire, no API, no persisted format. Safe in a single PR, validated by `tsc` + `bun test` (tests only fail if a renamed *identifier* leaked — pure prose cannot break the build). Covers: A4, A5, A6a.

**Tier 3 — operator-facing CLI + persisted broker state.** A1, A2, A3. Two compounding reasons this is the top tier despite being a "small" repo:

1. **Durable consumer names are persisted broker state.** A JetStream durable created as `cortex-review-consumer-metafactory-echo` does **not** rename itself when arc's template changes. After the A1 PR ships, `arc nats provision-consumer` will create `cortex-review-consumer-meta-factory-echo` — a *different, new* durable (the corrected 2-segment `(stack, assistant)` form: stack `meta-factory`, assistant `echo`). The old malformed durable lingers, still bound to its filter subject, still accumulating acks. See the operational step below.
2. **`--network` is operator muscle-memory.** Operators and any scripts/runbooks calling `arc nats provision-streams --network … --agent …` break the moment A2/A3 land. This is a deliberate break (the flag fed a wrong value) but it is a break — `CHANGELOG.md` and the PR body must headline it.

There is **no Tier 2** in arc: there is no envelope-schema or shared-wire-payload change here (those all live in the myelin manifest). The `principals.json` config-format question is contained inside the deferred `Principal.operator` cluster — if the review loop chooses to rename that field it becomes a Tier-2 change *at that point*, handled by that follow-up.

---

## PR ordering

Small repo — strictly ordered. The hard review split PR-1 to keep the defect fix off the myelin cross-dependency.

1. **PR-1 — A1 + A5 + the C2 mandatory-segment correction (jetstream cluster).** `src/lib/jetstream.ts` + `src/commands/jetstream.ts` + `test/unit/jetstream.test.ts`. The template rename (`network`→`stack`, `agent`→`assistant`, **stays 2-segment**), its one caller path, its tests, and the C2 `{stack?}`→`{stack}` optional-marker correction (arc-internal, no myelin dependency). Plus `operator`→`principal` prose *within those two files only* (A5 lines local to jetstream). Landed atomically so `bun test` stays green. This PR makes `reviewConsumerName` correct.
   - **Does NOT ship** the `{org}`→`{principal}` token spelling or `Broadcast`→`Offer` (those are myelin-owned — see PR-1b).
   - **Blocks PR-2:** the CLI flags must feed the renamed 2-arg `reviewConsumerName`; PR-2's option-object types depend on PR-1's signature.
1b. **PR-1b — A4 (`{org}`→`{principal}` + `Broadcast`→`Offer` comment edits).** `src/lib/jetstream.ts` comments only. **Gated on the myelin manifest's grammar merge** — must not land before myelin defines `{principal}` and `Offer`. Small, prose-only, can land any time after the myelin dependency is satisfied.
2. **PR-2 — A2 + A3 (CLI flags).** `src/cli.ts` only. Rename `--network`→`--stack`, `--agent`→`--assistant` (**2 flags, no `--stack`-extra**), keep the 2-flag all-or-none guard, add the one-release `--network` error-with-guidance shim. `CHANGELOG.md` entry under `### Changed` headlining the flag break. Pre-flight caller enumeration (see flag decision) in the PR body. Depends on PR-1.
3. **PR-3 — A6a (remaining `operator` prose).** Every A6a line *outside* the jetstream files — `nats-broker.ts`, `remove.ts`, `install.ts`, `upgrade.ts`, `catalog.ts`, `symlinks.ts`, `init.ts`, `types.ts`, `hosts/*.ts`, `core-concepts.md`. Pure-prose, independent, can land any time after PR-1 (no ordering constraint with PR-2; sequenced last only to keep review small).

**Deferred — not in this manifest's PR set:** the `Principal.operator` cluster (FOR REVIEW section) and the A6b marketplace-operator lines. Each becomes its own follow-up issue once the review loop decides.

---

## Roll-out

1. **PR-1 merges.** `reviewConsumerName` now emits `cortex-review-consumer-{stack}-{assistant}` (2-segment — see C1). No live broker is touched yet — arc only *constructs* names; it does not rename existing durables.
2. **Operational step — re-provision the malformed durables (REQUIRED, manual).** Any broker that already has `cortex-review-consumer-metafactory-*` durables (created by the pre-fix arc, cited in the P-VERIFY handover as `cortex-review-consumer-metafactory-echo`) carries **orphaned, malformed** durables after PR-1. They will not self-heal. For each affected broker/account:
   - **Enumerate:** `nats consumer ls CODE_REVIEW` (or `nats stream view`) and identify every malformed durable. **Operator grep predicate:** any durable whose stack or assistant slot holds a *network* token is malformed by definition — concretely, `nats consumer ls CODE_REVIEW | grep -E 'cortex-review-consumer-(metafactory|meta-factory-prod-network|.*-network-)'`; the canonical defect signature is the literal `cortex-review-consumer-metafactory-*`. A name is well-formed only if both segments are `(stack, assistant)` values — a network name (`metafactory`) in either slot means re-provision.
   - **Re-provision the correct durable:** `arc nats provision-consumer --stack <stack> --assistant <assistant>` (post-PR-2 flag names — 2 flags, no `--principal`).
   - **Verify the new durable is draining BEFORE deleting the stale one (I2 — REQUIRED gate):** run `nats consumer info CODE_REVIEW <new-name>` and confirm the new durable is actually consuming — `num_pending` drawing down and/or `num_ack_pending` advancing across two successive `info` calls. **Only once the new durable demonstrably has the message flow** proceed to deletion. This is a hard precondition, not a courtesy check.
   - **Cut over consumers**, then delete the stale durable: `nats consumer rm CODE_REVIEW cortex-review-consumer-metafactory-echo`. Do **not** delete before the new durable is consuming — JetStream redelivers un-acked messages, and dropping the old durable mid-flight loses in-flight review tasks. The `nats consumer info` check above is exactly the gate that proves the new durable is ready to take over.
   - This step is a runbook item, not code — add it to the cortex/pilot deployment SOP and the PR-1 description. It is the arc analogue of the myelin manifest's schema-cutover discipline.
3. **PR-2 merges.** CLI flags cut over. Announce in the release notes: `arc nats provision-* --network` is **removed**; use `--stack --assistant` (2 flags). The one-release error-with-guidance shim ships in this PR (legacy `--network` exits non-zero with the rename message). **Pre-flight (mandatory, before opening PR-2):** run the caller-enumeration `grep` from the flag-decision section against cortex `main`. Iteration-2 result: no plist/script caller; the only external references are `cortex/docs/design-bus-addressing.md:30,159,199` (documentation) — update those in the same window. If the PR-2-time enumeration finds new callers, list and fix them in the PR.
4. **PR-3 merges.** Prose-only; no roll-out action.
5. **Follow-up grills** (post-manifest): the `Principal.operator` field decision, the `Principal` type-name question, and the A6b marketplace-operator lines. Each lands as its own issue + PR with its own (possibly Tier-2) discipline.

### Cross-manifest consistency

arc consumes the subject grammar myelin owns. Two alignment points the review loop must check against the myelin manifest:

- **`Broadcast`/`broadcast` → `Offer`/`offer`** (myelin R11). arc references "Broadcast grammar" only in a `jetstream.ts:40` comment — fixed under A4's note. arc has no `broadcast` *enum value* (that is myelin's). If myelin's R11 changes the dispatch-mode vocabulary, arc's one prose mention must match.
- **`{org}` → `{principal}`** (myelin grammar / cortex-Q3). arc's A4 changes arc's *comments*; myelin owns the *grammar definition*. These must land describing the same token shape.

No arc PR should merge a grammar-token spelling that contradicts the myelin manifest at its merge commit.

> **Cross-manifest timing — A4 must land AFTER myelin's grammar merges.** A4 rewrites a comment to `local.{principal}.{stack}.tasks.code-review.{flavor}` and aligns "Broadcast grammar" → "Offer grammar". Both tokens are **owned by myelin**: `{org}`→`{principal}` is myelin's grammar rename, and `Broadcast`→`Offer` is myelin R11. If A4's prose ships *before* myelin's grammar merges, PR-1 carries a token spelling that does not yet exist upstream — a stale token in a "deterministic ground truth" manifest. **Resolution:** sequence the A4 comment edits to land **after** myelin's `{org}`→`{principal}` and `Broadcast`→`Offer` are merged. Because PR-1 (the jetstream cluster) is otherwise the *defect fix* and should not be gated on a cosmetic myelin dependency, the recommended split is: **PR-1 ships A1 + A5 (the durable-template defect fix + jetstream-local `operator`→`principal` prose) and the C2 `{stack?}`→`{stack}` mandatory-segment correction** (that correction is arc-internal — it does not depend on myelin); the **A4 `{org}`→`{principal}` / `Broadcast`→`Offer` comment edits split into a small follow-up PR (PR-1b) gated on the myelin merge.** PR-1 must not ship the `{principal}` *token spelling* in a comment until myelin has defined it. This keeps the defect fix unblocked while preventing a stale-token merge.
