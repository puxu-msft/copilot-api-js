# NGHTTP2_CANCEL 最终 evidence gate 复核 R10

- evidence-manifest-sha256: 66de25e7b45c1f84494cbd6f6360fee37514fcbbf23e4fbb983886963ef6159a
- verdict: 0 blocker / 0 major

- **评审范围：** 以新 checkout 接手者视角，只审 manifest／`FINAL_COMMIT` gate；不重审技术机制。
- **绑定证据：** HANDOVER SHA256 `1229e85ce89a4ca04bff24c31bb4fb9a15eefabbcd1af70c80090d3bcdc199bd`；KICKOFF SHA256 `1842b7891f0b18b823363fc17192afc5d326382aacd8d98574e2dfa6bfd8ed00`；manifest 文件 SHA256 与上方机器字段一致。独立重算 manifest 得 26 行／26 唯一路径，全部 workspace blob hash匹配；manifest不含自身或R10，含 factual／successor R9双链。KICKOFF新增 gate的11个 Bash block与18个 Python heredoc语法均通过。
- **总体结论：** 0 blocker／0 major，可提交。

## 正确状态走查

调用方必须显式给出小写40位 `FINAL_COMMIT`，gate不读取 `HEAD`或工作区。它先以 `cat-file -t`与 `rev-parse <id>^{commit}`双门证明输入本身是精确commit，再从该对象读取manifest、26个历史blob及两份R10；因此HANDOVER、KICKOFF、manifest、26 blobs与双R10只能来自同一commit，不能混搭checkout或其他提交。

当前manifest是冻结literal集合：严格26行、26个唯一路径，每行格式与digest受检，缺项、额外项、重复项或任一blob漂移均红。manifest不列自身，R10也不列入manifest；两份R10只声明同commit中manifest blob的hash，故没有自引用求不动点。正确final commit只需同时包含manifest、26 blobs及双绿R10，存在可达绿路径。

两份R10均接受全文机器语义检查：manifest字段与verdict字段各自全文件恰好一次、位于前20行、逐字匹配；任一R10缺失、非UTF-8、错hash、晚置重复／冲突字段、非绿verdict或标准finding marker都会红。本报告前20行中的两项机器字段各恰好一次，且未在后文复写。

## 反例覆盖

- 未设置FINAL、短SHA、非小写／非40hex、未知对象、tree／blob／tag对象：均在读取证据前转红。
- 错误commit或混合commit：manifest集合／blob digest或双R10读取至少一项转红。
- manifest漏项、额外项、重复路径、坏格式或blob漂移：集合、行数、格式、唯一性或digest门转红。
- 漏任一R10、R10错manifest hash、重复机器字段、晚置冲突字段、非绿机器verdict或标准严重finding marker：全文报告门转红。
- 提供的PoC `/home/xp/.claude/jobs/2684f077/tmp/final-evidence-gate-poc.wsypxftj` 已覆盖正确commit绿，以及tree、重复字段、严重finding、错hash、late conflict红；PoC仅用于本轮复核，不是新checkout运行gate的依赖。

## 新checkout独立性

新checkout只需Git object database、调用方显式FINAL与KICKOFF内置literal集合。所有证据均通过 `git show FINAL:path`读取；不读取工作区文件、不扫描目录、不访问job／tmp／transcript。PoC路径不会进入执行协议，删除后不影响最终门。

## 双向结论

- **假绿方向：** tree对象、混合提交、集合漂移、blob漂移、R10缺失／错hash／重复或冲突机器字段、标准严重finding均有机械拒绝门。
- **假红方向：** 精确commit、严格26项manifest、匹配blobs与全文件唯一双绿R10可通过；manifest与R10的单向hash关系避免了自引用导致的不可构造状态。

## 事实性发现

未发现阻断性或重要问题。

## 结构怪味扫描

扫描范围为 `KICKOFF.md` 的FINAL对象类型、manifest集合／digest、双R10全文字段门及 `HANDOVER.md` 的终态证据说明。判据是对象形状冒充类型、跨commit混搭、清单自推导、manifest自引用与局部字段检查。当前候选均已用冻结literal和同commit对象读取闭合，未发现需记录的新问题。
