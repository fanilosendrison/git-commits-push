---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "specification"
name: "git-commits-push-reconciliation"
version: "1.0.2"
status: "Active"
summary: "Normative contract for coalescing concurrent git-commits-push invocations into durable SQLite-backed reconciliation passes."
domain: "git-commits-push"
severity: "strict"
---

# Reconciliation specification

## Scope

This document defines the public invocation, durable coordination, ownership,
recovery, and compatibility contracts of `git-commits-push`.

A public invocation means: **the set of dirty repositories may have changed;
reconcile the current global state**. It is not a durable per-request work item.
The coordinator therefore stores generations and one owner, not queued orders.

## Runtime state

The authoritative coordinator is `reconciler.sqlite` in the reconciliation state
directory. `ORDER_STATE_DIR` remains the compatibility override for that
directory; the default is `.state/orders/` under the skill directory.

The SQLite database MUST:

- use schema version `2` through `PRAGMA user_version`;
- contain exactly one `reconciler_state` row with `singleton_id = 1`;
- preserve `requested_generation >= completed_generation`;
- set and clear running generation, owner token, PID, process-start identity,
  boot epoch, caller, origin, and heartbeat together;
- keep `owner_session_id` null while idle and either null or non-empty while an
  owner is active;
- fail closed on corruption, an incompatible schema, or an impossible state;
- never persist a per-request order history.

Caller, origin, and optional session ID are observability metadata. Correctness
depends on the random owner token, process ID, process-start identity, running
generation, and SQLite transaction boundaries. Boot epoch remains diagnostic
metadata; wall-clock drift MUST NOT invalidate a matching live process identity.
The heartbeat records progress but MUST NOT be the sole evidence used to steal
ownership from a live process.

## Admission

Every public launcher invocation admitted without incompatible state or
repeated ownership churn MUST register a reconciliation request before building
artifacts, discovering repositories, mutating Git state, or invoking an LLM.

Registration MUST execute in a short `BEGIN IMMEDIATE` transaction and increment
`requested_generation` exactly once.

- If the recorded PID is alive and its process-start identity matches,
  registration MUST coalesce into that owner and exit successfully without
  running a pass.
- If there is no live owner, registration MUST acquire ownership for the new
  generation.
- If ownership metadata identifies a dead process or a reused PID with a
  different process-start identity, registration MUST replace it atomically and
  report recovery.
- If the PID is alive but its process-start metadata cannot be read,
  registration MUST fail closed by retaining the observed owner.

A stale heartbeat alone MUST NOT permit stealing ownership from a live process.
No Git, build, child-process, or LLM work may occur inside a coordinator
transaction.

## Reconciliation passes

The launcher owns the whole reconciliation chain. Turnlock owns execution of one
pass.

For each owned generation, the launcher MUST:

1. build the shared runtime and skill artifacts once for the owner lifecycle;
2. launch a fresh compiled supervisor pass;
3. keep a token-fenced heartbeat while that pass runs;
4. atomically finalize the pass and decide whether to continue or stop.

Pass finalization and concurrent registration MUST serialize in SQLite.
Consequently, a racing invocation is either included in the current owner's next
pass or becomes a new owner after release; it MUST NOT be lost.

If `requested_generation` advanced during a pass, the owner MUST retain its token
and execute one fresh pass for the latest requested generation. Intermediate
generations may be coalesced because each pass rescans global repository state.

A successful final pass advances `completed_generation`. A failed pass does not
claim its generation as completed. On interruption, graceful release MUST clear
ownership without advancing completion, so a later invocation can recover and
rescan.

## Ownership fencing and shutdown

Heartbeat, pass completion, and ownership release MUST match both the owner token
and owner PID. A mismatched owner MUST fail closed rather than update another
owner's state.

The launcher MUST install `SIGINT` and `SIGTERM` handling immediately after
owner admission, cancel the build or supervisor process tree, release ownership
when possible, close SQLite, and preserve unfinished work as a pending
generation. A failed token-fenced heartbeat MUST cancel active work and MUST NOT
permit pass finalization.

## Legacy file-queue compatibility

The legacy `running.lock`, `order-*.json`, and `order-*.flag` protocol is not an
active execution path.

During compatibility admission:

- a live legacy lock MUST block the SQLite reconciler;
- stale or malformed lock residue and legacy order artifacts MUST be classified
  before any cleanup;
- cleanup MUST occur only after the SQLite request has been durably registered;
- cleanup MUST revalidate device, inode, size, modification time, and content
  digest, then atomically archive only exact observed files outside the legacy
  namespace;
- any legacy artifact added, replaced, or modified across admission MUST abort
  the new owner and remain available for inspection;
- ambiguous or unreadable state MUST fail closed and remain available for manual
  inspection.

The legacy `GCP_ORDER_IS_QUEUED` value is retained only as telemetry compatibility
metadata. It does not select a queue mode.

## Request identity and telemetry

Each invocation MUST resolve one origin identity for Antigravity, Pi, Codex,
Claude Code, tests, or direct CLI use. Explicit `GCP_ORDER_*` values override
automatic harness detection. Codex uses `CODEX_THREAD_ID` as its session ID;
Claude Code does not invent a session ID when none is available.

Telemetry failures MUST NOT block reconciliation. Events SHOULD distinguish
owner acquisition, coalescing, recovery, pass start, pass completion, and idle
release.

## Safety invariants

- Public admission occurs before every side effect.
- At most one live reconciler owns execution.
- Every invocation durably advances `requested_generation`.
- No invocation racing with pass completion is lost.
- Live owners are not stolen because of heartbeat age.
- Corrupt, incompatible, or uncheckpointed state is preserved and blocks Git
  mutation.
- Ownership is token-fenced across heartbeat, completion, and release.
- The coordinator stores no credentials, prompts, diffs, or Git remote URLs.
