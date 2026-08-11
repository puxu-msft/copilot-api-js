# Task 9 evidence FK final-state probe

> 观测环境：Bun 1.3.14，Linux x64，内存 SQLite。项目 History 连接默认执行 `PRAGMA foreign_keys = ON`（`src/lib/history/sqlite/connection.ts:76`）。探针同时枚举 FK on/off 与 `recursive_triggers` on/off；原始脚本与 JSON 位于本作业临时目录，不属于产品代码。

| FK | recursive triggers | DML | 结果 | 最终状态 |
|---|---|---|---|---|
| on | off/on | referenced `DELETE` | `FOREIGN KEY constraint failed`，statement ABORT | evidence、refs、ready summary、marker 全部不变；trigger side effects 回滚 |
| off | off/on | referenced `DELETE` | COMMIT | evidence 删除；refs 保留；summary poisoned；marker 删除 |
| on/off | off | existing-key `INSERT OR REPLACE` | COMMIT | evidence 替换；refs 保留；INSERT-side trigger使summary poisoned、marker删除；隐式DELETE trigger不运行 |
| on/off | on | existing-key `INSERT OR REPLACE` | COMMIT | evidence替换；refs保留；DELETE与INSERT triggers均运行；summary poisoned、marker删除 |

结论：reviewer关于 referenced DELETE 的 FK-on ABORT finding成立；关于 existing-key REPLACE 在 FK-on 也会 ABORT 的外推被独立探针推翻。REPLACE 的正确机制是显式 INSERT-side referenced invalidation，不能依赖 SQLite 是否触发隐式 DELETE trigger。
