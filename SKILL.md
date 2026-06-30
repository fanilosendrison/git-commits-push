---
name: git-commits-push
description: Enforce Conventional Commits convention for writing commit messages, then auto-push. Use when the user says "commit", "commit ça", wants to commit changes, asks how to write a commit, wants their message reviewed, needs to understand commit types, or asks about breaking changes.
---

# Git Commits & Push Workflow

## When to Use This

The user wants to commit. Signals, simples ou explicites :
- "commit ça", "commit", "commit les changements"
- "comment j'écris ce commit"
- "c'est quoi le bon type de commit pour ça"
- "revois mon message de commit"
- "conventional commits"
- "breaking change"

## Workflow (Execution Steps)

Execute these steps in order:

1. **Analyze & Resolve**:
   - *Symlink Rule*: If the modified files are inside `~/.agents/`, `~/.claude/skills/`, or `~/.pi/agent/`, you MUST `cd` into their resolved target repository (respectively `dotagents`, `dotclaude`, `dotpi`) before running any git commands. Use `readlink` to find the true path.
   - Scan the working directory for uncommitted changes (`git status`). If changes exist, read the diff.
   - *Rule*: Never generate a commit message without understanding the change. Ask if unclear.
   - *Rule*: Split multi-concern commits into separate commits.
2. **Validate**:
   - *Rule*: Never commit code that doesn't pass tests — run tests before committing. If a test fails, fix it first. No exceptions.
   - *Rule*: Never commit secrets, API keys, tokens, or passwords. Review the staged diff carefully.
3. **Draft**: Craft the appropriate commit message(s) following the **Format & Conventions** below.
   - *Rule*: Choose the right type based on the changes.
   - *Rule*: Rewrite vague messages into specific ones.
   - *Rule*: Always verify the commit message against every rule before committing.
4. **Commit**: Stage and commit the changes without waiting for the user to ask.
5. **Push**: After every successful commit, push immediately to the current branch's remote.
   - No upstream → `git push -u origin <branch>`
   - Has upstream → `git push`
   - *Exception*: Do not push if the user explicitly says "ne push pas" or "commit only".
   - *Error Handling*: If push fails, report the error. Do not retry in a loop.

## Format & Conventions

You enforce Conventional Commits 1.0.0 for every commit you produce.

### Structure
```
<type>(<scope>): <description>

[body]

[footer]
```

Three parts: **subject line** (required), **body** (optional), **footer** (optional).

### Subject Line Rules
1. **Always in English** — commits, body, and footer
2. **Type** — required, from the list below
3. **Scope** — optional, in parentheses, names the module/component/service affected
4. **Description** — required, after `: `
5. **Imperative present tense** : `add`, `fix`, `remove` — never `added`, `fixes`, `removing`
6. **No capital letter** after the colon
7. **No period** at the end
8. **72 characters max** for the entire subject line

### Allowed Types

| Type | When to use it | Example trigger |
|------|---------------|-----------------|
| `feat` | New feature | "J'ai ajouté un nouveau endpoint" |
| `fix` | Bug fix | "J'ai fixé un crash" |
| `docs` | Documentation only | "J'ai mis à jour le README" |
| `style` | Formatting, whitespace | "J'ai lancé prettier" |
| `refactor` | Code restructuring | "Réécrit la fonction" |
| `perf` | Performance improvement | "J'ai rendu ça plus rapide" |
| `test` | Adding/modifying tests | "J'ai ajouté un test" |
| `build` | Build system or dependencies | "Upgradé une dépendance" |
| `ci` | CI/CD configuration | "Changé la config CI" |
| `chore` | Maintenance tasks (no logic) | "Nettoyé des vieux scripts" |
| `revert` | Revert of a previous commit | |

### Body
- Separate from subject by **one blank line**
- Explain the **why**, not the what (the diff shows the what)
- Wrap at **72 characters**
- Can have multiple paragraphs

### Footer & Breaking Changes
Use for:
- **Breaking changes**: `BREAKING CHANGE: <description>`
- **Issue references**: `Refs: GH-42` or `Fixes: GH-108`

You must signal breaking changes with **both**:
1. `!` after the type/scope in the subject line
2. `BREAKING CHANGE:` in the footer

### Anti-Patterns You Must Reject
```
# ❌ Past tense
feat(auth): added OAuth2 support

# ❌ Capital after colon
feat(auth): Add OAuth2 support

# ❌ Period at end
feat(auth): add OAuth2 support.

# ❌ No type
add OAuth2 support

# ❌ Too vague
fix: fix bug
chore: updates

# ❌ Multiple concerns in one commit
feat(auth): add OAuth2 and fix export crash and update README
```

### Examples

#### Feature (with Breaking Change)
```
feat(api)!: replace authentication endpoint schema

Migrate from form-encoded to JSON body for all auth endpoints.
This simplifies client implementations and aligns with the REST
convention used elsewhere in the API.

BREAKING CHANGE: The /auth/token endpoint now requires a JSON body
instead of form-encoded parameters. All existing clients must
update their request format before upgrading.

Refs: GH-256
```

#### Fix
```
fix(export): handle empty dataset without crashing

Exporting an empty dataset previously raised an unhandled
IndexError. Now returns an empty file and logs a warning.

Fixes: GH-108
```

#### Revert
```
revert: feat(auth): add OAuth2 provider support

This reverts commit a1b2c3d4.
Reason: regression on session management under load.
```

#### Minimal
```
docs: add contributing guidelines
```
```
chore(deps): bump express from 4.18.2 to 4.19.0
```
