---
name: feedback_never_git_checkout_user_files
description: "Never run git checkout/restore/reset --hard/clean/stash drop OR rm/unlink on working-tree files — once silently wiped the user's unstaged changes via `git checkout HEAD --`, irreversible, no backup existed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d3484aff-0a7f-4ddf-80b9-248de8587aff
---

**Never** run `git checkout HEAD -- <file>`, `git checkout -- <file>`, `git restore <file>`, `git reset --hard`, `git clean -f`, `rm` on source files, or any command that can destroy unstaged working-tree changes. This applies **even when**:
- I think I'm only reverting my own recent edits (e.g. lint --fix output)
- The file looks like it only contains my changes
- I'm sure the user "wouldn't have touched it"
- It's "just rolling back one step"

**Why:** I ran `git checkout HEAD -- src/lib/anthropic/auto-truncate.ts` to undo a partial `eslint --fix`, not realizing the file was already in the initial `git status` as `M` — meaning the user had pre-existing unstaged work in it. The checkout silently wiped all their work. The user had **no backup** (no IDE timeline, no fs snapshot). The damage was irreversible.

**How to apply:**
1. Before any operation that touches the working tree of a file, check `git status` for that file. If it shows `M` (modified) or it's untracked, **stop and ask** — never `checkout`/`restore`/`rm` it.
2. To undo my own lint/format changes: re-edit the file with `Edit`/`Write`, or just leave the changes and tell the user "I made these edits, I cannot cleanly revert without risking your work — please review and revert manually if undesired."
3. Even when "just undoing the last 30 seconds of my own work", treat the file as user-owned. Git cannot distinguish my edits from theirs.
4. If a tool I ran (like `eslint --fix`) modified many files in ways I want to undo, do **not** mass-revert. Ask the user.

Linked: [[feedback_no_unilateral_action]]
