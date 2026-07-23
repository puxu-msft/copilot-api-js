# Spec：`anthropic.model_capabilities` 支持 glob 与 `!` 剔除

- 状态：✅ landed（合入 master 合并提交 `77e07413`，2026-07-23）。已折入两轮异模型 subagent 审 + 一轮合并态审；实现见 [docs/plan/2026-07-23-model-capabilities-glob-and-negation.md](../plan/2026-07-23-model-capabilities-glob-and-negation.md) 与 `src/lib/models/model-pattern.ts`。
- 日期：2026-07-23
- 归属：`docs/spec/`（配置契约 + 匹配语义）。相关：[docs/API.md](../API.md) 端点无关，[docs/anthropic-compat.md](../anthropic-compat.md) 需同步能力匹配说明。

## 1. 目标与动机

`anthropic.model_capabilities` 下 5 个 list 型能力允许表（`context_editing` / `interleaved_thinking` / `adaptive_thinking` / `extended_cache_ttl` / `memory`）当前只支持「family 前缀」逐条枚举：一个裸 token `p` 命中当归一后模型名 `=== p` 或 `startsWith(p + "-")`。要覆盖「一整代 Claude 除某个变体外全开」这类意图，运维只能逐个列全名，既啰嗦又会随新模型上线漏项。

本 spec 引入两项表达力，且**不破坏**现有 family 前缀语义与内置默认表：

1. **glob**：模式里可用 `*`（任意串）`?`（任意单字符），如 `claude-*`、`claude-opus-4-*`。
2. **`!` 剔除**：`!` 前缀的模式表示从结果集中减去，如 `!claude-haiku-*`。

同时把 glob **键**顺带开放给 `tool_search_overrides`（map，键→`true`/`false`）以保持 `model_capabilities` 内部一致。

## 2. 语义决策（已与用户对齐）

### 2.1 剔除语义 = 列表自洽 + 剔除永远胜（order-independent）

一条能力列表内，`!` 前缀条目为 **negative**，其余为 **positive**。模型 `id`（及其 `family`，见 §2.3）具备该能力当且仅当：

```
命中 ≥1 个 positive  且  命中 0 个 negative
```

- **顺序无关**：negative 永远优先于 positive，书写顺序不影响结果。
- **列表自洽、无隐藏基底**：negative 只从**本列表的 positive**里减，**不**耦合内置默认表。想要「全 claude 除 haiku」必须自带 positive：

  ```yaml
  context_editing:
    - "claude-*"
    - "!claude-haiku-*"
  ```

- **只有 negative（无 positive）→ 空集**：无 positive 即无能力。这是自洽语义的直接推论，非 bug。
- **空列表 → 空集**（现状即如此）。

被否方案（记录理由，`record-not-adopted`）：

- *在内置默认表上做增删*（negative 从 bundled defaults 减、positive 往上加）：更省事，但配置行为随内置默认表版本漂移而变，语义隐晦、可预测性差。用户明确否掉。
- *gitignore 式 last-match-wins*：顺序敏感、心智负担大，与「剔除」朴素直觉不符。用户否掉。

### 2.2 glob 与 family 前缀共存（按是否含元字符分派）

单条模式的匹配规则**按是否含 glob 元字符（`*` 或 `?`）分派**：

- **不含元字符 → family 前缀语义（逐字节保持现状）**：`norm(x) === norm(p)` 或 `norm(x).startsWith(norm(p) + "-")`。这条是**向后兼容承重点**——内置默认表 `claude-sonnet-4` 靠 dash 边界覆盖 `claude-sonnet-4-5` 却不误伤 `claude-sonnet-40`。
- **含元字符 → glob**：`norm(p)` 里的 `*`→`.*`、`?`→`.`，其余正则元字符转义，编译成**锚定**（`^…$`）大小写不敏感正则，对 `norm(x)` 整体匹配。

  - dash 边界由运维用 glob 显式控制：`claude-opus-4-*` 编译为 `^claude-opus-4-.*$`（天然带 dash），而 `claude-opus-4*` 会匹配 `claude-opus-40`。二者语义不同、由运维取舍。

归一化 `normalizeForMatching`（lowercase + `.`→`-`，见 [model-name.ts](../../src/lib/models/model-name.ts)）对 candidate 与 pattern 双侧都先跑，故 `claude-opus-4.6` 与 `claude-opus-4-6` 等价。

> 分层边界（reviewer 建议，承重）：底层 `globToRegExp` 保持**纯编译**——不内置 `normalizeForMatching`。归一化只发生在 model-specific 包装器（`matchesModelPattern` / `matchesModelKey`）里：先 `normalizeForMatching(pattern)` 再交给纯 `globToRegExp`。这样 header 侧复用同一 `globToRegExp` 时仍只做 trim + 大小写不敏感、**不**把 model 名的 `.`→`-` 语义泄进 header-name 匹配。

### 2.3 family 参与匹配（保持现状）

现有 `matchModelCapability(id, list, family?)` 会同时拿 `id` 与 `resolvedModel.capabilities.family` 两个候选去撞列表（镜像 GHC 的 `matches(id) || matches(family)`）。新语义保持：positive/negative 的命中判定都对 `[norm(id), norm(family)]` 两个候选做「任一命中即命中」。

> 边界确认：negative 对 candidate 集的命中也用「任一候选命中即视为被剔除」。即只要 `id` **或** `family` 命中某个 `!` 项，该模型即被剔除——与 positive 对称。

## 3. `tool_search_overrides`（map 键支持 glob，剔除仍用值 `false`）

`tool_search_overrides` 是 `Record<模型键, boolean>`，经 `findMostSpecific`（[per-model-config.ts:33](../../src/lib/anthropic/per-model-config.ts#L33)）做「最具体键胜 + `"*"` 兜底」匹配。它的匹配器 `findMostSpecific`/`collectAllMatching` **被大量 per-model map 共享**，改动前先看全 blast radius。

### 3.1 完整 blast radius（改 `findMostSpecific`/`collectAllMatching` 会影响的全部 state map）

| 共享函数 | 消费的 state map | 消费者 file:line | 聚合语义 |
|---|---|---|---|
| `findMostSpecific`（最具体键胜 + `"*"` 兜底） | `toolSearchOverrides` | [features.ts:176](../../src/lib/anthropic/features.ts#L176) | whitelist（单一来源） |
| ↑ | `effortsOverrides` | [request-preparation.ts:824](../../src/lib/anthropic/request-preparation.ts#L824) | whitelist |
| ↑ | `streamIdleTimeoutOverrides` | [timeout-resolver.ts:26](../../src/lib/models/timeout-resolver.ts#L26) | whitelist |
| ↑ | `responseHeaderTimeoutOverrides` | [timeout-resolver.ts:41](../../src/lib/models/timeout-resolver.ts#L41) | whitelist |
| `collectAllMatching`（每个命中键都收，含 `"*"`） | `stripToolFields` | [message-tools.ts:434](../../src/lib/anthropic/message-tools.ts#L434) | strip-list（加性） |
| ↑ | `keepToolFields` | [message-tools.ts:439](../../src/lib/anthropic/message-tools.ts#L439) | strip-list |
| ↑ | `rejectBodyFields` | [request-preparation.ts:291](../../src/lib/anthropic/request-preparation.ts#L291) | strip-list |
| ↑ | `stripCacheControlSubfields` | [request-preparation.ts:308](../../src/lib/anthropic/request-preparation.ts#L308) | strip-list |
| ↑ | `stripBetaHeaders` | [request-preparation.ts:324](../../src/lib/anthropic/request-preparation.ts#L324) | strip-list |
| ↑ | `stripPartnerFeatures` | [request-preparation.ts:338](../../src/lib/anthropic/request-preparation.ts#L338) | strip-list |

**不在 blast radius**：`system_reject_models`（[system-reject-mode.ts:20](../../src/lib/anthropic/system-reject-mode.ts#L20)）用的是独立的 list-substring matcher，**不**走 `findMostSpecific`/`collectAllMatching`，本次**不**获得 glob 支持。`disabled_models` 走 `normalizeModelNameList` + 精确比较，也不在内。（若日后要给它们对齐 glob，另开 backlog，见 §7。）

### 3.2 键匹配规则

- **键不含元字符 → 保持 substring `includes`（现状语义不变）**。绝不改成精确匹配，否则 `claude-opus-4-7` 会意外收窄、断掉 `claude-opus-4-7-high` 这类变体命中。
- **键含 `*`/`?` → 锚定 glob**（`^…$`），与 §2.2 的 glob 编译同源（经 `matchesModelKey`）。
- `"*"` 纯通配 fallback 特例**保持不变**：`findMostSpecific` 里 `key === "*"` 走兜底分支、`collectAllMatching` 里 `"*"` 恒收，都**不**进 glob 分支。
- map 的「剔除」仍用值 `false`（GHC 分层里 `false` 力压 default-allow）；`!` 语法**只对 5 个 list 生效**，不进 map。

### 3.3 specificity 排序（reviewer major：显式定序，禁止「宽 glob 因串长压过精确 literal 键」）

现状 `findMostSpecific` 用「原始 `key.length` 最长者胜」度量具体度。若含 glob 键仍按字面串长参与比较，会出现反直觉：`{ "claude-opus-4-8": true, "*claude-opus-4-8": false }` 对模型 `claude-opus-4-8` 两键都命中，glob 键长 16、精确键长 15，`false` 反而胜。

**故本 spec 定死新的具体度排序**（`findMostSpecific` 内，`"*"` 始终最后兜底不参与）:

1. **先按种类**：literal substring 键（不含元字符）**优先于** glob 键（含元字符）。即任一命中的 literal 键都压过任一命中的 glob 键。
2. **同种类再按字面 `key.length` 最长者胜**（保持现状度量）。
3. **等长再按 insertion order 首见者胜**（保持现状 `Object.keys` tie-break）。

理由：literal 是运维精确点名某模型的手段，glob 是批量兜底，精确点名应压过批量——这与 §2.1「negative/precise 意图优先」一致，也符合直觉。`collectAllMatching` 是加性并集、无具体度概念，不受此排序影响（它只需按 §3.2 的键匹配规则决定某键是否命中）。

副作用：此升级让**上表全部** per-model map 都获得 glob 键能力。这是有意的一致性收益，向后兼容（不含元字符的老键行为不变，见 §8 的 literal-meta 说明），符合 `long-termism-wins`。

## 4. 架构落地

### 4.1 新增共享 primitive `src/lib/models/model-pattern.ts`

把「glob→正则」编译从 header 专属的 [header-glob-strip.ts:32](../../src/lib/anthropic/header-policy/header-glob-strip.ts#L32) `globToRegExp` 抽成通用工具，`header-glob-strip.ts` 改为 import（消一份重复实现）。**抽取安全性核实**：`globToRegExp` 是纯正则编译，`PROTECTED_HEADERS` 守卫与 empty-list mirror-opposite 语义都在 `compileHeaderStrip`/`compileHeaderAllow` 里、**不随** `globToRegExp` 迁走；header 侧行为逐字节保持，其现有测试原样通过。依赖方向 `anthropic/header-policy` → `models/` 是既有正常流向（`per-model-config.ts` 已 import `models/resolver`），无循环依赖。新文件导出：

- `hasGlobMeta(pattern): boolean` —— 是否含 `*`/`?`。
- `globToRegExp(pattern): RegExp` —— 锚定、大小写不敏感的**纯编译**（从 header 文件迁入，行为逐字节保持；**不**内置 `normalizeForMatching`）。
- `matchesModelPattern(candidate: string, pattern: string): boolean` —— 单模式对单候选，先对两侧跑 `normalizeForMatching`，再按 §2.2 分派 family-prefix vs glob。
- `modelMatchesPatternList(id: string, entries: ReadonlyArray<string>, family?: string): boolean` —— 列表求值，实现 §2.1 的「positive 命中且 negative 未命中」，候选集 `[id, family?]`（§2.3）。
- `matchesModelKey(modelName: string, key: string): boolean` —— map 键匹配：先归一，`key` 含元字符 → 锚定 glob，否则 → substring `includes`（§3.2）。供 `per-model-config.ts` 调用。

> 归属理由：放 `src/lib/models/`（与 `model-name.ts`/`resolver.ts` 同级），因为它是「模型名 × 模式」的纯匹配语义，`anthropic/` 与 `models/timeout-resolver.ts` 双方都消费，放 anthropic 子树会造成 `models/` → `anthropic/` 反向依赖。

### 4.2 改动点

| 文件 | 改动 |
|---|---|
| `src/lib/models/model-pattern.ts` | 新增，见 §4.1 |
| `src/lib/anthropic/header-policy/header-glob-strip.ts` | `globToRegExp` 改为从 `model-pattern.ts` import（删本地副本）；`compileHeaderStrip`/`compileHeaderAllow` 逻辑不变 |
| `src/lib/anthropic/features.ts` | `matchModelCapability` body 改为委托 `modelMatchesPatternList`；签名与 5 处调用点不变；metadata-first 分层不动 |
| `src/lib/anthropic/per-model-config.ts` | `findMostSpecific`/`collectAllMatching` 的 `normalizedModel.includes(normalizeForMatching(key))` 判定改为调 `matchesModelKey(modelName, key)`；`findMostSpecific` 的 specificity 改为 §3.3 定序（literal > glob，同种类键长胜，等长 insertion order）；`"*"` 特例、`collectAllMatching` 的 `"*"` 恒收不变 |
| `src/lib/config/schema.ts` | `model_capabilities` 的 doc 注释补 glob/`!`/YAML 引号说明；schema 类型无需改（`nullableNonemptyStringArray` 仅约束每项为非空字符串、无正则/长度限制；`tool_search_overrides` 的 `z.record` 无键约束，`!`/glob 串均通过校验，已核实 [schema.ts:99](../../src/lib/config/schema.ts#L99)） |
| `config.schema.json` | 跑 `bun run generate:config-schema` 重新生成 |
| `config.yaml` | 5 个能力 + `tool_search_overrides` 注释补 glob/`!` 用法与 YAML 引号陷阱；给 1-2 个示例 |
| **`docs/DESIGN.md`（漏项补入）** | [DESIGN.md:310-311](../../docs/DESIGN.md#L310) 是匹配语义的 **SSOT**（现文档只写 `=== 或 startsWith(+"-")` dash 边界 + `toolSearchOverrides` 的 `findMostSpecific` 优先级）。必须同步 glob/`!` 剔除语义与 §3.3 specificity 定序，否则文档与代码不一致 |
| `docs/anthropic-compat.md` | [:45](../../docs/anthropic-compat.md#L45) 仅是指向 DESIGN.md 的薄指针，语义细节不在此重复；如需加一句「支持 glob/`!`」即可（SSOT 仍在 DESIGN.md，避免同一事实两处） |

config 加载（[config.ts:651](../../src/lib/config/config.ts#L651)）与 state 存储**无需改**：列表按原始串存、匹配时才归一/编译。

## 5. YAML 引号规则（reviewer major-fix：精确到「哪些必须引号」）

YAML 里 `!` 是 tag 指示符、行首 `*` 是 alias 指示符。实测项目所用 `yaml` 解析器的实际行为（不要过度断言）：

- `- "!claude-haiku-*"` **必须引号**——裸 `- !claude-haiku-*` 被当 tag，产生 unresolved-tag warning / 空值。
- `- "*claude"` **必须引号**——裸 `- *claude`（`*` 在 scalar 开头）被当 alias 而解析失败。
- `- claude-*` **可不加引号**——`*` 不在 scalar 开头，是合法 plain scalar；但**推荐统一加引号**以防手误。
- `- "?claude-*"` / `?` 出现在模式中间或非 indicator 位一般可作 plain scalar；仍推荐引号。

**规则**：**以 `!` 或 `*` 开头的 pattern / map 键必须双引号；其余 glob pattern 推荐（非强制）统一双引号**。不要声称「`claude-*` 因行首 `*` 必须引号」——那是错的（`*` 不在行首）。

```yaml
context_editing:
  - "claude-*"          # 推荐引号（此处 * 非行首，裸写也合法）
  - "!claude-haiku-*"   # 必须引号（! 是 YAML tag 指示符）
  - claude-opus-4       # 裸 family 前缀无需引号，语义不变
tool_search_overrides:
  "claude-*": true      # glob 键（推荐引号）
  "claude-haiku-*": false
```

此规则写进 config.yaml 注释、schema doc、本 spec；YAML 行为测试须覆盖 quoted `!claude-*`、quoted `*claude`、以及**未引用** `!`/行首 `*` 的解析失败路径（防文档与 parser 脱节）。

## 6. 测试计划（TDD）

真相域归位（`choosing-test-type`）：匹配语义是纯函数 → unit/property 为主；热重载是集成 → 一条 `.it`。

- **新增 `tests/models/model-pattern.unit.test.ts`**（primitive 真相域）：
  - `matchesModelPattern`：family 前缀 exact / dash 边界（`claude-opus-4` 不匹配 `claude-opus-40`）/ glob `*`/`?` / `.`↔`-` 归一 / 大小写不敏感 / 正则元字符转义（`+`/`.`/`(` 不被当正则通配）。
  - `modelMatchesPatternList`：纯 positive（等价旧 family 语义）/ positive+negative 剔除胜 / 只有 negative → false / 空列表 → false / `!`+glob 组合 / **id 命中 positive 但 family 命中 negative → 剔除**、以及**反向组合（family 命中 positive、id 命中 negative → 剔除）**，证明 §2.3「任一候选命中任一 negative 即剔除」不是只测了同候选对称情形。
  - `matchesModelKey`：不含元字符 → substring 保持（`claude-opus-4-7` 命中 `claude-opus-4-7-high`）/ 含元字符 → 锚定 glob（`claude-*` 不匹配 `xclaude`）。
  - **等价性 oracle（reviewer minor-fix）**：旧 `matchModelCapability` 是 module-private 且将被替换，**不能**用它当 oracle。测试内**冻结一份 legacy family-prefix 参考实现**（`n === np || n.startsWith(np + "-")`，对 `[id, family]` 双候选），对一组「无 `!`、无 glob」的模型 × 前缀笛卡尔输入，逐条断言 `modelMatchesPatternList` 与该冻结实现结果相同——守住向后兼容。
- **扩 `tests/anthropic/anthropic-features.unit.test.ts`**：5 个能力各加 glob/`!` 用例（含 `contextEditingModels: ["claude-*", "!claude-haiku-*"]` 打到 `modelSupports*`）；`toolSearchOverrides` 加 glob 键用例（`{ "claude-*": false }`；以及 §3.3 定序：`{ "claude-opus-4-8": true, "claude-*": false }` → 精确 literal 键压过 glob 键得 `true`）。
- **扩 `tests/anthropic/per-model-config.unit.test.ts`**：glob 键 + substring 键并存；§3.3 定序（literal > glob、同种类键长胜、`"*"` 恒最后兜底）；`collectAllMatching` 的 glob 键加性并集。
- **新增 blast-radius 接线测试（reviewer minor-fix）**：至少各取一个 `findMostSpecific` 消费者与一个 `collectAllMatching` 消费者，证明 glob 键在它们身上生效且向后兼容——`findMostSpecific` 取 `streamIdleTimeoutOverrides`（timeout-resolver）；`collectAllMatching` 取 `stripToolFields` + `keepToolFields` **同时命中**的交互（strip 加、keep 减）。
- **扩 `tests/config/config-hot-reload.it.test.ts`**：一条 config-level「YAML（含 quoted `!`/glob）→ schema → state → `modelSupports*`」端到端 + 热重载：覆盖 (a) metadata 明示 `false` 仍压过 glob positive；(b) metadata 缺失时 `["claude-*", "!claude-haiku-*"]` 生效；(c) glob map 键与 bare 键的 §3.3 specificity 决议。

正样本先行（`empirical-verification`）：每条 glob/`!` 断言先证「去掉该模式后行为翻转」，确保断言真触达匹配腿而非恒真。

## 7. 非目标 / 暂缓

- **不**引入 delta-over-defaults（§2.1 被否方案）。
- **不**给 map 引入 `!` 语法（map 用值 `false` 剔除即可，§3）。
- **不**给 `system_reject_models` / `disabled_models` 加 glob（用独立 matcher、不在本 blast radius，§3.1）。若日后要对齐，另开 backlog（`docs/todo/deferred-backlog.md`），本次不做以免扩面。
- **不**动 metadata-first 分层、`toolSearchEnabled` 主闸、`memoryToolEnabled` 主闸等消费侧门控——glob/`!` 只改「name-list / map 键」这一匹配腿。
- 字符集只支持 `*`/`?`（不引入 `[abc]` 字符类、`{a,b}` 花括号展开）——YAGNI，如需再议。

## 8. 兼容性与风险

### 8.1 兼容性承诺（reviewer major-fix：精确界定，不夸大）

「含 `*`/`?` 即 glob」的自动分派与「所有既有配置逐字节不变」在理论上互斥：一个假想的既有 literal 键/条目若字面含 `*`/`?`（如 `vendor*exp`），旧代码把它当字面 substring/前缀、新代码会把它当 glob，语义变化。故**如实收窄承诺**：

- **逐字节等价只对「无 `!`、无 glob 元字符」的条目成立**（§6 冻结参考实现守卫）。
- **对「字面含 `*`/`?`」的既有条目，这是一次有意的语义变更**（不是逐字节保持）。但影响面为零，理由承重：**真实模型 id 永不含 `*`/`?`**，故任何既有 literal 键/条目一旦字面带这两个字符，旧代码下**从不命中任何模型**（substring `includes` 一个含 `*` 的串对真实模型名恒 false；family 前缀同理）——即它本就是**死配置**。新语义只是让这类**先前恒不命中的死条目复活成 glob**，不改变任何**曾经生效**的配置的行为。
- **已实测确认**：当前 bundled `config.yaml` 的 5 个能力 list 与所有 per-model map 键中，除 bare `"*"` 通配外**无任何**含 `*`/`?` 的字面项（config.yaml 里带 `*` 的都是 header glob 列表，走 header primitive、不在本 blast radius）。故对项目自身出厂配置**零行为变化**。
- 本项目本无向后兼容义务（CLAUDE.md），此改动更是纯增量：不引入 opt-in 语法/独立字段（字符自动分派足够、无死配置受害者），但 spec 与文档**如实标注**上述 literal-meta 边界，不写「所有既有配置逐字节不变」的过度断言。

### 8.2 风险点

- **正则元字符转义遗漏**会让 `.`/`+` 被当通配——§6 primitive 测试覆盖（`globToRegExp` 迁移自 header 侧、已在生产用，转义逻辑成熟）。
- **YAML 裸 `!`/行首 `*` 解析陷阱**——§5 精确规则 + 示例 + 解析失败路径测试。
- **`findMostSpecific` specificity 在 glob 键下的直觉**——§3.3 显式定序（literal > glob），禁止「宽 glob 因串长压过精确 literal 键」，测试固化。
- **primitive 抽取破坏 header 侧契约**——§4.1 已核实 `PROTECTED_HEADERS` / empty-list mirror-opposite 语义留在 header 文件、`globToRegExp` 纯编译不带 normalize、无循环依赖；header 现有测试原样通过作为守卫。
