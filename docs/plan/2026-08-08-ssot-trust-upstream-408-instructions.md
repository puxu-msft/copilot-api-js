# SSOT、主线信任与 GHC 408 指令修订计划

> **状态：已完成（2026-08-08；原 reviewer 与未卷入第三方均 0 blocker / 0 major；落地 commits `9db0748c`、`b2480b49`、`7af39d60`，本状态回填见后续 commit）**

**目标：** 修正文档单一事实源的错误绝对化表述，固化共享主线收尾的 trust-first 口径，并把 GHC 请求体读取 408 的实证诊断方法写入既有 upstream transport skill。

**方案：** 以全局 `41-doc-mgmt.md` 作为“文档权威来源与复述”通用规则；项目 `CLAUDE.md` 与 `session-closeout` 按自身语境完整复述并引用该规则。保留类型定义、明细→汇总、进度写入权转移等真正的单写入源。`debugging-ghc-api-upstream-transport` 继续拥有 GHC 上游 HTTP 传输诊断，不拆新 skill；产品重试契约引用 `docs/request-pipeline.md`。

## 批次 1：全局规则

- [x] 修订 `~/.claude/rules/00-user/41-doc-mgmt.md`，定义“一个权威来源 + 允许语境完整复述 + 必须引用 + 冲突回权威来源裁决”。
- [x] 扩展 `~/.claude/rules/00-user/01-core-principles.md` 的 trust-first：已合并且已有验收证据时，shared HEAD 单纯前进不触发重复验证；真实失败、相关路径冲突、合并异常、用户明确要求才升级调查。

## 批次 2：项目复述与记忆

- [x] 修订 `CLAUDE.md` 的“同一事实只写一处”。
- [x] 修订 `.claude/skills/session-closeout/SKILL.md` 中 HANDOVER/KICKOFF、docs 入口和进度所有权的边界：允许完整复述；易变状态必须带权威引用与基线，活跃写入权仍唯一。
- [x] 更新错误复述该语义的 memory；新增本轮用户裁决的 feedback memory 与索引。

## 批次 3：GHC 408 调试 skill

- [x] 扩充 description 的触发词。
- [x] 增加 History body 字节、framing header、本地 h2c 逐字节探针、证据边界和窄 retry matcher。
- [x] 引用 `docs/request-pipeline.md` 作为产品行为权威来源。

## 验收

- [x] RED：修改前独立 agent 场景测试暴露旧指令缺口。
- [x] 全文通读每个修改文件。
- [x] 跨规则／skill／memory 检索旧绝对化措辞并逐条 disposition。
- [x] GREEN：同一 agent 场景在新指令下给出目标行为。
- [x] 独立 reviewer 对当前状态命题逐条给证据，达到 0 blocker / 0 major（原 reviewer Round 4 + 408 reviewer Round 2 + 未卷入第三方终审）。
- [x] 指令文本与计划按语义批次提交；不推送（`9db0748c`、`b2480b49`、`7af39d60`）。

## 不拆 skill 的当前裁决

`debugging-ghc-api-upstream-transport` 的触发对象仍是同一个边界：本项目到 GHC 的上游 HTTP 传输。408 请求体读取超时依赖同一 `upstreamFetch`／`http2Fetch`／History／错误分类链，拆分会让一次事故在两个 skill 间往返。若未来加入流式请求上传、请求压缩或 HTTP/3，形成独立实现与独立探针面，再提议拆出 `debugging-ghc-request-upload`。
