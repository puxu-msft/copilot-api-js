---
name: large-refactor-toolkit-sed-grep-status
description: "For multi-file API renames / import deletions / type-shape migrations, the productive loop is `sed -i` for bulk edits + `grep -rn` to verify zero residuals + `git status --short` to track scope, NOT one-Edit-at-a-time"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

Working pattern for ~8 commits / ~3500 LOC observability rewrite (2026-06-14).

**When you have to do "rename X to Y across 30 files" or "delete this import everywhere":**

1. **`sed -i` for the bulk edit** (per-line regex, in-place):
   ```bash
   sed -i 's/tracker\.getActiveRequests/tracker.getActive/g' src/lib/shutdown.ts tests/shutdown/shutdown.unit.test.ts
   sed -i '/import { tuiLogger } from/d; /tuiLogger\.clear()/d' tests/helpers/test-bootstrap.ts
   ```
   Faster than the Edit tool for repetitive substitutions; deterministic; works on dozens of files in one shell call.

2. **`grep -rn` to verify zero residuals** AFTER edit:
   ```bash
   grep -rn "tuiLogger\|TuiLogEntry\|TuiRenderer" src/ tests/ --include="*.ts"
   ```
   If output is non-empty, the bulk edit missed something. Iterate.

3. **`git status --short`** to track scope creep:
   ```bash
   git status --short | grep -v '^??'    # tracked changes only
   git diff --stat                        # per-file line delta
   ```
   Spot files that shouldn't have been touched (your sed regex was too loose).

4. **Distinguish "code references" from "comment references"**:
   ```bash
   grep -rn "tuiLogger" src/ tests/ --include="*.ts" | grep -v "^\\s*\\*\\|//" | head
   ```
   Or just inspect output mentally; docstring residuals are usually intentional historical context.

**Pitfalls caught this session:**
- `sed` will silently mangle multi-line patterns. For anything spanning lines, use Edit/Read.
- `sed -i 's/foo/bar/g' file file` works on multiple files but NOT recursive. For recursive: `grep -rln "foo" src | xargs sed -i 's/foo/bar/g'`.
- After bulk delete, also delete now-unused imports — TypeScript will complain, that's your hint.
- Always `bun run typecheck` between bulk edits. Don't stack 5 bulk edits then debug a wall of type errors.
- Heredoc + `sed` doesn't survive special chars in commit messages — use `git commit -F file` or careful escape. (Bit me on commit 4: backticks in commit message broke bash parsing; commit still succeeded but stderr was loud.)

**When NOT to use sed:**
- Anything inside string literals / template literals (high risk of mismatch)
- TypeScript signature changes (multi-line edit, easier with Edit tool)
- When you need to preserve formatting nuance (lint will fix simple ones after, but if a sed produces invalid syntax, lint won't run)

**Combined productivity recipe:**
```bash
# 1. bulk edit
sed -i 's/oldAPI(/newAPI(/g' src/ -r --include="*.ts"
# 2. verify
grep -rn "oldAPI" src/ tests/ | head
# 3. let TypeScript find remaining
bun run typecheck 2>&1 | tail -20
# 4. fix any holdouts with Edit tool
# 5. verify again
bun run test:backend 2>&1 | tail -5
# 6. autofix lint
bunx eslint --fix <changed files>
```

Related: [[feedback_parallel_edit_different_files]] (in-message parallel for independent file edits), [[feedback_never_stop_at_compile_intermediate]] (push through typecheck-broken states to the next green).
