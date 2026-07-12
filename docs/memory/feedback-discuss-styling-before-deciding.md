---
name: feedback-discuss-styling-before-deciding
description: "样式/视觉细节(颜色/字形/圆角/阴影/间距/高度/透明度)总是先与用户讨论并给选项+建议,绝不自行决定"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9adc2eaf-0885-437d-9c58-0b8c86859381
---

用户明确要求:**关于样式,总是先与用户讨论而不是自行决定**。

**背景**:在 ui-v4 LiveDock 系列工作里,我一路自作主张定了大量视觉细节——颜色(`#7fd99a`/`#2f6f3f` 绿、`#d4a04a` amber)、字形(`● ▲ ▼ ⏸ ↓ ⚡ ↻`)、高度(`h-6`)、边框/阴影、间距、圆角与否——从未就这些征求用户意见。用户指出这不对。

**Why**:样式是用户偏好的强分叉区(不是代码正确性能自解的 invariant);默认值(模型先验的"好看")经常与用户审美 / 项目设计系统冲突。本项目主题是「工业风 Terminal Amber · **锐角** · 暖近黑 · amber 主色 · 信号色」(见 `ui-v4/src/styles/theme.css` 顶注 + `--color-*` token),我却默认加圆角/自选配色,可能直接违背设计语言。

**How to apply**:任何涉及视觉呈现的改动(新组件外观、配色、圆角、阴影、间距、字号/字形、透明度/毛玻璃、动效、布局形态)——**先停下,把样式维度系统性列出,给每维 2-4 个带取舍的选项 + 我的推荐(并标注与项目设计系统 token/锐角约定 的一致性),用 `AskUserQuestion` 问用户**,定稿后再实现。区别于 `scope-ambiguity-then-ask`(那是逻辑/范围歧义可用 invariant 自解);样式是真偏好分叉,几乎总要问。功能/逻辑仍可自解自决,别把这条泛化成事事都问。**Related**:[[feedback-pass-null-clean-not-self-validating]] 是「结论不自证」,本条是「样式不自决」。
