---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "verification-record"
name: "Full Validation Timeout Remediation"
version: "0.1.1"
domain: "git-commits-push"
severity: "guideline"
---

# Full validation timeout remediation

## Subject and preserved history

The recovery base is PR33 HEAD19fd834ac2d8abc55cf08ea7fd0fe469da05fb4b.
The exact recovered unpublished patch SHA256 is
aa04c86b5f3a5a219cef226bfbf4ed875664287232dc2fa814306a3a676cd07f.
The generation correction is not reopened. All earlier FAIL, cancellation,
truncated-TAP and independent BLOCKED/Q1 records retain their own exact scopes.

[The initial record](initial-plan-description-contract.md) distinguishes the
original response loss, instrumented generation correction and previous gates.
This record addresses qualification mechanisms, not new publication semantics.

## ENV-01 — missing maintained platform selection

### Statement and evidence

The host is Darwin17.7.0 with Node22.19.0. Direct contributor qualification used
ambient MacPorts Git2.55.0, while the public launcher already selected validated
Apple Git2.17.2 under the accepted legacy-Darwin policy. The private validation
controller bypassed that activation.

Native Git Trace2 and parent-process API timing were captured without recording
credential environment values or process output contents. Repeated launch
controls showed median direct launches of the same MacPorts binary at about330ms,
versus about9ms for Apple Git. MacPorts Git through a shell was about16ms. Changing
maxBuffer between1MiB and50MiB did not remove the effect. No reduced output limit,
shell trampoline or alternate production Git helper was adopted.

Actual unmodified fixture workloads, identical assertions and watchdogs:

- I2 ambient:43.772s,97 synchronous calls,35.233s inside synchronous calls;
  median343.138ms. Native Git work total1.979s, maximum0.729s.
- I2 official selection:7.682s, the same97 calls,1.153s synchronous-call total;
  median9.819ms.
- Index-hook ambient isolated:452.892s,1130 synchronous calls,429.486s total;
  median356.919ms. Native Git work total16.241s, maximum0.497s.
- Index-hook official selection:32.430s, the same1130 calls,14.833s total;
  median10.523ms.

All four observed runs ended0 with no unresolved descendants or process-table
observation errors. Apple Git2.17 does not provide Trace2; its parent API and
process-tree observations remain the supported evidence. An initial analysis
expecting a Trace2 file for that version failed and is preserved, not counted as
product failure.

The observed cost is launch-path overhead rather than measured native Git lock,
authentication, stdin or index-hook waiting. This establishes a current common
qualification mechanism, not the exact internal OS cause or instruction where
each old timeout fired. The original full-suite index-hook timeout remains a
cancellation; an isolated ambient PASS does not rewrite it. CPU-load observations
alone are not used as causal proof.

### Authority and disposition

Existing authority: AGENTS.md legacy-Darwin Git policy and the maintained
`activateGitExecutableForProcess` used by the public launcher.
Disposition: `no-normative-impact`; affected layers: integration-or-conformance,
verification-or-qualification-evidence and repository documentation.
No new Git version, trust, shell, retry or publication rule is selected.

### Correction and next action

Both normal source and compiled package test commands now use one narrow
contributor bootstrap around that maintained selector. Other platforms retain
PATH Git. Literal Node arguments, child failure and PATH restoration are tested.
Poisoning the ambient test Git and removing activation makes the control RED.
The complete source/compiled suites must prove the correction in suite context.

## I2-SECONDARY — failure-output consequence

The secondary I2 exception occurred because stdout/stderr assignment followed
the first watchdog assertion. A failed first assertion left later checks without
captured output. This is a fixture diagnostic consequence, not independent proof
of a second publisher defect. Original source output is now captured before the
watchdog assertion; assertions and both60-second process watchdogs remain.
Disposition: `no-normative-impact` in verification evidence. Prior error output
is preserved; later diagnostics do not retrospectively diagnose the old timeout.

## CONTROL-01 — direct-child cancellation leaves live descendants

### Statement and reproduction

The old Python controller called subprocess.run with a10800-second timeout.
On expiry it killed its direct pnpm child, recorded124, then stopped observing
still-active shell/Node descendants. The eventual inner TAP had its own result;
it could not establish successful completion of the original command.

A bounded real-process RED reproduces that ownership defect: terminating the
parent leaves a known grandchild alive under PID1. The diagnostic grandchild
then exits naturally and its absence is verified. No unknown numeric PID/group
is signalled to manufacture cleanup.

### Authority and disposition

Existing authority: fail-closed qualification, exact terminal returns and the
repository's maintained execution-boundary identity/IPC/termination primitives.
Disposition: `no-normative-impact` in implementation/conformance/evidence layers.
Qualification records never become durable publication authority or coordinator
requests. No production controller state machine or reconciler schema changes.

### Correction and controls

The source-only qualifier reuses `prepareSupervisorPass` and the unchanged actual
execution controller through a task-owned Node entrypoint projection. The worker
keeps literal argv, closes output to exact retained stdout/stderr files and records
the real command result. A live controller remains the group identity anchor.
Residual-process observation is fail-closed; a zero-exit command leaving a child
cannot qualify even when the controller subsequently cleans it up.

The host accepts a step only with successful command/worker returns, valid
receipt, no interruption, no residuals and confirmed process-group absence.
Missing/malformed receipt, observation failure or ambiguous cleanup is not PASS.
A failure stops the sequence; prior results and identity evidence remain retained,
with no automatic resume. The same three-hour watchdog covers qualification.
I2's60-second watchdogs and the600-second per-file bounds are unchanged.

Real-process controls demonstrate nominal success, residual-child refusal and
cancellation of an active tree, each with confirmed group absence. Removing the
worker's residual observation makes its negative control RED. Existing
registration, process identity, START, IPC disconnect and signal behavior are
reused rather than copied into a second controller.

## Complete qualification and release boundary

The qualifier owns an independently checked seven-command inventory. It refuses
missing explicit historical-release inputs rather than treating their optional
skip as full qualification. CI still requires literal-head checkout and actual
log confirmation; an identical-tree synthetic checkout is not relabeled.

The new source checks and focused I2/index-hook group pass with no skips. The
subsequent complete controlled qualification completed successfully, with actual
command exit0 and observed group absence for every step:

- typecheck28.474s; typecheck:node23.433s; typecheck:node:stats7.372s;
- lint6.252s;
- test919.982s, source796/796 PASS, zero failures/cancellations/skips;
- test:node:build1721.745s,163/163 PASS, zero failures/cancellations/skips;
- test:node:stats3.763s,1/1 PASS.

The historical fixture inputs were the actual retained immutable0.10.1 and0.11.0
release directories, not an optional skipped case. Evidence records base HEAD19fd834
with the uncommitted amendment; this is local working-source qualification, not
an assertion that19fd834 contained the new modules. Earlier nonpassing records
remain unchanged.

Canonical publication, new literal-SHA CI, fresh independent review, applicable
integration and immutable-release installation/activation/readback remain
separate gates. This record does not claim corrected-release availability
or authorize Review Broker changes, publication or historical rewriting.

## Fresh0562566 NO_GO and mechanical follow-up

The independently published05625666db5a335c3ca5f6f7bfdf26a274147fbc subject
received a fresh NO_GO, not an extension of the earlier19fd834 BLOCKED/Q1.
Official CI43117980491 passed on literal0562566 (796 source;162 compiled plus
one conditional history-input skip), but did not override these findings.

- F1: writing boundary identity after READY was outside cleanup protection.
  An actual EISDIR could leave the inert controller connected after rejection.
  All post-preparation evidence/error paths are now protected by owned termination
  and group-absence verification; an indeterminate cleanup retains its failure.
- F2: a string of PATH delimiters passed a nonempty-string check but parsed into
  an empty historical directory list. Admission now applies the fixture's actual
  delimiter/list semantics and rejects the empty parsed list before qualification.
- F3: cancellation while awaiting READY could still send START. The qualifier
  now checks cancellation after preparation and terminates the inert boundary
  without START, preserving the maintained production controller unchanged.

Disposition for each: `no-normative-impact` in implementation, conformance and
verification evidence. Existing ownership, cancellation and explicit historical
coverage requirements determine these corrections; no new product choice or
watchdog increase is introduced.

Real regression controls preserve EISDIR with natural driver exit and group
absence, reject separator-only lists and retain valid parsed inputs, and hold
READY while cancelling with a controlled termination delay. The latter requires
no START/supervisor/command marker. All3 corrected controls pass. The original
0562566 F1/F3 implementation is RED against those unchanged controls; removing
the parsed-list guard is separately RED. Source is restored byte-exactly after
negative runs. The closed source inventory now includes112 files.

The full corrected subject requires a new seven-command qualification, canonical
publication, literal-SHA CI and independent verdict. The complete0562566 report
and its reviewer setup/oracle failures remain preserved rather than relabeled.
