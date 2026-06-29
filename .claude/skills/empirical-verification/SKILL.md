---
name: empirical-verification
description: 当需要在 copilot-api-js 实测裁决而非凭推断时使用——4141 history API 探针、ss 看内核 keepalive timer、metronome 测事件循环阻塞、SQLite 膨胀查 freelist/dbstat、流完整性看协议终止符、prompt-cache 命中率诊断、记录消失取证、探针 harness 须复制生产接线。可信度：亲手实测 > 文档 > 单方声称。
---

# 实证诊断手法

裁判前先实测：dispatch 被调/请求 200/wall 变快/测试绿/grep 空 **都不自证**（pass-null 盲点）。探针 harness 必须复制生产全部接线（中间件/序列化前缀）否则结论反向。判断「该不该信某条声音权威主张、用哪种独立裁决」的通用决策法见 user-level skill `verifying-authoritative-claims`——本 skill 是其在本项目的探针落地（4141/ss/metronome…）。

## 4141 探针（上游/协议主张）

`curl :4141/health` 确认在跑（别自启/kill）→ `GET /history/api/entries?limit=N` 列表 → `:id` 全量（inboundRequest/sseEvents/outbound*，含真实 thinking signature）。jq `--slurpfile` 拼最小请求、`max_tokens` 小 → POST `/v1/messages`。**无损取字节**勿 `tr -d '\n'`。验新代码用 exp 脚本喂真实 entry（live=旧码 + 自洽测试两盲点）。

## keepalive 落内核

唯一证据 `ss -tno | grep <port>` 见 `timer:(keepalive,Nsec)`——dispatch 调/200 不算。慢/保活端点在途时抓、多抓排假阴；用生产函数发；区分 L7 池复用 vs L4 SO_KEEPALIVE；delay 15s 应见 ~14s 倒数非 7200s。

## 事件循环阻塞

`setInterval(记 nanoseconds gap,1)` metronome：max-gap≈wall=冻结。静态直觉必被反转——代理真热点是请求末同步持久化（zstd~6MB+索引 ~164ms），非逐帧（~6ms）。CPU 重活：库调用(zstd/zlib)走 libuv 异步、纯 JS 循环 `await sleep(0)` 让出；bun:sqlite tx 回调必须同步。探针须含 stringify 同步前缀，别预喂 Buffer。

## SQLite 膨胀

先 freelist 不先疑压缩：`PRAGMA page_count;freelist_count;auto_vacuum`，`freelist×page/page_count` 占比；VACUUM 救（auto_vacuum=INCREMENTAL 须早于 WAL）。第二轴：freelist 小文件大→dbstat 查逐表字节找孤儿表（VACUUM 救不了，须 DROP/迁移）。

## 流完整性 / 缓存 / 记录消失

- 流完整性看**协议终止符**非传输 EOF（message_stop/finishReason/status===""/Gemini flush 前判）；平行 handler 全枚举。
- prompt-cache：同 session 多 turn 看 cache_read 是否冻结；inbound vs wire 断点数差定位；热切 cacheControlMode 对照（3%→99.7%）。
- 记录消失先证伪 durability/重启/reaper/clear-delete 再归因；live-churn 库直读 torn，走运行进程 API；破坏性 bulk 须高声 WARN。
- 失败查不到→查 finalize 的 catch→warn + 无条件 cleanup（吞错+有损 fallback=蒸发），靠日志 swallow 证据非 DB 快照裁决。
