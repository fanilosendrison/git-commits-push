---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "procedure"
name: "git-commits-push-reconciliation-preflight"
version: "4.4.0"
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

## Installer lock refusals

Treat the source installer's lock separately from `reconciler.sqlite`. A
`SQLITE_BUSY` result alone does not prove that the PID in an old owner record is
alive: concurrent native lock promotions can both refuse before any installer
owns the lifecycle transaction.

Preserve the lock database, sidecars, owner record, and candidate evidence. A
matching live owner or indeterminate birth identity is refused before waiting.
Validated dead-incarnation recovery has a five-second native contention budget;
a changed or removed entry record is a superseded request, not authority to
install after its winner. After a refusal, inspect the current owner and retry
as a new deliberate invocation only when appropriate. Never remove records,
loosen permissions, or delete the database to manufacture progress.

Instrumentation must not open/read/close the database through unrelated file
APIs inside its owning process: POSIX descriptor closure can release that
process's SQLite locks. Observe database bytes from a separate process and keep
lock scheduling probes test-only. These installer procedures change no
reconciliation or historical-run recovery rule.

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
Hash validation and retries through the same immutable Git representation; cached
and tree-to-tree mnemonic prefixes are not interchangeable hash inputs.
Require `commitCompletion` to bind final HEAD/tree to that original tree and,
when publication was required, matching `publishedSha`. Remote identity alone
and nonempty `committedShas` do not prove content completeness.

Preserve legacy witness-free state for diagnosis. Do not resume it into new
commits or complete-success transitions, including by rerunning discovery to
stage residual files. A complete known chain may recover status only from actual
Git proof and its durable required publication evidence, never another inference
or push. For an admitted failure before the first commit, inspect `publisherIndexTreeSha`
as exact index-progress evidence only: original H0/T must remain unchanged and
foreign index/HEAD changes are not authorized. For interrupted commits, require actual
parentage/content matching the durable chain; unknown progress stops without
history rewriting. Retain both landed SHAs and any known remote publication on
failure. A terminal `commit-outcome` or `creation-outcome` reporting continuation
performs no publication. These fields do not alter reconciler schema v4 or waive
installation, active-execution, legacy-global or WAL gates. Never perform an
offline apply solely because completeness source tests passed.

## Prepared-merge inspection

Inspect the explicit `prepared-merge` scope, exact worktree/Git directory,
original first parent, sole second parent, expected complete tree, canonical
membership, index-entry digest, frozen message and existing endpoint/baseline.
The source checkpoint precedes a consumer-owned commit External Request and the
exact M checkpoint precedes the publication External Request. Check their current
SQLite-backed manifest digests and payload equality; a freed Turnlock owner alone
does not grant Git authority. The controller still fences the consumer process. Confirm the prepared-operation
policy suppresses both repository hooks and commit/push signing programs without
rewriting caller configuration. The same explicit policy must reach private-index
source proofs; post-index-change or filesystem-monitor hooks cannot replace
comparison authority T, and untracked-cache state cannot waive source inspection. An unacknowledged local effect permits recognition only of the exact current
direct child with ordered parents and matching tree/message. Foreign or further
history stops; never reset, recapture input or ask the planner for another message.
An interrupted push observes that same M and frozen endpoint before existing
bounded retries. Changed input can require FAILED while retaining proven landed
M and verified remote M; inspect these separate effects rather than treating
failure as proof of non-execution or remote SHA as complete success. Terminal prepared-merge reporting is a third no-effect External Request and never republishes.

Preserve these exact-scope runs at their canonical paths during legacy-global
cutover. Their new application fields do not change schema v4, release-integrity,
WAL, offline confirmation or ownership gates. Source integration is not activation;
qualify an isolated installed candidate and the actually activated public launcher
separately. The runtime never prepares a merge or resolves conflicts. See the
[prepared-merge contract](../specs/caller-prepared-merge-publication.md).

## Context-planning release inspection

Inspect the exact source witness, original full unconverted diff hash, complete
remaining membership and aggregate result. No partition or counter receipt may
replace H0/T or justify success from a subset. Keep generation/admission refusals
separate from preserved landed commits and verified remote effects.

Distinguish `CONTEXT_CAPACITY_PROVEN` from `PORTABLE_ATTEMPT_ALLOWED` in request
receipts. For qualified admission verify profile provenance, effective revision,
protocol/encoding, complete-request counting and explicit reserve. For portable
execution verify complete-request and wire limits, explicit output quota, exact
structured overflow evidence and shared budgets. The empty production registry
permits portable attempts, not qualified capacity claims. Synthetic profiles are
test injections only. Generic GO does not establish live operational remediation
or authorize activation. Never present exact coverage as semantic coherence.

Existing installation, legacy-global/WAL, reconciliation and immutable-release
gates remain mandatory. Generic context tests do not authorize cutover, a new
provider, an inference retry or caller publication. See
[model context planning](../specs/model-context-planning.md).

## Controlled runtime package inspection

For the source-only 0.13.1 candidate, verify the accepted local `file:` tarball
under `vendor/llm-runtime/` against its provenance SHA-256/SHA-512 and pnpm lock.
After standalone deployment, require the installed runtime's complete package
inventory to match `dist/dependency-provenance/llm-runtime.json`. The release
retains provenance, not the source tarball, and must execute without upstream
source, the preparation checkout or pnpm. Re-run DeepSeek thinking, whole-body
timeout and Mistral final-text/strict-refusal controls on the installed dependency.

This owner-authorized route does not publish npm, qualify a real provider, remove
legacy-global/WAL gates, or authorize activation of a candidate release. Keep
source integration, dependency distribution, operational requalification and host
activation as distinct decisions. Do not modify immutable historical releases.

## Evidence to retain

For an upgrade or incident record, capture:

- preflight command and exit code;
- resolved reconciliation state, Turnlock run-root, and closure-ledger paths;
- Node and Git versions;
- historical classifications and reported blocker kinds;
- operator decision and any preserved database copy;
- legacy-global dry-run and apply reports, including quarantine path;
- post-recovery output from both preflights.
