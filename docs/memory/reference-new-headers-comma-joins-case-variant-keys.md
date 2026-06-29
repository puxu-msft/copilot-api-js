---
name: reference-new-headers-comma-joins-case-variant-keys
description: new Headers(record) 对异大小写同名键逗号拼接而非覆盖——头合并护栏不能靠 spread 顺序
metadata:
  type: reference
---

REFERENCE（Bun + Web 标准，已 `bun -e` 实测）：`new Headers(record)` 对**异大小写同名键**做**逗号拼接**，不是后者覆盖前者。

```
new Headers({ authorization: "Bearer A", Authorization: "Bearer B" })
  → get("authorization") === "Bearer A, Bearer B"   // 拼接!
```

普通 JS 对象 `{ authorization, Authorization }` 是**两个不同键**，`{ ...low, ...High }` spread 两个都保留；只有等到 `new Headers(obj)` 这一步才按 lowercased 折叠、且**拼接**而非取一个。

**后果与护栏**：任何"合并两组头再 `new Headers`"的代码，**绝不能靠 spread 顺序实现"某组优先"**——异大小写撞键会把两边的值拼起来（如客户端 `authorization` + 代理 `Authorization` → 畸形双 Bearer，把客户端凭证拼给上游）。正确做法是在 merge **之前**按 **lowercased** 把要让位的那组里所有与优先组同名（lowercased）的键**剔除干净**，使两组按 lowercased 无交集，`new Headers` 才不会拼接。

落地于 `anthropic.strict_request_headers` 透传（`buildAnthropicHeaders` + `selectPassthroughHeaders`，见 [[feedback-self-consistent-needs-independent-oracle]] 的独立 oracle 思路：用真实 `new Headers` 实测裁决而非凭直觉）：`coreLower = new Set(Object.keys(core).map(toLowerCase))` 从**实际构造出的** core 对象动态取键，`selectPassthroughHeaders` 据此剔除 passthrough 里所有 core 键后才 `{...pass, ...core}`。同样适用于 OpenAI/Gemini 若将来加请求头透传。两轮 plan review 中这是被推翻的 CRITICAL 假设（最初以为 spread 顺序=优先）。
