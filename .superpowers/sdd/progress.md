# 本文件不再是账本，只是一个指针

**Mandatory Block Delivery + HTTP/2 Observability 的 SDD 进度账本已迁至：**

> [`docs/mandatory-block-delivery-h2-observability/progress-ledger.md`](../../docs/mandatory-block-delivery-h2-observability/progress-ledger.md)

迁移时间 2026-08-11，理由是该特性的全部文档按 CLAUDE.md 的 `docs/<topic>/` 约定收进了同一个目录。

## 读到这里的人请注意一件事

**这个路径是被复用的。** 历次 SDD 运行都把各自的账本放在这里，所以仓库里别处提到 `.superpowers/sdd/progress.md` 时，指的**未必**是上面那一份——多半是当时占着这个路径的另一份账本。举一个已经确认的例子：`docs/todo/deferred-backlog.md` 里那条引用写着「见 `.superpowers/sdd/progress.md` P1 Task 1-4/7」，而迁走的这份账本里**一个 `P1` 都没有**，所以它指的是更早的另一份。

因此迁移时**只重指了本特性目录内部的引用**，目录外的一律没动——把它们统统改指本特性的账本，会让那些旧文档断言一件假事。

如果你是顺着某份旧文档找到这里、而它谈的不是 mandatory block delivery，那么它要找的账本**已经不存在了**（被后续运行覆盖过），去 git 历史里按当时的 commit 取。
