---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "specification"
name: "git-commits-push-reconciliation"
version: "4.0.0"
status: "Active"
summary: "Normative contract for SQLite reconciliation ownership, invocation modes, and durable single-live Git execution."
domain: "git-commits-push"
severity: "strict"
---

# Reconciliation specification

## Scope

This document defines public invocation, durable coordination, active execution,
recovery, and compatibility for `git-commits-push`.

There are exactly two public invocation modes:

```ts
type ReconciliationInvocationMode = "global" | "targeted";
```

A **global invocation** means that global repository state may have changed, so
the current dirty-repository set must be reconciled. Global requests are
rediscoverable by a fresh global rescan, and multiple live global requests may
coalesce by generation. An incomplete admitted global generation remains durable
reconciliation work.

A **targeted invocation** is one synchronous exact caller-owned request that
names one exact worktree, remote, and ref. The repository, remote, and ref remain
outside reconciler durable state, so the request must execute its own scope, must
not coalesce into another request's execution, and is not a durable replayable
coordinator work item.

The coordinator stores generations, one reconciliation owner, and at most one
active execution descriptor. It stores no request or execution history and no
targeted payload. `SINGLE_LIVE_GIT_EXECUTION` spans both modes: at most one Git
side-effect-capable execution boundary exists regardless of which mode owns it.

The stable harness command resolves through the selected immutable XDG release:

```bash
"$HOME/.local/bin/git-commits-push"
```

Production MUST NOT depend on a source checkout, package manager, or runtime
build.

InvocationScope is Turnlock-run state, not reconciler durable authority. The
reconciler stores only the owner's invocation mode; it stores no repository,
remote, ref, or targeted request payload. Explicit-target publication stays
inside one Turnlock execution pass.

## Normative invariant

### SINGLE_LIVE_GIT_EXECUTION

At most one distinct `git-commits-push` execution boundary capable of Git side
effects may be alive. Recovery ownership never authorizes fresh Git execution
until every previous execution boundary is proven terminated or safely adopted.
This implementation uses termination and a fresh global rescan; it does not
adopt old execution.

Owner death is not evidence of execution death. Heartbeat age, expected signal
handling, elapsed time, and supervisor exit are not execution-death proof.

## Durable singleton state

The authority is `reconciler.sqlite` in the reconciliation state directory.
`ORDER_STATE_DIR` remains the absolute-path compatibility override. The default
is `$XDG_STATE_HOME/git-commits-push/orders/`, falling back to
`~/.local/state/git-commits-push/orders/`.

The database MUST:

- use schema version `4` through `PRAGMA user_version`;
- contain exactly one `reconciler_state` row with `singleton_id = 1`;
- preserve `requested_generation >= completed_generation`;
- set and clear owner metadata with `running_generation`;
- set and clear `owner_invocation_mode` with the owner;
- set and clear the complete active-execution descriptor together;
- fail closed on corruption, an incompatible schema, or impossible state;
- contain no per-request, execution, or event history.

### Reconciliation owner

The owner schedules rescans and owns coordinator transitions. Its durable fields
are the running generation, random owner token, PID, process-start identity,
boot epoch, caller, origin, optional session ID, invocation mode, and heartbeat.

`owner_invocation_mode` is `global`, `targeted`, or null when no owner exists.
It is part of the owner integrity set: a running owner without a mode, or a mode
without a running owner, is impossible durable state. Ownership and mode changes
participate in registration race observation.

Correctness depends on owner token, PID, process-start identity, invocation
mode, running generation, and SQLite transaction boundaries. Boot epoch and
heartbeat are observability metadata. A stale heartbeat never authorizes
replacement of a matching live owner.

### Active Git execution

The active-execution descriptor identifies the concrete side-effect boundary:

- random execution token;
- execution generation;
- controller PID;
- controller process-start identity;
- process-group ID;
- boundary kind;
- registering owner token;
- execution state: `REGISTERED` or `START_AUTHORIZED`.

When idle, every execution field is null. When populated:

1. every execution field is valid and non-null;
2. `completed_generation < execution_generation <= running_generation`;
3. PID and PGID identify the same controller group leader;
4. a current-generation execution belongs to the current owner;
5. an older execution generation with its former owner token is an explicit
   recovery state;
6. no second execution may register;
7. unresolved execution state blocks fresh execution;
8. owner replacement preserves the execution descriptor.

## Admission

Every public invocation MUST parse its invocation mode from a pure argv parse
and register before repository discovery, Git mutation, supervisor execution, or
LLM invocation. Registration uses a short `BEGIN IMMEDIATE` transaction and
increments `requested_generation` exactly once for every admitted request.

### Global/global coalescing

A matching live global owner coalesces a global requester: `requested_generation`
increments exactly once, and the running generation, owner token, owner PID,
owner mode, and active execution stay unchanged.

### No targeted coalescing

No combination containing a targeted request may coalesce:

- live global owner with a targeted requester;
- live targeted owner with a global requester;
- live targeted owner with another targeted requester.

These combinations perform zero durable mutation and return a process-local
`WAIT`. The caller polls with bounded exponential backoff (25 ms, 50 ms, 100 ms,
200 ms, then 250 ms maximum) and re-registers with unchanged mode and arguments.
WAIT is never durable, creates no request row, increments no generation, and
starts no runtime preparation, supervisor, Git, or LLM work.

### Normal targeted admission

A targeted request acquires normal ownership only from an idle, converged
coordinator: no owner, no active execution, and
`requested_generation == completed_generation`. It increments the generation
exactly once, becomes the owner with `owner_invocation_mode = targeted`, and
executes exactly its own scope.

### Ownerless pending generations

Ownerless `requested_generation > completed_generation` state is global
reconciliation debt because targeted ownership is never released leaving
targeted debt. For either requester mode, recovery acquires ownership with
`owner_invocation_mode = global` and a generation strictly greater than the
previous running generation. A global requester is satisfied by that fresh
global pass; a targeted requester is not and must retry normal admission after
the coordinator converges.

Other admission rules remain:

- a dead or identity-mismatched owner is replaced atomically, preserving the
  prior owner's invocation mode until the old execution and reconciliation
  obligation are safely resolved;
- a live PID with unreadable process metadata retains ownership and blocks
  replacement;
- replacing an owner never clears or reinterprets active execution;
- a dead targeted owner whose state shows `requested_generation != running_generation`
  is impossible targeted debt and fails closed rather than being recovered.

No Git, child-process, or LLM work occurs inside a coordinator transaction.

## Execution startup gate

One pass starts through this protocol:

```text
OWNER_ACQUIRED
  -> execution token created
  -> execution controller spawned inert
  -> PREPARE sent over dedicated IPC
  -> READY(pid, process identity, PGID, token) verified
  -> execution descriptor committed as REGISTERED
  -> START_AUTHORIZED committed
  -> START(token) sent over IPC
  -> node-supervisor may be spawned
```

The controller MUST NOT spawn the supervisor before valid `START`. IPC closure
before `START` terminates the inert controller. IPC closure after `START` begins
boundary termination immediately. Parent-disconnect cleanup is defense in depth;
recovery still resolves the durable descriptor before new work.

`START_AUTHORIZED` is durable because delivery and child scheduling cannot be
made atomic with SQLite. Recovery treats it as possibly started even when the
controller never received `START`.

## Process topology

On supported POSIX platforms the topology is:

```text
launcher [SQLite owner]
  -> execution-controller [SID/PGID leader]
       -> node-supervisor [inherits controller group]
            -> Turnlock orchestrator [inherits group]
            -> LLM bridge [inherits group]
                 -> resume, Git, and test children [inherit group]
```

The controller remains the exact identity anchor when `node-supervisor` dies.
Repository-controlled stages MUST NOT create independent sessions or process
groups. APIs that signal isolated process-group leaders remain distinct from APIs
that signal direct inherited children.

## Recovery protocol

After dead-owner takeover, the sole elected recovery owner MUST inspect the
preserved active execution before runtime preparation or a new pass. Recovery
owned by a mode-preserving generation strictly greater than the previous running
generation keeps an old execution descriptor representable as an older
explicit-recovery execution under the new owner.

### No active execution

Recovery may proceed according to its mode. A global recovery runs a fresh
global rescan. A targeted recovery settles its generation and admits no new pass
for the abandoned target.

### Dead global owner

A dead or replaceable global owner is recovered with a fresh global
execution. The recovery generation is the new requested generation. A global
requester is satisfied by that pass; a targeted requester is not, and retries
normal admission only after global convergence.

### Dead targeted owner

A dead or replaceable targeted owner is recovered only to fence and settle the
abandoned execution. Recovery MUST NOT start a supervisor, Turnlock run, or Git
pass for the abandoned exact target, and MUST NOT infer, persist, or replay that
target. After the old boundary is proven dead and its descriptor token-cleared,
the targeted recovery generation settles and the caller retries normal
admission.

### Exact live controller

Recovery MUST:

1. re-read and verify controller PID, process-start identity, and PGID;
2. send graceful termination to the exact execution group;
3. wait for the existing termination grace period;
4. escalate to hard termination only while exact leader identity still matches;
5. prove the complete process group absent;
6. token-clear the durable execution descriptor using current owner authority;
7. only then start a fresh pass or admit the caller's own request.

### Dead boundary

If the controller and recorded process group are absent, recovery may token-clear
the descriptor and proceed. Absence proves the old group cannot later
reconstitute.

### Ambiguous identity

A reused or unreadable controller PID, a mismatched PGID, or a dead controller
with a still-live recorded group is ambiguous. Recovery MUST NOT signal, clear,
or start new work. The descriptor remains durable for operator inspection.

A numeric PGID is not a durable kernel handle. Recovery therefore never signals
a group based only on its number after controller identity is lost.

## Pass completion and failure

Supervisor exit is a result, not boundary-death proof. Success, failure,
cancellation, and abnormal supervisor exit use this ordering:

```text
pipeline result known
  -> controller terminates remaining group members
  -> controller exits
  -> launcher proves PGID absent
  -> execution descriptor token-cleared
  -> generation finalized
  -> next generation or idle
```

`finishReconciliationPass()` and ownership release MUST fail while execution is
recorded, and MUST verify owner token, PID, invocation mode, running generation,
and execution absence before changing completion state.

A successful global pass advances completion only after execution clearing. A
failed global pass does not claim its generation complete. A newer requested
generation retains the global owner and starts one fresh pass after the old
boundary is dead. Intermediate global generations remain coalescible.

A targeted owner must never have coalesced newer work
(`requested_generation == running_generation ==` pass generation), or
finalization fails closed. Both targeted application outcomes settle coordinator
occupancy after the execution descriptor is cleared: success sets
`completed_generation = generation`, failure sets `completed_generation = generation`
too, and both clear the owner. Coordinator settlement is not application success;
a terminal targeted failure is still returned to the caller. Targeted
finalization never returns `CONTINUE` and never leaves
`requested_generation > completed_generation` as fake global debt.

## Fencing

Owner heartbeat, finish, release, execution registration, START authorization,
and execution clearing require current owner authority. Finish and release
also require the exact `owner_invocation_mode`. Execution authorization and
clearing additionally require the exact execution token. An obsolete owner or
execution token cannot mutate a replacement execution or generation.

Ownership release is mode-aware. Global release preserves
`requested_generation` and leaves interrupted global work pending. Targeted
release, once no active execution remains, sets
`completed_generation = requested_generation`, then clears the owner. That rule
covers targeted cancellation, targeted fatal paths after safe boundary
teardown, dead-targeted recovery after fencing, and release before application
success was established. If execution death cannot be proven, the coordinator is
not settled and durable evidence is preserved.

## Shutdown and fatal errors

`SIGINT` and `SIGTERM` cancel the active boundary, wait for proven group death,
clear execution, release ownership without advancing incomplete work, close
SQLite, and preserve signal termination.

Heartbeat fencing and SQLite failures cancel active work. If termination or
clearing cannot be proven, owner and execution evidence remains durable and the
launcher fails closed.

Uncaught exceptions and unhandled rejections MUST NOT advertise idle state. A
fatal launcher may release only when no execution is recorded; otherwise it
exits with owner and execution evidence intact so recovery can resolve them.
`SIGKILL` relies on the same durable recovery protocol.

## Platform contract

Linux and macOS support the POSIX session/process-group boundary. Windows and
untested POSIX platforms MUST refuse Git-capable execution before controller
spawn until a tested Job Object or equivalent kernel boundary exists.

The guarantee covers repository-controlled descendants and cooperative external
commands that inherit the execution group. A command that deliberately calls
`setsid()` or otherwise escapes the group is outside the supported execution
contract. Repository-controlled runtime code MUST never do so.

## Schema migrations

### Schema v3 to v4 (automatic, bounded)

Schema v4 adds exactly one durable coordinator field: `owner_invocation_mode`,
with `CHECK (owner_invocation_mode IS NULL OR owner_invocation_mode IN ('global', 'targeted'))`.

A writable open MAY migrate an existing schema-v3 singleton to v4 atomically and
in place, but only when the v3 row proves: exactly one singleton row with
`singleton_id = 1`, `running_generation = null`, every owner field null, every
execution field null, and `requested_generation == completed_generation`. The
migration re-reads schema, version, and state under `BEGIN IMMEDIATE`, adds the
column, sets `PRAGMA user_version = 4`, and commits. The migrated column stays
`NULL` because the state is idle.

Any other v3 state fails closed: the transaction rolls back, the v3 database is
preserved, and opening raises an incompatible-schema error. Schema v3 cannot say
whether interrupted reconciliation work was global or targeted, so non-idle v3
state is never guessed, deleted, recreated, or copied. No migration history
table is introduced. A read-only open never migrates and never mutates.

### Schema v2 (explicit, offline)

Schema v2 contains no active-execution identity and MUST NOT be interpreted as
idle. Production opening fails closed.

An operator may migrate only an idle, converged v2 singleton after externally
proving that no launcher, supervisor, or descendant remains alive:

```bash
pnpm run migrate:reconciler-v2 -- --confirm-no-live-execution
```

The explicit migration adds the existing v3 execution columns, sets
`PRAGMA user_version = 3`, closes its transaction, then opens through the normal
writable path so the bounded idle v3-to-v4 upgrade runs before verification. It
rejects active owners, running generations, pending generations, SQLite
sidecars, malformed state, and absent confirmation, preserves the singleton, and
creates no history. A database already at version 4 is reported as
`already-current`.

## Preflight

Read-only preflight distinguishes:

- idle state;
- pending reconciliation;
- live owner;
- stale or unverifiable owner;
- active execution under a live owner;
- unresolved orphan execution;
- corrupt, incompatible, or uncheckpointed state.

Any owner, pending generation, or execution descriptor is a blocker. A dead owner
alone never proves Git execution absent.

## Legacy compatibility

`running.lock`, `order-*.json`, and `order-*.flag` are migration inputs only. A
live legacy lock blocks admission. Stale residue is archived outside the legacy
namespace only after SQLite registration and exact file-evidence revalidation.
`GCP_ORDER_IS_QUEUED` remains telemetry metadata and never enables queue mode.

## Telemetry

Telemetry is best effort and never correctness authority. Lifecycle events may
include execution preparation, registration, start, orphan detection,
termination, and clearing. Coordinator state and telemetry contain no provider
credentials, prompts, diffs, or remote URLs.

## Safety invariants

- `EXEC-INV-1`: at most one side-effect-capable execution boundary exists.
- `EXEC-INV-2`: no execution becomes Git-capable before durable registration.
- `EXEC-INV-3`: owner death does not imply execution death.
- `EXEC-INV-4`: recovery never overlaps unresolved old execution.
- `EXEC-INV-5`: owner and execution mutations are token-fenced.
- `EXEC-INV-6`: completion follows full boundary termination.
- `EXEC-INV-7`: supervisor hard death cannot orphan an overlapping pipeline.
- `EXEC-INV-8`: launcher hard death cannot authorize overlap.
- `EXEC-INV-9`: PID reuse cannot authorize unrelated signaling.
- `EXEC-INV-10`: recovery remains singleton under contention.
- `EXEC-INV-11`: supervisor disappearance never implies completion.
- `EXEC-INV-12`: SQLite remains one bounded singleton with no history.
- `EXEC-INV-13`: a targeted public request is never satisfied by coalescing into
  another request's execution scope.
- `EXEC-INV-14`: normal targeted Git execution starts only from a coordinator
  whose prior reconciliation debt has been resolved.
- `EXEC-INV-15`: targeted coordinator settlement is independent from targeted
  application success and creates no durable exact-request replay obligation.
- `EXEC-INV-16`: dead-owner recovery preserves the prior owner's invocation mode
  until the old execution/reconciliation obligation has been safely resolved.
