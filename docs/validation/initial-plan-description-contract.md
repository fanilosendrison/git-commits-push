---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "verification-record"
name: "Initial Commit Plan Description Contract"
version: "0.1.4"
domain: "git-commits-push"
severity: "guideline"
---

# Initial commit plan description contract

## Authority and bounded correction

The implemented initial result schema requires `commit.description`. Its optional
`body` is not a substitute. The generation prompt owns instructions to the model;
Zod, message validation, exact Git membership/tree checks and publication
readback remain independent deterministic gates. This record is evidence, not
new publication or release authority.

The correction makes required fields and the distinct description/body roles
explicit in the existing prompt. No result schema, provider adapter, retry,
fallback, authentication, source witness, file assignment, reconciliation or
publication code changes. Later source-only contributor qualification tooling
is recorded separately below; it does not change those production paths. The first unpublished candidate0.10.3 followed source
baseline0.10.2. Concurrent integration of PR32 advanced main to
5ea7ae6a758a46bb919ce56d93a392067c56604e, package0.11.0. The reconciled candidate
is0.11.1; it preserves that integration and changes no prepared-merge authority.
The host initially used0.10.1 and was later independently observed at0.11.0.
Neither observation is activation or qualification of this candidate.

## Historical evidence and its limit

Issue31 preserves two terminal failures from installed release
0.10.1-a6b3e50ccd45d534d6ca126d1f3843bb57be973b760094bda8fb5d2f0a3c36e5:

- 01M70RYWC88YABBVVTR4PTFHGZ;
- 01M70S0GRCRTNTKB1N1K6QTY9G.

Both retained missing-description diagnostics at four plan indexes and refused
before commit/push. Their prompt SHA256 is
7918925f99c6b03425d37abc24903df1a4b2d126a6bdc0981067c45a71e61be4.
It contains valid examples with `description`; no prompt/schema contradiction
was found. The rejected response bodies were NOT retained. Their exact original
contents, grouping and model-side causal reasoning therefore remain unknown.
A reconstructed shape is never described as an original response.

## New instrumented reproduction

Three new logical invocations used the same configured
`google/gemini-3.5-flash-lite`, temperature0.2, thinking disabled and preserved
planning input, with
no Git effects, provider switch or manual output repair. Each completed in one
provider attempt. These are distinct observations, not retries/resumptions of
historical publication authority.

1. Baseline prompt: five commit objects omitted `description`, retaining
   `type`, `scope`, `body`, `isBreaking`. Response SHA256
   afe54991b4317419c78bf623d2034fb58443e1c2c185fc81445a740e27e83c33.
   The exact non-secret response text is retained as a test fixture.
2. Baseline prompt, HTTP-level capture: eight objects again omitted that field.
   The actual HTTP candidate text equalled the invoker output. HTTP-body SHA256
   cb6d75b6608ce450a59cbc34274180049c22cb9a38484e4733041f7ed23e6b30.
   This places the observed omission before adapter parsing or Zod validation.
3. Clarified prompt: two schema-valid plans contained descriptions and covered
   the exact eight input paths. Response SHA256
   b89103618902be87c43a903b972e0be56c0c4d15dc038a5c7218cfc98ea4a981.

The established current failure class is model-generated schema-incomplete
output, not an adapter deleting fields or a schema incorrectly making them
required. Explicit required-field instructions correct the generation contract's
insufficient emphasis. They cannot guarantee future model compliance: an invalid
future response MUST still fail closed. The model's internal reason for omitting
fields and the lost historical raw bytes are not claimed as established.

Different fresh initial plans may group files differently under the existing
planning authority. This was NOT a message-only repair of a previously accepted
plan, and no existing caller plan or Git state was changed. Message-only repair
continues to preserve its original groups/cardinality/protected fields.

## Atomic discovery disposition

- **Statement:** new actual provider outputs omit a required field despite valid
  examples; the initial response contract does not explicitly distinguish the
  required subject field from optional body text.
- **Source/evidence:** instrumented observations above; the retained schema,
  prompt, Google transport/parser and invoker, plus deterministic refusal tests.
- **Existing authority:** `src/modules/turnlock/job-result-schema.ts`, the existing
  generation prompt, message-only repair rules and reconciliation specification.
- **Semantic disposition:** `no-normative-impact` for contract clarification and
  verification; no publication or fallback semantics are newly selected.
- **Affected layers:** architecture-or-implementation,
  integration-or-conformance, verification-or-qualification-evidence,
  repository-governance-or-documentation.
- **Related consequences:** caller Review Broker publication remains a separate
  task and cannot resume on an unqualified candidate or an old review verdict.
- **Required authority/next action:** exact-source CI and independent review,
  applicable integration, isolated installation qualification and official host
  activation/readback before claiming installed availability.

## Deterministic regression boundaries

The new source tests retain the captured current invalid response byte-exactly,
check prompt examples against the production schema, reject single/multiple
missing descriptions and body-only objects, preserve exact valid plans, and
exercise malformed output, failure and valid-second-response paths under the
unchanged two-local-attempt budget. Existing tests cover protected message-only
repair, exhausted primary/fallback budgets and typed provider failures.

Installed tests exercise the public launcher against disposable real Git and
bare remotes, replacing ONLY the HTTP boundary. Single/multiple missing fields
and malformed response shape cause exactly two requests and no commit/push or
index-tree change. Complete and valid-second-response plans publish the exact
captured tree with four commits and the exact independently expected file in
each commit. They do not invoke the real caller or treat schema acceptance as
complete-publication proof.

Negative sensitivity controls retain nonpassing output when the old prompt is
restored, and when the required description validator is temporarily removed.
Both source files are restored byte-exactly afterward. No assertion is weakened.

Initial focused baseline tests first failed during setup because private
workspace packages had not been built. That output remains preserved; after
`build:packages`, all40 focused baseline tests passed. The new5 source and5
isolated installed tests passed. Neither result substitutes for the full required
suite, exact published-SHA CI, independent review or installed host qualification.

## Preserved validation interruptions and reconciliation

The old-base full source run reported735/741 PASS and6 failures, exit1. Two
agent-added environment overrides invalidated five test expectations: a TMPDIR
inside the Git worktree made the outside-repository fixture discover Git, and
`PI_SKILL_STATS_MODE=test` altered identity and disabled expected logging.
The sixth failure was a20-second native C fixture build refusal. Its precise
initial cause remains unestablished. No test assertion or production code was
changed to hide these results.

Removing those overrides and using the standard invocation environment produced
50/50 PASS across the four affected test files. Separate compiler controls
succeeded with both scratch-directory settings. A later standard full run ended
exit1 with truncated TAP and no final test summary; it is INCOMPLETE, not PASS,
and its termination cause is not asserted. The complete seven-command sequence
has not been qualified by either run.

The original worktree, both runs and the complete unpublished patch remain
preserved. A successor worktree starts from the new exact main above. Only the
task's prompt, tests, evidence and version qualification wiring are transferred;
no concurrent feature is overwritten. Earlier focused/installed successes apply
to their old candidate, not implicitly to the successor. Fresh complete
validation, publication, exact-SHA CI and independent review remain mandatory.

## Reconciled local validation before later amendments

All seven prescribed commands completed exit0 on the first published reconciled
candidate19fd834ac2d8abc55cf08ea7fd0fe469da05fb4b, before the CI/timing
verification amendments below:

- `pnpm run typecheck`:29.571s;
- `pnpm run typecheck:node`:15.138s;
- `pnpm run typecheck:node:stats`:3.740s;
- `pnpm run lint`:4.286s;
- `pnpm test`:7961.592s; source TAP786/786 PASS, no failures/cancellations/skips;
- `pnpm run test:node:build`:2821.403s;160 PASS, zero failures/cancellations,
  one conditional historical-release test skipped without its optional input;
- `pnpm run test:node:stats`:3.188s;1/1 PASS.

The optional historical-entrypoint test was then run with the actual preserved
0.10.1 and0.11.0 release directories:2/2 PASS, zero skips/failures, exit0,
6.459s. It exercises only isolated fixture runs and never rewrites those releases
or replays their real historical requests. The earlier six failures and truncated
run retain their own outcomes; they are not retroactively converted into PASS.

These are local source/build/isolated-installed results. Exact published SHA/CI,
independent review, applicable integration and actual host activation/readback
are still separate required gates; no caller publication is performed here.

## Exact-checkout CI qualification correction

Initial publication19fd834ac2d8abc55cf08ea7fd0fe469da05fb4b used the canonical
installed0.11.0 publisher successfully. Its twelve-file proposal did not change
production TypeScript. During the exact-SHA CI gate, the existing PR workflow
was found to use default checkout rather than explicitly selecting the PR head.
A run's `head_sha` alone does not attest the actual checkout. Official logs for
successful run42823551325 actually show synthetic merge commit
0274f2af476127deaab136b22fd40e3d0bcb3e65 under `refs/remotes/pull/33/merge`,
not19fd834. Its786-source/161-compiled result is preserved on that observed
checkout and is not counted as the required exact-head CI.

The verification setup now explicitly selects
`github.event.pull_request.head.sha || github.sha`. A static CI-surface regression
requires that binding under the checkout step. This is a
`no-normative-impact` verification/conformance correction under the mandate's
exact-SHA requirement; it selects no new product, retry, publication or release
semantics. Removing the binding must fail its negative control. Any historical
merge-ref CI result retains its own actual checkout scope and cannot be
relabeled exact-head evidence. The amended SHA requires new CI and independent
review, with actual runner checkout/readback, not only workflow inspection.

## Required timing-fixture remediation

The full revalidation after the CI amendment remained nonpassing:781 PASS,
1 FAIL and1 cancellation. I2's aggregate elapsed assertion observed60805.681ms;
the four-case prepared-merge regression file reached its600000ms file timeout.
These files and their production dependencies were unchanged by the generation
correction. Prior same-source passes do not erase the new failures. Host-load
observations do not establish their precise historical causes.

The test reporting helper actually invokes TWO sequential processes, each with
the caller's timeout. It previously returned only the second result when a
checkpoint name appeared, potentially masking the first process's error.
New real-process negative controls reproduce that masking for an explicit exit7
and a genuine watchdog timeout. The corrected helper preserves the first
failure and never sends a reporting acknowledgement after it.

I2 now measures the actual source-resume process and the separate no-effect
reporting process independently. BOTH retain the existing60000ms timeout and
elapsed assertion; all push-failure/no-retry/actual-commit assertions remain.
No production deadline or no-prompt guarantee is relaxed. The earlier aggregate
failure is not retrospectively diagnosed as a legitimate two-stage completion.

The four distinct prepared-merge hazards now each own a test module: historical
staging admission, explicit parent identity, source races during remote
observation and terminal merge state. Their complete existing test bodies are
byte-preserved after moving; no assertion, production mechanism or per-file
600000ms bound changes. The closed inventory and its independent membership
oracle include all four modules plus the new reporting-helper guards:109 files.
This is responsibility-based isolation, not omission or a relaxed test deadline.

Disposition: `no-normative-impact` in verification/conformance and repository
documentation. Required authority is this mandate's complete-validation gate,
not a new product decision. These are required repairs within Issue31, not
follow-ups allowing an incomplete task to be declared complete.

Focused results after these amendments:3/3 reporting-helper tests PASS,
7/7 I2/four-hazard tests PASS, zero skips/cancellations. The original helper is
RED against the new real-process guards, then restored exactly. The entire
required validation sequence, exact amended publication/CI and independent
review must still be completed before release qualification.

## Subsequent timeout-remediation mandate

[The dedicated remediation record](full-validation-timeout-remediation.md)
contains measured launch-path counterfactuals and the direct-child interruption
RED. It applies the already accepted legacy-Darwin Git selector to contributor
tests and reuses the maintained process boundary for qualification. The old
failures remain unchanged. New contributor modules are not new publication
mechanisms, and no caller patch is published by their delivery.

Private receipts preserve raw responses, commands, exits, source identities and
scope. Credentials, authorization headers and full planning prompts are not
published. This task performs no direct Review Broker modification or publication.
