---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "migration-guide"
name: "git-commits-push-sqlite-reconciliation-migration"
version: "2.1.0"
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
- `$XDG_STATE_HOME/git-commits-push/orders/` is the default directory when
  `XDG_STATE_HOME` is non-empty, with
  `~/.local/state/git-commits-push/orders/` as its fallback;
- `GCP_ORDER_*` fields carry request-origin telemetry;
- `GCP_ORDER_IS_QUEUED` is emitted only as legacy telemetry metadata;
- `running.lock`, `order-*.json`, and `order-*.flag` are inspected only as legacy
  migration residue.

No compatibility field re-enables queue semantics.

## Safety changes

- Admission is committed before build or Git work.
- Default-state migration and launcher admission share one atomic filesystem
  lock until SQLite registration finishes, so a migrated database cannot be
  opened while validation or rollback is still possible.
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

## Standalone repository and executable cutover

Runtime code and state are independent of the source checkout. Install the
production executable from the dedicated repository before enabling harness
invocations:

```bash
pnpm run install:standalone
```

The installer deploys an immutable content-addressed release below non-empty
`XDG_DATA_HOME`, falling back to `~/.local/share`, atomically switches only the
application's `current` symlink, and exposes the stable harness entrypoint at
`~/.local/bin/git-commits-push`. Production invocations do not run `pnpm` or
compile source. Older releases remain available so persisted Turnlock runs can
resume against the exact entrypoints recorded when they began.

The one-time state migration moves the complete legacy `.state/` container,
including `orders/` and the closure ledger, into the XDG state location.

The public launcher fails closed while the legacy state container still exists,
so default-state migration cannot be skipped accidentally. The launcher and
migration command contend on the same sibling `.migration-lock` directory from
legacy-path inspection through either migrated-state validation or durable
SQLite registration. The migration command first validates an existing database
read-only, rejects uninitialized or non-regular database files, checkpoints
SQLite, refuses active or pending ownership, requires an atomic rename on one
filesystem, validates the moved database, and rolls back the rename if
validation fails:

```bash
pnpm run migrate:state
```

Never copy only `reconciler.sqlite`; WAL and ledger evidence are part of the
cutover boundary. A crash or power loss can leave the fail-closed lock directory
behind. Remove that empty directory only after proving that no migration or
launcher process is active.

## Operator actions

1. Ensure Node.js 22.19 or later is active because the coordinator uses
   `node:sqlite`.
2. Stop every legacy and current launcher before migrating state.
3. Run `pnpm run migrate:state` once when legacy state exists.
4. Run `pnpm run check:node-cutover` and resolve every blocker.
5. Run the compiled reconciliation, recovery, migration, and hard-death suites.
6. Run `pnpm run install:standalone` and verify the stable executable resolves to
   a content-addressed release.
7. Enable public invocations only after the preflight exits `0` by invoking
   `"$HOME/.local/bin/git-commits-push"`.

See [`node-cutover-preflight.md`](node-cutover-preflight.md) for incident and
manual-recovery procedures.

## Rollback boundary

Do not start an old file-queue worker while a SQLite owner is active. A rollback
requires stopping all launchers and supervisors, preserving
`reconciler.sqlite`, and proving that no reconciliation generation is pending.
The preferred recovery is to fix or restore the SQLite runtime and trigger a new
global rescan rather than recreate per-request order files.
