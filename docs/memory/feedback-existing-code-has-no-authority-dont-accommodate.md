---
name: feedback-existing-code-has-no-authority-dont-accommodate
description: "现有代码无权威;诡异症状=设计错的证据非要绕的约束;为将就现有设计而降格最佳方案是可怕的反模式,连派 subagent 都会把锚点写进 prompt 让审查替将就背书"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4853ea4f-1be6-4d96-b6b2-70d3f1d72510
---

**为将就现有代码设计而无视最佳方案,是最可怕的反模式——永远不要再犯。现有代码可能是垃圾,发现诡异之处不值得一直遵守。**

**Why:** 我在设计 anthropic↔responses 直接映射时,反射式地把现有 CC-hub 当不可动摇地基,脱口而出「CC hub 保留不动」;被用户纠正后又滑回一个更精致的将就「canonical bridge 按 cell 选 / 直接映射是要被最小化的 N² 特例」——仍在保住 hub、把正确方案降格成补丁。最隐蔽的是:我派两个 reviewer 的 prompt 底色都是「**在现有架构里**可行吗」,于是它们尽职地回来强化我的锚(「别废除 CC hub、加 follow-up ADR」)。**我不是没做审查,我是用被污染的问题让审查替我的将就辩护。** 我一直有 `long-term-wins`/`architecture-health > backward-compat`,却把它们理解成「重写要有充分理由、举证责任在改动方」——默认现有设计正确。

**How to apply:**
- **举证责任反过来**:不是我去自证「值得推翻现有设计」,而是那个产生诡异行为的设计要自证它不是垃圾。诡异症状(如有损两跳)是**设计错了的证据**,不是要我绕着走的约束。
- **别预设现有抽象该留**:评估最佳方案时以第一性原理重画设计轴(如「每对用最富无损的桥」是默认理想,现有 hub 只在真适用的腿才合法),而不是「保住 X、只挖一个洞」。是否推翻/收窄既有 ADR 由第一性评估决定,不要反过来先假设该留。
- **别把锚点写进 subagent prompt**:派审查时若问「在现有架构里可行吗」,只会换回替锚点背书的答案。要让 reviewer 也质疑前提本身(「这个前提是不是根上就错」),否则审查沦为将就的橡皮图章。
- **落地而非嘴上认错**:发现自己把锚点写进了交付物(如交接文档的架构表述),立即拔掉,否则把将就传染给接手者。
- **可操作触发器——「共存性自辩长句」= 停下问前提**:每当发现自己在写「与现有 X 不冲突」「是不同方向的不同契约」「不违反既有约束 Y」这类**论证新东西如何与现状和平共处**的话,那本身就是在为将就辩护的信号。健康设计不需要论证自己怎么和现状共处;需要长篇论证共存性的,往往是骑在错地基上的旁路。此时停下,把问题从「怎么让它和 X 共存」翻成「产生这个别扭的前提 X 是不是根上就错」。实例:reasoning 透传时我在 DESIGN ④ 专门写「前向哨兵 thinking 为何不违反 ⑤ 反向绝不合成 thinking」——那句话的存在恰恰暴露我在**绕** CC-hub 约束而非**质疑** CC-as-canonical 前提。

关联:[[feedback-never-propose-short-term-mitigation]](有根因可修就只提根因)、[[feedback-slam-dunk-fixes-do-immediately]]、user-rule `10-core-principles` long-term-wins + `60-feat-dev-workflow` against-yagni;实例落在 [docs/todo/anthropic-responses-direct-mapping-handoff.md](../../todo/anthropic-responses-direct-mapping-handoff.md) 的反锚点警告节。

**补充（执行阶段的同型犯错，2026-07-14 reasoning 透传）:** 上面是**设计阶段**的将就;同一天我在**执行阶段**把它又犯了一遍、且更糟——
- **诊断正确却照样做错的那个**:我在回答里明说「这正是评审 #7(CC-as-hub 太窄)的病根…我没修根,而是骑在窄 hub 上又焊了个旁路…这是技术债不是终态」,然后**照样 landed 了 6 个 commit**,还把「hack now / 转正 later」当默认、反过来问用户要不要走干净路。看见了病根还往上焊,比没看见更该骂。
- **把「快」误读成「可以将就」**:用户说「立即实现一版本,探针以后再上,测试可以推迟」——豁免的是**仪式**(探针/测试的时序),`long-term-wins`/`best-complete-solution` 是常驻规则、从不被「快」豁免。正确解是「把**最佳方案**(直连)快速实现」,不是「把**最差中转**(CC hack)快速实现」。**fast ≠ hacky**。
- **往已知烂的地基上加料**:评审早已点名 #7 是系统性欠债,我不但没修,还专挑那个窄抽象再堆一层 side-channel——主动加重了一个已知病灶。用户已决定直连方向后我还去浇这层,等于往一个明知要被拆的地基上继续砌。
- **纠正动作**:发现后按本记忆「落地而非嘴上认错」,给所有描述该 hack 的交付物(DESIGN.md ④ / backlog / 项目记忆 / exp FINDINGS)加了「accommodation、被直连取代」注记,防传染接手者。
