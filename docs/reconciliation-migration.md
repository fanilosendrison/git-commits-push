---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "migration-guide"
name: "git-commits-push-sqlite-reconciliation-migration"
version: "1.0.1"
status: "Active"
summary: "Migration record for replacing per-request file queues with SQLite generation reconciliation."
domain: "git-commits-push"
severity: "strict"
---

# SQLite reconciliation migration

## Change summary

The public launcher no longer creates durable per-request order files or runs a
file-queue worker. It now records reconciliation generations in
`reconciler.sqlite`, coalesces concurrent invocations into one live owner, and
rescans global repository state after later wakeups.

Turnlock remains responsible for one pass's durable workflow. The launcher is
responsible for cross-invocation admission, ownership, recovery, and deciding
whether another pass is required.

## Compatibility surface

The following names remain temporarily for compatibility:

- `ORDER_STATE_DIR` selects the reconciliation state directory;
- `.state/orders/` remains the default directory;
- `GCP_ORDER_*` fields carry request-origin telemetry;
- `GCP_ORDER_IS_QUEUED` is emitted only as legacy telemetry metadata;
- `running.lock`, `order-*.json`, and `order-*.flag` are inspected only as legacy
  migration residue.

No compatibility field re-enables queue semantics.

## Safety changes

- Admission is committed before build or Git work.
- SQLite `BEGIN IMMEDIATE` transactions serialize registration and completion.
- Ownership is fenced with a random token, PID, and process-start identity.
- Live owners are not stolen because of heartbeat age or boot-clock drift.
- Dead owners and recycled PIDs are recoverable on the next invocation.
- Unreadable metadata for a live PID retains ownership and fails closed.
- Signal handling covers build and supervisor execution without marking an
  interrupted generation complete.
- Corrupt and unsupported databases block mutation and are preserved.
- Legacy residue is exactly revalidated and archived outside the legacy
  namespace only after a SQLite wakeup is durable.

## Operator actions

1. Ensure Node.js 22.19 or later is active because the coordinator uses
   `node:sqlite`.
2. Stop any legacy queue worker before enabling the reconciler.
3. Run `pnpm run check:node-cutover` and resolve every blocker.
4. Run the compiled reconciliation, recovery, and hard-death suites.
5. Enable public invocations only after the preflight exits `0`.

See [`node-cutover-preflight.md`](node-cutover-preflight.md) for incident and
manual-recovery procedures.

## Rollback boundary

Do not start an old file-queue worker while a SQLite owner is active. A rollback
requires stopping all launchers and supervisors, preserving
`reconciler.sqlite`, and proving that no reconciliation generation is pending.
The preferred recovery is to fix or restore the SQLite runtime and trigger a new
global rescan rather than recreate per-request order files.
