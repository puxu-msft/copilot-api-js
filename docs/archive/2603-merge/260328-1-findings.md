# 260328-1 Findings

## 范围

本次检查对象：

- `docs/merge/05-eslint.md`
- `docs/merge/09-p2-cold-start-504.md`

目标：

- 判断两份文档中“下一步计划”是否完善
- 判断其前提是否正确
- 判断是否存在会误导后续实施的错误假设

## 结论

- `05-eslint.md` 的方向基本正确，但计划不够严谨，缺少对当前 shared config 实际能力边界的明确判断
- `09-p2-cold-start-504.md` 的问题更大：复现路径有错误，且把两个不同问题混在了一起

## Findings

### 1. `09-p2-cold-start-504.md` 的缓存清理路径错误

严重性：`高`

文档当前写法：

```bash
rm -rf ui/history-v3/node_modules/.vite
```

这个路径在合并后已不再是正确的 Vite 预构建缓存位置。

当前仓库里，相关浏览器请求实际命中的是根目录缓存：

- `node_modules/.vite/deps/vue-json-pretty.js?...`

也就是说，文档中的“最小复现路径”和“验证标准”目前基于错误路径，后续执行者即使照文档做，也可能根本没有清掉真正的缓存。

建议修正为：

```bash
rm -rf node_modules/.vite
```

如果需要更谨慎，可以在文档中补充说明：

- 合并前子项目路径可能存在 `ui/history-v3/node_modules/.vite`
- 合并后应以根目录 `node_modules/.vite` 为准

### 2. `09-p2-cold-start-504.md` 将两个不同问题错误地绑定为同一根因

严重性：`高`

文档当前把以下现象放在同一问题中统一处理：

- `vue-json-pretty.js` 的 `504 Outdated Optimize Dep`
- Vue Router 警告：`No match found for location with path "/v/"`

但这两个问题不应默认视为同一根因。

从当前代码看，`/v/` 路径本身不是合法路由：

- 路由表只定义了：
  - `/v/history`
  - `/v/logs`
  - `/v/dashboard`
  - `/v/models`
  - `/v/usage`
- 并没有 `/v/`

同时，导航切换逻辑里确实存在可能生成 `/v/` 的代码：

```ts
const switchPath = computed(() => {
  const p = route.path
  if (p.startsWith("/v/")) return p.replace("/v/", "/")
  return "/v" + p
})
```

当 `route.path === "/"` 时，上述逻辑会生成：

```ts
"/v" + "/" === "/v/"
```

因此，`/v/` 的 Vue Router 警告更像是独立的路由构造问题，而不是 `optimizeDeps` 缓存问题的附带表现。

建议将 `09` 至少拆成两部分：

1. `504 Outdated Optimize Dep`
2. `/v/` 路由告警

否则后续修 `optimizeDeps.include` 后，仍可能保留 `/v/` 警告，导致文档结论与实际结果不一致。

### 3. `09-p2-cold-start-504.md` 对 `vue-json-pretty` 的导入方式描述不准确

严重性：`中`

文档当前说法：

- `vue-json-pretty` 通过 `ToolUseBlock.vue` 和 `RawJsonModal.vue` 动态 import
- 因此 Vite 的自动预构建发现可能延迟

这个描述与当前代码不一致。

实际代码中，`vue-json-pretty` 在以下文件中是静态导入：

- `ui/history-v3/src/components/message/ToolUseBlock.vue`
- `ui/history-v3/src/components/ui/RawJsonModal.vue`

即：

```ts
import VueJsonPretty from 'vue-json-pretty'
import 'vue-json-pretty/lib/styles.css'
```

因此，当前更准确的表述应当是：

- `vue-json-pretty` 不在应用初始首页/首屏入口图中
- 而是在特定路由和组件树中首次被加载
- 所以它在 dev server 冷启动时可能并未在最早阶段完成 optimize-deps

也就是说，结论“考虑将其加入 `optimizeDeps.include`”可以保留，但前面的技术解释应改成与当前代码一致的版本。

### 4. `05-eslint.md` 对 shared config 的假设过于乐观

严重性：`中`

文档当前写法把下面两条视为并列分支：

1. 如果 `@echristian/eslint-config` 支持 Vue SFC，直接移除 `ui/**` ignore
2. 如果不支持，再引入 `eslint-plugin-vue` + Vue parser

但从当前实际依赖看，这个前提过于乐观。

当前本地安装的 `@echristian/eslint-config@0.0.54` 中：

- 没有 `eslint-plugin-vue`
- 没有 `vue-eslint-parser`
- 没有任何明显的 Vue / `.vue` 处理依赖

因此，更合理的计划应当是：

- 默认按“shared config 不支持 Vue SFC”来制定实施方案
- “直接移除 ignore 即可”不应再作为默认主路径，而只能作为待证伪假设

建议文档将“待验证事项”改成：

1. 先用最小试运行证明当前配置是否能解析 `.vue`
2. 如果失败，则立即进入 Vue parser/plugin 方案
3. 不要把“直接移除 ignore”写成对等主路径

### 5. `05-eslint.md` 的实施计划没有明确绑定当前根配置的测试覆盖差异

严重性：`低`

当前根 `eslint.config.js` 只对以下测试目录做了测试规则放宽：

```js
files: ["tests/**/*.ts"]
```

而 `05-eslint.md` 虽然在示例里写了：

```js
files: ["tests/**/*.ts", "ui/**/tests/**/*.ts"]
```

但文档没有明确指出这一步为什么是必需的，也没有明确说明“如果只移除 `ui/**` ignore，而不补前端测试规则，前端测试文件会直接落入默认严格规则”。

这个问题不算方向错误，但计划表达不够完整。

建议在文档里明确写出：

- 前端源码规则
- 前端测试规则
- 两者必须分别处理，不能只去掉 ignore

## 对下一步计划的总体判断

### `05-eslint.md`

判断：`方向正确，但需要收紧前提并补足实施说明`

可以保留的部分：

- 作为独立 PR 处理
- 不阻塞主迁移
- 需要先评估 lint 报告量

需要修正的部分：

- 不要再把“直接移除 ignore”作为默认主路径
- 明确当前 shared config 对 Vue SFC 没有现成证据支持
- 明确前端测试规则需要单独覆盖

### `09-p2-cold-start-504.md`

判断：`需要修订后才能作为可靠执行文档`

可以保留的部分：

- 问题优先级定为 P2 是合理的
- `optimizeDeps.include` 作为候选修复方向是合理的

需要修正的部分：

- 修复缓存路径
- 将 `/v/` 路由告警从本问题中拆出
- 用与当前代码一致的方式重写 `vue-json-pretty` 的导入说明
- 重新定义复现步骤和验证标准

## 建议动作

建议按以下顺序处理：

1. 修订 `docs/merge/09-p2-cold-start-504.md`
   - 改正缓存路径
   - 拆分路由警告问题
   - 收紧根因描述
2. 修订 `docs/merge/05-eslint.md`
   - 将 Vue parser/plugin 方案前置为默认实施路径
   - 明确前端测试规则覆盖要求
3. 修订后再按文档推进实现，避免基于错误前提执行
