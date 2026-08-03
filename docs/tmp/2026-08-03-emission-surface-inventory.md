# Generation client-visible emission 面权威 inventory

## 审计锚点

- 被审树：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc`
- 分支：`feat/inter-block-anchor-allocator`
- HEAD：`854421d4e9765491f840e4daba9f42a36127fd3f`
- 初始 provenance 命令输出：
```text
/home/xp/src/copilot-api-js/.worktrees/anchor-alloc
854421d4e9765491f840e4daba9f42a36127fd3f
```
- 执行纪律说明：初始调用在 runtime cwd 已为被审树时打印了下列正确 path/HEAD，但该调用的命令文本遗漏了用户要求的显式 `cd <path> &&`；这是过程异常。其后所有承载结论的 Bash invocation 均在同一 shell chain 打印并断言 `pwd -P`、git top-level 与 full HEAD 后才执行实际命令。
- 统一口径：除第 9 节外，生产代码边界为该 commit 的 `src/**/*.{ts,tsx}`，排除所有测试文件与测试目录；代码调用与注释／类型声明分别统计。第 9 节按测试树单独定义。

### 1. `ClientSink.write` 的生产调用点

**取数命令（可复跑）**

```bash
rg -n --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' '\b(?:sink|inner)\.write\s*\(' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const v=n=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==="write"){const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${n.expression.expression.getText(sf)}`)}ts.forEachChild(n,v)};v(sf)}'
```

- 方法 A（完整 `rg` 清单 + 逐处读 receiver 类型）命中 11 个 `.write(`：其中 10 个 receiver 是 `ClientSink`，另 1 个是 `/src/lib/pipeline/delivery/session.ts:600` 的 `OwnerRawSink` physical write，故本类计数为 **10 个调用点／4 个文件**。
- 方法 B（TypeScript AST 枚举所有 production property-call，再按 receiver 符号定义归类）得到相同的 **10 个 `ClientSink.write` 调用点／4 个文件**；与方法 A 一致。代码引用 10；注释／类型声明引用不计入调用点。
- 正样本对照：已知 live drain 的 `/src/lib/pipeline/driver.ts:1048` 被两种扫描同时命中，证明扫描触达目标；完整未截断输出再归类为下表全集。

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/lib/pipeline/driver.ts:948` | `writeWinnerFrames` 逐帧写获胜候选帧。 | generation／helper |
| `src/lib/pipeline/driver.ts:952` | `writeWinnerFrame` 写单个获胜候选帧。 | generation／helper |
| `src/lib/pipeline/driver.ts:1048` | live `runResponseSink` 写 post-render frame。 | generation／live |
| `src/lib/pipeline/driver.ts:1265` | buffered flush 写 remap 后 frame。 | generation／buffered |
| `src/lib/pipeline/driver.ts:1319` | buffered retreat 后 live write-through。 | generation／retreat |
| `src/lib/anthropic/keepalive-anchor.ts:375` | synthetic-envelope injector 写捕获到的真实 `message_start`。 | generation／injector |
| `src/lib/anthropic/live-reconcile.ts:157` | reconciler 写 close/reindex 后的每个真实帧。 | generation／decorator |
| `src/routes/chat-completions/handler-v4.ts:662` | direct Chat Completions 尾部写唯一 `[DONE]`。 | handler／terminal |
| `src/routes/chat-completions/handler-v4.ts:833` | via-Responses 已见 terminal 时写 `[DONE]`。 | handler／terminal |
| `src/routes/chat-completions/handler-v4.ts:839` | via-Responses closing drain 后写 `[DONE]`。 | handler／terminal |

补充边界：`src/lib/pipeline/delivery/session.ts:600` 是 owner→raw 的 `OwnerRawSink.write` physical call，不是 `ClientSink.write`，在第 4 节 raw adapter 中计入。

### 2. `writeSynthetic`／`writeKeepalive`／`writeSyntheticEnvelope` 的生产调用点

**取数命令（可复跑）**

```bash
rg -n --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' 'writeSynthetic|writeKeepalive|writeSyntheticEnvelope' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const names=new Set(["writeSynthetic","writeKeepalive","writeSyntheticEnvelope"]),fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); let c=0; for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const name=e=>ts.isPropertyAccessExpression(e)&&names.has(e.name.text)?e.name.text:ts.isParenthesizedExpression(e)&&ts.isBinaryExpression(e.expression)&&e.expression.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken&&ts.isPropertyAccessExpression(e.expression.left)&&names.has(e.expression.left.name.text)?e.expression.left.name.text:null; const v=n=>{if(ts.isCallExpression(n)){const x=name(n.expression);if(x){c++;const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${x}`)}}ts.forEachChild(n,v)};v(sf)} console.error(`COUNT=${c}`)'
```

- 方法 A（完整 `rg` 后逐处区分定义、注释、直接调用和 fallback-dispatch）得到 **28 个调用点／7 个文件**：`writeSynthetic` 22，`writeKeepalive` 3，`writeSyntheticEnvelope` 3。
- 方法 B（AST）先得到 23 个直接 property calls（`writeSynthetic` 21、`writeKeepalive` 1、`writeSyntheticEnvelope` 1），再得到 5 个 `(... ?? ...)(...)` fallback calls（`writeSynthetic` 1、`writeKeepalive` 2、`writeSyntheticEnvelope` 2），合计同为 **28**。两法一致。
- 代码调用 28；类型声明 3（`src/lib/pipeline/types.ts:762,770,782`）；函数实现／对象属性赋值不计入调用点；其余命中为注释／JSDoc。
- 正样本对照：已知 Responses HTTP H3 的 `src/routes/responses/handler-v4.ts:435` 与已知 fallback dispatch `src/lib/pipeline/delivery/session.ts:596` 均被对应检索式命中；后者证明扫描不会漏掉可选方法 fallback 形态。

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/lib/anthropic/live-reconcile.ts:160` | decorator 转发 `writeSynthetic`。 | writeSynthetic／decorator |
| `src/routes/messages/handler-v4.ts:713` | delayed-commit post-commit terminal。 | writeSynthetic／Anthropic |
| `src/routes/messages/handler-v4.ts:1477` | direct H3 error。 | writeSynthetic／Anthropic |
| `src/routes/messages/handler-v4.ts:1597` | malformed tool input error。 | writeSynthetic／Anthropic |
| `src/routes/messages/handler-v4.ts:1636` | direct truncation error。 | writeSynthetic／Anthropic |
| `src/routes/messages/handler-v4.ts:1700` | unexpected direct-pump throw error。 | writeSynthetic／Anthropic |
| `src/routes/messages/handler-v4.ts:1814` | translate H3 error。 | writeSynthetic／Anthropic |
| `src/routes/messages/handler-v4.ts:1854` | translate truncation error。 | writeSynthetic／Anthropic |
| `src/routes/messages/handler-v4.ts:1896` | unexpected translate-pump throw error。 | writeSynthetic／Anthropic |
| `src/routes/chat-completions/handler-v4.ts:601` | direct H3 error。 | writeSynthetic／CC |
| `src/routes/chat-completions/handler-v4.ts:656` | direct truncation error。 | writeSynthetic／CC |
| `src/routes/chat-completions/handler-v4.ts:792` | reverse H3 error。 | writeSynthetic／CC |
| `src/routes/chat-completions/handler-v4.ts:824` | reverse truncation error。 | writeSynthetic／CC |
| `src/routes/responses/handler-v4.ts:435` | direct H3 error。 | writeSynthetic／Responses |
| `src/routes/responses/handler-v4.ts:498` | direct truncation error。 | writeSynthetic／Responses |
| `src/routes/responses/handler-v4.ts:629` | reverse H3 error。 | writeSynthetic／Responses |
| `src/routes/responses/handler-v4.ts:657` | reverse truncation error。 | writeSynthetic／Responses |
| `src/routes/gemini/handler-v4.ts:470` | direct H3 error。 | writeSynthetic／Gemini |
| `src/routes/gemini/handler-v4.ts:503` | direct truncation error。 | writeSynthetic／Gemini |
| `src/routes/gemini/handler-v4.ts:670` | reverse H3 error。 | writeSynthetic／Gemini |
| `src/routes/gemini/handler-v4.ts:711` | reverse truncation error。 | writeSynthetic／Gemini |
| `src/lib/pipeline/delivery/session.ts:596` | owner 按 synthetic provenance 向 raw sink dispatch。 | writeSynthetic／owner→raw fallback |
| `src/lib/anthropic/live-reconcile.ts:161` | decorator 转发 `writeKeepalive`。 | writeKeepalive／decorator |
| `src/routes/messages/handler-v4.ts:690` | cold-start immediate ping，经 keepalive-or-write fallback。 | writeKeepalive／Anthropic fallback |
| `src/lib/pipeline/delivery/session.ts:588` | owner 按 keepalive provenance 向 raw sink dispatch。 | writeKeepalive／owner→raw fallback |
| `src/lib/anthropic/live-reconcile.ts:162` | decorator 转发 `writeSyntheticEnvelope`。 | writeSyntheticEnvelope／decorator |
| `src/lib/anthropic/keepalive-anchor.ts:382` | fabricated `message_start`，经 envelope-or-write fallback。 | writeSyntheticEnvelope／injector fallback |
| `src/lib/pipeline/delivery/session.ts:592` | owner 按 synthetic-message-start provenance 向 raw sink dispatch。 | writeSyntheticEnvelope／owner→raw fallback |

### 3. `[DONE]` 的生产写出点

**取数命令（可复跑）**

```bash
rg -n --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' '\[DONE\]' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const v=n=>{if(ts.isCallExpression(n)&&n.arguments.some(a=>a.getText(sf).includes("[DONE]"))){const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${n.expression.getText(sf)}`)}ts.forEachChild(n,v)};v(sf)}'
```

- 方法 A（完整 `rg` + 逐处语义归类）得到 **3 个生产 client write-out 点／1 个文件**。
- 方法 B（AST）找到 8 个以 `[DONE]` 为参数子树的调用；其中 3 个是 `sink.write`，1 个是 production hook fixture builder，4 个是 candidate-session predicate/config，最终写出点同为 **3**。两法一致。
- 代码写出 3；其余代码引用是生成器、过滤／比较、测试工具；注释／JSDoc 另有多处，不计写出。
- 正样本对照：已知 direct CC terminal 的 `src/routes/chat-completions/handler-v4.ts:662` 被两法命中。

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/routes/chat-completions/handler-v4.ts:662` | direct CC 成功终止后写 trailing `[DONE]`。 | direct／terminal |
| `src/routes/chat-completions/handler-v4.ts:833` | reverse Anthropic leg 的 contentless-refusal 终止后写 `[DONE]`。 | reverse／terminal |
| `src/routes/chat-completions/handler-v4.ts:839` | reverse Anthropic leg 正常终止后写 `[DONE]`。 | reverse／terminal |

### 4. direct transport 调用点

本节“调用点”按**词法 physical frame send/write site**计数；同一 helper 被多类 caller 调用仍计一个词法点。`ws.close` 是 transport termination，不是 frame write，列入第 7 节相关边界说明。管理 History broadcast 的 `src/lib/ws/broadcast.ts:119,196` 不属于 generation client-visible boundary，明确排除。

**取数命令（可复跑）**

```bash
rg -n --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' '(stream|ws|rawWs)\.(writeSSE|send)\s*\(' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const v=n=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&["writeSSE","send"].includes(n.expression.name.text)){const recv=n.expression.expression.getText(sf);if(n.expression.name.text==="writeSSE"||/^(?:ws|rawWs)$/.test(recv)){const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${n.expression.getText(sf)}`)}}ts.forEachChild(n,v)};v(sf)}'
```

- 方法 A（完整 `rg`）命中 generation 候选 9 个，另命中管理 broadcast 2 个并有出处地排除。
- 方法 B（AST）同样枚举 11 个候选，排除 `src/lib/ws/broadcast.ts:119,196` 后为 **9 个 generation direct transport 词法点／4 个文件**。两法一致。
- 代码调用 9；注释中的 `writeSSE`／`ws.send` 不计。正样本对照：已知 raw SSE adapter `src/lib/pipeline/client-sink.ts:209` 和 Responses WS mixed helper `src/routes/responses/ws.ts:165` 均命中。

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/lib/pipeline/client-sink.ts:209` | `makeSseSink` 的 raw SSE physical adapter；由 delivery owner 向下调用。 | post-owner／raw adapter |
| `src/lib/pipeline/client-sink.ts:645` | `makeWsSink` 的 raw WS physical adapter；由 delivery owner 向下调用。 | post-owner／raw adapter |
| `src/routes/responses/ws.ts:165` | `sendErrorAndClose` physical send；caller 同时覆盖 sink 创建前的 parse／admission／runRequest error（312、322、647、652、659）与 owner 创建后的 stream-error／truncation（447、491）。 | **混合**／bypass helper |
| `src/routes/responses/ws.ts:595` | `onOpen` connection-cap rejection error frame；response owner 尚未创建。 | pre-owner／admission |
| `src/routes/responses/ws.ts:667` | 同一 socket 已有 in-flight operation 时拒绝第二个 `response.create`；第一 operation 的 owner 已存在，但该控制帧不属于其 generation owner command。 | post-owner／socket control bypass |
| `src/routes/messages/error-shaping-glue.ts:131` | pre-driver AskUserQuestion whole-turn SSE synthesis。 | pre-owner／AUQ |
| `src/lib/anthropic/warmup.ts:214` | warmup drop 的 `message_start`。 | pre-owner／warmup |
| `src/lib/anthropic/warmup.ts:230` | warmup drop 的 `message_stop`。 | pre-owner／warmup |
| `src/lib/anthropic/warmup.ts:243` | warmup fake 循环写每个 SSE event。 | pre-owner／warmup |

**异常：既有文档“8 个”不成立。** 其自身分类写成 raw adapter 2 + mixed helper 1 + WS admission/control 2 + AUQ 1 + warmup 3，算术即为 9；当前 AST 与未截断 `rg` 也都得到 9。

### 5. `stopFrame(` 的生产调用点

**取数命令（可复跑）**

```bash
rg -n --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' '\bstopFrame\s*\(' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const v=n=>{if(ts.isCallExpression(n)&&((ts.isIdentifier(n.expression)&&n.expression.text==="stopFrame")||(ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==="stopFrame"))){const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${n.expression.getText(sf)}`)}ts.forEachChild(n,v)};v(sf)}'
```

- 方法 A 与方法 B 均得到 **3 个调用点／3 个文件**；代码调用 3，类型声明／注释不计。
- 正样本对照：已知 owner terminal-close 的 `src/lib/pipeline/driver.ts:1185` 被两法命中。

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/lib/pipeline/driver.ts:1185` | buffered owner close callback 生成 anchor stop。 | buffered／owner close |
| `src/lib/anthropic/live-reconcile.ts:145` | live reconciler 在 real-start／terminal 前生成 anchor stop。 | live／owner close |
| `src/routes/messages/handler-v4.ts:1116` | handler `closeAnchorViaOwner` 生成 anchor stop。 | handler／owner close |

### 6. delivery sink／owner 的 composition 构造点

本节同时给两种口径：**外层 generation composition roots**（handler 将 raw transport 交给 delivery/anchored constructor）与**内部 constructor chaining**（factory 内 raw sink + owner session）。既有文档“10 个 composition-root 构造点”使用前一口径。

**取数命令（可复跑）**

```bash
rg -n --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' '\b(makeDeliverySseSink|makeDeliveryWsSink|makeAnchoredSseSink|makeSseSink|makeWsSink|createDownstreamDeliverySession)\s*\(' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const names=new Set(["makeDeliverySseSink","makeDeliveryWsSink","makeAnchoredSseSink","makeSseSink","makeWsSink","createDownstreamDeliverySession"]),fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const v=n=>{if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&names.has(n.expression.text)){const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${n.expression.text}`)}ts.forEachChild(n,v)};v(sf)}'
```

- 方法 A 与 AST 方法 B 均得到 **14 个 constructor call／6 个文件**。
- 其中 handler 外层 composition roots 为 **10 个／5 个文件**；factory 内部 chaining 为 **4 个／1 个文件**。代码调用 14；定义／JSDoc 不计。
- 正样本对照：已知 Anthropic anchored root `src/routes/messages/handler-v4.ts:574` 与内部 owner construction `src/lib/pipeline/client-sink.ts:497` 均被两法命中。

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/routes/messages/handler-v4.ts:574` | delayed-commit Anthropic anchored composition。 | outer root／makeAnchoredSseSink |
| `src/routes/messages/handler-v4.ts:658` | immediate Anthropic anchored composition。 | outer root／makeAnchoredSseSink |
| `src/routes/chat-completions/handler-v4.ts:523` | direct CC SSE delivery。 | outer root／makeDeliverySseSink |
| `src/routes/chat-completions/handler-v4.ts:760` | reverse CC SSE delivery。 | outer root／makeDeliverySseSink |
| `src/routes/responses/handler-v4.ts:351` | direct Responses SSE delivery。 | outer root／makeDeliverySseSink |
| `src/routes/responses/handler-v4.ts:600` | reverse Responses SSE delivery。 | outer root／makeDeliverySseSink |
| `src/routes/gemini/handler-v4.ts:429` | direct Gemini SSE delivery。 | outer root／makeDeliverySseSink |
| `src/routes/gemini/handler-v4.ts:634` | reverse Gemini SSE delivery。 | outer root／makeDeliverySseSink |
| `src/routes/responses/ws.ts:358` | Responses WS delivery。 | outer root／makeDeliveryWsSink |
| `src/routes/messages/handler-v4.ts:1192` | `makeAnchoredSseSink` 内创建 delivery sink。 | outer-layer helper／makeDeliverySseSink |
| `src/lib/pipeline/client-sink.ts:496` | delivery SSE factory 创建 raw SSE sink。 | internal chaining／makeSseSink |
| `src/lib/pipeline/client-sink.ts:497` | delivery SSE factory 创建 owner session。 | internal chaining／createSession |
| `src/lib/pipeline/client-sink.ts:698` | delivery WS factory 创建 raw WS sink。 | internal chaining／makeWsSink |
| `src/lib/pipeline/client-sink.ts:699` | delivery WS factory 创建 owner session。 | internal chaining／createSession |

### 7. `terminate(`／`finalize(` 的生产调用点

**取数命令（可复跑）**

```bash
rg -n -F --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' 'sink.finalize?.(' src
rg -n -F --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' 'session.terminate(' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const v=n=>{if(ts.isCallExpression(n)){const e=n.expression,name=ts.isIdentifier(e)?e.text:ts.isPropertyAccessExpression(e)?e.name.text:"";if(name==="terminate"||name==="finalize"){const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${e.getText(sf)}`)}}ts.forEachChild(n,v)};v(sf)}'
```

- `ClientSink/OwnerRawSink.finalize`：方法 A 与 AST 均得 **52 个调用点／6 个文件**。其中 handler-level `ClientSink.finalize` 51；owner 内向 raw sink 的 `OwnerRawSink.finalize` 1（`session.ts:285`）。
- `DownstreamDeliverySession.terminate`：两法均得 **1 个调用点／1 个文件**（`session.ts:544`，`clientSink.finalize` 适配到 `terminate({kind:"complete"})`）。
- 合计 delivery termination API **53 个调用点／6 个文件**。代码调用 53；其他同名 `finalize`（shutdown、tool decoder、lightweight model operation）按 receiver 排除；注释／类型声明不计。
- 正样本对照：已知 `src/routes/messages/handler-v4.ts:1499` 与 `src/lib/pipeline/delivery/session.ts:544` 被两法命中。

完整清单如下；同一行即一个词法调用点：

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/lib/pipeline/delivery/session.ts:285` | owner finalize-once 向 raw sink finalize。 | finalize／owner→raw |
| `src/lib/pipeline/delivery/session.ts:544` | `clientSink.finalize` 调 `session.terminate({kind:"complete"})`。 | terminate／adapter |
| `src/routes/messages/handler-v4.ts:587,789,1444,1499,1529,1566,1606,1656,1676,1706,1792,1832,1877,1885,1903` | Anthropic delayed/direct/translate 各 terminal branch seal delivery。 | finalize／Anthropic／15 |
| `src/routes/chat-completions/handler-v4.ts:584,614,632,659,665,776,795,811,827,836,842` | CC direct/reverse 各 terminal branch seal delivery。 | finalize／CC／11 |
| `src/routes/responses/handler-v4.ts:419,448,474,501,507,616,632,645,660,668,674` | Responses HTTP direct/reverse 各 terminal branch seal delivery。 | finalize／Responses HTTP／11 |
| `src/routes/responses/ws.ts:430,464,498,504` | Responses WS abort/error/truncation/complete seal operation。 | finalize／Responses WS／4 |
| `src/routes/gemini/handler-v4.ts:452,479,512,525,655,679,693,720,728,735` | Gemini direct/reverse 各 terminal branch seal delivery。 | finalize／Gemini／10 |

补充 transport close（不计入上述 `terminate/finalize` 数）：Responses WS 的 `sendErrorAndClose` 在 `src/routes/responses/ws.ts:174` 调 `ws.close(1011, ...)`；成功路径 `:506` 调 `ws.close(1000,"done")`；admission/control 还在 `:574,:610` close。它们是 composition-root 反转时需保留的 socket-lifetime capability。

### 8. 直接持有 `stream`／`ws` 句柄的生产闭包

本节按“会形成 generation client-visible output composition 边界，且闭包／函数参数或捕获变量中直接保留 raw handle”计；纯 helper（例如 `wsConnectionKey`）若不负责 emission composition 不计。

**取数命令（可复跑）**

```bash
rg -n --glob 'src/**/*.ts' --glob '!src/**/*.test.ts' 'streamSSE\(c, async \(stream\)|\bstream:\s*(SSEStreamingApi|Parameters<Parameters<typeof streamSSE)|\bws:\s*WSContext|make(Sse|Ws|DeliverySse|DeliveryWs)Sink\((stream|ws)' src
bun -e 'import ts from "typescript"; import { readdirSync,readFileSync,statSync } from "fs"; import { join } from "path"; const fs=[]; const w=d=>{for(const n of readdirSync(d)){const p=join(d,n),s=statSync(p);if(s.isDirectory())w(p);else if(/\.tsx?$/.test(n)&&!/[.-](?:test|spec)\.tsx?$/.test(n))fs.push(p)}}; w("src"); for(const f of fs){const sf=ts.createSourceFile(f,readFileSync(f,"utf8"),ts.ScriptTarget.Latest,true); const v=n=>{if(ts.isFunctionLike(n)){let hit=false;const z=x=>{if(ts.isIdentifier(x)&&(x.text==="stream"||x.text==="ws"))hit=true;ts.forEachChild(x,z)};z(n);if(hit){const q=sf.getLineAndCharacterOfPosition(n.getStart());console.log(`${f}:${q.line+1}\t${n.name?.getText(sf)??"<closure>"}`);return}}ts.forEachChild(n,v)};v(sf)}'
```

- 两法得到同一集合：**23 个 production emission-relevant 闭包／函数点，分布于 8 个文件**。其中 route/composition 层 19 个，raw/delivery factory 4 个。
- 正样本对照：`src/routes/messages/handler-v4.ts:561`（outer stream closure）、`src/routes/responses/ws.ts:259`（WS generation handler）、`src/lib/pipeline/client-sink.ts:188`（raw factory）均命中。

| file:line | 说明 | 分类标签 |
|---|---|---|
| `src/routes/messages/handler-v4.ts:561` | delayed-commit `streamSSE` closure，创建 anchored sink 并持 `stream`。 | route closure／stream |
| `src/routes/messages/handler-v4.ts:645` | immediate `streamSSE` closure，创建 anchored sink 并持 `stream`。 | route closure／stream |
| `src/routes/messages/handler-v4.ts:1124` | `makeAnchoredSseSink` composition helper 持 `stream` 并在 :1192 创建 delivery sink。 | composition helper／stream |
| `src/routes/chat-completions/handler-v4.ts:259` | outer `streamSSE` closure。 | route closure／stream |
| `src/routes/chat-completions/handler-v4.ts:498` | direct pump function（其 options 在 :446 声明 raw handle）持 `stream` 并在 :523 composition。 | pump／stream |
| `src/routes/chat-completions/handler-v4.ts:753` | reverse pump function（其 options 在 :730 声明 raw handle）持 `stream` 并在 :760 composition。 | pump／stream |
| `src/routes/responses/handler-v4.ts:228` | outer `streamSSE` closure。 | route closure／stream |
| `src/routes/responses/handler-v4.ts:324` | direct pump function（其 options 在 :310 声明 raw handle）持 `stream` 并在 :351 composition。 | pump／stream |
| `src/routes/responses/handler-v4.ts:594` | reverse pump function（其 options 在 :569 声明 raw handle）持 `stream` 并在 :600 composition。 | pump／stream |
| `src/routes/gemini/handler-v4.ts:301` | outer `streamSSE` closure。 | route closure／stream |
| `src/routes/gemini/handler-v4.ts:422` | direct pump function（其 options 在 :384 声明 raw handle）持 `stream` 并在 :429 composition。 | pump／stream |
| `src/routes/gemini/handler-v4.ts:627` | reverse pump function（其 options 在 :605 声明 raw handle）持 `stream` 并在 :634 composition。 | pump／stream |
| `src/routes/responses/ws.ts:133` | `sendErrorAndClose` helper 直接持 `ws` 并 physical send/close。 | helper／ws／mixed |
| `src/routes/responses/ws.ts:224` | wrapper `handleResponseCreate` 持 `ws` 并下传。 | wrapper／ws |
| `src/routes/responses/ws.ts:259` | generation `handleResponseCreateV4` 持 `ws`，创建 owner 后仍用于 bypass error/close。 | pump／ws／mixed |
| `src/routes/responses/ws.ts:588` | `onOpen` socket composition 持 `ws`，执行 admission send/close。 | socket composition／ws／pre-owner |
| `src/routes/responses/ws.ts:634` | `onMessage` socket composition 持 `ws`，执行 parse/control sends 并启动 generation。 | socket composition／ws／mixed |
| `src/routes/messages/error-shaping-glue.ts:129` | AUQ `streamSSE` closure 直接 physical write。 | pre-owner closure／stream |
| `src/lib/anthropic/warmup.ts:211` | warmup drop `streamSSE` closure。 | pre-owner closure／stream |
| `src/lib/anthropic/warmup.ts:241` | warmup fake `streamSSE` closure。 | pre-owner closure／stream |
| `src/lib/pipeline/client-sink.ts:188` | raw SSE factory 持 `stream`。 | raw factory／stream |
| `src/lib/pipeline/client-sink.ts:494` | delivery SSE factory 持 `stream`，创建 raw sink + owner。 | delivery factory／stream |
| `src/lib/pipeline/client-sink.ts:619` | raw WS factory 持 `ws`。 | raw factory／ws |
| `src/lib/pipeline/client-sink.ts:696` | delivery WS factory 持 `ws`，创建 raw sink + owner。 | delivery factory／ws |

这 23 个是 composition-root 反转的 emission-relevant handle-supply inventory；并非都应消失：raw adapter／socket lifetime composition 应继续持 handle，generation pump／runner 的 raw handle 参数则是反转目标。

### 9. 测试面规模

边界：`tests/**/*.{ts,tsx}`；commit `854421d4e9765491f840e4daba9f42a36127fd3f`。`makeArraySink` 调用与 TypeScript checker 判定可赋给 `ClientSink`／`OwnerRawSink`、且自身含 `write` member 的 object literal 计“构造点”；纯 holder／返回包装对象不计。sink API 文件数按 AST code identifier 计，另给 raw-text 数以显式分离 comment-only 命中。raw factory 只计 `makeSseSink`／`makeWsSink` 的 CallExpression。

**取数命令（可复跑）**

```bash
rg -n --glob 'tests/**/*.ts' --glob 'tests/**/*.tsx' '\bmakeArraySink\s*\(' tests
rg -n --glob 'tests/**/*.ts' --glob 'tests/**/*.tsx' '\b(ClientSink|OwnerRawSink)\b' tests
rg -l --glob 'tests/**/*.ts' --glob 'tests/**/*.tsx' '\b(ClientSink|OwnerRawSink|makeArraySink|makeSseSink|makeWsSink)\b' tests
rg -n --glob 'tests/**/*.ts' --glob 'tests/**/*.tsx' '\b(makeSseSink|makeWsSink)\s*\(' tests
bun -e 'import ts from "typescript"; const cfg=ts.readConfigFile("tsconfig.json",ts.sys.readFile),pc=ts.parseJsonConfigFileContent(cfg.config,ts.sys,"."),p=ts.createProgram(pc.fileNames,pc.options),c=p.getTypeChecker(); let client,raw,array=0,typed=0,rawCalls=0; const af=new Set,tf=new Set,rf=new Set,dep=new Set,names=new Set(["ClientSink","OwnerRawSink","makeArraySink","makeSseSink","makeWsSink"]); for(const sf of p.getSourceFiles())if(/src\/lib\/pipeline\/(?:delivery\/)?types\.ts$/.test(sf.fileName))for(const st of sf.statements)if((ts.isInterfaceDeclaration(st)||ts.isTypeAliasDeclaration(st))){if(st.name.text==="ClientSink")client=c.getTypeAtLocation(st.name);if(st.name.text==="OwnerRawSink")raw=c.getTypeAtLocation(st.name)} for(const sf of p.getSourceFiles()){if(!/(^|\/)tests\//.test(sf.fileName)||!sf.fileName.endsWith(".ts"))continue;const f=sf.fileName.replace(/^.*\/tests\//,"tests/");const v=x=>{if(ts.isIdentifier(x)&&names.has(x.text))dep.add(f);if(ts.isCallExpression(x)&&ts.isIdentifier(x.expression)){if(x.expression.text==="makeArraySink"){array++;af.add(f)}if(x.expression.text==="makeSseSink"||x.expression.text==="makeWsSink"){rawCalls++;rf.add(f)}}if(ts.isObjectLiteralExpression(x)&&x.properties.some(q=>q.name?.getText(sf)==="write")){const t=c.getTypeAtLocation(x);if(c.isTypeAssignableTo(t,client)||c.isTypeAssignableTo(t,raw)){typed++;tf.add(f)}}ts.forEachChild(x,v)};v(sf)} console.log({array,arrayFiles:af.size,typed,typedFiles:tf.size,total:array+typed,unionFiles:new Set([...af,...tf]).size,sinkApiFiles:dep.size,rawCalls,rawFiles:rf.size})'
```

- array sink：`rg` 与 AST 均为 **45 点／18 文件**。
- typed fake sink：方法 A 为完整 type-reference／constructor-argument `rg` 后逐个 object literal 归类，方法 B 为 TypeScript checker 独立枚举“object literal 自身含 `write`，且 inferred/contextual type 可赋给 `ClientSink|OwnerRawSink`”；两者均为 **47 点／24 文件**。这比只识别显式 type annotation/assertion 的浅 AST（40／22）多 7 点，新增点是通过默认参数、函数参数或 contextual return 推断出的真实 typed fake。
- 两类合并：方法 A 与方法 B 均为 **92 个构造点／40 个 union 文件**。这与既有文档 82／35 不一致；完整文件表见下。
- 依赖 sink API：raw-text `rg -l` 为 **61 文件**；AST code identifier 为 **57 文件**。差额 4 个是 comment／string-only：`tests/anthropic/anthropic-v4.http.test.ts`、`tests/architecture/generation-engine-boundaries.unit.test.ts`、`tests/pipeline/generation-runtime-baseline.http.test.ts`、`tests/responses/candidate-response-session.unit.test.ts`。因此若“依赖”指编译期代码引用，权威数是 **57**；若沿用既有文本命中口径，则是 **61**。
- raw SSE／WS factory：`rg` 与 AST 均为 **65 个调用点／14 文件**。
- 正样本对照：`tests/openai/reverse-cc-messages.it.test.ts:194`（array）、`tests/pipeline/driver.unit.test.ts:1117`（typed fake）、`tests/pipeline/client-sink.unit.test.ts:100`（raw factory）均被相应扫描命中。

#### 9.1 array／typed fake sink 完整文件清单

| 文件 | array 点 | typed fake 点 | 合计 |
|---|---:|---:|---:|
| `tests/anthropic/anthropic-stream-roundtrip.it.test.ts` | 1 | 0 | 1 |
| `tests/anthropic/live-reconcile.unit.test.ts` | 0 | 3 | 3 |
| `tests/anthropic/translate-leg-flush-reconcile.unit.test.ts` | 2 | 0 | 2 |
| `tests/gemini/reverse-gemini-messages.it.test.ts` | 1 | 0 | 1 |
| `tests/openai/reverse-cc-messages.it.test.ts` | 1 | 0 | 1 |
| `tests/pipeline/allocation-begin-leg-after-termination.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/allocation-commit-point.it.test.ts` | 0 | 5 | 5 |
| `tests/pipeline/allocation-outside-owner-control.it.test.ts` | 0 | 2 | 2 |
| `tests/pipeline/allocation-real-block-refusal.it.test.ts` | 0 | 6 | 6 |
| `tests/pipeline/allocation-recovery-leg.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/anchor-allocation-owner.it.test.ts` | 0 | 3 | 3 |
| `tests/pipeline/anchor-allocation-race.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/anchor-allocator-bridge.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/anchor-injector-mirror-state.it.test.ts` | 0 | 3 | 3 |
| `tests/pipeline/begin-leg-fence.it.test.ts` | 0 | 2 | 2 |
| `tests/pipeline/buffer-hold-timing.unit.test.ts` | 1 | 0 | 1 |
| `tests/pipeline/buffered-block-level.it.test.ts` | 3 | 0 | 3 |
| `tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts` | 1 | 0 | 1 |
| `tests/pipeline/buffered-merge-wiring.unit.test.ts` | 2 | 0 | 2 |
| `tests/pipeline/buffered-sink.unit.test.ts` | 11 | 0 | 11 |
| `tests/pipeline/client-sink.unit.test.ts` | 3 | 0 | 3 |
| `tests/pipeline/continuation-flow.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/continuation-retry.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/cross-leg-mapping-isolation.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/delivery-finish-race.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/delivery-finished-outcome.it.test.ts` | 0 | 3 | 3 |
| `tests/pipeline/delivery-session.unit.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/delivery-terminal-race.unit.test.ts` | 0 | 2 | 2 |
| `tests/pipeline/driver-leg-fence.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/driver.unit.test.ts` | 7 | 4 | 11 |
| `tests/pipeline/generation-recorder-driver.unit.test.ts` | 3 | 0 | 3 |
| `tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/heartbeat-suspend.it.test.ts` | 1 | 1 | 2 |
| `tests/pipeline/hedged-driver.it.test.ts` | 3 | 0 | 3 |
| `tests/pipeline/hooks/reload-and-l2.it.test.ts` | 1 | 0 | 1 |
| `tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts` | 1 | 0 | 1 |
| `tests/pipeline/live-owner-port.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/live-reconcile-collision.it.test.ts` | 0 | 1 | 1 |
| `tests/pipeline/response-pump-operation.unit.test.ts` | 1 | 0 | 1 |
| `tests/responses/reverse-responses-messages.it.test.ts` | 2 | 0 | 2 |

#### 9.2 sink API code-reference 完整文件清单

下表是 57 个 AST code-identifier 文件；类型引用属于代码，注释／字符串不属于代码。

| 文件 |
|---|
| `tests/anthropic/anthropic-stream-roundtrip.it.test.ts` |
| `tests/anthropic/enveloped-ping.it.test.ts` |
| `tests/anthropic/keepalive-active-path.unit.test.ts` |
| `tests/anthropic/live-pre-response-anchor.it.test.ts` |
| `tests/anthropic/live-reconcile.unit.test.ts` |
| `tests/anthropic/translate-leg-flush-reconcile.unit.test.ts` |
| `tests/architecture/package-boundaries.unit.test.ts` |
| `tests/chat-completions/cc-keepalive.unit.test.ts` |
| `tests/gemini/reverse-gemini-messages.it.test.ts` |
| `tests/openai/reverse-cc-messages.it.test.ts` |
| `tests/pipeline/allocation-begin-leg-after-termination.it.test.ts` |
| `tests/pipeline/allocation-commit-point.it.test.ts` |
| `tests/pipeline/allocation-outside-owner-control.it.test.ts` |
| `tests/pipeline/allocation-real-block-refusal.it.test.ts` |
| `tests/pipeline/allocation-recovery-leg.it.test.ts` |
| `tests/pipeline/anchor-allocation-owner.it.test.ts` |
| `tests/pipeline/anchor-allocation-race.it.test.ts` |
| `tests/pipeline/anchor-allocator-bridge.it.test.ts` |
| `tests/pipeline/anchor-injector-mirror-state.it.test.ts` |
| `tests/pipeline/anchor-multiblock-lifecycle.it.test.ts` |
| `tests/pipeline/begin-leg-fence.it.test.ts` |
| `tests/pipeline/buffer-hold-timing.unit.test.ts` |
| `tests/pipeline/buffered-anchor-golden.it.test.ts` |
| `tests/pipeline/buffered-anchor.unit.test.ts` |
| `tests/pipeline/buffered-block-level.it.test.ts` |
| `tests/pipeline/buffered-hedge-mutual-exclusion.unit.test.ts` |
| `tests/pipeline/buffered-merge-wiring.unit.test.ts` |
| `tests/pipeline/buffered-sink.unit.test.ts` |
| `tests/pipeline/client-first-real.unit.test.ts` |
| `tests/pipeline/client-sink-block-stack.it.test.ts` |
| `tests/pipeline/client-sink.unit.test.ts` |
| `tests/pipeline/continuation-flow.it.test.ts` |
| `tests/pipeline/continuation-retry.it.test.ts` |
| `tests/pipeline/cross-leg-mapping-isolation.it.test.ts` |
| `tests/pipeline/delivery-finish-race.it.test.ts` |
| `tests/pipeline/delivery-finished-outcome.it.test.ts` |
| `tests/pipeline/delivery-session.unit.test.ts` |
| `tests/pipeline/delivery-terminal-race.unit.test.ts` |
| `tests/pipeline/driver.unit.test.ts` |
| `tests/pipeline/generation-recorder-client-sink.unit.test.ts` |
| `tests/pipeline/generation-recorder-driver.unit.test.ts` |
| `tests/pipeline/heartbeat-survives-boundary-commit.it.test.ts` |
| `tests/pipeline/heartbeat-suspend.it.test.ts` |
| `tests/pipeline/hedged-driver.it.test.ts` |
| `tests/pipeline/hooks/driver-provenance.unit.test.ts` |
| `tests/pipeline/hooks/reload-and-l2.it.test.ts` |
| `tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts` |
| `tests/pipeline/live-owner-port.it.test.ts` |
| `tests/pipeline/live-reconcile-collision.it.test.ts` |
| `tests/pipeline/owns-sink-two-racer.unit.test.ts` |
| `tests/pipeline/response-pump-operation.unit.test.ts` |
| `tests/pipeline/retreat-anchor-collision.it.test.ts` |
| `tests/responses/heartbeat-survives-item-commit.it.test.ts` |
| `tests/responses/responses-keepalive.unit.test.ts` |
| `tests/responses/responses-ws-keepalive.unit.test.ts` |
| `tests/responses/reverse-responses-messages.it.test.ts` |
| `tests/responses/upstream-idle-margin.unit.test.ts` |

#### 9.3 raw SSE／WS factory 完整文件清单

| 文件 | 构造点数 |
|---|---:|
| `tests/anthropic/enveloped-ping.it.test.ts` | 1 |
| `tests/anthropic/keepalive-active-path.unit.test.ts` | 5 |
| `tests/chat-completions/cc-keepalive.unit.test.ts` | 3 |
| `tests/pipeline/client-first-real.unit.test.ts` | 2 |
| `tests/pipeline/client-sink-block-stack.it.test.ts` | 4 |
| `tests/pipeline/client-sink.unit.test.ts` | 27 |
| `tests/pipeline/generation-recorder-client-sink.unit.test.ts` | 1 |
| `tests/pipeline/heartbeat-suspend.it.test.ts` | 4 |
| `tests/pipeline/hooks/driver-provenance.unit.test.ts` | 5 |
| `tests/pipeline/owns-sink-two-racer.unit.test.ts` | 2 |
| `tests/responses/heartbeat-survives-item-commit.it.test.ts` | 1 |
| `tests/responses/responses-keepalive.unit.test.ts` | 3 |
| `tests/responses/responses-ws-keepalive.unit.test.ts` | 5 |
| `tests/responses/upstream-idle-margin.unit.test.ts` | 2 |

### 10. 与既有文档的差异

对照对象：`/home/xp/src/copilot-api-js/docs/tmp/2026-08-03-m1-owner-wire-boundary-design.md` §1.2／§1.2.1，以及该文 `:261` 测试迁移数字；本 inventory 锚定 commit `854421d4e9765491f840e4daba9f42a36127fd3f`。

| 项目 | 既有文档 | 本次实测 | 结论 | 证据 |
|---|---:|---:|---|---|
| `ClientSink.write` production calls | 10 | 10／4 文件 | 一致 | 第 1 节 AST + `rg`；另有 1 个 owner→raw physical write，口径分开。 |
| `writeSynthetic` production calls | 21 | 22 | **不一致** | 第 2 节完整表；21 个直接 property calls之外，`session.ts:596` 的 `(sink.writeSynthetic ?? sink.write)(...)` 也是实际调用点。若旧口径只数 direct property syntax，则 21。 |
| 三个 synthetic API 合计 | 未给 | 28 | 新增明示 | `writeSynthetic` 22 + `writeKeepalive` 3 + `writeSyntheticEnvelope` 3。 |
| `[DONE]` production write-outs | 3 | 3 | 一致 | 第 3 节。 |
| direct transport | 8 | 9 | **不一致** | 第 4 节；既有文档自己的分类 2+1+2+1+3=9，且 AST/`rg` 均列出 9 个词法点。 |
| outer composition roots | 10 | 10 | 一致 | 第 6 节；若将 factory 内 chaining 也纳入 constructor calls，则总数 14。 |
| array／typed fake sink constructs | 82 | 92 | **不一致** | 第 9 节：45 array + 47 checker-assignable typed fake；两类 union 40 文件。 |
| fake sink files | 35 | 40 | **不一致** | 第 9.1 节完整文件表。 |
| sink API test files | 61 | 57 code-reference／61 raw-text | **口径澄清** | 61 与旧文本 grep 一致，但其中 4 文件仅注释／字符串命中；编译期代码依赖是 57。 |
| raw SSE／WS factory constructs | 65 | 65／14 文件 | 一致 | 第 9.3 节 AST + `rg`。 |

### 11. 完备性边界与未命中项

- direct transport 等价物额外搜索了 `sendText`、`sendBinary`、`writeText`、`publish`，范围为 `src/**/*.{ts,tsx}` 非测试。`publish` 命中均为内部 observability/event bus，`socket.send` 命中 `src/lib/openai/upstream-ws-connection.ts:470` 是**上游** GHC transport，二者不属于 client-visible generation emission；没有额外下游点。
- `stopFrame` 同时搜索了 identifier call 与 property call；没有第四个 production 调用点。
- 本 inventory 的“完整”限于静态可达的 production lexical sites；动态 property access／反射式 transport emission 未找到。检索词包括 `writeSSE`、`ws.send`、`rawWs.send`、`sendText`、`sendBinary`、`writeText`、`publish`、`ClientSink`、`OwnerRawSink`、全部 named sink APIs。
