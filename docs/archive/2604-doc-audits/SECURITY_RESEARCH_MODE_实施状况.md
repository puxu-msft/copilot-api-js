> **⚠️ 已归档（2026-06-28）——陈旧的 2026-04-14 文档审查快照，勿当当前状态依据。** 见同目录 [README.md](README.md)。
> 本快照结论：docs/SECURITY_RESEARCH_MODE.md 描述的功能当时代码中不存在（"尚未实现"类）。未重新核验，仅作历史记录。

# SECURITY_RESEARCH_MODE.md 实施状况

> 审查日期：2026-04-14
> 对照源码验证 docs/SECURITY_RESEARCH_MODE.md 中每项声明的准确性

## 总体评价：❌ 文档描述的功能在代码库中不存在

---

## 验证结果

### 1. "--security-research-mode 选项"

**状态：❌ 不存在**

搜索整个代码库（`src/`、CLI 参数定义、配置文件），未找到：
- `--security-research-mode` CLI 参数
- `security-research-mode` 配置项
- 任何引用 "security research" 的运行时代码

### 2. "src/lib/security-research-mode.ts"

**状态：❌ 文件不存在**

目标文件 `src/lib/security-research-mode.ts` 不存在于代码库中。

### 3. System prompt 清洗和注入

**状态：❌ 无对应实现**

文档描述的 system prompt 模式移除和 `<security_research_environment>` 块注入均无代码实现。

---

## 结论

此文档描述的是一个**已被移除或从未合并**的功能。文档本身具有参考价值（作为安全层级模型的分析），但不反映当前代码库的任何实际功能。

**建议**：移入 `docs/archive/` 或在文档顶部标注"此功能已移除"。
