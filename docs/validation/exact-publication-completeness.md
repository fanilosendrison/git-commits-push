---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "verification-record"
name: "exact-publication-completeness-counterexample"
version: "1.0.0"
status: "Active"
summary: "Historical evidence and deterministic negative qualification for Issue 18."
domain: "git-commits-push"
severity: "guideline"
---

# Exact publication completeness counterexample

## Authority and scope

Issue 18 tracks correction of an existing complete-plan obligation, already
expressed by `system-prompt.md`. The reconciliation specification owns the
current deterministic publication contract. This record preserves evidence;
it neither makes a model response authoritative nor grants release activation.
The guarantee binds the publisher's own validated source, not an external
review tree that was never supplied to the publisher.

## Historical incident

The Proto-Ring incident remains unchanged:

- Originating run: `01M6PJY9EWHNQC7JV1F0FG92E5`, release `0.9.0`.
- Expected tree: `a9126b09200b3c081e2eb28a1b60eb09859c8cea`.
- First published commit: `0f6fc8c0de604cc6a1c6d3588f35749e1643e43f`.
- First published tree: `61b88bc71eb533539d5977ffe09b252c3dc97338`.
- Corrective commit: `baf0847cbe03718ae8a4907ff7a4d883174fc8f7`.
- Corrective tree: `a9126b09200b3c081e2eb28a1b60eb09859c8cea`.

Fresh official GitHub reads confirmed those commit/tree identities and that the
correction directly follows the first publication, adding exactly the five
reported test files without removals. Neither consumer history nor source was
modified or replayed. The cause of the historical missing-file publication is not
established.

## Deterministic baseline RED receipt

The baseline source was freshly verified at main commit
`c3a8b0730fa3b51e139a36887a562fdb3ad913f4`, tree
`d3ca525ae953d1101d80badb81d1a25f3e7cb8e4`.
The actual installed launcher used immutable release
`0.10.0-cdc04f1d8f9affb10d085f6c9206b79a2830cff637d3f8f7eab8f0756a6c3c5a`.

An isolated fixture used a real repository, local bare remote and detached
linked worktree. Seven new files were staged: `a.ts`, `b.ts`, and five files
under `tests/`. Only the external provider HTTP response was replaced. Its
schema-valid Conventional Commit plan explicitly owned `a.ts` and `b.ts`, with
no duplicates or nonexistent paths. No real API key or remote model was used.

Observed identities and results:

- Original HEAD: `08ccca2409896c5e6eeaafa4eb612711c1fa10e2`.
- Validated index tree: `697a871673762f06e99f4a340c1f2b7cc515c7a7`.
- Planned files: `a.ts`, `b.ts`.
- Created commit: `1449ba80eb6680693047b8aedfd17f4ec8d93c63`.
- Produced tree: `5294b0dfec833dec350d706ebf19549da5c34165`.
- Final bare-remote ref `refs/heads/master` identified that exact commit and
  incomplete tree.
- Reported result: exit `0`, `Success`.
- Remaining source: all five test files, reported as untracked `tests/`.

The retained private receipt includes complete stdout/stderr, exact fixture
paths and repository objects. The mismatch is RED evidence, not a passing
completeness result. Exact remote identity was verified while the source tree
was incomplete.

## Regression boundaries

Source regressions exercise real Git objects, initial untracked files, complete
and omitted plans, literal special paths, deletions, renames, symlinks, unborn
HEAD, gitlinks, source races, genuine second-commit failures, partial recovery,
empty replies and witness-free historical parsing. A post-tree-check HEAD race
must not change the exact commit authorized for publication.

Compiled and isolated standalone regressions replace only the external HTTP
boundary. They require omitted-file plans to create no commits or publication,
while complete targeted, conditional-creation, ordinary and bounded-retry
controls reach the independently captured tree and exact remote SHA. Resume
fixtures preserve uncheckpointed commits, partial results and known publication
identities; reporting cannot recreate a deleted destination.

Passing these focused regressions does not replace the complete required
validation, independent exact-SHA/tree review, main CI or qualification of the
actually activated launcher. Earlier candidates and failed/interrupted commands
remain separate evidence and do not qualify a later source state.
