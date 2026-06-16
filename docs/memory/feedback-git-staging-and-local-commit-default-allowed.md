---
name: feedback-git-staging-and-local-commit-default-allowed
description: "Git add/commit/local-branch operations are default-allowed (not \"禁止 unless asked\") — user explicitly changed this rule 2026-06-15 because old \"always ask\" was due to past management chaos, not actual risk. Remote push + history rewrite still need explicit consent."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: aefcabc6-5b23-423e-aa8a-2fef19f97ca3
---

User changed CLAUDE.md 原则2 on 2026-06-15. Old rule: "禁止 git add/reset/restore --staged without explicit user consent". New rule: **default-allowed for reversible local operations; explicit consent required only for remote/history-rewrite**.

**Default-allowed (no need to ask):**
- `git add` / `git add -p`
- `git restore --staged <file>` (only touches index)
- `git commit` / `git commit --amend` (only when not yet pushed)
- `git stash push`
- Local branch ops: `git branch`, `git switch -c`, `git checkout -b`

**Must ask explicitly:**
- `git push` (any remote push, including --force / --force-with-lease)
- `gh pr create` and any content-to-GitHub operation
- Amend/rebase/reset against commits already pushed
- Branch deletion: `git branch -D`, `git push --delete`
- Tag push

**Still forbidden (原则1 unchanged):** anything that destroys unstaged working-tree changes — see [[feedback_never_git_checkout_user_files]]. `git restore --staged` is safe (only index); `git restore <file>` (no --staged) hits working tree → 原则1 territory.

**Why:** User said "以前是因为管理混乱所以才禁止" — past chaos meant misplaced trust, so the conservative rule was "ask every time". Now that 原则1 hard-locks the truly destructive ops, treating `git add` as needing ceremonial approval is friction-only.

**How to apply:**
1. Self-check before any git op: (a) does it touch remote? → ask. (b) does it touch user's working-tree files? → 原则1. (c) only index / only local commit / only local branch? → just do it.
2. Commit messages: write, commit, mention what was committed in the response. If user dislikes the message, they can `git commit --amend` (reversible until push).
3. Do NOT slip into the old "should I ask before git add?" reflex — it was correct under the old rule, now it's wasted ceremony.

Linked: [[feedback_never_git_checkout_user_files]] (原则1 untouched, still controls destructive ops), [[feedback_no_unilateral_action]] (scope ambiguity still requires asking).
