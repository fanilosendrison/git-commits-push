---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "procedure"
name: "git-commits-push-reconciliation-preflight"
version: "1.0.2"
status: "Active"
summary: "Read-only inspection and recovery procedure for durable git-commits-push reconciliation state."
domain: "git-commits-push"
severity: "strict"
---

# Reconciliation preflight and recovery

## Purpose

The preflight is a read-only gate for inspecting both historical Turnlock runs
and the state directory used by the SQLite reconciler. It detects incomplete or
incompatible Turnlock runs, legacy queue residue, an active reconciler owner,
incomplete generations, and corrupt or incompatible databases without creating
or mutating state.

Use it before runtime upgrades, incident recovery, or manual coordinator
maintenance. Routine public invocations perform their own fail-closed admission
checks and do not require a separate preflight.

## Command

From the skill directory:

```bash
pnpm run check:node-cutover
```

To inspect the same non-default directory used by the launcher:

```bash
ORDER_STATE_DIR=/absolute/path/to/state pnpm run check:node-cutover
```

The command accepts these inspection inputs:

- `ORDER_STATE_DIR` selects the reconciliation state directory. The default is
  `.state/orders/` under the skill directory.
- `TURNLOCK_RUN_DIR_ROOT` selects the Turnlock run root. The inspected directory
  is its `git-commits-push-tl/` child; the default root is `~/.turnlock/runs/`.
- `GCP_NODE_CUTOVER_CLOSURE_LEDGER` selects the explicit closure ledger. The
  default is `.state/node-cutover-closures.json` under the skill directory.

`ORDER_STATE_DIR` remains a compatibility name for the reconciliation state
directory.

## Exit contract

- Exit `0`: no blocker was found.
- Exit `1`: one or more blockers were found and printed.
- Exit `2`: the preflight itself failed.

The command MUST remain read-only. It MUST NOT create `reconciler.sqlite`, create
SQLite journal, WAL, or shared-memory sidecars, delete legacy files, clear
ownership, repair schema state, or rebuild runtime artifacts.

## Blockers

The preflight reports:

- active, stale, or malformed historical Turnlock locks;
- malformed or incompatible historical Turnlock run state;
- unreadable or unexpected entries in the Turnlock run root;
- invalid explicit closure-ledger evidence;
- live, stale, or malformed legacy `running.lock` state;
- legacy `order-*.json` or `order-*.flag` artifacts;
- an active SQLite reconciler owner;
- `requested_generation > completed_generation` without an owner;
- an uncheckpointed SQLite journal or WAL state that cannot be inspected without
  mutating SQLite sidecars;
- a corrupt SQLite database;
- an unsupported SQLite schema version.

Any blocker means automated Git mutation must remain disabled until the state is
understood.

## Historical run classifications

Every historical Turnlock run is classified as one of:

- `drained`: schema version `2`, matching orchestrator identity, and a final
  successful `orchestrator_end` event;
- `explicitly-closed`: a valid closure-ledger record documents the operator's
  decision;
- `rejected-incompatible`: the run is not proven drained and has no valid closure
  evidence.

The closure ledger is a versioned JSON object. Each entry requires a unique ULID
`runId`, an ISO timestamp in `closedAt`, and a non-empty `reason`:

```json
{
  "version": 1,
  "runs": [
    {
      "runId": "01J00000000000000000000000",
      "closedAt": "2027-01-15T08:00:00.000Z",
      "reason": "Reviewed and closed before cutover"
    }
  ]
}
```

Closure evidence records a deliberate operator decision; it does not modify or
delete the historical run directory.

## Recovery rules

1. Stop new invocations and identify whether the recorded owner PID and
   process-start identity still designate the same live process.
2. If an owner is alive, let it finish or terminate it deliberately; never delete
   its database while it is running.
3. Preserve a corrupt or incompatible `reconciler.sqlite` before any manual
   intervention. Checkpointed SQLite state is inspected through an immutable URI;
   journal, WAL, or shared-memory sidecars block inspection rather than being
   opened or changed.
4. Treat incomplete generations as required future rescans, not as disposable
   queue entries.
5. Review every incompatible historical Turnlock run. Add explicit closure
   evidence only after determining that it cannot contain resumable work.
6. For legacy artifacts, confirm that no legacy worker is active. A normal
   launcher invocation can migrate stale residue only after it has durably
   registered a SQLite generation.
7. Run the preflight again and require exit `0` before re-enabling automated
   invocations.

Deleting coordinator state is a last resort. It is safe only after confirming
that no launcher or supervisor is active and accepting that the next invocation
must rediscover all current dirty repositories from scratch.

## Evidence to retain

For an upgrade or incident record, capture:

- preflight command and exit code;
- resolved reconciliation state, Turnlock run-root, and closure-ledger paths;
- Node and Git versions;
- historical classifications and reported blocker kinds;
- operator decision and any preserved database copy;
- post-recovery preflight output.
