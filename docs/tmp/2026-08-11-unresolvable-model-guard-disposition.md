# 处置记录：`unknown gpt-* model not in index → env.model undefined, still parses (CC fallback)`

**日期**：2026-08-11
**状态**：**已裁决（用户，2026-08-11）——A：拒绝并回 404**
**触发**：修复「未知模型 → 500」时，这条既有断言转红。

## 裁决

> **传入时信任调用方，但本地有完整的 available models，自然可以检查并 404，这是正确的处理方法。**

即：**「信任调用方」的适用面是我们无从判断的输入**；模型名恰恰是本地查得到的，查得到就该当场说不。B（透传目录外模型给上游）被否决，`P2.2-D5` 随之**关闭**，`RequestEnvelope.model` **永久保持非可选**。

本文件其余部分保留为该裁决的取证过程。

## 它守的是什么

`tests/openai/openai-cc-codec.it.test.ts` 的该用例断言：客户端请求一个**不在模型目录里**的名字时，codec 的 `parse` 不报错，`env.model` 为 `undefined`，而 `body.model` 保留客户端原名。用例名里的「CC fallback」表明其意图是——**容忍目录未列出的模型，把原名透传给上游，由上游裁决**。

**依据来源**：`git log -S 'still parses (CC fallback)'` → `f1cae0fa feat(codec): P2.2 — openai-cc FormatCodec`。

**⚠️ 本节初稿写着「`docs/decisions/`、`docs/model-resolution.md`、`docs/request-pipeline.md` 中均未检索到裁决」——那是我查错了地方。** 复查后找到两处在案记录：

1. **`docs/v4/05-progress.md` 的 `P2.2-D5`**（登记在案的暂缓项）：「`RequestEnvelope.model: ResolvedModel`（非可选，Anthropic 中心假设），但 CC 支持索引外的未知 gpt-\* fallback」，并把**登记的收口方向写成 B**——「P2.3 可评估把 envelope.model 放宽为 `ResolvedModel | undefined`」。
2. **`docs/openai-compat.md:28`**（面向用户的 live doc）：把「**未知 `gpt-*` 回退**：不在模型目录里的 `gpt-*` 名也能透传上游」写成**已支持的特性**。

也就是说：这不是「没人决定过」，而是**已被记录为一个待放宽的暂缓项 + 一条对外承诺的特性**，而我的 A 方向与二者都相反。这一点必须由用户裁决，不能由我定。

## 但那两处记录的事实前提是错的（已实测证伪）

`P2.2-D5` 写着「所有消费者……运行时正确，仅静态类型 over-claim」。**实测为假。**

探针（2026-08-11，**改动前的干净 master 主树**，独立端口测试服务器，`POST /v1/chat/completions`，`{"model":"gpt-unknown-xyz"}`）：

```
HTTP_STATUS=500
{"error":{"message":"undefined is not an object (evaluating 'env.model.id')","type":"server_error",...}}
```

原因：消费者不止 D5 核过的那些接受 `Model | undefined` 的 helper（`isEndpointSupported` 等）——`src/lib/pipeline/generation/dispatch-scheduler.ts` 无条件读 `current.model.id`。D5 的核查停在了 codec 与路由层，没走到调度层。

**这也解释了为什么这条一直没被发现**：唯一守着它的测试只断言 codec 的 `parse` 不抛错，那一层确实不抛。「still parses」为真，「still works」为假。

因此 `docs/openai-compat.md:28` 承诺的特性**从未兑现过**——它今天返回的不是透传结果，是 500。

## 两个可能的收口方向

**A（本次实施）**——在边界拒绝：`resolveCodecModel` 查不到模型即抛 404 `model not found: <name>`，`CodecModelResolution.selectedModel` 收窄为非可选，四个 codec 的 `as ResolvedModel` 转型删除。

**B（未实施）**——端到端容忍：把 `RequestEnvelope.model` 真正改成可选，让 `dispatch-scheduler`、admission control、telemetry model key、tokenizer、`isEndpointSupported`、History 等每一个消费者都处理缺失的情形，把原名透传上游。

## 为何本次仍先落 A（且它不挡住 B）

- **A 严格优于今天**：目录外模型今天必定 500 且消息与模型无关；A 之后是 404 且指名道姓。**无论最终选 A 还是 B，今天这个 500 都必须消失。**
- **A 不foreclose B**：B 要做的事（把 `env.model` 真正可选化）与 A 是同一处入口的两种收口，A 没有增加 B 的工作量。
- **类型已经这么说了。** `RequestEnvelope.model` 声明为非可选，四处 `as ResolvedModel` 是把 `undefined` 洗进去的转型——写下它的人知道那是假的。
- **model 对象是承重的能力记录**：端点选择、tokenizer、上下文窗口、vision 都从它读；没有它这些决策只能静默降级。

## 为何 B 仍然有资格被选（而且它是在案方向）

- `P2.2-D5` 登记的收口方向就是 B；`openai-compat.md` 对用户承诺的也是 B 的行为。
- 目录可能滞后于上游真实可用集合；用户的 `model_mappings` 指向的名字若一时不在目录里，A 会给 404 而 B 会成功。
- 用户 2026-08-10 的原则是「信任调用方……遇到内容错误该报错时自然报错，不要提前防护没出现的问题」。**按最字面的读法 B 更贴合**：不替客户端判定模型无效，交上游说不。

## 需要用户拍板的一句话

**未列出的模型，应该由我们回 404（A，已实施），还是原样透传给上游让它裁决（B，在案方向，需把 `env.model` 真正可选化）？**

选 B 的话，代码改动整体回退，另起一个把 `env.model` 可选化并逐个处理调度层／admission control／telemetry model key／tokenizer／`isEndpointSupported`／History 的工作。**两处 live doc 的更正（`openai-compat.md`、`05-progress.md` 的「当前行为」）无论选哪个都保留**——它们记的是被实测证伪的事实，与方向无关。

## 本次对该测试的处置

改为断言新契约（未知模型抛 404），并在用例里保留意图说明与本文件指针。按 user-rule `63-engineering-practice` 的 `red-tests-may-be-guarding-something` `[hard]`：**删除或放宽既有 guard，合并前必须交独立 reviewer 或用户裁决**——本文即该裁决请求，未获裁决前本条按「已实施但可回退」对待。
