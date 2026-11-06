---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "specification"
name: "targeted-destination-creation"
version: "1.0.0"
status: "Active"
summary: "Opt-in, absence-leased publication of an exact validated commit to a new remote task branch."
domain: "git-commits-push"
severity: "strict"
---

# Conditional targeted destination creation

## Authority and invocation

Require the complete existing targeted group:

```text
--repository <exact absolute worktree>
--push-remote <configured remote>
--push-ref refs/heads/<destination>
```

Without additional creation authority, preserve historical targeted-update behavior, including refusal of an absent destination. Ordinary worktree behavior and non-executable legacy global state remain unchanged. Issue #7 records that historical boundary; this contract is additive.

Require this complete additional group for creation:

```text
--create-if-absent
--base-ref refs/heads/<source>
--base-sha <full commit object ID>
```

Treat `--create-if-absent` as a presence-only boolean without a value. Reject incomplete groups, duplicate flags, missing values, `--flag=value`, a valued boolean, or any combination with `--resume`. Resume derives its authority exclusively from persisted state. Do not derive authority from ambient configuration, branch names, HEAD, absence, or environment variables. Keep parsing pure before reconciliation admission: no filesystem, Git, network or LLM access.

A fresh creation request MUST refuse a destination already present, including at the authorized base or local HEAD. To update a published branch, require a separate historical targeted invocation without creation flags.

## Separate identities

Keep these identities distinct:

- B (`baseSha`): caller-authorized immutable history boundary.
- R (`observedBaseRefSha`): source branch commit observed at admission.
- S (`validatedHeadSha`): exact final commit validated for publication.
- Destination expectation: ABSENT, never B.
- Outgoing history: all commits reachable from S and not from B, in canonical oldest-first order.

B authorizes reuse of prior history, not a retrospective audit of every commit preceding it.

## Admission qualification

Before staging, LLM planning, commits or publication:

1. Resolve exactly the caller's canonical worktree and configured remote using existing validation. Reject remote `.`.
2. Require valid distinct fully qualified `refs/heads/*` source and destination refs.
3. Require B to be a full, nonzero object ID matching the repository object format, resolving directly to a locally available commit. Reject abbreviations, revision expressions, tags and non-commit objects.
4. Resolve exactly one effective push endpoint and freeze its existing URL/rewrite fingerprint without persisting or exposing URLs or credentials.
5. Observe R from the source ref on this push endpoint, never a potentially different fetch endpoint.
6. Prove B ancestor-or-equal to R and to initial worktree HEAD. Require necessary objects locally; missing prerequisites cause a distinct diagnostic, never an automatic fetch.
7. Establish destination absence by successful exact-ref remote observation on the same endpoint.
8. Persist authority, B, source ref, R and endpoint fingerprint before commit/publication effects.

Disable implicit promisor retrieval during local proof, including initial object identification and ancestry traversal. Refuse missing patch input objects before secret scanning or publication instead of lazily fetching them. Local patch-material availability checks do not audit commits preceding B. Git replacement objects must not substitute different content for the full object identities being qualified. Qualify the exact worktree's HEAD and index inputs before staging a dirty diff; do not enumerate linked-worktree indexes. Use one canonical actual-content representation for creation scans and staged-diff hashes: ambient text conversion, external drivers, binary classification, color, path-prefix changes, rename-only elision or root suppression must not conceal relevant content. Keep submodule diffs to parent gitlink data rather than expanding child repositories. Retain the existing secret-pattern policy; these input guarantees do not establish exhaustive detection of every possible secret encoding.

Do not lock the source branch. R may already descend from B. Progression of the source after admission alone does not invalidate publication. Never refresh B silently or claim atomic observation of source and destination.

## Exact remote observation

Use one Git-layer implementation. Only successful `ls-remote` output with zero entries establishes absence. Parse complete OID/ref entries and verify the exact requested ref, not merely a first token: Git selection arguments are patterns. Reject malformed or truncated output, invalid or null object IDs, different refs, duplicates, ambiguous entries, access denial and transport errors. None authorizes creation or counts as absence.

## Validation and histories

For a dirty detached worktree, retain existing tests, staging, secret scanning and message planning; commit directly on detached HEAD. Never create a local publication branch, upstream, checkout change, tracking projection or persistent configuration.

For a clean descendant S of B, publish push-only without new commits or LLM message requests. For clean S == B, creation remains real work: publish B with an empty outgoing sequence, no artificial commit and no LLM. Only creation permits this empty publication history. Reject HEAD not descending from B. Unborn repositories or an unobservable source base are outside this extension; preserve their support in other modes.

Check and secret-scan the entire B..S, including commits present before the invocation and not just its staged diff. Reuse the canonical outgoing-history calculation. Revalidate exact HEAD, clean worktree, endpoint and outgoing set after validation and immediately before publication. A destination appearing before the first commit invalidates admission; stop preserving local work.

After commits, preserve their identity and files on push failure. Do not send produced commits through LLM replanning. Resume only when persisted evidence proves the validated identity; otherwise stop explicitly rather than inventing a binding. Never convert local commits, an empty plan, an empty result batch or coordinator settlement into creation success. Before-commit message/provider/structural retries may reuse only the original validated raw diff and hash. Refuse changed staged, unstaged or untracked input before further inference; do not reset a raced index. A structural cleanup's empty index may be restaged only when the complete raw diff still matches the original binding and no commit has landed. Preserve the existing inference cap and attempt budgets.

## Exact transport and concurrency

Use the shared Git transport only, with `pushExact(S, destinationRef, null)`: exact `S:destinationRef` and `--force-with-lease=destinationRef:`. Never bootstrap the destination at B, use a forge API, `--force`, a `+` refspec, implicit lease expectation, wildcard, `--all` or `--mirror`.

At the shared exact-push boundary, use Git-2.17-compatible `--no-follow-tags` and `--recurse-submodules=no` to neutralize ambient secondary publication. Do not mutate persistent configuration. Server rejection remains rejection; do not alter protections, rights or use another publication route.

Once S is fixed and validated:

- If the destination is absent, conditionally publish the same S.
- If observed at S, accept the verified postcondition without rewriting or claiming exclusive authorship.
- If observed at another OID T, reject the collision, even when T is an ancestor of S.
- If not observable, stop without concluding absence or success.

Keep the absence lease even after a successful absence observation. A competing writer between observation and push must not be overwritten. Git's successful or up-to-date process result is not proof this invocation created the ref. After a push attempt, reread the same destination at the same endpoint and report success only if observed exactly at S. A later observation of a different SHA does not establish the exact postcondition.

## Uncertain outcomes and bounded recovery

Reuse the existing retry budget without a new one or blind retry. After an uncertain result:

- Observe S: postcondition established; do not resend.
- Observe another OID: collision; do not resend.
- Observation unavailable: outcome indeterminate; stop retaining evidence.
- Observe absence: only an already-budgeted retry may send the same S to the same destination and endpoint under the same absence lease.

A timeout/local error does not prove remote non-execution. Do not claim exactly-once execution of remote hooks, exclusive causal attribution, remote immutability, absence of historical creation, or detection of creation followed by deletion between observations.

## Durable state and compatibility

Persist `InvocationScope.kind = "targeted-create"` and `PushSnapshot.kind = "explicit-create"`. Use a separately discriminated creation target carrying remote, destinationRef, baseRef, baseSha, observedBaseRefSha and pushUrlFingerprint. Do not encode B as destinationBaselineSha, or infer creation from an optional missing destination baseline.

Strictly validate new variants, their fields and relations to scope, repository, remote, destination and base. Reject missing, null, incoherent or cross-mode injected creation data. Creation success requires matching validated final identity and publication evidence, not a commit count. Historical update state keeps its meaning and compatibility; never default historical data into creation authority. The real baseline reader must reject the new variants before effects.

Persist creation success/failure evidence in a no-effect Turnlock outcome checkpoint before terminal reporting. Its bridge acknowledgement performs neither LLM inference nor Git work; resumed reporting must not republish. A crash before a provable checkpoint remains an explicit stop under existing Turnlock resume limits, not permission to invent evidence.

Resume preserves B and original absence authority; never recapture a current destination as an update baseline. A known successful publication must not recreate a subsequently deleted destination. Preserve established resume limits, including explicit stop when a dirty interrupted execution cannot be proven safe. Do not migrate historical runs in place or modify immutable releases.

Map targeted-create to the existing exact, non-coalescing `targeted` coordinator mode. Preserve SINGLE_LIVE_GIT_EXECUTION, unchanged arguments while waiting and existing fencing. Keep SQLite schema v4 and its bounded owner/execution records unchanged; store no creation, target or history payload there. Turnlock run state owns this authority.

## Qualification obligations

Qualify the mandate's C01–C35 matrix with real temporary repositories and bare remotes, independent state-validation oracles and the existing deterministic LLM fixtures. Preserve historical E2. Cover parsing, invalid bases and observations, source progression, dirty/clean/at-base histories, collision races, uncertain results, bounded retries, mutations after validation, full-history scanning, secondary-push suppression, concurrency, durable and historical readers, interruption, checkout isolation, server refusal, credential hygiene and false-success paths.

Exercise a genuinely installed candidate in isolated HOME/XDG through its public launcher for dirty, clean, collision and resume paths without production reliance on source or pnpm. Record executed Git versions separately from documented compatibility. Do not weaken budgets, tests, rights or validation to qualify the feature. Integration and global activation remain separate operator gates.
