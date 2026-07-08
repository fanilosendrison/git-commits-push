# git-commits-push

`git-commits-push` is a Turnlock-orchestrated skill that discovers dirty Git
repositories, validates them, asks an LLM for Conventional Commit plans, commits
with file-level splitting, and pushes safely.

The agent does not write commits directly. `SKILL.md` instructs the host agent to
start the standalone Bun application:

```bash
cd /Users/famillesendrison/.agents/skills/git-commits-push && bun run start
```

From that point, the TypeScript app owns discovery, validation, LLM calls, Git
operations, queueing, and reporting.

## Architecture

The skill is built around Turnlock, which provides resumable state-machine
execution and batch delegation.

```text
git-commits-push/
├── SKILL.md
├── AGENTS.md
├── README.md
├── system-prompt.md
├── package.json
├── docs/
│   └── order-rationale.md
├── specs/
│   └── order.md
├── src/
│   ├── config/
│   │   ├── settings.ts
│   │   ├── settings.json
│   │   └── state-schema.ts
│   ├── entrypoints/
│   │   ├── turnlock-orchestrator.ts
│   │   └── turnlock-to-llm-bridge.ts
│   ├── modules/
│   │   ├── core/
│   │   ├── formatters/
│   │   ├── git/
│   │   ├── orders/
│   │   └── telemetry/
│   ├── phases/
│   │   ├── step1-discovery-validation.ts
│   │   └── step2-commit-push.ts
│   ├── types.ts
│   └── utils/
│       ├── cli-bootstrap.ts
│       ├── git-utils.ts
│       └── lock-manager.ts
└── tests/
    ├── acceptance/
    ├── fixtures/
    ├── invariants/
    ├── property/
    └── unit/
```

## Runtime Flow

The app starts in `src/entrypoints/turnlock-orchestrator.ts`. Bootstrap runs
before Turnlock is imported so the process can claim the local execution lock,
create a `runId`, create or inherit an `orderId`, and exit early if another run
is active.

The `bun run start` script pipes two processes together:

```bash
bun run src/entrypoints/turnlock-orchestrator.ts | bun run src/entrypoints/turnlock-to-llm-bridge.ts
```

The orchestrator emits Turnlock protocol blocks on stdout. The bridge consumes
delegations, calls the configured LLM provider, writes per-job result files, and
resumes the orchestrator.

Normal debug and final reports are written to stderr so stdout remains reserved
for Turnlock protocol. Queue registration is the intentional human-readable
stdout exception because the queued process exits before entering Turnlock.

## Phase 1: Discovery And Validation

`src/phases/step1-discovery-validation.ts` performs:

- repository discovery from `settings.searchPaths`;
- detached-HEAD exclusion;
- pre-commit validation for each dirty repository;
- test cascade execution unless `skipTests` is enabled;
- `git add -A`;
- diff extraction and `diffHash` calculation;
- secret scan;
- initial LLM batch delegation.

The test cascade is:

1. `STACK_EVAL.yaml` `test_runner`;
2. `package.json` `test`;
3. auto-discovered Bun tests;
4. auto-discovered pytest tests;
5. silent success when no tests are found.

## Phase 2: Commit And Push

`src/phases/step2-commit-push.ts` consumes LLM results and, per repository:

- classifies LLM-side failures;
- validates Conventional Commit subjects and bodies;
- escalates to fallback model only when validation retries are exhausted;
- commits with file-level splitting;
- preserves already-created commits after partial failures;
- detects race conditions with `diffHash`;
- classifies Git and network errors;
- queues retries with structured feedback;
- stops repeated identical plans with loop detection;
- writes final run and order telemetry.

## Retry Model

Retry counters are per repository and per retry kind.

- `validation`: invalid Conventional Commit output.
- `structural`: malformed or unusable LLM commit plan.
- `race`: staged diff changed after validation.
- `git`: unexpected Git failure outside push/race handling.
- `network`: push failure considered transient.

`src/modules/core/queue-retry.ts` builds the retry payload, formats feedback,
caps feedback history, and hashes plans for loop detection.

Fallback model behavior lives in `src/modules/core/fallback-model.ts`.
Fallback requires both `fallbackProvider` and `fallbackModel` in settings, and it
only applies to validation retries.

## Order Queue

The local order system prevents concurrent `git-commits-push` executions from
colliding on Git indexes or Turnlock state.

Important terms:

- `runId` is the Turnlock execution id for one process.
- `orderId` is the durable user/session request id.
- One `orderId` can be queued by one process and later executed by another.

The current queue implementation uses:

- `src/utils/cli-bootstrap.ts` for order context creation;
- `src/utils/lock-manager.ts` for lock acquisition, heartbeat, release, and
  spawning the next order;
- `src/modules/orders/types.ts` for queue metadata and env keys;
- `src/modules/orders/order-store.ts` for JSON queue files;
- `src/modules/orders/order-id.ts` for generated ids.

Queue state lives under `ORDER_STATE_DIR` when set. Otherwise it uses the
skill-local `.state/orders` directory. The state directory contains:

- `running.lock`, JSON metadata for the active run;
- `order-<queuedAtEpochMs>-<orderId>.json`, one durable queued order.

The lock heartbeat updates `running.lock` every 10 seconds. If a new process
finds a lock whose `mtime` is older than 40 seconds, the lock is treated as
stale, old queued files are cleaned up, and the new process acquires execution.

When a second session starts while a run is active, it writes a queued-order JSON
file, logs `order_queued`, prints the queue position, and exits with status `0`.
When the active run finishes, it releases the lock, dequeues the oldest order,
logs `order_dequeued`, and spawns a fresh `bun run start` with `GCP_ORDER_*`
environment variables so the next run can be tied back to the original session.

Legacy `order-*.flag` files are tolerated for cleanup and migration, but JSON
orders are the canonical queue format.

## Telemetry

Telemetry is emitted through `src/modules/telemetry/stats-logger.ts`.

Git commit/push events are written to:

```text
~/neelopedia/stats/<agent>/git-commits-push/events.jsonl
```

Secret scanner events are written to:

```text
~/neelopedia/stats/<agent>/secret-scanner/events.jsonl
```

Secret scanner results are fail-closed for production-looking secrets. Obvious
non-production contexts are tolerated instead:

- files under `test/`, `tests/`, `__tests__/`, `specs/`, or `fixtures/` emit a
  non-blocking `warning`;
- `.env.example`, `.env.template`, and `.env.sample` files are skipped;
- same-line `mock`, `dummy`, `test`, `example`, or `fake` values are skipped;
- same-line `git-commits-push: allow-secret` annotations are skipped.

Core event types:

- `order_started`;
- `order_queued`;
- `order_dequeued`;
- `order_finished`;
- `queue_empty`;
- `run_start`;
- `delegation`;
- `retry`;
- `loop_detected`;
- `repo_outcome`;
- `run_end`;
- secret scanner `passed`, `warning`, and `block`.

When `GCP_ORDER_*` environment variables are present, normal run events are
automatically enriched with order context. This makes it possible to distinguish
a retry inside one run from a queued order that came from another agent session.

## Configuration

Settings are read by `src/config/settings.ts`.

Default file:

```text
src/config/settings.json
```

Tests and custom launches can override the path with:

```text
TURNLOCK_SKILL_SETTINGS_PATH
```

Required settings:

- `provider`;
- `model`;
- `temperature`;
- `systemPromptPath`;
- `autoPush`;
- `skipTests`.

Optional settings:

- `searchPaths`;
- `thinking`;
- `fallbackProvider`;
- `fallbackModel`.

`fallbackProvider` and `fallbackModel` must be configured together.

## Artifacts

Runtime artifacts include:

- Turnlock runs under `~/.turnlock/runs/git-commits-push-tl/<runId>/`;
- order state under `ORDER_STATE_DIR` or `.state/orders`;
- Git telemetry JSONL under `~/neelopedia/stats/<agent>/git-commits-push/`;
- secret telemetry JSONL under `~/neelopedia/stats/<agent>/secret-scanner/`.

## Verification

Useful commands:

```bash
bun run typecheck
bun run lint
bun run test
```

Focused tests for the order layer:

```bash
bun test \
  tests/unit/order-store.test.ts \
  tests/unit/lock-manager.test.ts \
  tests/acceptance/a4-queued-order-observability.test.ts \
  --timeout 60000
```
