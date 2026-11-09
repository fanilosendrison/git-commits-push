---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "directive"
name: "git-commits-push-agent-directives"
version: "3.5.2"
status: "Active"
summary: "Architecture, safety, and validation directives for contributors to git-commits-push."
domain: "git-commits-push"
severity: "strict"
---

# git-commits-push contributor directives

## Mission

`git-commits-push` operates on exactly the invocation worktree, validates it,
asks an LLM for Conventional Commit plans, commits exact file groups, and
pushes them. Turnlock
owns one pass's durable phase workflow. The public launcher owns reconciliation
reconciliation across concurrent invocations.

## Repository boundary

This repository owns the complete runtime, its private workspace packages,
tests, documentation, build, and CI. The harness repository owns only the
`SKILL.md` discovery manifest and its enforcement adapters. Do not move runtime
code back into the manifest directory.

`packages/node-runtime/` owns reusable process and asset infrastructure.
`packages/trust/` is the canonical one-shot guardrail-permit protocol. It is not
a security boundary against arbitrary code running as the same OS user.
Harnesses consume a pinned packed artifact of the trust package; never duplicate
its constants or validation rules in a harness repository.

## Engineering work tracking

- Apply the shared GitHub Engineering Projects operational protocol for generic
  Issue and Project operations.
- Use
  [`docs/repository-governance/git-commits-push-engineering.md`](docs/repository-governance/git-commits-push-engineering.md)
  for this repository's Project coordinates, fields, views, and workflow policy.
- Resolve an unqualified `Issue #N` as
  `fanilosendrison/git-commits-push#N`.
- Track durable future work in git-commits-push Engineering and its associated
  GitHub Issues.
- Revalidate every Issue and finding against current authoritative repository
  sources before implementation.
- Never use a Project status transition or Issue closure as a substitute for
  repository validation or installed-release verification.

## Runtime architecture

The production path is:

```text
~/.local/bin/git-commits-push
  -> XDG current release/bin/git-commits-push.mjs
  -> compiled git-commits-push entrypoint
  -> SQLite reconciliation admission and ownership
  -> paused execution controller + durable execution registration
  -> compiled node-supervisor
  -> Turnlock orchestrator + LLM bridge
  -> discovery, commit/push, and reporting phases
```

Responsibilities MUST remain separated:

- `bin/git-commits-push.mjs` performs only the Node version gate and imports the
  compiled entrypoint relative to its immutable release.
- `src/entrypoints/git-commits-push.ts` and
  `src/modules/reconciliation/public-launcher.ts` own lifecycle-wide signal
  cancellation, legacy-state inspection, owner heartbeat, reconciliation pass
  scheduling, and graceful release.
- `scripts/start-node.mjs` is a source-only development launcher. It builds once
  and delegates to the same compiled production entrypoint; production must not
  invoke it.
- `src/modules/installation/` owns content-addressed deployment, release-tree
  validation, installer locking, and atomic `current` activation. Installed
  releases are immutable and MUST NOT be automatically garbage-collected while
  compatible historical Turnlock runs may reference absolute entrypoints.
  Legacy-global cutover revokes run paths, never release-tree content.
- `src/modules/reconciliation/` is the sole authority for SQLite schema,
  generation transitions, active-execution recovery, and token fencing.
- `src/entrypoints/execution-controller.ts` is the inert-until-START POSIX
  session/process-group leader. It owns parent-disconnect response and the
  externally fenceable boundary for one pass.
- `src/entrypoints/node-supervisor.ts` owns producer/consumer protocol routing,
  direct-stage shutdown, and bounded transport buffering. Its stages inherit
  the controller's process group rather than creating independent groups.
- `src/entrypoints/turnlock-orchestrator.ts` owns Turnlock phases and snapshots.
- `src/entrypoints/turnlock-to-llm-bridge.ts` owns delegation handling and result
  writes; provider dispatch belongs in `src/modules/llm/`.
- `src/phases/` coordinates domain modules. Keep phase entrypoints below 400
  lines by extracting cohesive policies into `src/modules/`.

JavaScript entrypoints are narrow bootstrap or compatibility shims only. New
runtime behavior belongs in TypeScript modules.

## Invocation scope

- Each Turnlock run carries one durable `InvocationScope`.
- The fresh default scope is the exact current worktree: the canonical Git
  top-level containing the original invocation directory. Nested invocation
  directories resolve to that top-level, and the scope never widens into
  recursive, sibling, linked-worktree, or common-dir discovery.
- The ordinary worktree scope requires an attached symbolic branch and fails
  closed on detached HEAD; it never falls back to `searchPaths`.
- Legacy `global` scope exists only for persisted Turnlock-state compatibility
  and legacy reconciliation debt. No fresh ordinary invocation produces it.
  Legacy `InvocationScope.global` is compatibility state only: the current
  runtime may parse and inspect it but must never execute it. A persisted
  global scope cannot run discovery, resume commit/push, or authorize any Git
  work; it fails closed before repository mutation. Before activating a release,
  source installation must prove that every historical global or missing-scope
  run is physically revoked from its canonical Turnlock namespace.
- Targeted scope names one exact canonical worktree plus explicit remote/ref
  publication intent.
- Targeted scope never widens into recursive, sibling, linked-worktree, or
  common-dir discovery.
- The three historical targeted CLI flags are atomic and consumed before Turnlock parses argv; that mode still requires an existing remote destination.
- Conditional remote creation requires the complete additional `--create-if-absent --base-ref <ref> --base-sha <OID>` group and persists `targeted-create` authority. Follow `specs/targeted-destination-creation.md`: keep the authorized history boundary separate from destination absence, verify all B..S against actual commit parentage rather than shallow cutoffs, and publish only the exact validated S under an explicit absence lease. Creation traversal and patch reads share that actual-parent view without fetching or rewriting metadata. Suppress default and ambient legacy graft files in the Git child environment, never globally.
- Creation is an exact non-coalescing request using coordinator mode `targeted`, without a SQLite schema or payload change.
- Resume recovers scope from durable Turnlock state and may not redefine it
  through targeted CLI flags.
- Persisted worktree and targeted scopes are revalidated before resumed work.
- `autoPush` gates ordinary clean-worktree tracked push-only publication; it is
  not a discovery policy. Explicit targeted publication remains independent of
  `autoPush`.
- Targeted remote/ref arguments are explicit publication authority, and the
  observed destination baseline is frozen before any commit effect.
- Targeted dirty detached worktrees commit directly on the detached HEAD.
- Targeted clean ahead worktrees publish through explicit push-only snapshots.
- Explicit publication never creates or changes a local branch, an upstream, or persistent Git configuration; its remote-tracking synchronization is `not-applicable`. Historical targeted updates never create a remote branch. Only the explicitly authorized creation mode may create its exact absent remote destination, directly at validated S.
- Use shared exact transport with `--no-follow-tags` and `--recurse-submodules=no`; do not let ambient Git configuration expand publication beyond the requested ref.
- In creation mode, qualify local HEAD/index objects before staging and inspect only the exact worktree's index. Share canonical actual-content diff arguments between staged-diff hashing and outgoing scans; do not let textconv, external drivers, binary/color/rename configuration or root suppression hide scan input. Keep child repositories outside parent gitlink diffs. Preserve historical scan semantics; the independent legacy gap is tracked in Issue #20.
- A destination that moved away from the frozen baseline fails closed: no
  merge, rebase, or automatic recovery is attempted.
- Targeted publication never advances or mutates a persistent checkout.
- git-commits-push detects stale concurrent publication; the caller or harness
  owns any fetch, rebase, and conflict resolution before retrying.
- The reconciler stores the owner's invocation mode but no target payload.

## Reconciliation contract

The durable coordinator keeps exactly two invocation modes. A **global** mode
classification exists only for legacy persisted state, ownerless reconciliation
debt, and legacy recovery compatibility; no fresh public invocation produces
fresh global work. Every fresh ordinary (`worktree`) or explicit targeted
request is an exact caller-owned request and uses the existing non-coalescing
`targeted` coordination mode. Its exact scope is never persisted in the
reconciler and is not a durable replayable work item.

Before any Git, supervisor, or LLM work, every production invocation MUST
classify its mode by pure argv parsing and atomically increment
`requested_generation` in `reconciler.sqlite`. Production invocations MUST NOT
build or resolve modules from the source checkout.

- One live owner executes reconciliation passes.
- A legacy global owner still coalesces a legacy global requester,
  incrementing the requested generation exactly once.
- No fresh ordinary or explicit targeted request coalesces. A request that
  meets another live owner waits process-locally with bounded exponential
  polling, registers no durable request, and retries with unchanged mode and
  arguments until it obtains its own exact ownership.
- Normal exact execution starts only from an idle, converged coordinator.
- Ownerless pending generations are legacy global reconciliation debt. Recovery
  acquires global ownership only to fence any preserved execution boundary and
  retire the debt; it starts no replacement execution. Legacy global recovery:
  preserves safety; fences any old execution; retires debt without replay;
  starts no replacement execution; then re-admits the fresh exact caller.
- Legacy global reconciliation mode is non-executable: `runOwnedReconciliation`
  rejects it before runtime preparation, execution-token creation, controller
  spawn, supervisor, Turnlock, Git, or LLM work.
- Registration and pass finalization use short `BEGIN IMMEDIATE` transactions.
- An owner runs another fresh pass when a newer generation was registered.
- Ownership is fenced by random token, PID, process-start identity, and
  invocation mode.
- Active execution is separately fenced by execution token, generation,
  controller PID, process-start identity, and POSIX process-group identity.
- Recovery ownership never authorizes fresh Git execution until the previous
  execution boundary is proven dead and its record is token-cleared.
- Dead global reconciliation is fenced and retired without replay; dead
  targeted requests are fenced and settled, never replayed, and never run
  through a replacement supervisor for the abandoned target.
- A matching live process is never replaced because of heartbeat age or
  boot-clock drift.
- A live PID with temporarily unreadable process metadata retains ownership.
- Corrupt, incompatible, or impossible state fails closed and is preserved.
- A supervisor is spawned only through the paused READY/register/authorize/START
  protocol; no child can become Git-capable before durable registration.
- Pass completion and owner release are forbidden while active execution is
  recorded.
- Targeted coordinator settlement is not publication success: a terminal
  targeted failure still returns failure to the caller while leaving the
  coordinator idle and converged.
- The coordinator stores no per-request orders or historical event log.

`ORDER_STATE_DIR` remains the compatibility override for the state directory
and must resolve to an absolute path. The default is
`$XDG_STATE_HOME/git-commits-push/orders/`, falling back to
`~/.local/state/git-commits-push/orders/`. The normative state machine is
documented in
[`specs/reconciliation.md`](specs/reconciliation.md).

Legacy `running.lock` and `order-*.json` or `order-*.flag` artifacts are migration
inputs only. A live legacy worker blocks admission. Stale residue may be
archived outside the legacy namespace only after a SQLite generation is durably
registered and exact pre-admission file evidence is revalidated.

## Git safety

- Never interpolate discovered paths, branches, refs, or remotes into shell
  command strings. Use argument arrays and `shell: false`.
- Never put remote credentials or push URLs in argv, repository config,
  telemetry, state snapshots, or unsanitized diagnostics.
- Resolve exactly one effective push URL. Fingerprint both that URL and ambient
  URL-rewrite configuration. Preflight, exact-SHA push, and postflight
  verification MUST target the same resolved endpoint.
- Treat verified remote publication and its local remote-tracking projection as
  separate outcomes. Synchronize only an unambiguously matching branch, ref,
  and effective fetch/push endpoint with an expected-old-value guard; never
  overwrite concurrent local ref changes or reinterpret projection failure as
  remote push failure.
- Process-scoped Git configuration MUST remain compatible with Git 2.17 and use
  correctly quoted `GIT_CONFIG_PARAMETERS` rather than repository mutation.
- On Darwin kernel 17 and older, resolve and validate Apple toolchain Git through
  `xcrun` before starting reconciliation; all descendant Git commands must inherit
  that selection. Newer Darwin and non-Darwin systems use Git from `PATH`.
- Internal Git subprocesses use the stable C locale so diagnostic classification
  never depends on the invoking user's language.
- Validate full Git object IDs before using persisted push snapshots.
- Push-only recovery MUST prove the baseline is an ancestor of current `HEAD`
  and must recompute the exact outgoing set before secret scanning or push.
- Secret scanning and tests are mandatory gates unless configuration explicitly
  disables tests. Any unrelated failure discovered during validation must be
  fixed rather than ignored.

## Exact publication completeness

- Capture `validatedSource` after staging and validation, before the first
  delegation: exact worktree/Git-directory identity, original HEAD or unborn
  absence, complete index tree T, literal changed-path membership and required
  publication intent. Validate the diff from immutable H0/T input, compare the
  source after validation, reuse that same immutable diff representation for
  publication admission and retries, and persist the witness in Turnlock, never in the
  reconciler. Never rerun discovery on resume to acquire a replacement authority.
- Keep T unchanged across retries. Retain `publisherIndexTreeSha` only as proof
  of an admitted publisher index transition, never as a replacement T. Require
  exact matching progress plus original content before a zero-commit retry;
  reject foreign index/HEAD changes. Reject missing witnesses, source races and
  uncheckpointed history before commit effects; read legacy state for diagnosis
  without inventing authority.
- Admit the complete plan before reset/add/commit/push. Account for each remaining
  validated path exactly once using actual Git commit evidence, not LLM claims,
  directory expansion or patch-header parsing.
- Require the final HEAD tree to equal T before publication, and matching remote
  identity when publication is required. Neither commits, remote SHA nor empty
  output alone permits success. Preserve effects and remote evidence on failure.
- Persist terminal results through a no-effect Turnlock checkpoint. Reporting
  continuations must never republish. Recover complete progress only through the
  same Git/publication proof, never by empty-diff inference. Preserve legitimate `autoPush=false`
  local-commit success and unchanged clean push-only behavior.

## LLM safety

- Validate and authorize Turnlock delegation manifests before reading job payloads. New v3 manifests must target exactly `worker("git-commit-generator")`; bounded v2 compatibility accepts only that historical worker. Unknown targets and compatibility markers fail closed.
- Validate initial planning and repair responses with the production Zod schema
  inside the bounded attempt loop.
- Commit-message repair may change only requested messages; file ownership,
  indexes, and plan cardinality remain invariant.
- An over-budget `repair-commit-messages` response may be shortened only at an
  existing ASCII-space whole-word boundary using the already-calculated
  description budget. The repair preserves `type`, `scope`, `isBreaking`, body,
  file ownership, and plan structure; the canonical full commit validator
  remains the final gate. If no whole-word prefix fits, fail closed.
- Primary validation repair is bounded to two attempts. Typed runtime rate-limit,
  overload, transient-provider, timeout, protocol and response-parse outages may
  also select the configured fallback after runtime retries terminate. Both paths
  share one durable `fallbackAttempted` budget. Auth, invalid-request, cancelled
  and untyped string errors never authorize provider failover. An invalid or failed
  fallback terminates; no empty-diff inference or ownership-changing repair is allowed.
- Carry the eligible runtime failure kind through job-result validation. Preserve
  exact rejected plans when failing over a message-only repair. Legacy results
  without a typed outage retain their historical classification.
- Never log provider tokens, Authorization headers, raw credential-bearing URLs,
  prompts containing secrets, or unsanitized provider errors.

## Identity and telemetry

Harness detection has one authority:
`src/modules/core/execution-identity.ts`. It supports Antigravity, Pi, Codex,
Claude Code, tests, and direct CLI use. Request identity and telemetry MUST use
that authority rather than duplicate environment precedence.

Explicit `GCP_ORDER_*` variables override automatic request-origin detection.
`GCP_ORDER_IS_QUEUED` is legacy telemetry metadata only and MUST NOT reactivate a
queue execution path. Telemetry failures must never block reconciliation.

## Installation and release safety

- The harness command is exactly `"$HOME/.local/bin/git-commits-push"`; do not
  reintroduce checkout discovery, `cd`, `pnpm`, or runtime build steps.
- Install application data below non-empty absolute `XDG_DATA_HOME`, falling back
  to `~/.local/share`; an empty `XDG_DATA_HOME` is equivalent to absence.
- Activate only the relative `current` symlink atomically. The public executable
  symlink is stable and may be created only when absent or already equal to the
  managed target.
- Release names bind semantic version and a deterministic tree digest. Reject
  escaping or broken symlinks, special files, hostile destination entries, and
  mismatched existing release content.
- `pnpm run cutover:legacy-global-runs` is read-only by default. Its apply form
  requires explicit no-live-execution confirmation, an idle reconciler, and the
  shared state-cutover lock. It may checkpoint abandoned Turnlock WAL state only
  inside that confirmed offline window.
- Global-run revocation atomically renames the complete run directory into a
  same-filesystem quarantine and writes a regular-file tombstone at the exact
  canonical run path. It never edits an immutable release or moves a worktree or
  targeted run. Closure-ledger prose alone is not an execution fence.
- Installation MUST fail until legacy-global cutover inspection is ready. A
  crash after quarantine rename remains fail-closed because the canonical run
  directory is absent; a retry completes the tombstone.
- Installation locking uses a lifecycle-held SQLite exclusive transaction plus
  a private owner record fenced by nonce, PID, and process-start identity. OS
  lock release makes crashes recoverable, and simultaneous stale recovery may
  admit only one installer. Once that lock is held, remove only physical
  `.staging-<32 hex>` directories and owner-candidate files proven stale by
  exclusive ownership. Reject matching live or unreadable-identity owners before
  waiting. Only a validated dead-incarnation owner record enables the bounded
  stale-recovery arbitration budget. After `BEGIN EXCLUSIVE`, reject an expired
  admission deadline or any change to the entry owner tuple (including its
  removal) before schema, candidate, or owner-record effects. A waiter must never
  acquire the next epoch merely because the winner finished. Keep missing-record
  admission non-waiting; deadlines and records alone confer no ownership.
- `pnpm` is allowed during source installation only. The installed release must
  run with Node and Git when the source checkout and `pnpm` are unavailable.

## Dependency patching

- `patches/@fanilosendrison__llm-runtime@0.1.3.patch` is a transitional pnpm
  patch that carries two upstream fixes: explicit DeepSeek thinking-mode control
  through `providerOptions` and a per-attempt timeout that covers the response
  body as well as the headers. It applies until
  `@fanilosendrison/llm-runtime` 0.1.4 is published to the registry.
- The patch payload is the exact compiled output of the upstream fix; do not
  hand-edit it. Regenerate it from the llm-runtime build whenever the upstream
  fix changes.
- Adopting `>= 0.1.4` must bump the dependency, delete the patch and its
  `pnpm-workspace.yaml` entry, and keep
  `tests/node-build/deepseek-thinking-patch.node.mjs` green against the
  published release in the same change.

## State and schema

- Parse persisted Turnlock state through `src/config/state-schema.ts`.
- For conditional creation only, checkpoint terminal repository/publication evidence through Turnlock before final reporting. The bridge acknowledges `checkpoint-creation-outcome` without inference or Git work; its reporting continuation must never republish.
- Reconciler schema v4 stores one bounded owner, its invocation mode, and one
  bounded active-execution descriptor in the singleton row; it stores no
  request history, target payload, or execution history.
- Schema changes require production-schema tests and compatibility fixtures.
- A writable open MAY upgrade only a provably idle, converged schema-v3
  singleton to v4 by adding `owner_invocation_mode` and setting
  `PRAGMA user_version = 4` in one transaction. Non-idle v3 state fails closed
  and is preserved because v3 cannot say whether missing work was global or
  targeted. Read-only opens never migrate.
- Schema v2 MUST fail closed in production. Its explicit offline migration is
  allowed only for an idle, converged row after the operator proves that no old
  launcher, supervisor, or descendant remains alive; it stages v3 and then
  upgrades to v4 through the normal writable path.
- Persist push URL fingerprints, never push URLs.
- Preserve committed SHA evidence across partial failures and retries.
- Do not silently migrate incompatible Turnlock or reconciler schema versions.

## Code quality

- TypeScript is strict; do not introduce `any`.
- Use exact optional-property semantics and explicit discriminated unions.
- Prefer immutable state transitions.
- Keep one source of truth for schemas, retry budgets, environment keys,
  identity precedence, and event contracts.
- Add JSDoc to exported APIs where intent or invariants are not obvious.
- Keep production files below 400 lines; split by cohesive responsibility rather
  than hiding logic in generic utility modules.
- New files and Markdown must follow repository naming and OpenKnowledge rules.

## Required validation

Run from this directory:

```bash
pnpm run typecheck
pnpm run typecheck:node
pnpm run typecheck:node:stats
pnpm run lint
pnpm test
pnpm run test:node:build
pnpm run test:node:stats
```

The TypeScript runner explicitly enumerates 91 test files in `tests/run-tests.mjs`.
Installer concurrency tests build a test-only SQLite VFS extension with `cc` and
SDK SQLite development headers. It delegates native operations unchanged and
schedules lock promotions over control pipes; it links no replacement SQLite
engine and is not part of the installed release.
When adding or renaming a test, update that manifest and
`tests/node-build/test-runner.node.mjs` together.

Concurrency and recovery changes MUST cover:

- historical absolute resume commands encountering a non-directory tombstone
  after global-run revocation, with no Git or LLM effect;
- authoritative SQLite scope inspection, abandoned-WAL checkpointing only in a
  confirmed offline apply, crash-after-rename recovery, and non-global run
  preservation;

- simultaneous cold-start registration;
- global coalescing during a running pass;
- incompatible targeted combinations returning process-local WAIT while the
  coordinator row and active execution stay unchanged;
- targeted wait cancellation and waiter SIGTERM semantics;
- registration racing with pass completion;
- owner death and recycled-PID recovery, including mode-preserving targeted
  recovery that fences without replaying the abandoned target;
- legacy global fencing/retirement without replay before exact-request
  admission;
- fenced heartbeat and release;
- active-execution registration, START authorization, and token clearing;
- launcher and supervisor hard-death recovery without execution overlap;
- PID/process-group identity mismatch and fail-closed recovery;
- corrupt or incompatible database handling, including bounded idle v3-to-v4
  migration and non-idle v3 refusal;
- legacy queue residue classification;
- compiled launcher, execution-controller, and supervisor behavior.

Push changes MUST include real temporary Git repositories and bare remotes.
Provider changes MUST retain at least one real smoke test when credentials are
available, while deterministic unit tests use injected adapters.

## Supported execution-boundary contract

Linux and macOS use one detached execution controller as the SID/PGID leader;
all repository-controlled descendants inherit that process group. Recovery may
signal the group only while the controller's process-start identity and PGID
match. A missing or reused leader with a still-live group is ambiguous and MUST
fail closed. Windows and untested POSIX platforms MUST refuse Git-capable
execution until a Job Object or equivalent tested containment boundary exists.
Repository-controlled code MUST NOT call `setsid()` or detach from the execution
boundary.

## Documentation synchronization

When architecture or runtime state changes, update together:

- `README.md` for users;
- `AGENTS.md` for contributors;
- `specs/reconciliation.md` for normative behavior;
- `docs/reconciliation-migration.md` for compatibility and migration history;
- `docs/node-cutover-preflight.md` for operational inspection and recovery.
