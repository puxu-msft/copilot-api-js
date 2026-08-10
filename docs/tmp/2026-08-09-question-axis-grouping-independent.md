# 按「读者当时在问哪个问题」独立分组（62/63/64 全部顶层条目）

口径：先写下读者遭遇它的**时刻**与**困惑**，时刻或困惑不同即分组，名词相同不算同组。未参考任何现成分组结论。

**条目计数订正**：任务书写 23 条，实际 `rg` 命中 **25 条**（62 = 7、63 = 11、64 = 7，含 `replacement-must-cover-what-it-restates` 与 `anchor-numbers-to-commits` 两个缩进子条）。本文覆盖全部 25 条。

## 分组（每行一组：问题 → 成员 → 为什么同问题）

- **G1「我刚写完的这份文档，内容真的是我以为的那样吗？」** —— `reread-docs-after-writing`。时刻＝落笔完毕、交付之前；困惑＝「编辑成功」与「文档正确」之间的落差。它管的是成品复核这一个动作，不管怎么编辑、也不管事实是否过期。
- **G2「我正在做的这次替换式编辑，会不会静默把文件弄坏？」** —— `replacement-must-cover-what-it-restates`。时刻＝手指按在 `Edit` 上的那一刻；困惑＝old/new 覆盖面不匹配导致的重复或静默删除。它是**编辑操作本身**的机械风险，与文档是否正确无关（改代码也一样中），所以不与 G1 同组。
- **G3「我写下的这句状态，明天还成立吗？我脑子里的快照还准吗？」** —— `stale-context-at-session-end`、`anchor-numbers-to-commits`。时刻＝要把一个当前状态/数字写进交付物；困惑＝易变事实的保鲜期。前者管「重新去取」，后者管「别写死、写重算它的命令」，是同一困惑的进出两侧。
- **G4「这个只在过渡期存在的东西，该安置在哪才不会被误读或被静默清掉？」** —— `put-transient-state-in-the-right-file`、`track-transitional-symlinks`。时刻＝迁移/过渡期产生了一个临时物件；困惑＝把它放错地方，要么被固化成长期心智模型，要么被 `git clean` 无声抹掉。载体一个是文档、一个是文件系统，但读者问的是同一句「临时的东西归哪儿」。
- **G5「我刚说出口的这条教训，下次真的会被召回吗？」** —— `verify-lessons-are-actually-hardened`。时刻＝复盘、说出「这是个模式」之后；困惑＝规则存在但触发接缝没接上＝不存在。它不问文档对不对，只问未来的可触发性。
- **G6「我要交给下一个人的派发件，它依赖的上游可信吗？」** —— `kickoff-inherits-upstream-defects`。时刻＝写 kick-off / 转述他人成果；困惑＝我的正确性上限受制于我引用的最弱那份文档。这是**输入侧尽调**，与 G1 的自我复核方向相反。
- **G7「这一轮做完了，除了测试绿我还欠什么？」** —— `analyze-structural-smells-each-round`、`reflect-best-approach-each-round`。时刻＝一轮/一阶段收口；困惑＝全绿带来的收工冲动。一条向外看结构，一条向内看选路，但触发点与心理状态完全同一。
- **G8「我为验证而临时改坏了代码，怎么安全地还原回去？」** —— `mutation-baseline-must-contain-the-real-impl`。时刻＝变异注入与恢复之间的那个窗口；困惑＝恢复动作本身会连同伴与自己的未提交工作一起抹掉。它的核心是不可逆数据丢失，不是判据设计。
- **G9「收尾了，我还有哪些产出没并回主干？」** —— `worktree-branches-are-for-merging`。时刻＝会话/阶段结束清点；困惑＝隔离产物无声堆积。与 G3 的区别：G3 问「我说的状态准不准」，本组问「有没有东西根本还没落地」。
- **G10「挡我路的这个东西，是不是别人有意为之的决定？」** —— `check-existing-decisions-before-changing-behavior`、`red-tests-may-be-guarding-something`。时刻分别在改动前与改动后一片红时，但困惑逐字相同：眼前这个看着像缺陷/像过时的东西，可能是被权衡过的裁决或守护型断言，顺手改掉＝替别人重做决定。
- **G11「我这段东西该插在哪一层？」** —— `fix-at-the-shared-base-not-where-you-noticed`、`new-checks-must-not-alter-existing-contracts`。时刻＝已经知道要写什么、正在选落点；困惑＝选高了漏掉复用者，选低了/选错位置碰坏顺序契约与分层边界。两条给的是同一个选层判据的正反两半。
- **G12「我设的这道门，在真正执行的那一刻还在吗？」** —— `check-dependency-contract-against-your-invariant`、`batching-can-silently-remove-a-gate`。时刻＝门已经写完、自认为守住了；困惑＝门在执行接缝上蒸发——一个蒸发于「实施者读的是被调用方文档而非我的规格」，一个蒸发于「换行不传播退出码」。同一失效机理的两种载体。
- **G13「我这次改动的爆炸半径里，有谁的不变量会被打破？」** —— `packaging-can-void-another-invariant`。时刻＝要动一个看似局部的基础设施配置；困惑＝破坏不以构建失败暴露，而以别处测试红暴露、极易被判为无关故障。它问的是「我碰坏了谁」。
- **G14「我写下的这条不变量，作用域是不是写大了？」** —— `scoped-invariant-written-as-global`。时刻＝正在写或读一条「只有这一处会改它」的断言；困惑＝它只在某个作用域内成立。与 G13 方向相反：那条问「我碰坏了谁」，这条问「我这句话本身是不是就假的」。
- **G15「切换的那个瞬间，会不会有人看见坏掉的中间态？」** —— `atomic-publish-with-invalidation`、`atomic-swap-for-live-paths`。时刻＝要把「现任」从旧换到新；困惑＝两步写法之间存在真实的可观测窗口。载体一个是内存指针＋派生状态失效，一个是在跑进程的文件路径，但问的都是「有没有窗口」。
- **G16「把散落状态收进一个对象，这类重构有哪些已知坑？」** —— `shared-state-refactor-traps`。时刻＝正在动手做这一种特定形状的重构；困惑＝要一份坑清单＋机械判据。它是查表式知识，不是判断式规则。
- **G17「它到底生效了没有／真的能跑吗？」** —— `migrate-then-verify-execution-not-existence`、`environ-is-frozen-at-process-start`。时刻＝改完/迁完，要断言「已可用」；困惑＝我手上的是静态属性或声明值（`test -x`、配置文件、`systemctl show`），而真相是执行结果与进程持有值。两条是同一个「声明 vs 运行态」缺口。

## 跨组条目

- `new-checks-must-not-alter-existing-contracts`：**选落点**那一半在 G11；**「别碰坏既有顺序契约与分层边界」**那一半属 G13（我这次改动打破了谁）。
- `mutation-baseline-must-contain-the-real-impl`：主体在 G8（不可逆还原）；其「共享树里同伴可能正在写」的前提与 G9 的收尾清点共享同一个并发工作树世界观，但不构成同问题。
- `stale-context-at-session-end`：主体在 G3；其「逐条验证 pending / 下一步 / 归属」的动作在 G9 的清点时刻也会被召回。

## 最难归的几条

- `track-transitional-symlinks`：正文写的是 git 跟踪与 `clean -xdf`，看着像 Git 纪律；但读者遇到它的时刻是「迁移过渡期我留下了一个中间产物」，所以我按时刻归进 G4 而非任何 Git 组——这是本轮最可能与你版本对撞的一条。
- `new-checks-must-not-alter-existing-contracts`：唯一一条我认为必须拆半的，见上。若强行单归，G11 与 G13 都会丢掉它的一半价值。
- `environ-is-frozen-at-process-start`：它同时长得像「迁移后验证」（G17）与「配置生效的因果知识」；我按困惑归 G17，因为读者不是来学 environ 语义的，是来回答「我改的东西生效没有」。
- `shared-state-refactor-traps`（G16）与 `atomic-publish-with-invalidation`（G15）：都出自并发/重构语境，且都谈锁，但一个是「给我坑清单」、一个是「判断有没有窗口」，时刻与召回方式不同，我拒绝合并。
- `verify-lessons-are-actually-hardened`（G5）与 `reflect-best-approach-each-round`（G7）：都发生在复盘，但前者问「未来会不会触发」、后者问「本轮还欠什么」，指向的下一步动作完全不同，故分置。
