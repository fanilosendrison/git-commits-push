# Order Algorithm Specification

For the design rationale, see
[`docs/order-rationale.md`](../docs/order-rationale.md).

## Purpose

The order algorithm serializes local `git-commits-push` executions. It prevents
two agent sessions from mutating the same repositories, Git indexes, Turnlock
state, or telemetry stream at the same time.

The algorithm deliberately separates these identities:

- `runId`: one Turnlock execution.
- `orderId`: one user or agent request, even if queued and executed later.

This separation is required for observability. A retry stays inside one `runId`.
A queued second agent session receives its own `orderId`, exits, and is later
executed by a fresh run in the parent session.

## State Directory

The state directory is resolved as follows:

1. `ORDER_STATE_DIR`, when present.
2. The skill-local `.state/orders` directory.

The directory contains:

- `running.lock`;
- `order-<queuedAtEpochMs>-<orderId>.json`;
- legacy `order-*.flag` files during migration only.

## Lock File

`running.lock` is JSON.

Required fields:

- `runId`;
- `callerName`;
- `timestamp`.

Optional fields:

- `orderId`;
- `originSessionId`;
- `originAgent`.

The active process updates the lock file `mtime` every 10 seconds. If another
process finds the lock older than 40 seconds, it treats the active execution as
dead, removes the stale lock, clears queued files, and acquires the lock.

## Queued Order File

Queued order files are JSON.

Required fields:

- `orderId`;
- `requestedRunId`;
- `originAgent`;
- `callerName`;
- `queuedAtEpochMs`.

Optional fields:

- `originSessionId`;
- `blockedByRunId`;
- `blockedByCallerName`;
- `triggeredByRunId`;
- `queuePosition`.

The filename starts with `queuedAtEpochMs` so FIFO order is inspectable even
without parsing the file. The JSON body is the canonical data.

## Environment Contract

Queued orders are passed into spawned child runs with these environment
variables:

- `GCP_ORDER_ID`;
- `GCP_ORDER_ORIGIN_SESSION_ID`;
- `GCP_ORDER_ORIGIN_AGENT`;
- `GCP_ORDER_CALLER_NAME`;
- `GCP_ORDER_QUEUED_AT_EPOCH_MS`;
- `GCP_ORDER_TRIGGERED_BY_RUN_ID`;
- `GCP_ORDER_IS_QUEUED`.

`src/utils/cli-bootstrap.ts` reads these variables before Turnlock is imported.
It also creates fresh values for direct, non-queued invocations.

## Acquisition Rules

`checkAndAcquireLock(runId, orderContext)` returns an `AcquireLockResult`.

If no lock exists:

- create `running.lock`;
- return `kind: "ACQUIRED"`;
- allow Turnlock startup to continue;
- log `order_started` from bootstrap.

If the lock belongs to the same `runId`:

- return `kind: "ACQUIRED"`;
- treat this as a resume of the same run.

If the lock is malformed:

- overwrite it;
- return `kind: "ACQUIRED"`.

If the lock is stale:

- remove it;
- remove queued order files;
- create a fresh lock;
- return `kind: "ACQUIRED"`.

If the lock is active and belongs to another run:

- create an `order-*.json` file;
- calculate FIFO queue position;
- log `order_queued`;
- return `kind: "QUEUED"`;
- print a queue-registration message;
- exit with status `0`.

## Release Rules

`releaseLockAndTriggerNext(runId)` returns a `ReleaseLockResult`.

If no lock exists:

- stop heartbeat;
- return `kind: "missing-lock"`.

If the lock is malformed:

- stop heartbeat;
- return `kind: "malformed-lock"`.

If the lock belongs to another run:

- stop heartbeat;
- return `kind: "not-owner"`.

If the lock belongs to the current run:

- remove `running.lock`;
- stop heartbeat;
- inspect queued orders.

When the queue is empty:

- log `queue_empty`;
- return `kind: "released"` with `remainingQueuedOrders: 0`.

When the queue is not empty:

- delete the oldest queued order;
- add `triggeredByRunId`;
- log `order_dequeued`;
- spawn `bun run start` in the skill root unless `DISABLE_REAL_SPAWN=1`;
- pass `GCP_ORDER_*` variables to the child process;
- return `kind: "released"` with the triggered order.

## Telemetry Rules

The order algorithm emits:

- `order_started`;
- `order_queued`;
- `order_dequeued`;
- `order_finished`;
- `queue_empty`.

All standard git-commits-push telemetry events are enriched with order context
when `GCP_ORDER_*` variables exist. This is how consumers distinguish:

- a retry attempt inside the same run;
- a queued order from another session;
- a queued order later executed by the parent session.

## Safety Rules

The order algorithm must not depend on an OS PID lock. Turnlock intentionally
terminates and resumes processes between delegations, so PID ownership would be
misleading.

The queued process must not sleep, poll, or keep the terminal open. It registers
its order and exits.

The parent process must spawn the full `bun run start` command for the next
order. Restarting only the orchestrator would bypass the bridge and break LLM
delegation.

Telemetry failures must never prevent lock cleanup or queued-order execution.

## Tests

Important tests:

- `tests/unit/order-store.test.ts`;
- `tests/unit/lock-manager.test.ts`;
- `tests/unit/skill-stats-log.test.ts`;
- `tests/acceptance/a4-queued-order-observability.test.ts`;
- `tests/invariants/i4-stdout-compliance.test.ts`;
- `tests/invariants/i5-test-environment-safety.test.ts`.
