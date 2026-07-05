# git-commits-push

This skill automates the creation of commits that comply with the **Conventional Commits** specification and pushes them to the remote repository. The entire workflow is orchestrated by the **Turnlock** state machine engine.

> [!NOTE]
> **Skill vs. Script**: It is important to note that the AI Agent using this skill does **not** generate the commits itself. The `SKILL.md` file simply instructs the Agent to execute a standalone, fully-featured TypeScript script (`turnlock-orchestrator.ts`). Once launched, the script takes over completely, doing all the heavy lifting (repository discovery, calling the LLM via its own bridge, and performing git operations).

## What happens when you run this skill?

When the `/git-commits-push` command (or `bun run start` from the skill folder) is executed, the orchestrator follows a precise lifecycle divided into several phases:

### Phase 1: Discovery
- The skill searches for local Git repositories containing uncommitted changes (staged or modified files).
- Repositories in a *detached HEAD* state (not on an active branch) are automatically ignored for safety reasons.

### Phase 2: Local Validation
- For each eligible repository, the skill extracts the *diff* and calculates a unique hash (`diffHash`). This prevents *race conditions* (e.g., if a developer modifies files while the AI is generating the commit message).
- If a local validation fails (such as the *Secret Scanner* blocking a commit containing API keys), the repository is marked as failed at this step.

### Phase 3: LLM Delegation (Commit Generation)
- The orchestrator prepares a *batch* of requests and temporarily suspends its execution.
- The local bridge (`turnlock-to-llm-bridge`) takes over: it contacts the configured Artificial Intelligence model (OpenAI, Anthropic, etc.).
- It sends the *diffs* along with the `system-prompt.md` rules file.
- The AI generates a structured JSON commit plan detailing the `type` (feat, fix, chore...), `description`, affected files, and potential *breaking changes*.

### Phase 4: Commit Validation and Execution
- Once the AI responses are received, the orchestrator resumes its execution.
- **Strict Validation**: It imports the global `commit-msg-validator` enforcer to ensure the AI's proposed message formally complies with the Conventional Commits standard.
- **Auto-Correction (Retry)**: If the AI made a mistake, the orchestrator dynamically creates a new correction job. It prompts the AI again, providing the exact error messages from the validator (*feedback*) so the AI can fix its proposal.
- **Commit & Push**: Once the message is validated, the code is committed via `git commit` and automatically pushed to the remote repository via `git push`. If there is no remote branch, the skill handles an upstream fallback push.

### Phase 5: Reporting
- A final report is displayed in the console indicating the status (Success or Failure) for each processed repository.
- All data (states, prompts sent to the LLM, results, and errors) is silently saved by Turnlock into the centralized `~/.turnlock/runs` directory.

## Configuration and Architecture
- **settings.json**: Contains the skill configuration (AI provider choice, model, paths).
- **turnlock-orchestrator.ts**: The core of the skill that defines the state machine.
- **turnlock-to-llm-bridge.ts**: The script responsible for resolving authentication and acting as the bridge between tasks delegated by Turnlock and the LLMs API.

