---
name: methodology-plan-drift-scales-with-rework-reconcile-per-contract
description: 实现被返工 N 轮，plan 文档就积了 N 代旧契约；按已知形态 grep 结构性查不全，必须逐契约对账
metadata:
  type: feedback
---

**一份 plan 的陈旧程度，与它所描述的实现被返工的轮数成正比。** 每一轮返工都可能改契约，而 plan 通常只在「实现完成」时被想起来同步一次——于是它同时积着好几代旧形状。**接手一个经历过多轮返工的相位时，先做逐契约对账，别假设 plan 还准。**

**Why:** 2026-08-02 方案 A 的 P1+P2 经四轮异模型审查、契约被反复重塑（`OwnerResult` 三 reason、missing mapping 改 throw、`wireTorn`、hedge 第四条腿、AST allowlist 取代字面量 baseline）。写于返工之前的 `plan-3-remap-sites.md` 因此积了至少 **13 处**旧契约，分布在返回类型、Step 正文、精确状态转移表、mutation 对照形状、Modify 清单等**五类不同位置**。十四轮评审里**每一轮都还能再找出一处**——包括「我以为已经扫干净了」的那几轮。

**为什么每轮都扫不干净**：我每次的「全文扫一遍」实际是**按上一轮抓到的形态 `rg`**——用已知错误找未知错误，覆盖面天然不完全。旧契约的表现形式差异极大（类型签名 / 散文描述 / 表格单元 / checkbox 文本 / 文件清单），任何单一正则都只覆盖其中一类。

**How to apply:**
- **对账方向是「从当前类型源头出发」，不是「从文档里搜可疑词」**：打开 `types.ts`（或该域的契约 SSOT），把每个公共类型/函数签名逐个拿去文档里找它的所有出现，逐处判是否仍成立。**方向反了就永远漏**。
- **五类容易藏旧契约的位置，逐类过**：① 代码块里的签名；② Step/task 的散文措辞（最容易漏，因为不含类型名）；③ 表格单元（尤其状态转移表）；④ mutation/正控的「对照形状」（契约变了，对照也得变）；⑤ Modify/新增文件清单。
- **别用顶层一句「以下旧措辞按补正理解」兜住相反的 checkbox**——实施者会照着 checkbox 做，不会先读顶部。**逐处改写，每处标补正日期与依据行号。**
- **补正时把「为什么原措辞是错的」留在正文**，不要只写正确版本；否则后来者凭直觉会退回那个更省事的旧形状（本轮实测：删掉旧行后又有人从相邻表述里推回同一形状）。
- **改文档用内容匹配而非行号**：多轮编辑后行号会漂，本轮就因按行号替换而**覆盖了无关的一行、把矛盾的旧行留在原地**，结果比改之前更糟。非用行号不可时，替换前断言该行含预期内容。

**配套的一条**：写完新表格/新小节后，**它比被修补的旧文字更容易出错**——新写的内容没有历史校验，本轮连续三轮的发现都集中在我当轮新增的表上。新增段落要单独再过一遍「与代码逐格核对」。

**Related:** [[methodology-dont-specify-across-a-seam-you-havent-read]]（别跨没读过的缝规定行为）[[feedback-pass-null-clean-not-self-validating]]（doc-vs-code 结论不自证）[[methodology-each-fix-round-introduces-green-passing-regression-at-the-same-seam]]
