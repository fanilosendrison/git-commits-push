---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "procedure"
name: "git-commits-push-reconciliation-preflight"
version: "4.2.1"
status: "Active"
summary: "Read-only inspection and recovery procedure for durable git-commits-push reconciliation state."
domain: "git-commits-push"
severity: "strict"
---

# Reconciliation preflight and recovery

## Purpose

The preflight is a read-only gate for inspecting both historical Turnlock runs
and the state directory used by the SQLite reconciler. It detects incomplete or
incompatible Turnlock runs, legacy queue residue, live or stale reconciler
owners, active or orphaned Git execution, incomplete generations, and corrupt or
incompatible databases without creating or mutating state. A separate
legacy-global preflight proves that no historical absolute resume command can
still reach a canonical global run directory.

Use it before runtime upgrades, incident recovery, or manual coordinator
maintenance. Routine public invocations perform their own fail-closed admission
checks and do not require a separate preflight.

## Command

From the dedicated source repository:

```bash
pnpm run check:node-cutover
```

This is operator tooling and intentionally remains source-only. The installed
`~/.local/bin/git-commits-push` executable exposes only the production
reconciliation workflow and never invokes `pnpm`.

To inspect the same non-default directory used by the launcher:

```bash
ORDER_STATE_DIR=/absolute/path/to/state pnpm run check:node-cutover
```

The command accepts these inspection inputs:

- `ORDER_STATE_DIR` selects an absolute reconciliation state directory. The
  default is `$XDG_STATE_HOME/git-commits-push/orders/` when `XDG_STATE_HOME` is
  non-empty, falling back to `~/.local/state/git-commits-push/orders/`.
- `TURNLOCK_RUN_DIR_ROOT` selects the Turnlock run root. The inspected directory
  is its `git-commits-push-tl/` child; the default root is `~/.turnlock/runs/`.
- `GCP_NODE_CUTOVER_CLOSURE_LEDGER` selects an absolute closure-ledger path. The
  default is `node-cutover-closures.json` in the application state container.

`ORDER_STATE_DIR` remains a compatibility name for the reconciliation state
directory.

## Legacy-global release cutover

Inspect the historical-release boundary independently:

```bash
pnpm run cutover:legacy-global-runs
```

The default is read-only. Exit `0` means every global or missing-scope run is
already physically revoked; exit `1` reports candidates or blockers; exit `2`
means inspection failed. The report includes the canonical run namespace,
quarantine, safe non-global runs, revoked runs, candidates, and blockers.

After stopping every current and historical process that could execute a resume
command, apply the cutover:

```bash
pnpm run cutover:legacy-global-runs --apply --confirm-no-live-execution
```

Apply refuses `ORDER_STATE_DIR`, because overridden launchers do not share the
default state-cutover lock. It requires idle reconciliation state, rejects
legacy locks and held Turnlock ownership, checkpoints abandoned WAL, and moves
only authoritative global or missing-scope state. The quarantine defaults next
to the Turnlock run root and can be overridden with the absolute
`GCP_LEGACY_GLOBAL_QUARANTINE` path. Source installation refuses release
activation until this inspection is ready.

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
- a live SQLite reconciler owner;
- a stale or unverifiable recorded owner;
- an active execution under a live owner;
- an unresolved orphan execution, even when its controller appears dead;
- `requested_generation > completed_generation` without an owner;
- an uncheckpointed SQLite journal or WAL state that cannot be inspected without
  mutating SQLite sidecars;
- a corrupt SQLite database;
- an unsupported SQLite schema version, including schema v2 until its explicit
  offline migration is complete and schema v3 until a writable open has
  completed the bounded idle upgrade to v4.

Any blocker means automated Git mutation must remain disabled until the state is
understood.

## Historical run classifications

Every historical Turnlock run is classified as one of:

- `drained`: a supported digest-verified authoritative state, matching
  orchestrator identity, and a final successful `orchestrator_end` event;
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
delete the historical run directory. It therefore does not prevent a historical
absolute resume command from executing. Legacy-global closure requires the
physical quarantine-and-tombstone cutover in addition to any retained decision
evidence.

## Recovery rules

1. Stop new invocations and identify whether the recorded owner PID and
   process-start identity still designate the same live process.
2. Independently inspect the active-execution token, generation, controller PID,
   process-start identity, boundary kind, and PGID. Owner death alone never
   proves execution death.
3. If an owner is alive, let it finish or terminate it deliberately; never delete
   its database while it is running.
4. If an active execution is exact and live, use normal launcher recovery to
   terminate, verify full group absence, and token-clear it. If identity is
   ambiguous, preserve state and fail closed rather than signalling a numeric
   PID or PGID.
5. Preserve a corrupt or incompatible `reconciler.sqlite` before any manual
   intervention. Checkpointed SQLite state is inspected through an immutable URI;
   journal, WAL, or shared-memory sidecars block inspection rather than being
   opened or changed.
6. Treat incomplete generations as required future reconciliation debt that the
   next exact invocation retires under the existing ownership and fencing
   rules, not as disposable queue entries.
7. For schema v2, stop all execution processes, require an idle converged row,
   and run `pnpm run migrate:reconciler-v2 --confirm-no-live-execution` only
   after proving that no old descendant survives. An idle v3 row is upgraded to
   v4 automatically by the next writable open; a non-idle v3 row stays preserved
   and requires manual inspection.
8. Review every incompatible historical Turnlock run. Add explicit closure
   evidence only after determining that it cannot contain resumable work.
9. Run the legacy-global inspection. If candidates remain, stop every historical
   resume process and run the confirmed apply command. Require the repeated
   read-only inspection to exit `0`; closure-ledger evidence alone is
   insufficient.
10. For legacy artifacts, confirm that no legacy worker is active. A normal
   launcher invocation can migrate stale residue only after it has durably
   registered a SQLite generation.
11. If the sibling `.migration-lock` directory remains after a crash or power
    loss, prove that no migration or launcher process is active, then remove only
    that empty directory with `rmdir`.
12. For full node-cutover qualification or incident recovery, run both
    preflights again and require exit `0` before re-enabling automated
    invocations through `"$HOME/.local/bin/git-commits-push"`. For a routine
    standalone upgrade, require the legacy-global inspection to exit `0` before
    installation; preserve non-global historical runs and do not add closure
    evidence solely to make the broader historical audit green.

Deleting coordinator state is a last resort. It is safe only after confirming
that no launcher, execution controller, supervisor, or pipeline descendant is
active and accepting that the next invocation starts from scratch on its own
exact worktree. Legacy incomplete generations are handled by the next exact
invocation with the existing recovery protocol: the current release fences any
preserved active boundary and retires legacy global debt without replay. No
fresh invocation scans `searchPaths`, substitutes the caller cwd for global
work, or resumes a legacy global Turnlock run.

## Conditional creation inspection

For package 0.10.0 creation runs, inspect persisted `targeted-create` authority, exact worktree/remote/destination, authorized `baseRef`/`baseSha`, observed source SHA and endpoint fingerprint. The expected destination is absence, not the source base. Confirm the full outgoing-history snapshot and exact matching publication SHA before treating a creation as successful; coordinator settlement and local commits alone do not establish publication.

Keep original creation authority on resume. Never replace it with a newly observed destination baseline. An interrupted dirty run without provable final validated identity must stop with commits preserved. Before-commit retries must retain the original raw diff/hash binding and reject changed input before inference, without resetting a raced index or increasing budgets. A recorded successful creation must not recreate a ref deleted later. Local object checks must not lazily fetch from a promisor remote; missing source-proof, dirty HEAD/index or outgoing-patch input objects require an explicit caller-owned prerequisite step. A dirty-at-base run must qualify its diff inputs even though its pre-existing outgoing sequence is empty. Shallow side boundaries and legacy grafts cannot stand in for actual parentage: qualification and patch reads suppress those masks in each Git child, preserve repository metadata and the caller's environment, and stop if required actual ancestors are missing. Creation scans and hashes use actual unconverted content, independent of ambient diff presentation; do not mistake this for repair of the legacy/default weakness tracked in Issue #20. Source progression alone is not an incident requiring convergence. Collisions, unreadable remote state and missing local proof objects require caller action, never automatic fetch, merge, rebase or rights escalation.

Qualify candidates in isolated HOME/XDG through the installed public launcher before integration and activation. The source PR and its candidate qualification do not activate a global release or compatible harness instructions. See [the creation contract](../specs/targeted-destination-creation.md).

## Exact publication completeness inspection

Inspect `validatedSource` for new commit-and-push runs: exact repository and Git
directory, original HEAD or unborn null, expected tree, changed-path membership
and required publication intent. Do not recapture a residual tree as authority.
Require `commitCompletion` to bind final HEAD/tree to that original tree and,
when publication was required, matching `publishedSha`. Remote identity alone
and nonempty `committedShas` do not prove content completeness.

Preserve legacy witness-free state for diagnosis. Do not resume it into new
commits or complete-success transitions, including by rerunning discovery to
stage residual files. A complete known chain may recover status only from actual
Git proof and its durable required publication evidence, never another inference
or push. For interrupted commits, require actual
parentage/content matching the durable chain; unknown progress stops without
history rewriting. Retain both landed SHAs and any known remote publication on
failure. A terminal `commit-outcome` or `creation-outcome` reporting continuation
performs no publication. These fields do not alter reconciler schema v4 or waive
installation, active-execution, legacy-global or WAL gates. Never perform an
offline apply solely because completeness source tests passed.

## Evidence to retain

For an upgrade or incident record, capture:

- preflight command and exit code;
- resolved reconciliation state, Turnlock run-root, and closure-ledger paths;
- Node and Git versions;
- historical classifications and reported blocker kinds;
- operator decision and any preserved database copy;
- legacy-global dry-run and apply reports, including quarantine path;
- post-recovery output from both preflights.
