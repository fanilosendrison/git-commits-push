---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "specification"
name: "git-commits-push-reconciliation"
version: "3.0.0"
status: "Active"
summary: "Normative contract for SQLite reconciliation ownership and durable single-live Git execution."
domain: "git-commits-push"
severity: "strict"
---

# Reconciliation specification

## Scope

This document defines public invocation, durable coordination, active execution,
recovery, and compatibility for `git-commits-push`.

A public invocation means: **the set of dirty repositories may have changed;
reconcile the current global state**. It is not a durable per-request work item.
The coordinator stores generations, one reconciliation owner, and at most one
active execution descriptor. It stores no request or execution history.

The stable harness command resolves through the selected immutable XDG release:

```bash
"$HOME/.local/bin/git-commits-push"
```

Production MUST NOT depend on a source checkout, package manager, or runtime
build.

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

- use schema version `3` through `PRAGMA user_version`;
- contain exactly one `reconciler_state` row with `singleton_id = 1`;
- preserve `requested_generation >= completed_generation`;
- set and clear owner metadata with `running_generation`;
- set and clear the complete active-execution descriptor together;
- fail closed on corruption, an incompatible schema, or impossible state;
- contain no per-request, execution, or event history.

### Reconciliation owner

The owner schedules rescans and owns coordinator transitions. Its durable fields
are the running generation, random owner token, PID, process-start identity,
boot epoch, caller, origin, optional session ID, and heartbeat.

Correctness depends on owner token, PID, process-start identity, running
generation, and SQLite transaction boundaries. Boot epoch and heartbeat are
observability metadata. A stale heartbeat never authorizes replacement of a
matching live owner.

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

Every public invocation MUST register before repository discovery, Git mutation,
supervisor execution, or LLM invocation. Registration uses a short
`BEGIN IMMEDIATE` transaction and increments `requested_generation` exactly once.

- A matching live owner causes successful coalescing.
- No live owner causes atomic owner acquisition for the new generation.
- A dead or identity-mismatched owner is replaced atomically.
- A live PID with unreadable process metadata retains ownership and blocks
  replacement.
- Replacing an owner never clears or reinterprets active execution.

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
preserved active execution before runtime preparation or a new pass.

### No active execution

Recovery may proceed with a fresh global rescan.

### Exact live controller

Recovery MUST:

1. re-read and verify controller PID, process-start identity, and PGID;
2. send graceful termination to the exact execution group;
3. wait for the existing termination grace period;
4. escalate to hard termination only while exact leader identity still matches;
5. prove the complete process group absent;
6. token-clear the durable execution descriptor using current owner authority;
7. only then start a fresh pass.

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
recorded. A successful pass advances completion only after execution clearing.
A failed pass does not claim its generation complete. A newer requested
generation retains the owner and starts one fresh pass after the old boundary is
dead. Intermediate generations remain coalescible.

## Fencing

Owner heartbeat, finish, release, execution registration, START authorization,
and execution clearing require current owner authority. Execution authorization
and clearing additionally require the exact execution token. An obsolete owner
or execution token cannot mutate a replacement execution or generation.

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

## Schema-v2 migration

Schema v2 contains no active-execution identity and MUST NOT be interpreted as
idle by schema v3. Production opening fails closed.

An operator may migrate only an idle, converged v2 singleton after externally
proving that no launcher, supervisor, or descendant remains alive:

```bash
pnpm run migrate:reconciler-v2 -- --confirm-no-live-execution
```

The migration rejects active owners, running generations, pending generations,
SQLite sidecars, malformed state, and absent confirmation. It adds nullable
execution columns in one transaction, preserves the singleton, and creates no
history.

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
