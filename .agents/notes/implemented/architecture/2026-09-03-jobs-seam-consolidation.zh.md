# Agent Note：后台 job 的一个输出环、一个投影、一条事件流

Status: implemented

[English](2026-09-03-jobs-seam-consolidation.md) | 中文

## 问题

job seam 是逐步堆出来的。生产者要把输出声明两次——模型读取的消耗式 `readOutput` 钩子，以及观察者读取的可选 `record: true` 环——注册表也为同一个 job 保留了两套词汇（模型侧的 `JobSnapshot`、会话控制流上的 `SessionJob`、观测线路上的 `JobWireChunk`）。三个监听器家族（`onJobDone`、`onJobsChanged`、`onOutput`）用不同的拥有者过滤投递彼此重叠的事实，注册表自己还跟踪着只有模型侧工具才解释得了的 `reported` 位。合并后设计的评审把接口层称作最薄弱的部分：读者分不清 `read`、`readRecord`、`JobStart`、`RecordingJob` 与 `updateDetail` 里哪些是约定、哪些是历史遗留。

## 决策

- **每个 job 一个环。** `JobSpec` 取代 `JobStart`：spec 声明可选的拉取式 `output` 源（`JobOutputSource`，子进程的 `readFrom` 家族），由注册表按自己的节奏（`dsh-jobs-local` 的 `pumpPollMs`）泵送；每个生产者都收到一个 `JobHandle`，其 `append` 把块推进同一个环。模型的消耗式读取与每个观察者的绝对偏移读取服务同一批字节；`readOutput` 与 `record` 判别字段被移除。shell 生产者把它们的 `observed` 偏移读取器交给注册表，并把沙箱事实折进终态 `detail`；terminal 生产者通过一个计字节的源适配其消耗式发送读取器；subagent 把回答作为 `JobOutcome.result` 返回，结算后的第一次读取携带它一次。
- **两个游标，一份存储。** `JobRegistry.read(id)` 是有状态的模型游标；`JobRegistry.readAt(id, from)` 是无状态的观察者读取。模型读取排除 `log` 块（给观察者的生产者叙述），并渲染 stdout，再接一段 `[stderr]`，与 shell 工具一贯的做法完全一致。
- **`updateProgress` 取代 `updateDetail`。** `JobView.progress` 是实时行，结算时清除；`JobView.detail` 是终态原因，合并了模型 `job_kill` 给出的原因。
- **一个投影。** `JobView`（客户端安全叶子 `@deepseek-ai/dsh-jobs/view`）是模型工具、浏览器名册与观测帧共同消费的形状；`owner` 是会话 id，从不是 `Agent`。
- **直接传入调用方的操作。** `JobRegistry.list`、`get`、`read`、`readAt`、`kill` 与 `wait` 在每次调用时接收调用方会话。省略调用方时仅允许访问无主 job。输出环与浏览器流不需要独立的调用方操作对象。
- **一条事件流。** 带 `{ owner }`、`{ owners: 'scope' }` 或 `{ owners: 'all' }` 过滤的 `events.subscribe(filter, listener)` 取代三个监听器家族。`settled` 标出原因（`producer`、`kill`、`teardown`）；`output` 只携带 id 与新的 total。
- **完成通知归 `dsh-tool-jobs` 所有。** 注册表的 `settled.awaited` 记录结算是否释放了仍在进行的等待。工具通过 `killedByModel` 跟踪已受理的模型 `job_kill` 请求并抑制重复通知，结算或移除会清除条目。尚未通过等待或模型 kill 投递的结算发送给当前登记的属主 Agent，跳过 teardown 与无主任务。浏览器 kill 不进入该台账。
- **名册传输遵循 Web 任务决策。** 分叉版经过授权的 BFF 在订阅基线与生命周期提交时发布 `session/jobs` 完整可见集，输出通过非消费的 `jobs.output` 独立读取。[Web 任务输出决策](../feature/2026-09-30-web-job-output-and-kill.zh.md) 负责该复用传输与客户端观察生命周期。输出事件不重发名册，BFF 保留生命周期发布顺序。

`attachController` 与相对拥有者的 `servesOwner` 门保持原样；没有挂载控制器的生产者是否可以提供 `run_in_background`，因为这个缺口早于本次变更，暂不处理。

## 考虑过的替代方案

- **保留三个监听器并共享一个拥有者过滤。** 它保住了堆出来的名字，却保不住评审要的性质——一个地方就能学会注册表宣布什么——而且 `onJobDone` 的精确拥有者投递正是迫使注册表在每个投影里保留 `Agent` 的原因。
- **把 `reported`留在注册表。** 只有工具知道哪些投递到达了模型（等待的工具结果、kill 的确认）；注册表只能近似，而这个近似正是评审列出的重复播报与漏播报 bug 的来源。
- **也把 `log` 块交给模型。** 生产者叙述是给观察者的；模型已经通过 `progress` 与终态 `detail` 收到同样的事实。

## 后果

模型可见文本保持不变：状态行、工具描述与 schema、播报措辞逐字节相同，唯一新增的模型可见事实是 `killed` 状态行现在携带的 kill 原因。需要流式输出的生产者选择拉取源或 `append`，从不格式化消耗式增量。Web 客户端把每个进行中的 job 渲染为可展开，因此从不写输出的 job 显示为空的运行中面板而非静态行。`JobKindMap` 的合并发生在宿主侧，浏览器程序把 `JobView.kind` 视为它认识的 kind 集合，其余当作不透明字符串——名册对它也只做这些。

job 的第一个事件永远是 `registered`：通告先于泵，而泵的首轮 drain 同步执行且可能通告输出。已结算的环在模型的首次终态读取之前保留模型游标尚未消费的全部字节，因此在首次 `job_output` 之前结束的 job 不会丢失运行期上限保留的任何内容。等待在超时或中止时同步解除其结算回调，因此 `settled.awaited` 只反映仍应接收终态投影的等待。浏览器的轮询观察者把注册表拒绝显示为读取错误，并在仍有查看者持有观察时重试传输失败。拉取源保留的 spill 文件是 job 元数据（`JobView.output.spillPaths`，每次泵读取都会上报，读取不再点名时即撤回），不是逐块元数据；模型读取对生产者侧缺口与环淘汰都渲染 shell 工具的丢失输出提示并列出这些文件，即使缺口块本身已被淘汰。被拒绝的后台 spawn 不产生任何进程输出，因此 shell provider 把 `spawn failed: …` 提示作为 observed stderr 的整条流提供（消耗式读取仍只折入一次），且 `ShellProcess.observed` 及其两个读取器为必填。
