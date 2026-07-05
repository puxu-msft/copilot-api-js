# 兼容层技术正确性审查报告

> **类型**：对抗性审查报告 —— 非独立 plan，实施状态见父 plan [config-rename-backcompat-layer.md](config-rename-backcompat-layer.md)。

审查对象：cheeky-painting-star.md 的向后兼容迁移层。所有结论基于实际代码而非推理。

## 断言逐一裁决

### 断言1 — 多条 renameLeaf 累积到同一 timeouts section：成立

`deepMergeMissingOnly`（validation.ts:81-95）递归正确。三条迁移按顺序处理：
- 第1条 `{timeouts:{stream_idle:v}}`：`out` 无 `timeouts`，`existing===undefined`，整体 clone 进 `out.timeouts`（:87-88）。
- 第2条 `{timeouts:{response_header:v}}`：`out.timeouts` 已是 object，递归进入（:85-86），`response_header` 不存在 → 写入。
- 第3条 `stale_request_max_age` 同理累积。
三字段不互相覆盖。**成立。**

### 断言2 — renameSection + 内部字段重映射：部分成立，但计划缺失 translate 实现细节（见 HIGH-1）

(a) 未列入 fieldRenames 的字段（normalize_call_ids 等）：**取决于 renameSection.translate 的实现**。计划只描述了意图（plan:50, 56），未给实现。正确实现必须遍历整个旧 section 对象、对每个 key 应用 fieldRenames（命中则改名、未命中则原样保留），否则会丢字段。这是实现约束，不是自动成立的。

(b) 若只搬 section 名不重映射：新 section 下残留的 `upstream_websocket` 会被 `ConfigSchema.strict()`（schema.ts:259 的 `.strict()`）当未知键 → 进入 `unrecognized_keys` issue → 被 `cleanInvalidPaths`（validation.ts:117-123）剥离丢失。计划 plan:50 已正确识别此风险。**风险真实存在，计划意识到了。**

(c) translate 返回新 section 经 deepMergeMissingOnly：新 key `openai_responses` 在 `out` 不存在 → 整体 clone（:87-88），不与残留冲突。但**前提是旧 `openai-responses` 已被 delete**（validation.ts:68 删的是 `dep.key`）——见 CRITICAL-1，renameSection 的 `key`/`parentPath` 必须正确指向 `openai-responses`。

### 断言3 — 迁移作用于 user 与 bundled 两层：成立但有 HIGH 风险（见 HIGH-2）

`validateConfig` 在 `loadRawConfigFile`（config.ts:183，user）和 `loadBundledDefaultConfig`（config.ts:156，bundled）两处都调用。迁移分别独立作用于各自，各自产出**新键形状**。之后 `mergeConfigs`（config.ts:216-218）用 `mergeBySchema` 按新 schema 形状合并。

- 若 bundled 用新键、user 用旧键：user 迁移后也变成新键 → 两边都是 `openai_responses` / `timeouts.*` → mergeBySchema 按字段正确合并。**成立。**
- **但前提**：renameSection 产出的新 section 必须与 schema 的 `openai_responses` 同名同形。一旦 helper 实现把 `client_ws_keep_open` 拼错或漏改，user 迁移产物与 bundled 不同形，merge 会错位。这是实现正确性依赖，非结构缺陷。

### 断言4 — recovery_timeout ×60 transform 的 null 边界：成立，但默认值换算有 CRITICAL 漏改（见 CRITICAL-2）

transform `(v)=> typeof v==="number" ? v*60 : v`：
- `recovery_timeout: 0` → `0`（0=禁用语义保留）。OK。
- `recovery_timeout: null`（PUT delete 语义）：`typeof null === "object"` → 走 else 分支返回 `v`（即 null）。translate 返回 `{rate_limiter:{recovery_interval:null}}`。`null` 是 object，deepMergeMissingOnly 会把它当 object 递归（:84）——但 `null && typeof null==="object"` 中 `null &&` 短路为 falsy，故走 :91 的 else，`existing===undefined` 时 `target[key]=null`。之后 `nullableNonnegativeInt()`（schema.ts:36-44）接受 null → transform 成 undefined。**null 删除路径不被破坏。成立。**
- 注意：`validateConfig` 走的是 config.yaml 加载路径，不是 PUT 路径；PUT 路径（validateConfigInput）**不经过迁移**（validation.ts:221 直接 safeParse），所以 PUT 旧键 `recovery_timeout` 会直接报 unknown key——这是预期（PUT 只接受新形状），但见 MEDIUM-1 前端兼容。

### 断言5 — 新旧键同时存在，新键 wins：成立

`extractAndTranslateDeprecated` 先 `delete parentObj[dep.key]`（删旧键，:68）再 `deepMergeMissingOnly`（missing-only，:74）。若用户已写 `timeouts.response_header`，则 `out.timeouts.response_header` 已存在，deepMergeMissingOnly 在 :91 判断 `existing !== undefined` 不覆盖。**新键 wins。成立。**

### 断言6 — renameLeaf dotted-path 拆解 + parentPath/key 计算：成立（前提是 helper 正确实现，见 CRITICAL-1）

现有 `navigate`（validation.ts:97-104）逐段下钻；`extractAndTranslateDeprecated` 用 `dep.parentPath.split(".")`（:61）。对照 DEPRECATED_KEYS（schema.ts:469-496）：
- 顶层旧键 `fetch_timeout`：parentPath=`""`、key=`fetch_timeout`。validation.ts:61 `parentPath===""` → `parent=out`。translate 返回嵌套 `{timeouts:{response_header:v}}`。**正确。**
- 嵌套旧键 `rate_limiter.recovery_timeout`：parentPath=`"rate_limiter"`、key=`recovery_timeout`。navigate 下钻到 `out.rate_limiter`，delete `recovery_timeout`。**正确。**
helper 必须从 `oldPath` 反推这三字段（见 CRITICAL-1）。

### 断言7 — 两个完整性守卫：计划部分覆盖，有遗漏（见 HIGH-3、HIGH-4）

config-hot-reload 守卫：`enumerateLeafKeys`（test:629-650）从 JSON Schema 递归产出嵌套叶。timeouts 成 section 后会产出 `timeouts.stream_idle`/`timeouts.response_header`/`timeouts.stale_request_max_age` 三个新叶；`auto_truncate.compress_tool_results` 新叶；`openai_responses.*` 改名叶。计划 plan:146 提到改 configKey，但**未列全所有受影响条目**（见 HIGH-3）。

config-schema-json-export 守卫（test:39-52）：硬编码断言数组含 `"openai-responses"`、`"stream_idle_timeout"`、`"fetch_timeout"` 顶层键——schema 改后这些**顶层键消失**，断言会 fail。计划 plan:150 提到改这个文件但**遗漏了 :47/48 顶层 timeout 键的移除 + :46 openai-responses 改名**的精确性（见 HIGH-4）。

---

## CRITICAL

### CRITICAL-1：renameSection 的 path/parentPath/key 三字段语义与 extractAndTranslateDeprecated 的删除机制存在结构冲突
**证据**：validation.ts:60-75 的删除逻辑写死为「删除 parentObj 里的单个 `dep.key`」。对 section 改名，`ConfigMigration` 必须 `parentPath=""`、`key="openai-responses"`，这样 :68 才能 `delete out["openai-responses"]`。
**问题**：但 `renameLeaf("anthropic.efforts_overrides", ...)` 产出 `parentPath="anthropic"`、`key="efforts_overrides"`，而 renameSection 产出 `parentPath=""`、`key="openai-responses"`——两个 helper 生成的字段语义必须都精确匹配现有消费逻辑。计划 plan:47 说「保留 path/parentPath/key/message/translate 字段」，但**没有给出 helper 如何从 `oldPath` 字符串反推这三字段的算法**。`renameLeaf` 的反推是：`parts=oldPath.split(".")`、`key=parts.at(-1)`、`parentPath=parts.slice(0,-1).join(".")`。这个算法**必须在 compat.ts 实现且正确**，否则 navigate 找不到父节点、delete 失败、旧键残留 → strict() 报 unknown key → 旧值丢失。
**为何 CRITICAL**：这是整个迁移层能否工作的根基。若 helper 反推算法写错（例如对 section 用了 leaf 反推、parentPath 算成 `"openai"`），所有迁移静默失效，旧 config 用户的设置丢失且无明显报错（被当 unknown key 剥离）。
**修正建议**：在 compat.ts 中 `renameLeaf` 显式实现 `const parts=oldPath.split("."); const key=parts.at(-1)!; const parentPath=parts.slice(0,-1).join(".")`。`renameSection` 因 section 必在顶层，硬编码 `parentPath=""`、`key=oldKey`。新增专门单测断言每条生成的 ConfigMigration 的 `{path,parentPath,key}` 三元组精确值（不只测端到端行为），作为反推算法的回归锚点。

### CRITICAL-2：start.ts 的 rate_limiter 单位换算只改了一半会导致 recovery 时间错 60 倍
**证据**：
- start.ts:284 `const rlRecoveryTimeout = rlConfig?.recovery_timeout ?? 10`
- start.ts:294 `recoveryTimeoutMinutes: rlRecoveryTimeout`
- adaptive-rate-limiter.ts:317 `const timeout = this.config.recoveryTimeoutMinutes * 60 * 1000`（分钟→ms）
**问题**：迁移层把 config 的 `recovery_timeout`（分钟）×60 转成 `recovery_interval`（秒）。但 start.ts:284 读的是 `config.rate_limiter`——**这是 mergeConfigs 之后的 effective config，已经过 validateConfig 迁移**（config.ts:319 `loadRawConfigFile`→validateConfig，再 mergeConfigs）。所以 start.ts 读到的将是**新键 `recovery_interval`（秒值，已×60）**，而非旧键 `recovery_timeout`。若 start.ts:284 仍读 `recovery_timeout`，读到 undefined → 回退默认 10（被当分钟）。即使按 plan:106 改成读 `recovery_interval ?? 600`，但 :294 仍传给 `recoveryTimeoutMinutes` 参数、:317 仍 `×60×1000`——**秒值被当分钟再×60，实际恢复时间放大 60 倍**。
**为何 CRITICAL**：计划 plan:106 已识别「AdaptiveRateLimiter 构造处的单位换算需改」，但这是 stateful singleton（DESIGN 列为「修改需重启」、且 hot-reload 守卫里 `rate_limiter.recovery_timeout` 是 EXEMPT，test:578）。两处必须**原子地同时改**：(1) start.ts 读 `recovery_interval`（秒）；(2) adaptive-rate-limiter.ts 的字段名 `recoveryTimeoutMinutes`→`recoveryIntervalSeconds`、:317 改 `*1000`、:319 日志文案、:32/:43/:598 默认值 10→600。漏改任一处都使恢复时间错 60 倍且无类型错误兜底（都是 number）。
**修正建议**：把 adaptive-rate-limiter.ts 的内部字段连同 :43 DEFAULT_CONFIG（10→600）、:317 换算（`*60*1000`→`*1000`）、:319 日志（minutes→seconds）一并改名为 seconds 语义。EXEMPT 条目 plan:146 提到改 :578 的 configKey 字符串，但要确认 `defaultStateValue`/语义注释也同步（该项是 EXEMPT 无 R1/R2/R3，但 compat 端到端实测必须覆盖 ×60）。subagent review 必须实测 `recovery_timeout:10`（旧）与 `recovery_interval:600`（新）产出**相同的 600000ms timeout**。

---

## HIGH

### HIGH-1：renameSection 的 translate 实现未在计划中定义，存在「fieldRenames 命中后未命中字段被丢弃」的隐患
**证据**：plan:55-57 只给了 `renameSection("openai-responses","openai_responses",{fieldRenames:{...}})` 的调用，未给 translate 实现。
**问题**：正确 translate 必须 `Object.entries(oldSectionObj)` 遍历，对每个 `[k,v]`：`newKey = fieldRenames[k] ?? k`，输出 `{[newSectionKey]:{[newKey]:v}}`。若实现成「只搬 fieldRenames 里列的字段」，则 `normalize_call_ids`/`fix_stream_ids`/`max_ws_frame_bytes`/`max_client_ws_connections`/`max_upstream_ws_connections`（5 个未改名字段，plan:24）会全部丢失。
**为何 HIGH**：静默丢失 5 个 Responses 配置项，用户无感知。
**修正建议**：renameSection.translate 必须保留所有未列字段；新增单测：旧 section 含全部 8 个字段，断言迁移后新 section 含全部 8 个（2 改名 + 6 原名，注意 plan:24 实际是 5 个未改名 + normalize_call_ids，共 6 个原名）。

### HIGH-2：bundled config.yaml 若仍用旧键，会与 user 新键在 merge 后双重残留
**证据**：config.ts:156 bundled 也走 validateConfig 迁移。plan:167 要求把 bundled `config.yaml`/`config.example.yaml` 改成新键。
**问题**：迁移是「旧→新」单向。若执行时**漏改 bundled config.yaml**（仍写 `openai-responses:`/`fetch_timeout:`），bundled 经迁移变新键、user 也变新键，merge 正常——**这条其实安全**。真正风险反向：若有人误以为「迁移层在，bundled 不用改」，bundled 每次加载都触发一次 deprecation warn（warnDeprecatedKeyOnce 是 per-process，bundled 先加载会先占用 warn 名额，user 的同键 warn 被吞）。
**为何 HIGH**：bundled 不改不会功能错误，但会污染 warn-once 语义——用户改自己的旧键时看不到迁移提示（warn 已被 bundled 触发消耗）。违反「warn 一次」的用户预期。
**修正建议**：bundled config.yaml 必须用新键（plan:167 已列），并在 compat 端到端测试中加一条：用旧键 bundled + 旧键 user，断言 user 的 deprecation warn 仍出现（或确认 warn 语义可接受 bundled 消耗）。更稳妥：迁移仅对 user 文件 warn，bundled 静默迁移（需在 validateConfig 加 `{ warn?: boolean }` 参数区分两个调用点）。

### HIGH-3：config-hot-reload FIELDS 改 configKey 不是「字符串替换」而是「条目重定位」，计划低估了改动
**证据**：FIELDS 现有 `fetch_timeout`（:170-174，stateKey=fetchTimeout）、`stream_idle_timeout`（:177）、`stale_request_max_age`（:184）三条**顶层** FieldSpec。
**问题**：迁移后这三项的 configKey 要变 `timeouts.response_header`/`timeouts.stream_idle`/`timeouts.stale_request_max_age`。`yamlForField`（test:134-165）按 split(".") 生成嵌套 YAML——改 configKey 即可让它生成 `timeouts:\n  response_header: 30`。**但** stateKey 不变（fetchTimeout 等运行时字段名 plan:97 保持）。所以是「改 configKey 字符串、保留 stateKey」。计划 plan:146 说「configKey 改新路径，stateKey 不变」**方向正确**。同理 `compress_tool_results_before_truncate`（:198）→`auto_truncate.compress_tool_results`。`openai-responses.*` 7 条（:500-549）→`openai_responses.*`。`anthropic.efforts_overrides`（:382）→`anthropic.effort_overrides`。`anthropic.thinking_block_sanitize_check`（:274）→`anthropic.thinking_block_sanitize`。
**为何 HIGH**：enumerateLeafKeys 完整性守卫（test:710-715）会拿新 schema 的叶集合与 FIELDS+EXEMPT 比对。**漏改任一条 configKey 即 orphan → 守卫 fail**。这是好事（天然探测器），但计划必须确保 FIELDS 全部 8 改名项都改对，否则 test:backend 直接红。
**修正建议**：逐条核对 FIELDS：3 个 timeout（:170/177/184）、compress（:198）、7 个 openai-responses（:500-549）、efforts（:382）、sanitize_check（:274）共 13 条 configKey 改名。EXEMPT 的 `rate_limiter.recovery_timeout`（:578）改 `recovery_interval`。建议改完先单独跑 `bun test config-hot-reload` 的 Coverage completeness 用例验证 orphans=[]。

### HIGH-4：config-schema-json-export 守卫的硬编码顶层键断言会因 timeouts 升级为 section 而 fail，计划描述不精确
**证据**：test:39-49 断言数组含 `"stream_idle_timeout"`、`"fetch_timeout"` 为**顶层 properties 必须存在**；plan:36-52 的 `known top-level keys` 用例 + plan:54-64 `removed deprecated keys` 用例。
**问题**：schema 改后 `stream_idle_timeout`/`fetch_timeout` 顶层键删除、`timeouts` 顶层键新增、`openai-responses`→`openai_responses`。test:47/48 断言这两键存在 → **fail**。test:39-49 数组里的 `"openai-responses"`（:44）也要改 `openai_responses`。计划 plan:150 说「移除 stream_idle_timeout/fetch_timeout、加 timeouts、openai-responses→openai_responses」**方向对**，但要注意：这是 `expect(props[key]).toBeDefined()` 循环，删掉旧键断言、加 `timeouts` 断言即可；可补 `expect(props.fetch_timeout).toBeUndefined()` 反向断言确认顶层已无旧键。
**为何 HIGH**：漏改即 test 红。属于必须改对的连带项。
**修正建议**：test:39-49 数组移除 `stream_idle_timeout`/`fetch_timeout`、`openai-responses`→`openai_responses`、加 `timeouts`；可选加反向断言。

---

## MEDIUM

### MEDIUM-1：PUT /api/config/yaml 路径不经过迁移，旧前端/旧脚本 PUT 旧键会被硬拒
**证据**：validateConfigInput（validation.ts:213-226）直接 `ConfigSchema.safeParse(input)`，**无 extractAndTranslateDeprecated**。route.ts:208 写 `openai-responses`、:192-194 写顶层 timeout、:196 写 compress。
**问题**：迁移层只覆盖 config.yaml **加载**路径，不覆盖 PUT **写入**路径。这是设计上合理的（PUT 是「编辑器写最新形状」），但意味着：若有外部脚本/旧版前端仍 PUT `fetch_timeout`/`openai-responses`，会得到 400 unknown key（validateConfigInput 走 reject 语义）。plan 第五节改了前端 types/composable/page 同步新形状，**所以官方前端 OK**；但 route.ts:190-227 的 `mergeConfigIntoDocument` 仍写旧 key 路径（:192-194/196/208）必须同步改，否则前端发新键、route 按旧键写盘 → 写出旧键 → 下次加载又触发迁移（可工作但绕路）。
**为何 MEDIUM**：不致命（迁移层兜底），但违反原则8「修根因不绕路」。route.ts 必须与 schema 同步。
**修正建议**：route.ts:192-194 三条顶层 setScalar 改为 `setNestedScalarContainer(doc,["timeouts"],body.timeouts)`（plan:101 已列）；:196 compress 改 `["auto_truncate","compress_tool_results"]`（plan:102 已列，注意当前 route 无 auto_truncate 写逻辑需新增容器）；:208 `["openai-responses"]`→`["openai_responses"]`（plan:103 已列）。计划覆盖了，确认执行即可。

### MEDIUM-2：renameLeaf 的 transform 仅声明 recovery 一处，但 transform 在 deepMergeMissingOnly 前执行，需确认 translate 内部顺序
**证据**：现有 translate 签名 `(legacy)=>Record|undefined`（schema.ts:466），validation.ts:72 `const patch = dep.translate(legacyValue)`。
**问题**：renameLeaf 的 translate 必须：(1) 对 legacyValue 应用 transform；(2) 把结果包成嵌套 patch。顺序是先 transform 再嵌套。若 transform 返回 undefined（如非 number 的 recovery），patch 仍需包含该键还是跳过？现有逻辑 :73 `if(!patch) continue`——若 transform 把值变 undefined 又包进 patch `{rate_limiter:{recovery_interval:undefined}}`，deepMergeMissingOnly :91 `existing===undefined` 会写入 `undefined`，schema 再 transform 成 undefined，无害但冗余。
**为何 MEDIUM**：边界行为正确但不优雅。recovery transform 对非 number 返回原值（plan:60 `: v`），保留原始值让 schema 报类型错——这是合理的（坏类型走正常 invalid 路径）。
**修正建议**：明确 renameLeaf transform 语义：transform 抛错或返回原值时，让下游 schema 校验接管。当前 plan:60 的 `typeof v==="number" ? v*60 : v` 对 null/string 透传原值，由 nullableNonnegativeInt 处理，正确。无需改，但建议单测覆盖 `recovery_timeout: "abc"`（坏值）确认走 invalid-strip 而非崩溃。

### MEDIUM-3：warnDeprecatedKeyOnce 对 8 条新迁移的 path 唯一性依赖
**证据**：validation.ts:35-39 用 `dep.path` 作 warn-once key（Set）。
**问题**：8 条新迁移的 path 必须全局唯一且与 3 条历史迁移不撞。renameSection 的 path 应是 `"openai-responses"`，renameLeaf 的 path 是各自旧 dotted-path。都唯一。**无冲突**，但 helper 生成 path 时若用 newPath 而非 oldPath 作 path，会与「迁移提示应指向旧键」语义不符。
**修正建议**：helper 的 `path` 字段用 oldPath（与现有 DEPRECATED_KEYS 一致，schema.ts:471 path 是旧键）。message 文案提示「旧键 X 已改名为 Y」。

---

## 成立的断言汇总
- 断言1（timeouts 累积）：完全成立。
- 断言5（新键 wins）：完全成立。
- 断言6（dotted 拆解）：成立，依赖 helper 正确实现（见 CRITICAL-1）。
- 断言4（×60 transform 的 null 边界）：transform 本身对 null 安全成立；但单位换算落地有 CRITICAL-2。
- 断言2/3/7：机制成立，但有实现约束与连带改动（HIGH-1~4）。

## 最高优先级行动项
1. **CRITICAL-2**：adaptive-rate-limiter.ts 单位换算两处 + start.ts 读取，必须原子改对，subagent 实测 600000ms 等价。
2. **CRITICAL-1**：compat.ts helper 的 path/parentPath/key 反推算法，加三元组精确单测。
3. **HIGH-1**：renameSection.translate 必须保留未改名字段，加全字段保留单测。
4. **HIGH-3/HIGH-4**：两个守卫的 configKey/断言数组逐条改对（共 13+ 条），改完先单跑守卫用例。
