---
name: git-commits-push
description: Enforce Conventional Commits convention for writing commit messages, then auto-push. Use when the user says "commit", "commit ça", wants to commit changes, asks how to write a commit, wants their message reviewed, needs to understand commit types, or asks about breaking changes.
---

# Git Commits & Push

You enforce Conventional Commits 1.0.0 for every commit you produce.
**After every successful commit, push immediately** unless the user says otherwise.

## When to Use This

The user wants to commit. Signals, simples ou explicites :
- "commit ça", "commit", "commit les changements"
- "comment j'écris ce commit"
- "c'est quoi le bon type de commit pour ça"
- "revois mon message de commit"
- "conventional commits"
- "breaking change"

## Format

```
<type>(<scope>): <description>

[body]

[footer]
```

Three parts: **subject line** (required), **body** (optional), **footer** (optional).

## Subject Line Rules

1. **Always in English** — commits, body, and footer
2. **Type** — required, from the list below
3. **Scope** — optional, in parentheses, names the module/component/service affected
4. **Description** — required, after `: `
5. **Imperative present tense** : `add`, `fix`, `remove` — never `added`, `fixes`, `removing`
6. **No capital letter** after the colon
7. **No period** at the end
8. **72 characters max** for the entire subject line

## Allowed Types

| Type | When to use it |
|------|---------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only (README, comments, docstrings) |
| `style` | Formatting, whitespace, semicolons — no logic change |
| `refactor` | Code restructuring without functional change |
| `perf` | Performance improvement |
| `test` | Adding or modifying tests |
| `build` | Build system or external dependencies |
| `ci` | CI/CD configuration |
| `chore` | Maintenance tasks that touch neither source nor tests |
| `revert` | Revert of a previous commit |

### How to Pick the Type

When you hesitate:

- "J'ai ajouté un nouveau endpoint" → `feat`
- "J'ai fixé un crash" → `fix`
- "J'ai réécrit la fonction mais elle fait la même chose" → `refactor`
- "J'ai rendu ça plus rapide" → `perf`
- "J'ai ajouté un test" → `test`
- "J'ai mis à jour le README" → `docs`
- "J'ai lancé prettier" → `style`
- "J'ai upgradé une dépendance" → `build`
- "J'ai changé la config CI" → `ci`
- "J'ai nettoyé des vieux scripts" → `chore`

## Body

- Separate from subject by **one blank line**
- Explain the **why**, not the what (the diff shows the what)
- Wrap at **72 characters**
- Can have multiple paragraphs

## Footer

Use for:
- **Breaking changes** : `BREAKING CHANGE: <description>`
- **Issue references** : `Refs: GH-42` or `Fixes: GH-108`

## Breaking Changes

You must signal breaking changes with **both**:
1. `!` after the type/scope in the subject line
2. `BREAKING CHANGE:` in the footer

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

## Examples

### Feature

```
feat(auth): add OAuth2 authorization code flow with PKCE

Implements the full authorization code flow with PKCE for
third-party identity providers. Includes token refresh,
revocation, and session binding.

Refs: GH-42
```

### Fix

```
fix(export): handle empty dataset without crashing

Exporting an empty dataset previously raised an unhandled
IndexError. Now returns an empty file and logs a warning.

Fixes: GH-108
```

### Minimal (no body, no footer)

```
docs: add contributing guidelines
```

```
chore(deps): bump express from 4.18.2 to 4.19.0
```

### Revert

```
revert: feat(auth): add OAuth2 provider support

This reverts commit a1b2c3d4.
Reason: regression on session management under load.
```

## Anti-Patterns You Must Reject

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
feat: stuff

# ❌ Multiple concerns in one commit
feat(auth): add OAuth2 and fix export crash and update README
```

## Auto-Push

After every successful `git commit`, **always follow with `git push`** to the current
branch's remote.

- No upstream → `git push -u origin <branch>`
- Has upstream → `git push`
- **Exception**: user explicitly says "ne push pas" or "commit only"
- Push fails → report the error, do not retry in a loop

## Your Rules

- **Never commit code that doesn't pass tests** — run tests before committing.
  If a test fails, fix it first. No exceptions.
- **Never commit secrets, API keys, tokens, or passwords** — the `secret-scanner`
  hook blocks these automatically, but you should still review the staged diff.
  Use `.gitignore` and `.env` for sensitive data.
- **Always verify the commit message** against every rule before committing
- **Choose the right type** based on what the user changed
- **Rewrite vague messages** into specific ones — propose a concrete alternative
- **Split multi-concern commits** into separate commits
- **Never generate a commit message without understanding the change** — ask what
  changed if it's unclear
