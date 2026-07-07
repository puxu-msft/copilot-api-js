# 修复 ui-v4 "upstream vs forwarded" SSE diff 满屏假差异

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：`ui-v4/src/lib/diff/block-diff.ts`（canonicalRaw/coalesceDeltas）
> **备注**：JSON 键序规范化 + 同块 delta 合并全落地

## Context

ui-v4 请求详情的 Response 段有一块 "upstream vs forwarded" diff，本意是凸显被过滤/合成/改写的帧（如 thinking-signature shim、server-tool filter）。但实测 req_1782730931656_6：upstream 38 帧、forwarded 36 帧（去 3 个 keepalive ping），累积文本逐字相同（663 字符），diff 却把 31 帧标成 modified/removed/added —— 信号被噪声淹没，没法用。

根因两条（都对全部 Anthropic 流式生效，非个例）：
1. **JSON 键序不同**：upstream `raw` 是 `{"delta":…,"index":1,"type":…}`，forwarded 是 `{"type":…,"index":1,"delta":…}`。语义相同、字节不同 → `frameKey = type\0raw` 判不等。
2. **text_delta 重新分块**：上游 29 个 delta、转发 27 个，切分边界不同 → 逐帧 raw 对不齐，LCS 对齐崩成整片改。

## 改动锚点

均在 [ui-v4/src/lib/diff/block-diff.ts](ui-v4/src/lib/diff/block-diff.ts) 的 L4 SSE 段（`frameKey` / `diffSseFrames`），渲染方 `SseFrameDiff.tsx` 与 `FrameList` 不动。

1. **规范化 JSON 键序**：新增本地 `canonicalRaw(raw)`——`JSON.parse` 后按键排序 stable-stringify，parse 失败（ping/keepalive 等非 JSON）原样返回。`frameKey` 改用 canonical；`modified` 行 `rawDiff` 也用 canonical 两侧比对（消除键序噪声，差异只剩真正改写）。

2. **合并同块 delta**：diff 前把连续 `content_block_delta` 中 `index` 相同的帧 coalesce 成一个合成帧，拼接内部 text/partial_json，`offsetMs` 取首帧。两端重分块后累积文本一致 → 同 key → 判 `same`。仅作用于 diff 输入，原始帧列表（FrameList）仍逐帧显示。

3 个前导 ping 仍正确显示为 `added`（forwarded 合成），属真实差异，保留。

## 测试

[ui-v4/tests/block-diff.bun.test.ts](ui-v4/tests/block-diff.bun.test.ts) `diffSseFrames` describe 现有 3 例须仍绿，补：
- 键序打乱但语义相同 → `same`（0 modified）
- 两端 text_delta 切分不同但拼接相同 → 合并后 `same`
- 上游缺一帧/forwarded 多合成帧 → 仍 removed/added
- 真改写（signature A→B）→ 仍 modified、rawDiff 非空

## 验证

`bun run typecheck` + `bun run test:bun`（block-diff 测试）+ `eslint --fix` 改动文件。可对 req_1782730931656_6 复核 diff 应近全 `same` + 3 个 ping added。
