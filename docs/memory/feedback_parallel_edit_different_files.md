---
name: feedback_parallel_edit_different_files
description: Always parallel-submit Edit/tool calls when modifying different files in a refactor; never serialize across-file edits
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d66b9bc-324c-453c-9c7e-d6e9100240e2
---

User: "你怎么不并行了??"——当我串行 Edit 5 个不同的清洗 pass 文件时(应该一个消息里并行提交全部 Edit)。

**Why:** harness 显式支持同一消息里并行多个独立工具调用("Independent tool calls can run in parallel in one response")。不同文件的 Edit 是独立的(no shared state)。串行不仅每个 Edit 单独走一轮往返徒增延迟,还在大重构里累积出明显的总耗时差。同文件多个非重叠 Edit 也可放同一消息——harness 顺序应用,只要 old_string 不重叠即正确。

**How to apply:**
- 任何多文件改动:**先列清单,再一次性并行提交全部 Edit**(同一 assistant 消息里多个 `<invoke name="Edit">`)。
- 同文件多处非重叠改动:也放同一消息。
- 唯一需要串行的:Edit 依赖前一个 Edit 的输出值——实际罕见,因为 Edit 输入是字面字符串。
- 不止 Edit:Read/Bash/Write 凡是相互独立的也应并行(如同时读多个文件、跑 typecheck+lint+test 三个命令)。
- 这是工具调用层的效率原则,适用所有重构/批量改动/多文件探索场景。
