# git-commits-push

**One command. All your dirty repos. Tests, Conventional Commits, file-level splitting, push. Done.**

`git-commits-push` discovers every Git repository you touched, runs their tests,
scans for secrets, asks an LLM to write clean Conventional Commit messages, commits
file by file, and pushes — so you don't have to think about any of it.

---

## When to use this

| You are… | Use it when… |
|-----------|--------------|
| **An agent** (Pi, Claude Code, Codex, etc.) | Your user says "commit," "push," "publish changes," or asks about commit messages. Invoke the skill and let it run. |
| **A human** | You worked across several repos and want clean, per-file Conventional Commits without crafting 20 messages by hand. |

---

## How it works (step by step)

### 1. Discovery

The skill walks every directory under `searchPaths` (defaults to your home
folder) and identifies Git repositories that have uncommitted changes — staged,
unstaged, or both. Repos on a detached HEAD are skipped (there's no branch to
push to).

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

Once a repo passes validation, its full staged diff is sent to the configured
LLM along with a system prompt (from `system-prompt.md`). The LLM is asked to
produce a **commit plan**: one Conventional Commit message per file, with a
subject line (`feat:`, `fix:`, `chore:`, etc.) and an optional body.

Every message is validated on return:
- Does it follow the Conventional Commits format?
- Is the subject line under the recommended length?
- Does the plan map cleanly onto the files that were staged?

If any message fails validation, the LLM is retried with structured feedback
about what was wrong. If the primary model exhausts its validation budget, the
skill escalates to the fallback model (when configured).

### 4. Commit & push

**File-level splitting.** The LLM may propose multiple commits for a single
repo (one per logical change), or one commit covering several related files.
The skill respects the plan exactly — each commit in the plan gets its own
`git commit` with the proposed message and the specified set of files.

**Race detection.** Before each commit, the skill checks if the staged diff
still matches the original `diffHash`. If it changed (e.g., a background tool
staged something else), the repo is re-validated from scratch.

**Partial failure handling.** If one commit succeeds and the next one fails,
the already-created commits are preserved. The skill reports which commits
landed and which didn't, then retries the remainder.

**Push.** After all commits for a repo succeed, `git push` runs. If the push
fails with a network error, it's retried automatically. If it fails with a
non-network error (e.g., rejected by the remote), the error is reported and the
skill moves on to the next repo.

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

When the primary model repeatedly fails `validation` retries (invalid
Conventional Commit output), the skill can escalate to a fallback model — a
different provider or a more capable model — for one final attempt.

This is **not** a general-purpose retry strategy. The fallback only kicks in
when:

- Both `fallbackProvider` and `fallbackModel` are configured.
- The error is specifically a `validation` error (malformed commit messages).
- The primary model has already failed at least 2 validation attempts.
- The fallback hasn't been used yet for this repo (one escalation per repo).

It does **not** cover Git errors, network failures, race conditions, or
structural LLM issues. If the fallback also fails, the repo is reported as
failed and the skill moves on.

Example: you configure `provider: "openai"` with `model: "gpt-4o-mini"`
and `fallbackProvider: "anthropic"` with `fallbackModel: "claude-sonnet-4-20250514"`.
The cheap model handles 95% of repos; the expensive one catches the 5% where
the cheap model can't produce valid Conventional Commits.

---

## What you need

- **Bun** ≥ 1.1.0 installed.
- **An LLM provider** configured with valid credentials. The skill uses
  `@fanilosendrison/llm-runtime` under the hood and supports any provider it knows.
- **Git** and your usual package manager (bun, pnpm, yarn, npm, pytest) available
  on `PATH` so it can run tests inside target repos.

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

Settings live in `src/config/settings.json`.

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
| `searchPaths` | Directories to scan for repos (defaults to `HOME` if omitted) | `["~/Projects", "~/Work"]` |
| `thinking` | Enable thinking/reasoning tokens on providers that support it | `true` |
| `fallbackProvider` | Provider to escalate to when validation retries are exhausted | `"anthropic"` |
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

## Queueing — what if a run is already active?

If you start `git-commits-push` while another session is already running, your
request is automatically queued:

```
A git-commits-push session is already in progress.
Queue position: 1. This terminal will exit now;
the parent session will execute this order asynchronously.
```

You don't need to wait or retry. The active run will finish its work, then
automatically pick up your request and run it to completion. Your terminal is
free immediately.

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
| **Queue state** | `.state/orders/` inside the skill directory (or `ORDER_STATE_DIR` if set) |

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

## For contributors

The architecture, runtime contract, invariants, and test expectations are documented
in [AGENTS.md](AGENTS.md). The queue algorithm design is explained in
[docs/order-rationale.md](docs/order-rationale.md) with the technical specification
in [specs/order.md](specs/order.md).
