# ui-v4 Plan 04 — 请求内搜索（可控 JSON 渲染器）Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development。先读 `ui-v4/docs/HANDOFF.md`（硬性约定）+ `DESIGN.md §6`。

**Goal:** 给详情面板加**请求内搜索**——在已打开的当前请求里查找/高亮文本，作用于**底层数据模型而非 DOM**，跨段命中计数、n/N 导航、regex/大小写/整词。配套把 JSON 段换成**可控渲染器**（@uiw/react-json-view 无法被外部搜索驱动）。

**Architecture（spec §6）：** 搜索是 client-state（Zustand search-store：query/选项/matches/currentIndex）。搜索作用于 DetailPanel 各段的**源数据**（对话 blocks 文本、stages payload、headers kv、sse 帧、meta）——每段贡献一个 `Searchable`（提供 `collectMatches(query, opts)` + `scrollToMatch(matchId)`）。sub-rail 每段显示命中数 badge；跳转（n/N）自动切到该段（懒加载段先挂载）+ 滚动+高亮当前匹配。聚焦详情时 **Ctrl/Cmd-F** 唤起，Esc 关。JSON（wire/forwarded/tool-input）改用**可控渲染器**：CodeMirror 6（json lang + 可控 search highlight）或自建虚拟化树——实现期评测后定（DESIGN.md §11 待定）。

**Tech Stack:** 续前 + CodeMirror 6（`@codemirror/state`/`view`/`lang-json`，bun 原生纯 JS，无 node-gyp）或自建树。

**⚠ 高风险**（spec §6 标注）：这是**全新工程非移植**（旧 UI 只是 DOM 高亮）；虚拟化列表 + scrollToIndex 与匹配索引映射、懒加载段先加载再等布局稳定再滚、JSON 折叠子树内匹配定位——均是难点。**先在主线做技术尖刺**（spike）验证 CodeMirror 可控 search 接口 + 跨段 match 模型，再 subagent 执行。

## 后端契约
无后端改动（纯前端）。数据来自已有 `useEntry(id)` 的 `HistoryEntry`。

## 文件结构
```
ui-v4/src/
├── stores/search-store.ts          # query/options/matches/currentIndex(Zustand)
├── lib/search/
│   ├── types.ts                    # Match{ id, segment, preview }、SearchOptions、Searchable
│   └── text-match.ts               # 纯逻辑:在字符串/字符串数组里找 matches(regex/case/word)
├── components/detail/
│   ├── DetailFindBar.tsx           # find 条:输入+n/N+计数+Aa/.*/整词+✕
│   ├── search-context.tsx          # 段注册 Searchable 的 context(provide/consume)
│   └── json/ControllableJson.tsx   # 可控 JSON 渲染器(CodeMirror/自建,支持外部 match 高亮+滚动)
└── hooks/useFindShortcut.ts        # Ctrl/Cmd-F 唤起/Esc 关
tests/
├── text-match.bun.test.ts          # 纯匹配逻辑(regex/case/word/计数)
├── search-store.bun.test.ts        # reducer(setQuery/next/prev/clear)
└── DetailFindBar.vitest.test.tsx
```

## Tasks（bite-sized，执行时按 HANDOFF 约定）

- [ ] **Task 1 — text-match 纯逻辑（TDD）**：`collectTextMatches(text|string[], query, {regex,caseSensitive,wholeWord}) → Match[]`。穷尽测试：普通/regex/大小写/整词/多匹配/空 query。
- [ ] **Task 2 — search-store（TDD reducer）**：state `{ query, options, matches: Match[], currentIndex }`；actions setQuery/setOptions/setMatches/next/prev(环绕)/clear。纯 reducer + Zustand。
- [ ] **Task 3 — Searchable 协议 + search-context**：context 让各段注册 `{ id, collectMatches(query,opts), scrollToMatch(id) }`；DetailPanel 聚合所有段 matches → search-store；切段时按 currentIndex 的 segment 自动激活。
- [ ] **Task 4 — 技术尖刺 + ControllableJson（主线 spike 后 TDD）**：评测 CodeMirror 6 vs 自建树对「外部喂 match → 高亮 + scrollIntoView」的可控性，选定后实现 `ControllableJson`（替换 Stages/Headers/Convo 的 tool-input JSON `<pre>`）。**先 spike，记录选型理由进 DESIGN.md §11。**
- [ ] **Task 5 — DetailFindBar + 各段接 Searchable**：Convo（对话文本）/Stages（payload）/Headers（kv）/SSE/Meta 各实现 collectMatches + scrollToMatch；FindBar 显示总计数 + 当前 n/N + 选项。sub-rail 每段命中数 badge（Plan 03 的 DetailSubRail 加 badge slot）。
- [ ] **Task 6 — useFindShortcut + DetailPanel 接线**：聚焦详情 Ctrl/Cmd-F 开 FindBar、Esc 关；n/N 跳转自动展开/加载目标段 + scrollToMatch + 当前匹配高亮加深。
- [ ] **Task 7 — 手动验证 + 回填**。

## 验收
- typecheck/test/build 绿；零 binding.gyp（CodeMirror 纯 JS）。
- 纯逻辑测试覆盖 regex/case/word/计数；折叠/未加载段匹配照常计数；n/N 跳转跨段定位。
- 手动：Ctrl-F 搜当前请求，跨 Convo/Stages/Headers/SSE 计数+定位，JSON 段内匹配可定位。

## 交给后续/暂缓
- 跨「当前 session 全部请求」搜索 → 不做（用全局搜索 + sessionId 过滤覆盖，spec §6）。
- 二进制/图片段匹配 → 跳过（无文本）。
