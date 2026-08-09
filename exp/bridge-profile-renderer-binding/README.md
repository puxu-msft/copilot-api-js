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

四处观测点：

| 位置 | 构造 | 实测 |
|---|---|---|
| `widened` | `satisfies Record<string, Profile<BridgeTargetFormat>>` + 错配 | **无报错**（false-green） |
| `good` | 零参封闭联合 + 正确装配 | 无报错（无 false-red） |
| `bad` | 零参封闭联合 + 错配 | **TS2322**（有判别力） |
| `postureO` | 带宽默认值的泛型别名裸用 + 错配 | **无报错**（false-green） |

**`postureO` 是第五轮补上的**，它击穿了第四轮的不变量措辞。当时只写「具体实例化的联合」，而 `type HelperProfile<TF extends BridgeTargetFormat = BridgeTargetFormat> = Profile<TF>` 裸用时**字面上像联合别名、实际等价于宽实例化**。因此不变量收紧为「**零类型参数的封闭联合**」。

独立评审另外实测了 7 类姿势（helper 泛型 identity 中转、`Object.assign`／spread、`Partial<Record>`、裸索引签名、分两步赋值、mapped-type 分布式生成、共享 builder 返回宽类型），在零参封闭联合下**全部正确报红**。

## 为什么重要

`src/lib/pipeline/hub-translate.ts` 现有 `satisfies Record<ClientFormat, Record<UpstreamEndpoint, RequestBridge>>` 正是宽容器形状。实施者照房内既有惯例写 registry，就会落进 false-green 那一格，而只测「具体实例化」的负样本完全看不见这个姿势。

## 它没有证明什么

- **没有**证明具体的 `AnyRequestBridgeProfile` 别名该怎么写。真实 `RequestBridgeProfile` 另有 8 个类型参数，本 PoC 的 `Profile<TF>` 只保留了 `targetFormat` 与 `errorRenderer` 两个字段。那 8 个参数在联合臂里取何值（各臂独立推断／existential／helper 泛型）**未实测**。
- **没有**证明姿势已穷举。第四轮我以为两种姿势够了，第五轮独立评审就找出了 Posture O。**「我想不出还有别的写法」不构成证据**——这份 PoC 的历史本身就是反例。
- **没有**证明消费侧不需要 correlated narrowing。本 PoC 未构造「泛型体内按 `targetFormat` 窄化 `errorRenderer`」的用法；已知 TS 不做跨字段相关性窄化，若将来消费侧真要窥探具体字段，需另行设计。
- **没有**覆盖 `ResponseBridgeProfile`——它的字段集不同，本 PoC 只建模了 request 侧的两字段形状。

## 归属

规格 §11 的不变量与 P1 Task 1.6 Step 5b 的两格负样本以此为依据。
