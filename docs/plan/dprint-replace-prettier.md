# 用 dprint 替换 Prettier,并强制多参数函数签名展开

> **实施状态：未实施（rejected）**
> **落地**：—
> **现状锚点**：项目仍用 @echristian/eslint-config + Prettier（CLAUDE.md 代码风格），printWidth 160
> **备注**：dprint 方案未采纳；无 dprint.json 配置、package.json 无 dprint 依赖、prettier.config.mjs 仍在

## Context（为什么做这个改动）

用户有两个**方向相反的逐构造格式化偏好**:

1. **长字符串 / 长错误消息 / 注释:不要折行**(保持单行,即使超出常规行宽)。
2. **多参数函数签名:一律展开**(每个参数独占一行),例如:
   ```ts
   export async function countMessageTokens(
     msg: MessageParam,
     model: Model,
     options?: { includeThinking?: boolean },
   ): Promise<number> {
   ```

**Prettier 本质上无法同时满足**:它只有 `printWidth` 一个全局旋钮,要么逼着折行(低),要么把多行塌缩成长行(高),没有逐构造控制——这是 Prettier 刻意的设计哲学。本会话早先把 `printWidth` 从 120 调到 160 并全库 `eslint --fix`,结果**把约 26 个多参数函数签名塌缩成了单行**(如 `countMessageTokens`),正是用户不接受的。

经实证调研(已下载 dprint TS schema 核实):
- **dprint** 的 `preferSingleLine` 默认 `false`(保留作者多行布局、从不强制塌缩)、永不折字符串字面量、`operatorPosition:nextLine`(三元/运算符行首,匹配现有约定)、`importDeclaration.forceMultiLine:"whenMultiple"` 可**完全复刻**自定义 `local/multiline-imports` 规则(≥2 specifier 强制多行)且不再需要 `//` 标记 hack。
- **但 dprint 无法强制展开函数参数**——`forceMultiLine` 仅支持 import/export specifier,`parameters.*` 只有 `preferHanging`/`preferSingleLine`(保留/塌缩,非强制)。

**最终架构**:dprint 做通用格式化(满足偏好 1 + 几乎所有布局),外加**一条 ESLint `@stylistic/function-paren-newline` 规则**强制展开多参数签名(满足偏好 2,补 dprint 唯一盲区)。两者职责不重叠:eslint 规则负责"是否展开"的强制,dprint 负责展开后的逐行布局并保留之(`preferSingleLine:false`)。

预期结果:长字符串单行 + 所有多参数签名逐行展开,均由工具强制,无需手改。

## 方案

### 1. 引入 dprint(替换 Prettier 的格式化职责)

- 新增 `dprint.json`(仓库根),plugins:
  - `typescript`(.ts/.js/.mjs/.cjs)
  - `json`(.json)
  - `markdown`(.md)
  - `markup_fmt`(g-plane,v0.27.3:`.vue`/html);`.vue` 的 `<style>` 块需配 `malva`(g-plane CSS 插件),`<script>` 委托给 typescript 插件
- TS 配置(其余全用默认):
  ```jsonc
  "typescript": {
    "lineWidth": 160,
    "semiColons": "asi",          // 无分号(匹配 semi:false)
    "quoteStyle": "preferDouble",  // 双引号,少转义时可单引(匹配 singleQuote:false)
    "importDeclaration.forceMultiLine": "whenMultiple",
    "exportDeclaration.forceMultiLine": "whenMultiple"
    // preferSingleLine:false / operatorPosition:nextLine / indentWidth:2 均为默认
  }
  ```
- `dprint.json` 的 `includes`/`excludes` 镜像 `eslint.config.js` 的 ignores:排除 `node_modules`、`**/dist/**`、`archive/**`、`refs/**`、`ui/**/dist/**`、`ui/types/**/*.d.ts`、磁盘 fixture JSON(`tests/fixtures/**`)等。

### 2. ESLint:卸下 Prettier 格式化,补一条参数展开规则

文件 `eslint.config.js`:
- 移除 `import prettierConfig from "./prettier.config.mjs"`,`config({ prettier: prettierConfig })` 改为 `config()`。
- **追加块禁用 prettier 规则**(echristian 工厂始终注入 `prettier/prettier`,必须显式关闭):
  ```js
  { rules: { "prettier/prettier": "off" } }
  ```
  这样保留 echristian 的所有非格式化规则(typescript-eslint strict、unicorn、perfectionist 等)。
- **移除** `local/multiline-imports` 规则注册与 `localPlugin` import(dprint `forceMultiLine:whenMultiple` 已接管;`//` 标记 hack 作废)。
- **新增**强制多参数签名展开的规则(dprint 盲区):
  ```js
  { rules: { "@stylistic/function-paren-newline": ["error", { minItems: 2 }] } }
  ```
  `@stylistic/eslint-plugin` 已作为 echristian 的传递依赖存在(^5.2.3),需在 config 中显式注册其 plugin 后启用该规则。`minItems:2` = ≥2 参数即强制换行展开(与 import 的 `whenMultiple` 一致)。**可调旋钮**:若觉 2 过激(每个双参函数变 4 行),改 `minItems:3`。

> 收敛性:eslint 规则强制"断开括号",dprint(`parameters.preferHanging:false` 默认 + `preferSingleLine:false`)把参数逐行排布并保留。二者对"多行形态"一致,仅"是否多行"由 eslint 强制、dprint 尊重。**实现期必须验证**:`dprint fmt` → `eslint --fix` → `dprint fmt` 达到稳定不互相反复改写。若不收敛 → 回退为 @stylistic-only 全量格式化(备选)。

### 3. 删除 Prettier 残留

- 删除 `prettier.config.mjs`(不再被引用)。
- `package.json`:移除 devDep `prettier-plugin-packagejson`(仅 Prettier 用;代价:package.json 键排序丢失,可接受);新增 devDep `dprint`。
- 删除 `scripts/eslint-rules/import-marker.js`(规则已被 dprint 接管)。

### 4. 工作流接线

- `package.json` scripts:新增 `"format": "dprint fmt"`、`"format:check": "dprint check"`;`lint`/`lint:all` 保持(eslint 现仅做 lint + 参数展开强制)。
- `lint-staged`:`"*.{ts,js,mjs,cjs,vue}"` 改为先 `dprint fmt` 再 `eslint --cache --fix`(暂存文件先格式化再 lint 修复)。
- `.vscode/settings.json`:设 `editor.defaultFormatter` 为 `dprint.dprint` 并对 `[typescript]`/`[vue]`/`[json]` 指定 dprint;保留 `source.fixAll.eslint`(参数展开靠它在保存时强制)。
- `CLAUDE.md:65`:把"使用 @echristian/eslint-config + Prettier,运行 eslint --fix 自动格式化"改为"格式化用 dprint(`dprint fmt`),eslint 负责 lint 与多参数签名展开强制;不再用 Prettier"。`//` import 标记约定的相关注释一并清理。

### 5. 一次性全库重排(达成"都展开" + dprint 接管)

顺序:
1. `dprint fmt`(全库):dprint 接管格式化;`forceMultiLine:whenMultiple` 自动展开所有多 specifier import 并可顺带去掉多余 `//` 标记行(若 dprint 不自动去除,加一个一次性脚本删 import 块内独占的 `//` 行)。
2. `eslint --cache --fix .`:`@stylistic/function-paren-newline` **强制展开全库所有 ≥2 参数函数签名**(包含早先被塌缩的 26 个)。
3. `dprint fmt`(再跑一次):确保收敛、最终态由 dprint 定型。

这是一次预期内的全库大 diff(切换格式化器固有),纯布局、无语义改动。

## 关键文件

- 新增:`dprint.json`
- 改:`eslint.config.js`(去 prettier 接线 + 关 `prettier/prettier` + 去 `local/multiline-imports` + 加 `@stylistic/function-paren-newline`)
- 改:`package.json`(devDeps:-`prettier-plugin-packagejson` +`dprint`;scripts +`format`/`format:check`;`lint-staged`)
- 改:`.vscode/settings.json`、`CLAUDE.md`
- 删:`prettier.config.mjs`、`scripts/eslint-rules/import-marker.js`
- 全库:dprint + eslint --fix 重排

## 验证

1. **环境可行性(第一步,先做)**:`bun x dprint --version`(或装为 devDep 后 `node_modules/.bin/dprint --version`)在本机 Volta-无-Node 环境能跑通;dprint 是独立二进制,预期不受 Volta 影响。不通则先解决安装方式。
2. **收敛性**:在少量样本文件上跑 `dprint fmt` → `eslint --fix` → `dprint fmt`,确认无反复改写(idempotent)。不收敛则回退 @stylistic-only。
3. **偏好达成**:抽查 `countMessageTokens` 等签名 → 多行逐参;构造一条 >160 列长错误消息 → 保持单行不折。
4. **回归**:`bun run typecheck`(后端 0 错误)、`bun x --bun vue-tsc -p ui/tsconfig.json`、后端全 offline `bun test .unit.test .it.test .http.test`(应仍 1938 pass / 0 fail)、`bun test ./ui/tests/`(187 pass)、`bun x --bun vitest run --config ui/vitest.config.ts`——纯格式化不应改变任何测试/类型结果。
5. **lint 干净**:`eslint --cache .` 全绿(0 violations,新参数规则下亦然)。

## 风险 / 备选

- **dprint × eslint 冲突**:唯一重叠点是函数括号布局。若验证 2 不收敛,改为 **@stylistic-only**(禁用 dprint,用 @stylistic 全套规则做格式化 + 同一条 function-paren-newline),工作流零改动但格式化覆盖面需多规则拼装。
- **.vue 嵌入语言**:markup_fmt 需搭配 typescript(`<script>`)+ malva(`<style>`)插件;实现期验证 `.vue` 三段都被正确格式化。
- **package.json 键排序丢失**(prettier-plugin-packagejson 移除后):影响小,如在意可保留该 prettier 插件单独跑或用 dprint 的 json 插件 + 手动约定。
