# ui-v4 恢复 history URL 定位 + 前进后退能力

> 实施状态:**已落地**(commit `798bcc5`,2026-07-05)。本文档为归档计划,记录最终形态与对抗评审结论。

## Context

commit `b0d3144`(拆两全屏路由)把请求选中项从 URL 迁到易失的 zustand `list-store.selectedId`(仅 `HistoryList.selectRow` 写入),详情"返回列表"写死成 `navigate("/requests")`(push 非 pop)。丢失两个能力:

1. **定位** — 列表页 URL 不再表达/定位选中条目;刷新/分享无定位;返回列表不滚动到那一行。
2. **前进后退** — 返回按钮 push 污染回退栈:浏览器"后退"会重开详情、列表滚动丢失。

范围(用户确认):仅 URL 同步层,**不**恢复过滤工具栏;保留两全屏路由;URL 写入用 `replace`、不污染回退栈。

## 最终设计:URL 作为"被定位条目"的唯一真值

路由不变。核心:被定位条目 id 始终在 URL —— 详情 `/requests/:id`、列表 `/requests?at=<id>`。zustand 不再承载定位真值。

- **进入详情**(History/Live/Session 行):`navigate("/requests/"+id)`(push;浏览器后退天然回来源)。
- **返回列表**(按钮 + Escape):`navigate("/requests?at="+id, { replace })`,id 取自 `useParams`(非导航 state → 深链/刷新直达同样成立);replace 不污染回退栈。
- **列表定位**(`HistoryList` 读 `useSearchParams().at`):高亮该行 + edge-trigger 暂停 tail + `scrollIntoView` + `toc-flash` + **load-until-found**(不在游标窗口内则逐页拉取,上限 20 页)。
- `RequestRow` 行加 `data-entry-id` 供查找;`list-store` 删 `selectedId`、`select`→`locate`(纯 tail 暂停、幂等)。

## 对抗 subagent review 修正的真实缺陷

首版方案是 push+`navigate(-1)`+zustand-`selectedId`,两轮对抗评审推翻:

- 定位靠 zustand-`selectedId` 仅 History 入口写入、刷新即 null(恰是要恢复的分享/刷新场景)→ 改 URL `?at=` 承载,全入口通吃。
- `navigate(-1)` 把 Session/Live 来源送错目标 → 改 URL 恒定 `?at=` 返回列表。
- 深层条目无法定位 → load-until-found。
- **定位态下 resume 永久失效**:tail-pause effect 依赖 `tailOn`,resume 转 true 立刻被 effect 再暂停 → 改 edge-trigger(deps 仅 `[at]`)+ 显式 go-live(resume/flush)清 `?at`,保持 URL-as-truth。
- **详情 Escape 与 BlockJsonModal Escape 冲突**(一次按键既关弹窗又返回)→ 有 `[role=dialog]` 打开时让弹窗先吃 Esc。
- jsdom 无 `scrollIntoView` → `tests/setup.ts` 全局 stub。

## 验证

173 vitest + 143 bun(含 7 reducer)全绿;typecheck/lint 净(仅 peer 在飞错误)。覆盖:返回=?at(replace)/Escape/Escape-with-modal/定位滚动/load-until-found 终止/resume-while-located/reducer 幂等。运行时行为需用户启动 UI 实测(`build:ui`,非仅 typecheck)。

## 不在范围

过滤工具栏 + URL 过滤参数(用户明确排除);详情内 j/k 上一条/下一条兄弟导航(定位延伸增强)。
