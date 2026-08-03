# 新会话 kick-off 提示词

复制下面整段作为新会话的第一条消息。

---

接手 copilot-api-js 上一轮未完的工作：**上游传输 Provider 化 + Rust/napi-rs 实现**。

**唯一入口是 [HANDOVER.md](./HANDOVER.md)，请先完整读它**，再按它 §0 的指引读相关材料。

⚠️ **那份 HANDOVER 头部标着「草稿·未评审」——它还没过评审闭环，不要当成已核验的档案。** 让它过评审并改掉状态行，是 §3 的 T1。

## 硬性工作方式

- **共享 worktree，有并发 peer 会话**：工作区里所有未提交改动与未追踪文件**都是别人的**。**一律显式 pathspec 提交（`git commit -F <msgfile> -- <精确路径>`），绝不 `git add -A` / `-am`。** 细节见 HANDOVER §6。
- **代码改动才进隔离 worktree；文档改动留主树。** 本轮至今**零生产代码改动**。
- **构建 Rust 前必须 `export RUSTUP_HOME=/home/xp/.local/rustup`**，否则会看到 `no installed toolchains` 这个假阴性。理由与实测见 HANDOVER §2 事实 7。
- **绝不 kill 4141 端口的服务器**（用户主实例）。
- **动手实现前先过 T1（评审闭环）与 T3（§11 取证轮）**——spec 状态行明写「未达可进入计划阶段」。

## 待办与优先级

见 HANDOVER §3，**建议顺序 T1 → T2 → T4 → T3 → T5 → T6**：

| | 批准状态 |
|---|---|
| T1 过评审闭环、改掉「草稿·未评审」 | 已裁决（skill 强制） |
| T2 建 `docs/` 权威入口 | 已裁决（skill 强制） |
| T3 §11 七条取证轮 | 已裁决 |
| T4 §11/§12 按 v3 更新 | 我的建议 |
| T5 backlog 记「进程内 libcurl 暂缓非否决」 | 我的建议 |
| T6 实现期必须闭合的实测项 | 已裁决（spec §3.3） |

**用户已裁决、不要重开的四项**：① provider 契约协议无关、h1/h2 平等；② 选型 = Rust + napi-rs（hyper/reqwest）；③ 分发 = per-platform 可选包发布产物；④ 默认 = `auto` 探测（有产物用 Rust，没有则**大声**回落 `node:http2`）。

## 这一轮反复踩的坑

完整版见 HANDOVER §4，每条都绑了复发点：

1. **夹具不忠实而未验夹具** —— 造 h2 RST 必须 `stream.destroy(err)`，`stream.close(code)` 不放 RST 帧。三方同错过一次。
2. **否定性 / 完备性结论把搜索范围当全集** —— 「没有任何 X」在两小时内错了两次（h2 耦合点、Rust 工具链）。
3. **把两个不同的写入路径当成同一条** —— 误判了一个不存在的崩溃风险。
4. **把「我还没想清楚」包装成「留给实现期」** —— spec v1 因此被评审判回。
5. **subagent 连续被后端 API 错误掐断** —— 派长报告必须给 `REPORT_FILE` 绝对路径 + 要求逐条落盘；恢复一律 `SendMessage`，**绝不重派、绝不换模型**。

## 测试与门禁（**核验于 2026-08-03 / `0a2e3bdf`；接手第一件事是复验而非采信**）

- 本轮**零生产代码改动**，故 `bun run test:backend` / `typecheck` / `lint` **未跑**。
- `exp/napi-http-spike/run-all.sh` → exit 0；需先设 `RUSTUP_HOME`。
- **不要顺手修**工作区里 peer 的未提交改动（tool-name-sanitize 那条线等）。

完整门禁现状与理由见 HANDOVER §6。
