---
okf_version: "1.0"
kind: "KnowledgeAsset"
asset_type: "documentation"
name: "git-commits-push-readme"
version: "3.7.0"
status: "Active"
summary: "User guide for the standalone SQLite-reconciled, Turnlock-driven git-commits-push CLI."
domain: "git-commits-push"
severity: "guideline"
---

# git-commits-push

The runtime is maintained and installed from this dedicated repository.
Harnesses discover it through a separate `SKILL.md` manifest and invoke only the
stable user-local executable:

```bash
"$HOME/.local/bin/git-commits-push"
```

The production command does not depend on this checkout or invoke `pnpm`.

**One command. The current worktree. Tests, Conventional Commits, file-level splitting, push. Done.**

`git-commits-push` operates on exactly the Git worktree you invoke it from, runs its
tests, scans for secrets, asks an LLM to write clean Conventional Commit messages,
commits file by file, and pushes — so you don't have to think about any of it.

---

## Controlled runtime dependency

This source candidate consumes the compiled `llm-runtime` 0.1.5 tarball under
`vendor/llm-runtime/`, pinned to accepted upstream commit
`f2ab2f723775bbfe8a40a597be84769819eb1e0e`. Its provenance records source/tree,
SHA-256, SHA-512 and the complete package-file inventory; pnpm locks the exact
local `file:` artifact. No npm publication is implied.

The build verifies tar integrity. Standalone deployment verifies the installed
runtime bytes against that inventory, retains provenance in
`dist/dependency-provenance/llm-runtime.json`, and removes source-distribution
inputs from the immutable release. Runtime execution needs neither the upstream
checkout, original tarball nor pnpm. DeepSeek thinking control and whole-response
timeouts are inherited from this dependency, not a downstream patch.

This controlled route is limited to the accepted package; changed artifacts need
new comparison, qualification and review. Source version0.13.1 does not activate
an installed release or qualify a real provider. See [contributor directives](AGENTS.md).

## Installation

Before upgrading a host that may contain historical Turnlock runs, inspect and
retire every legacy global run:

```bash
pnpm run cutover:legacy-global-runs
pnpm run cutover:legacy-global-runs --apply --confirm-no-live-execution
```

The first command is read-only. The apply form is an offline operation: stop all
launchers and historical resume processes first. It moves only `global` or
missing-scope runs to a same-filesystem quarantine and leaves a durable regular
file at each canonical run path, so an absolute resume command from an old
release cannot reopen that run. Exact `worktree` and `targeted` runs are not
moved. The installer refuses activation until this cutover reports ready.

Then install or upgrade the production CLI:

```bash
pnpm run install:standalone
```

Installation builds the workspace and deploys a self-contained Node application
to
`$XDG_DATA_HOME/git-commits-push/releases/<version>-<sha256>/`, falling back to
`~/.local/share/git-commits-push/releases/<version>-<sha256>/`. It then
atomically switches the `current` symlink and preserves the stable public link
at `~/.local/bin/git-commits-push`.

Add `~/.local/bin` to `PATH` for interactive use, or invoke the absolute path as
the harness does. Releases are immutable and are not automatically deleted:
compatible non-global Turnlock runs can retain an absolute entrypoint from an
older release and resume after a later installation. Legacy global runs are the
intentional exception: cutover revokes their canonical run paths without
modifying the historical release trees. Re-running the installer with identical
content reuses the verified release.

Installation holds an exclusive SQLite transaction for its full lifecycle. A
matching live installer is refused immediately, not queued. Recovery from a
validated dead owner allows a five-second contention budget; after acquiring
SQLite, the request must still match the owner record it originally observed.
If another installer completed or changed that record, the superseded request
refuses rather than installing after it. A timeout never grants ownership. Do
not delete the lock database or owner record to bypass a refusal.

`pnpm` is an installation and contributor dependency only. The installed CLI
requires Node.js, Git, and the package managers needed to test discovered
repositories; it neither compiles nor consults the source checkout at runtime.

## When to use this

| You are… | Use it when… |
|-----------|--------------|
| **An agent** (Pi, Claude Code, Codex, etc.) | Your user says "commit," "push," "publish changes," or asks about commit messages. Invoke the skill and let it run. |
| **A human** | You finished work in one Git worktree and want clean, per-file Conventional Commits without crafting messages by hand. |

---

## How it works (step by step)

### 1. Discovery

By default, the skill processes exactly the Git worktree that contains your
invocation directory:

```bash
cd ~/Projects/api
"$HOME/.local/bin/git-commits-push"
```

- The invocation directory is resolved to its canonical Git top-level, so
  invoking from a nested subdirectory (`cd src/deep && git-commits-push`)
  resolves the repository root.
- Only that worktree is inspected, validated, staged, committed, and pushed.
- `searchPaths` is never scanned by an ordinary invocation.
- Sibling worktrees, linked worktrees, and unrelated repositories are never
  enumerated or touched.
- An ordinary invocation requires an attached symbolic branch. A detached HEAD
  fails closed with a diagnostic directing you to explicit targeted publication.
- A clean current worktree reports no work and stops. It never searches
  elsewhere.

#### Targeted mode

Ordinary invocation targets the current worktree. Explicit targeted invocation supports historical updates and separately authorized conditional creation (package 0.10.0 or later). Legacy global discovery remains persisted-state
compatibility only; no fresh command produces it.

ORDINARY MODE

```bash
git-commits-push
```

- uses only the exact Git worktree containing the invocation directory;
- resolves nested invocation directories to the canonical worktree root;
- requires an attached branch and fails closed on detached HEAD;
- retains normal tracked-branch publication semantics;
- ignores `searchPaths` and never expands to siblings or unrelated repositories;
- concurrent ordinary invocations from different worktrees serialize through
  reconciliation but never scope-coalesce.

TARGETED MODE

```bash
git-commits-push \
  --repository <absolute-exact-worktree-root> \
  --push-remote <configured-remote-name> \
  --push-ref refs/heads/<branch>
```

- the three flags form one atomic argument group;
- targets exactly one canonical worktree;
- does not scan `searchPaths`;
- does not scan sibling worktrees;
- does not expand through the Git common directory;
- explicitly supports detached HEAD;
- supports dirty detached commit-and-publish;
- supports clean detached push-only publication;
- requires an explicit configured remote and fully qualified `refs/heads/*`
  destination;
- does not create a temporary publication branch;
- does not create or modify an upstream;
- does not persist `push.default`;
- does not persist `branch.*.remote`;
- does not persist `branch.*.merge`;
- freezes the remote destination baseline before commit/publication effects;
- uses exact-SHA publication with lease protection;
- verifies the remote destination after publication;
- fails closed if the destination becomes stale/diverged;
- does not merge, rebase, or resolve conflicts;
- leaves convergence/correction to the caller;
- incompatible exact requests serialize rather than scope-coalescing;
- the reconciler persists owner invocation mode but never target
  repository/remote/ref payload;
- `SINGLE_LIVE_GIT_EXECUTION` remains global.

#### Conditional creation of a task branch

The historical three-flag targeted mode requires a destination branch that already exists. Conditional creation instead requires all six options:

```bash
"$HOME/.local/bin/git-commits-push" --repository "/absolute/exact/task-worktree" --push-remote "origin" --push-ref "refs/heads/feat/example" --create-if-absent --base-ref "refs/heads/main" --base-sha "<full-authorized-base-OID>"
```

The caller supplies exact authorized literal values. The source ref and destination must differ. The base commit must already be available locally and be an ancestor of both the observed source tip on the **push** endpoint and the initial worktree HEAD; the publisher never fetches, including implicit promisor retrieval during local history qualification. Missing local proof or patch-input objects are prerequisite failures, not authorization to download history. Creation checks read actual parentage despite shallow boundaries or legacy grafts; these graph masks cannot hide outgoing commits. Repository metadata and the caller's environment are not rewritten. Source progression after admission does not lock publication to the latest source tip.

A fresh creation request refuses an existing destination, even at the requested SHA. Dirty detached worktrees commit directly on detached HEAD; clean ahead worktrees publish without planning or new commits. A clean worktree exactly at the authorized base can also create its destination, without an artificial commit. Tests and secret scanning cover the entire outgoing history from the authorized base, not just a dirty diff. Creation qualifies its own HEAD/index objects before staging and uses actual, unconverted diff input for scanning and staged-diff hashes; ambient textconv, binary, color or rename settings cannot replace that input. The existing secret-pattern and false-positive policy still applies. Pre-commit retries reuse only the same validated raw input; changed work is refused before further inference rather than silently replanned. Existing inference and retry budgets are unchanged.

Publication uses the final validated SHA directly under an explicit absence lease, with tag following and submodule push recursion disabled. A collision at a different SHA fails without replacement, merge or rebase. Success means the exact destination was observed at that SHA, not that this invocation exclusively created it. No local branch, upstream, tracking projection or persistent Git configuration is changed.

Creation-mode diff hardening does not silently change historical scan inputs. The independently validated legacy textconv weakness is tracked in [Issue #20](https://github.com/fanilosendrison/git-commits-push/issues/20); this feature must not be presented as a repair of that default-path defect.

To update a branch after publication, use historical targeted mode without creation flags. Resume uses only persisted authority and must not be mixed with targeted CLI options. An interrupted dirty creation whose final validated identity cannot be proven stops with commits preserved rather than replanning; confirmed successful creation is not authority to recreate a later-deleted branch. See [the creation contract](specs/targeted-destination-creation.md) for uncertainty, compatibility and retry boundaries.

#### Caller-prepared two-parent merge

Package 0.11.0 adds a separate explicit operation for an already prepared, fully
resolved merge. The caller chooses histories, prepares the merge and resolves
conflicts; GCP never runs merge, rebase or conflict resolution.

```bash
"$HOME/.local/bin/git-commits-push" --repository "/absolute/exact/worktree" --push-remote "origin" --push-ref "refs/heads/destination" --publish-prepared-merge --first-parent "<full-D-OID>" --second-parent "<full-C-OID>" --index-tree "<full-resolved-tree-OID>" --merge-message "feat: integrate caller-approved histories"
```

All eight options are mandatory together. The destination must already exist.
The exact Conventional Commit subject is supplied by the caller, not an LLM.
GCP binds HEAD=D, the sole MERGE_HEAD=C and resolved index=T, runs validation
without staging/resetting that index, and creates one commit with ordered parents
[D,C] and tree T. Repository hooks and both commit/push signing are disabled process-locally in this
mode, including private-index proofs, so their programs cannot transform the
frozen message, input or comparison authority. No persistent Git
configuration changes. Historical modes refuse MERGE_HEAD without this authority.

Turnlock persists source authority and frozen author/committer identities before
requesting the commit, then persists the exact resulting SHA before requesting
publication. These effects execute through Turnlock's existing External Request
protocol, not inside a freely executing resumable phase. Git commit-tree receives
explicit ordered parents and T; expected-old ref installation preserves exact M.
Recovery recognizes that deterministic object/current direct child and never
replans a landed commit.
Ambiguous publication observes the exact target before bounded retries. A later
source refusal retains proven landed commits and exact remote evidence, but
reports failure rather than hiding effects or claiming complete success. Success
leaves HEAD at that merge, index/tree T and no active MERGE_HEAD. Resume supplies
only persisted authority, not fresh merge flags. See the
[bounded merge contract](specs/caller-prepared-merge-publication.md).

### 2. Validation

For each dirty repository, in parallel where safe:

**Test cascade.** Unless `skipTests` is `true`, the skill runs your test suite.
It tries, in order:

1. A `test_runner` command defined in `STACK_EVAL.yaml` (if present).
2. The `test` script from `package.json`.
3. Auto-discovered Bun tests (`bun test`).
4. Auto-discovered pytest tests.
5. Silent success — if no test runner is found at all, the repo passes.

If any test step fails, the repo is skipped and the failure is reported. The
other repos continue unaffected.

**Staging.** After tests pass, the skill runs `git add -A` to stage everything:
new files, modifications, and deletions. A `diffHash` is computed from the staged
diff to detect race conditions later (if someone stages more changes while the
LLM is thinking).

**Secret scan.** The staged diff is scanned for secrets: API keys, tokens,
passwords, private keys, connection strings with embedded credentials, and
similar sensitive patterns. The scanner is fail-closed — if it looks like a
production secret, the commit is blocked. But it tolerates obvious non-production
contexts:

| Context | Behavior |
|---------|----------|
| Files under `test/`, `tests/`, `__tests__/`, `specs/`, `fixtures/` | Non-blocking `warning` — the commit proceeds |
| `.env.example`, `.env.template`, `.env.sample` | Skipped entirely |
| Values containing `mock`, `dummy`, `test`, `example`, or `fake` on the same line | Skipped |
| Line annotated with `git-commits-push: allow-secret` | Skipped |
| Everything else | **Blocked** — the commit stops, the event is logged, and the error is reported |

### 3. Planning

**Two execution policies:** qualified counting optionally proves capacity for a
specific request/model/protocol. Runtime-supported models without a qualified
profile instead use portable bounded attempts, without a capacity guarantee.
The production profile registry remains empty; no synthetic profile is enabled
through settings or environment variables.

Portable policy bounds the complete logical JSON request to 64 KiB and its actual
wire body to 128 KiB, with an explicit output quota of 4096 tokens. These are local
resource limits, not estimates of model capacity. System instructions, feedback,
metadata and options remain included. Requests split deterministically on complete
Git paths, never by truncation. Recognized structured context errors permit bounded
subdivision; arbitrary error text does not. Indivisible or exhausted work refuses.
All units must produce a complete validated aggregate before the first commit;
partial planning never authorizes publication.

Exact coverage is not proof of semantic coherence. Reduced cross-unit context
can change the model's proposed commit groups; existing validators still apply.
Mandatory caller grouping/cardinality/message constraints not representable in the
current contract are not supported by this feature (#23). A caller that knows such
a constraint must not engage publication while claiming it will be enforced.
Operational qualification, independent review and release activation remain
separate gates. See
[the context contract](specs/model-context-planning.md) and
[Issue #34](https://github.com/fanilosendrison/git-commits-push/issues/34).

Once a repo passes validation, its full staged diff is sent to the configured
LLM along with a system prompt (from `system-prompt.md`). The LLM is asked to
produce a **commit plan**: one Conventional Commit message per file, with a
subject line (`feat:`, `fix:`, `chore:`, etc.) and an optional body.

The generation contract explicitly requires `commit.type` and
`commit.description` in every plan, plus its exact `files` list. Optional body
text never substitutes for the subject description. The runtime refuses missing
fields rather than inventing them, including after an invalid first response.
This improves generation instructions, not a guarantee that a model always obeys.

Commit-plan responses preserve literal `<think>` and `<thinking>` text inside
JSON strings: thinking-tag stripping is disabled, while the existing JSON-fence
policy remains. External thinking wrappers that are not admissible JSON fail
closed within the existing repeat budget. Rejection diagnostics contain bounded
structural codes and paths, never rejected content or response hashes. The
invoker disables unfiltered runtime logging and reports typed runtime failures
without their provider-body/error text, retaining the existing failure kinds.
This corrects a reproducible postprocessing mechanism; the missing raw responses from
Issue #37 do not establish its historical cause. It does not qualify a production
provider profile or authorize release activation.

The separately diagnosed CL-01 controller lifetime defect is corrected by keeping
shutdown polling and escalation timers referenced after IPC loss. The existing
20 ms polling and 5-second SIGKILL grace, signal order, group-absence checks,
fencing and durable recovery rules are unchanged. Real-controller tests cover
owner death, resistant descendants, actual zombies and unknown observations;
this source correction grants no release activation or consumer-resume authority.

The distinct F2 observation correction rejects empty, malformed or incoherent
successful process-table output as unknown, including missing controller or
inspection identities. It validates full numeric fields and unique PID rows
before excluding the identified inspection child. Valid descendants still block
quiescence; a coherent table does not claim absolute system completeness. No
shutdown timing, signal, fencing, admission or durable format is changed.

Every message is validated on return:
- Does it follow the Conventional Commits format?
- Is the subject line under the recommended length?
- Does the plan map cleanly onto the files that were staged?

If any message fails validation, the LLM is retried with structured feedback
about what was wrong. LLM repair remains primary. If a repair response still
exceeds its exact subject budget, the runtime may mechanically shorten only the
description at an existing ASCII-space whole-word boundary, then runs the normal
full validator again. If the primary model exhausts its validation budget, the
skill escalates to the fallback model (when configured).

### 4. Commit & push

**File-level splitting.** The LLM may propose multiple commits for a single
repo (one per logical change), or one commit covering several related files.
The skill respects the plan exactly — each commit in the plan gets its own
`git commit` with the proposed message and the specified set of files.

**Exact validated source.** Before inference, Turnlock retains the original
HEAD (or unborn absence), index tree T, exact changed paths and worktree identity.
Validation reads its diff from pinned H0/T objects and rejects changed source
before issuing the durable witness. Admission and retries use the same immutable
diff representation, including under Git mnemonic-prefix settings, rather than
mixing cached and tree-to-tree hashes. Discovery is not rerun on resume to recapture
residual input. The publisher checks complete, non-duplicated plan coverage before
resetting or staging. An omitted file is a structural failure, not permission to publish less.
Retries retain T; changed HEAD, index or working input fails closed rather than
silently adopting a new source.

After all commits, HEAD's tree must equal T before publication. Success also
requires the exact verified remote SHA when publication was requested. With
ordinary `autoPush=false`, complete local commits do not imply a remote push.
This proves completeness against the publisher's own validated source, not an
external review identity that was never supplied to it.

**Partial failure handling.** If one commit succeeds and the next one fails,
the already-created commits are preserved. The skill reports which commits
landed and which did not. An exact publisher-owned index transition is retained
for a failure before the first commit; it permits the bounded retry without
replacing validated T. Different external index states still fail closed. Only a
proven durable commit chain can authorize a remaining-file retry; uncheckpointed
history stops without rewriting commits.
Empty LLM output and nonzero commit counts never establish success. An already
complete durable chain can recover only through independent Git proof and its
required publication evidence; it never authorizes inference against an empty
diff or another publication. Terminal
commit/publication evidence is checkpointed through Turnlock before reporting.
Historical states without the source witness remain readable, but cannot grant
new commit effects or a new complete-success claim.

**Initial commits.** A dirty repository with a proven unborn branch is supported.
The CLI records the absence of a prior commit, builds the initial commit from the
exact plan, and can publish it to an empty remote branch.

**Push.** After all commits for a repo succeed, `git push` runs against the
single effective push URL. Preflight, exact-SHA publication, and postflight
verification all use that same endpoint. Credentials are never persisted or
placed in process arguments, and push diagnostics are sanitized before they are
reported. If the push fails with a network error, it's retried automatically. If
it fails with a non-network error (for example, a remote rejection), the error is
reported and the skill moves on to the next repo.

After exact publication is verified, the CLI synchronizes the applicable local
remote-tracking ref when the tracked branch, destination ref, and effective
fetch and push endpoints all match. The update uses the previously observed ref
value as an atomic guard, so a concurrent fetch or other local update is never
overwritten. Triangular workflows and split fetch/push endpoints remain
independent. The report records remote publication separately from this local
projection; a skipped, concurrent, or failed local synchronization does not turn
a verified remote publication into a push failure.

### Retry model

Retries are per repository and per error category. Five categories exist, each
with its own budget:

| Category | When it triggers | Scope |
|----------|-----------------|-------|
| `validation` | LLM produced invalid Conventional Commit output | Per-repo |
| `structural` | LLM plan was malformed or unusable | Per-repo |
| `race` | Staged diff changed after validation | Per-repo |
| `git` | Unexpected Git error outside push/race handling | Per-repo |
| `network` | Push failed with a transient network error | Per-repo |

If the LLM keeps proposing the exact same invalid plan repeatedly, loop
detection stops the retries to avoid burning tokens indefinitely.

### Fallback model

Google `gemini-3.5-flash-lite` remains the default primary model. The configured
fallback is Mistral `mistral-large-latest`. After the shared runtime exhausts its
provider retry budget, typed rate-limit, overload, transient-provider, timeout,
protocol or response-parse failures permit one fallback delegation. HTTP 429 and
503 therefore do not require changing the primary provider.

Malformed Conventional Commit messages retain their existing two primary repair
attempts followed by at most one configured fallback attempt. Both paths share
the durable `fallbackAttempted` budget. A provider outage during message-only
repair preserves the exact rejected plans and file ownership; it never enables
full replanning. Empty pending diffs cannot authorize provider failover.

This is **not** a general-purpose retry strategy. The fallback only kicks in
when:

- Both `fallbackProvider` and `fallbackModel` are configured.
- The error is a typed eligible provider outage, or malformed commit messages
  have exhausted the two primary validation repairs.
- Provider-outage classification uses the runtime error kind, not diagnostic text.
- The fallback hasn't been used yet for this repo (one escalation per repo).

It does **not** cover Git errors, race conditions, authentication failures,
invalid requests, cancellation, arbitrary error strings or structural plan
changes. If the fallback also fails, the repo is reported as failed. Legacy
string-only result files retain their former behavior; no error is reclassified
merely because its message contains an HTTP status.

Example: you configure `provider: "openai"` with `model: "gpt-4o-mini"`
and `fallbackProvider: "anthropic"` with `fallbackModel: "claude-sonnet-4-20250514"`.
The cheap model handles 95% of repos; the expensive one catches the 5% where
the cheap model can't produce valid Conventional Commits.

---

## What you need

- **Node.js** ≥ 22.19.0 and **Git** ≥ 2.17 for the installed CLI.
- **pnpm** 11.24.0 only when building, installing, or contributing from source.
- **An LLM provider** configured with valid credentials. The CLI uses
  `@fanilosendrison/llm-runtime` under the hood and supports any provider it knows.
- **Git** 2.17 or later and each package manager required by your target
  repositories (`bun`, `pnpm`, `yarn`, `npm`, or `pytest`) available on `PATH`
  so their tests can run.
- **Linux or macOS** for automated Git execution. Windows and untested POSIX
  platforms fail closed until an equivalent tested whole-tree containment
  boundary is available.

On macOS High Sierra (Darwin 17), the installed CLI resolves and validates the
Apple toolchain Git through `xcrun` before any repository operation. This avoids
a known TLS linker collision in third-party Git/libcurl builds on that platform.
Other operating systems and newer macOS releases continue to use Git from
`PATH`.

---

## API keys

The skill needs an API key for each LLM provider it uses (the primary `provider`
and the optional `fallbackProvider`). It resolves keys in this order:

1. **Environment variable** — set `<PROVIDER>_API_KEY` in your shell or
   agent environment. For example: `export OPENAI_API_KEY=sk-...`
2. **Credentials file** — `~/.agents/agent-credentials.json` stores a shell
   command per provider (typically a `doppler secrets get ...` call). The
   command's stdout is used as the key.

Example `~/.agents/agent-credentials.json`:

```json
{
  "openai": {
    "type": "api_key",
    "key": "doppler secrets get OPENAI_API_KEY_MYAGENT -p myagent -c dev --plain"
  },
  "anthropic": {
    "type": "api_key",
    "key": "doppler secrets get ANTHROPIC_API_KEY_MYAGENT -p myagent -c dev --plain"
  }
}
```

> `agent-credentials.json` is not versioned (it's gitignored). Use
> `~/.agents/agent-credentials.json.template` as a starting point.

---

## Configuration

The source settings live in `src/config/settings.json` and are copied into each
immutable release during installation. Change that source file and reinstall to
activate a new default configuration. Tests and controlled integrations can set
`TURNLOCK_SKILL_SETTINGS_PATH` to an absolute external settings file.

### Required

| Key | What it does | Example |
|-----|-------------|---------|
| `provider` | LLM provider to use for commit planning | `"openai"` |
| `model` | Model name | `"gpt-4o"` |
| `temperature` | LLM temperature (0 = deterministic) | `0` |
| `systemPromptPath` | Path to the system prompt injected into LLM jobs | `"system-prompt.md"` |
| `autoPush` | Whether to `git push` after committing | `true` |
| `skipTests` | Skip the test cascade entirely | `false` |

### Optional

| Key | What it does | Example |
|-----|-------------|---------|
| `searchPaths` | Legacy/global-discovery compatibility state only. Normal worktree invocation and explicit targeted invocation do not use it. An omitted or empty value retains the historical `~/Developper/Projects` fallback for persisted legacy reconciliation. | `["~/Projects", "~/Work"]` |
| `thinking` | Enable thinking/reasoning tokens on providers that support it | `true` |
| `fallbackProvider` | Provider for bounded validation or typed provider-outage escalation | `"anthropic"` |
| `fallbackModel` | Model for the fallback provider | `"claude-sonnet-4-20250514"` |

> `fallbackProvider` and `fallbackModel` must be paired — configure both or neither.
> See the [Fallback model](#fallback-model) section for the full behavior.

---

## What you see on screen

```
Found 3 dirty repos:
  ~/Projects/api          2 files staged
  ~/Projects/frontend     5 files staged
  ~/Projects/cli          1 file staged

[api] Running tests…          ✓ 12 passed
[frontend] Running tests…     ✓ 47 passed
[cli] Running tests…          ✓ 3 passed

[api] Scanning secrets…       ✓ clean
[frontend] Scanning secrets…  ⚠ warning (test fixture)
[cli] Scanning secrets…       ✓ clean

[api] LLM planning…           ✓ 2 commits planned
[frontend] LLM planning…      ✓ 5 commits planned
[cli] LLM planning…           ✓ 1 commit planned

[api] Committing…   ✓ feat: add rate limiter
[api] Committing…   ✓ fix: handle nil session
[api] Pushing…      ✓ pushed to origin/main

… (summary per repo)
```

---

## Reconciliation — what if a run is already active?

Every invocation first increments a durable generation in `reconciler.sqlite`
before any Git work. An ordinary invocation and an explicit targeted invocation
are exact, non-coalescing caller-owned requests. While another exact request owns
the execution boundary, a new invocation waits process-locally without durable
mutation and then executes its own scope. An ordinary invocation from worktree A
and an ordinary invocation from worktree B serialize; they never merge into one
owner's scope, and A never processes B.

Legacy persisted global generations remain reconciliation debt. Old global state
can be retired safely, but it cannot cause the current command to scan other
worktrees or start any global work: recovery only fences any preserved execution
boundary and retires the debt without replay. No fresh command creates
rediscoverable global work or scans `searchPaths`.

There is no per-request order queue. The durable contract is that exact requests
serialize under one live Git execution boundary. SQLite distinguishes the
launcher that owns reconciliation scheduling from the concrete execution tree
that can mutate Git.

Each pass has a separate execution token, controller PID, process-start identity,
and POSIX process-group identity. The controller starts inert, reports `READY`
over IPC, and cannot launch Turnlock until its identity is durably registered and
`START_AUTHORIZED` is committed. All pipeline stages inherit that one process
group.

If a launcher dies, the next elected owner terminates and proves the old
execution boundary dead, token-clears it, and only then admits its own request.
An abandoned exact worktree scope is never replayed by another caller. Launcher
death, supervisor exit, and stale heartbeat age are never treated as proof that
Git execution has ended.

---

## When things go wrong

| You see… | What it means | What to do |
|-----------|--------------|------------|
| **"Secret blocked"** | A production-looking API key, token, or password was found in your diff. | Remove the secret from the file, or add `git-commits-push: allow-secret` on the same line if it's a false positive. |
| **"Secret warning"** | A potential secret was found in a test file, fixture, or `.env.example`. | This is non-blocking. The commit proceeds. Review the warning if you want, but you don't have to act. |
| **Tests failing** | One of your repos has broken tests. | Fix the tests, then run the skill again. Or set `skipTests: true` if you're in a hurry (not recommended). |
| **LLM returned invalid commits** | The model produced malformed Conventional Commit messages. | The skill retries automatically. If retries are exhausted, it escalates to the fallback model (if configured). The report will tell you what happened. |
| **Push failed (network)** | `git push` could not reach the remote. | The skill retries automatically. If retries keep failing, check your connection and push manually. |

---

## Where results are stored

| What | Where |
|------|-------|
| **Commit/push events** | `~/neelopedia/stats/<agent>/git-commits-push/events.jsonl` |
| **Secret scan events** | `~/neelopedia/stats/<agent>/secret-scanner/events.jsonl` |
| **Reconciler state** | `$XDG_STATE_HOME/git-commits-push/orders/reconciler.sqlite`, falling back to `~/.local/state/git-commits-push/orders/reconciler.sqlite` |

The JSONL files contain structured records of every action: which repos were
processed, what messages were committed, whether push succeeded, and any errors
or retries. Useful for debugging and audit trails.

---

## FAQ

**Can I skip tests?**
Yes. Set `skipTests: true` in `settings.json`. Not recommended for production repos.

**Can I disable auto-push?**
Yes. Set `autoPush: false`. Commits stay local; you push manually later.

**What test runners does it use?**
It tries, in order: a `STACK_EVAL.yaml` `test_runner` command, `package.json` `test`
script, auto-discovered Bun tests, auto-discovered pytest tests. If none are found,
the repo passes validation silently.

**What if a test file or fixture contains a real-looking secret?**
The secret scanner automatically tolerates files under `test/`, `tests/`,
`__tests__/`, `specs/`, and `fixtures/` directories, as well as `.env.example`,
`.env.template`, and `.env.sample` files. Values containing `mock`, `dummy`, `test`,
`example`, or `fake` are also skipped. Anything else blocks the commit.

**Can I mark a line as safe for the secret scanner?**
Yes. Add `git-commits-push: allow-secret` as a comment on the same line.

**How does retry work?**
Per repository, per error kind. The five retry kinds are: `validation` (bad LLM
output), `structural` (malformed plan), `race` (diff changed mid-run), `git`
(unexpected Git error), and `network` (push failure). Each has its own retry budget.

**What's the fallback model?**
A second LLM that takes over when the primary model can't produce valid
Conventional Commits after multiple attempts. See [Fallback model](#fallback-model)
for the exact trigger conditions.

---

## Architecture

The CLI is integrated against an immutable Turnlock 0.11.0 source revision
while that version awaits publication. New requests use delegation manifest v3
with the logical target `worker("git-commit-generator")`. The stable public link
resolves through the atomically selected immutable application release. The
compiled Node launcher registers a SQLite reconciliation generation before one
owner starts the shell-free execution boundary:

```text
~/.local/bin/git-commits-push
  → current/bin/git-commits-push.mjs
  → compiled public launcher
  → SQLite reconciler owner
  → paused execution controller [durably registered SID/PGID leader]
  → node-supervisor [inherits execution group]
  → orchestrator + LLM bridge [inherit execution group]
```

The installed launcher never builds at runtime. The source-only
`scripts/start-node.mjs` entrypoint builds once for development and then invokes
the same compiled public launcher. The launcher owns admission, lifecycle-wide
signal cancellation, exact-request serialization, recovery, and the pass loop.
The execution controller owns parent-disconnect response and the externally
fenceable process boundary. The orchestrator owns one pass's finite-state
machine and persists Turnlock snapshots.
The bridge writes v3 requests and authorizes only
`worker("git-commit-generator")` before resolving that capability to direct LLM
inference. During the bounded transition it can also read v2 manifests whose
historical `worker` is exactly `git-commit-generator`, and v3 retry manifests
whose only compatibility marker is `legacy-v2`. Other targets and markers fail
closed before any job is read. The bridge then validates mode-specific
responses, writes results, and resumes the orchestrator. The supervisor owns producer/consumer piping, direct-stage shutdown,
backpressure, and protocol-safe stdout routing. Full-boundary termination and
proof remain controller/launcher responsibilities.

### Reconciler schema migrations

Schema v4 adds `owner_invocation_mode` so the coordinator can distinguish a
global owner from a targeted one. An idle, fully converged schema-v3 singleton
is upgraded in place automatically by any writable open; non-idle v3 state
fails closed and is preserved because v3 cannot say whether the missing work
was global or targeted.

Schema v2 cannot prove that an old pipeline is absent, so production does not
silently reinterpret it. After stopping all launchers and proving that no
supervisor or descendant remains alive, migrate an idle, fully converged v2
singleton explicitly:

```bash
pnpm run migrate:reconciler-v2 --confirm-no-live-execution
```

The explicit path stages schema v3 and then completes the bounded v4 upgrade
through the normal writable open. Active, pending, malformed, uncheckpointed, or
unconfirmed v2 state fails closed.

### Compatibility with older Turnlock runs

A historical release remains immutable, but immutability does not preserve
retired global application authority. `pnpm run cutover:legacy-global-runs`
reads SQLite-backed runs from their digest-verified authoritative state and uses
`state.json` only for pre-SQLite runs. The confirmed apply operation checkpoints
abandoned WAL state, refuses active locks or held ownership, atomically renames
each global or missing-scope run into quarantine, and occupies the original run
path with a tombstone. A crash after rename leaves the canonical path absent and
therefore non-resumable; rerunning the command completes the tombstone.
Operator closure evidence alone is not an execution fence.

Turnlock 0.11.0 migrates supported state schema v2/v3 runs into schema v4.
A pending manifest-v2 delegation is re-emittable only when its historical
worker is present; this consumer further authorizes only
`git-commit-generator`. The bridge retains bounded v2 read compatibility so
existing authorized work can complete while all new output is v3. Ambiguous v2
manifests, legacy `agent-batch` manifests, host targets, and other workers fail
closed before physical execution.

The immutable Git revision in `package.json` must be replaced by the published
npm `turnlock@0.11.0` only after the same Turnlock commit is release-CI green.
Historical installed git-commits-push releases remain immutable for compatible
non-global runs whose resume command points to them. A pre-cutover absolute
resume command for a revoked global run resolves to a non-directory tombstone
and cannot load Turnlock state.

## For contributors

### Qualification environment and process ownership

Source and compiled test commands use the same maintained platform Git selector
as the public launcher. On legacy Darwin this selects the validated Apple
toolchain Git; other platforms keep their normal PATH selection. No global Git
configuration or persistent PATH is changed. This prevents contributor tests
from bypassing the platform prerequisite already enforced by production.

The source-only `pnpm run qualify` command executes the seven prescribed commands
sequentially with captured stdout/stderr, exact child exit results and observed
process-group absence. It reuses the maintained execution controller and its
identity/IPC/termination checks; it does not run the publisher or initialize its
coordinator. A zero-exit command leaving a live descendant, unknown observation,
interruption or missing receipt cannot qualify. Its three-hour watchdog does not
increase I2's60-second or the runner's600-second limits.

Full qualification requires `GCP_QUALIFY_LEGACY_RELEASES` with explicit immutable
historical release directories (separated with the platform PATH delimiter).
Without that input the command refuses rather than counting a conditional skip
as qualification. Evidence is retained under a fresh ignored `.state/qualification-*`
directory. A failed sequence is not resumed automatically.

[The timeout-remediation record](docs/validation/full-validation-timeout-remediation.md)
separates measured causes, historical limits and negative controls. None of these
source checks grants integration, activation or caller publication.

The architecture, runtime contract, invariants, and test expectations are
documented in [AGENTS.md](AGENTS.md). Installer concurrency tests additionally
require `cc` and the platform SDK's SQLite development headers. Their test-only
VFS extension schedules real lock transitions without replacing Node's SQLite
engine; the installed CLI does not require these build tools. The normative concurrency contract is
[specs/reconciliation.md](specs/reconciliation.md), the queue-to-SQLite change is
recorded in
[docs/reconciliation-migration.md](docs/reconciliation-migration.md), and the
read-only state gate is documented in
[docs/node-cutover-preflight.md](docs/node-cutover-preflight.md).
