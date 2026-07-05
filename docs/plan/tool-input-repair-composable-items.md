# 把 `tool_repair_malformed_input` 从枚举档位重构为可叠加修复项目集 + 新增坏 Unicode 转义修复

## Context

**问题**:常驻 4141 上一条真实 FAIL(`req_1782778207147_144`,claude-opus-4-8,AskUserQuestion)经字节级诊断,根因是上游把 `questions` 字段里一个 `\uXXXX` 转义生成坏了——`默`("默")写成 `\u9 ed8`(4 位 hex 被空格打断),整个 stringified JSON 在 position 200 报 `Bad Unicode escape`。

**现状为何救不了**:用户配置 `tool_repair_malformed_input: tags`,只跑 Layer 1 antml 标签剥离(本输入无标签→no-op)。实测即使升 `repair` 档,jsonrepair@3.14.1 对 `\u9 ed8` 直接抛 `Invalid unicode character`,也修不了。当前 `false | "tags" | "repair"` 是**串行层档位**(repair 隐含 tags),无法表达「只修 unicode 不剥标签」这类自由组合。

**目标**:① 把配置从枚举档位改成**可叠加的逗号分隔修复项目集**(`tags` / `jsonrepair` / `unicode`),每项独立可选、可叠加;② 新增保守的坏 Unicode 转义修复项目,覆盖实测 case。

**已确认的设计选择**(AskUserQuestion):
- **固定规范顺序**:内部固定 `tags → unicode → jsonrepair`,逗号集合只决定启用哪些、书写顺序无关;每个启用项把变换叠加在前一项输出上,任一步 revalidate 通过即停。
- **命名**:`tags`(antml 剥离) / `jsonrepair`(结构修复) / `unicode`(新)。
- **unicode 保守**:只修「`\u` 后 4 位 hex 被空白字符打断」,去空白凑齐 4 位;合法 `\uXXXX` 原样透传。
- **干净破坏、零兼容**(项目未发布,compat-fusion):**不留旧值兼容**——无 compat 迁移、不保留 `false` 布尔。off 用空字符串 `""`(空项目集)。旧 `"repair"` 直接变非法 token 报错(预期);`"tags"` 天然仍合法(解析为单项目集 `["tags"]`,语义不变)。

## 数据模型

新增 `export type RepairItem = "tags" | "jsonrepair" | "unicode"`(放 `src/lib/anthropic/tool-input-repair.ts`,机制 owner)。

配置内部表示:`ReadonlyArray<RepairItem>`,规范化 = 去重 + 按固定规范顺序 `[tags, unicode, jsonrepair]` 排列。空数组 `[]` = 不修复(等价旧 `false`)。

**项目名 → layer/遥测名映射**(历史不一致,注释说明):`tags`→layer `strip`、`jsonrepair`→`jsonrepair`、`unicode`→`unicode`。

## 实现(按 commit invariant 分 3 个自洽 commit)

### C1 — 项目集模型重构(行为等价,纯重构,typecheck+test 绿)

此 commit **不引入 unicode**,只把档位模型换成项目集,且 `tags`/`jsonrepair` 两项逐字节等价旧 `tags`/`repair` 档行为(`tags` 项 = 旧 `tags` 档,`"tags,jsonrepair"` 集 = 旧 `repair` 档)。

- **schema** [src/lib/config/schema.ts:350-355](src/lib/config/schema.ts#L350):union-of-literals → 接受 `string`/`null`(纯字符串,**不再接受 `false` 布尔**),`.transform()` 调新 helper `parseRepairItems(raw): RepairItem[]`(split→trim→去空→校验 token∈{tags,jsonrepair,unicode}→去重→规范排序);非法 token 经 `ctx.addIssue` 报错(文案列三项目)。`""`/`null`/absent→`[]`。同步 TSDoc(342-349)。**干净破坏**:旧 `"repair"` 现为非法 token(预期报错);`"tags"` 天然解析为 `["tags"]`。
- **state** [src/lib/state.ts:147,1139,1294](src/lib/state.ts#L147):字段类型 `ReadonlyArray<RepairItem>`,默认 `[]`;`setAnthropicBehavior` key 联合(927)不变。
- **config→state** [src/lib/config/config.ts:578](src/lib/config/config.ts#L578):retain-on-absence `!== undefined` 守卫不变,直传已规范化数组。
- **repairToolInput** [src/lib/anthropic/tool-input-repair.ts:130](src/lib/anthropic/tool-input-repair.ts#L130):签名 `(raw, items: ReadonlyArray<RepairItem>)`。改为级联叠加:`let current=raw`;`if(items.includes("tags")){current=stripAntmlTagsOutsideStrings(current); revalidate→layer:"strip"}`;(C2 在此插 unicode);`if(items.includes("jsonrepair")){tryJsonRepair(current)→layer:"jsonrepair"}`;否则 `unrepairable`。**关键**:Layer 1 从无条件改为 `items.includes("tags")` 条件触发;jsonrepair 作用在 `current`(已被前序项处理)上=叠加。
- **decode 消费** [src/lib/anthropic/decode-tool-input.ts:62,183-184,210,303-304,321](src/lib/anthropic/decode-tool-input.ts#L62):`ToolInputRewriteOptions.repairMalformedInput` 类型 → `ReadonlyArray<RepairItem>`;两处 `repairMode`/`repairEnabled` 派生(184、304)改为 `const items = opts.repairMalformedInput ?? []; const repairEnabled = items.length>0`;`repairToolInput(full, items)`。
- **appliesTo 门** [src/lib/codec/anthropic/response-rewrite-adapters.ts:216,222,238](src/lib/codec/anthropic/response-rewrite-adapters.ts#L216):`!== false` → `.length>0`;两消费点传 `state.toolRepairMalformedInput`(已数组)。
- **status 暴露** [src/routes/status/route.ts:233](src/routes/status/route.ts#L233):`enabled: state.toolRepairMalformedInput`(数组直出或 join)。
- **测试更新**:`tool-input-repair.unit.test.ts`(`repairToolInput` 参数 mode→items,测固定顺序级联);`tool-input-repair-decoder.unit.test.ts`(`decodeNS` helper + 逐档→逐项目集,行 66-163/187);`config-hot-reload.it.test.ts:584-588`(`sampleYamlValue:"tags,jsonrepair"`、`expectedStateValue:["tags","jsonrepair"]` → 矩阵断言数组需 `toEqual` 非 `toBe`,**风险点**:核对矩阵比较逻辑是否需分支);schema 测试加逗号解析 + 非法 token 报错(含断言旧 `"repair"`/`false` 现在报错——锁住干净破坏)。

### C2 — 新增 unicode 修复项目(TDD,新能力)

- **新函数** `src/lib/anthropic/tool-input-repair.ts`:`export function fixBadUnicodeEscapes(input: string): string`。单遍扫描器(镜像 `stripAntmlTagsOutsideStrings` 结构):遇 `\u` → 若紧跟 4 hex 原样透传(slice 6);否则从 `\u` 后收集 hex、**仅跳过 hex 之间的空白**(` \t\r\n`),若去空白后恰好 4 hex 且确实消费过空白(`consumedWs`)则输出 `\u`+4hex、跳过窗口,否则 `\u` 原样输出 2 字符前进。保守:`\u 9ed8`(开头即空白)/少位/非 hex 一律不动。
- **级联接入** `repairToolInput`:在 tags 之后、jsonrepair 之前插 `if(items.includes("unicode")){current=fixBadUnicodeEscapes(current); revalidate→layer:"unicode"}`。
- **类型扩展**:`RepairResult.layer` 加 `"unicode"`([tool-input-repair.ts:97](src/lib/anthropic/tool-input-repair.ts#L97));`onRepair` 回调 layer 类型加 `"unicode"`([decode-tool-input.ts:68](src/lib/anthropic/decode-tool-input.ts#L68))。
- **遥测桶** [src/lib/anthropic/tool-input-repair-stats.ts:18-25,43-45](src/lib/anthropic/tool-input-repair-stats.ts#L18):`ToolInputRepairStats` 加 `unicode` 字段(同步 reset 43-45 + status)。
- **测试(先写)**:`fixBadUnicodeEscapes` 单元(合法 `默` 透传、`\u9 ed8`→`默`、`\u9e d8`→修、`\u 9ed8`/`\u9ed`/`\uZZZZ` 不动、idempotent);`repairToolInput` 测 `["unicode"]` 单项目 + `["tags","unicode","jsonrepair"]` 叠加级联;**真实 case fixture**:从 history `req_1782778207147_144` 取累积的 1179 字节畸形 input 做 fixture,断言 `unicode` 项目修复后 `JSON.parse` 成功且 `questions.length===1`(独立 oracle:真实上游字节,非自洽构造)。

### C3 — 文档同步

- [config.yaml:553-563](config.yaml#L553):注释块重写为项目集语义 + 三项目说明(`tags`/`jsonrepair`/`unicode`)+ `""`=off;默认值 `tool_repair_malformed_input: ""`(不再 `false`)。新增键须在 bundled config 完整列出(项目纪律)。
- [docs/DESIGN.md:334](docs/DESIGN.md#L334):配置表行重写(类型→逗号项目集、三项目语义、unicode 保守局限诚实标注、layer↔项目名映射)。
- [docs/spec/anthropic-malformed-tool-input-repair.md](docs/spec/anthropic-malformed-tool-input-repair.md):更新 §2.1 配置模型(档位→项目集)+ 新增 unicode 项目小节(算法、保守边界、实测 case `\u9 ed8`)。
- 检查 `docs/memory/` 是否有相关 pending 记忆需回填(completion-includes-doc-sync)。

## 验证

```bash
bun run typecheck                                  # 类型贯穿(state 字段类型变更波及全消费点)
bun run test:backend                               # 全 offline 套件
bun test tests/anthropic/tool-input-repair          # 修复核心单元 + decoder
bun test tests/config/config-hot-reload             # 矩阵(数组字段断言)
bun test tests/config                               # schema 解析 + 非法 token 报错
bun run lint:all                                    # eslint --fix
```

**端到端实测**(empirical-verification,服务器由用户重启后):把 history `req_1782778207147_144` 的畸形 input 经 `/api/debug/dry-run-pipeline`(响应侧 `stopAfter=rewrite-out`,format=anthropic)回放,配 `tool_repair_malformed_input: "unicode"` 验证 decode 改写链产出合法 `questions` 数组、不再 `input-unrepairable`;对照 `tags` 档仍 FAIL。

## 关键不变量

- C1 后 `tags`/`jsonrepair` 两项行为**逐字节等价**旧 `tags`/`repair` 档(golden/现有测试锁)。
- **干净破坏、零兼容**(项目未发布):无 compat 迁移、不留 `false`/`"repair"` 双轨。旧 `"repair"`/`false` 现为非法配置(schema 报错);`"tags"` 天然仍合法(单项目集,语义不变)。
- History 始终保留上游原始畸形字节(只改 forwarded 流,richest-data-flow)——本次不动持久化路径。
- `server_tool_use` 永不被缓冲/修复(既有 `block.type==="tool_use"` 硬门不变)。
- unicode 修复保守边界:合法 JSON 的 `\u` 后绝无空白,误伤面≈0;无法修的坏转义→照常 `unrepairable` 记 FAIL(不谎报)。
