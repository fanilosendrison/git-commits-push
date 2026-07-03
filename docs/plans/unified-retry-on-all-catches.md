# Plan — Unified Retry on All Catches

**Status**: Draft (pending implementation) — revised after hostile review
**Author**: AI assistant + user collaboration
**Target skill**: `git-commits-push-tl` v0.2.0
**Created**: 2026-07-03
**Revised**: 2026-07-03 (round 2 — fixes for C1, C2, C3, C5, D2, D5, D6, M1, M2, M5, M8)
**Revised**: 2026-07-03 (round 3 — fixes for R1-R25 hostile review findings)
**Revised**: 2026-07-03 (round 4 — fixes for R26–R55 hostile review findings: 6 critical, 7 high, 10 medium, 7 low)
**Revised**: 2026-07-03 (round 5 — fixes for R57–R66 hostile review findings: 3 critical, 7 high)
**Revised**: 2026-07-03 (round 6 — algorithmic fixes for R73–R75: worktree data loss, dirty staging on retry failure, path normalization gap)
**Revised**: 2026-07-03 (round 7 — spec discipline cleanup: strip implementation-level details, document the spec/implementation boundary)

---

## Spec discipline

This document is a **behavior specification**, not an implementation plan. It locks:

- **Desired behavior** — what happens when X (architectural decisions, error taxonomy, retry semantics)
- **I/O contracts** — type definitions for inputs and outputs (`RepoState`, `Feedback`, `FeedbackError`, etc.)
- **JSON schemas** — validation contracts for state and payloads (`stateSchema`, `commitPlanSchema`)
- **Pseudocode** — algorithmic intent for non-trivial behaviors (`queueRetry`, `classifyError`, publisher loop)

It does NOT lock:

- Module structure, import paths, or file layout
- Environment variables, command-line tools, or CI steps
- Code style (`try/catch` patterns, `async/await` choices, library preferences)
- Test organization (file paths, test runner choice, test ID numbering)

Implementers are free to choose any structure that satisfies the contracts above. Changes to implementation details do NOT require updates to this spec; changes to behavior or contracts do.

---

## Round 3 changes (hostile review R1–R25)

This revision addresses the issues raised in the hostile review of the round 2 plan. Each fix references the review ID.

| Review ID | Severity | Fix location | Summary |
|---|---|---|---|
| R1 | High | §7.1, §7.4b, §7.4c, §7.4d, §8 | Test IDs U-GE-22–U-GE-40 now defined; DoD references match test plan |
| R2 | High | Phase 2 (`RepoState`) | `commit?: CommitMessage` → `commits?: CommitPlan[]` (aligned with stateSchema) |
| R3 | Medium | Decision 10 | Corrected the "double reset on failure" rationale; failure path resets once in catch, success path resets once after commit |
| R4 | Critical | Phase 4 (`queueRetry`) | `queueRetry` is now pure: returns `{ kind, repoState, job? }` instead of mutating `repoState` |
| R5 | Critical | Phase 4 (loop detection) | Removed `__LOOP_DETECTED__` string sentinel; loop-detected is a discriminated union variant |
| R6 | Critical | Phase 4 (`queueRetry`) | `pendingFiles` filtered against `committedShas` (both `repoState` and `options`) before re-staging |
| R7 | High | Phase 4 (`commit-and-push`) | LLM-side failures (`result.success === false`) classified by signature via `classifyLLMFailure`; fail-closed for unknown |
| R8 | High | Phase 3 (catch block) | Catch-block reset uses `gitExec` (honors `GIT_TERMINAL_PROMPT=0`) with logged-but-non-fatal failure |
| R9, R23, R24 | Critical | Phase 4 imports | Added `crypto` and `execSync` imports (loop detection and diff capture) |
| R10 | High | Phase 3 (push) | Inner push-upstream classifies transient vs permanent via `classifyTransient`; auth errors fail-closed |
| R11 | High | Phase 4 (`queueRetry`) | Loop detection hashes canonical plan structure (sorted files, normalized commit fields), not formatted messages |
| R12 | Medium | Phase 1 (`CommitPlanErrorKind`), §3, `getResolutionHint` | Removed dead `uncovered-file` kind (no publisher path threw it; no test covered it) |
| R14 | Medium | §5 (file impact), Phase 8 (reporter update) | Reporter updated to surface `committedShas`, per-kind `attempts`, loop-detected failures |
| R15 | Low | Decision 9 | Corrected rationale: queue persists across phase boundaries, not because of helper visibility |
| R16 | High | Decision 13, Phase 4 (`classifyError`) | Empty-plans + non-empty `committedShas` = SUCCESS (no structural retry consumed) |
| R18 | High | Phase 8 smoke test 5 | Updated trigger: hook failure instead of nonexistent file (which goes to `nonexistent-file` via M8) |
| R20 | Medium | Decision 11, Phase 4 (`queueRetry`) | `feedbackHistory` capped at `MAX_FEEDBACK_HISTORY = 10` entries |
| R22 | Low | (no change) | `attemptCountFor`/`bumpAttempt` kept — minor indirection is acceptable for testability |

Open (not addressed in round 3, deferred):

- **R17** (phase deployment ordering): the plan still assumes atomic deployment of Phases 1–6. A feature flag is not in scope.
- **R19** (counter asymmetry between validation and other kinds): the asymmetry is intentional (validation can re-fire after a structural retry); no code change needed.
- **R25** (`executeCommitAndPush` singular tests): the legacy path stays as-is. Existing tests U-GE-06–U-GE-11 continue to pass without modification.

---

## Round 4 changes (hostile review R26–R55)

This revision addresses the issues raised in the round 4 hostile review. Each fix references the review ID.

| Review ID | Severity | Fix location | Summary |
|---|---|---|---|
| R26 | Critical | Decision 9, Phase 4 | `retryJobs` invariant documented: Turnlock must guarantee single-instance `commit-and-push` execution; if not, queue must move to phase-input/output state |
| R27 | Critical | Phase 4 (`classifyLLMFailure`) | Comments narrow the contract; signature list scoped to known LLM bridge error strings; documented extension point |
| R28 | Critical | Phase 4 (`queueRetry`) | Re-staging checks `git diff <file>` (worktree vs index) before `git add`; refuses to overwrite if worktree differs from the version captured at diffHash time (data-loss guard) |
| R29 | Critical | Phase 4 (`queueRetry`) | `feedbackHistory` entries capped at `MAX_FEEDBACK_ENTRY_BYTES = 16 KB`; oversized entries truncated with a `[truncated]` marker |
| R30 | Critical | Phase 4 (`stateSchema`) | `attempts` schema tightened to `z.record(z.string(), z.number().int().nonnegative())` |
| R31 | Critical | Phase 1 acceptance | Import direction documented: `errors.ts → types.ts → git-publisher.ts → turnlock-orchestrator.ts`; reverse edges forbidden |
| R32 | High | §7.4c | Defined U-GE-34–U-GE-37 for LLM-side failure classification |
| R33 | High | §8 smoke test 5 | Rewritten to use a single coherent scenario (hook-based partial-commit failure) |
| R34 | High | Phase 3 (`PERMANENT_PUSH_SIGNATURES`) | U-GE-24/U-GE-25 rewritten to use REAL git output strings captured from CI fixtures (no longer chosen-by-author substrings) |
| R35 | High | Decision 13 | Empty-plans-success now requires the LLM response to include a `done: true` marker; bare `[]` without marker is treated as a structural failure |
| R36 | High | Phase 4 (diffHash reset loop) | Reset loop now uses immutable updates (`{ ...r, attempts: {}, ... }`) consistent with the rest of the phase body |
| R37 | High | §6 (migration shim) | Shim code stub added; Zod schema accepts legacy `attempts: number` via preprocessor and zeroes it |
| R38 | High | Phase 4 (helpers) | `bumpAttempt` / `attemptCountFor` removed; callers use direct access (`(repoState.attempts?.[kind] ?? 0) + 1`) |
| R39 | Medium | §5 / Phase 8 (reporter) | Reporter interface stub added (new test U-GE-41) |
| R40 | Medium | Phase 4 (queueRetry, classifyError) | `process.stderr.write` logging added for retry decisions (kind, attempt, diffHash, repoId) |
| R41 | Medium | Phase 4 (`queueRetry`) + Phase 2 (`CommitJobPayload`) | Local variable in `queueRetry` renamed `diff` → `remainingDiff` for readability; `CommitJobPayload.diff` field name preserved (it is set by the diff-capture phase, out of scope). `CommitJobPayload.diff` semantic documented: full staged diff on first attempt, reconstructed remaining-work diff on retries (Decision 6). JSDoc added to the field. |
| R43 | Medium | Phase 4 (`classifyError`) | Return type changed to discriminated union `{ kind: "retry" | "fail", error: FeedbackError } | { kind: "success" }` |
| R44 | Medium | Decision 11 | `MAX_FEEDBACK_HISTORY` tied to `MAX_ATTEMPTS_BY_KIND` (≥ sum of max attempts across kinds, default 5) |
| R45 | Medium | §6 (pre-merge check) | `rg "committed_shas\|committedShas" --type ts` instruction added as a DoD gate |
| R46 | Medium | Phase 3 (`git-utils.ts`) | `gitExec` extraction code added; env-var contract documented (`GIT_TERMINAL_PROMPT=0`, `GIT_ENV`) |
| R47 | Medium | Phase 4 (validator) | Validator missing now throws by default; `settings.allowMissingValidator` flag bypasses for tests |
| R48 | Medium | Phase 4 (`stateSchema`) | `attempts` keys constrained to the 5-kind union via a refinement (`.refine` on the record) |

Open (not addressed in round 4, deferred):

- **R42** (Decision 9 rationale wording): the substance of the rationale (queue persistence across phase boundaries) is preserved; R26 strengthens the invariant. No further change.
- **R49** (`__LOOP_DETECTED__` sentinel trace): the sentinel was a code-level magic string removed by R5; no state-level migration needed.
- **R50** (`execSync` runtime availability): Turnlock phase environment confirmed at integration-test time; not blocking the plan.
- **R51**–**R55**: minor wording/import-style issues; documented as TODO comments in the implementation phases but not blocking the plan.
- **R56** (hostile review edge-case question, round 4.5): path normalization in the duplicate-file guard. **Status: addressed inline below.**

---

## Round 5 changes (hostile review R57–R66)

This revision addresses the issues raised in the round 5 hostile review. Each fix references the review ID.

| Review ID | Severity | Fix location | Summary |
|---|---|---|---|
| R57 | Critical | Decision 13, Phase 4 (`classifyError`), Phase 6 (system prompt), Phase 7 tests, smoke test 7 | The `done: true` marker is dropped. The success path for empty-plans is now purely based on `committedShas.length > 0` (R59 ensures the merge into `repoState.committedShas` happens for both `PartialCommitError` and `CommitPlanError` paths). Bridge, system prompt, and publisher are now consistent. `lastLLMResponse` field is removed. |
| R58 | Critical | Phase 4 (`stateSchema`) | Top-level `diffHash: z.string().optional()` added to `stateSchema`. The reset loop now correctly detects diffHash changes via `r.diffHash !== state.diffHash` (previously `state.diffHash` was undefined, wiping counters on every phase entry). |
| R59 | Critical | Phase 1 (`CommitPlanError`), Phase 3 (publisher catch block), Phase 4 (orchestrator catch block) | `CommitPlanError` gains an optional `context: { committedShas?, pendingFiles? }` field. Publisher populates it for mid-loop structural errors (`missing-file`, `nonexistent-file`). Orchestrator merges `err.context.committedShas` into `repoState.committedShas` for BOTH `PartialCommitError` and `CommitPlanError` paths. |
| R60 | High | Phase 3 (publisher), Phase 7 tests, Phase 8 smoke tests | `PERMANENT_PUSH_SIGNATURES` is now loaded from `src/modules/push-signatures.json` (fixture-based). Production code reads the same file the tests use. Hand-authored substrings removed. |
| R61 | High | Decision 10 (rationale text) | Inter-commit reset rationale corrected: `git add` on unchanged files is a no-op, so the reset is a safety measure for user mid-stream staging, not a correctness measure for the typical case. |
| R62 | High | Phase 4 (`RepoState`), Phase 8 (reporter) | `RepoState.loopDetected?: { kind, planHash }` added as a first-class field (not regex-extracted from error). The reporter reads it directly. The regex-based extraction is removed. |
| R63 | High | §6 (migration shim), Phase 7 (new sub-phase 7.6) | `state-loader.ts` is now an explicit Phase 7.6 deliverable. The shim handles both legacy `attempts: number` AND legacy `commit?: CommitMessage` (drops the latter silently). |
| R64 | High | Decision 12 (loop detection limitation) | Loop detection limitation documented: catches CONSECUTIVE identical plans only. Alternating plans (A-B-A-B) are not detected. |
| R65 | High | Decision 11, Phase 4 (`queueRetry`) | New `MAX_FEEDBACK_TOTAL_BYTES = 64KB` constant. `previous_commit` (the joined history sent to the LLM) is truncated at this boundary with a trailing `[truncated]` marker. Protects small-context LLMs. |
| R66 | High | Phase 5 (bridge) | Bridge imports `FeedbackError`, `CommittedSha`, `Feedback`, `CommitJobPayload` from `src/types.ts` instead of redeclaring them locally. Drift risk eliminated. |

Open (not addressed in round 5, deferred):

- **R67** (queueRetry path normalization in committedFiles filter): the `pendingFiles` filter in `queueRetry` (R6 fix) does not normalize paths via `path.posix.normalize()`, unlike the publisher's duplicate-file guard (R56). Syntactic variants (`src/./foo.ts`, `src/foo.ts/`) pass through. Acceptable for V1; documented as follow-up.
- **R68** (Phase 4 phase body size): the 150-line `commit-and-push` phase body mixes many concerns. Splitting into helpers (`handleValidationFailure`, `handleExecutionFailure`) is a refactor task, not a design change.
- **R69** (R26 integration test for Turnlock single-instance guarantee): the integration test is required before merging Phase 4 but is not yet defined in Phase 7. Follow-up.
- **R70** (`Settings` interface documentation): the plan uses `settings.provider`, `settings.model`, etc. without defining them. Add to a new "Dependencies" section. Follow-up.
- **R71** (Turnlock API documentation): `definePhase`, `io.*`, `readSettings`, `formatConventionalCommit` are used but not documented. Add to "Dependencies" section. Follow-up.
- **R72** (`commitPlanSchema` and `commitJobResultSchema`): referenced in `stateSchema` and `io.consumePendingBatchResults` but not defined. Implementation gap.

---

## Round 6 changes (hostile review R73–R75)

This revision addresses three algorithm bugs identified in the round 6 hostile review. Unlike prior rounds, these fixes correct **behavioral bugs in the spec itself** — the described algorithm is incorrect, not just missing rationale or features. Each fix is mechanical (~10 lines of diff total) and addresses a failure mode that would manifest in production.

| Review ID | Severity | Fix location | Summary |
|---|---|---|---|
| R73 | Critical | Phase 4 `queueRetry` (worktree guard) | The `if (worktreeVsIndex && inIndex)` condition from R28 only preserves worktree edits when the file is already staged. The case "worktree dirty, not staged" silently falls into `safeToRestage` → `git add` overwrites the unstaged edits with the index version (the committed content) → **data loss**. Fix: preserve worktree whenever `worktreeVsIndex` is non-empty, regardless of `ls-files` status. |
| R74 | Critical | Phase 3 publisher catch block + Phase 4 orchestrator catch block | R8 made `git reset HEAD` failure "logged but non-fatal". If the reset fails (index lock, hook, etc.), staging remains dirty after the catch block. The orchestrator queues a retry whose `git add` is a no-op on already-staged files → the next commit silently includes the failed plan's files. Fix: publisher reset becomes fatal (`GitExecError`); orchestrator retries the reset before `queueRetry`. |
| R75 | High | Phase 4 `queueRetry` (R6 filter) | Path normalization is inconsistent: publisher uses `path.posix.normalize()` (R56) for the duplicate-file guard, but `queueRetry`'s `committedFiles` filter uses raw string comparison. A `pendingFile` like `src/./foo.ts` is not filtered out even if `committedShas` contains `src/foo.ts`, so the LLM receives a path already committed → `git add` is a no-op → `git commit` reports "nothing to commit" → retry deterministic-fails. Fix: apply `path.posix.normalize()` to both sides of the filter, mirroring R56. Promotes R67 from follow-up to fixed. |

No items deferred. The round 6 hostile review surfaced three algorithm-level bugs; the remaining critiques (over-engineering of byte caps, mechanism/feature imbalance, follow-up documentation gaps) are design-level discussions, not algorithm bugs, and are tracked separately.

---

## Round 7 changes (spec discipline cleanup)

This revision aligns the document with the spec discipline declared above (locks behavior, contracts, schemas, pseudocode; does NOT lock imports, paths, env vars, CI steps, code style, test organization).

| Category | Removed | Rationale |
|---|---|---|
| Import statements | All `import { ... } from "..."` lines, `with { type: "json" }` assertions, `node:crypto` / `node:child_process` references | Module structure is implementation |
| File paths | `src/modules/push-signatures.json`, `scripts/capture-push-signatures.ts`, `tests/fixtures/push-auth-error.txt`, `tests/unit/queue-retry.test.ts`, etc. | File layout is implementation |
| `__dirname` walks | `path.resolve(__dirname, "../../../../../agent-enforcers/...")` | Relative path resolution is implementation |
| Env-var specifics | `GIT_TERMINAL_PROMPT=0`, `GIT_ENV`, `LC_ALL=C` | Env vars are implementation (the contract — "no credential prompts" — is kept) |
| CI commands | `madge --circular`, `rg "committed_shas\|committedShas" --type ts`, `bun run typecheck`, `bun test` | CI steps are implementation |
| Migration shim implementation | The 50-line `state-loader.ts` code block | Behavior is kept ("legacy `attempts:number` → zeroed, legacy `commit` field → silently dropped"); code is removed |
| File impact summary | The §5 table listing every file with Phase column | File inventory is implementation; the contracts remain in the pseudocode |
| Test file paths | `tests/unit/git-publisher.test.ts`, `tests/invariants/i3-parallel-isolation.test.ts` | Test organization is implementation; the test ID list (U-GE-NN) and behavior descriptions remain |
| `execSync` vs `gitExec` mixing | Style-level explanations of when to use which | Code style is implementation |
| Capture scripts | `scripts/capture-push-signatures.ts` and its runtime description | Internal tooling is implementation; the contract ("signatures loaded from a fixture, sorted by specificity") is kept |

No behavioral changes. No new tests. No deferred items. The pseudocode, type definitions, schemas, decision tables, error taxonomy, and review-fix tables are unchanged in substance — only stripped of implementation-level detail.

---

## Round 8 changes (escalation channel)

This revision closes the architectural hole identified during design review: the skill currently fails-closed when the retry budget is exhausted, with no structured context for the parent agent to act on. Round 8 adds a second layer — **deterministic retry handles the 90% of cases it can solve; the parent agent handles the 10% where semantic understanding is required**.

| Category | Addition | Rationale |
|---|---|---|
| Decision table | Decisions 14, 15, 16 | Lock the new terminal state, the budget-reset semantics, and the feedback-format reuse |
| `RepoState.status` union | New value `"ESCALATED"` | Distinct terminal state from `FAILED` (which remains as "abandoned, no agent handoff") |
| `EscalationContext` interface | New I/O contract | Structured data emitted when the retry loop is exhausted |
| `Feedback` interface | Two optional fields: `recommended_action`, `loop_detected` | Allows the agent to pass escalation context as initial feedback without changing the bridge rendering |
| `ExecuteCommitsInput` interface | New optional field `escalationHint?: EscalationContext` | Lets the parent agent re-invoke the skill with a fresh budget and prior context |
| `formatEscalationAsFeedback()` | New helper pseudocode | Maps `EscalationContext` to `Feedback` (field-by-field copy) |
| `reconstructRemainingDiff()` | Refactored from `queueRetry` to a shared helper | Used by both mid-loop retries and escalation re-invocations |
| `executeCommits` pseudocode | New `if (escalationHint)` branch | Behavior contract for escalation re-invocations |
| Agent-side contract note | Out-of-scope section | Documents what the skill guarantees vs what the agent decides |
| Test U-GE-47 | Escalation re-invocation scenario | Validates the new behavior end-to-end |

The LLM sees **the same system prompt and the same feedback rendering** as today. No changes to the bridge, the system prompt, or the LLM-facing surface. Round 8 only changes what happens at the boundaries: an `ESCALATED` terminal state and an `escalationHint` input. The LLM treats both the same way it treats a mid-loop retry today.

---

## 1. Goal

Currently, only **validation errors** (Conventional Commits format violations) trigger an LLM retry via `feedback`. All other catches (duplicate-file guards, git execution failures, push errors, partial commit failures) are fail-closed: the error is stored in `RepoState.error` and the repo is marked `FAILED` with no second chance.

This plan extends the retry mechanism to **all LLM-recoverable error categories** and adds **partial commit instrumentation** so the LLM can recover even after some commits have landed in history.

### Non-goals

- No automatic rollback (`git reset --hard`) — too destructive.
- No per-plan validation mid-loop — guards stay before any `git commit`.
- No E2E tests with mocked Turnlock — unit + integration fixtures only.
- No `onProgress` callback in the publisher API — return value is sufficient for V1.

---

## 2. Architectural Decisions (locked)

| # | Decision | Rationale |
|---|----------|----------|
| 1 | **Max attempts per kind**, default 1 for all retryable kinds. Counter is **per-kind, per-diffHash**, not global. | A global counter means one kind's retry budget can be consumed by another's error (e.g. `validation` retry burns the budget for a later `structural` retry). Per-kind counters also reset cleanly on a new diff. |
| 2 | **`git reset HEAD`** (mixed) runs after each commit (between plans) AND on partial commit failure (catch block). | Non-destructive, preserves already-committed work, keeps unstaged changes for retry. NOT run at the start of the publisher (see Decision 8) — only between/after plans, never before the loop. |
| 3 | **`committed_shas`** items are `{ sha, files: string[] }[]`. SHAs stored full-length, sliced to 7 chars **at display time only**. | The LLM has no git access in its batch context — passing only SHAs makes the feedback "DO NOT re-include these files" unactionable. File lists are small (a handful of paths per commit) and necessary for the LLM to plan the remaining work. |
| 4 | **No `onProgress` callback**, publisher returns `{ committedShas, originalHead, pendingFiles? }`. `pendingFiles` is present only on `PartialCommitError`. | YAGNI — no caller needs streaming progress; signature can be extended non-breaking later. `pendingFiles` is the source of truth for "what's left" — see Decision 6. |
| 5 | **Tests = unit + integration fixtures**, no E2E mock | Best ROI; mocking Turnlock is brittle; manual smoke test validates end-to-end flow. |
| 6 | **`remaining_diff`** (LLM-facing) is **reconstructed** from `pendingFiles` (publisher-provided) by re-staging them temporarily and capturing `git diff --cached`, NOT from `git diff originalHead`. | `git diff originalHead` returns the *committed* content, not the remaining work. The publisher knows which files were in `plans[failedIndex..end]` that never got committed — that is the only reliable source. Re-staging pendingFiles + capturing diff + resetting leaves the repo clean while giving the LLM the actual diff content of the remaining work. |
| 7 | **`attempts`** is keyed by `diffHash` AND `kind`. New `diffHash` → fresh counter. | Otherwise a successful retry on day 1 exhausts the budget for unrelated errors on day 2 (same `RepoState` reused). |
| 8 | **No leading `git reset HEAD`** at the start of the publisher. The publisher stages per-plan via `git add` and resets between commits (Decision 10). | A leading reset silently destroys user pre-staging. Per-plan `add` is NOT consumed by `git commit` — `git commit` does not modify the index, so files remain staged after each commit and bleed into subsequent commits unless reset. |
| 9 | **`retryJobs`** lives at module scope (single queue) — Phase 4 helper functions push into it. **Invariant**: Turnlock must guarantee that a single `commit-and-push` phase instance runs at any given time per worker. The `retryJobs.length = 0` reset at phase entry is safe only under this invariant; if two instances ever interleave, the reset destroys the other instance's queued jobs (R26 landmine). | The queue must persist across phase boundaries: `commit-and-push` reads `retryJobs` after `consumePendingBatchResults` to decide whether to delegate again. A local-scope queue is destroyed when the phase function returns. **Fallback if Turnlock does NOT guarantee single-instance execution**: stash the queue on `nextRepos[id].__pendingRetry = { id, prompt }` and return it via `io.delegateAgentBatch` input state, eliminating the module-scope mutable state. The integration test for `commit-and-push` must assert the invariant before merging Phase 4. |
| 10 | **`git reset HEAD`** is run **after each successful commit** in the publisher loop. On failure, the catch block already resets before throwing `PartialCommitError` (no second reset runs because the throw exits the inner `try`). | R61 fix: the original rationale overstated the necessity. After `git commit`, the index matches HEAD; `git add <file>` on an unchanged file is a **no-op**. So plan N's files do NOT bleed into plan N+1's commit in the typical case. The inter-commit reset is a **safety measure for user mid-stream staging**: if the user staged new changes to plan N's files between commits, the reset clears those user changes from the index; without the reset, the next `git add` doesn't re-add them (already staged), and `git commit` includes them. Failure-path reset lives in the catch block (Decision 2). |
| 11 | **`feedbackHistory`** is capped at `MAX_FEEDBACK_HISTORY = 10` entries by default, each entry is capped at `MAX_FEEDBACK_ENTRY_BYTES = 16 KB` (R29), AND the joined `previous_commit` string sent to the LLM is capped at `MAX_FEEDBACK_TOTAL_BYTES = 64 KB` (R65). `MAX_FEEDBACK_HISTORY` defaults to `Σ MAX_ATTEMPTS_BY_KIND` (sum of max attempts across all 5 kinds = 5 by default); the explicit `10` is a safety floor that allows future per-kind budget bumps (R44). On overflow at the entry layer, the oldest entry is shifted off. On overflow at the entry byte layer, the entry is truncated with a `[truncated]` marker. On overflow at the total layer, the joined string is truncated with a trailing `[truncated]` marker. | Each retry appends the full failed plan as a string. With `MAX_ATTEMPTS_BY_KIND` configurable (Follow-up #1) and bumped to e.g. 5 per kind, a multi-retry path could serialize hundreds of KB into Turnlock state. Capping bounds the state size and protects resume performance. The LLM still sees the most recent history, which is what matters for context. **Per-entry byte cap (R29)**: a single plan with thousands of files can serialize to >100 KB; without a per-entry cap, one bad plan poisons the whole history. **Total byte cap (R65)**: 10 entries × 16 KB = 160 KB exceeds small-context LLMs (8K tokens ≈ 32 KB). Truncating the joined string at 64 KB protects context budgets while preserving the most recent history. |
| 12 | **`lastPlanHash`** is a sha256 of the **plan structure** (canonical JSON of `{commit, files}[]`), NOT the formatted commit messages. **Limitation (R64)**: loop detection catches **consecutive** identical plans only. If the LLM alternates between two plans (A-B-A-B-A-B), neither matches the previous, so detection never fires. Acceptable for V1; documented as follow-up (R67). | R11 hostile review: hashing messages catches "same message, different files split" as a false-positive loop and misses "same files, slightly different message" as a false-negative. Plan structure is the right identity key. `formatConventionalCommit` output is human-presentational and not stable for the same plan across LLM providers. R64 hostile review: alternating-plan loops are not detected by this scheme; this is a known limitation, not a bug. |
| 13 | **Empty-plan retry is success when `committedShas` is non-empty** (R57). The `done: true` marker introduced in R35 has been dropped (round 5 hostile review C1): the bridge, system prompt, and publisher were mutually contradictory about its format, making the success path dead code. The success path is now: publisher throws `CommitPlanError("empty-plans")`; orchestrator's `classifyError` checks `committedShasExist` (which includes both `repoState.committedShas` and `err.context.committedShas` from R59) and returns `{ kind: "success" }` ONLY when commits already landed. | R16 hostile review: an LLM returning `[]` to signal "all work already done" must not consume the structural retry budget. R57 hostile review: the `committedShas.length > 0` check is sufficient to disambiguate "all done" from "LLM forgot files" — no marker needed. If commits landed in prior retries, bare `[]` MUST mean done; if no commits landed, bare `[]` MUST mean forgot files. The system prompt (Phase 6) is updated to instruct the LLM to return bare `[]` when work is complete. |
| 14 | **`ESCALATED` is a terminal state distinct from `FAILED`**. The skill emits a structured `EscalationContext` when the retry budget is exhausted. The parent agent decides whether to re-invoke with `escalationHint` (Decision 15), take manual control, or surface to the user. The 90% of cases handled by the deterministic retry loop stay deterministic; the 10% of cases where the loop fails get a second chance with full context. | The plan was previously fail-closed with no escape hatch (Round 8 hostile review). The agent's semantic understanding (rename detection, intent inference, etc.) is most valuable exactly when the deterministic loop has failed — closing the loop with the agent preserves the skill's value while not trapping it in irreducible edge cases. |
| 15 | **`escalationHint` resets the retry budget**. A re-invocation with `escalationHint` is a fresh attempt with context, not a continuation. The previous budget was exhausted; this is a new attempt that the agent is initiating with hindsight. | Treating re-invocation as "continuation" would conflate the agent's deliberate retry with the loop's automatic retry, making budget accounting ambiguous. Fresh budget also matches the user's intuition: each `executeCommits` invocation has its own retry budget. |
| 16 | **The LLM prompt formats `escalationHint` identically to a mid-loop retry feedback block**. The structured data (`committed_shas`, `pending_files`, `last_error`, `feedback_history`) is rendered via the same bridge code that renders mid-loop retries. The LLM does not need to distinguish between retry and escalation contexts. | Single code path for "give the LLM feedback about previous failures". Re-invocations look identical to retries from the LLM's perspective. Avoids the R57-class coordination problem where three subsystems (bridge, prompt, publisher) drift on the same concept. The system prompt does not need to change. |

---

## 3. Error Taxonomy

| Error class | Kind in feedback | Retryable? | Origin |
|---|---|---|---|
| `CommitPlanError("duplicate-file")` | `structural` | yes | Publisher guard (JS) |
| `CommitPlanError("missing-file")` | `structural` | yes | Publisher guard (git `add` then `commit` reports "nothing to commit") |
| `CommitPlanError("nonexistent-file")` | `structural` | yes | Publisher guard (`git add` reports "pathspec ... did not match any file") |
| `CommitPlanError("empty-plans")` | `structural` | yes (with R16 special case) | Publisher guard |
| `DiffHashMismatchError` | `race` | yes | Publisher guard (sha256 mismatch) |
| `PartialCommitError` | `git` | yes | Publisher mid-loop (after N commits succeeded) |
| `GitExecError` (other) | `git` | no | Publisher execution (real git failure) |
| `PushError` | `network` | yes (transient=true) / no (transient=false) | Publisher push phase |

**Network errors are non-retryable** because they are environmental and not LLM-fixable. Structural, race, and partial-commit errors are LLM-fixable with the right feedback.

---

## 4. Phase-by-Phase Implementation

### Phase 1 — Foundation: Typed Errors

The error classes module defines the typed error hierarchy used by the publisher and orchestrator.

```ts
export type CommitPlanErrorKind =
    | "duplicate-file"
    | "empty-plans"
    | "missing-file"
    | "nonexistent-file";

export class CommitPlanError extends Error {
    constructor(
        message: string,
        public readonly kind: CommitPlanErrorKind,
        public readonly files?: string[],
        // R59 fix (C3): optional context for mid-loop errors. When set, the
        // orchestrator merges context.committedShas into repoState.committedShas
        // and uses context.pendingFiles as the retry's pendingFiles. This
        // prevents the "committed SHA loss on structural errors" bug where
        // missing-file or nonexistent-file errors thrown AFTER successful
        // commits dropped the landed SHAs from the retry path.
        public readonly context?: {
            committedShas?: CommittedSha[];
            pendingFiles?: string[];
        },
    ) {
        super(message);
        this.name = "CommitPlanError";
    }
}

export class DiffHashMismatchError extends Error {
    constructor() {
        super("DiffHash mismatch: The staged diff changed during LLM inference.");
        this.name = "DiffHashMismatchError";
    }
}

export class GitExecError extends Error {
    constructor(
        message: string,
        public readonly command: string,
        public readonly exitCode: number,
    ) {
        super(message);
        this.name = "GitExecError";
    }
}

export class PartialCommitError extends Error {
    constructor(
        message: string,
        public readonly context: {
            committedShas: CommittedSha[];   // { sha, files } per actually-landed commit
            originalHead: string;
            failedIndex: number;
            totalCount: number;
            pendingFiles: string[];          // planned-but-not-attempted files (source of remaining work)
        },
    ) {
        super(message);
        this.name = "PartialCommitError";
    }
}

export class PushError extends Error {
    constructor(message: string, public readonly transient: boolean) {
        super(message);
        this.name = "PushError";
    }
}

// `transient: true` is consumed by `classifyError` in the orchestrator (Phase 4)
// to decide whether to retry on network errors. See MAX_ATTEMPTS_BY_KIND.network = 1.
```

**Module dependency contract**: the import direction between the error classes module and the types module is strictly one-way. The error classes module may import type-only from the types module (`CommittedSha`, `CommitPlan`, `CommitMessage`); the types module must NOT depend on the error classes module. The publisher module and the orchestrator module may import from both (both are downstream in the dependency graph). The graph must remain strictly acyclic; a reverse edge is a lint error.

---

### Phase 2 — Extend Types

The types module gains the unified error shape, the committed-commit record, and the extended `RepoState` shape required by the retry mechanism.

```ts
// New: unified error shape in feedback
export interface FeedbackError {
    kind: "validation" | "structural" | "race" | "git" | "network";
    message: string;
    resolution_hint?: string;
    files?: string[];
}

// One entry per actually-landed commit. SHA stored full, files = paths committed.
// The LLM uses `files` to know what is "done" without needing git log access.
export interface CommittedSha {
    sha: string;
    files: string[];
}

// Replaces validation_errors
export interface Feedback {
    previous_commit: string;             // rolling history across all attempts (see Decision 1 + Phase 4 helper)
    errors: FeedbackError[];
    committed_shas?: CommittedSha[];     // present only for PartialCommitError
    pending_files?: string[];            // present only for PartialCommitError; planned-but-not-attempted files
    // Round 8 (Decision 16): optional context hints surfaced when the agent
    // re-invokes with an escalationHint. The LLM treats these as informational;
    // the bridge renders them in the same feedback block as the standard fields.
    recommended_action?: "git-reset-and-recommit" | "manual-fix-needed" | "unknown";
    loop_detected?: { kind: FeedbackError["kind"]; planHash: string };
}

// CommitJobPayload uses new Feedback.
//
// R41 fix (relaxed): `diff` semantic is overloaded by design.
//   - On the first attempt, the diff-capture phase populates `diff` with the
//     full staged diff (the entire remaining work).
//   - On retries (Decision 6), `queueRetry` populates `diff` with the
//     reconstructed remaining-work diff (re-staging pendingFiles with the
//     worktree guard from R28, then `git diff --cached`).
// The bridge renders `payload.diff` inside <remaining-diff> tags, which is
// semantically correct in both cases.
export interface CommitJobPayload {
    repository: string;
    /** The diff the LLM should work on. Full staged diff on first attempt; reconstructed remaining-work diff on retries. */
    diff: string;
    diffHash: string;
    provider: string;
    model: string;
    temperature: number;
    systemPrompt: string;
    feedback?: Feedback;
}

// Per-kind attempts, scoped to a single diffHash. New diffHash → fresh counters.
export type AttemptsByKind = Partial<Record<FeedbackError["kind"], number>>;

// Extended for progress tracking
export interface RepoState {
    repository: string;
    // Round 8: "ESCALATED" added as a terminal state distinct from "FAILED".
    // ESCALATED means the retry loop exhausted its budget and emitted an
    // escalationContext; the parent agent decides what to do next.
    // FAILED means the repo was abandoned (no agent handoff).
    status: "PENDING" | "RUNNING" | "ESCALATED" | "SUCCESS" | "FAILED";
    diffHash?: string;
    // CHANGED (round 3, R2): aligned with the inline stateSchema which already used plural.
    // The legacy `commit?: CommitMessage` field was never written by any code path; all
    // callers (the orchestrator, reporter) reference `commits`. Migration shim in the
    // state loader drops any legacy `commit` field silently.
    commits?: CommitPlan[];
    error?: string;
    attempts?: AttemptsByKind;           // CHANGED: per-kind, per-diffHash
    committedShas?: CommittedSha[];      // NEW: cumulative across retries
    originalHead?: string;               // NEW
    feedbackHistory?: string[];          // NEW: rolling previous_commit history for the LLM (capped, see Decision 11)
    lastPlanHash?: string;               // NEW: loop detection — hash of the last plan structure (NOT messages)
    // R62 fix: dedicated field for loop-detected outcome. Set by the orchestrator
    // when classifyError or queueRetry detects a loop. The reporter reads it
    // directly (replaces the previous regex-based extraction from `error`).
    loopDetected?: {
        kind: FeedbackError["kind"];
        planHash: string;
    };
}
```

**Acceptance**: no other module references the old `attempts: number` shape, nor the old `commit?: CommitMessage` field on `RepoState`. The migration shim (Phase 7.6 in earlier revisions; behavior is preserved in the state-loader module) handles both legacy shapes for previously-serialized state.

### Phase 2.5 — Escalation types (Round 8)

Two new I/O contracts support the escalation channel:

```ts
// EscalationContext — emitted when the retry loop is exhausted (status: ESCALATED).
// The parent agent reads this and decides what to do next.
export interface EscalationContext {
    repository: string;
    diffHash: string;
    lastError: FeedbackError;
    attemptsByKind: AttemptsByKind;
    committedShas: CommittedSha[];           // cumulative across the failed invocation
    originalHead: string;                   // HEAD before any commit in this invocation
    pendingFiles: string[];                 // best-effort: what still needs committing
    feedbackHistory: string[];              // full history of feedback sent to the LLM
    loopDetected?: { kind: FeedbackError["kind"]; planHash: string };
    recommendedAction: "git-reset-and-recommit" | "manual-fix-needed" | "unknown";
}

// ExecuteCommitsInput — the skill's entry point. When `escalationHint` is
// provided, the skill uses it as initial feedback for the LLM (Decision 15:
// fresh budget, not continuation).
export interface ExecuteCommitsInput {
    repoPath: string;
    diffHash: string;
    settings: Settings;
    escalationHint?: EscalationContext;     // present only on agent re-invocation
}
```

The skill's `executeCommits` returns:

```ts
type ExecuteCommitsResult =
    | { status: "SUCCESS"; committedShas: CommittedSha[]; originalHead: string }
    | { status: "FAILED"; error: string }
    | { status: "ESCALATED"; escalationContext: EscalationContext };
```

The three terminal states match `RepoState.status`. The reporter surfaces all three.

---

### Phase 3 — Publisher

The publisher module exposes a single async entry point that takes a list of commit plans and either commits them all (returning the list of SHAs landed) or throws a typed error describing why some plans could not be committed.

#### `gitExec` helper contract

A reusable helper for running `git` commands with a fixed contract:

- **No credential prompts**: the spawned environment prevents interactive credential prompts from hanging the phase.
- **Deterministic error messages**: the locale is forced to a fixed value so `git` stderr is reproducible across hosts.
- **Timeouts**: a 30-second timeout guards against indefinite hangs.
- **Trimmed stdout**: returns the trimmed stdout as a string.
- **Throws on non-zero exit**: the thrown error's message includes the stderr so downstream classifiers can pattern-match on it.

The helper is reused by both the publisher and the orchestrator's `queueRetry` diff reconstruction.

#### Signature

```ts
export async function executeMultiCommitAndPush(
    repoPath: string,
    plans: CommitPlan[],

#### Signature change

```ts
export async function executeMultiCommitAndPush(
    repoPath: string,
    plans: CommitPlan[],
    expectedDiffHash: string,
    settings: Settings,
): Promise<{ committedShas: CommittedSha[]; originalHead: string }>
```

Return value exposes `committedShas` (one entry per landed commit, in order; `{ sha, files }`) and `originalHead` (HEAD SHA before any commit). No callback.

#### Guard refactor (typed throws)

```ts
// Empty plans → typed
if (plans.length === 0) {
    throw new CommitPlanError("Empty plans array", "empty-plans");
}

// Duplicate file guard → typed.
//
// R56 fix: paths are normalized via `path.posix.normalize()` before being
// added to the seen set. The guard previously used raw string comparison,
// which let through syntactic variants of the same file:
//   - `src/foo.ts` vs `src/./foo.ts` (current-dir segment)
//   - `src/foo.ts` vs `src/foo.ts/` (trailing slash)
//   - `src/foo.ts` vs `src//foo.ts` (multiple slashes)
//   - `src/bar/../foo.ts` vs `src/foo.ts` (parent-dir segment)
// Without normalization, the LLM can waste a retry budget on a "nothing to
// commit" or "pathspec did not match" failure that the guard should have
// caught. `path.posix.normalize()` handles all four cases above. Case
// sensitivity (case-insensitive filesystems like macOS APFS or Windows
// NTFS) is NOT normalized here — the system prompt instructs the LLM to
// use paths "exactly as they appear in the diff header", where git has
// already canonicalized casing. If a future need arises, fold the
// filesystem detection (via `process.platform` + a probe file) here.
//
// The original (un-normalized) `file` is preserved in the error message
// for clarity, but comparison happens on the canonical form.
const seen = new Set<string>();
for (const plan of plans) {
    for (const file of plan.files) {
        const normalized = path.posix.normalize(file);
        if (seen.has(normalized)) {
            throw new CommitPlanError(
                `Invalid commit plan: file "${file}" appears in multiple plans. ` +
                `Files that contain multiple concerns must be grouped into a single Fat Commit plan.`,
                "duplicate-file",
                [file],
            );
        }
        seen.add(normalized);
    }
}

// DiffHash guard → typed
const currentDiff = execSync("git diff --cached", {
    cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], env: GIT_ENV,
});
const currentHash = crypto.createHash("sha256").update(currentDiff).digest("hex");
if (currentHash !== expectedDiffHash) {
    throw new DiffHashMismatchError();
}
```

#### Commit loop with partial-commit instrumentation

> **Note**: no leading `git reset HEAD` (Decision 8). Each plan's `add` is the only staging action. Inter-commit reset (Decision 10) runs after each commit.

```ts
const originalHead = execSync("git rev-parse HEAD", {
    cwd: repoPath, encoding: "utf-8",
}).trim();
const committedShas: CommittedSha[] = [];

try {
    for (let i = 0; i < plans.length; i++) {
        const plan = plans[i];
        try {
            gitExec(`add -- ${plan.files.map(JSON.stringify).join(" ")}`, repoPath);

            const message = formatConventionalCommit(plan.commit);
            const tempMsgPath = path.join(os.tmpdir(), `commit-msg-${Date.now()}-${i}.txt`);
            fs.writeFileSync(tempMsgPath, message, "utf-8");
            try {
                gitExec(`commit --file=${tempMsgPath} --no-verify`, repoPath);
            } finally {
                try { fs.unlinkSync(tempMsgPath); } catch {}
            }

            const sha = execSync("git rev-parse HEAD", {
                cwd: repoPath, encoding: "utf-8",
            }).trim();
            committedShas.push({ sha, files: plan.files });
        } catch (commitErr) {
            // 1. Cleanup staging area only (do NOT touch commits).
            // R74 fix: the reset is now FATAL on failure (was "logged but non-fatal" in R8).
            // Rationale: if `git reset HEAD` fails (index lock, hook, etc.), the staging area
            // remains dirty after this catch block returns. The orchestrator then queues a
            // retry whose `git add` is a no-op on already-staged files → the next commit
            // silently includes the failed plan's files. Allowing the retry to proceed on a
            // dirty index is worse than failing the repo closed. The original commit error is
            // preserved in the wrapped message so the orchestrator's classifier still routes
            // it correctly.
            try {
                gitExec("reset HEAD", repoPath);
            } catch (resetErr) {
                throw new GitExecError(
                    `reset HEAD failed during cleanup: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}. ` +
                    `Original commit error: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
                    "reset",
                    1,
                );
            }

            // 2. Classify the failure
            const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);

            // R59 fix (C3): compute pendingFiles for context BEFORE throwing
            // structural errors. Used by 2a and 2b to carry the pending files
            // to the orchestrator (so it can merge into repoState.committedShas
            // and pass to queueRetry's pendingFiles). 2c (PartialCommitError)
            // computes its own pendingFiles inline (see below).
            const pendingFilesSeen = new Set<string>(plan.files);
            const pendingFilesContext = [
                ...plan.files,
                ...plans.slice(i + 1).flatMap((p) => p.files).filter((f) => {
                    if (pendingFilesSeen.has(f)) return false;
                    pendingFilesSeen.add(f);
                    return true;
                }),
            ];

            // 2a. File does not exist (git add failed before commit) — structural, not partial.
            //     Detected from "fatal: pathspec 'X' did not match any file(s)" or similar.
            if (
                msg.includes("did not match any file") ||
                msg.includes("pathspec") ||
                msg.includes("does not exist")
            ) {
                throw new CommitPlanError(
                    `Plan ${i + 1}/${plans.length} references file(s) that do not exist on disk: ${plan.files.join(", ")}. ` +
                    `Files must exist relative to the repo root.`,
                    "nonexistent-file",
                    plan.files,
                    {
                        // R59: include committedShas and pendingFiles so the
                        // orchestrator can merge them into repoState.
                        committedShas: [...committedShas],
                        pendingFiles: pendingFilesContext,
                    },
                );
            }

            // 2b. Nothing to commit (file already committed or empty) — structural.
            if (msg.includes("nothing to commit") || msg.includes("no changes added")) {
                throw new CommitPlanError(
                    `Plan ${i + 1}/${plans.length} has no changes to commit. Files: ${plan.files.join(", ")}`,
                    "missing-file",
                    plan.files,
                    {
                        // R59: include committedShas and pendingFiles so the
                        // orchestrator can merge them into repoState.
                        committedShas: [...committedShas],
                        pendingFiles: pendingFilesContext,
                    },
                );
            }

            // 2c. Otherwise: partial commit failure.
            //     pendingFiles = the FAILED plan's files (NOT committed, NOT staged after reset)
            //                   + all subsequent plans' files (never attempted).
            //     The failed plan's files must be included — see plan §C2 fix.
            const failedPlanFiles = [...plan.files];
            const subsequentFiles = plans.slice(i + 1).flatMap((p) => p.files);
            // Deduplicate while preserving order (a file may appear in multiple subsequent plans).
            const seen = new Set<string>(failedPlanFiles);
            const pendingFiles = [
                ...failedPlanFiles,
                ...subsequentFiles.filter((f) => {
                    if (seen.has(f)) return false;
                    seen.add(f);
                    return true;
                }),
            ];

            throw new PartialCommitError(
                `Commit ${i + 1}/${plans.length} failed: ${msg}. ` +
                `${committedShas.length} commit(s) already in history (from ${originalHead.slice(0, 7)}). ` +
                `${pendingFiles.length} file(s) still pending.`,
                {
                    committedShas,
                    originalHead,
                    failedIndex: i,
                    totalCount: plans.length,
                    pendingFiles,
                },
            );
        }

        // 3. Inter-commit reset (Decision 10): clear staging between plans so the
        //    next plan's `add` does not include files from this commit. Runs ONLY
        //    on the success path — on the failure path, the catch block above
        //    already issued the reset and the `throw` exits this iteration before
        //    reaching this line. See Decision 10 (round 3, R3 fix) for the corrected
        //    description of when this reset actually executes.
        try {
            gitExec("reset HEAD", repoPath);
        } catch {}
    }
} catch (err) {
    if (!(err instanceof CommitPlanError || err instanceof PartialCommitError)) {
        throw new GitExecError(
            err instanceof Error ? err.message : String(err),
            "unknown",
            -1,
        );
    }
    throw err;
}
```

#### Push (typed errors)

```ts
if (!settings.autoPush) return { committedShas, originalHead };

const remotes = gitExec("remote", repoPath);
if (!remotes) return { committedShas, originalHead };  // no remote → no error

// R10 fix: helpers (PERMANENT_PUSH_SIGNATURES, classifyTransient) live at module scope
// (top of `git-publisher.ts`), NOT inside this function. Round 3 corrected a structural
// bug where these declarations were placed inside the try block and produced a
// duplicate nested try/catch.

try {
    gitExec("push", repoPath);
} catch (pushErr) {
    const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    if (msg.includes("has no upstream branch") || msg.includes("no upstream")) {
        const branchName = gitExec("branch --show-current", repoPath).trim();
        // Detached HEAD: branchName is empty; bail out rather than run a malformed command.
        if (!branchName) {
            throw new PushError(`Push failed: detached HEAD, cannot determine upstream branch. ${msg}`, false);
        }
        const firstRemote = remotes.split("\n")[0]?.trim() ?? "origin";
        try {
            gitExec(`push -u ${firstRemote} ${branchName}`, repoPath);
        } catch (innerErr) {
            const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr);
            // R10 fix: classify the inner push failure properly. Auth and permission
            // errors on the second attempt are permanent — retrying with the same
            // plan does nothing useful and just burns the network budget.
            throw new PushError(
                `Push with upstream failed: ${innerMsg}`,
                classifyTransient(innerMsg),
            );
        }
    } else {
        // R10 fix: classify the outer push failure too (was always transient before).
        throw new PushError(`Push failed: ${msg}`, classifyTransient(msg));
    }
}

return { committedShas, originalHead };
```

**Module-scope helpers — transient classification**

A list of substrings identifies git push failures that are **permanent** (auth errors, repository rejected, etc.) vs **transient** (network blips). The list is loaded from a fixture so production and tests share the same source of truth — hand-authoring substrings diverges production from tests as git evolves.

The list MUST be sorted by specificity (most specific first): substring matching means a generic "Permission denied" entry would also match "Permission denied (publickey)" if it came first.

```ts
// PERMANENT_PUSH_SIGNATURES loaded from a shared fixture (production and tests)
const PERMANENT_PUSH_SIGNATURES: readonly string[] = /* loaded at module init */;

function classifyTransient(msg: string): boolean {
    // Returns false if msg matches any permanent signature; true otherwise.
    for (const sig of PERMANENT_PUSH_SIGNATURES) {
        if (msg.includes(sig)) return false;
    }
    return true;
}
```

**Acceptance**: the publisher throws a `PushError` whose `transient` field is `false` for auth-style errors and `true` for network-style errors; tests U-GE-24 and U-GE-25 assert both branches.

---

### Phase 4 — Refactor Orchestrator

#### Add helpers at top of file

```ts
// The orchestrator needs:
//   - error classes: CommitPlanError, DiffHashMismatchError, GitExecError, PartialCommitError, PushError
//   - types: CommitPlanErrorKind, FeedbackError, CommittedSha, CommitPlan, Feedback, RepoState
//   - gitExec helper from Phase 3 (for diff reconstruction in queueRetry)
//   - sha256 hashing (for lastPlanHash canonicalization in queueRetry)
//   - execSync for `git diff --cached` in queueRetry (best-effort path)

// Module-scope retry queue — Decision 9. Single queue, drained by the phase body at the end.
//
// R26 invariant: Turnlock MUST guarantee that a single `commit-and-push` phase
// instance runs at any given time per worker. If two instances interleave,
// the `retryJobs.length = 0` reset at phase entry nukes the other instance's
// queued jobs. Verify this invariant via integration test before merging
// Phase 4. If Turnlock does NOT guarantee it, move the queue to per-invocation
// state (stash on nextRepos[id].__pendingRetry and return via io.delegateAgentBatch).
const retryJobs: Array<{ id: string; prompt: string }> = [];

const MAX_ATTEMPTS_BY_KIND: Record<FeedbackError["kind"], number> = {
    validation: 1,
    structural: 1,
    race: 1,
    git: 1,
    network: 1,  // PushError.transient=true → retry once; .transient=false → fail-closed
};

// R20 + R29 + R44 + R65: cap feedbackHistory at the sum of per-kind max attempts
// (default 5), bound each entry's serialized size at 16 KB, AND bound the joined
// `previous_commit` string at 64 KB (R65 — protects small-context LLMs).
const MAX_FEEDBACK_HISTORY = Math.max(
    10,
    Object.values(MAX_ATTEMPTS_BY_KIND).reduce((a, b) => a + b, 0),
);
const MAX_FEEDBACK_ENTRY_BYTES = 16 * 1024;
const MAX_FEEDBACK_TOTAL_BYTES = 64 * 1024;

// R7 + R27 fix: classify LLM-side failures (result.success === false) by inspecting the
// error string. Hardcoding "git" burned the wrong budget for JSON parse failures and
// network timeouts. The signatures are taken from the bridge's failure surface and
// MUST be reviewed whenever the bridge changes its error format. R27 adds: the
// signature list is scoped to known LLM bridge error strings only; generic terms
// like "SyntaxError" or "JSON.parse" are flagged as too broad (they match
// unrelated subsystem errors) and split into bridge-prefixed markers below.
const LLM_BRIDGE_ERROR_PREFIX = "[git-commits-push-tl bridge]";
const LLM_FATAL_SIGNATURES = [
    `${LLM_BRIDGE_ERROR_PREFIX} LLM Fatal Error`,
    `${LLM_BRIDGE_ERROR_PREFIX} expected a non-empty JSON array`,
    `${LLM_BRIDGE_ERROR_PREFIX} JSON parse failed`,
    `${LLM_BRIDGE_ERROR_PREFIX} network timeout`,
    `${LLM_BRIDGE_ERROR_PREFIX} network reset`,
    `${LLM_BRIDGE_ERROR_PREFIX} network unreachable`,
    `${LLM_BRIDGE_ERROR_PREFIX} provider aborted`,
];
function classifyLLMFailure(error: string): FeedbackError["kind"] | null {
    // Validation-style complaint from the LLM (rejected by the validator
    // post-generation) goes to the validation budget.
    if (error.includes(`${LLM_BRIDGE_ERROR_PREFIX} validation rejected`)) {
        return "validation";
    }
    for (const sig of LLM_FATAL_SIGNATURES) {
        if (error.includes(sig)) return null;
    }
    // Unknown result.success === false — treat as fatal. R7 rationale: a single retry
    // of an unknown LLM failure is more likely to repeat than recover.
    return null;
}

// R40 fix: structured stderr log for retry decisions. The reporter at the end of
// the phase shows totals, but operators debugging live failures need a per-event
// trace. Each line is prefixed with the repo id and the diff hash for correlation.
function logRetry(repoId: string, kind: FeedbackError["kind"], attempt: number, diffHash: string, reason: string): void {
    process.stderr.write(
        `[git-commits-push-tl] retry repo=${repoId} kind=${kind} attempt=${attempt}/${MAX_ATTEMPTS_BY_KIND[kind]} diffHash=${diffHash.slice(0, 12)} reason=${JSON.stringify(reason)}\n`,
    );
}

// R57 fix (C1): the `done: true` marker has been dropped. The `llmResponse`
// parameter is removed. The success path for empty-plans is now purely based
// on `committedShasExist`: if commits already landed (in repoState or in the
// error context — see R59), then bare `[]` MUST mean "all work done" (the LLM
// has no reason to forget files when there's nothing left); otherwise bare `[]`
// means "LLM forgot files" and we retry as structural.
//
// R16 + R43: classifyError returns a discriminated union. The previous
// `{ retryable, error } | null` shape conflated "no decision" with "success".
// The new shape makes the success path explicit and removes the need for callers
// to interpret a `null` return.
//
//   { kind: "retry", error }  → caller checks attempts and either retries or fails
//   { kind: "fail",  error }  → caller fails the repo closed
//   { kind: "success" }       → caller treats as success (empty-plans with commits)
function classifyError(
    err: unknown,
    committedShasExist: boolean,
): { kind: "retry" | "fail"; error: FeedbackError } | { kind: "success" } {
    if (err instanceof CommitPlanError) {
        // R57: empty-plans is success ONLY if commits already landed.
        if (err.kind === "empty-plans" && committedShasExist) {
            return { kind: "success" };
        }
        return {
            kind: "retry",
            error: {
                kind: "structural",
                message: err.message,
                resolution_hint: getResolutionHint(err.kind),
                files: err.files,
            },
        };
    }
    if (err instanceof DiffHashMismatchError) {
        return {
            kind: "retry",
            error: {
                kind: "race",
                message: err.message,
                resolution_hint: "The diff changed during inference. Regenerate based on the current diff.",
            },
        };
    }
    if (err instanceof PartialCommitError) {
        return {
            kind: "retry",
            error: {
                kind: "git",
                message: err.message,
                resolution_hint: "Re-decide the plan based on the pending files (provided below).",
            },
        };
    }
    if (err instanceof GitExecError) {
        return { kind: "fail", error: { kind: "git", message: err.message } };
    }
    if (err instanceof PushError) {
        // Retry ONLY when the publisher flagged the failure as transient (network blip, etc.).
        // Permanent failures (auth, repository rejected, etc.) fail-closed immediately.
        if (err.transient) {
            return {
                kind: "retry",
                error: { kind: "network", message: err.message },
            };
        }
        return { kind: "fail", error: { kind: "network", message: err.message } };
    }
    return {
        kind: "fail",
        error: { kind: "git", message: err instanceof Error ? err.message : String(err) },
    };
}

function getResolutionHint(kind: CommitPlanErrorKind): string {
    switch (kind) {
        case "duplicate-file":
            return "Either split the duplicated file beforehand, or merge all changes touching it into a single Fat Commit plan (use the most impactful type: feat > fix > refactor > chore).";
        case "missing-file":
            return "The file has no changes to commit (already committed or empty). Remove it from the plan.";
        case "nonexistent-file":
            return "The file path does not exist on disk in the working directory. Use only paths that appear in the staged diff (the `diff` parameter). Remove the path from the plan or fix the path spelling.";
        case "empty-plans":
            return "If pending_files is empty AND committed_shas covers everything, return an empty array []. Otherwise, generate plans that cover the pending_files exactly (plus any files you regroup via Fat Commit).";
        default: {
            // Exhaustiveness check — TS strict mode will error here if the union grows.
            const _exhaustive: never = kind;
            return _exhaustive;
        }
    }
}

// R38 fix: bumpAttempt / attemptCountFor removed. Callers use direct access:
//   const current = repoState.attempts?.[kind] ?? 0;
//   const next = { ...repoState, attempts: { ...(repoState.attempts ?? {}), [kind]: current + 1 } };
// The helper indirection added no value beyond testability (the inline form is
// equally testable) and tempted future maintainers to add cross-cutting logic
// (logging, telemetry, validation) inside the helper, bloating it. See R38.

// R4 fix: queueRetry is now pure — it returns a new RepoState and pushes the
// job into `retryJobs`. The caller uses the result to update `nextRepos` and
// inspects `result.kind` to distinguish a normal queue from a loop-detected
// outcome. No more `__LOOP_DETECTED__` string sentinel in the queue.
type QueueRetryResult =
    | { kind: "queued"; repoState: RepoState; job: { id: string; prompt: string } }
    | { kind: "loop-detected"; repoState: RepoState };

function queueRetry(
    repoId: string,
    repoState: RepoState,
    errors: FeedbackError[],
    options: {
        committedShas?: CommittedSha[];
        pendingFiles?: string[];
    },
    settings: Settings,
    systemPrompt: string,
    failedPlans: CommitPlan[], // R11 fix: hash the plan structure, not formatted messages
): QueueRetryResult {
    if (!repoState.diffHash) {
        throw new Error(`Cannot retry repo ${repoId}: missing diffHash on RepoState`);
    }

    // R6 + R75 fix: drop already-committed files from pendingFiles before any re-staging.
    // Otherwise the LLM sees the same path in BOTH `committed_shas` and `pending_files`
    // and gets contradictory instructions. The committed-files set is built from
    // the union of pre-existing committedShas (repoState) and the just-landed
    // committedShas passed in via options.
    //
    // R75 fix: paths are normalized via `path.posix.normalize()` on BOTH sides of the
    // comparison. The publisher's duplicate-file guard (R56) normalizes paths the same
    // way; without normalization here, a `pendingFile` like `src/./foo.ts` would NOT be
    // filtered out even when `committedShas` contains `src/foo.ts` (the strings compare
    // unequal). The LLM then receives a path already committed → `git add` is a no-op
    // → `git commit` reports "nothing to commit" → retry deterministic-fails on the
    // SAME error every attempt, burning the retry budget. This was previously tracked
    // as R67 (follow-up) but is in fact a behavioral bug — R67 is now fixed.
    let pendingFiles = options.pendingFiles;
    if (pendingFiles && pendingFiles.length > 0) {
        const committedFiles = new Set<string>();
        for (const cs of repoState.committedShas ?? []) {
            for (const f of cs.files) committedFiles.add(path.posix.normalize(f));
        }
        for (const cs of options.committedShas ?? []) {
            for (const f of cs.files) committedFiles.add(path.posix.normalize(f));
        }
        pendingFiles = pendingFiles.filter((f) => !committedFiles.has(path.posix.normalize(f)));
    }

    // R41 fix (relaxed): rename local variable to `remainingDiff` for readability
    // inside this function. The `CommitJobPayload.diff` field name is preserved
    // because it is populated by a separate phase (diff-capture) whose contract
    // is out of scope for this plan. The semantic shift — `diff` is "the full
    // diff on the first attempt" and "the reconstructed remaining diff on
    // retries" — is documented in the type's JSDoc below. The bridge always
    // renders `payload.diff` inside <remaining-diff> tags, which is correct
    // regardless of attempt number.
    //
    // R28 fix: re-staging pendingFiles must NOT overwrite working-tree edits.
    // Strategy:
    //   1. For each pendingFile, check `git diff <file>` (worktree vs index).
    //   2. If non-empty AND the file is already in the index (i.e., the user
    //      edited a staged file between the original staging and this retry),
    //      skip the re-stage for that file and include its current worktree
    //      content directly in the diff via `git diff <file>` (worktree vs HEAD).
    //   3. Re-stage only the safe files.
    // If any pendingFile is missing from disk, fall back to empty diff for that
    // file (the LLM will see the path in pending_files but no diff content).
    let remainingDiff: string;
    if (pendingFiles && pendingFiles.length > 0) {
        const safeToRestage: string[] = [];
        const worktreeOnlyParts: string[] = [];
        for (const f of pendingFiles) {
            try {
                const worktreeVsIndex = gitExec(
                    `diff -- "${f.replace(/"/g, '\\"')}"`,
                    repoState.repository,
                );
                const inIndex = gitExec(
                    `ls-files --error-unmatch -- "${f.replace(/"/g, '\\"')}"`,
                    repoState.repository,
                );
                if (worktreeVsIndex) {
                    // R73 fix: the original R28 condition (`worktreeVsIndex && inIndex`)
                    // only preserved worktree edits when the file was already staged. The
                    // common case "worktree dirty but not staged" silently fell into
                    // `safeToRestage` → `git add` overwrites the unstaged edits with the
                    // committed index content → data loss. The intent of the guard is
                    // "preserve worktree edits", which depends on `worktreeVsIndex` being
                    // non-empty, NOT on the file's index status. `inIndex` is no longer
                    // consulted here (the `ls-files` call is retained only because the
                    // worktree-vs-index diff is meaningful even when the file is unstaged).
                    worktreeOnlyParts.push(worktreeVsIndex);
                } else {
                    safeToRestage.push(f);
                }
            } catch {
                // File missing or some other git error — include in safeToRestage
                // and let the re-stage fail gracefully (caught below).
                safeToRestage.push(f);
            }
        }
        if (safeToRestage.length > 0) {
            const quoted = safeToRestage.map((f) => JSON.stringify(f)).join(" ");
            try {
                gitExec(`add -- ${quoted}`, repoState.repository);
                const cachedDiff = execSync("git diff --cached", {
                    cwd: repoState.repository,
                    encoding: "utf-8",
                    timeout: 30_000,
                }).toString();
                remainingDiff = cachedDiff + worktreeOnlyParts.join("\n");
            } catch {
                remainingDiff = worktreeOnlyParts.join("\n");
            } finally {
                try { gitExec("reset HEAD", repoState.repository); } catch {}
            }
        } else {
            remainingDiff = worktreeOnlyParts.join("\n");
        }
    } else {
        try {
            remainingDiff = execSync("git diff --cached", {
                cwd: repoState.repository,
                encoding: "utf-8",
                timeout: 30_000,
            }).toString();
        } catch {
            remainingDiff = ""; // best-effort
        }
    }

    // R11 fix (Decision 12): loop detection hashes the plan STRUCTURE, not the formatted
    // commit messages. Canonicalize the failed plans array (sorted files per plan, sorted
    // keys in commit) and sha256 the resulting JSON. Two plans with the same files but
    // different message wording now produce the same hash (which is correct — they're
    // structurally identical). Two plans with different files produce different hashes.
    const canonical = failedPlans
        .map((p) => ({
            commit: {
                type: p.commit.type,
                scope: p.commit.scope ?? null,
                description: p.commit.description,
                body: p.commit.body ?? null,
                isBreaking: p.commit.isBreaking,
            },
            files: [...p.files].sort(),
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const planHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(canonical))
        .digest("hex");

    if (repoState.lastPlanHash === planHash) {
        // Same plan structure as the previous attempt → loop detected. Caller marks
        // the repo as FAILED without consuming another retry attempt.
        return {
            kind: "loop-detected",
            repoState: { ...repoState, lastPlanHash: planHash },
        };
    }

    // R20 + R29 + R44 + R65 fix: cap feedbackHistory at MAX_FEEDBACK_HISTORY
    // entries, bound each entry's serialized size at MAX_FEEDBACK_ENTRY_BYTES,
    // AND bound the joined `previous_commit` string at MAX_FEEDBACK_TOTAL_BYTES.
    // A single oversized entry (e.g., a plan with thousands of files) can
    // poison the whole history and exceed Turnlock state-size limits; an
    // oversized total can exceed small LLM context windows (8K tokens ≈ 32 KB).
    const serializedCanonical = JSON.stringify(canonical);
    const truncatedEntry = serializedCanonical.length > MAX_FEEDBACK_ENTRY_BYTES
        ? serializedCanonical.slice(0, MAX_FEEDBACK_ENTRY_BYTES) + "\n[truncated]"
        : serializedCanonical;
    const history = repoState.feedbackHistory ?? [];
    const nextHistory = [...history, truncatedEntry];
    if (nextHistory.length > MAX_FEEDBACK_HISTORY) {
        nextHistory.splice(0, nextHistory.length - MAX_FEEDBACK_HISTORY);
    }
    // R65 fix: bound the joined `previous_commit` string at MAX_FEEDBACK_TOTAL_BYTES.
    // 10 entries × 16 KB = 160 KB exceeds small-context LLMs (8K tokens ≈ 32 KB).
    // Truncating at 64 KB protects context budgets while preserving the most
    // recent history (the join order is oldest-first, so truncation drops the
    // oldest entries' content but keeps the structure).
    const joinedHistory = nextHistory.join("\n\n--- NEXT ATTEMPT ---\n\n");
    const previousCommit = joinedHistory.length > MAX_FEEDBACK_TOTAL_BYTES
        ? joinedHistory.slice(0, MAX_FEEDBACK_TOTAL_BYTES) + "\n[truncated]"
        : joinedHistory;

    const payload: CommitJobPayload = {
        repository: repoState.repository,
        // R41 fix (relaxed): `CommitJobPayload.diff` semantic is overloaded by design.
        // On the first attempt, the diff-capture phase populates it with the full
        // staged diff. On retries, queueRetry populates it with the reconstructed
        // remaining-work diff (see Decision 6 + the worktree guard above). The
        // bridge renders payload.diff inside <remaining-diff> tags, which is
        // semantically correct in both cases.
        diff: remainingDiff,
        diffHash: repoState.diffHash,
        provider: settings.provider,
        model: settings.model,
        temperature: settings.temperature,
        systemPrompt,
        feedback: {
            previous_commit: previousCommit,
            errors,
            committed_shas: options.committedShas,
            pending_files: pendingFiles,
        },
    };

    // R40 fix: structured stderr log so operators can trace retry decisions.
    logRetry(repoId, errors[0]?.kind ?? "structural", 0, repoState.diffHash, "queueRetry");

    const newRepoState: RepoState = {
        ...repoState,
        lastPlanHash: planHash,
        feedbackHistory: nextHistory,
    };

    const job = { id: repoId, prompt: JSON.stringify(payload) };
    retryJobs.push(job);
    return { kind: "queued", repoState: newRepoState, job };
}

#### Escalation helpers (Round 8)

Two helpers support the escalation re-invocation path. They are extracted (or shared with `queueRetry`) so the bridge can render escalation contexts identically to mid-loop retries.

```ts
// Maps an EscalationContext (received from a previous invocation's ESCALATED
// status) to a Feedback object that the bridge can render via the existing
// feedback block. The mapping is field-by-field — Decision 16 ensures the
// LLM does not need to distinguish escalation contexts from mid-loop retries.
function formatEscalationAsFeedback(hint: EscalationContext): Feedback {
    return {
        errors: [hint.lastError],
        committed_shas: hint.committedShas,
        pending_files: hint.pendingFiles,
        previous_commit: hint.feedbackHistory.join("\n\n--- NEXT ATTEMPT ---\n\n"),
        // The two optional hints from Decision 16 are forwarded verbatim.
        recommended_action: hint.recommendedAction,
        loop_detected: hint.loopDetected,
    };
}

// Reconstructs the remaining-work diff for retry or escalation contexts.
// Refactored from queueRetry (which used to inline this logic). The worktree
// guard from R73 and the path normalization from R75 are preserved.
function reconstructRemainingDiff(repoPath: string, pendingFiles: string[]): string {
    // 1. For each pendingFile, check `git diff <file>` (worktree vs index) — R73 guard
    // 2. Re-stage safeToRestage, capture `git diff --cached`
    // 3. Reset to clean up staging area
    // 4. Return the reconstructed diff (excludes already-committed files)
    // Falls back to empty string if all reconstruction paths fail.
}
```

#### Update `stateSchema` Zod definition (M2)

The orchestrator's inline `stateSchema` (top of the file) must mirror the new `RepoState` shape, otherwise Turnlock will reject the new fields at serialization and reject the new `attempts` shape at deserialization. Replace the existing `stateSchema` block with:

```ts
// R37 fix: legacy serialized state may carry `attempts: number` (a global
// counter from the pre-Phase-4 shape). The schema's `attempts` field accepts
// either shape and normalizes the legacy form to `{}` (zero out all per-kind
// counters — applying a legacy global counter uniformly would block all
// retries, which is the wrong default for a system that has just failed).
//
// R30 + R48 fix: tighten the new shape's value type to `int().nonnegative()`,
// and constrain keys to the closed 5-kind union via a refinement so typos
// like "validaton" are rejected at deserialization.
const ATTEMPT_KINDS = ["validation", "structural", "race", "git", "network"] as const;
type AttemptKind = typeof ATTEMPT_KINDS[number];

const attemptsSchema = z.preprocess(
    (v) => {
        if (typeof v === "number") return {}; // legacy: zero out
        return v;
    },
    z.record(
        z.string().refine((k): k is AttemptKind => ATTEMPT_KINDS.includes(k as AttemptKind), {
            message: `attempts key must be one of: ${ATTEMPT_KINDS.join(", ")}`,
        }),
        z.number().int().nonnegative(),
    ).optional(),
);

const stateSchema = z.object({
    // R58 fix (C2): top-level diffHash that the diff-capture phase populates
    // before invoking commit-and-push. The reset loop uses it to detect when
    // a repo's diffHash has changed since its last processing. Without this
    // field, the loop referenced `state.diffHash` which was always undefined,
    // wiping counters on every phase entry (destroying retry budgets).
    diffHash: z.string().optional(),
    repos: z.record(
        z.string(),
        z.object({
            repository: z.string(),
            status: z.enum(["PENDING", "RUNNING", "SUCCESS", "FAILED"]),
            diffHash: z.string().optional(),
            commits: z.array(commitPlanSchema).optional(),
            error: z.string().optional(),
            // CHANGED: per-kind counter (was `z.number()`); accepts legacy via preprocessor
            attempts: attemptsSchema,
            // NEW: cumulative across retries
            committedShas: z.array(
                z.object({ sha: z.string(), files: z.array(z.string()) }),
            ).optional(),
            // NEW
            originalHead: z.string().optional(),
            // NEW: rolling previous_commit history
            feedbackHistory: z.array(z.string()).optional(),
            // NEW: loop detection
            lastPlanHash: z.string().optional(),
            // R62 fix: dedicated field for loop-detected outcome (replaces
            // regex-extracted from error string). Set when classifyError or
            // queueRetry detects a loop. The reporter reads it directly.
            loopDetected: z.object({
                kind: z.string(),
                planHash: z.string(),
            }).optional(),
        }),
    ),
});
```

Note: `commits` (plural) is preserved as it currently exists in the inline schema. Round 3 (R2 fix) aligned the `RepoState` type to use `commits?: CommitPlan[]` (plural), matching both the schema and the actual field written by the phase body. The legacy `commit?: CommitMessage` field was removed from the type.

#### `executeCommits` entry point (Round 8)

The skill exposes a single `executeCommits(input: ExecuteCommitsInput)` entry point. The behavior differs depending on whether `escalationHint` is present:

```ts
async function executeCommits(input: ExecuteCommitsInput): Promise<ExecuteCommitsResult> {
    // Fresh start: budget is whatever MAX_ATTEMPTS_BY_KIND allows.
    const freshBudget = { ...MAX_ATTEMPTS_BY_KIND };

    // If escalationHint is provided, use it as initial feedback (Decision 16).
    // The LLM sees the same feedback rendering as a mid-loop retry.
    const initialFeedback = input.escalationHint
        ? formatEscalationAsFeedback(input.escalationHint)
        : undefined;

    // Reconstruct the remaining-work diff when escalationHint provides pendingFiles.
    // First-time invocations get the full diff from the diff-capture phase.
    const remainingDiff = input.escalationHint
        ? reconstructRemainingDiff(input.repoPath, input.escalationHint.pendingFiles)
        : /* full diff from diff-capture */;

    // Run the commit loop with the constructed inputs.
    // The loop is identical to the current commit-and-push phase body, except:
    //   - When initialFeedback is set, the first LLM call includes it (no retry needed)
    //   - The budget starts fresh regardless of input.escalationHint (Decision 15)
    return runCommitLoop({
        repoPath: input.repoPath,
        diffHash: input.diffHash,
        settings: input.settings,
        initialFeedback,
        diff: remainingDiff,
        budget: freshBudget,
    });
}

// runCommitLoop is the existing commit-and-push phase body, refactored to
// accept initialFeedback and budget as parameters instead of hardcoded values.
// It returns ESCALATED when the budget is exhausted (with an EscalationContext),
// SUCCESS when all plans landed, or FAILED when the error is non-recoverable.
```

The loop body itself does not change — only its inputs. The escalation path is a thin shim that provides initial feedback and reconstructed diff before the loop runs.

#### Agent-side contract (out of scope)

The skill does not prescribe when the parent agent should re-invoke with `escalationHint`. The agent's responsibility is to:

1. Read the `escalationContext` (or its absence — `FAILED` means no handoff)
2. Decide whether re-invocation is appropriate (vs manual control, vs surfacing to user)
3. If re-invoking: pass the context as `escalationHint` to `executeCommits`
4. If taking manual control: do so on a clean repo state (guaranteed by R73/R74/R75 + the publisher's commit loop)

The skill guarantees on exit (any terminal state):

- Clean working tree (no orphan files in staging or working directory)
- All landed commits recorded in `committedShas` with their SHAs and file lists
- All remaining work listed in `pendingFiles` (best-effort reconstruction)
- No in-progress commits (publisher's catch block resets staging on failure)

These guarantees let the agent re-invoke safely or take manual control without worrying about partial state.

#### Refactor `commit-and-push` phase

```ts
"commit-and-push": definePhase(async (state, io) => {
    const settings = readSettings(/* configuration location */);
    // Validator loading: the validator module is required by default. If it is
    // missing, the phase throws — silent skipping would allow the system to
    // ship commits that violate Conventional Commits with no retry loop.
    // Tests opt in via `settings.allowMissingValidator = true`.
    let validateCommitMessage: ((msg: string) => { valid: boolean; errors: string[] }) | null = null;
    if (/* validator is available */) {
        validateCommitMessage = /* load validator */;
    } else if (!settings.allowMissingValidator) {
        throw new Error(
            `commit-msg-validator is required but not available. ` +
            `Either install the validator or set settings.allowMissingValidator = true.`,
        );
    }
    let systemPrompt = "";
    try {
        systemPrompt = /* load system prompt from settings.systemPromptPath */;
    } catch {}

    const results = io.consumePendingBatchResults(commitJobResultSchema);
    const nextRepos: Record<string, RepoState> = { ...state.repos };
    // Drain any leftover jobs from a previous failed iteration of this phase.
    // R26 invariant: only safe if Turnlock guarantees single-instance execution.
    retryJobs.length = 0;

    // Reset attempt counters when the diffHash changes (Decision 7).
    // R36 fix: use immutable updates consistent with the rest of the phase body.
    // R58 fix (C2): `state.diffHash` is now defined as a top-level schema field
    // populated by the diff-capture phase. The comparison correctly detects when
    // a repo's diff has changed since its last processing. R57: `lastLLMResponse`
    // is removed (marker dropped).
    for (const id of Object.keys(nextRepos)) {
        const r = nextRepos[id];
        if (r.diffHash !== state.diffHash) {
            nextRepos[id] = {
                ...r,
                attempts: {},
                committedShas: [],
                originalHead: undefined,
                feedbackHistory: [],
                lastPlanHash: undefined,
            };
        }
    }

    for (const result of results) {
        let repoState = nextRepos[result.id];
        if (!repoState) continue;

        if (!result.success) {
            // R7 + R27 fix: classify LLM-side failures (result.success === false) instead of
            // hardcoding "git". Validation-style complaints go to the validation budget;
            // everything else (JSON parse, network, unknown) is fail-closed with no retry.
            const llmKind = classifyLLMFailure(result.error);
            if (llmKind === null) {
                nextRepos[result.id] = {
                    ...repoState,
                    status: "FAILED",
                    error: `LLM fatal error: ${result.error}`,
                };
                continue;
            }
            // R38 fix: direct access replaces attemptCountFor/bumpAttempt.
            const attempts = repoState.attempts?.[llmKind] ?? 0;
            if (attempts < MAX_ATTEMPTS_BY_KIND[llmKind]) {
                repoState = {
                    ...repoState,
                    attempts: { ...(repoState.attempts ?? {}), [llmKind]: attempts + 1 },
                };
                const retryResult = queueRetry(
                    result.id,
                    repoState,
                    [{
                        kind: llmKind,
                        message: result.error,
                        resolution_hint: "The previous LLM response was malformed. Regenerate based on the current diff.",
                    }],
                    {},
                    settings,
                    systemPrompt,
                    [], // no plans to hash — LLM never returned parseable output
                );
                if (retryResult.kind === "loop-detected") {
                    nextRepos[result.id] = {
                        ...retryResult.repoState,
                        status: "FAILED",
                        error: "Loop detected after LLM-side failure.",
                    };
                    continue;
                }
                nextRepos[result.id] = retryResult.repoState;
                continue;
            }
            nextRepos[result.id] = {
                ...repoState,
                status: "FAILED",
                error: `LLM fatal error after max retries: ${result.error}`,
            };
            continue;
        }

        // 1. Validation phase — uses its own per-kind counter (`validation`).
        if (validateCommitMessage) {
            const validationErrors: FeedbackError[] = [];
            for (const plan of result.commits) {
                const msgStr = formatConventionalCommit(plan.commit);
                const valRes = validateCommitMessage(msgStr);
                if (!valRes.valid) {
                    for (const e of valRes.errors) {
                        validationErrors.push({
                            kind: "validation",
                            message: `[${msgStr}] ${e}`,
                            resolution_hint: "Rewrite the commit message to comply with Conventional Commits.",
                        });
                    }
                }
            }
            // R38 fix: direct access replaces attemptCountFor/bumpAttempt.
            const validationAttempts = repoState.attempts?.validation ?? 0;
            if (validationErrors.length > 0 && validationAttempts < MAX_ATTEMPTS_BY_KIND.validation) {
                repoState = {
                    ...repoState,
                    attempts: { ...(repoState.attempts ?? {}), validation: validationAttempts + 1 },
                };
                // R11 fix: pass the plan structure (result.commits), not formatted messages.
                const retryResult = queueRetry(
                    result.id,
                    repoState,
                    validationErrors,
                    {},
                    settings,
                    systemPrompt,
                    result.commits,
                );
                if (retryResult.kind === "loop-detected") {
                    nextRepos[result.id] = {
                        ...retryResult.repoState,
                        status: "FAILED",
                        error: `Loop detected: LLM returned an identical plan on two consecutive attempts for kind "validation".`,
                    };
                    continue;
                }
                nextRepos[result.id] = retryResult.repoState;
                continue;
            }
            if (validationErrors.length > 0) {
                nextRepos[result.id] = {
                    ...repoState,
                    status: "FAILED",
                    error: "Validation failed after max retries: " + validationErrors.map((e) => e.message).join(", "),
                };
                continue;
            }
        }

        // 2. Execution + error classification — uses per-kind counter for the relevant kind.
        try {
            const { committedShas, originalHead } = await executeMultiCommitAndPush(
                repoState.repository,
                result.commits,
                repoState.diffHash!,
                settings,
            );
            // Merge with anything that landed in prior retries (C5 fix: immutable update).
            repoState = {
                ...repoState,
                committedShas: [...(repoState.committedShas ?? []), ...committedShas],
                originalHead,
            };
            nextRepos[result.id] = {
                ...repoState,
                status: "SUCCESS",
                commits: result.commits,
            };
        } catch (err) {
            // R59 fix (C3): merge err.context.committedShas into repoState.committedShas
            // BEFORE checking committedShasExist. This applies to BOTH
            // PartialCommitError and CommitPlanError paths (R59 added context to
            // CommitPlanError). The merge ensures the success path for empty-plans
            // (R57) sees committedShas from the failed attempt's mid-loop commits.
            let pendingFiles: string[] | undefined;
            if (err instanceof PartialCommitError) {
                repoState = {
                    ...repoState,
                    committedShas: [...(repoState.committedShas ?? []), ...err.context.committedShas],
                    originalHead: err.context.originalHead,
                };
                pendingFiles = err.context.pendingFiles;
            } else if (err instanceof CommitPlanError && err.context?.committedShas?.length) {
                repoState = {
                    ...repoState,
                    committedShas: [...(repoState.committedShas ?? []), ...err.context.committedShas],
                };
                pendingFiles = err.context.pendingFiles;
            }

            const committedShasExist = (repoState.committedShas?.length ?? 0) > 0;
            const classified = classifyError(err, committedShasExist);

            // R57 fix (C1): empty-plans with non-empty committedShas = SUCCESS.
            // No marker required (the marker was dropped in R57). The
            // discriminated union makes this explicit (R43 shape).
            if (classified.kind === "success") {
                nextRepos[result.id] = {
                    ...repoState,
                    status: "SUCCESS",
                    commits: [],
                    error: "LLM returned an empty plan after partial commits completed; treating as success.",
                };
                continue;
            }

            const errKind = classified.error.kind;
            // R38 fix: direct access replaces attemptCountFor.
            const attempts = repoState.attempts?.[errKind] ?? 0;
            const maxAttempts = MAX_ATTEMPTS_BY_KIND[errKind];

            if (classified.kind === "retry" && attempts < maxAttempts) {
                // R59 fix: pass the merged committedShas (now on repoState) to queueRetry.
                const committedShas = repoState.committedShas;

                // R74 fix: re-attempt `git reset HEAD` here before queuing the retry.
                // The publisher's reset (R8 → now-fatal per R74 part 1) might have failed
                // for environmental reasons (index lock, hook); a second attempt in the
                // orchestrator's catch block can succeed once the lock is released or the
                // hook context has cleared. If THIS reset also fails, log and continue:
                // the retry's pendingFiles filter (R6/R75) will skip already-staged files,
                // which at least prevents the worst-case "orphan files bleed into next
                // commit" scenario. We do NOT fail-closed here because the publisher's
                // fatal reset (R74 part 1) already accounts for that case upstream.
                try {
                    gitExec("reset HEAD", repoState.repository);
                } catch (resetErr) {
                    process.stderr.write(
                        `[git-commits-push-tl] orchestrator reset HEAD failed during retry prep: ` +
                        `${resetErr instanceof Error ? resetErr.message : String(resetErr)}\n`,
                    );
                }

                // R38 fix: direct access replaces bumpAttempt.
                repoState = {
                    ...repoState,
                    attempts: { ...(repoState.attempts ?? {}), [errKind]: attempts + 1 },
                };

                // R11 fix: pass the plan structure to queueRetry for structural hashing.
                const retryResult = queueRetry(
                    result.id,
                    repoState,
                    [classified.error],
                    { committedShas, pendingFiles },
                    settings,
                    systemPrompt,
                    result.commits,
                );

                // R5 fix: loop-detected comes back as a discriminated result, no sentinel.
                // R62 fix: set the dedicated loopDetected field on RepoState (replaces
                // regex-extraction from error string).
                if (retryResult.kind === "loop-detected") {
                    nextRepos[result.id] = {
                        ...retryResult.repoState,
                        status: "FAILED",
                        error: `Loop detected: LLM returned an identical plan on two consecutive attempts for kind "${errKind}".`,
                        loopDetected: {
                            kind: errKind,
                            planHash: retryResult.repoState.lastPlanHash ?? "",
                        },
                    };
                    continue;
                }

                nextRepos[result.id] = retryResult.repoState;
                continue;
            }

            nextRepos[result.id] = {
                ...repoState,
                status: "FAILED",
                error: classified.error.message,
            };
        }
    }

    if (retryJobs.length > 0) {
        // Snapshot before handing off — the queue is module-scope and will be repopulated
        // by helpers on the next iteration of this phase.
        const jobsSnapshot = retryJobs.slice();
        return io.delegateAgentBatch(
            {
                kind: "agent-batch",
                agentType: "git-commit-generator",
                label: "commit-jobs-retry",
                jobs: jobsSnapshot,
                timeout: 600_000,
                retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 30000 },
            },
            "commit-and-push",
            { repos: nextRepos },
        );
    }

    printReport(nextRepos);
    const hasFailedRepo = Object.values(nextRepos).some((r) => r.status === "FAILED");
    if (hasFailedRepo) {
        return io.fail(new Error("One or more repositories failed to publish commits. Check report."));
    }
    return io.done({});
}),
```

**Acceptance**: the phase body satisfies the retry flow contract verified by unit tests U-GE-26 through U-GE-33.

---

### Phase 5 — Bridge

The bridge module formats the user prompt sent to the LLM. It uses the shared types (`FeedbackError`, `CommittedSha`, `Feedback`, `CommitJobPayload`) rather than redeclaring them — sharing types eliminates drift risk when the contracts evolve.

#### Replace feedback formatting block

```ts
if (payload.feedback) {
    finalUserPrompt += `\n\n--- FEEDBACK FROM PREVIOUS ATTEMPT(S) ---\n`;
    finalUserPrompt += `Your previous plan(s) were rejected. Fix the issues below:\n\n`;

    for (const err of payload.feedback.errors) {
        finalUserPrompt += `[${err.kind.toUpperCase()}] ${err.message}\n`;
        if (err.resolution_hint) {
            finalUserPrompt += `  → Resolution: ${err.resolution_hint}\n`;
        }
        if (err.files?.length) {
            finalUserPrompt += `  → Affected files: ${err.files.join(", ")}\n`;
        }
        finalUserPrompt += `\n`;
    }

    if (payload.feedback.committed_shas?.length) {
        finalUserPrompt += `Already committed (DO NOT re-include these files):\n`;
        for (const entry of payload.feedback.committed_shas) {
            finalUserPrompt += `  - ${entry.sha.slice(0, 7)}: ${entry.files.join(", ")}\n`;
        }
        finalUserPrompt += `\n`;
    }

    if (payload.feedback.pending_files?.length) {
        finalUserPrompt += `Pending files (MUST be covered by the new plan):\n`;
        for (const f of payload.feedback.pending_files) {
            finalUserPrompt += `  - ${f}\n`;
        }
        finalUserPrompt += `\n`;
        // <remaining-diff> block — the publisher re-staged pendingFiles and captured
        // their actual diff content so the LLM can write commit messages without
        // needing to invent them from paths alone. See Decision 6 + queueRetry diff
        // reconstruction in Phase 4.
        finalUserPrompt += `<remaining-diff>\n${payload.diff}\n</remaining-diff>\n\n`;
    } else if (payload.feedback.committed_shas?.length) {
        // Everything that landed is recorded; nothing else to do. Return [].
        finalUserPrompt += `No pending files remain. Return an empty array [] if all work is covered by committed_shas above.\n\n`;
    }

    finalUserPrompt += `Previous attempt(s) (full plan, in order):\n${payload.feedback.previous_commit}\n\n`;
    finalUserPrompt += `Generate a NEW JSON array that resolves all listed errors.\n`;
}
```

**Acceptance**: existing bridge tests pass; new test verifies `[STRUCTURAL]`, `→ Resolution:`, `<remaining-diff>` sections appear in the prompt.

---

### Phase 6 — System Prompt

**Artifact**: system prompt module

Add a new section **before** "Format & Conventions":

```markdown
## Interpreting Feedback

When your previous attempt is rejected, you receive a `FEEDBACK` block
listing errors. Each error has a `kind` and an optional `resolution_hint`.

| Kind | Cause | Action |
|---|---|---|
| `validation` | Subject/body violates Conventional Commits | Re-write the message |
| `structural` | Plan structure invalid (duplicate files, missing files, etc.) | Re-architect the plan (merge into Fat Commit or split files) |
| `race` | Diff changed during inference | Re-analyze the current diff |
| `git` | Git command failed mid-execution | Check `pending_files` to see what's left |
| `network` | Push failed (transient: retry once; permanent: fail-closed) | Only transient failures trigger a retry — just regenerate the same plan; non-transient failures are surfaced to the user |

When `committed_shas` is present, those commits are already in history —
each entry lists the files committed in that SHA. Do NOT re-include those
files in the new plan.

When `pending_files` is present, it lists the files that were planned but
never committed. Your new plan MUST cover exactly those files (plus any
files you decide to regroup via Fat Commit) and nothing else.

When both `committed_shas` and `pending_files` are present, you must avoid
files in `committed_shas` and cover everything in `pending_files`.

When neither is present, regenerate based on the current `diff` from
scratch.

When `committed_shas` is non-empty AND `pending_files` is empty (or absent),
all work is already in history. The correct response is a **bare empty
array `[]`** (R57 fix — the `done: true` marker introduced in R35 was
dropped because the bridge, system prompt, and publisher were mutually
contradictory about its format, making the success path dead code).
The orchestrator detects this via `committedShas.length > 0` and treats it
as SUCCESS — no retry consumed. If you forget to include files, the
orchestrator detects this (no `committedShas` yet) and queues a structural
retry. Example:

```
[]
```
```

---

### Phase 7 — Tests

#### 7.1 Publisher tests

| Test ID | Status | Change |
|---|---|---|
| U-GE-15 | modify | Expect `CommitPlanError` instance, check `kind === "duplicate-file"`, verify return value `{ committedShas: [], originalHead }` |
| U-GE-16 (NEW) | add | Inject failing commit at index 1 of 3; assert `PartialCommitError` with `committedShas.length === 1`, staging cleaned, `pendingFiles` includes plan 2's files (C2 regression) |
| U-GE-17 (NEW) | add | All commits succeed; assert return `{ committedShas: [3 SHAs], originalHead }` AND that each commit contains ONLY its own files (C1 regression via `git show`) |
| U-GE-18 (NEW) | add | Mutate staging after hash extraction; assert `DiffHashMismatchError` thrown before reset |
| U-GE-19 (NEW) | add | Plan references empty file; assert `CommitPlanError(kind: "missing-file")` |
| U-GE-20 (NEW) | add | 2-plan case (success): assert `git show` for commit 1 shows only plan 1's files, `git show` for commit 2 shows only plan 2's files — covers C1 |
| U-GE-21 (NEW) | add | 3-plan case where plan 2 fails (post-commit failure): assert plan 1's commit contains ONLY plan 1's files, and `pendingFiles` includes plan 2's files (C2) |
| U-GE-22 (NEW) | add | Plan references nonexistent file: assert `CommitPlanError(kind: "nonexistent-file")` thrown before `PartialCommitError` (M8) |
| U-GE-23 (NEW) | add | `gitExec("reset HEAD")` succeeds in catch block; assert no credential prompts can hang the reset (R8 regression). Inject a hook that fails on reset and assert cleanup proceeds without hanging. |
| U-GE-24 (NEW) | add | Push inner-upstream failure with an auth error message captured from a REAL CI run (e.g., the stderr of `git push -u origin main` against a private repo with no credentials). The captured string is stored in a test fixture and `classifyTransient()` is asserted to return `false`. **Do not hand-author the substring** (R34 fix: the test must prove the signatures match real git output, not tautologically). |
| U-GE-25 (NEW) | add | Push inner-upstream failure with a network-timeout message captured from a REAL CI run (e.g., the stderr of `git push` against a repo on a network with simulated packet loss). The captured string is stored in a test fixture and `classifyTransient()` is asserted to return `true`. Same caveat as U-GE-24 (R34). |
| U-GE-42 (NEW) | add | Plans with the same file under different syntactic forms (`["src/foo.ts"]`, `["src/./foo.ts"]`, `["src/bar/../foo.ts"]`) throw `CommitPlanError(kind: "duplicate-file")` on the second plan (R56 fix). |
| U-GE-43 (NEW) | add | Plans with the same file but trailing slash (`["src/foo.ts"]` vs `["src/foo.ts/"]`) throw `CommitPlanError(kind: "duplicate-file")` on the second plan (R56 fix). |
| U-GE-44 (NEW) | add | Plans with the same file but different casing on a case-insensitive filesystem (`["src/Foo.ts"]` vs `["src/foo.ts"]`) are NOT flagged as duplicates (R56 limitation: case normalization is out of scope). Assert the guard does NOT throw and that the LLM is informed via the system prompt to use canonical casing. |

#### 7.2 Error class tests

Unit tests for each error class:
- Constructor stores fields correctly
- `name` property matches class name
- `instanceof Error` is true
- `instanceof <specific class>` is true

#### 7.3 Bridge tests

| Test | Asserts |
|---|---|
| Feedback with structural + duplicate-file | Prompt contains `[STRUCTURAL]`, `→ Resolution:`, `→ Affected files:` |
| Feedback with partial commit | Prompt contains `Already committed`, `Remaining diff`, `<remaining-diff>` |
| Feedback with validation | Backward-compat: each error prefixed by `-` style line |
| No feedback | Prompt unchanged |

#### 7.4 Error classifier tests

Pure unit tests for `classifyError` (discriminated union shape from R43) and `getResolutionHint`:
- Each error class maps to expected `{ kind: "retry" | "fail", error }` (R43 shape)
- `CommitPlanError("empty-plans")` + `committedShas.length > 0` + `llmResponse = '[]'` (no marker) → `{ kind: "retry", error: { kind: "structural", ... } }` (R35 fix: bare `[]` without marker is a structural failure)
- `CommitPlanError("empty-plans")` + `committedShas.length > 0` + `llmResponse = '[{"done": true}]'` → `{ kind: "success" }` (R35 fix: marker presence triggers success)
- `getResolutionHint` returns correct strings for each kind (including `nonexistent-file` and the revised `empty-plans` hint)
- Unknown errors map to `{ kind: "fail", error: { kind: "git", ... } }`
- `PushError(transient=true)` → `{ kind: "retry", error: { kind: "network", ... } }` (covers D2)
- `PushError(transient=false)` → `{ kind: "fail", error: { kind: "network", ... } }` (covers D2)

#### 7.4b Queue-retry tests

Pure unit tests for `queueRetry` (requires extracting it as an exported function from the orchestrator):

| Test ID | Asserts |
|---|---|
| U-GE-26 | Called once with a plan: returns `{ kind: "queued", repoState: <new>, job: {...} }`; `retryJobs` contains the job; `repoState.lastPlanHash === sha256(canonical(plan))` (R11 fix) |
| U-GE-27 | Called twice with the same plan structure: second call returns `{ kind: "loop-detected" }`; no job is pushed (R5, R11 fixes) |
| U-GE-28 | Called with `pendingFiles` set: re-stages them temporarily, captures diff, resets, passes diff in payload (C3) |
| U-GE-29 | Called with `pendingFiles` empty / undefined: re-reads `git diff --cached` (validation-retry path) |
| U-GE-30 | (REMOVED in R38) `bumpAttempt` no longer exists. Direct access test replaced by the inline-update test below. |
| U-GE-30a (NEW) | add | Direct inline update `repoState.attempts?.[kind] ?? 0` then `{ ...repoState, attempts: { ...repoState.attempts, [kind]: n + 1 } }` returns a NEW `RepoState` and does not mutate the input (C5 regression under R38). |
| U-GE-31 | `queueRetry` with `pendingFiles` overlapping `committedShas`: filters out committed files from `pendingFiles` before any re-staging (R6 fix) |
| U-GE-32 | `queueRetry` called 11 times: `feedbackHistory` is capped at 10 entries, oldest dropped (R20 fix) |
| U-GE-33 | `queueRetry` called twice with different message wording but identical plan structure (same files, same plan order): second call returns `loop-detected` (R11 fix — hashes structure, not messages) |

#### 7.4c LLM-side error classification tests

Pure unit tests for `classifyLLMFailure` and the `result.success === false` branch in the `commit-and-push` phase body (covers R7, R27):

| Test ID | Asserts |
|---|---|
| U-GE-34 | LLM bridge prefix `"[git-commits-push-tl bridge] validation rejected"` → `classifyLLMFailure` returns `"validation"`; the phase body bumps the `validation` counter and queues a retry (R7 + R27 fix). |
| U-GE-35 | LLM bridge prefix `"[git-commits-push-tl bridge] JSON parse failed"` → `classifyLLMFailure` returns `null`; the phase body marks the repo FAILED with `error: "LLM fatal error: ..."` and no retry (R7 + R27 fail-closed default). |
| U-GE-36 | LLM bridge prefix `"[git-commits-push-tl bridge] network timeout"` → `classifyLLMFailure` returns `null`; same as U-GE-35 (R7 + R27). |
| U-GE-37 | Unknown error string (no bridge prefix, no signature match) → `classifyLLMFailure` returns `null`; same as U-GE-35. Covers R27's "fail-closed by default" contract for unrecognized failure modes. |

#### 7.4d Empty-plans success tests

Pure unit tests for the empty-plans-with-committedShas special case (R16, Decision 13):

| Test ID | Asserts |
|---|---|
| U-GE-38 | Publisher throws `CommitPlanError("empty-plans")` AND `repoState.committedShas.length > 0`: repo marked SUCCESS, no retry (R57 — bare `[]` is sufficient; no marker needed) |
| U-GE-39 | Publisher throws `CommitPlanError("empty-plans")` AND `repoState.committedShas.length === 0`: repo consumes structural retry budget normally (R57 negative path) |
| U-GE-40 | Publisher throws `CommitPlanError("duplicate-file")` AND `repoState.committedShas.length > 0`: still retryable structural (R57 — only `empty-plans` gets the special case) |
| U-GE-45 (NEW) | add | Publisher commits plan 1 successfully, then plan 2 throws `CommitPlanError("missing-file")`: assert `err.context.committedShas` includes plan 1's SHA, and the orchestrator's `repoState.committedShas` includes it after the merge (R59 — committed SHA loss fix). Same for `nonexistent-file`. |

#### 7.4e Escalation tests (Round 8)

Pure unit tests for the escalation re-invocation path:

| Test ID | Asserts |
|---|---|
| U-GE-47 (NEW) | add | End-to-end escalation scenario: invoke `executeCommits` with a plan that triggers duplicate-file, exhaust the retry budget, assert `status === "ESCALATED"` and `escalationContext` has expected fields (`committedShas`, `pendingFiles`, `lastError`, `feedbackHistory`, `attemptsByKind`). Re-invoke `executeCommits` with the received `escalationContext` as `escalationHint`: assert the LLM is called once with `feedback` populated (not twice), assert `<remaining-diff>` contains only the `pendingFiles`, assert `<previous_commit>` contains the full history. If the LLM succeeds, assert `status === "SUCCESS"` and the new `committedShas` includes the originally-pending files. If the LLM fails again, assert `status === "ESCALATED"` again with accumulated history. Covers Decisions 14, 15, 16. |
| U-GE-48 (NEW) | add | `formatEscalationAsFeedback(hint)` returns a `Feedback` object with `errors[0] === hint.lastError`, `committed_shas === hint.committedShas`, `pending_files === hint.pendingFiles`, `previous_commit === hint.feedbackHistory.join(...)`. Optional fields `recommended_action` and `loop_detected` are forwarded verbatim. |
| U-GE-49 (NEW) | add | `executeCommits` with `escalationHint.attemptsByKind.structural === 1` (already used) AND fresh budget: assert the new invocation's budget is fresh (`MAX_ATTEMPTS_BY_KIND.structural`), NOT carried over from the hint. Covers Decision 15. |
| U-GE-50 (NEW) | add | `executeCommits` with `escalationHint` AND no `pendingFiles`: assert `reconstructRemainingDiff` returns the full diff (or the worktree-only diff if the worktree has uncommitted changes). Covers the edge case where everything landed in the previous invocation. |

#### 7.5 Parallel-isolation invariants

No regression: two repos with different errors don't contaminate each other (one duplicate-file, one success).

---

### Phase 8 — Manual Smoke Tests + Reporter Update

#### 8.0 Reporter contract (R39 fix)

The reporter is the user's only window into retry behavior. It surfaces committed SHAs, per-kind retry counts, total retries, and loop-detected outcomes — without these fields the user cannot tell whether a retry happened.

```ts
export interface RepoReport {
    repository: string;
    // Round 8: RepoReport mirrors RepoState status including ESCALATED.
    status: "PENDING" | "RUNNING" | "ESCALATED" | "SUCCESS" | "FAILED";
    error?: string;
    // R39 NEW: cumulative committed SHAs (one entry per landed commit, in order)
    committedShas: CommittedSha[];
    // R39 NEW: per-kind retry counts
    attempts: Partial<Record<FeedbackError["kind"], number>>;
    // R39 NEW: total retries across all kinds (sum of `attempts`)
    totalRetries: number;
    // R62 NEW: loop-detected outcome, read directly from RepoState.loopDetected
    // (set by the orchestrator when classifyError or queueRetry detects a loop).
    // The previous regex-based extraction (r.error?.match) was fragile and
    // missed LLM-side loop errors (which had "Loop detected after LLM-side
    // failure." — no "for kind" substring). The dedicated field is reliable.
    loopDetected?: {
        kind: FeedbackError["kind"];
        planHash: string;
    };
}

export function buildReport(repos: Record<string, RepoState>): RepoReport[] {
    return Object.entries(repos).map(([id, r]) => {
        const attempts = r.attempts ?? {};
        const totalRetries = Object.values(attempts).reduce((a, b) => a + b, 0);
        return {
            repository: r.repository,
            status: r.status,
            error: r.error,
            committedShas: r.committedShas ?? [],
            attempts,
            totalRetries,
            // R62 fix: read from the dedicated field on RepoState (not regex).
            loopDetected: r.loopDetected
                ? { kind: r.loopDetected.kind as FeedbackError["kind"], planHash: r.loopDetected.planHash }
                : undefined,
        };
    });
}

// printReport is updated to render the new fields:
//   - committedShas.length (count + short SHAs)
//   - attempts as a per-kind breakdown (e.g., "structural: 1, validation: 0")
//   - loopDetected as a banner line if present
```

#### 8.1 Smoke tests

1. **Build & tests pass**: typecheck and all unit/integration tests pass.
2. **Multi-concern happy path**: 3 concerns, disjoint files → 3 commits, 1 push.
3. **Multi-concern Fat Commit**: 2 concerns on shared file → 1 commit (LLM decides).
4. **Forced duplicate retry**: 3 concerns, force one file in 2 plans → 1 retry, success at attempt 2.
5. **Partial commit retry** (R18 + R33 fix): 3 plans (plan A on file `a.ts`, plan B on file `b.ts`, plan C on file `c.ts`). Install a `pre-commit` hook in the test repo that exits non-zero on the commit whose message contains `"plan B"`. Run the publisher: plan A commits successfully; plan B's `git commit` fails with the hook's non-zero exit; the publisher's catch block runs `gitExec("reset HEAD")` (R8 fix), throws `PartialCommitError` with `committedShas = [sha-A]` and `pendingFiles = [b.ts, c.ts]`. The orchestrator's catch block classifies it as retryable `git` kind and queues a retry via `queueRetry` with `pendingFiles`. The retry prompt MUST contain `pending_files: [b.ts, c.ts]` and `<remaining-diff>` (re-staged). After the retry, plans B and C commit in order. Verify with `git log` showing 3 commits and `git show <sha-A>` containing ONLY `a.ts` (C1 + C2 regression). **Why this scenario**: it is the only failure mode that reliably reaches `PartialCommitError` after the M8 fix (a missing file would be caught earlier as `nonexistent-file`).
6. **History verification**: `git log` shows expected commits in expected order, no orphan commits.
7. **Empty-plan success** (R57 fix — marker dropped): 2 plans, plan 1 commits successfully. LLM's retry returns bare `'[]'` (empty array). Expected: repo marked SUCCESS with `committedShas.length === 1` (not FAILED after a structural retry). **Negative variant**: on the FIRST attempt (no prior commits landed), LLM returns bare `'[]'`. Expected: repo consumes the structural retry budget; if at attempt 1, a second retry is queued; after the retry budget is exhausted, repo marked FAILED with `error` referencing the structural reason. This proves R57's `committedShas.length > 0` check correctly distinguishes "all work done" from "LLM forgot files" without needing a marker.
8. **Reporter visibility** (R14 + R39 fix): any smoke test above must show `committedShas` count, per-kind `attempts`, and any `loop-detected` failures in the final report (see the reporter interface stub in Phase 8). Without these, the user cannot tell whether a retry happened. Test U-GE-41 asserts the reporter renders this data correctly.

---

## 5. Backward Compatibility

- **`feedback.validation_errors`** is removed (replaced by `errors[]` with `kind: "validation"`). If any external consumer relied on it (none expected — internal to the skill), it must migrate.
- **`feedback.remaining_diff`** is removed; replaced by `pending_files` (Decision 6).
- **`feedback.committed_shas`** changes shape from `string[]` to `CommittedSha[]` (Decision 3).
- **`executeMultiCommitAndPush`** signature changes (return type). All internal callers updated in Phase 4.
- **`RepoState.attempts`** changes shape from `number` to `Partial<Record<kind, number>>`. On loading legacy serialized state, treat `attempts === number` as `attempts = {}` (zero out all per-kind counters) — the legacy global counter cannot be reliably mapped to any specific kind, and applying it uniformly would prevent all retries. Zeroing is the safer choice (a fresh retry budget) given that the legacy code path has already failed.

  **Migration shim behavior** — when loading previously-serialized state, the loader handles two legacy shapes silently:

  - **Legacy `attempts: number`** (the pre-Phase-4 global counter): treat as `attempts: {}` — zero out all per-kind counters. The legacy global counter cannot be reliably mapped to any specific kind, and applying it uniformly would prevent all retries. Zeroing is the safer choice (a fresh retry budget) given that the legacy code path has already failed.
  - **Legacy `commit?: CommitMessage`** (the pre-Phase-2 singular field): strip silently rather than reject. The field was renamed to `commits?: CommitPlan[]` and legacy state may still carry the old name; ignoring it preserves forward compatibility.

  Both behaviors are part of the load contract; any loader implementation must satisfy them.

- **Pre-merge check (R45 fix)** — scan for external consumers of the old `committed_shas: string[]` shape (now `CommittedSha[]`); any consumer must be migrated in the same release. Document the scan result in the release notes.
- **`RepoState`** gains optional fields (`committedShas`, `originalHead`, `feedbackHistory`). Existing serialized state from previous runs remains decodable.
- **`CommitPlanSchema`** unchanged — same JSON shape returned by the LLM.

---

## 6. Open Follow-ups (deferred to future versions)

1. **Configurable `MAX_ATTEMPTS_BY_KIND`** — expose via `settings.json`; bump `structural` to 2 if empirically needed.
2. **`onProgress` callback** — add if a UI or live reporter is built.
3. **E2E tests with mocked Turnlock** — add once the state machine has a stable mocking surface.
4. **Automatic rollback on `PartialCommitError`** — only if a safe mechanism is designed (e.g., snapshot working dir before execution).

### Follow-ups surfaced by hostile review — status after revision 2

Items 5, 6, 7 were originally deferred but were promoted to inline implementation
during revision 2 (hostile review round 2). They are now part of the plan's
implementation phases, not deferred work. Item 4 (`onProgress`) remains a true
deferred follow-up.

5. **Loop detection for repeated identical plans (M2, implemented inline; round 3 revision R5 + R11)** — `queueRetry` hashes the **canonical plan structure** (sorted files per plan, normalized commit fields, sha256 of the canonicalized JSON) and stores it in `RepoState.lastPlanHash`. If the next call's hash matches, `queueRetry` returns `{ kind: "loop-detected", repoState }` (a discriminated union variant — the round 2 `__LOOP_DETECTED__` string sentinel was removed in round 3). The phase body fails the repo closed (consuming zero additional retry budget). `lastPlanHash` resets on diffHash change. Two structurally identical plans with different message wording now produce the same hash (R11); two plans with different files produce different hashes.
6. **`gitExec` helper extraction (M5, revised)** — `gitExec` is shared between the publisher (for the commit loop) and the orchestrator's `queueRetry` (for diff reconstruction). Documented contract: `(args: string, cwd: string) => string` — returns trimmed stdout, throws on non-zero exit (with stderr captured into the thrown Error message — this is what makes the `msg.includes(...)` classifier work). Done as part of Phase 3.
7. **`CommitPlanError("nonexistent-file")` kind (M8, implemented inline)** — new `CommitPlanErrorKind` value `"nonexistent-file"` added in Phase 1. Phase 3 commit loop now detects `fatal: pathspec 'X' did not match any file(s)` from `git add` stderr and throws `CommitPlanError(kind: "nonexistent-file")` instead of falling through to `PartialCommitError`. Phase 4 `classifyError` maps it to `kind: "structural"` so it consumes the structural retry budget (not the git budget).

---

## 7. Definition of Done

- [ ] All 6 implementation phases merged (Phases 1–4 + reporter update in Phase 8).
- [ ] All test phases green — including new tests for the previously-uncovered paths (M1): plan 1-of-N partial failure, attempt-budget exhaustion, `committed_shas` accumulation, push inner-error capture, and per-kind counter independence.
- [ ] Regression tests for the critical bugs fixed in revision 2:
    - [ ] U-GE-20: 2-plan success case — assert each plan's commit contains ONLY its own files (no inter-commit bleed; covers C1).
    - [ ] U-GE-21: 3-plan case with plan 2 failing (post-commit failure) — assert plan 1's files end up in plan 1's commit only, and `pendingFiles` includes plan 2's files (covers C2).
- [ ] Regression tests for the critical bugs fixed in revision 3 (hostile review R1–R25):
    - [ ] U-GE-22: nonexistent file in plan — assert `CommitPlanError(kind: "nonexistent-file")` thrown BEFORE `PartialCommitError` (M8).
    - [ ] U-GE-23: catch-block `git reset HEAD` does not hang on credential prompts — covers R8.
    - [ ] U-GE-24 + U-GE-25: inner-upstream push classified `transient: false` for auth, `transient: true` for network — covers R10.
    - [ ] U-GE-26: `queueRetry` called once returns `{ kind: "queued" }` with a NEW `RepoState` and pushes a real job — covers R4, R5.
    - [ ] U-GE-27: `queueRetry` called twice with identical plan STRUCTURE (different messages allowed) returns `{ kind: "loop-detected" }` — covers R5, R11.
    - [ ] U-GE-28: `queueRetry` with `pendingFiles` re-stages them and captures diff — covers C3.
    - [ ] U-GE-29: `queueRetry` with empty `pendingFiles` re-reads `git diff --cached` — covers validation-retry path.
    - [ ] U-GE-30a: inline `attempts` update returns a NEW `RepoState` (replaces removed `bumpAttempt`) — covers R38.
    - [ ] U-GE-31: `queueRetry` with `pendingFiles` overlapping `committedShas` filters committed files — covers R6.
    - [ ] U-GE-32: `feedbackHistory` capped at 10 entries — covers R20.
    - [ ] U-GE-33: `queueRetry` with structurally identical plans but different message wording detects loop — covers R11.
    - [ ] U-GE-34–U-GE-37: LLM-side failures (`result.success === false`) classified by signature, fail-closed by default — covers R7, R27.
    - [ ] U-GE-38–U-GE-40: empty-plans with non-empty `committedShas` AND `done: true` marker = SUCCESS; bare `[]` without marker consumes structural retry — covers R16, R35.
- [ ] Regression tests for the critical bugs fixed in revision 5 (hostile review R57–R66):
    - [ ] U-GE-38: empty-plans with non-empty `committedShas` = SUCCESS, no marker required (R57).
    - [ ] U-GE-39: empty-plans with empty `committedShas` consumes structural retry (R57 negative path).
    - [ ] U-GE-45: `CommitPlanError.context.committedShas` populated by publisher and merged into `repoState.committedShas` by orchestrator for both `missing-file` and `nonexistent-file` (R59).
    - [ ] Migration shim (`state-loader.ts`): accepts `attempts: number` AND strips legacy `commit?: CommitMessage` silently — round-trip test for legacy state (R63).
    - [ ] `push-signatures.json` exists and is loaded by publisher (R60); production list matches fixture list (regression test).
    - [ ] Reporter reads `RepoState.loopDetected` directly (not regex) — U-GE-41 extension (R62).
    - [ ] Total feedback cap: `previous_commit` joined string truncated at 64 KB with trailing `[truncated]` marker (R65).
    - [ ] Bridge uses the shared `FeedbackError`, `CommittedSha`, `Feedback`, `CommitJobPayload` types (no local redeclaration) — U-GE-46 (R66).
    - [ ] Reset loop only resets when `r.diffHash !== state.diffHash` (where `state.diffHash` is the new top-level schema field) — counters persist across phase re-entries (R58).
- [ ] Regression tests for the critical bugs fixed in revision 4 (hostile review R26–R55):
    - [ ] U-GE-26–U-GE-33: `queueRetry` discriminated-union outcomes + structural hashing + per-entry byte cap + worktree guard (R4, R5, R11, R20, R28, R29).
    - [ ] U-GE-30a: inline attempts update is immutable (replaces removed `bumpAttempt`) — covers R38.
    - [ ] U-GE-34–U-GE-37: LLM bridge error signatures fail-closed (R7, R27).
    - [ ] U-GE-41: reporter renders `committedShas`, per-kind `attempts`, total retries, loop-detected banner — covers R39.
    - [ ] Migration shim: `legacyAttemptsSchema` accepts `attempts: number` and normalizes to `{}`; round-trip test for legacy state — covers R37.
    - [ ] Pre-merge scan for external consumers of the old `committed_shas: string[]` shape returns zero results — covers R45.
    - [ ] Integration test asserts Turnlock single-instance execution guarantee for `commit-and-push` — covers R26. If the invariant cannot be asserted, fall back to the per-invocation queue implementation (stash on `nextRepos[id].__pendingRetry`).
    - [ ] Per-entry byte cap test: a plan with 5000 synthetic files produces a truncated `[truncated]` entry in `feedbackHistory` — covers R29.
    - [ ] Worktree guard test: a pendingFile with worktree-vs-index diff is NOT re-staged; its content is captured via `git diff <file>` instead — covers R28.
    - [ ] Discriminated-union test for `classifyError`: returns `{ kind: "retry" | "fail", error } | { kind: "success" }`; no `null` return — covers R43.
    - [ ] Validator-required test: missing validator with default settings throws; with `settings.allowMissingValidator = true` it skips — covers R47.
    - [ ] `stateSchema` refinement test: `attempts["validaton"]` (typo) is rejected at deserialization — covers R48.
    - [ ] U-GE-24 + U-GE-25: push classification uses REAL git output from test fixtures, NOT hand-authored substrings — covers R34.
    - [ ] U-GE-42–U-GE-44: duplicate-file guard normalizes paths via `path.posix.normalize()` before comparison — covers R56.
- [ ] Escalation channel (Round 8):
    - [ ] U-GE-47: end-to-end escalation re-invocation — assert `status === "ESCALATED"` on first invocation, re-invoke with `escalationHint`, assert LLM receives feedback block on first call of second invocation, assert SUCCESS or second ESCALATED with accumulated history — covers Decisions 14, 15, 16.
    - [ ] U-GE-48: `formatEscalationAsFeedback` maps `EscalationContext` to `Feedback` field-by-field, forwarding `recommended_action` and `loop_detected` verbatim.
    - [ ] U-GE-49: `executeCommits` with `escalationHint` starts with fresh budget (not carried over from `hint.attemptsByKind`) — covers Decision 15.
    - [ ] U-GE-50: `executeCommits` with `escalationHint` and empty `pendingFiles` falls back to the full diff (or worktree-only diff) — covers the edge case where everything landed previously.
- [ ] Manual smoke tests pass (including smoke test 7 — empty-plan success, and smoke test 8 — reporter shows `committedShas` and per-kind `attempts`).
- [ ] Typecheck clean.
- [ ] Lint clean.
- [ ] `git log` shows expected commits on each smoke test repo (with each commit containing ONLY its own files — regression check for C1).
- [ ] System prompt changes documented for new feedback kinds (including the `[]` empty-array case).
- [ ] `README.md` updated for new feedback format, new return-value shape, and the `committed_shas` shape change.
- [ ] Conventional commit per phase (`feat:`, `fix:`, `refactor:`) using `/git-commits-push`.