---
name: reference-ts6-blocked-by-bun-types
description: REFERENCE：TS6 升级对本 bun-first 项目的真实阻塞是 @types/bun 在 TS6 下解析失败(TS2688)，非代码问题、非 typescript-eslint(已支持)
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2f1f6a9c-4ff0-4c5b-a1cc-2dabc506a356
---

2026-06-22 实测裁决：TypeScript 6.0.3 升级在本项目(copilot-api-js, bun-first)**唯一硬阻塞是 Bun 的类型包 `@types/bun`/`bun-types`(1.3.14, 当时 latest)在 TS6 下无法解析**——`"types": ["bun"]` 直接 `TS2688: Cannot find type definition file for 'bun'`，连带 270 个错误全是下游级联:`Bun` 全局丢失、`bun:test` 模块找不到、`import.meta.dir` 未类型化、test 回调因失去 `bun:test` 类型而 `noImplicitAny`(TS7006)。

**关键:项目自身代码零 TS6 错误**——把 270 个 @types/bun 级联剔除后没有任何 TS6 语法/严格性新错。即 TS6 编译本项目 OK,卡的是 Bun 类型生态没跟上 TS6 的 type-package 解析。对**bun-first**项目(Bun 是一等运行时、`bun:test` 是唯一测试器、`import.meta.dir` 遍布)这是**不能丢 Bun 类型**的硬墙,故 TS6 暂不可行,待 Bun 发 TS6 兼容的 `@types/bun` 再议。

**纠正旧 defer 理由**:此前(本会话早期 commit `1966b0a`)把 TS6/eslint10 都归因于 `@echristian/eslint-config` 所 pin 的 `typescript-eslint@8.45` peer 封顶 `typescript <6.0.0` / `eslint <10`。但后续 hardening 显式加了 `typescript-eslint ^8.45.0` → 解析到 **8.61.1**,其 peer 已放宽到 `typescript >=4.8.4 <6.1.0`(**支持 TS6.0.x**)、`eslint ^8||^9||^10`(**支持 eslint10**)。`vue-tsc 3.3.5` peer `>=5.0.0` 也支持 TS6。所以 **typescript-eslint 不再是 TS6 阻塞**——真正阻塞换成了 @types/bun。eslint10 的阻塞也需重新评估(typescript-eslint 已不挡,但 @echristian/eslint-config 自身 peer 与其它插件待核)。

**前后端"严格拆分"与 TS6 无关**:本项目的 FE/BE split 是"ui 作 bun workspace 成员",`typescript`/`eslint`/`tsdown` 等仓库级 dev 工具**仍单一留在 root**(见 [[feedback-bun-first-dependency-selection]] 域),并未按端拆分 TS 版本。故"只给后端升 TS6"不成立(一个共享 tsc);TS6 是 repo-wide 决策。

复现/裁决手段:`tsc --version` 确认 6.0.3 → `bun run typecheck 2>&1 | grep "error TS"` 计数 → `grep -ivE "Bun|bun:test|globalThis|ImportMeta|implicitly.*any"` 剔除级联看是否还有真 TS6 错(本次为零)→ `tsconfig` 加 `"types":["bun"]` 探 TS2688 确认是 type-package 解析层失败。baseUrl 弃用(TS6 deprecate、TS7 移除)用 `"ignoreDeprecations":"6.0"` 可消、非阻塞。
