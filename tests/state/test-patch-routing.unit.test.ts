/**
 * `setStateForTests` patch routing, and the registry that makes it domain-agnostic.
 *
 * S4 inverted the credential shim: `state.ts` used to import the token store directly and hard-code
 * the four credential keys, which is a dependency running the wrong way — `packages/token` already
 * depends on foundation, and `state` is moving INTO foundation
 * (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md). Domains now register a participant instead,
 * and `src/lib/token-runtime.ts` (core, already the bridge between the two) registers the token one.
 *
 * The red line for that inversion is that all 629 existing `setStateForTests(...)` call sites keep
 * their arguments EXACTLY as they were. The two ways to break it invisibly are both pinned here:
 *
 *  1. **Silently ignoring keys nobody claims.** That is the shape an implementer reaches for to make
 *     the suite green without wiring registration, and it passes every existing test while credential
 *     isolation between tests is simply gone.
 *  2. **Losing `"key" in patch` semantics.** `setStateForTests({ copilotToken: undefined })` is how
 *     tests assert the unauthenticated path; treating an explicit `undefined` as "absent" makes it a
 *     no-op that inherits the previous test's token.
 *
 * The third test guards the routing table itself: `State`'s optional fields do not exist on the state
 * object until written, so the cheap `key in mutableState` test reports false for them and they would
 * be misrouted as unowned.
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

import type { StateSnapshot } from "~/lib/state"

import {
  //
  clearSnapshotParticipantsForTests,
  registerSnapshotParticipant,
  restoreStateForTests,
  setStateForTests,
  snapshotStateForTests,
  state,
} from "~/lib/state"
import {
  //
  installDefaultTokenDeps,
  installDefaultTokenRuntime,
} from "~/lib/token-runtime"
import { getTokenCredentials } from "~/lib/token/store"

/**
 * Deliberately NOT `useIsolatedRuntime()`. These tests touch nothing but the state object and the
 * participant registry, and that fixture bootstraps a whole runtime per test — enough extra load,
 * with 16 shards running in parallel, to starve a neighbour in the same shard that spawns its own
 * runtime and drives 160 concurrent in-handler queries (`tests/history/search/uds-transport.it`
 * timed out at 30s in the full tier while passing in isolation, purely from this file being added).
 * A snapshot/restore pair is all the isolation this file's subject matter needs.
 */
beforeEach(() => {
  snapshot = snapshotStateForTests()
})

afterEach(() => {
  restoreStateForTests(snapshot)
})

let snapshot: StateSnapshot

/**
 * Run `body` against an EMPTY participant registry, then put the real wiring back — synchronously,
 * inside the test.
 *
 * Not an `afterEach`: the fixture's own `afterEach` restores state from a snapshot taken by
 * `snapshotStateForTests`, and restoring participant slices needs the participants to still be
 * registered. Leaving the registry cleared until a hook that may run in either order is how this
 * file leaked a bogus participant and a stale credential into the NEXT test file — which is the
 * pollution rule this repo already learned: the polluter cleans up, the victim does not patch
 * around it.
 */
function withClearedRegistry(body: () => void): void {
  clearSnapshotParticipantsForTests()
  try {
    body()
  } finally {
    clearSnapshotParticipantsForTests()
    installDefaultTokenDeps()
  }
}

describe("setStateForTests 的 patch 路由", () => {
  test("无人认领的键**抛错**，而不是被静默忽略", () => {
    withClearedRegistry(() => {
      // 这一条是整个反转的承重断言：静默忽略同样能让全套件变绿，而凭据隔离已经没了。
      expect(() => setStateForTests({ copilotToken: "tok" })).toThrow(/no snapshot participant claims/)
    })
  })

  test("错误信息点名缺失的键与当前已注册的参与者（否则接手的人无从下手）", () => {
    withClearedRegistry(() => {
      registerSnapshotParticipant({ name: "other", claims: ["somethingElse"], snapshot: () => null, restore: () => {}, applyTestPatch: () => {} })
      expect(() => setStateForTests({ githubToken: "g" })).toThrow(/`githubToken`[\s\S]*other/)
    })
  })

  test("凭据键路由到 token 参与者，不落进 state", () => {
    setStateForTests({ copilotToken: "tok-1", githubToken: "gh-1" })
    expect(getTokenCredentials().copilotToken).toBe("tok-1")
    expect(getTokenCredentials().githubToken).toBe("gh-1")
    expect((state as unknown as Record<string, unknown>).copilotToken).toBeUndefined()
  })

  test('保留 `"key" in patch` 语义：显式 undefined 清空、缺席不动', () => {
    setStateForTests({ copilotToken: "tok-2", githubToken: "gh-2" })

    setStateForTests({ copilotToken: undefined })
    expect(getTokenCredentials().copilotToken).toBeUndefined()
    // githubToken 缺席 ⇒ 不动。这两种情况一旦被合并，测试就会静默继承上一条测试的凭据。
    expect(getTokenCredentials().githubToken).toBe("gh-2")
  })

  test("State 的可选字段仍然走 state 路由（它们在 state 对象上并不存在，最容易被误判成无人认领）", () => {
    // 三个可选字段一次全走一遍。任何一个被误判都会抛错。
    expect(() => setStateForTests({ models: undefined, vsCodeVersion: "1.2.3", adaptiveRateLimitConfig: undefined })).not.toThrow()
    expect(state.vsCodeVersion).toBe("1.2.3")
  })

  test("OPTIONAL_STATE_FIELDS 清单没有相对 State 声明漂移", () => {
    const source = readFileSync(path.resolve(import.meta.dir, "../../packages/foundation/src/state.ts"), "utf8")
    const sourceFile = ts.createSourceFile("state.ts", source, ts.ScriptTarget.Latest, true)

    let declaration: ts.InterfaceDeclaration | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === "State") declaration = node
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    expect(declaration, "State 接口没找到——本守卫已经失去目标，先修它再谈通过").toBeDefined()

    const optional = declaration!.members
      .filter((member) => ts.isPropertySignature(member) && member.questionToken)
      .map((member) => (member.name as ts.Identifier).text)
    const listed = /const OPTIONAL_STATE_FIELDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? ""
    const listedNames = [...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1])

    expect(listedNames.sort(), "State 的可选字段变了，state.ts 里的 OPTIONAL_STATE_FIELDS 要同步").toEqual(optional.sort())
  })
})

describe("snapshot / restore 参与者", () => {
  test("快照带上参与者切片，restore 一并还原", () => {
    setStateForTests({ copilotToken: "before" })
    const snapshot = snapshotStateForTests()

    setStateForTests({ copilotToken: "after" })
    expect(getTokenCredentials().copilotToken).toBe("after")

    restoreStateForTests(snapshot)
    expect(getTokenCredentials().copilotToken).toBe("before")
  })

  test("两个注册入口都真的注册（各自单独证明，否则其中一行没有存在理由）", () => {
    // 测试地板走 installDefaultTokenDeps，生产构造链走 installDefaultTokenRuntime。两条路径都必须
    // 让凭据键可用——只测其中一条，另一行被删掉时没有任何 oracle 会红。
    for (const install of [installDefaultTokenDeps, installDefaultTokenRuntime]) {
      clearSnapshotParticipantsForTests()
      try {
        expect(() => setStateForTests({ copilotToken: "x" })).toThrow()
        install()
        expect(() => setStateForTests({ copilotToken: "x" })).not.toThrow()
      } finally {
        clearSnapshotParticipantsForTests()
        installDefaultTokenDeps()
      }
    }
  })

  test("异名参与者声明同一个 claim 会被拒（而不是按注册顺序静默选第一个）", () => {
    withClearedRegistry(() => {
      const make = (name: string): Parameters<typeof registerSnapshotParticipant>[0] => ({
        name,
        claims: ["sharedKey"],
        snapshot: () => null,
        restore: () => {},
        applyTestPatch: () => {},
      })
      registerSnapshotParticipant(make("first"))
      // 静默按顺序选第一个的话，second 永远收不到它的键，而 snapshot/restore 仍两边都跑——
      // 表现为「某个域莫名其妙没被重置」，是最难查的那类测试隔离 bug。
      expect(() => registerSnapshotParticipant(make("second"))).toThrow(/both claim .*sharedKey/)
    })
  })

  test("参与者是按名字幂等的：重复注册替换而不是叠加", () => {
    withClearedRegistry(() => {
      let restores = 0
      const participant = { name: "dup", claims: ["dupKey"], snapshot: () => 1, restore: (): void => void restores++, applyTestPatch: () => {} }
      registerSnapshotParticipant(participant)
      registerSnapshotParticipant(participant)

      restoreStateForTests(snapshotStateForTests())
      expect(restores).toBe(1)
    })
  })
})
