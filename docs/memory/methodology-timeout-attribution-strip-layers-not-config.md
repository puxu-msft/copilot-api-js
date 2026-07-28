---
name: methodology-timeout-attribution-strip-layers-not-config
description: 多层客户端栈里真正掐断的那层可能在你配置的那层之下——配置自称值是假 oracle，须逐层剥离 + 看错误 cause + 裸 socket 排除服务端
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5a5c87a9-5348-4b9a-8d8d-78766c4bb5f9
  modified: 2026-07-27T22:40:13.888Z
---

客户端**自称的超时配置不是 oracle**：CC 的请求头写着 `x-stainless-timeout: 1200`、SDK 显式 `timeout: 1_250_000`、源码里 client-level 是 600s——而实际在 **~300s** 掐断的是**更低一层** undici 的默认 `headersTimeout`。上面三个计时器**从来没机会触发**。凭配置层的数字做预算，会把真实上限算大 2–4 倍。

**How to apply:**
- **逐层剥离定位**：真客户端 → 裸 SDK（显式设一个远大的 timeout）→ 完全剥掉厂商层的裸 `fetch` → 裸 TCP socket。哪层剥掉后现象消失，约束就在那层。
- **错误 cause 就是层名**：`UND_ERR_HEADERS_TIMEOUT` / `HeadersTimeoutError` 直接点名 undici；客户端超时与服务端关连接抛的是**不同错误类型**，别只看时刻数字。所以**客户端侧原始记录（含 `cause` 与 `process.versions`）必须落盘**，只有服务端观测「客户端离开了」是分不出层的。
- **多个客户端臂共享同一服务端实现时，服务端必须单独排除**：三臂一起在同一时刻失败，同样可以解释成「它们共享 transport 的同一个默认值」或「我的服务器在那时关连接」。用**裸 TCP socket**（无任何 HTTP 客户端、无自身超时）挂住同一 handler 看服务器动不动，才是排除。
- **结论要带作用域**：这类值是**某个 runtime 的默认值**，可被 dispatcher 覆盖、随版本变，不是协议常量。写成「物理上限」会误导后续取值。
- **别说「不属于客户端」**：transport 本来就是客户端运行栈的一部分；正确表述是「不是它的哪个具名计时器，触发器与某默认值一致」。

**Why:** 配置层的数字是「意图」，不是「生效值」；生效的是所有层里**最早**触发的那个。

**推论：定位到层之后，去查那一层有没有开关。** 本例里 undici 自己没有环境变量（`headersTimeout` 只能构造 Dispatcher 时给），但**上层应用可能替它开了口**——CC 的 `API_FORCE_IDLE_TIMEOUT=0` 会走到 `fetchOptions.timeout = false`，一次性关掉 undici 的 headers+body 两个超时（实测：静默 600s 仍单次尝试干净成功，对照臂 299.5s 死）。所以「这层没有 env 开关」不等于「这个限制关不掉」，要往上一层的封装找。

实例与完整对照表（含 5 个臂 + 正样本 + 服务端对照 + env 开关附测）见 `exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」与 §「Q1 附测」。

Related: [[methodology-client-source-grep-not-rest-capability-probe-endpoint]]（源码 grep ≠ 上游真实能力，同属「别拿声明当实测」）、[[feedback-pass-null-clean-not-self-validating]]、[[methodology-observe-client-giveup-serverside-not-ladder]]
