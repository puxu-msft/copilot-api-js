# ADR: 暂缓 TypeScript 6 升级（受 @types/bun 阻塞）

- **状态**：Deferred（暂缓，待外部约束解除）
- **日期**：2026-07-05（实测裁决 2026-06-22）
- **相关**：[dependency-selection-bun-first.md](2026-07-05-dependency-selection-bun-first.md)、skill `bun-node-runtime-gotchas`

## 背景

本项目 bun-first：Bun 是一等运行时，`bun:test` 是唯一测试器，`import.meta.dir` 遍布代码。升级 TypeScript 到 6.0.x 是路线图上的正确方向（更严格的类型检查、新特性），但需要一条明确的「能不能升、卡在哪」的裁决，避免把「工具生态没跟上」误归因为「项目代码有问题」而反复评估。

## 定夺

**暂不升 TS6。唯一硬阻塞是 Bun 的类型包 `@types/bun` / `bun-types` 在 TS6 下无法解析——不是项目代码的问题。** 待 Bun 发布 TS6 兼容的 `@types/bun` 再议。

实测裁决（2026-06-22，TypeScript 6.0.3 + `@types/bun`/`bun-types` 1.3.14 当时 latest）：

- `"types": ["bun"]` 直接 `TS2688: Cannot find type definition file for 'bun'`，连带 270 个错误**全是下游级联**：`Bun` 全局丢失、`bun:test` 模块找不到、`import.meta.dir` 未类型化、test 回调因失去 `bun:test` 类型而 `noImplicitAny`（TS7006）。
- **项目自身代码零 TS6 错误**——把 270 个 @types/bun 级联剔除后，没有任何 TS6 语法/严格性新错。即 TS6 编译本项目 OK，卡的是 Bun 类型生态没跟上 TS6 的 type-package 解析。
- 对 **bun-first** 项目这是**不能丢 Bun 类型**的硬墙。

**纠正旧 defer 理由**：此前（commit `1966b0a`）把 TS6/eslint10 都归因于 `@echristian/eslint-config` 所 pin 的 `typescript-eslint@8.45` peer 封顶 `typescript <6.0.0` / `eslint <10`。后续 hardening 显式加 `typescript-eslint ^8.45.0` → 解析到 **8.61.1**，其 peer 已放宽到 `typescript >=4.8.4 <6.1.0`（**支持 TS6.0.x**）、`eslint ^8||^9||^10`（**支持 eslint10**）；`vue-tsc 3.3.5` peer `>=5.0.0` 也支持 TS6。所以 **typescript-eslint 不再是 TS6 阻塞**——真正阻塞换成了 @types/bun。eslint10 的阻塞需重新评估（typescript-eslint 已不挡，但 `@echristian/eslint-config` 自身 peer 与其它插件待核）。

**前后端「严格拆分」与 TS6 无关**：FE/BE split 是「ui 作 bun workspace 成员」，`typescript`/`eslint`/`tsdown` 等仓库级 dev 工具**仍单一留在 root**，未按端拆分 TS 版本。故「只给后端升 TS6」不成立（一个共享 tsc）；TS6 是 repo-wide 决策。

## 复核 / 退出条件（将来重新评估时的复现手段）

Bun 发新 `@types/bun`（声称 TS6 兼容）后，按此实测复核阻塞是否解除：

1. `tsc --version` 确认 6.0.x。
2. `bun run typecheck 2>&1 | grep "error TS"` 计数。
3. `... | grep -ivE "Bun|bun:test|globalThis|ImportMeta|implicitly.*any"` 剔除 @types/bun 级联，看是否还有真 TS6 错（2026-06 本次为零）。
4. `tsconfig` 加 `"types":["bun"]` 探 `TS2688` 确认是否仍是 type-package 解析层失败。
5. `baseUrl` 弃用（TS6 deprecate、TS7 移除）用 `"ignoreDeprecations":"6.0"` 可消、非阻塞。

若第 4 步不再 `TS2688` 且第 3 步仍为零，则阻塞解除、可升。
