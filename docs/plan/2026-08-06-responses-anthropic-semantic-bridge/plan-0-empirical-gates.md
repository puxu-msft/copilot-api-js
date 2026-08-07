# P0 — Empirical Gates and Frozen Decisions

> **状态**：未实施
>
> **前置**：权威规格；可与 P1 并行。任何涉及真实 GHC 的步骤使用 `live-ghc-e2e-verification`，非 4141 端口。

**Goal:** 在承重实现前冻结 Web Search continuation 最小形态、carrier channel、affinity、stream timing、structured-output／`context_management` capability matrix。

**Architecture:** 所有探针写入 `exp/responses-anthropic-semantic-bridge/`，原始脱敏观测与结论分离。Mock／SDK 覆盖面是主力，真 GHC 只回答物理接受性；每个结论必须写“它没有证明什么”。

**Tech Stack:** Bun scripts、真实代理隔离实例、History API、OpenAI／Anthropic SDK。

### Task 0.1: 建实验骨架与安全门

**Files:**
- Create: `exp/responses-anthropic-semantic-bridge/README.md`
- Create: `exp/responses-anthropic-semantic-bridge/shared.ts`
- Create: `tests/semantic-bridge/probe-safety.unit.test.ts`
- Create: `docs/tmp/2026-08-07-responses-anthropic-semantic-bridge-progress-p0-gates.md`

**Interfaces:**
- Produces: `runProbeCase(name, request): Promise<ProbeObservation>`；输出只含 status、事件类型、长度、SHA-256、字段存在性，不含 token 或 opaque payload。

- [ ] **Step 1: 写失败的安全测试**

在 `shared.ts` 导出 `assertProbePort(port)`，测试拒绝 `4141`、接受高位端口；对脱敏函数输入 `encrypted_content`／signature 后断言正文不出现在序列化结果。

- [ ] **Step 2: 跑红灯**

Run: `bun test tests/semantic-bridge/probe-safety.unit.test.ts`
Expected: FAIL，缺 `assertProbePort`／redactor。

- [ ] **Step 3: 实现安全骨架**

```ts
export function assertProbePort(port: number): void {
  if (port === 4141) throw new Error("probe must not use the user server port 4141")
}

export interface ProbeObservation {
  case: string
  httpStatus: number
  eventTypes: string[]
  opaque?: { present: boolean; bytes: number; sha256: string }
}
```

README 必含：回答什么、它没有证明什么、隔离方式、复跑命令、清理 PID 和 4141 health 复核。

- [ ] **Step 4: 跑绿灯并提交**

Run: `bun test tests/semantic-bridge/probe-safety.unit.test.ts`
Expected: PASS。

Commit: `test(exp): add semantic bridge probe harness`

### Task 0.2: Web Search continuation 最小形态

**Files:**
- Create: `exp/responses-anthropic-semantic-bridge/web-search-continuation.ts`
- Create: `exp/responses-anthropic-semantic-bridge/web-search-observed.json`
- Modify: `exp/responses-anthropic-semantic-bridge/README.md`

**Consumes:** 真实已完成／incomplete `web_search_call` fixture。
**Produces:** `full-item | type-id | item-reference | bare-id` 的同模型、alias、跨模型矩阵裁决。

- [ ] **Step 1: 先写 mock 正负控制**

Mock endpoint 对完整 item 返回 200，对篡改 id 返回可辨识错误；证明 harness 能区分正确／错误 reference。

- [ ] **Step 2: 起隔离服务器并确认归属**

使用 `live-ghc-e2e-verification` 选非 4141 唯一端口；确认监听 PID、当前 commit、无 upstream hook、独立 History。

- [ ] **Step 3: 逐格真实回喂**

逐项执行 24 格矩阵：2 种 item 状态（complete／incomplete）× 4 种 reference 形态（full item、`{type,id}`、`item_reference`、裸 id）× 3 种 affinity（同模型、同 resolved model alias、不同模型）。每格记录 HTTP status、错误 code、下一轮可观察语义、History upstream wire 的字段存在性和 opaque SHA；不允许每类抽样一格代替全矩阵。

- [ ] **Step 4: 写结论边界**

README 不允许从“HTTP 200”推导“隐藏语义恢复”；若同模型正控无鉴别力，明确标为未证，不据此放宽 affinity。

- [ ] **Step 5: 清理与提交**

精确 PID 停测试服务器，复核 `http://127.0.0.1:4141/health`；提交 exp 文件与 progress。

Commit: `test(exp): probe web search continuation forms`

### Task 0.3: Carrier channel 与首次可得时点

**Files:**
- Create: `exp/responses-anthropic-semantic-bridge/carrier-channel.ts`
- Create: `tests/e2e-client/semantic-bridge-carrier.it.test.ts`
- Modify: `exp/responses-anthropic-semantic-bridge/README.md`

**Produces:** carrier 承载字段、最大长度、whole／stream parity、客户端 echo、首次可得 phase、malformed／foreign prefix 行为。

- [ ] **Step 1: Anthropic SDK echo 正控**

用 `serveInProcess()` + mock upstream 发送带候选 carrier 的 thinking block；真实 `@anthropic-ai/sdk` `.finalMessage()` 深等后将完整 content 回送第二轮，mock 断言 carrier 字节未变。

- [ ] **Step 2: OpenAI SDK echo 正控**

真实 `openai` SDK 对 Responses reasoning／item reference 做第二轮回送；断言我方请求捕获完整。

- [ ] **Step 3: 流式 timing 探针**

记录 reasoning／web_search continuation 在 `added`、progress、delta、`.done` 各 phase 是否完整；若只在 `.done` 可得，P4/P5 live renderer 必须选择 buffered inline、早期 reference 或阻断，不允许末尾回插 thinking。

- [ ] **Step 4: malformed／foreign／length**

损坏 prefix 必须“不误认且不抛”；foreign prefix 原样当普通内容；长度达到 SDK／endpoint 边界前后各一例。

- [ ] **Step 5: 目标 mutation**

把 echo 断言改成只比较 decode 后对象，测试应无法证明 byte-exact；恢复为原始字符串比较。删除 `.done` 捕获、改用 `.added` 后，权威 SHA 断言必须红。

Commit: `test: probe semantic bridge carrier channel`

### Task 0.4: 顶层 capability matrix 与用户裁决输入

**Files:**
- Create: `exp/responses-anthropic-semantic-bridge/top-level-capabilities.ts`
- Create: `exp/responses-anthropic-semantic-bridge/capability-matrix.md`
- Modify: `exp/responses-anthropic-semantic-bridge/README.md`

**Produces:** structured output name 与 `context_management` strategy 的候选、实测、违反契约和推荐；不自行落最终产品映射。

- [ ] **Step 1: structured output 双向 wire inventory**

列 Anthropic `output_config.format` 与 Responses `text.format` 的 type/name/strict/schema；用真实 SDK 生成 request，mock 记录 wire。候选至少含 source name、确定性 schema hash、显式配置、reject。

- [ ] **Step 2: strategy matrix**

逐个当前生产的 `context_management` strategy 记录 producer、source schema、target 是否有同语义，不按字段同名整体透传。

- [ ] **Step 3: 真上游 spot-check**

只对 mock 无法判断的接受性做最少真 GHC 请求；记录 provider／model／endpoint 基线。

- [ ] **Step 4: 形成裁决表**

每行：方案、可行性、真实证据、可逆性、丢失字段、推荐。未裁决项产品实现必须 `degraded` 或 `rejected`，不得 silent drop。

- [ ] **Step 5: 提交**

Commit: `docs(exp): freeze semantic bridge capability evidence`

## Phase 验收

- `exp/responses-anthropic-semantic-bridge/README.md` 每项都含“它没有证明什么”。
- 所有原始文件不含 opaque 正文／token；只存 SHA／长度／存在性。
- P4/P5/P2 可以从产物直接读出 continuation／timing／capability 的冻结输入，不临场猜测；Web Search 表含 24/24 格，缺一格即 P0 未完成。
- 真 GHC 测试后 4141 一直 healthy。
