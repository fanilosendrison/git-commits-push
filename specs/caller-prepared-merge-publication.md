---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "specification"
name: "caller-prepared-merge-publication"
version: "1.0.0"
domain: "git-commits-push"
severity: "strict"
---

# Caller-prepared two-parent merge publication

## Explicit authority

Require all eight options as one atomic group:

```text
--repository <absolute exact worktree>
--push-remote <configured remote>
--push-ref refs/heads/<existing destination>
--publish-prepared-merge
--first-parent <full direct commit D>
--second-parent <full direct commit C>
--index-tree <full resolved index tree T>
--merge-message <Conventional Commit subject>
```

The message is exactly one canonical, whitespace-trimmed Conventional Commit subject accepted by the existing validator, without NUL, CR or LF; Git stores it with one terminal LF. No inference is needed or authorized in this operation. Neither planner-supplied groups nor ambient merge state can enable this mode. Reject partial groups, duplicate flags, valued booleans, equals syntax, creation flags and resume mixed with supplied authority. Resume uses only persisted `prepared-merge` scope.

The caller prepares the merge and resolves every conflict. The runtime never invokes merge, rebase, checkout repair or conflict resolution. It never creates a branch, upstream, tracking projection or persistent configuration. Historical modes refuse MERGE_HEAD before staging/reset/commit; they never consume it as implicit authority. Legacy global state remains non-executable.

## Source and admission

Before effects, prove exact canonical worktree/Git-directory identity; HEAD=D; exactly one MERGE_HEAD=C; D != C; both direct local commit objects; no unmerged index entries; materialized index tree=T. Preserve caller index bytes: no add, mixed reset or recursive submodule staging. Require the working tree to match T under the existing completeness contract. The full tree binds complete resolved index membership; retain canonical literal changed paths F from D/T and the canonical full index-entry digest as additional evidence. Propagate the prepared execution policy explicitly through private-index materialization and working-tree proofs, including read-tree, cache refresh, sparse flags and comparison. Suppress post-index-change and filesystem-monitor hooks, disable untracked-cache trust, and independently require the private comparison tree to remain T; a mutable comparison index never replaces validated authority.

Freeze an existing explicit destination and endpoint fingerprint before validation. Require its baseline to be an ancestor of D. Run the configured test gate and secret scanning against actual unconverted immutable D/T content and the complete outgoing history from the frozen baseline, including the second-parent side. Do not fetch missing proof or patch objects, honor graph masks or let attributes/textconv hide scanned input. Revalidate source after asynchronous gates. Persist original witness, parents, target, exact message and index-membership digest through Turnlock before commit creation.

The complete deterministic plan owns every member of F exactly once in one commit. No omitted, duplicate or foreign ownership is accepted. An unchanged tree is still a meaningful merge if both distinct parents and prepared state are valid; no artificial file change is required.

## Commit and interruption

Before commit, revalidate all frozen facts and the unchanged target. Freeze Git's author/committer identities and timestamps, exact HEAD reference and expected commit SHA before the source checkpoint. Compute that SHA with Git's non-writing hash-object command over the standard commit-object representation. Create exactly that object through Git commit-tree with explicit ordered D/C arguments, immutable T, frozen identities and verbatim message, independent of optional MERGE_MODE. Disable both commit signing and push signing (`commit.gpgSign=false`, `push.gpgSign=false`) and all repository hooks process-locally for prepared effects, including reference-transaction during ref installation and pre-push during every transport attempt. Commit-tree executes no commit hooks. Historical modes retain their inherited hook policy. Revalidate prepared input again before installing M with an expected-old D ref guard. Never mutate index content to produce M. Arbitrary hooks must not transform authority. This is not an exactly-once hook-execution guarantee. Independently read actual Git commit objects without replacement/graft/shallow interpretation and require exactly ordered parents [D,C], tree T and exact stored message before publication.

If interrupted before a visible commit, resume only with unchanged HEAD reference, MERGE_HEAD, index, membership, identity, endpoint, baseline and message. An existing deterministic orphan M can be recognized by the frozen SHA and actual object proof; missing local acknowledgement never authorizes a different timestamp or substitute M2. If HEAD changed, accept only frozen M as the current direct child with exactly [D,C], T and the frozen message, and unchanged validated working/index input. A foreign, reversed, additional-parent, wrong-tree/message or further descendant commit fails closed. Never search for a convenient substitute or replan. Once the exact commit M is established, checkpoint it before any push. Recovery uses M, not a newly resolved or recreated commit.

An uncertain local acknowledgement with HEAD still D and the original prepared state has no visible history progress; the unchanged before-commit authority may resume. A visible candidate must be uniquely the exact current HEAD, not an arbitrary reflog entry. Unknown progress preserves history and fails closed.

## Publication and terminal reporting

The publish continuation independently revalidates M's parents/tree/message, complete witness, current index/worktree and endpoint. After every remote observation, requalify local authority and endpoint immediately before each actual send, including bounded retries. Publish only M through the shared exact-SHA endpoint under the original baseline lease and fast-forward rules, with tag following and submodule recursion disabled. Observe the same destination after publication. A stale third SHA fails without convergence. An uncertain push must be observed before any existing bounded retry; an unobservable outcome remains failure, never blind resend. If observed exactly M, recognize the exact postcondition without a second commit or resend.

Checkpoint terminal outcome before reporting. Prepared-mode terminal qualification requires unchanged full index membership, exact HEAD reference and absent MERGE_HEAD as well as complete actual-object proof. A reporting continuation performs no Git publication and cannot recreate a later-deleted destination. Source completeness and actual final tree remain mandatory; remote SHA alone cannot establish success. If source refusal follows a proven local ref effect, retain actual M by independent raw-object/current-HEAD proof even when the changed index/worktree forbids continuation. If a source refusal follows exact remote observation, retain that verified M as publication evidence while reporting failure; never erase known effects or infer overall success from them. Successful state has HEAD=M, index/tree=T, no MERGE_HEAD and no pending source changes; unrelated refs/configuration remain unchanged.

## Durable boundary and qualification

All additional authority, witness and exact commit identity belong to one Turnlock run. Use Turnlock's existing External Request protocol for consumer-owned commit and publication effects, followed by a no-effect report request. Before effects, require the canonical request path, exact supported request type, current pending identity, manifest size/digest, digest-verified SQLite application state, matching payload and free Turnlock ownership. The surrounding live GCP execution controller, not Turnlock ownership, provides SINGLE_LIVE_GIT_EXECUTION. Re-emission is authority to reconcile the same exact request, never to invent or blindly repeat an effect. Freely executing Turnlock phases remain non-replayable; do not weaken leases or state compatibility. Map the operation to existing non-coalescing coordinator mode `targeted`; SQLite schema v4 and SINGLE_LIVE_GIT_EXECUTION are unchanged. No merge queue, unrelated history, replayable request or target payload belongs in the coordinator. Historical readers must not infer this authority.

Qualify nominal resolved overlapping histories with independent tree-entry/blob oracles, M01–M20, complete literal membership including supported file types, interruption before/after commit, lost acknowledgement, ambiguous push, source/destination/endpoint races, hostile hooks/configuration, historical modes and isolated installed public-runtime execution without source or pnpm. Preserve all failures and exact-source qualification scope. Integration and immutable activation remain separate governed gates; Review Broker #111 is never resumed by this operation's delivery task.
