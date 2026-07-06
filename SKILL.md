---
name: git-commits-push
description: Discover dirty repos, validate (tests + secret scan), generate Conventional Commits via LLM, commit with file-level splitting, auto-push with retry loop. Use when the user says "commit", wants to publish changes, or asks about commit messages.
---

# Git Commits Push

When this skill is activated or referenced, you **MUST** immediately run the following command to execute the commit and push assistant:

```bash
cd /Users/famillesendrison/.agents/skills/git-commits-push && bun run start
```

⚠️ **No external timeout.** The skill manages its own. Run bare.
