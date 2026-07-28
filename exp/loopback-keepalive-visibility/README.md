# 探针：loopback 连接上 TCP keepalive 计时器是否可见

`probe-loopback-baseline.mjs` 回答一个基线问题：在 **127.0.0.1 回环连接**上调用 `socket.setKeepAlive(true, 8000)` 后，`ss -tno` 是否真的显示 `timer:(keepalive,...)`。

为什么需要它：排查上游保活时，`ss` 是我们判「keepalive 到底有没有生效」的内核侧 oracle（见 skill `empirical-verification` / `debugging-ghc-api-upstream-transport`）。但如果连回环的正样本都看不到 keepalive 计时器，那么"真实上游连接上看不到"就没有裁决力——**先证工具能测到，再用它下结论**。

```bash
bun exp/loopback-keepalive-visibility/probe-loopback-baseline.mjs   # 自带监听端口 37775
```

2026-07-27 从仓库根目录归档至此（原为根目录散落脚本）。
