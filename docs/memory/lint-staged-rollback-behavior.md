---
name: lint-staged-rollback-behavior
description: "bun's lint-staged auto-restores the working tree on lint failure (stash → revert), leaving fix changes only in your subsequent edits — must re-git-add to actually commit them"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

In `/home/xp/src/copilot-api-js`, `git commit` triggers a lint-staged hook that:

1. **Backs up** working tree to `git stash`
2. Runs `eslint --cache` on staged files
3. On **failure**: reverts the working tree to the stash, **skips the commit**, prints errors
4. On **success**: applies any autofix mods, commits

**Practical consequence:** if you ran `git commit` → it failed lint → you then ran `bunx eslint --fix` to fix the failures → those fixes live in the **working tree** but not the **index**. Re-running `git commit` will re-stage from the index (unchanged → still has the broken version), then fail lint again. Symptoms: "I just fixed it, why does it still error?" with **identical** error line numbers as before.

**Fix:** `git add <fixed-files>` before re-committing. Per [[feedback_no_unilateral_action]] this requires user consent unless the user already authorized you to stage those files.

**Detection:** if `bun run typecheck` and `bunx eslint <file>` both report clean but `git commit` still reports lint errors at exact same lines as before, you're in this state — the staged blob is stale.

Tested with bun 1.3.14, package `lint-staged` invoked via husky pre-commit hook. Same behavior on any other lint-staged based setup.

Related: [[feedback_no_unilateral_action]] (cannot silently `git add` user files).
