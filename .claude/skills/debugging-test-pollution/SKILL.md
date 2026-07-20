---
name: debugging-test-pollution
description: 当 copilot-api-js 后端测试「单跑通过、全套件失败」（或反之、或随 --shuffle 时好时坏）时用于定位——bun 单进程跨文件共享 module-global 单例（state/models/config/mock）泄漏。含读泄漏值→grep 变异点→配对复现→识破 gated 污染者（describeWithToken/beforeAll）的诊断法，与「污染者负责还原、非受害者打补丁」的修复取向。写隔离测试的基建见 skill test-isolation。
---

# 调试跨文件测试污染（bun 单进程）

`bun test` 把整套后端在**一个进程**里跑，`~/lib/state`、models 缓存、config、mock 等 module-global 单例跨文件存活。一个文件变异了全局却不还原 → 后续文件继承脏值 → 出现「单跑绿、全套件红」的**顺序依赖失败**。这类失败**不是被测代码的 bug**，是测试污染。

## 症状识别

- 某测试全套件失败，但 `bun test <该文件>` 单跑通过（或反之）。
- 失败随文件集合/顺序变化（加一个无关文件就翻绿/翻红）。
- 断言值是「别的测试的配置」（如期望默认 `false` 实得 `true`），而非逻辑错。

## 诊断流程

**① 抓泄漏的确切变量与值，别停在「测试挂了」。** 全套件跑、抓失败断言的 received vs expected：

```bash
bun test 2>&1 | grep -A12 "<失败测试名>"
```

`Expected: false / Received: true` + 断言行 `expect(state.stripServerTools).toBe(...)` → 泄漏变量 = `state.stripServerTools`、脏值 = `true`。日志里的旁证（如 `[DirectAnthropic] Stripping server tool: web_search`）确认同一脏值也在改被测行为——**多个失败常同源**（本例 config drift-guard 与 web_search double-hop 都是 `stripServerTools=true` 一个泄漏）。

**② grep 谁变异它、谁不还原。** 找所有把它设成脏值的文件，逐个看有没有配套还原（`afterEach`/`afterAll`/`autoRestoreState`/`useIsolatedRuntime`）：

```bash
grep -rln "stripServerTools.*true\|stripServerTools: true" tests/
grep -nE "afterAll|afterEach|autoRestoreState|useIsolatedRuntime|setStateForTests" tests/<候选>
```

有还原的（配对能自净）先排除。

**③ 配对复现确认污染者。** 单进程里污染跨文件传递，`<污染者> <受害者>` 一起跑即可复现：

```bash
bun test tests/<候选>.test.ts tests/<受害者>.test.ts 2>&1 | grep -E "<失败测试名>|[0-9]+ (pass|fail)"
```

**坑：gated 污染者会让配对假绿。** 本例 `e2e/copilot-api.test.ts` 与 `e2e/extended-api.test.ts` 都在 `describeWithToken`（`getE2EMode() !== "mock" ? describe : describe.skip`）里、`beforeAll` 才 `setStateForTests({stripServerTools:true})`。copilot-api 的 `beforeAll` 无 token 时先 `throw`（setState 没跑到）→ 配它假绿；extended-api 跑到了 setState → 配它才红。**别因一个候选配对通过就排除整类**——同形候选逐个配、看日志确认 setState 真跑了。gated e2e 在本机（`getE2EMode()!=="mock"` 且有 GITHUB_TOKEN）会真跑真污染。

**④ 理解受害者为何没自保。** `useIsolatedRuntime` 的 per-test 快照是 `snapshotStateForTests()` **快照当前值、非重置默认**（fixture 假设「快照时状态是 pristine」）；上游文件留脏 → 快照到脏值 → 整个受害文件继承。受害者 beforeEach 若没显式重置该字段，就靠这个 pristine 假设。

## 修复取向：污染者还原，别给受害者打补丁

根因是「变异全局却不还原」，修在**污染者**（一处修好所有下游受害者），不是逐个给受害者加防御。

- 变异在 `beforeEach`/测试体 → `autoRestoreState()`（per-test 快照 + afterEach 还原）。
- **变异在 `beforeAll`**（跑一次、后续测试依赖脏值）→ **不能**用 autoRestoreState（afterEach 会在首个测试后就还原掉后续测试要的值）。用「模块级快照 + `afterAll` 还原」：
  ```ts
  const fileStateSnapshot = snapshotStateForTests()  // 模块加载时 = 干净
  describeWithToken("...", () => {
    afterAll(() => restoreStateForTests(fileStateSnapshot))
    beforeAll(() => { setStateForTests({ stripServerTools: true, ... }) })
  })
  ```
  模块级快照在 import 时取（此时 pristine）；`afterAll` 只在块真跑时注册（`describe.skip` 内不注册），跑完还原全部字段。既有范例 `tests/anthropic/server-tool-rewriting.it.test.ts`（顶层存 original + afterAll 还原）。

## 验证

修完**全套件**跑，确认目标失败清零、无新增：

```bash
bun test 2>&1 | grep -E "[0-9]+ (pass|fail)|\(fail\)"
```

否定性核验：修前先证明「配对能复现失败」（正样本），否则改完的绿可能是假绿（skill empirical-verification、verifying-authoritative-claims）。跨 runtime/顺序敏感的还可 `bun test --rerun-each=N` 或打乱顺序连跑确认确定性。

## 相关

- 写隔离测试的基建（`useIsolatedRuntime`/`RESETTERS`/sandbox/后缀分层）：skill `test-isolation`。
- 战例经验：[[feedback_tests_never_touch_real_env]]、[[methodology-sync-to-async-persistence-refactor-invariants]]（teardown drain 顺序）。
