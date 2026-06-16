---
name: feedback_prefer_mature_libs_for_scoped_components
description: "对于范围明确/算法性的组件,优先使用成熟的外部库而非手写实现"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a84ec520-05ff-4528-9150-52b84a2eec7e
---

当一个组件的范围定义明确、问题本身已是被解决过的/算法性的(例如行+词/字符的文本 diff、解析、日期运算),**应优先使用成熟的外部库,而非手写实现**。自定义代码只保留给库无法胜任的领域特定部分。

**Why:** 成熟的库在处理棘手的边界情况(例如以行为单位的 diff 同时高亮行内词/字符级的显著差异)上远胜一个临时手写的 LCS;手写这些久经验证的算法是一种得不偿失的虚假节省,会变成维护/质量上的负债。

**How to apply:** 拆分设计——算法已被解决的叶子层用外部库;只有库无法表达的领域层才自己实现。本仓库的具体案例:UI 的 block-diff 引擎在 L3 叶子层的行/词 diff(`diffLines`/`diffWordsWithSpace`/`diffJson`)上使用 `diff`(jsdiff),而 L1/L2/L4(按 role/type/offsetMs 对齐 message/block/SSE-frame)则自己实现,因为没有通用的 diff 库能对齐我们的领域模型。NOTE: 只丢弃渲染包装层(`diff2html` → 我们用自己的主题渲染),保留算法核心(`diff`)。

不要过度套用"不引第三方依赖 / 自己造"的本能——这个本能只在真正领域特定或极其简单的代码上才正确。与 [[feedback_optimize_long_term_maintainability]] 和 [[feedback_complete_root_cause_fix]] 对照:最可维护、最完整的方案往往**就是**那个久经沙场的库。
