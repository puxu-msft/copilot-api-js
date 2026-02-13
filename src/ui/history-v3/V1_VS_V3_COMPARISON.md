# History UI V1 vs V3 完整功能对比

状态标记：
- ✅ V3 已有且正确
- ⭐ V3 比 V1 更好
- ❌ V3 缺失（V1 有）
- ⚠️ V3 有但存在缺陷
- 🆕 V3 新增（V1 没有）

---

## A. 页面布局和结构

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| A1 | 三层布局 | Header + Stats + SplitPane | 同 | ✅ | |
| A2 | 分栏宽度 | CSS Grid 固定 320px / 1fr | 可拖拽，记忆到 localStorage | ⭐ | V3 更好 |
| A3 | 响应式断点 | `@media (max-width: 768px)` 竖向堆叠 | 无媒体查询断点 | ❌ | V3 在窄屏下不会自适应 |
| A4 | 选中条目后自动滚动到底部 | `detailContent.scrollTop = detailContent.scrollHeight` | 无 | ❌ | V1 选中条目后详情面板滚动到底部（最新消息/响应可见） |
| A5 | 首次加载自动选中 | 自动选中第一条（最新条目） | 无 | ❌ | V1: `if (!currentEntryId && data.entries.length > 0) selectEntry(data.entries[0].id)` |

---

## B. 顶部栏 (Header)

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| B1 | 标题 | "History" | "History V3" | ✅ | |
| B2 | 会话选择器 | 下拉框，显示时间 + 请求数 | 下拉框，显示 Session ID 前8位 + 请求数 | ⚠️ | V1 显示 `formatDate(startTime) + " (N reqs)"`，V3 显示 `Session XXXXXXXX (N req)`。V1 更直观 |
| B3 | Refresh 按钮 | 列表透明度降至 0.5 作为加载指示，完成后恢复 | 仅 Toast "Refreshed" | ⚠️ | V1 的视觉反馈更好，能看到正在刷新 |
| B4 | Refresh 后重新加载当前条目 | 刷新后重新 selectEntry 当前条目 | 只刷新列表和统计 | ❌ | V1: `if (currentEntryId) selectEntry(currentEntryId)` |
| B5 | Export 下拉 | 两项（JSON/CSV），点击外部关闭 | 同 | ✅ | |
| B6 | Export 方式 | `location.href = url`（当前窗口下载） | `window.open(url, '_blank')`（新标签） | ⚠️ | 功能相同但行为不同，V1 用当前窗口更自然 |
| B7 | Clear 确认 | confirm 对话框 | 同 | ✅ | |
| B8 | Clear 后重置 | 隐藏详情面板 + 重新加载所有数据 | 调用 store.clearAll() | ✅ | |
| B9 | WS 连接状态指示 | 无 | StatusDot + "Live"/"Offline" 文本 | 🆕 | V3 新增 |
| B10 | Esc 关闭 Export 菜单 | 是 | 否（只有点击外部关闭） | ❌ | V1 按 Esc 也关闭 Export 菜单 |

---

## C. 统计栏 (Stats Bar)

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| C1 | 5 项统计 | Requests / Success / Failed / In Tokens / Out Tokens | 同 | ✅ | |
| C2 | 格式化 | formatNumber（K/M 后缀） | 同 | ✅ | |
| C3 | 数据刷新 | 手动 Refresh 触发 | 手动 Refresh + WS stats_updated 自动更新 | ⭐ | V3 实时更新 |

---

## D. 请求列表 (Request List)

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| D1 | 搜索框 | 有，300ms debounce | 同 | ✅ | |
| D2 | 搜索结果计数 | 显示 "N hits" 文本 | 无 | ❌ | V1: `updateSearchCount()` 在搜索框旁显示匹配数 |
| D3 | Endpoint 过滤 | 下拉框（Anthropic/OpenAI） | 同 | ✅ | |
| D4 | Status 过滤 | 下拉框（Success/Failed） | 同 | ✅ | |
| D5 | 列表项 - 状态点 | 彩色圆点 | 同 | ✅ | |
| D6 | 列表项 - 时间 | formatDate | 同 | ✅ | |
| D7 | 列表项 - 模型名 | 显示 | 同 | ✅ | |
| D8 | 列表项 - Endpoint badge | 显示 | 同 | ✅ | |
| D9 | 列表项 - Stream badge | 显示 | 同 | ✅ | |
| D10 | 列表项 - Token 统计 | `↓{in} ↑{out}` 格式 | `{in} in / {out} out` 格式 | ✅ | 格式不同但信息相同 |
| D11 | 列表项 - Duration | 显示 formatDuration | 不显示 | ❌ | V1 列表项第三行有 duration |
| D12 | 列表项 - 预览文本 | 最后一个 user 消息前 100 字符 | 同 | ✅ | |
| D13 | 选中高亮 | `selected` class + 样式 | 左边框蓝色 + 背景色 | ✅ | V3 选中效果更清晰 |
| D14 | 分页 - 页码按钮 | 显示最多 5 个页码 + 省略号 + 首页/末页 | 只有 Prev/Next + "page/total" | ❌ | V1 分页更丰富，支持跳转到任意页 |
| D15 | 空状态 | "No requests found" + "Try adjusting your filters" | "No requests found"（无副标题） | ⚠️ | V1 的提示更友好 |
| D16 | 错误状态 | 列表内显示错误信息 | Toast 通知 | ⚠️ | 不同策略，V3 错误不持久显示 |
| D17 | 加载状态 | 无明确加载指示 | "Loading..." 文本 | ⭐ | V3 有加载提示 |

---

## E. 详情面板 (Detail Panel)

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| E1 | 空状态 | "Select a request to view details" | 同 + 快捷键提示 "Use ↑↓ or j/k to navigate, / to search" | ⭐ | |
| E2 | 详情搜索框 | 有，300ms debounce | 同 | ✅ | |
| E3 | 搜索后滚动到首个匹配 | 是（applySearchHighlight → scrollIntoView） | 否 | ❌ | V1 搜索后自动滚动到第一个高亮词 |
| E4 | 角色过滤 | All / system / user / assistant / tool | All / System / User / Assistant（缺 tool） | ⚠️ | V3 缺少 tool 角色过滤选项 |
| E5 | 类型过滤 | All / text / tool_use / tool_result / image / thinking | 同 | ✅ | |
| E6 | Aggregate Tools 开关 | 复选框 | 同 | ✅ | |
| E7 | 全局 Show Raw 按钮 | 在 Section 头部（REQUEST/RESPONSE/META 各一个 Raw） | 工具栏一个全局 Raw | ⚠️ | V1 每个 Section 有独立 Raw 按钮（可查看 Request/Response/Full Entry 的 Raw），V3 只有一个全局 Raw 显示整个 entry |
| E8 | Section 折叠 | 三个 Section 都可折叠 | 同（SectionBlock 组件） | ✅ | |
| E9 | Section 头部 Raw 按钮 | REQUEST section: Raw 查看 request，RESPONSE: Raw 查看 response，META: Raw 查看 full entry | 无 Section 级别 Raw | ❌ | V3 只有全局 Raw 和消息/内容块级别 Raw，缺少 Section 级别的 Raw |
| E10 | Section badge | REQUEST 显示 "N messages" | 同 | ✅ | |
| E11 | 过滤器触发行为 | 变更过滤器后完全重建 DOM | computed 属性 + v-show | ⭐ | V3 性能更好 |

---

## F. System Message

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| F1 | 显示 string 格式 | 是 | 是 | ✅ | |
| F2 | 显示 SystemBlock[] 格式 | 是（合并为单文本） | 是（逐块显示 + cache_control 标记） | ⭐ | V3 更详细 |
| F3 | cache_control 标记 | 不显示 | 显示 `[cache: {type}]` | ⭐ | V3 新增 |
| F4 | Rewrite 检测 | 比较原文和重写文本 | 同 | ✅ | |
| F5 | Original/Rewritten/Diff 切换 | 三个 tab 按钮 | 同 | ✅ | |
| F6 | 折叠/展开 | 可折叠（点击 collapse-icon），折叠后显示摘要（前80字符） | 无折叠功能 | ❌ | V1 可以折叠 system message 到一行摘要 |
| F7 | Expand 按钮 | 内容超过 max-height 200px 时显示 Expand/Collapse | 无（固定 max-height: 400px 滚动） | ⚠️ | V3 system-body 有 max-height 400px + overflow-y auto，但没有 Expand 按钮切换 |
| F8 | Copy 按钮 | 有 | 有 | ✅ | |
| F9 | Raw 按钮 | 有 | 有 | ✅ | |
| F10 | "rewritten" badge | 显示 `(rewritten)` 文本 | 显示 BaseBadge "rewritten" | ✅ | |

---

## G. 消息块 (Message Block)

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| G1 | 角色标签 | `SYSTEM` / `USER` / `ASSISTANT` / `TOOL` 带颜色 | BaseBadge 带颜色 | ✅ | |
| G2 | 消息序号 | 无 | 显示 `#N` | ⭐ | V3 新增，更容易定位 |
| G3 | 折叠/展开（消息级别） | 点击 collapse-icon 折叠，显示 collapsed-summary | 点击整个 header 折叠/展开 | ✅ | 行为略不同但功能等价 |
| G4 | 折叠摘要 | 折叠时显示 getMessageSummary（前80字符或块类型计数） | 折叠时不显示摘要 | ❌ | V1 折叠后能看到消息概要，V3 折叠后只有 header |
| G5 | Rewrite 检测 | 比较原始和重写消息内容 | 同 | ✅ | |
| G6 | Original/Rewritten/Diff 切换 | 三个 tab 按钮 | 同 | ✅ | |
| G7 | 截断标记 | `(deleted)` badge + truncated class（红色边框+删除线） | BaseBadge "truncated" + truncated class | ✅ | V1 用 "(deleted)" 更准确（消息确实被删除），V3 用 "truncated" |
| G8 | Expand/Collapse 按钮 | 内容超 200px 时显示，控制 body-collapsed class | 内容超 500px 时显示 | ⚠️ | V3 阈值更高（500px vs 200px），在 V1 中有些内容会触发 Expand 的在 V3 中不会 |
| G9 | Raw 按钮 | 有，显示消息 JSON | 有 | ✅ | |
| G10 | Copy 按钮（消息级别） | 无独立 Copy，依赖内容块的 Copy | 无 | ✅ | 相同 |
| G11 | 消息 body 默认状态 | 不折叠（展开状态） | 同 | ✅ | |

---

## H. 内容块 — TEXT

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| H1 | 类型标签 | `TEXT` 彩色标签 | 无标签 | ❌ | V1 每个 text 块左上角有 "TEXT" 标签 |
| H2 | 折叠头部 | 有 collapse-icon，可折叠，折叠后显示摘要 | 无折叠头部 | ❌ | V1 text 块有完整的 header（类型标签 + collapse + actions） |
| H3 | 默认折叠 | body-collapsed（max-height: 200px） | 无限制 | ❌ | V1 text 块默认只显示 200px 高度，超出部分需点击 Expand |
| H4 | Expand/Collapse 按钮 | 超出 200px 时显示 | 无 | ❌ | V3 TextBlock 没有 Expand 功能 |
| H5 | Copy 按钮 | 有 | 有（悬浮显示） | ✅ | V3 hover 时出现 |
| H6 | Raw 按钮 | 有 | 有（悬浮显示） | ✅ | |
| H7 | 搜索高亮 | 有 | 有 | ✅ | |

---

## I. 内容块 — TOOL USE

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| I1 | 类型标签 | `TOOL USE` 彩色标签 | `TOOL USE` 标签 | ✅ | |
| I2 | 工具名 | 显示 | 同 | ✅ | |
| I3 | Tool ID | 显示 | 同 | ✅ | |
| I4 | 折叠头部 | 有 collapse-icon，可折叠，折叠后显示工具名 | 无折叠功能 | ❌ | V1 tool_use 块可以折叠到只显示工具名 |
| I5 | 默认折叠 | body-collapsed（max-height: 200px） | 无限制（fixed max-height: 300px + overflow） | ⚠️ | V3 有 max-height 300px 但没有 Expand 按钮 |
| I6 | Expand/Collapse | 超出 200px 时显示 Expand 按钮 | 无 | ❌ | |
| I7 | Input 格式化 | JSON.stringify + escapeHtml（纯文本） | JSON.stringify（`<pre>` 纯文本） | ✅ | |
| I8 | 聚合模式 - 内联结果 | 显示 RESULT 子区域（有 Raw 按钮） | 嵌入完整 ToolResultBlock 组件 | ⭐ | V3 内联结果更完整（有 Copy+Raw） |
| I9 | 非聚合模式 - Jump to result | "→ Jump to result" 链接 | 同 | ✅ | |
| I10 | Jump 后目标高亮闪烁 | highlightBlock() 添加 highlight-flash CSS 动画 | 只有 scrollIntoView，无闪烁 | ❌ | V1 跳转后目标块边框短暂闪烁高亮 |
| I11 | Copy 按钮 | 有，复制 input JSON | 有 | ✅ | |
| I12 | Raw 按钮 | 有 | 有 | ✅ | |

---

## J. 内容块 — TOOL RESULT

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| J1 | 类型标签 | `TOOL RESULT` 彩色标签 | `TOOL RESULT` 标签 | ✅ | |
| J2 | 工具名 | 从 toolUseNameMap 查找并显示 | 同 | ✅ | |
| J3 | Tool Use ID | 显示 `for {id}` | 无（只在聚合模式下通过 tool_name 关联） | ⚠️ | V1 显示 tool_use_id 方便对照 |
| J4 | "← Jump to call" 链接 | 有，滚动到对应 tool_use 块 | 无 | ❌ | V1 tool_result 块有反向跳转到 tool_use 的链接 |
| J5 | Jump 后目标高亮闪烁 | 同 I10 | 同 I10 | ❌ | |
| J6 | 折叠头部 | 有 collapse-icon，可折叠 | 无折叠功能 | ❌ | |
| J7 | 默认折叠 | body-collapsed（max-height: 200px） | fixed max-height: 300px + overflow | ⚠️ | |
| J8 | Expand/Collapse | 有 | 无 | ❌ | |
| J9 | is_error 样式 | 无特殊样式 | 红色边框 + ERROR badge | ⭐ | V3 error 状态更醒目 |
| J10 | Copy 按钮 | 有 | 有 | ✅ | |
| J11 | Raw 按钮 | 有 | 有 | ✅ | |

---

## K. 内容块 — THINKING

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| K1 | 类型标签 | `THINKING` 彩色标签 | `THINKING` 标签 | ✅ | |
| K2 | 折叠头部 | 有 collapse-icon，可折叠，折叠后显示摘要 | 无折叠功能 | ❌ | |
| K3 | 默认折叠 | body-collapsed（max-height: 200px） | fixed max-height: 400px + overflow | ⚠️ | |
| K4 | Expand/Collapse | 有 | 无 | ❌ | |
| K5 | redacted_thinking 处理 | 不处理 | 显示 "[Thinking content redacted]" + 整体降低透明度 | ⭐ | V3 更好 |
| K6 | Copy 按钮 | 有 | 有（非 redacted 时显示） | ✅ | |
| K7 | Raw 按钮 | 有 | 有（非 redacted 时显示） | ✅ | |
| K8 | 搜索高亮 | 有（但 V1 thinking 块不参与搜索高亮） | 有 | ⭐ | V3 thinking 也支持搜索高亮 |

---

## L. 内容块 — IMAGE

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| L1 | 图片渲染 | 不渲染，显示 "[Image content - base64 encoded]" | 渲染实际图片 `<img>` | ⭐ | V3 更好 |
| L2 | 类型标签 | `IMAGE` + media_type 文本 | 无标签，直接显示图片 | ⚠️ | V3 没有 IMAGE 类型标签和 media_type 显示 |
| L3 | Raw 按钮 | 有 | 无 | ❌ | V1 图片块有 Raw 按钮查看完整 block JSON（包含 base64 数据） |

---

## M. 内容块 — GENERIC (未知类型)

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| M1 | 类型标签 | 显示 block.type 或 "UNKNOWN" | 显示 `UNKNOWN: {type}` | ✅ | |
| M2 | 内容 | JSON.stringify 格式化 | 同 | ✅ | |
| M3 | Raw 按钮 | 有 | 有 | ✅ | |

---

## N. 内容块通用 — 折叠机制对比（关键差异）

V1 的内容块有两层折叠机制：

1. **块级折叠**（点击 collapse-icon）：整个内容块折叠到只显示 header（一行摘要）
2. **内容展开**（Expand/Collapse 按钮）：body 在 body-collapsed（200px max-height）和完全展开之间切换

V3 的内容块：
- **无块级折叠**：内容块始终显示完整 header + body
- **无 Expand/Collapse**：内容块没有 max-height 限制（部分有固定 max-height + overflow-y auto）
- **只有消息级别有折叠**：MessageBlock 可以折叠/展开

这是 V1 和 V3 最大的结构性差异。

---

## O. 聚合模式特殊行为

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| O1 | 聚合模式下 tool_result 隐藏 | 隐藏独立 tool_result，内联到 tool_use | 同 | ✅ | |
| O2 | 空消息提示 | 当消息只包含被聚合的 tool_result 时，显示 "Tool results aggregated to: ← {id}" 链接 | 无提示 | ❌ | V1 在内容被完全聚合走的消息中显示链接指向聚合目标 |
| O3 | 聚合内联结果的 Raw 按钮 | 有独立 Raw 按钮 | 有（ToolResultBlock 组件自带） | ✅ | |

---

## P. 截断可视化

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| P1 | 截断分隔线位置 | 在最后一个被截断消息之后 | 在 system message 之后、所有消息之前 | ⚠️ | V1 的位置更精确（在第 removedCount-1 个消息后），V3 始终放在消息列表最前面 |
| P2 | 截断信息 | "N messages truncated (Xk → Yk tokens, -Z%)" | 同 | ✅ | |
| P3 | 被截断消息样式 | truncated class（红色边框 + 减低透明度 + 删除线） | truncated class（红色边框 + 减低透明度） | ⚠️ | V1 还有文本删除线效果 |

---

## Q. Diff 对比

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| Q1 | System Message Diff | 有 | 有 | ✅ | |
| Q2 | Message Diff | 有 | 有 | ✅ | |
| Q3 | Diff 库 | diff + diff2html（CDN 加载） | diff + diff2html（npm 打包） | ⭐ | V3 无 CDN 依赖 |
| Q4 | Diff 输出格式 | side-by-side | side-by-side | ✅ | |
| Q5 | Diff 样式覆盖 | 有完整的暗色主题覆盖 | 有 diff2html-overrides.css | ✅ | |
| Q6 | 无差异提示 | 显示 "No differences" | 显示 "No differences found" | ✅ | |

---

## R. Raw JSON 弹窗

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| R1 | JSON 树视图 | 自实现 buildJsonTree（默认展开 3 层） | vue-json-pretty（默认全部展开） | ⚠️ | V1 默认展开 3 层更适合大 JSON，V3 全部展开可能在大 JSON 时卡顿 |
| R2 | 长字符串截断 | 超过 300 字符截断，显示 "(N chars - click to expand)" | 无截断 | ❌ | V1 的 Raw 树中长字符串有截断+展开按钮，V3 完整显示所有字符串 |
| R3 | 弹窗内 Copy 按钮 | 有，复制完整 JSON | 无 | ❌ | V1 Raw 弹窗头部有 Copy 按钮可复制 JSON |
| R4 | Esc 关闭 | 有 | 有 | ✅ | |
| R5 | 点击遮罩关闭 | 有 | 有 | ✅ | |
| R6 | 弹窗标题 | "{名称} - Raw JSON" | "Raw — {名称}" | ✅ | |

---

## S. Copy 功能

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| S1 | 复制反馈 | 按钮文本变为 "✓ Copied"（1 秒后恢复） | Toast 通知 "Copied!" | ✅ | 不同策略，V3 更统一 |
| S2 | 位置 | System/Text/Thinking/ToolUse/ToolResult 块的 header | 同（部分为悬浮显示） | ✅ | |
| S3 | 失败处理 | 无处理 | Toast "Copy failed" | ⭐ | V3 有失败反馈 |

---

## T. 键盘快捷键

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| T1 | ↑/↓ 导航 | 有 | 有 | ✅ | |
| T2 | j/k 导航 | 无 | 有 | ⭐ | V3 新增 vim 风格 |
| T3 | / 聚焦搜索 | 有（聚焦列表搜索框） | 有 | ✅ | |
| T4 | Esc 关闭弹窗 | 关闭 Raw Modal + Export Menu | 取消选择（clearSelection） | ⚠️ | V1 Esc 只关闭弹窗，V3 Esc 取消选中条目 |
| T5 | 输入框中禁用导航 | 检查 activeElement.tagName !== "INPUT" && !== "SELECT" | 同 | ✅ | |
| T6 | 导航后滚动到可见 | 是（scrollIntoView block:nearest） | 是 | ✅ | |
| T7 | 导航循环 | 到底后跳到顶部，到顶后跳到底部 | 同 | ✅ | |

---

## U. WebSocket 实时更新

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| U1 | WebSocket 连接 | 无 | 有 | 🆕 | |
| U2 | entry_added 事件 | 无 | 列表顶部插入新条目 | 🆕 | |
| U3 | entry_updated 事件 | 无 | 更新对应条目 + 如果是当前选中则刷新详情 | 🆕 | |
| U4 | stats_updated 事件 | 无 | 实时刷新统计栏 | 🆕 | |
| U5 | 自动重连 | 无 | 指数退避（1s→2s→4s→...→30s） | 🆕 | |
| U6 | 连接状态指示 | 无 | StatusDot + Live/Offline 文本 | 🆕 | |

---

## V. 样式和主题

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| V1 | 暗色主题 | GitHub Dark 风格 | 同 | ✅ | |
| V2 | 亮色主题 | 有 `@media (prefers-color-scheme: light)` | 有（variables.css 中） | ✅ | |
| V3 | 自定义滚动条 | 有（webkit + Firefox） | 有 | ✅ | |
| V4 | 过渡动画 | 无 | 有（transitions.css） | ⭐ | V3 新增 |
| V5 | 圆角 | 有 border-radius | 无（全部设为 0） | ✅ | 按用户要求去掉圆角 |
| V6 | 高亮闪烁动画 | @keyframes highlight-flash（边框颜色闪烁） | 无 | ❌ | V1 跳转目标的闪烁效果 |

---

## W. 错误处理

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| W1 | API 错误 | console.error | Toast 通知 | ⭐ | V3 有用户可见反馈 |
| W2 | 列表加载失败 | 在列表中显示错误信息 | Toast（列表不变） | ⚠️ | 各有利弊 |
| W3 | 条目加载失败 | console.error | Toast | ⭐ | |

---

## X. META 信息对比

| # | 功能 | V1 | V3 | 状态 | 说明 |
|---|------|----|----|------|------|
| X1 | Time | 有 | 无 | ❌ | V1 显示请求时间 |
| X2 | Model | 有 | 有 | ✅ | |
| X3 | Endpoint | 有（badge） | 有 | ✅ | |
| X4 | Stream | 有（badge） | 有 | ✅ | |
| X5 | Max Tokens | 有（如果设置） | 有 | ✅ | |
| X6 | Temperature | 有（如果设置） | 有 | ✅ | |
| X7 | Tools 数量 | 有（"N defined"） | 有 | ✅ | |
| X8 | Stop Reason | 有 | 有 | ✅ | |
| X9 | Status (OK/Failed) | 有（绿色/红色文本） | 有 | ✅ | |
| X10 | Input Tokens | 有 | 有 | ✅ | |
| X11 | Output Tokens | 有 | 有 | ✅ | |
| X12 | Cached Tokens | 有 | 有 | ✅ | |
| X13 | Duration | 有 | 有 | ✅ | |
| X14 | Truncation 详情 | 有（"N msgs removed (Z%)"） | 有 | ✅ | |
| X15 | Sanitization - Orphaned blocks | 有（"N blocks removed"） | 无 | ❌ | V1 显示孤立块清理信息 |
| X16 | Sanitization - System reminders | 有（"N tags filtered"） | 无 | ❌ | V1 显示系统提醒过滤信息 |
| X17 | Layout | 动态两行 Grid（列数 = ceil(items/2)） | 固定两列 Grid | ⚠️ | V1 布局更灵活 |
| X18 | Error 信息（response section） | RESPONSE section 内 Error 块 | 无独立 Error 块 | ❌ | V1 在 response 存在 error 时显示红色 Error 块 |

---

## 汇总统计

| 状态 | 数量 | 说明 |
|------|------|------|
| ✅ 正确 | 63 | V3 已有且与 V1 一致 |
| ⭐ 更好 | 17 | V3 比 V1 更好 |
| 🆕 新增 | 7 | V3 独有功能 |
| ❌ 缺失 | 27 | V1 有但 V3 没有 |
| ⚠️ 缺陷 | 19 | V3 有但存在问题 |

---

## 修复优先级（按影响排序）

### P0 — 核心体验缺失（严重影响可用性）

| # | 问题 | 关联编号 | 说明 |
|---|------|----------|------|
| 1 | **内容块缺少折叠/展开机制** | H2-H4, I4-I6, J6-J8, K2-K4, N全部 | V1 所有内容块都有 collapse-icon（点击折叠到一行摘要）+ body-collapsed（200px max-height）+ Expand 按钮。V3 内容块完全没有折叠能力。在大型会话中（数十个 tool_use/tool_result），V3 无法快速浏览内容 |
| 2 | **消息折叠时无摘要** | G4 | V1 折叠消息时显示摘要文本（前80字符或 "3 text, 2 tool_use"），V3 折叠后只有 header bar |
| 3 | **搜索后不滚动到匹配** | E3 | V1 搜索后自动滚动到第一个匹配项 |
| 4 | **首次加载不自动选中** | A5 | V1 首次加载自动选中最新条目并显示详情 |

### P1 — 功能缺失（影响特定场景）

| # | 问题 | 关联编号 |
|---|------|----------|
| 5 | tool_result 缺少 "← Jump to call" 反向链接 | J4 |
| 6 | 跳转目标无闪烁高亮动画 | I10, J5, V6 |
| 7 | 分页缺少页码按钮（只有 Prev/Next） | D14 |
| 8 | 列表项缺少 Duration 显示 | D11 |
| 9 | 搜索结果缺少 hit 计数 | D2 |
| 10 | Section 级别的 Raw 按钮 | E9 |
| 11 | Raw 弹窗缺少 Copy 按钮 | R3 |
| 12 | Raw 弹窗长字符串无截断 | R2 |
| 13 | 响应式布局缺失（窄屏断点） | A3 |
| 14 | META 缺少 Time 字段 | X1 |
| 15 | META 缺少 Sanitization 信息 | X15, X16 |
| 16 | Response section 缺少 Error 块 | X18 |

### P2 — 行为差异（影响一致性）

| # | 问题 | 关联编号 |
|---|------|----------|
| 17 | 会话选择器显示格式不直观 | B2 |
| 18 | Refresh 无视觉加载反馈 | B3 |
| 19 | Refresh 后不重新加载当前条目 | B4 |
| 20 | Export 用新标签而非当前窗口 | B6 |
| 21 | Esc 行为不同（应关闭弹窗而非清除选择） | T4, B10 |
| 22 | 截断分隔线位置不精确 | P1 |
| 23 | 角色过滤缺少 tool 选项 | E4 |
| 24 | 聚合模式空消息无提示 | O2 |
| 25 | tool_result 不显示 tool_use_id | J3 |
| 26 | 选中条目后详情不滚动到底部 | A4 |
| 27 | 列表空状态缺少副标题 | D15 |
| 28 | ImageBlock 缺少类型标签和 media_type | L2 |
| 29 | ImageBlock 缺少 Raw 按钮 | L3 |
| 30 | TextBlock 缺少类型标签 | H1 |
