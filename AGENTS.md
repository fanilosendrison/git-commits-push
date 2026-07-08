# git-commits-push Agent Guide

This file is your local operating guide to work on the
`git-commits-push` skill.

## Path Rules

- Edit this skill through `/Users/famillesendrison/.agents/skills/git-commits-push`.
- Do not edit the physical `~/Developper/Projects/dotagents/...` path directly.
- Keep `SKILL.md` as the user-facing activation contract.
- Do not run `bun run start` while developing unless the task explicitly needs a
  full skill execution.
- Prefer targeted tests, typecheck, and lint while iterating.

## Quick Workflow

When iterating:

1. Edit through this gateway path.
2. Run `bun run typecheck && bun run lint`, then targeted tests.
3. Run `bun run test` before finishing code changes.
4. If committing, commit from the dotagents repo using `/git-commits-push`.

## Important Invariants

- Secret scanning is fail-closed.
- Secret scanner `warning` events are non-blocking and must stay limited to
  explicit non-production contexts.
- Git commands must be non-interactive.
- Parallel validation must not leak state across repositories.
- Orchestrator stdout must stay Turnlock-protocol clean.
- Test runs must not write production Turnlock, order, or telemetry state.

## Runtime Contract

`SKILL.md` requires host agents to run:

```bash
cd /Users/famillesendrison/.agents/skills/git-commits-push && bun run start
```

Run it without an external timeout. The skill manages its own timeout and retry
behavior.

`bun run start` runs this pipeline:

```bash
bun run src/entrypoints/turnlock-orchestrator.ts | bun run src/entrypoints/turnlock-to-llm-bridge.ts
```

The orchestrator owns Turnlock state. The bridge owns LLM delegation execution.

## Testing Expectations

Run these before finishing code changes:

```bash
bun run typecheck
bun run lint
bun run test
```

Use targeted tests while iterating:

```bash
bun test \
  tests/unit/order-store.test.ts \
  tests/unit/lock-manager.test.ts \
  tests/unit/skill-stats-log.test.ts \
  tests/acceptance/a4-queued-order-observability.test.ts \
  --timeout 60000
```

Tests that spawn the orchestrator must use `MockTurnlockEnvironment` and include
`...env.env()` in `spawnSync` environment objects.

## Dependencies

Runtime and package dependencies:

- Bun `>=1.1.0` is the runtime and test runner.
- TypeScript runs in ESM mode with Bun-compatible imports.
- `turnlock` comes from the npm registry at `^0.3.1`. Do not reintroduce a
  local `file:` dependency unless actively testing unreleased Turnlock changes.
- `tsconfig.json` resolves `turnlock` through normal package exports, not through
  a local source path mapping.
- `@fanilosendrison/llm-runtime` powers provider adapters and prompt building.
- `zod` validates Turnlock state and LLM result schemas.
- `src/modules/telemetry/stats-logger.ts` imports `createEventSink` from the
  local telemetry-tools checkout at
  `/Users/famillesendrison/Developper/Projects/telemetry-tools/event-sink/src/index.ts`.

Development dependencies:

- `typescript` powers `bun run typecheck`.
- `@biomejs/biome` powers `bun run lint`.
- `@types/bun` provides Bun runtime types.

External tools the skill may invoke while validating target repositories:

- `git`;
- package managers detected from target repos: `bun`, `pnpm`, `yarn`, or `npm`;
- `pytest` for Python test discovery.

## Folder Structure

```text
git-commits-push/
├── AGENTS.md                  # Local instructions for future agents
├── README.md                  # Human-facing architecture and usage docs
├── SKILL.md                   # Activation contract for host agents
├── docs/
│   └── order-rationale.md     # Design rationale for the order queue
├── specs/
│   └── order.md               # Technical contract for lock/order behavior
├── src/
│   ├── config/
│   │   ├── settings.json      # Runtime defaults for provider, model, paths
│   │   ├── settings.ts        # Settings loader and validation
│   │   └── state-schema.ts    # Turnlock state and LLM result schemas
│   ├── entrypoints/
│   │   ├── turnlock-orchestrator.ts  # Turnlock app definition
│   │   └── turnlock-to-llm-bridge.ts # LLM bridge and resume loop
│   ├── modules/
│   │   ├── core/              # Discovery, validation, retry, reporting logic
│   │   ├── formatters/        # Conventional Commit formatting
│   │   ├── git/               # Git commit splitting, push, and diff helpers
│   │   ├── orders/            # Order ids, types, and durable JSON queue store
│   │   └── telemetry/         # JSONL stats logging
│   ├── phases/
│   │   ├── step1-discovery-validation.ts # Discovery and first delegation
│   │   └── step2-commit-push.ts          # Retries, commits, push, report
│   ├── types.ts               # Shared domain types
│   └── utils/
│       ├── cli-bootstrap.ts   # Pre-Turnlock run and order bootstrap
│       ├── git-utils.ts       # Shared Git helpers
│       └── lock-manager.ts    # Lock, heartbeat, queue, next-order spawn
├── system-prompt.md           # Prompt injected into commit-planning jobs
└── tests/
    ├── acceptance/            # End-to-end Turnlock flows
    ├── fixtures/              # Temporary repo and Turnlock env builders
    ├── helpers/               # Shared test helpers
    ├── invariants/            # Safety and protocol invariants
    ├── property/              # Race, detached HEAD, and push properties
    └── unit/                  # Module-level tests
```

## Core Concepts

- `runId` identifies one Turnlock execution.
- `orderId` identifies one user or agent request.
- A queued request keeps its `orderId` but later executes in a fresh `runId`.
- Retries are per repository and per retry kind.
- Fallback model escalation only applies to exhausted `validation` retries.
- Normal orchestrator stdout must remain valid Turnlock protocol.
- Queue-registration stdout is allowed because queued processes exit before
  entering Turnlock.

## Order Queue

The order queue exists to serialize local executions.

- Active execution is represented by `running.lock`.
- Queued executions are durable JSON files named
  `order-<queuedAtEpochMs>-<orderId>.json`.
- Queue state comes from `ORDER_STATE_DIR` when set, otherwise from
  `.state/orders`.
- The active process updates `running.lock` every 10 seconds.
- A lock older than 40 seconds is stale.
- A concurrent process writes an order JSON file, logs `order_queued`, prints
  its position, and exits with status `0`.
- The active process releases the lock, dequeues the oldest order, logs
  `order_dequeued`, and spawns a fresh `bun run start`.
- Spawned queued runs receive `GCP_ORDER_*` environment variables.
- Legacy `order-*.flag` files may exist; JSON files are canonical.

## Retry And Fallback

Retry kinds are:

- `validation`;
- `structural`;
- `race`;
- `git`;
- `network`.

Validation retries can escalate to the configured fallback model after their
normal budget is exhausted. Fallback requires both `fallbackProvider` and
`fallbackModel`.

Do not treat fallback as a general retry strategy for every error kind.

## Telemetry

Git events are written to:

```text
~/neelopedia/stats/<agent>/git-commits-push/events.jsonl
```

Secret scanner events are written to:

```text
~/neelopedia/stats/<agent>/secret-scanner/events.jsonl
```

Secret scanner event types:

- `passed`: no suspicious findings;
- `warning`: tolerated finding in an explicit non-production context;
- `block`: commit flow stopped because a production-looking secret was found.

Important order events:

- `order_started`;
- `order_queued`;
- `order_dequeued`;
- `order_finished`;
- `queue_empty`.

Important run events:

- `run_start`;
- `delegation`;
- `retry`;
- `loop_detected`;
- `repo_outcome`;
- `run_end`.

When `GCP_ORDER_*` variables are present, run events should be enriched with
order context.

## Documentation Notes

- Treat source and tests as canonical when docs drift.
- Keep `README.md`, `specs/order.md`, and `docs/order-rationale.md` aligned
  when changing order behavior.
- Update this file when adding a new subsystem or invariant that future agents
  must know.
