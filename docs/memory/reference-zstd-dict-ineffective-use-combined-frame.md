---
name: reference-zstd-dict-ineffective-use-combined-frame
description: zstd dictionary 选项对大 near-dup blob 无增益(node:zlib + Bun 实测);dedup 真正有效的是把关联 blob 压进同一 zstd 帧
metadata: 
  node_type: memory
  type: reference
  originSessionId: 51d56536-5c7a-43aa-85d0-1a34c7c557e1
---

要 dedup 多个**高度相似的大 blob**(如同一请求的 inbound/effective/outbound 三份请求体,>90% 共享),**zstd `dictionary` 选项无用,合并帧才有效**。实测裁决(copilot-api 存储瘦身):

- per-blob 字典:用 blob A 当字典压 blob B —— **node:zlib `zstdCompressSync(B,{dictionary:A})` 与 `Bun.zstdCompressSync(B,{dictionary:A})` 对大 blob 均无增益**(245→245KB / 244→244KB)。字典没把内容当匹配源(可能只对"大量小同构文档"有效)。
- **合并帧有效**:`[A+B+C]` 拼一个 buffer 单次 zstd → 3224KB raw 压到 231KB = 单份 A 同值,第 2/3 份近零成本。

所以纯 zstd 的 dedup = **把关联 payload 拼成 JSON 数组单次压缩存一行**(非二进制 framing——JSON 自表达边界、消手写 uint32/int16 可错面;非手动剪 JSON/存 diff——每份仍逐字 round-trip)。copilot-api 落地为 `request_group` 合并帧(serialize.ts `partitionStagesForWrite`/`decodeStageRows`)。

附带 reference:
- **`node:zlib` 的 zstd 跨 Bun/Node 可用**(`zstdCompressSync`/`zstdDecompressSync`,Bun 1.3.14 实测;Node ≥22.15)——bun-first 合规的 gzip→zstd 升级路径,无新依赖、无 node-gyp。zstd L3 实测比 gzip 砍半(505→261KB)、~7ms/1.2MB,性价比最高。
- magic bytes:gzip `1f 8b` / zstd `28 b5 2f fd`——可靠判别新旧格式做混存向后兼容,无需自定义版本字节。

参见 [[methodology-sqlite-bloat-check-freelist-first]](同次存储瘦身;VACUUM 才是 2GB 的根因,zstd/dedup 是次要)、[[feedback-bun-first-dependency-selection]]。
