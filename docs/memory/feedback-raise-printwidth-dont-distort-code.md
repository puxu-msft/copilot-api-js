---
name: feedback-raise-printwidth-dont-distort-code
description: 用户厌恶 prettier 强制折行长字符串/注释；解法是调高 prettier printWidth（现为 160），而非缩短/扭曲代码去将就
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

用户**极度厌恶** prettier 强制折行长字符串 / 错误消息 / 注释（"用户极度厌恶这种长字符串、注释折行"）——例如 `throw new Error("…very long…")` 被重排成 `throw new Error(⏎  "…",⏎)`。

**Why:** Lint 应服务于可读性，而非反过来（CLAUDE.md best-complete-solution）。当我的错误消息超过 print width 时，prettier 把它折行了——很丑。我起初的"修法"是**缩短消息去将就**，被用户坚决否决："用户希望禁用 prettier 的折行检查，而不是我们去将就它"——禁掉折行检查，别靠扭曲代码去迁就它。

**How to apply:**
- 杠杆是 `prettier.config.mjs` → `printWidth`。它是 prettier **唯一**的折行控制，且全有或全无：太低强制折行，太高（如 1000）会反向把**现有的多行代码塌缩**成超长单行（已验证——会全仓破坏 lint）。不存在"保留作者换行不动"的模式。
- 采用的方案（2026-06-06）：`printWidth` 从 **120 → 160**，然后一次性全仓 `eslint --fix .` 归一化了 176 个文件（机械塌缩 120–160 之间被折行的调用/对象；后端 tsc/tests + ui tests 保持绿）。
- 所以：**不要为躲折行而缩短/重构代码。** 长字符串/错误消息在 ~160 列以内现在会自动保持单行。若某处确实仍超过 160 折行，再去调 printWidth（或对那一处用 `// prettier-ignore`）——绝不残害措辞。Relates to [[feedback_optimize_long_term_maintainability]]。

**注意范围:本条只记代码(printWidth)那半边。** 手写**散文**(md/yaml/注释/记忆正文)的同源原则——"按语义换行、一段一行、绝不为列宽硬折一个句子"——由 CLAUDE.md prose-line-per-paragraph 管辖,不在此记忆重复(knowledge-routing:CLAUDE.md 放原则,记忆不复述)。
