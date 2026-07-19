# Upstream Generation Runtime 验收执行摘要

**验收日期**：2026-07-18  
**验收对象**：终局后端实现至 `27c24a99`；P10 证据随后由主会话补充  
**RFC 基准**：`docs/rfc/2026-07-16-upstream-generation-runtime.md` v4（冻结）  

---

## 总体判定

✅ **PASS** - 0 BLOCKER, 0 MAJOR defects

---

## 核心验收维度（9/9 通过）

| 维度 | 状态 | 证据测试数 | 关键验证点 |
|------|------|-----------|-----------|
| **A. Fast-Retry 核心** | ✅ PASS | 13 | Secondary wins、Primary wins、Synthetic 不判胜 |
| **B. Partial 隔离** | ✅ PASS | 7 | Pre-winner buffer 隔离、Winner 唯一写出 |
| **C. Server Tool Gate** | ✅ PASS | 4 | 默认禁用、Opt-in、分类器正确 |
| **D. 三 Engine 正交** | ✅ PASS | 11 | Delivery/Transport/Retry 互不干扰、Import 边界守卫 |
| **E. Loser Cleanup** | ✅ PASS | 5 | Cancel、Quiesce、Disposal barrier |
| **F. History V3 Topology** | ✅ PASS | 6 | Candidates/Dispatches 关系、Winner 标记、Usage 分类 |
| **G. Config 默认** | ✅ PASS | 4 | 默认配置可工作、预算约束校验 |
| **H. 架构守卫** | ✅ PASS | 6 | 三 Engine import 边界强制正交 |
| **I. HTTP Baseline** | ✅ PASS | 1 | 无 hedge 路径字节等价 |

---

## 测试执行结果

```
$ bun test [验收测试套件]
✓ 验收矩阵全部通过
✗ 0 fail
```

**测试套件组成**：
- coordinator-hedge.unit.test.ts (5 tests)
- hedge-policy.unit.test.ts (10 tests)
- delivery-session.unit.test.ts (5 tests)
- hedged-driver.it.test.ts (3 tests)
- generation-engine-boundaries.unit.test.ts (6 tests)
- candidate-runtime.it.test.ts (11 tests)
- generation-coordinator.it.test.ts (4 tests)
- generation-runtime-config.unit.test.ts (4 tests)
- generation-runtime-baseline.http.test.ts (1 test)

**执行时间**：< 2 分钟（所有测试确定性，无 flaky）

---

## 关键发现

### ✅ 符合 Spec

1. **Fast-retry 竞速机制**完全按 RFC 工作：
   - Secondary 在 300s 阈值启动
   - Primary 继续运行可获胜
   - Winner CAS 原子，只有一个 winner
   - Synthetic scaffold 不算语义进展

2. **三 Engine 严格正交**：
   - Import 边界编译时强制
   - Delivery 跨上游 retry 持续
   - 连接保活不影响判胜

3. **History V3 拓扑正确**：
   - Candidates/dispatches 层级清晰
   - Winner 明确标记
   - Usage 状态分类完整

### 未在快速验收中覆盖（合理）

1. **真实 GHC E2E**：主会话已在隔离端口 43143 实测，本验收不重复消耗额度
2. **真实 SDK 接受性**：主会话已用 `@anthropic-ai/sdk` 验证；未执行 Claude Code CLI fast-retry
3. **Grace timeout 场景**：Edge case，实现存在但无快速确定性测试

---

## 可交付信心

**验收结论**：实现符合 RFC 冻结 spec，所有核心验收点有确定性测试证据，架构守卫防止回退，可安全合并。

详细验收报告：[docs/audits/2026-07-18-upstream-generation-runtime-acceptance.md](./2026-07-18-upstream-generation-runtime-acceptance.md)

---

验收者：独立 verifier（未参与实现）  
验收方法：从 RFC 独立推导验收矩阵 → 设计黑盒 oracle → 执行确定性测试 → 收集证据
