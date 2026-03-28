# 03 — TypeScript 配置

## 当前状态

两个完全独立的 tsconfig：

**根 `tsconfig.json`**（后端）：
- `target: ESNext`, `lib: ["ESNext"]`
- `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`
- `paths: { "~/*": ["./src/*"] }`
- `include: ["src/**/*.ts", "tests/**/*.ts"]`

**`ui/history-v3/tsconfig.json`**（前端）：
- `target: ES2020`, `lib: ["ES2022", "DOM", "DOM.Iterable"]`
- `jsx: "preserve"`（Vue 需要）
- `paths: { "@/*": ["src/*"], "~backend/*": ["../../src/*"] }`
- `include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]`

## 方案：保持两个 tsconfig，不引入 project references

前后端的 TypeScript 配置差异是本质性的（不同 target、不同 lib、不同 module 语义），
不适合合并成一个 tsconfig。Project references 增加复杂度但收益有限（前端 noEmit，不需要构建顺序）。

### 保持不变

- 根 `tsconfig.json` — 后端，不做改动
- `ui/history-v3/tsconfig.json` — 前端，主体不变

### 推荐改动：将前端测试纳入 `include`

当前前端测试 (`ui/history-v3/tests/*.test.ts`) 不在前端 tsconfig 的 `include` 中。
合并后 `typecheck:ui` 成为根级正式脚本，覆盖范围缺失就不再只是 IDE 体验问题，而是静态检查缺口。

将 `ui/history-v3/tsconfig.json` 的 `include` 扩展为：

```json
{
  "include": [
    "src/**/*.ts", "src/**/*.tsx", "src/**/*.vue",
    "tests/**/*.ts"
  ]
}
```

这样 `vue-tsc --noEmit --project ui/history-v3/tsconfig.json`、IDE、CI 都能覆盖到前端测试文件。

### `~backend` 路径别名

合并后依赖在根 `node_modules`，`~backend/*` 别名仍然指向 `../../src/*`，
这是相对于 `ui/history-v3/tsconfig.json` 的路径，仍然有效。

## 为什么不用 tsconfig project references

1. 前端 `noEmit: true`，不产出 `.d.ts`，后端也不 import 前端代码
2. 只有前端 → 后端的单向类型引用（通过 `~backend` 别名）
3. Project references 需要 `composite: true` + `declaration: true`，引入不必要的 `.d.ts` 产物
4. Vite 和 tsdown 各自有独立的类型解析，不依赖 tsc 构建顺序

## 结论

不需要合并 tsconfig，也不需要引入 project references。
建议将前端测试目录纳入前端 tsconfig 的 `include`，以补齐类型检查覆盖面。
