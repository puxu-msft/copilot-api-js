---
name: feedback-raise-printwidth-dont-distort-code
description: User dislikes prettier-forced line-wrapping of long strings/comments; the fix is to RAISE prettier printWidth (now 160), NOT to shorten/distort code to fit
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

The user **extremely dislikes** prettier-forced line-wrapping of long strings / error messages / comments ("用户极度厌恶这种长字符串、注释折行") — e.g. `throw new Error("…very long…")` reflowed into `throw new Error(⏎  "…",⏎)`.

**Why:** Lint must serve readability, not the reverse (CLAUDE.md 原则8). When my error message exceeded print width, prettier wrapped it — ugly. I first "fixed" it by **shortening the message to fit**, and the user firmly rejected that: "用户希望禁用 prettier 的折行检查，而不是我们去将就它" — disable the wrap check, don't accommodate it by distorting code.

**How to apply:**
- The lever is `prettier.config.mjs` → `printWidth`. It is prettier's ONLY wrap control and is all-or-nothing: too low forces wrapping, too high (e.g. 1000) inverts to **collapsing** existing multi-line code into long single lines (verified — breaks lint repo-wide). There is no "leave the author's line breaks alone" mode.
- Resolution chosen (2026-06-06): `printWidth` raised **120 → 160**, then a one-time repo-wide `eslint --fix .` normalized 176 files (mechanical collapse of 120–160 wrapped calls/objects; backend tsc/tests + ui tests stayed green).
- So: **do NOT shorten/restructure code to dodge a wrap.** Long strings/errors up to ~160 cols now stay one line automatically. If something legitimately still wraps past 160, revisit printWidth (or `// prettier-ignore` that one spot) — never mutilate the wording. Relates to [[feedback_optimize_long_term_maintainability]].

**注意范围:本条只记代码(printWidth)那半边。** 手写**散文**(md/yaml/注释/记忆正文)的同源原则——"按语义换行、一句一行、绝不为列宽硬折一个句子"——由 CLAUDE.md 代码风格段管辖,不在此记忆重复(原则11:CLAUDE.md 放原则,记忆不复述)。
