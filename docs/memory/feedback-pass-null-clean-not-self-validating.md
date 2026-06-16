---
name: feedback-pass-null-clean-not-self-validating
description: 通过/空/干净的结果不会自证；下结论前先确认这次检查真的跑到了目标
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb26a9bc-bbda-45b1-94b3-4fffbd4bccdc
---

"测试通过""结果为空""没发现问题""diff 干净"这类**否定性/通过性**结论，本身不证明任何东西——它同样可能是检查根本没命中目标产生的假阴性。下结论前必须确认这次检查真的执行到了它声称覆盖的范围。

具体陷阱：
- **空 ≠ 负**：grep 0 命中可能是模式写错、路径写错，而非"不存在"。
- **通过 ≠ 健全**：测试 pass 可能是断言太弱、mock 短路、根本没进被测分支。
- **子域 0 ≠ 全域 0**：在一个子目录/单文件搜到 0，不代表整个代码库 0。

**Why:** 假阴性比假阳性更危险——它伪装成"已确认安全"，让你停止追查。这是承重判断（"无消费者""可安全删除""已覆盖"）翻车的高发口。

**How to apply:** 拿到 pass/empty/clean 结论时，先反问"这个检查真的触达目标了吗"——用一个已知应命中的正样本验证 grep/测试确实会响应（正向对照），再相信它的"无"。与 [[feedback-mine-the-pass-with-warn]]（PASS+WARN 当黄灯）、[[feedback_reviewer_verify_critically]]（绝对断言要复核）配套。
