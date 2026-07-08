# Order Algorithm Rationale

## Objective

The order algorithm solves local concurrency problems when multiple agents start
`git-commits-push` at the same time on the same machine.

Without serialization, two executions can collide on:

- `.git/index.lock`;
- staged file state;
- Turnlock run state;
- retry feedback;
- telemetry interpretation.

The design goal is not merely mutual exclusion. It must also explain what
happened afterward: which agent session queued work, which parent run executed
it, and whether an event was a retry or a separate queued order.

## Why An Order Instead Of A Waiting Queue

A waiting queue would keep the second process alive while the first process
runs. That creates several problems:

- it holds the user's terminal open;
- it keeps the `orchestrator | bridge` pipe alive without useful work;
- it wastes resources;
- it still has no useful context to preserve, because discovery is automatic.

The selected model is an order handoff:

1. Session A is already running.
2. Session B starts and sees A's active lock.
3. Session B writes a durable JSON order.
4. Session B exits successfully.
5. Session A finishes and releases the lock.
6. Session A dequeues the oldest order.
7. Session A starts a fresh `bun run start` process for that order.

This keeps the terminal responsive and makes the parent session responsible for
continuing queued work.

## Why Not PID Locks

Turnlock deliberately terminates and resumes execution around LLM delegation.
That makes process identity unstable. A PID lock would look dead during normal
operation or point at a process that no longer owns the run.

The heartbeat on `running.lock` is a better ownership signal for this runtime.

## Why Not Polling

Polling would keep the queued process alive just to wait for a filesystem state
change. That contradicts the order model. The queued session has no unique work
to preserve, because a later fresh discovery pass can find the repositories that
still need commits.

The order file is enough.

## Why Spawn The Full Skill Command

The skill is a two-process pipeline:

```bash
bun run src/entrypoints/turnlock-orchestrator.ts | bun run src/entrypoints/turnlock-to-llm-bridge.ts
```

The orchestrator alone can emit Turnlock delegation blocks, but it cannot call
the LLM by itself. A queued order must therefore restart the full `bun run start`
command so the bridge is present.

## Why Durable JSON Orders

The original order idea used empty flag files. That was enough to say "run
again", but not enough to answer operational questions later.

Durable JSON orders now store:

- the queued `orderId`;
- the requested `runId`;
- the origin agent and session;
- the blocking run and caller;
- the queue position;
- the run that eventually triggered execution.

This makes the queue auditable and allows telemetry to distinguish a queued
second session from an internal retry.

## Why `orderId` Is Separate From `runId`

`runId` belongs to Turnlock execution. Retries, resumes, and final reporting are
run-scoped.

`orderId` belongs to user intent. A user or agent request can be queued by one
process, then executed later by a different process with a different `runId`.

Keeping both ids makes these statements possible:

- "This was attempt 2 of repo X inside run Y."
- "This was order Z from Pi session B."
- "Order Z was later executed because run A released the lock."

## Why Telemetry Is Part Of The Design

The order algorithm is only useful if operators can understand it after the
fact. The telemetry stream therefore includes order lifecycle events:

- `order_started`;
- `order_queued`;
- `order_dequeued`;
- `order_finished`;
- `queue_empty`.

Normal run events are enriched from `GCP_ORDER_*` environment variables. This
means existing `run_start`, `delegation`, `retry`, and `run_end` events can be
grouped by order as well as by run.

## Rejected Behaviors

Do not wake the old queued process. It has exited by design.

Do not spawn only the orchestrator. It would break LLM delegation.

Do not rely on PID locks. Turnlock process lifetimes are intentionally
discontinuous.

Do not block the queued session. It should register and exit.

Do not treat telemetry failure as fatal. Lock cleanup and queued-order handoff
must continue even if event logging fails.
