# reusePort overlap 内核分发 PoC 结论

- Bun 版本: 1.3.14（`bun --version`）
- 端口: 41990（非 4141，符合 CLAUDE.md protect-user-main-server）

## 方法论警告已验证（R1 评审 BLOCKER-1）

**必须用 fresh-connection 探针（每次新建裸 TCP + `Connection: close`），绝不能用默认 `fetch()`。**

用 `probe-keepalive-control.ts`（默认 `fetch()`，让 undici/Bun 连接池按默认策略工作）跑同样流程，
在「关旧 listener 后」阶段**复现了假阳性**：

```
[keep-alive 对照] 关旧 listener 后分布: [ 'OLD' ] count: 50
[keep-alive 对照] 复现假阳性（PASS 的含义）：含非 NEW = 50
```

即：旧进程的 listen socket 已关闭、内核已 100% 只往新进程分发新连接，但用 `fetch()`
的客户端因为连接池复用了此前建立的、指向旧进程的连接，仍然 100% 收到 `OLD`——
如果只用这种探针，会误判「关旧 listener 后仍有旧进程响应」→ 误判内核分发不确定 / 机制不可靠。

这证实了 R1 评审的警告：**用 keep-alive 客户端探测 reusePort 分发正确性会产生假阳性 FAIL**，
必须用 fresh-connection 探针排除连接池变量。

## fresh-connection 探针结论（`probe.ts`，5 次连跑）

| 次数 | overlap 期分布（20 次，两服务器都存活） | 关旧 listener 后分布（50 次） | 结果 |
|---|---|---|---|
| 1 | OLD:12 NEW:8 | 全 NEW | PASS |
| 2 | OLD:12 NEW:8 | 全 NEW | PASS |
| 3 | OLD:14 NEW:6 | 全 NEW | PASS |
| 4 | OLD:13 NEW:7 | 全 NEW | PASS |
| 5 | OLD:12 NEW:8 | 全 NEW | PASS |

**5/5 连跑 100% 确定性通过。**

- overlap 期（两个进程都持有 reusePort 监听）：内核在 OLD/NEW 之间做负载均衡，分布不均匀但两者皆有响应
  （这是预期行为，符合「重叠窗口内两进程都能接收新连接」的设计前提）。
- 旧进程 `stop(false)`（只停 accept、不强杀已建连接）后，所有新建 fresh TCP 连接 **100% 落新进程**，
  无 RST、无连接失败、无非 NEW 响应（跨 5 次独立运行、每次 50 个 fresh 连接、共 250 个样本零例外）。

## 结论

**关旧 listener（`stop(false)`）后，新连接 100% 落新进程（5/5 连跑确定，250/250 样本零例外）。**

支撑 `docs/lifecycle.md`「优雅重启」节所依赖的内核层前提：
「新旧进程重叠期同绑一端口（reusePort）→ 旧进程关闭 listen fd 后，内核只把新连接投给新进程，
已建立的旧连接在旧进程侧继续存活直到自然结束（drain）」。

**Phase 0 Task 0 门槛：PASS，可继续后续 Phase。**

## 文件

- `probe.ts` —— fresh-connection 探针（唯一权威判据）。
- `probe-keepalive-control.ts` —— keep-alive 对照探针（证明为何不能用 `fetch()`，Step 1.5 交叉验证）。
