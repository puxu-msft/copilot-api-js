# 03 — 模块边界修正（P1）

## 问题 1：`ws/index.ts` 与 `ws-adapter.ts` 命名混淆

### 现状

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/lib/ws/index.ts` | 350 | Topic-aware WebSocket 广播系统（history/status/rate-limiter 事件推送） |
| `src/lib/ws-adapter.ts` | 34 | Node/Bun 跨运行时 WebSocket upgrade adapter |

两者都涉及 WebSocket，但职责完全不同。`ws/index.ts` 是一个完整的业务模块（不是 barrel），而 `ws-adapter.ts` 是底层 runtime 适配器。

### 方案

将 `ws-adapter.ts` 移入 `ws/` 目录：

```
src/lib/ws/
├── index.ts          # barrel re-export
├── broadcast.ts      # 原 index.ts 的内容（topic broadcast）
└── adapter.ts        # 原 ws-adapter.ts（runtime adapter）
```

同时将 `ws/index.ts`（350 行，20 exports）重命名为 `ws/broadcast.ts`，
新建 `ws/index.ts` 作为真正的 barrel。

**影响范围**：
- `import { ... } from "~/lib/ws"` — 通过 barrel 保持不变
- `import { ... } from "~/lib/ws-adapter"` — 改为 `"~/lib/ws/adapter"` 或通过 barrel

---

## 问题 2：`auto-truncate/index.ts` 不是 barrel

### 现状

`src/lib/auto-truncate/index.ts`（425 行，20 exports）是共享的 auto-truncate 引擎（校准/持久化/预检查），
不是 re-export barrel。但在本项目中，`index.ts` 通常意味着 barrel（如 `history/index.ts`、`request/index.ts`）。

### 方案

重命名为具有描述性的名称：

```
src/lib/auto-truncate/
├── index.ts          # 新建 barrel: export * from "./engine"
└── engine.ts         # 原 index.ts 的内容（校准/持久化/预检查逻辑）
```

**影响范围**：
- `import { ... } from "~/lib/auto-truncate"` — 通过 barrel 保持不变

---

## 问题 3：system-prompt 相关文件散落

### 现状

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/lib/system-prompt.ts` | 182 | System prompt override 规则应用 |
| `src/lib/sanitize-system-reminder.ts` | 304 | `<system-reminder>` 标签解析与提取 |

两者逻辑相关（都处理 system-level 文本）但分别作为 `lib/` 下的顶层文件存在，没有分组。

### 方案

合并到 `src/lib/system-prompt/` 目录：

```
src/lib/system-prompt/
├── index.ts          # barrel
├── override.ts       # 原 system-prompt.ts
└── reminder.ts       # 原 sanitize-system-reminder.ts
```

**影响范围**：
- `import { ... } from "~/lib/system-prompt"` — 通过 barrel 保持不变
- `import { ... } from "~/lib/sanitize-system-reminder"` — 改为从 barrel 或 `"~/lib/system-prompt/reminder"` 导入

---

## 问题 4：`shutdown.ts` 是否需要拆分

### 现状

`src/lib/shutdown.ts`（403 行，14 exports，11 imports）。处理优雅关闭的三个阶段：drain → abort → force kill。

### 判断

403 行刚好在推荐范围（200-400）的上限。内容高度内聚（三阶段关闭是一个不可分割的流程），强行拆分会增加跨文件耦合。

**建议**：不拆分。如果后续增长超过 500 行再考虑。

---

## 验证

- [ ] `ws/` 目录重组后 `typecheck` 通过
- [ ] `auto-truncate/` 重命名后 `typecheck` 通过
- [ ] `system-prompt/` 分组后 `typecheck` 通过
- [ ] 所有受影响的 import 路径更新完毕（grep 验证）
