---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "migration-guide"
name: "git-commits-push-sqlite-reconciliation-migration"
version: "4.0.0"
status: "Active"
summary: "Migration record for replacing per-request file queues with SQLite generation reconciliation."
domain: "git-commits-push"
severity: "strict"
---

# SQLite reconciliation migration

## Change summary

The public launcher no longer creates durable per-request order files or runs a
file-queue worker. It now records reconciliation generations in
`reconciler.sqlite`, serializes exact caller-owned requests under one live owner,
and keeps legacy global generations as non-executable compatibility state. The ordinary
command operates on exactly the Git worktree it was invoked from; it never scans
`searchPaths` or sibling worktrees.

Turnlock remains responsible for one pass's durable workflow. The launcher is
responsible for cross-invocation admission, scheduling ownership, recovery, and
deciding whether another pass is required. Schema v3 records the concrete
execution controller and process group capable of Git side effects; schema v4
adds the owner's invocation mode so global and targeted admission have distinct,
durable semantics.

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

## Turnlock invocation-scope compatibility

- GlobalState persists InvocationScope.
- Historical valid Turnlock state with no invocationScope normalizes to
  `{kind:"global"}`. This is valid because the worktree scope did not exist when
  those states were written.
- New no-argument invocations persist `{kind:"worktree", repository}` with the
  canonical Git top-level of the original invocation directory.
- The ordinary `worktree` scope and the explicit `targeted-explicit` scope both
  use the durable coordinator mode `targeted`: they are exact, non-coalescing
  caller-owned requests.
- Legacy `{kind:"global"}` state remains structurally compatible, but its
  application authority is retired. A persisted global Turnlock run is
  parseable and inspectable, yet it is non-executable: discovery and
  commit/push resumption both fail closed before repository mutation.
- A malformed present invocationScope still fails state validation.
- This is not a reconciler SQLite migration. There is no schema v5.
- `PRAGMA user_version` remains 4.
- No target repository, remote, or ref is added to the reconciler singleton, and
  the worktree path is never persisted there.
- Existing legacy global debt is retired by fence-and-settle recovery, never by
  replay, and no fresh invocation creates fresh global work. Historical missing
  Turnlock scope still normalizes to global but cannot execute.

## Turnlock push-state compatibility

- TrackedPushSnapshot now carries the discriminant `kind:"tracked"`.
- A legacy valid tracked snapshot without a discriminant normalizes to
  `kind:"tracked"`; a present but unknown or malformed discriminant fails.
- ExplicitPushSnapshot and ExplicitPushTargetSnapshot have no historical
  migration: no explicit publication state existed before this change, so a
  snapshot without a discriminant is never reinterpreted as explicit.
- A legacy in-progress targeted run that requires publication but has no frozen
  explicit target fails closed. Its historical remote baseline is unknown, and
  substituting a current baseline would silently redefine the publication
  authority, so the state is rejected instead of repaired.
- Raw push URLs are never persisted; explicit state stores only a SHA-256
  fingerprint of the single effective push URL.
- This is Turnlock state compatibility, not a reconciler SQLite migration.
- PRAGMA user_version is 4.

## Safety changes

- Admission is committed before build or Git work.
- Legacy global owners still coalesce legacy global requesters. Every fresh
  ordinary or explicit targeted request is exact: it performs no durable
  mutation while another owner is live, waits process-locally with bounded
  exponential polling, and retries with unchanged arguments.
- Legacy global recovery preserves safety: it fences and clears any preserved
  active execution, retires accumulated global debt without replay, starts no
  replacement execution, and then re-admits the fresh exact caller.
- Legacy global reconciliation mode is non-executable: a global owner can never
  start a supervisor, Turnlock run, Git operation, or LLM operation.
- Two ordinary invocations from different worktrees serialize without
  scope-coalescing, and neither processes the other's worktree.
- Normal exact execution requires an idle, converged coordinator.
- Ownerless pending generations are legacy global debt; no caller is satisfied
  by the global recovery that retires them, and every fresh exact caller
  re-admits after retirement.
- Dead targeted owners are fenced and settled without replaying the abandoned
  target or starting a replacement supervisor for it.
- Targeted coordinator settlement is separate from targeted application success:
  a terminal targeted failure still returns failure to the caller while leaving
  the coordinator idle and converged.
- Default-state migration and launcher admission share one atomic filesystem
  lock until SQLite registration finishes, so a migrated database cannot be
  opened while validation or rollback is still possible.
- SQLite `BEGIN IMMEDIATE` transactions serialize registration and completion.
- Ownership is fenced with a random token, PID, and process-start identity.
- Active execution is separately fenced by execution token, generation,
  controller PID, process-start identity, and POSIX PGID.
- A paused controller cannot start the pipeline until READY identity is durably
  registered and START authorization is committed.
- Live owners are not stolen because of heartbeat age or boot-clock drift.
- Dead owners are recoverable without clearing their execution descriptor.
- Recovery terminates and proves the old process group absent before clearing it
  or starting fresh work.
- Recycled or unreadable controller identities are never signalled; ambiguous
  state fails closed.
- Unreadable metadata for a live PID retains ownership and fails closed.
- Signal handling covers build and the complete execution group without marking
  an interrupted generation complete.
- Supervisor exit is not completion proof; finish and release are blocked until
  the active execution is proven dead and token-cleared.
- Corrupt and unsupported databases block mutation and are preserved.
- Legacy residue is exactly revalidated and archived outside the legacy
  namespace only after a SQLite wakeup is durable.

## Reconciler schema migrations

Schema v4 adds `owner_invocation_mode`. An idle, fully converged schema-v3
singleton is upgraded automatically and atomically by any writable open; the
migration is refused, with the v3 database preserved, when any owner, running
generation, execution descriptor, or pending generation exists. Read-only
opens never migrate.

Schema v2 has no durable active-execution identity. Production rejects it
rather than treating missing execution columns as proof of idle state.

After stopping every launcher and proving that no supervisor or descendant
process remains alive, an operator may migrate only an idle, fully converged v2
singleton:

```bash
pnpm run migrate:reconciler-v2 -- --confirm-no-live-execution
```

The command rejects missing confirmation, active or pending state, malformed
rows, and uncheckpointed SQLite sidecars. It adds the v3 nullable execution
columns, sets `PRAGMA user_version = 3`, and then completes the bounded v4
upgrade through the normal writable open. It creates no history table, and a
database already at version 4 is reported as `already-current`.

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
4. If an idle schema-v2 database exists, prove all historical execution trees
   dead and run the explicit reconciler migration.
5. Run `pnpm run check:node-cutover` and resolve every blocker.
6. Run the compiled reconciliation, recovery, migration, and hard-death suites.
7. Run `pnpm run install:standalone` and verify the stable executable resolves to
   a content-addressed release.
8. Enable public invocations only after the preflight exits `0` by invoking
   `"$HOME/.local/bin/git-commits-push"`.

See [`node-cutover-preflight.md`](node-cutover-preflight.md) for incident and
manual-recovery procedures.

## Rollback boundary

Do not start an old file-queue worker while a SQLite owner is active. A rollback
requires stopping all launchers, execution controllers, supervisors, and
pipeline descendants; preserving `reconciler.sqlite`; proving that no active
execution descriptor remains unresolved; and proving that no reconciliation
generation is pending.
The preferred recovery is to fix or restore the SQLite runtime and trigger a new
exact invocation rather than recreate per-request order files.
