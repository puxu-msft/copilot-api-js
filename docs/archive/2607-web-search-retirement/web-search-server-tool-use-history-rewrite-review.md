> **⚠️ 已归档（2607 web_search 双跳退役）**：web_search 双跳整套已于 2026-07-13 退役删除。本文档是该已删特性的历史 plan/review 快照，其「现状锚点」（如 `web-search-handler.ts`、config 键 `server_tool_rewrite`）指向的产物**均已不存在**。仅作历史参考。退役决策见 ADR [../../decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md](../../decisions/2026-07-13-server-tool-positioning-and-web-search-retirement.md)。

# 对抗性 Plan Review — server_tool_use 历史改写

> **类型**：对抗性审查报告 —— 非独立 plan，实施状态见父 plan [web-search-server-tool-use-history-rewrite.md](web-search-server-tool-use-history-rewrite.md)。

见对话输出。核心结论：**FAIL — 计划存在两个会导致新 400 的架构缺陷（结果块角色错位 + immutable-thinking 早退留洞的边界），以及若干遗漏（hot-reload 守卫登记、outboundRequest 诊断声明在搜索路径不成立、字符串化复用未指定）。需修正后才能实施。**
