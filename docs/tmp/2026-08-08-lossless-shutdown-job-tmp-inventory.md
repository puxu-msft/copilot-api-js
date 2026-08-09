# job 临时目录清单与 commit-message 对照

> 采集时间：2026-08-08T23:41:20+00:00。采集命令见本文件末尾。这是 `docs/tmp/2026-08-08-lossless-shutdown-temp-manifest.md` 所述文件计数与 msg↔subject 对照的**原始证据**——目录本身会随 job 删除消失，本文件是它唯一的留存。

## 目录清单

```
bytes	name
1531	INVENTORY.txt
138563	archived-script-run.log
166946	backend-final.log
256	backend-final2.log
256	backend-green-check.log
145981	backend-timeout-final.log
62828	base-validator.ts
41469	copilot-api-1786187008118-3388019.2026-08-08.1.ndjson
157	copilot-api-1786187008118-3388019.owner.json
990	extract-agent-id-events.py
826	extract-review-results.py
1416	extract-reviewers.py
175869	fast-after-shutdown-fix.log
175869	fast-final.log
252	fast-final2.log
252	fast-green-check.log
69	fast-rerun.log
179632	fast-root.log
146525	final-backend-after-review.log
138564	final-self.log
73236	guards.log
290380	lint-all.log
3075	master-changed-paths.txt
41	merge-preview.txt
460	merge-preview2.txt
41	merge-preview3.txt
456	merge-preview4.txt
256	merged-backend.log
252	merged-fast.log
125268	models-driver-classify.log
125272	models-driver-identity.log
41	mp5.txt
41	mp6.txt
41	mp7.txt
41	mp8.txt
389	msg.txt
461	msg10.txt
483	msg11.txt
892	msg12.txt
539	msg13.txt
177	msg14.txt
927	msg15.txt
464	msg16.txt
322	msg17.txt
382	msg18.txt
1169	msg19.txt
211	msg2.txt
219	msg20.txt
296	msg21.txt
676	msg22.txt
832	msg23.txt
861	msg24.txt
232	msg25.txt
892	msg26.txt
656	msg27.txt
391	msg3.txt
412	msg4.txt
323	msg5.txt
411	msg6.txt
330	msg7.txt
567	msg8.txt
886	msg9.txt
869	mutate-shutdown-drop-generation.patch
878	mutate-shutdown-drop-lightweight.patch
256	newest-backend.log
1038	run-self-tests.sh
138448	self-tests-final.log
138361	self-tests-run1.log
138361	self-tests-run2.log
1660	shutdown-backlog-section.md
10470	validator-timings.xml
```

常规文件 71 个；符号链接 0 个；子目录 0 个。

## commit-message 输入 ↔ 已落地 commit subject 对照

每行格式：`msg 文件` → 其首行 → 匹配到的 commit（`git log --all --format=%H%x09%s` 中 subject 完全相等者）。

```
msg.txt	b6f1f5e07e8b0ff378aada0ebdef146736d04f54	docs: 记录三路复评 PASS 与 validator 超时预算处置
msg10.txt	d61d36d3c00a911d95e0e7ce16112a9a1ffab639	docs: 写入无损 shutdown 会话终态报告
msg11.txt	1ec645f900c98cfd9bc63e98673cbd0b3ac3f095	docs: 避开与并发会话的评审报告文件名撞车
msg12.txt	7fcaef691e5b84a27c7d2c622a38edbda4ebcf3f	docs: 处置终审的 1 blocker 与 2 major
msg13.txt	4d75e9117ea1e5f07cfcf0db3c944e60b7929440	docs: 收口终态报告的复评状态并更正复评者措辞
msg14.txt	bc4ff278ffc21a701f8aee61cd8b1a093fff2560	docs: 落盘终审的复评结论
msg15.txt	9c323128b40ecb35730ad1dfa1d0a5beea372001	docs: 合并落地后更新陈旧的「待合并」状态并提炼测试口径
msg16.txt	971a3e39fac570e742dbc110bfe4d02300544ed6	docs(memory): 记收尾文档在合并落地那一刻变陈旧
msg17.txt	f31d2bdd96490f7295d563d13b2a7e3f797904c4	docs: 补掉自查发现的第九处陈旧断言
msg18.txt	bd00b710f51a6614bd91a031a1cf42f9ba489144	docs(memory): 补上「一次 grep 不够」的当场实例
msg19.txt	a47d9e11de97c635d4e594b4bb3fecff15c0d823	docs: 处置合并后收尾评审的四条 major
msg2.txt	b7e2cdec3b0b42bfdd61014e8119ee47c6efa12b	docs: 闭合 lint 外部阻塞并更新合入后验证快照
msg20.txt	8f660aa05f075f087547aef8a88e8c480a7e7bad	docs: 落盘合并后收尾评审的复评结论
msg21.txt	906adaf272cdde2a8ecb7f750f5cf17708ee988a	docs: 补全终态报告第 9 节的本批内容与评审结论
msg22.txt	8c74e6b703efc4995a40800661a0f0b8f0208625	docs: 用判定命令取代自指的合并状态断言
msg23.txt	d60c02d176ff344f064f23572652f71bcb9519f9	docs: 撤回「无穷回归」的错误论证并收窄判据
msg24.txt	dcffed7070abb6065ee2d8c69c39a9719c7ceb49	docs: 给自指判据补上可机械判定的集合边界
msg25.txt	d5e190384e53294a02ed57745c4a84f1c02b26d7	docs: 落盘自指判据的收口结论
msg26.txt	a3542b80db4d81679de8bc59b2de614f38249de2	docs: 记收尾汇总的表述系统性强于其证据 + 第三次冻结临时清单
msg27.txt	1af98a5ea1713f997026e3c5213ae728cf3697c5	docs(memory): 给「十处」补口径——本条自己犯了它警告的错
msg3.txt	6adf2e5638a1500568d15988beadebf2dff4ba6d	docs: 归档无损 shutdown 的正控变异 patch 与 validator 计时证据
msg4.txt	93de46b95c13000a7f182d48406289261f34f2ef	docs: 把无损 shutdown plan 转为终态记录
msg5.txt	51d705cfc0ff5135a94e3050b81a328a7b450e8a	docs(skill): 给 shutdown 正控记述补可复跑的 patch 指针
msg6.txt	5405056b137c93d646314ebc5878952dd0827c05	docs(memory): 记随机 false-red 挂在进程全局量上的两种形态
msg7.txt	e5ad10ea9e4390d7417ade1168c6e3c18ae0aabf	docs: 冻结无损 shutdown 会话的临时证据清单
msg8.txt	73928cefb24967be744762ac68750c29f9f87cd0	docs: 处置收尾指令文本评审的三条 major
msg9.txt	2c248536670e1bc10c54c459a16f32be0c4fe290	docs: 修正合并方向表述并把数字锚到稳定字段
```

## 采集命令

```
bash docs/tmp/2026-08-08-lossless-shutdown-capture-job-tmp.sh <job-tmp-dir> <out-dir>
```
