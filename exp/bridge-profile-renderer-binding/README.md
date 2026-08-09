# PoC：profile `targetFormat` ↔ `errorRenderer` 的类型级绑定

**结论（实测，tsc 5.9.3 `--strict`）**：条件类型 `CompatibilityErrorRendererFor<TF>` 只在 `TF` 为**字面量**时有判别力。把 profile 存进以**宽联合** `BridgeTargetFormat` 实例化的容器后，错配**编译通过、零报错**；换成**具体实例化的联合**则报 `TS2322`，且正确装配不误红。

## 复现

```bash
node_modules/.bin/tsc --noEmit --strict exp/bridge-profile-renderer-binding/union-container.ts
```

预期输出（`bun-types` 的 ambient 报错是环境噪声，与本 PoC 无关）：

```
union-container.ts(33,3): error TS2322: Type '{ targetFormat: "anthropic-messages"; errorRenderer: ResponsesRenderer; }' is not assignable to type 'AnyProfile'.
  The types of 'errorRenderer.targetFormat' are incompatible between these types.
    Type '"openai-responses"' is not assignable to type '"anthropic-messages"'.
```

三处观测点：

| 位置 | 构造 | 实测 |
|---|---|---|
| `widened` | `satisfies Record<string, Profile<BridgeTargetFormat>>` + 错配 | **无报错**（false-green） |
| `good` | 具体实例化联合 + 正确装配 | 无报错（无 false-red） |
| `bad` | 具体实例化联合 + 错配 | **TS2322**（有判别力） |

## 为什么重要

`src/lib/pipeline/hub-translate.ts` 现有 `satisfies Record<ClientFormat, Record<UpstreamEndpoint, RequestBridge>>` 正是宽容器形状。实施者照房内既有惯例写 registry，就会落进 false-green 那一格，而只测「具体实例化」的负样本完全看不见这个姿势。

## 它没有证明什么

- **没有**证明具体的 `AnyRequestBridgeProfile` 别名该怎么写。真实 `RequestBridgeProfile` 另有 8 个类型参数，本 PoC 的 `Profile<TF>` 只保留了 `targetFormat` 与 `errorRenderer` 两个字段。那 8 个参数在联合臂里取何值（各臂独立推断／existential／helper 泛型）**未实测**。
- **没有**证明消费侧不需要 correlated narrowing。本 PoC 未构造「泛型体内按 `targetFormat` 窄化 `errorRenderer`」的用法；已知 TS 不做跨字段相关性窄化，若将来消费侧真要窥探具体字段，需另行设计。
- **没有**覆盖 `ResponseBridgeProfile`——它的字段集不同，本 PoC 只建模了 request 侧的两字段形状。

## 归属

规格 §11 的不变量与 P1 Task 1.6 Step 5b 的两格负样本以此为依据。
