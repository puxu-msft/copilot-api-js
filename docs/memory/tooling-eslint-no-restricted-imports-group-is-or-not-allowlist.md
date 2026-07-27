---
name: tooling-eslint-no-restricted-imports-group-is-or-not-allowlist
description: ESLint no-restricted-imports 的 patterns.group 是 OR 语义，["**", "!allowed"] 会退化成「匹配一切」，写不出 allowlist；要 allowlist 必须用 patterns.regex + 负向先行断言
metadata:
  type: project
---

ESLint `no-restricted-imports` 的 `patterns[].group` **是 OR 语义的 glob 列表**，不是 gitignore 那种「后面的否定覆盖前面」的顺序语义。所以想写「只许 A/B/C，其余全拒」时，直觉写法

```js
group: ["**", "!./**", "!node:*", "!@hsupu/ghc-proxy-foundation/**"]
```

**会退化成「匹配一切」**——因为 `**`（匹配全部）与各条否定项是 OR 起来的。实测症状：包内每一条**合法**的相对 import（`./db`、`./sketch`）和 foundation import 全被报违规。

正解是用 `patterns[].regex` + 负向先行断言把 allowlist 写成一条正则：

```js
{
  regex: String.raw`^(?!\.{1,2}/|node:|@hsupu/ghc-proxy-foundation(?:/|$)|consola(?:/|$)|@datadog/sketches-js(?:/|$)).+`,
  message: "…",
}
```

**Why:** monorepo 包边界天然是 allowlist 形状（「只许相对 + foundation + node: + 已声明 external」）。用 denylist 写会随 workspace 长出新包而**静默放行 sibling**（见 [[methodology-domain-peel-execution-techniques]] 技巧 10）；而 `group` 又写不出 allowlist——两头堵，只有 `regex` 这条路。

**How to apply:** 给新抽的包加 ESLint 边界规则时直接上 `regex`，别浪费一轮在 `group` 上。写完**务必实跑** `bunx eslint packages/<pkg>/src` 确认：① 违规 import 真的红（正样本）② 包内合法的相对 / foundation / external import 一条都不红（负样本）——本条记忆就是被负样本全红戳破的。unit 侧的对应守卫（`tests/architecture/package-boundaries.unit.test.ts`）不受此限，那里是自己写检测函数，正常写 allowlist 即可。

**Related:** [[methodology-domain-peel-execution-techniques]]、[[feedback-pass-null-clean-not-self-validating]]（守卫「绿」不自证，要正负样本对照）。
