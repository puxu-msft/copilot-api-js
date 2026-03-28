# 03 — 模块边界修正（P1）

## 问题 1：`ws/index.ts` 不是 barrel 却用 barrel 命名

### 现状

| 文件 | 内容 |
|------|------|
| `src/lib/ws/index.ts`（350 行，20 exports） | Topic-aware WebSocket 广播系统（业务逻辑） |
| `src/lib/ws-adapter.ts`（34 行） | Node/Bun 跨运行时 WebSocket adapter |

`ws/index.ts` 不是 re-export barrel——它直接拥有所有 20 个导出。在本项目中 `index.ts` 通常意味着 barrel（如 `history/index.ts`、`request/index.ts`）。

同时 `ws-adapter.ts` 作为平铺文件存在于 `lib/` 顶层，与 `ws/` 目录平级，命名容易混淆。

### 方案

```
src/lib/ws/
├── index.ts          # 新建 barrel
├── broadcast.ts      # 原 index.ts 内容
└── adapter.ts        # 原 ws-adapter.ts
```

---

## 问题 2：`auto-truncate/index.ts` 不是 barrel 却用 barrel 命名

### 现状

`src/lib/auto-truncate/index.ts`（425 行，20 exports）是共享的 auto-truncate 引擎（校准/持久化/预检查），不是 re-export。

### 方案

```
src/lib/auto-truncate/
├── index.ts          # 新建 barrel
└── engine.ts         # 原 index.ts 内容
```

---

## 问题 3：system-prompt 相关文件散落

### 现状

| 文件 | 职责 |
|------|------|
| `src/lib/system-prompt.ts`（182 行） | System prompt override 规则应用 |
| `src/lib/sanitize-system-reminder.ts`（304 行） | `<system-reminder>` 标签解析与提取 |

逻辑相关（都处理 system-level 文本注入/提取）但未分组。

### 方案

```
src/lib/system-prompt/
├── index.ts          # barrel
├── override.ts       # 原 system-prompt.ts
└── reminder.ts       # 原 sanitize-system-reminder.ts
```

---

## 问题 4：`shutdown.ts` 评估

403 行，14 exports。内容高度内聚（三阶段优雅关闭流程），不存在命名或职责混乱。
**不拆分。**

---

## 验证

- [ ] `ws/` 重组后所有 `import { ... } from "~/lib/ws"` 不变
- [ ] `auto-truncate/` 重命名后 import 不变
- [ ] `system-prompt/` 分组后 import 不变（消费者：`anthropic/sanitize.ts`、`openai/sanitize.ts`、`auto-truncate/index.ts`）
- [ ] `typecheck` + `test` 通过
