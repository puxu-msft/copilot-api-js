---
name: large-refactor-toolkit-sed-grep-status
description: "对于多文件 API 重命名 / 导入删除 / 类型形态迁移，高效的循环是用 `sed -i` 做批量编辑 + `grep -rn` 验证零残留 + `git status --short` 跟踪范围，而非一次一个 Edit"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

约 8 个 commit / 约 3500 LOC 的可观测性重写的工作模式（2026-06-14）。

**当你必须做"把 X 重命名为 Y，跨 30 个文件"或"到处删除这个导入"时：**

1. **用 `sed -i` 做批量编辑**（逐行正则，就地修改）：
   ```bash
   sed -i 's/tracker\.getActiveRequests/tracker.getActive/g' src/lib/shutdown.ts tests/shutdown/shutdown.unit.test.ts
   sed -i '/import { tuiLogger } from/d; /tuiLogger\.clear()/d' tests/helpers/test-bootstrap.ts
   ```
   对重复性替换比 Edit 工具快；确定性；一次 shell 调用即可作用于数十个文件。

2. **编辑后用 `grep -rn` 验证零残留**：
   ```bash
   grep -rn "tuiLogger\|TuiLogEntry\|TuiRenderer" src/ tests/ --include="*.ts"
   ```
   若输出非空，说明批量编辑漏了某处。迭代。

3. **用 `git status --short`** 跟踪范围蔓延：
   ```bash
   git status --short | grep -v '^??'    # tracked changes only
   git diff --stat                        # per-file line delta
   ```
   发现不该被改动的文件（你的 sed 正则太宽松了）。

4. **区分"代码引用"与"注释引用"**：
   ```bash
   grep -rn "tuiLogger" src/ tests/ --include="*.ts" | grep -v "^\\s*\\*\\|//" | head
   ```
   或者直接在脑中审视输出；docstring 里的残留通常是有意保留的历史上下文。

**本会话踩到的坑：**
- `sed` 会静默地搞乱多行模式。任何跨行的内容，用 Edit/Read。
- `sed -i 's/foo/bar/g' file file` 能作用于多个文件，但**不递归**。递归用：`grep -rln "foo" src | xargs sed -i 's/foo/bar/g'`。
- 批量删除后，也要删除如今未使用的导入——TypeScript 会报错，那就是你的提示。
- 批量编辑之间始终跑 `bun run typecheck`。别叠 5 个批量编辑再去 debug 一堵墙的类型错误。
- heredoc + `sed` 撑不住 commit message 里的特殊字符——用 `git commit -F file` 或仔细转义。（commit 4 咬了我一口：commit message 里的反引号破坏了 bash 解析；commit 仍然成功，但 stderr 噪声很大。）

**何时不该用 sed：**
- 任何在字符串字面量 / 模板字面量内部的内容（错配风险高）
- TypeScript 签名变更（多行编辑，用 Edit 工具更容易）
- 当你需要保留格式细节时（简单的 lint 之后会修，但如果 sed 产出无效语法，lint 跑不起来）

**组合生产力配方：**
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

Related: [[feedback_parallel_edit_different_files]]（对独立文件编辑用消息内并行），[[feedback_never_stop_at_compile_intermediate]]（推过 typecheck 损坏的状态直到下一个 green）。
