# Node Cutover Preflight

The Node cutover preflight is a read-only gate over persisted Turnlock and order
state. Run it from the skill directory before changing the active `start`
command:

```bash
pnpm --silent run check:node-cutover
```

The command builds the Node artifacts, emits one JSON report, and exits with:

- `0` when the state is ready for cutover;
- `1` when the report contains blockers;
- `2` when the preflight itself cannot execute.

It does not create, rewrite, rename, or delete Turnlock runs, locks, queued
orders, or closure evidence.

## Inputs

By default the preflight reads:

- `~/.turnlock/runs/git-commits-push-tl/` for Turnlock runs;
- `.state/orders/` for the order lock and queue;
- `.state/node-cutover-closures.json` for optional explicit closures.

`TURNLOCK_RUN_DIR_ROOT`, `ORDER_STATE_DIR`, and
`GCP_NODE_CUTOVER_CLOSURE_LEDGER` can redirect those inputs for isolated tests
or an alternate gateway. Paths remain runtime-resolved and are never embedded
in compiled artifacts.

## Historical run classifications

Every discovered run receives exactly one classification:

- `drained`: the final non-empty `events.ndjson` record is a matching
  `orchestrator_end` event;
- `explicitly-closed`: an operator recorded the run in the separate closure
  ledger after reviewing its effects;
- `rejected-incompatible`: the run is non-terminal, malformed, unreadable, or
  has an incompatible state schema.

A rejected run blocks cutover. Live, stale, or malformed Turnlock locks also
block independently of classification. This prevents closure evidence from
hiding an active or abandoned process lease.

Before explicitly closing a run, inspect its run directory and affected Git
repositories to determine what was already committed or pushed. Never modify
`state.json`, `events.ndjson`, `delegations/`, or `results/`. The closure ledger
is separate, local, and ignored by Git. Its schema is:

```json
{
  "version": 1,
  "runs": [
    {
      "runId": "<run-ulid>",
      "closedAt": "<iso-8601-timestamp>",
      "reason": "<reviewed closure reason>"
    }
  ]
}
```

Run IDs must be unique valid ULIDs. Each closure requires a parseable timestamp
and a non-empty reason. Invalid closure evidence fails closed.

## Queue blockers

Cutover is rejected when `.state/orders/` contains:

- a live, stale, malformed, or unreadable `running.lock`;
- any entry whose name starts with `order-`, including legacy flags and
  malformed or partially written order artifacts.

Stale artifacts remain blockers even though the compatibility runtime can clean
some of them during acquisition. Cutover requires an observably empty queue and
no abandoned lock; the preflight never performs that cleanup itself.
