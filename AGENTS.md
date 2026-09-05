---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "directive"
name: "git-commits-push-agent-directives"
version: "1.0.1"
status: "Active"
summary: "Architecture, safety, and validation directives for contributors to git-commits-push."
domain: "git-commits-push"
severity: "strict"
---

# git-commits-push contributor directives

## Mission

`git-commits-push` discovers dirty repositories, validates them, asks an LLM for
Conventional Commit plans, commits exact file groups, and pushes them. Turnlock
owns one pass's durable phase workflow. The public launcher owns global
reconciliation across concurrent invocations.

## Runtime architecture

The production path is:

```text
scripts/start-node.mjs
  -> SQLite reconciliation admission and ownership
  -> compiled node-supervisor
  -> Turnlock orchestrator + LLM bridge
  -> discovery, commit/push, and reporting phases
```

Responsibilities MUST remain separated:

- `scripts/start-node.mjs` owns pre-build admission, lifecycle-wide signal
  cancellation, legacy-state inspection, owner heartbeat, the pass loop, and
  graceful release.
- `src/modules/reconciliation/` is the sole authority for SQLite schema,
  generation transitions, liveness recovery, and token fencing.
- `src/entrypoints/node-supervisor.ts` owns its descendant process trees,
  protocol routing, and bounded transport buffering; launcher cancellation is
  forwarded through the supervisor tree.
- `src/entrypoints/turnlock-orchestrator.ts` owns Turnlock phases and snapshots.
- `src/entrypoints/turnlock-to-llm-bridge.ts` owns delegation handling and result
  writes; provider dispatch belongs in `src/modules/llm/`.
- `src/phases/` coordinates domain modules. Keep phase entrypoints below 400
  lines by extracting cohesive policies into `src/modules/`.

Shell entrypoints are compatibility shims only. New runtime behavior belongs in
TypeScript or focused `.mjs` launcher modules.

## Reconciliation contract

A public invocation means that global repository state may have changed. It is
not a durable per-request job.

Before any build, Git, child-process, or LLM work, every invocation MUST atomically
increment `requested_generation` in `reconciler.sqlite`.

- One live owner executes reconciliation passes.
- Concurrent invocations coalesce into that owner and exit successfully.
- Registration and pass finalization use short `BEGIN IMMEDIATE` transactions.
- An owner runs another fresh pass when a newer generation was registered.
- Ownership is fenced by random token, PID, and process-start identity.
- A matching live process is never replaced because of heartbeat age or
  boot-clock drift.
- A live PID with temporarily unreadable process metadata retains ownership.
- Corrupt, incompatible, or impossible state fails closed and is preserved.
- The coordinator stores no per-request orders or historical event log.

`ORDER_STATE_DIR` remains the compatibility override for the state directory.
The normative state machine is documented in
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
- Process-scoped Git configuration MUST remain compatible with Git 2.17 and use
  correctly quoted `GIT_CONFIG_PARAMETERS` rather than repository mutation.
- Validate full Git object IDs before using persisted push snapshots.
- Push-only recovery MUST prove the baseline is an ancestor of current `HEAD`
  and must recompute the exact outgoing set before secret scanning or push.
- Secret scanning and tests are mandatory gates unless configuration explicitly
  disables tests. Any unrelated failure discovered during validation must be
  fixed rather than ignored.

## LLM safety

- Validate Turnlock v2 manifests before reading job payloads.
- Validate initial planning and repair responses with the production Zod schema
  inside the bounded attempt loop.
- Commit-message repair may change only requested messages; file ownership,
  indexes, and plan cardinality remain invariant.
- Primary validation repair is bounded to two attempts. At most one configured
  fallback attempt follows. An invalid fallback terminates.
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

## State and schema

- Parse persisted Turnlock state through `src/config/state-schema.ts`.
- Schema changes require production-schema tests and compatibility fixtures.
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

The TypeScript runner explicitly enumerates 55 test files in `tests/run-tests.mjs`.
When adding or renaming a test, update that manifest and
`tests/node-build/test-runner.node.mjs` together.

Concurrency and recovery changes MUST cover:

- simultaneous cold-start registration;
- coalescing during a running pass;
- registration racing with pass completion;
- owner death and recycled-PID recovery;
- fenced heartbeat and release;
- corrupt or incompatible database handling;
- legacy queue residue classification;
- compiled launcher and supervisor behavior.

Push changes MUST include real temporary Git repositories and bare remotes.
Provider changes MUST retain at least one real smoke test when credentials are
available, while deterministic unit tests use injected adapters.

## Documentation synchronization

When architecture or runtime state changes, update together:

- `README.md` for users;
- `AGENTS.md` for contributors;
- `specs/reconciliation.md` for normative behavior;
- `docs/reconciliation-migration.md` for compatibility and migration history;
- `docs/node-cutover-preflight.md` for operational inspection and recovery.
