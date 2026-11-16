---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "procedure"
name: "exact-release-preactivation-maintenance"
version: "1.0.0"
domain: "git-commits-push"
severity: "strict"
---

# Exact-release preactivation maintenance

## Authority and scope

Use this runbook only under a separate owner mandate identifying the exact source
commit/tree, expected current release, accepted target release, allowed maintenance
operation, invocation allowance and responsible operator. This document designs
a window; it neither opens one nor authorizes installation, checkpointing,
historical resume, provider generation or Turnlock publication.

Keep the accepted target as one complete `<version>-<64 lowercase SHA256>`
identity. Requalify changed deployment bytes under a new identity. Never reuse an
old operational GO for a different image merely because the dependency or runtime
behavior appears unchanged. Keep source acceptance, live provider qualification,
host activation and caller publication separate.

## Establish operational exclusion

1. Inventory every launch source and assign an accountable owner. Include all
   local and remote interactive shells; Pi, Codex, Claude Code, Antigravity and
   other agent sessions; session-completion/commit hooks and enforcers; wrappers,
   aliases and editor tasks; scheduled jobs, services, launch agents and cron;
   CI/remote agents with access to this host; and direct historical absolute
   orchestrator/bridge/supervisor resume commands. Include in-flight subprocesses,
   not only their visible front-end sessions.
2. Stop new work at each producer using its maintained administrative controls.
   Obtain explicit acknowledgements covering both fresh launches and historical
   resumes for the whole window. Drain or terminate existing work through its
   normal fenced lifecycle. Account for shutdown/finalization hooks that can
   themselves request publication before declaring the producer stopped.
3. Keep an operator-owned exclusion record listing each source, its owner,
   inhibited state, acknowledgement, observation time and restoration condition.
   If a source has no maintained inhibit/stop control or its owner cannot confirm
   exclusion, do not open the window. Do not invent an application marker and
   assume historical entrypoints honor it.
4. Reinspect process identities, parentage, start identities and groups with
   bounded maintained observations. Inspect the reconciler singleton, execution
   descriptor, legacy locks/orders, Turnlock ownership and installer records.
   Distinguish absence from unreadable, dead-but-recorded or ambiguous state.
   Never signal an unproven numeric PID/PGID or clear a token to manufacture idle.
5. Observe database/sidecar handles and competing installer/cutover processes.
   Treat `ps` and `lsof` as snapshots, not as an exclusion mechanism. Require idle,
   converged reconciliation, no incompatible ownership, no live execution and no
   unresolved identity. A disappearing front-end is not descendant death proof.
6. Keep all producer inhibitions in force through backup, any separately allowed
   apply, reinspection, pinned installation and independent postflight. If an
   acknowledgement expires, an actor starts, or state changes unexpectedly, stop.
   Do not reopen producers while an execution or installation outcome is unknown.

## Official lock boundaries

Do not acquire an improvised outer lock or remove official lock records.

The official apply command acquires the shared application-state cutover lock,
checks idle reconciliation and enforces its own ownership/path rules. Default
launcher admission honors that lock. Historical absolute entrypoints are not
universally governed by it; external producer exclusion remains necessary.

The installer separately holds its lifecycle SQLite exclusive transaction and
nonce/PID/process-start owner record during deployment and activation. It refuses
competing live/indeterminate owners. Neither lock replaces the other. The apply
command releases its lock before returning: external exclusion must bridge the
interval through subsequent inspection and installation. Do not hold that lock
manually and then bypass the official apply command's acquisition.

## Inspect without granting new authority

Use the exact accepted source checkout and its prepared development dependencies.
Record commands, environment path selections, exits and complete reports:

```bash
pnpm run check:node-cutover
pnpm run cutover:legacy-global-runs
```

Distinguish the broad historical audit from the routine installation gate.
Preserve terminal non-global history; do not add closures merely to make the
broad audit green. Do not mislabel every broad diagnostic as terminal.

If the legacy-global inspection is ready, do not perform historical maintenance.
If it is not ready, establish the precise blocker and its owning authority.
Zero identified candidates does not classify WAL-blocked authorities as safe.
Never derive scope or terminality from an old `state.json` projection, a free
owner, lease age, process absence or a filename.

The prior activation report observed 46 WAL blockers and 39 `ctime` differences.
These are historical observations, not a current allowlist or fixed expected
count. Require fresh accepted evidence for every affected identity. Respect #14's
results: SQLite recovery, Backup and a valid recovered prefix/digest do not prove
that a committed authority-changing WAL suffix was never lost. Do not add a
private-copy reader, checksum parser or completion registry as substitute
installation authority. An unqualified or unknown state remains a stop.

## Preserve preimages before any separately authorized apply

Only after exclusion is established, inventory physical canonical/quarantine
paths, run identities, every main DB and present WAL/SHM/journal, owner/lock files,
state projections, artifacts and logs. Record file types, modes, owners, links,
inodes and available timestamps separately from byte hashes. Reject hostile,
changing or indeterminate inputs. Do not open originals through a writer or a
read-only connection that may create sidecars while taking backups.

Capture complete private preimages using the host's maintained backup facility,
including sidecars and all run contents, not the main SQLite file alone. Verify
backup membership, bytes, modes and links against the quiescent capture; retain
source metadata observations and the backup's different storage identities.
Protect private prompts, credentials and logs. A backup is evidence, not authority
to replay a run or restore over concurrent work.

Do not describe a stat-before-hash traversal as an atomic filesystem snapshot.
If copying/hash observation changes or cannot establish capture coherence,
preserve that failure and stop the proposed mutation until its required
preimage guarantee is established. Never restore timestamps to make a comparison
pass.

## Conditional official apply

Do not execute an apply from this runbook without a distinct owner authorization
and its invocation allowance. Require every cumulative condition in that mandate,
including accepted run-scope evidence, no restored global/missing-scope candidate,
no corrupt/ambiguous state, verified preimages and continuing external exclusion.
Only then may the authorized operator invoke the existing procedure:

```bash
pnpm run cutover:legacy-global-runs --apply --confirm-no-live-execution
```

Do not supply `ORDER_STATE_DIR` to bypass its refusal. Do not manually checkpoint,
delete sidecars, move runs or edit SQLite. Preserve the actual outcome and every
file changed. An unexpected blocker, failure or indeterminate result stops the
window; do not repeat an exhausted apply opportunity.

Re-run both read-only inspections. Require zero installation blockers and zero
global candidates before installation. Verify original run/incarnation identities,
scope, revisions, state digests, exact-run canonical locations and revocation
paths using accepted authority, not projections. Attribute physical main/WAL/SHM
changes only to effects supported by the official result and retained evidence.
A successful maintenance workaround does not resolve #14 or authenticate a lost
historical transaction.

## Pinned installation after acceptance

Do not execute placeholders. Obtain the target's complete release name from
independently qualified deployment evidence, not from the installer currently
being authorized. Under the separate installation mandate, keep exclusion active
and use the single official installer:

```text
pnpm run install:standalone --expected-release <ACCEPTED_VERSION-FULL_SHA256>
```

The supplied pin binds both version and digest. The installer snapshots it,
validates deployment/provenance under its native lock, refuses a different image
before promotion and verifies the actual named target before switching `current`.
Unknown/repeated CLI options refuse. Generic installation without this option
remains compatible, but does not satisfy an exact-release mandate. Do not omit the
pin after refusal, select the newly computed name instead, edit a symlink or use
a lower-level activation helper as an alternative installer.

The cooperative installer lock and immutable-image contract do not establish a
security boundary against arbitrary code running as the same OS user. Keep the
external actor exclusion and release-store protections applicable throughout.

## Postflight and release of the window

Independently read public/current links, physical executable, package version,
complete release digest, accepted runtime inventory/provenance and lock state.
Require the active identity to equal the authorized pin, not merely an installer
exit zero. Preserve every older release.

Run separately authorized zero-provider public-launcher controls only in isolated
HOME/XDG/state/Turnlock namespaces and synthetic Git repositories. Deny model
transport, observe actual child release resolution and prove controller-group
absence and coordinator settlement. Do not invoke publication on a real worktree
or resume historical runs. Do not relabel earlier Mistral/Google qualification as
a new host generation. Fixture WAL residue is not permission for another apply.

Record final state, exact effects, preservation results and any rollback decision.
Use only an independently safe, separately authorized maintained rollback path;
never blindly replace a pointer or delete the new release. Restore producers only
after the responsible operator accepts the complete postflight or an explicitly
safe stopped disposition. Hand off unresolved states without reopening them.

## Historical `ctime` assessment

The retained inventories agree on their observed bytes, modes, links and inodes,
but 39 WAL `ctime` values differ. Preserve `CAUSE_UNDETERMINED`. Neither corruption,
a read, `lsof`, another actor nor a filesystem mechanism is established as cause.
Keep the original failed strict metadata comparison; byte equality does not turn
it into a successful metadata-preservation result.

A global unchanged-`ctime` condition is not part of release identity: the maintained
release digest binds paths/types/executable modes/bytes/links, not timestamps.
The SQLite inspector separately requires its own within-inspection fingerprint
stability, including `ctime`; keep that fail-closed check unchanged. Thus the old
cross-inventory difference alone neither proves an installation defect nor waives
fresh coherent inspection, trusted preimages or exclusion. If a particular owner
mandate requires full physical metadata continuity, report that requirement as
unproven rather than silently weakening it. Do not infer continuous preservation
from two agreeing endpoint hashes.
