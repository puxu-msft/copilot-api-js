# C0.4 —— Responses `web_search_call` 续接形态的真实上游实测

**实测时间**：2026-08-11｜**方式**：隔离测试服务器 **45191**（真 GHC auth，`XDG_DATA_HOME` 指向临时目录、独立 History／telemetry）｜**4141 主服务器全程未动**，探针前后各复核一次，均 healthy（`302`）｜**清理**：按精确 PID `kill`（父 148434 + 实际持端口的子进程 148437），从不 `pkill`／`killall`。

**权威**：[RFC §17 真实上游接受性探针](../../docs/rfc/2026-08-08-anthropic-responses-semantic-bridge.md)、[统一语义桥权威 ADR](../../docs/decisions/2026-08-11-unified-semantic-bridge-authority.md)。
**证据文件**：`results.json`（五形态）、`mechanism.json`（机制与跨模型）。
**复现**：`bun run exp/responses-server-tool-continuation/probe-forms.ts <baseUrl> <model>`、`probe-mechanism.ts <baseUrl> <model> <altModel>`。

---

## 一、结论（先看这条）

`[hard]` **P4 负控只成立一半，因此「上游接受」不能用来收窄形态。RFC §6.1 的保守默认 `responses-output-item`（完整 item）予以保留，不改。**

上游**不校验** `web_search_call.id` 是否指向一次真实的历史搜索——随手编一个短 id（`ws_short_id_1`）照样 `200`。既然伪造与真实都被接受，「被接受」就不构成续接有效的证据。这正是 RFC §17 P4 预先写下的作废条件。

## 二、五形态实测（`results.json`）

turn 1 拿到真实 `web_search_call`，keys = `["action","id","status","type"]`（**确无** `encrypted_content`，与 2026-07-14 的既有探针一致）。turn 2 **不回放 turn-1 的 message**——它的正文里就写着答案，回放会让所有变体都答对、观测量失去判别力。

| 变体 | HTTP | 答案 |
|---|---|---|
| A 完整 item 原样回传 | **200** | `NO_CONTEXT` |
| B 最小 `{type,id}` | **200** | `NO_CONTEXT` |
| C `{type:"item_reference",id}` | **404** `not_found` | — |
| D 完整 item + 篡改 id（负控） | **400** `Invalid 'input[1].id': string too long. Expected … maximum length 64, but got … 424` | — |
| E 完全省略该 item（基线） | **200** | `NO_CONTEXT` |

## 三、机制（`mechanism.json`）

D 的 400 报的是「超长」，而 A 用**等长**的 id 却过了——这个不对称必须解释清楚，否则 D 只是碰巧变红、不构成负控。

| 用例 | HTTP | 读数 |
|---|---|---|
| 未篡改（对照） | 200 | — |
| **单字符**篡改、长度不变 | **400** | 同一条「超长 max 64 got 424」 |
| 短的伪造 id `ws_short_id_1` | **200** | **静默接受** |
| 跨模型回放（`gpt-5.6-sol` → `gpt-5.5`） | 200 | — |

**机制**：上游对该 id 做**解密**。解密成功 → 当作服务端不透明引用，不受长度规则约束；解密失败 → 退回普通 item-id 规则，撞 64 字符上限而 400。翻一个字符即失败，证明它确实在解密而非做长度检查。

**但**短的伪造 id 走的是「合法普通 id」那条路，直接放行——**所以 200 既可能来自真引用，也可能来自一个根本不存在的 id**。

## 四、对设计的影响

1. **保留 `responses-output-item` 作为默认**（RFC §6.1 不改）。`{type,id}` 虽被接受，但我们无法证明它保住了同样多的东西——完整 item 是唯一保全了我们看不见的那部分的形态。
2. **`responses-item-reference` 对 `web_search_call` 不可用**（404）。该 record kind 保留在联合里（别的 server tool 将来可能支持），但须标注此实测。
3. **`web_search_call` 的续接价值是 provenance／顺序，不是可恢复的结果数据。** A／B／E 三者答案完全相同这一点说明：回传它并没有把搜索结果带回上下文——因为该 item 从来就只有 `action` 与 `id`，结果一直在 message 文本里。

## 五、P5 与 P2 的补测（2026-08-11 第二轮，`stream-id.json`）

首轮把 P2／P5 列为欠账，同日补跑。

### P5：`web_search_call` 的 `id` 在流式下**稳定**

| 事件 | `output_index` | `status` | id |
|---|---|---|---|
| `response.output_item.added` | 1 | `in_progress` | 424 字符，`lLdnCxf7U788eEubnOkkI9uV…` |
| `response.output_item.done` | 1 | `completed` | **同一个 id** |

流式抓到的 id 回传上游得 `200`。

`[hard]` **这不推翻本仓既有的「GHC 逐事件重新加密 `item.id`」——那条是在 `function_call` 上测到的**（其证据涉及 `function_call_arguments.done` 这个 function 专有事件）。两者是**不同 item 类型**，不矛盾。正确的表述是：**该重加密行为不适用于 `web_search_call`**（本轮、本模型、两个事件的观测）。**不得**据此放宽 function_call 侧的既有纪律。

对设计的影响：存进 carrier 的 `web_search_call.id` **不需要**在 added／done 之间做「取哪一个」的裁决——这一格不存在那个陷阱。

### P2：incomplete 变体本轮不可复现，**据下述理由显式豁免**

两次尝试（单次搜索、以及强制三次独立搜索的提示词产出 6 个 `web_search_call`）**全部是 `status:"completed"` 且都带 `action`**。既有 FINDINGS 记录 2026-08-05 在 `gpt-5.6-sol` 上见过 incomplete 变体，但**不能按需复现**。

**豁免理由（不是"测不出来所以算了"）**：本轮裁决是**保留完整 item 作默认**，而完整 item 的回传**与 `status` 无关**——不论 completed 还是 incomplete，存进 carrier 的都是整个 item 原样。因此 P2 **不可能改变当前裁决**。它只在**将来有人想收窄形态**时才重新变得承重：那时必须证明所选的最小形态在两种终态下都成立。**收窄前必须先补 P2。**

---

## 六、它没有证明什么

- **没有**证明「回传 `web_search_call` 毫无作用」。id 可解密，意味着服务端**可能**据它维护我们观测不到的状态；**观测不到效果 ≠ 没有效果**。本探针的观测量只有「模型能否复述版本号」，这对服务端内部状态是盲的。
- **没有**证明 `{type,id}` 一定劣于完整 item。它只证明了**两者都被接受、而接受本身无判别力**，所以不能据此收窄——这是「证据不足以收窄」，不是「已证明更差」。
- **没有**覆盖 RFC §17 的 P5 的 carrier 部分。第二轮测的是**上游 wire 上的 `id` 是否逐事件变化**（结论：`web_search_call` 不变），**不是**我方 carrier v2 的编解码 byte-exact 往返——那个 carrier 还没实现（C7.1），无从测起。
- **P2 已显式豁免而非补齐**，理由见第五节：完整 item 的回传与 `status` 无关，故 P2 改变不了当前裁决；**收窄形态之前必须先补它**。
- **P5 的稳定性是两个事件、单次运行、单一模型的观测**。未覆盖多 `web_search_call` 并发时各自 `output_index` 的 id 行为，也未测跨请求或长时间后同一 id 是否仍可解密。
- **没有**覆盖 `web_search_call` 之外的任何 server tool。`ResponsesServerToolItemType` 目前只列 `web_search_call`，这是当前唯一有证据的类型，不是穷举结论。
- **没有**排除模型行为的偶然性。每个变体各跑**一次**，`NO_CONTEXT` 是单次观测；模型输出有随机性，若要把「A 与 E 无差异」当强结论，需要多次重复。
- **没有**验证 id 的时效。未测同一 id 在数分钟／数小时后是否仍可解密；若服务端有过期，长期存进 carrier 的 id 可能在回传时已失效。
- **单一 provider／account**：全部经本机 GHC 账号，未覆盖其他 provider 或 enterprise 账号。
