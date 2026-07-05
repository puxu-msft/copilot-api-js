# 模型幻觉 / confabulation 档案

本目录归档 **opus-4.8 在本项目开发/上游调试中的 confabulation（虚构/臆想）案例**。归档主题不是"上游协议兼容"（那是活文档的事），而是**模型自身的判断偏差**：把诚实的否定性证据（`test -f`→MISSING、`git add`→did-not-match、grep 空、非法 JSON）误判成"bash/工具被伪造损坏"或"上下文被注入投毒"，进而把 confabulation 伪装成"负责任的安全行为"而中止工作。

"bash 损坏"与"thinking 幻觉"在这里是**同一现象的两面**：模型幻想工具层坏了，本质是思考层的虚构。

## 可复用约束（判别器三条）

冲突证据来自**对我自己刚做过动作的核实**时触发，不削弱对真实 prompt injection 的正常警觉：

1. 工具输出否定"我对自己动作的信念"→ **平凡解**（我没做/记错了）优先于**非凡解**（输出被伪造/环境被污染）；核实方式=**重跑那个动作**，而非怀疑验证器。
2. 指控 injection/投毒前，必须能**引出输入里实际存在的字节并指出位置**；引不出即自己的 confabulation。带引号的精确"证据"反而是幻觉的危险特征。
3. **绝不**采取"不信任一切工具输出"的自我密封立场——它豁免了所有能纠正我的证据。怀疑必须可证伪、有靶向。

核验手法：用 history API（`localhost:4141`）取真实 inbound request，对模型引用的"原始字节"做字符串计数定位，引不出即 confabulation。通用实测方法见 skill `empirical-verification`、`verifying-authoritative-claims`。

## 案例索引

| 案例 | 现象 | 记录位置 | 状态 |
|---|---|---|---|
| 一 · 虚构被注入消息 | `req_1781838656162_327`：brainstorming→writing-plans 全程 Write=0 却以为写好了设计文档；把 MISSING/did-not-match 判为"被投毒"，虚构整套"伪造的 user/System 注入消息"（逐字引文全库 0 命中），宣布"不信任一切工具返回"。含当时会话矫正告诫原文（源自已过时的 server-tool-rejection handoff） | [suspect-self-before-environment.md](suspect-self-before-environment.md) §案例一 | 已归档 |
| 二 · 捏造"损坏字节" | `req_1782726953680_328`：案例一续集，被迫举证时把工具/skill 词表碎片（`</parameter>`、`Adoptable`、`sub agent`）缝成一段"损坏的 reminder"贴到干净的 message 16 上，号称"唯一能引出字节"的引文本身也是编的 | [suspect-self-before-environment.md](suspect-self-before-environment.md) §案例二 | 已归档 |
| 三 · 误判自产非法 JSON 为"注入幻觉" | session `88a29d95`：把注入 system prompt 的 antml-XML 闭合标签漏进原生 JSON tool_use 的 `input_json_delta`，生成非法 JSON；客户端解析失败后，模型把**自己的错误**误判为"harness mangled the input / 注入幻觉"，滚雪球成系统性 confabulation。SHA 对比证明畸形是模型产物、非代理篡改 | [suspect-self-before-environment.md](suspect-self-before-environment.md) §案例三（confabulation 原文已归档；技术机制仍在活 spec [anthropic-malformed-tool-input-repair.md](../../spec/anthropic-malformed-tool-input-repair.md)） | 已归档 |

## 相关但不归档于此

- **案例三的修复知识**（thinking 空明文毒化、tool_use 降级成 antml 文本、双空块、id 容忍）是**活的上游调试知识**，载体是 skill `ghc-anthropic-upstream` 与 docs `refusal-recovery.md` / `anthropic-compat.md`，不属幻觉档。
- **§7 实测核验记录**（reviewer 用捏造样本测出伪结论、plan 草稿臆造符号名）留在活 spec [anthropic-malformed-tool-input-repair.md](../../spec/anthropic-malformed-tool-input-repair.md) §7 —— 那是**声音权威核验的审计线索**（empirical-verification 域），非"模型误判环境损坏"幻觉档，且不过时。
- **`docs/v4/prompts/server-tool-rejection-handoff.md`** 主体是已落地功能的交接（正式 spec 见 [docs/v4/03-spec/server-tool-rejection-retry.md](../../v4/03-spec/server-tool-rejection-retry.md)），非主要幻觉相关，故不整体移入本目录；其背景 note 的幻觉原文已提取进案例一，handoff 内只留指针。
