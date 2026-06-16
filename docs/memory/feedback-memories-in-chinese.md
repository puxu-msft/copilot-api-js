---
name: feedback-memories-in-chinese
description: 本项目记忆一律用中文写——正文 + frontmatter description + MEMORY.md 索引钩子；保留 slug(kebab-ASCII)、code/file:line/wiki 链接/技术标识符、以及 Why/How 英文结构标签
metadata:
  type: feedback
---

用户要求本项目 `docs/memory/` 的记忆**全部用中文写**:
- **译为中文**:正文散文、frontmatter 的 `description:` 值、MEMORY.md 索引行的钩子文字。
- **逐字保留不动**:文件名与 frontmatter `name:`/`metadata:`(slug 一律 kebab-ASCII);code/JSON/shell 片段与行内 `code`;`file:line` 引用;`[[...]]` 内的 slug(只译外围文字);技术标识符与专名(tool_use、signature、printWidth、SSE 等)。
- **结构标签 `**Why:**`/`**How to apply:**`/`**Related:**` 保留英文**(本次用户在三选项中选了"保留英文标签";标签后的内容用中文)。

**Why:** 面向用户的一切产出——对话回复 + 记忆正文/description——用中文是用户一贯偏好;绝不用日语。slug 保 ASCII 是为跨工具/文件系统稳健 + 保证 wiki 链接匹配。本条与 CLAUDE.md"使用中文对话"互补:那条管对话,本条管记忆文件这条 CLAUDE.md 未覆盖的轴(同 [[feedback-knowledge-routing-docs-vs-memory]] 的延伸逻辑)。

**How to apply:** 新建或编辑任何记忆时**直接用中文写**,别先写英文再译。比对/维护既有记忆时若发现英文残留,顺手译(与 [[feedback-distill-lessons-at-boundaries]] 的"维护既有库:陈旧→修"配套)。
