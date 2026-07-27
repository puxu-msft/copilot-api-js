# 探针：我方 server-tool 过滤会不会在客户端腿上制造相邻 thinking

`measure-filter-damage.py` 扫描 History，统计「经过我方 server-tool 过滤的响应」里有多少条**因此**产生了相邻 thinking 块 / 以 thinking 收尾——即我方改写是否会自己制造上游 400 的布局违规（约束定义见 [docs/spec/2026-07-26-thinking-terminal-block-layout.md](../../docs/spec/2026-07-26-thinking-terminal-block-layout.md)）。

属 server-tool provenance 调查（[docs/plan/2026-07-27-handover-server-tool-provenance.md](../../docs/plan/2026-07-27-handover-server-tool-provenance.md)）的取证工具。

```bash
# 需要先准备待扫描的 session id 列表
python3 exp/server-tool-filter-damage/measure-filter-damage.py   # 读 /tmp/incident-session-ids.json，打 4141 只读 History API
```

2026-07-27 从仓库根目录归档至此（原为根目录散落脚本，路径变更请注意）。
