# Agent Note：Web 任务输出与人类 kill —— `session/jobs` 之上的游标读，而非第二个名册

Status: implemented

[English](2026-09-30-web-job-output-and-kill.md) | 中文

## 问题

[Web 任务展示 note](2026-08-08-web-background-job-display.zh.md) 交付的头部列表是只读的：活跃行显示状态词与跳动的耗时，终态行显示终态 `detail`，但没有任何读者能看到任务打印了什么，也没有一只手能停掉它。模型两样都有——`job_output` 消费环游标，`job_kill` 经 `ctx.jobs` 取消——而浏览器唯一的通道是 `session/jobs` 名册帧，一个刻意不带字节的生命周期投影。

要在不破坏该帧契约的前提下补上两个缺口：一条不消费模型读游标的单任务输出通道（浏览器若读 `ctx.jobs.read` 会悄悄拿走模型下一次 `job_output` 永远看不到的字节），以及一个不把生产者终态结算仍欠模型的通知据为己有的 kill 受理。

## 决策

### 既有载体上的两个一元 RPC

`jobs.output({ sessionId?, jobId, from? })` 与 `jobs.kill({ sessionId, jobId })` 落在 API proxy 上，与 [`packages/host/apiproxy/src/api/jobs.ts`](../../../../packages/host/apiproxy/src/api/jobs.ts) 里其它域契约并列。没有流式 RPC，也没有第二个名册：`session/jobs` 帧仍是唯一的名册通道，两个方法都是同一客户端传输上的普通请求/响应。

- `jobs.output` 是**非消费读**：它调注册表的 `readAt` 而非 `read`，模型侧游标从不移动。`from` 是绝对字节偏移；响应携带新鲜 `JobView`、环的 `output` 坐标（`total`、`earliest`、可选 `spillPaths`）、与 `[from, total)` 重叠的保留块、续读游标 `next`，以及 `from` 落在 `earliest` 之下时的 `lossy: true`。落在某个保留块内部的 `from` 会返回整块（其 `at` 可早于 `from`）；调用方按绝对偏移去重而非按块身份。带 `sessionId` 的读取经 `authorizeSession(sessionId, 'read')` 限定在该会话自己的任务上；不带时经 `captureCollaboration('read')` 只看到无主任务，与 `list(caller)` 的可见性一致。未知与越权 id 收敛为同一个 `job-not-found` 拒绝，线路永远不泄露失败的是哪一个。
- `jobs.kill` 要求 `sessionId`，在注册表属主栅栏之前先过 `authorizeSession(sessionId, 'write')`，所以浏览器只能停掉本会话本可列为己有的任务。响应只是受理——`requested` 或 `already-finished`——而非终态；行经下一帧 `session/jobs` 收敛（`stopping`，再到终态），因为一元响应与 mux 帧之间没有跨载体排序，只有权威帧能证明迁移发生。宿主转发原因 `'cancelled by the user'`，注册表将其并入 `killed` 结算的 `detail`；跑赢 kill 的任务只保留生产者 detail。
- **kill 不占有投递。** `JobRegistry.kill` 只记录原因；终态通知仍走生产者的完成路径，模型被告知任务被停掉了，而不是被留下自行推断。这满足了名册 note 当初记下的、使该控件无法在旧契约上落地的面向模型要求。
- `JobView` 新增 `output: { total, earliest, spillPaths? }`——环的绝对坐标——使终态行是否可展开（`total > 0`）成为名册数据而非探测读。帧依旧丢弃 `ownerSession`、`reported` 与 `outputLimitBytes`。

### 客户端观察：引用计数轮询，而非流

`SessionManager.observeJob(sessionId, jobId)` 返回一个释放闭包；列表快照上的 `observedJobs` 为每个被观察 id 持有一个 `ObservedJob`（`text`、`gapBefore`、`streaming`、可选 `error`）。同一任务的多个观察者共用一个按 job id 键控的循环，两个展开查看者不会让读取翻倍；循环每个 `JOB_OBSERVE_POLL_MS` 跑一拍，在最后一个查看者释放、任务结算且输出抽干（`next >= output.total`）、或读取返回业务拒绝时结束。传输失败在下一拍重试——游标使重读幂等——而 `job-not-found` 是终态。累积文本以 128 KiB 为界并按代理对安全截断，每条截断路径——环驱逐、`lossy`、块上的 `gapBefore`、渲染界——都折叠成一个 `gapBefore` 标记，由面板渲染为保留缺口提示。`killJob` 是返回注册表是否受理的直通；sessions 服务与运行时池暴露两个方法并路由到会话所属的运行时。

### 列表控件

`JobListAction` 把可观察行——活跃任务，或留有输出环的终态任务——渲染为可展开进 `TerminalBlock` 面板；行的状态点仍是状态来源，面板不另画，复制的是命令而非输出，缺口与读取失败以面板上方提示呈现。运行中行带一个两段式停止控件：第一次按下武装它，三秒内的确认按下发出 `killJob`，受理后按下的控件保持待决直到名册帧把该行移出可杀集合，被拒的按下显示短暂失败提示。存在活跃工作时终态分区折叠在其计数之后，可在客户端清空；768px 以下整个列表走共享的手机 Sheet。

## 备选方案

- **流式 `job.follow` 通道**——上游的答案——在此被拒，因为本组合的名册在 `session/jobs` 帧上，没有按任务推送的传输；第二条流式通道会为一个只以人类扫视频率轮询的读者重复 mux 的订阅生命周期。游标拉取对丢失容忍：错过一个窗口只是 `gapBefore` 标记，而非协议违约。
- **经 `ctx.jobs.read` 的消费读**——直接否决：它会移动模型侧游标并悄悄饿死 `job_output`，一个在调用点不可见的失败。
- **kill 上的 `notify: boolean`**——按上游 note 的论证否决，它仍然成立：注册表无法承诺通知，所以唯一诚实的契约是「kill 不占有投递」，原因走 `detail`。
- **单独的 `stopByUser()`**——以上游给出的同一理由否决：一条调用方明确的取消路径胜过两个只差一个标志的方法。

## 测试

`api-proxy-jobs.spec.ts` 经真实组合 context 端到端钉住线路契约：基线与生命周期帧携带 `output` 坐标；`jobs.output` 读自有环而不触碰模型游标（`ctx.jobs.read` 探针保持未调用）；无围栏读取只见无主任务；越权与未知 id 同样拒绝；`from` 以块粒度续读；越过保留窗口的环应答 `lossy`；`jobs.kill` 把活任务受理进 `stopping`、对已结算任务报 `already-finished`、拒绝越权与未知 id。`rpc-schemas.spec.ts` 钉住两对请求/值 schema 与 `job-not-found` 错误负载。`manager.client.spec.ts` 用可决 deferred 假响应与假时钟钉住观察循环——首读、游标推进、累积、终态抽干、业务拒绝呈现、释放拆除、引用共享轮询。`ui-jobs` spec 钉住两段式控件、展开生命周期、缺口与失败提示、折叠与清空。

## 后果

- 输出滞后界为 1 秒轮询加一次往返；这是不为一个扫视界面长出推送通道的代价。
- 终态任务的面板恰好等于环所保留的——首次读取前已驱逐的输出只剩模型仍能指名的 spill 文件，面板经缺口标记把这一点说出来。
- `JobView.output` 让每帧名册重了几个字节，并使 `output` 成为必填线路字段；每个 `JobView` 生产者（proxy 映射、测试 fixture）都要供给它。
- 从子会话自己的列表杀掉它自己的任务，仅凭注册表属主栅栏即被允许；本层没有第二道属主栅栏。
