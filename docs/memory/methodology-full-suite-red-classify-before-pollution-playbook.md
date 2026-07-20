---
name: methodology-full-suite-red-classify-before-pollution-playbook
description: 「全套件红」未必是测试污染;套用污染 playbook 前先逐个单跑分类(oracle/doc 漂移 vs 真污染 vs timing flake)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bf2071a8-0238-4330-8f6c-fb3440003423
---

用户报「测试污染又冒头,曾彻底修复过」,但**全套件红 ≠ 跨文件污染**——套 `debugging-test-pollution` playbook 前,先对每个失败**单跑**判定,别默认是污染。

**Why:** 本项目并发会话高速往 master land 特性,「全套件红」这个同一症状底下混着三类完全不同的病:
- **oracle/count 漂移**(单跑就挂):并发 landed 特性漏更下游 golden/count。实例=`e8112c82` 让 pipelineInfo 经 `mergedPipelineInfo` 无条件带 `streamIdleTimeoutMs`,打破 `payload-rewrite-registry` 的「no rewrite→no pipelineInfo」;`NEGOTIATION_CATEGORIES` 加第 11 类 `cacheControlSubfields` 打破 negotiation count=10。
- **doc 死条目**(单跑就挂、deterministic):并发删/改名文件漏更 DESIGN.md,撞 L1 existence guard。实例=`412e8f71` 删 `src/lib/auto-truncate/` 迁 `src/lib/models/calibration/`、DESIGN.md 旧路径成死引用。
- **timing flake**(单跑必过但慢、全套件间歇挂):实例=`request-payload` 的 o200k tokenizer 对 60KB 串估算 ~6s,全套件 CPU 争用下撞 per-test 超时。
真正的跨文件单例污染(单跑过、全套件必挂、随顺序变)本轮**一个都没有**——那次「彻底修复」的反污染基建(autoRestoreState/useIsolatedRuntime)是稳的。用户的「污染」假设被 ground truth 证伪。

**How to apply:** 抓失败断言 received vs expected → **逐个失败单跑**(`bun test <file>`):单跑挂=漂移/死条目/慢 flake(非污染,修 oracle/doc 或查 perf);单跑过+全套件挂=才进污染 playbook(pairing 找污染者)。**并发会话在你调查期间还在往 master 提交**,失败集合两次全量跑之间会变(第一次 5 个 oracle、第二次换成 doc+flake)——这是 moving target 不是你手抖,靠 `git log --diff-filter=D` / `-S` 定位是哪个 peer commit 引入。修 oracle 时钉 SSOT(引 `NEGOTIATION_CATEGORIES.length` 非硬编码数字)、剥正交诊断(rewriteDiag() 去 timeout 字段)防复发。verification 簇 [[feedback-pass-null-clean-not-self-validating]]、污染实操 skill `debugging-test-pollution`。
