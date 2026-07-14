# anthropic ↔ responses 直接桥 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 给 `(anthropic ↔ responses)` 做无损直接翻译桥（前向 + 反向），把 hub-translate 从 CC-canonical 枢纽重塑为 per-pair 显式桥选择器，消除 non-CC↔non-CC 经 CC 中转的保真损失（reasoning 折成 reasoning_effort 标量、thinking 结构丢失、server tool strip）。

**Architecture:** hub-translate 的四个翻译分发器（请求 / 响应非流式 / 前向流 / 反向流）全部改成穷尽 `(source,target)` 桥表（漏对=编译错）；`(anthropic,responses)` 对用新直接桥（跳过 CC 中间表示、复用提取出的纯块映射 helper）；reasoning 全链路 round-trip 复用 `synthetic-reasoning.ts` 真密文哨兵签名；两场景（稳定模型 / 中途切换模型）由新 `model_translation` per-pair 配置调制。cell-assembly 出站穷尽 Record 结构与 driver hybrid dispatch **不动**（结构层已备），唯一例外是前向请求腿跨 translateOut+prepareWire+retry-baseline 三点。

**Tech Stack:** TypeScript / Bun；SSE 流式翻译；`@anthropic-ai/sdk` accumulator 作 oracle；bun test；eslint。

**权威 spec：** [docs/rfc/2026-07-14-anthropic-responses-direct-bridge.md](../../rfc/2026-07-14-anthropic-responses-direct-bridge.md)（v2，两轮异模型对抗审查已过）。

## Global Constraints（每个 task 隐含包含，逐字来自 RFC §9）

- **R-EXPLICIT**：全部翻译 dispatch 改穷尽 `(source,target)` 桥表，漏对=编译错。**绝不**只塞一个 `if` 分支（=往铁板挖洞）。
- **R-NO-INTERNAL-ADAPT**：byte-equivalence **仅指客户端 wire 边界**。regression oracle 只看客户端观测，绝不要求新桥内部中间表示匹配旧 CC-via 内部形状/命名/模块边界。为适配旧内部模块扭曲结构 = 禁止。
- **R-GOLDEN-TWO-ZONE**：**等价区**（纯文本/基础 tool_use/usage 非 reasoning 字段/stop_reason）用旧 CC-via golden 逐字节对；**改进区**（reasoning 保真/thinking 结构）用独立 oracle（真 SDK accumulator / round-trip 回喂 200）。**绝不**拿旧有损 golden 当改进区目标（焊死损失）。
- **R-DIRECTION-ASYMMETRY**：真 signature 转发（Claude 上游真 thinking）与哨兵合成（GPT encrypted_content 封装）是两个**不共享**的路径。绝不用一个「合成 thinking」helper 不分真伪来源。
- **R-NO-REVIVE**：server tool **请求侧**走工具声明映射（上游原生搜）；**响应侧结果回显永远降级**为普通 tool_use/text，绝不合成 `web_search_tool_result`（无真密文、撞退役双跳死墙）。
- **empirical-verification**：round-trip 上游接受性靠 Phase 0 探针实测坐实，为成功而设计、不预设 fallback；证伪即 escalate 真发现，非默认降级。
- **4141 保护**：所有探针/测试服务器起在**非 4141 端口**、独立 history.db，按 PID 精确清理自己启动的实例，绝不 `pkill`/`killall`。
- **commit 纪律**：每语义单元一 commit、显式 pathspec（`git commit -F <msg> -- <精确路径>`）、conventional commits、不加模型署名。每 commit 终态不变量、中间态绝不半坏。

## Phase DAG（严格依赖）

```
Phase 0（P0 探针，最先）
   ├─→ Phase 1（hub 重塑桥表，纯结构，可与 Phase 0 并行——不依赖探针）
   ├─→ Phase 2（提取纯块映射 helper，依赖 Phase 1 桥表落位）
   │      └─→ Phase 3（前向直接桥：请求腿三点 + 响应非流 + 流式）
   │             └─→ Phase 4（反向直接桥，对称）
   │                    └─→ Phase 5（reasoning round-trip 两向）★ 细节 gated on Phase 0
   │                           └─→ Phase 6（server-tool 请求侧透传 + 结果降级）
   └─→ Phase 7（配置：model_mapping 重命名 + model_translation 两场景）★ 可早做、Phase 5 消费其 features
```

**★ gated 说明（诚实排序、非 placeholder）**：Phase 5/6 的 bite-sized TDD 步骤在 **Phase 0 探针落定后、该阶段开工时敲定**——探针 (a) 决定 reasoning `encrypted_content` 取 `added` 还是 `done`、探针 (b) 决定反向是否物理可行。为未验证前提现在写死步骤违背 empirical-verification。本文件对 Phase 5/6 给 deliverable/acceptance/file-map/commit-invariant + 待敲定标记。

---

## Phase 0：P0 去风险探针（最先，unblocks 全部 round-trip 设计）

**Goal:** 用真 GHC 实测坐实 round-trip 三个物理前提，产出 `exp/anthropic-responses-direct/FINDINGS.md` 作 Phase 5/6 设计依据。

**Files:**
- Create: `exp/anthropic-responses-direct/probe-reasoning-roundtrip.ts`
- Create: `exp/anthropic-responses-direct/probe-reverse-echo.ts`
- Create: `exp/anthropic-responses-direct/probe-server-tool-passthrough.ts`
- Create: `exp/anthropic-responses-direct/FINDINGS.md`

**Interfaces:**
- Produces: `FINDINGS.md` 三裁决——(a) reasoning `encrypted_content` 权威版是 `added` 还是 `done` + 上游是否接受回喂续接；(b) 反向 responses 客户端是否原样回传外来 `encrypted_content` + Claude 上游是否接受；(c) anthropic web_search 声明经 responses `web_search_preview` 是否真返结果。

- [ ] **Step 1：起隔离测试服务器（非 4141）**

Run: `bun run start --port 4157` （真 GHC auth、独立 history.db 路径经 env 注入临时目录）
Expected: `GET http://localhost:4157/health` 返 healthy；`server.log` 无 `port in use`；`ss -tlnp | grep 4157` PID 是自己。
（`empirical-verification` skill 的 spawn 验证：确认监听 PID 是我的、上游轨非 localhost mock。）

- [ ] **Step 2：探针 (a) reasoning round-trip 捕获时机 + 上游接受性**

写 `probe-reasoning-roundtrip.ts`：
1. 发 anthropic `/v1/messages`（model 路由到 `gpt-5.5@openai-responses`、`reasoning` 触发、`stream:true`、小 `max_tokens`）。
2. 从 History API 取上游轨的原始 Responses SSE 帧，dump 同一 reasoning item 的 `output_item.added` vs `.done` 的 `encrypted_content`（比对是否不同、记 enc_len）。
3. 构造轮 2：把轮 1 的 reasoning item（分别用 `added` 版和 `done` 版 encrypted_content）作 responses `input` 回喂上游，记 HTTP 200/400。

Run: `bun run exp/anthropic-responses-direct/probe-reasoning-roundtrip.ts`
Expected: 明确裁决「`added`/`done` 哪版被上游 200 接受」写入 FINDINGS.md。若两版都 400 → escalate 真发现（round-trip 上游侧不可行，非默认降级）。

- [ ] **Step 3：探针 (b) 反向 responses 客户端回传外来密文**

写 `probe-reverse-echo.ts`：模拟 openai-responses 客户端（如 Codex 形请求）访问 Claude 模型 @messages，取 Claude thinking 块 → 重建为 responses reasoning item 回传 → 记上游是否接受。

Run: `bun run exp/anthropic-responses-direct/probe-reverse-echo.ts`
Expected: 裁决反向 round-trip 物理可行性写入 FINDINGS.md。

- [ ] **Step 4：探针 (c) server-tool 请求侧透传**

写 `probe-server-tool-passthrough.ts`：anthropic `web_search_20250305` 声明 → 直接映射 responses `web_search_preview` → 上游原生执行 → 记是否真返搜索结果（**只验请求侧**，不测结果回显）。

Run: `bun run exp/anthropic-responses-direct/probe-server-tool-passthrough.ts`
Expected: 裁决请求侧透传可行性写入 FINDINGS.md。

- [ ] **Step 5：按 PID 清理测试服务器 + 写 FINDINGS.md + commit**

```bash
kill <记录的PID>   # 绝不 pkill/killall
# 确认 4141 主服务器仍 healthy
```
写 FINDINGS.md 三裁决。
```bash
git add -- exp/anthropic-responses-direct/
git commit -F <msg> -- exp/anthropic-responses-direct/
```
Commit invariant: FINDINGS.md 每条裁决附原始证据文件路径（probe*.json / *.sse / history.json）。

---

## Phase 1：hub-translate 重塑为 per-pair 显式桥表（纯结构，等价区 golden 把关）✅ **已完成 2026-07-14**

**Goal:** 把四个翻译分发器从「CC-canonical 单轴 + 串联 if」改成穷尽 `(source,target)` 桥表，全部对现有对保持**客户端 wire 逐字节等价**（此阶段不加任何新桥，纯结构重构）。

**完成状态**：四分发器全部重塑为 `satisfies Record<...>` 穷尽桥表，四个语义单元分别提交，逐提交 golden 全绿（36 pass / 0 fail）+ typecheck 无新增错误 + 全套件（`test:backend`）2529 pass 无回归（既有 4 fail 经 baseline 版 hub-translate.ts 复现同样失败，证实与本 Phase 无关，属其他并发会话触及 `src/lib/observability/events.ts` / `src/lib/tui/terminal-ui.ts` 的未提交改动）。commit：
- `1fc15bb8` `translateRequestVia`（含 `(anthropic,/chat/completions)` 与 `(anthropic,/responses|ws:/responses)` 拆分为独立表项，为 Phase 3 只换 responses 一格铺路）
- `001e1c96` `renderResponseNonStreamingVia`
- `ce426190` `createForwardStreamTranslator`（pair→factory，保有状态语义）
- `45c264e3` `createReverseStreamTranslator`（pair→factory，保有状态语义；`anthropic` 不可达分支仍显式命名表项，非 default）

**Files:**
- Modify: `src/lib/pipeline/hub-translate.ts`（`translateRequestVia` / `renderResponseNonStreamingVia` / `createForwardStreamTranslator` / `createReverseStreamTranslator` 四分发器）
- Test: 新增/复用 `tests/**/*golden*` 等价区基线（Phase 1 Step 1 先锁 HEAD）

**Interfaces:**
- Produces: 一个统一的桥表原语（如 `resolveBridge(source, target)` 或每分发器内的穷尽 `Record`），漏对=编译错。具体命名以最佳方案为准（R-NO-INTERNAL-ADAPT）。

- [ ] **Step 1：改前锁 HEAD 等价区 golden**

对现有全部 `(source,target)` 对（含 anthropic→responses 两跳、gemini 经 CC、cc↔cc 恒等）跑现有 golden 套件，确认全绿作基线。若某对无 client-wire golden，补一条锁 HEAD。
Run: `bun test tests/ --grep golden`（或项目实际 golden 套件命令）
Expected: 全绿，作为 Phase 1 重构的 regression oracle。

- [ ] **Step 2：改 `translateRequestVia` 为穷尽桥表**

把 `toAnthropicBody`/`toCcBody` 的 switch 收敛为 `(source,target)` 穷尽 Record dispatch（gemini/cc/responses/anthropic × messages/cc/responses/ws）。逻辑不变、只换 dispatch 形状。此阶段 anthropic↔responses 仍解析到经-CC 桥（Phase 3 才换直接桥）。
Run: `bun run typecheck`
Expected: 编译过（穷尽性由类型系统保证）。

- [ ] **Step 3：改三个响应/流式分发器为穷尽桥表**

`renderResponseNonStreamingVia` / `createForwardStreamTranslator` / `createReverseStreamTranslator` 的串联 if 全改穷尽 `(source,target)`/`(clientFormat,target)` Record。gemini 两 cell 显式声明「暂经 CC」维持穷尽性（R-EXPLICIT）。
Run: `bun run typecheck && bun test tests/ --grep golden`
Expected: 编译过 + 等价区 golden 全绿（客户端 wire 逐字节不变，含 gemini 现有 golden byte-identical）。

- [ ] **Step 4：lint + commit**

Run: `bunx eslint src/lib/pipeline/hub-translate.ts`
Expected: 无 error。
```bash
git commit -F <msg> -- src/lib/pipeline/hub-translate.ts tests/<锁的golden>
```
Commit invariant: 桥表穷尽、gemini/cc/responses/恒等对全部客户端 wire 等价、无新桥。

---

## Phase 2：提取纯块映射 helper（三分类，Phase 3 的地基）

**Goal:** 审计两跳 `responses↔CC↔anthropic` 现有映射，按 RFC §3.2 三分类，把第①类（真跨格式通用）提取为干净具名 helper（纯函数），供直接桥组合。第②③类不提取（Phase 3 重新设计/重新推导）。

**Files:**
- Create: `src/lib/openai/translate/block-mapping/`（或最佳位置）——tool_use↔function_call id/name/arguments、content text、基础 stop_reason 映射 helper
- Modify: 现有 `anthropic-to-cc-*.ts` / `responses-to-cc-*.ts` 改调提取出的 helper（保客户端 wire 等价）
- Test: 提取的 helper 加单元测试 + 现有 golden 兜底

**三分类审计交付物（Phase 2 Step 1 产出，写入本 phase 或 exp）:**
- ①**可提取**：tool_use↔function_call（id/name/arguments）、content text 提取、基础 stop_reason 映射。
- ②**须重设计（Phase 3，不提取）**：GHC cc 腿 multi-choices fold/split（`anthropic-to-cc-request.ts` + `cc-to-anthropic-stream.ts`，CC 协议怪癖，Responses `output[]` 语义不同）、CC tool_call `index` 分配。
- ③**须重推导（Phase 3，不提取）**：usage 换算（三方 cache token 两两不同构，Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens` vs Responses `input_tokens_details.cached_tokens`/`cache_write` vs CC 第三形态）。

- [ ] **Step 1：审计并落三分类清单**（读全部 11 个 translate 文件，产出①②③归类 + 每项 file:line）
- [ ] **Step 2：提取第①类 helper（extract-not-rewrite，纯移动 + golden 兜底）**——先纯移动 commit、golden 把关字节等价。
- [ ] **Step 3：helper 单元测试 + 现有调用方改调 helper + 等价区 golden 全绿 + commit**

Commit invariant: 提取纯移动、客户端 wire 等价、①类 helper 有独立单测；②③类明确不提取（Phase 3 owner）。
（bite-sized TDD 步骤在 Step 1 三分类清单落定后展开——依赖真实代码审计结果。）

---

## Phase 3：前向直接桥（anthropic 客户端 → responses 模型）

**Goal:** `(anthropic, responses)` 对用新直接桥替换经-CC 两跳：请求腿三点改动 + 响应非流式 + 响应流式，改进区用独立 oracle。

**Files:**
- Create: `src/lib/openai/translate/anthropic-to-responses-request.ts`（请求 body 直接桥）
- Create: `src/lib/openai/translate/responses-to-anthropic.ts`（响应非流式）
- Create: `src/lib/openai/translate/responses-to-anthropic-stream.ts`（响应流式 + 自带终端 meta 累积器）
- Modify: `src/lib/codec/openai-responses/openai-responses-cell.ts`（`isDirect` 对 anthropic clientFormat 走 direct）+ `openai-responses-leg.ts:119`（`prepareViaResponsesWire` 对 anthropic 不再 CC→Responses）+ `cc-family-strategies.ts:38`（anthropic retry baseline 改 Responses 形）
- Modify: `hub-translate.ts` 桥表 `(anthropic,responses)` 项换直接桥
- Test: 等价区 golden（纯文本/基础 tool_use/usage 非 reasoning/stop_reason）+ 改进区 oracle（真 `@anthropic-ai/sdk` accumulator）

**Interfaces:**
- Consumes: Phase 2 第①类 helper；Phase 0 FINDINGS（reasoning 细节留 Phase 5）。
- Produces: `translateAnthropicToResponses(body, opts)` / `translateResponsesResponseToAnthropic(resp)` / `createResponsesToAnthropicStreamTranslator(modelId)`（含 `getMeta()` 终端 usage+stop_reason）。命名以最佳方案为准。

**承重（RFC §2.3 MAJOR）**：前向请求腿跨三点——若只改 translateOut 让 body 变 Responses 形，`prepareViaResponsesWire` 会当 CC 双翻译、`cc-family-strategies.ts:38` CC retry baseline 也坏。三点必须同改。

**Commit invariant（分 commit）**：请求腿三点一致改（中间态不半坏）；响应非流/流式分别 golden（等价区）+ oracle（改进区）；此阶段 reasoning 只做「明文 summary → thinking text」非 round-trip（round-trip Phase 5）。

（bite-sized TDD 步骤在 Phase 2 三分类清单 + Phase 0 FINDINGS 落定后展开。）

---

## Phase 4：反向直接桥（openai-responses 客户端 → Claude 模型 @messages）

**Goal:** `(openai-responses, messages)` 对用新直接桥替换经-CC 两跳，对称于 Phase 3。

**Files:**
- Create: `src/lib/openai/translate/responses-to-anthropic-request.ts`（反向请求）
- Create: `src/lib/openai/translate/anthropic-to-responses.ts`（反向响应非流式）
- Create: `src/lib/openai/translate/anthropic-to-responses-stream.ts`（反向响应流式）
- Modify: `hub-translate.ts` 桥表 `(openai-responses,messages)` 项 + messages leg（反向请求腿在 hub 内，纯）
- Test: 等价区 golden + 改进区 oracle（reverse exchange responseId/itemId 驱动真 assembly）

**Commit invariant**：反向请求腿纯 hub 内（无三点问题）；流式反向须 streamError 门（RFC 通用翻译矩阵承重：三反向 pump 须 streamError 门）；reasoning round-trip Phase 5。

（bite-sized TDD 步骤在 Phase 3 落定后展开。）

---

## Phase 5：reasoning 全链路 round-trip（两向）★ gated on Phase 0

**Goal:** reasoning 完整 round-trip——前向 responses `encrypted_content` → anthropic thinking（哨兵签名封装真密文）→ 回传剥签名 → 回喂 responses 上游续接；反向对称（Claude 真 signature ↔ responses reasoning item，须新建 primitive）。

**Files:**
- Modify: `src/lib/anthropic/synthetic-reasoning.ts`（前向复用；反向新建「真 Claude 签名 ↔ responses reasoning item」primitive，与哨兵合成两路径不共享——R-DIRECTION-ASYMMETRY）
- Modify: Phase 3/4 的 stream translator（接 round-trip 通道）
- Modify: `sanitize/`（剥离守卫复用，前向 round-trip 脆弱不变量：门控须留 MESSAGES-only，扩到 responses 腿即断——记守卫）
- Test: round-trip 回喂 200 oracle（真上游）+ 前向哨兵 SDK 接受 oracle

**★ 待 Phase 0 FINDINGS 敲定的设计参数：**
- 前向 `encrypted_content` 取 `added` 还是 `done`（探针 a 裁决）。
- 反向是否物理可行（探针 b 裁决）；若证伪 → escalate，不默认降级。

**Commit invariant**：前向哨兵合成与反向真签名转发两路径不共享（R-DIRECTION-ASYMMETRY）；改进区 oracle 独立（绝不用旧 CC-via golden，那条腿本就丢 reasoning）；per-pair `features` 消费 Phase 7 配置（场景 B 剥签名保文本）。

（bite-sized TDD 步骤在 Phase 0 探针落定 + Phase 3/4 桥就位后展开。）

---

## Phase 6：server-tool 请求侧透传 + 结果降级 ★ gated on Phase 0(c)

**Goal:** anthropic server tool（web_search 为其一）请求侧原生透传到 responses（上游原生搜）；结果回显永远降级为普通 tool_use/text（R-NO-REVIVE，无真密文不合成）。

**Files:**
- Create/Modify: 直接桥请求侧的 server-tool 声明映射（anthropic `web_search_20250305` → responses `web_search_preview`，名称鸿沟映射）
- Modify: 直接桥响应侧——server-tool 结果降级为 tool_use/text
- Test: 请求侧透传 oracle（Phase 0(c) 真上游）+ 结果降级 golden（绝不出现 `web_search_tool_result`）

**Commit invariant**：请求侧透传（R-NO-REVIVE 只保护请求侧）；结果回显永远降级、绝不合成 `web_search_tool_result`；OQ1 server-tool 全集映射表在本阶段审计落定。

（bite-sized TDD 步骤在 Phase 0(c) FINDINGS 落定后展开。）

---

## Phase 7：配置（model_mapping 重命名 + model_translation 两场景）

**Goal:** `model_overrides`（顶层键）→ `model_mapping` 重命名（留旧键 compat 别名）；新增顶层 `model_translation` 段（key=ingress format、value=match `model@format` 规则列表、`features:['strip-thinking-signature']`）驱动两场景。

**Files:**
- Modify: `src/lib/config/schema.ts:982`（字段名）+ `:1059`（`RECORD_MERGE_STRATEGIES` 重绑 per-key）+ 新 `model_translation` 段 schema
- Modify: `src/lib/config/compat.ts:159`（`CONFIG_MIGRATIONS` 加 `renameLeaf("model_overrides","model_mapping")`）
- Modify: `src/lib/state.ts`（`modelOverrides`→`modelMapping` 内部字段 + DEFAULT）+ `config.ts` + `src/lib/models/resolver.ts:114` + `normalize-id.ts:16`（注释）+ `src/routes/config/route.ts:191,264`
- Regenerate: `config.schema.json`（`scripts/generate-config-json-schema.ts`）+ `config.example.yaml`
- doc-sync: `docs/` 下 `model_overrides` 引用（`model-resolution.md` / `anthropic-compat.md` / `DESIGN.md` / `spec/anthropic-via-openai-translation.md`）grep 全仓同步
- Test: config 加载 + compat 迁移（旧键读时映射）+ model_translation match（路由裁决后 model@format）+ 热重载不杀进程

**Interfaces:**
- Produces: `state.modelMapping`；`model_translation` 解析后的 per-pair features 查询（挂格式无关的桥选择函数内部、非 per-cell translateOut，避免两路径状态不一致——RFC §6.1）。

- [ ] **Step 1：写 compat renameLeaf 迁移测试（旧 `model_overrides` → 新 `model_mapping`）**
- [ ] **Step 2：改 schema 字段名 + RECORD_MERGE_STRATEGIES 重绑 + compat renameLeaf**
- [ ] **Step 3：改内部字段 modelOverrides→modelMapping（state/config/resolver/route）+ typecheck 绿**
- [ ] **Step 4：新增 model_translation 段 schema + 解析 + match 语义（精确 model@format）**
- [ ] **Step 5：重生成 config.schema.json + config.example.yaml + doc-sync grep**
- [ ] **Step 6：全套件 + 热重载测试 + commit（分：重命名 / model_translation 两 commit）**

Commit invariant: 旧键 compat 别名读时映射（warn-continue、热重载不杀进程）；`model_translation` 默认无 features = 场景 A 完整互填；features 挂格式无关桥选择函数。

（Step 2-4 的 bite-sized 代码在开工时按 schema.ts 实际结构展开——机械可全知，非 gated。）

---

## Self-Review 覆盖对照（spec → task）

| RFC 节 | 覆盖 phase |
|---|---|
| §2 hub 重塑桥表 | Phase 1 |
| §3.1 6 原语 / §3.2 三分类 extract | Phase 2/3/4 |
| §4 round-trip 两向 + 两场景 | Phase 5（+ Phase 7 配置） |
| §5 server-tool 透传 + 降级 | Phase 6 |
| §6 配置 model_mapping + model_translation | Phase 7 |
| §7.1 golden 双区 | 全 phase（等价区 golden + 改进区 oracle） |
| §7.2 P0 探针 | Phase 0 |
| §8 迁移 commit invariants | 各 phase commit invariant |
| §11 OQ1（server-tool 映射全集） | Phase 6 |
| §11 OQ4（新 ADR 收窄 CC-hub） | 收尾（landed 后写 ADR，见下） |

**收尾（landed 后）**：写 ADR `docs/decisions/2026-07-14-lossless-per-pair-bridge.md` 收窄 [universal-codec-translation-matrix ADR](../../decisions/2026-07-11-universal-codec-translation-matrix.md) 的 CC-canonical 适用边界（第一性设计轴翻转：CC-canonical 默认 → lossless-per-pair 默认、CC 仅在真 `/chat/completions` 腿）。
