# 06 — 路径别名重设计

## 当前别名体系

| 别名 | 定义位置 | 解析目标 | 用途 |
|------|----------|----------|------|
| `~/*` | 根 tsconfig + tsdown | `src/*`（后端） | 后端代码内部引用 |
| `@/*` | 前端 tsconfig + vite | `ui/history-v3/src/*` | 前端代码内部引用 |
| `~backend/*` | 前端 tsconfig + vite | `../../src/*` = `src/*`（后端） | 前端引用后端类型 |

## 合并后：保持不变

别名定义在各自的 tsconfig 和 vite.config.ts 中，互不干扰：

- **后端**用 `~/*`，定义在根 tsconfig → 不变
- **前端**用 `@/*`，定义在 `ui/history-v3/tsconfig.json` 和 vite.config.ts → 不变
- **前端引用后端**用 `~backend/*`，解析路径 `../../src/*` 仍然正确 → 不变

## 为什么不统一别名

`~/*` 和 `@/*` 分别服务于不同的 TypeScript 项目（不同的 tsconfig、不同的 lib、不同的 target）。
统一别名会导致：

1. tsconfig 需要同时声明两套路径，但只有一套在各自的上下文中有效
2. IDE 会在后端文件中提示 `@/*`（指向前端）的自动导入
3. 没有实际收益

## 可选改进：`~backend` → `~server`

如果觉得 `~backend` 命名不够清晰，可以重命名为 `~server/*`：

```json
// ui/history-v3/tsconfig.json
{
  "paths": {
    "@/*": ["src/*"],
    "~server/*": ["../../src/*"]
  }
}
```

```ts
// ui/history-v3/vite.config.ts
resolve: {
  alias: {
    '@': resolve(__dirname, 'src'),
    '~server': resolve(__dirname, '../../src'),
  },
},
```

影响文件：
- `ui/history-v3/src/types/index.ts`
- `ui/history-v3/src/types/ws.ts`

这是纯粹的命名改进，与合并无关，可以独立执行或跳过。
