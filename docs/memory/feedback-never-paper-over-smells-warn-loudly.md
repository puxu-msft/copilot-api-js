---
name: feedback-never-paper-over-smells-warn-loudly
description: 闻到任何「怪味」（命名不贴切、抽象错位、职责混淆、doc 名实不符等）永远当场大声警告用户，绝不粉饰或轻描淡写带过
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f8087ef3-0b1b-4c60-8b6c-ee5d6ec799b5
---

闻到任何**怪味**（code smell / 命名不贴切 / 抽象错位 / 职责混淆 / 文件名与内容名实不符 / 结构别扭）时，**永远当场大声警告用户**，绝不粉饰、绝不轻描淡写地夹在别的话里带过、绝不默默写完再顺口一提。

**Why:** 用户把「对怪味出声」当作承重能力,不是可选礼貌。我把 `shutdown.md` 扩进优雅重启 + 请求生命周期后,当时却让文件名仍叫 `shutdown`——名实不符、主动误导按名检索的读者/agent（后经用户点醒才改名 `lifecycle.md`）——我不但没在扩内容那一刻停下报警,还在结尾用「要不要加 wip 行」这种轻描淡写把它糊过去。用户明确：这是「粉饰怪味」,让他很失望。

**How to apply:** ① 产生怪味的**那一刻**就停下、用显眼措辞（⚠️ + 明确点名哪里怪、为什么怪、误导谁）报警,而不是完成动作后再补一句；② 改动使既有命名/抽象失配时,主动指出失配,别假设用户没注意；③ 报警是义务不是打扰——即使会打断当前流程也要出声；④ 与 [[feedback-verify-facts-before-superlative-completeness-verdict]] 的自省精神一致：别为了「显得顺利」而压下不适感。相关：`long-term-wins`（怪味是长期负债,当场治不留）。
