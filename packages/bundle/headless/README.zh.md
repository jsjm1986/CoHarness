# `@deepseek-ai/dsh-headless`

[English](README.md) | 中文

dsh 一次性任务组合包。[`cordis.patch.yml`](cordis.patch.yml) 直接叠加在 [`dsh-base`](../base/README.zh.md) 之上：提供编码 persona 和工具模式、禁用 HMR（热模块替换）、将 PTC mode 的 worker 作为核心执行能力挂载，并插入本包的 `headless-runner` 插件（配置为 `{task, sessionId, json, progress}`，从注入的 `headlessStartup` 提供方解析）。它不挂载任何 Host、HTTP server、Web runtime 或浏览器插件。

Loader 结算后，runner 读取共享的 [`ctx.agentDefaultModel`](../../core/agent-default-model/README.zh.md)，解析 Agent 身份——默认是全新的 `session-<uuid>`，或由 `--session-id` 指定的既有持久化 Session（经 `ctx.sessionQuery` 收养；日志不存在、Session 已在本进程中存活、或其记录的 cwd 与 agent preset 与本次运行不匹配时拒绝）——将任务作为普通用户消息提交，并等待完全停稳。它对 Session 执行 flush 后再汇总自身持有的持久化事件区间，将最后一条非空 assistant 文本写入 stdout，再经启动器提供的 `ctx.appExit` 宿主钩子（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)）请求退出（最终 `turn/end` 完成 → 0，否则为 1）。最终结束原因为 `error` 时，还会将 code 与 message 写入 stderr。`progress: true` 时会将 provider reasoning 分片流式写入 stderr；默认值为 `false`，因此成功运行时 stderr 保持为空。`--json` 则把最终文本行替换为 stdout 上的换行分隔 JSON 事件流——开头是 `session` 事件，中间是在提交点投影的 `status`/`text`/`thinking`/`tool_call`/`tool_result` 事件，结尾是 `final` 事件——stderr 只保留 `dsh:` 诊断。进程不会打开监听端口。任务文本就是这个应用的命令行：普通 `headless-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.zh.md)），读取 `dsh --profile headless "task"` 的位置参数——参数缺省或为单独的 `-` 时改读 stdin——以及 `--session-id` 与 `--json` 选项，打印应用自己的 `--help`，并提供 `headlessStartup`；runner 注入该服务，再从惰性配置中读取运行选项。缺失或只有空白的任务会在 runner 激活前被拒绝；`--json` 模式下每个用法错误还会向 stdout 写入一条 `error` 事件。

## 概述

`dsh-headless` 从命令行运行一个 dsh 任务并打印最终答案，然后退出——没有 GUI、没有服务器、没有浏览器。输入 `dsh --profile headless "run the tests"`，agent（智能体）会以与所有其他表层相同的模型、工具与安全默认值完成该任务。它非常适合脚本、CI 与一次性任务：进程不打开任何端口，也不会留下任何后台运行的东西。监督进程还可以通过按行 JSON 事件流（`--json`）驱动它，并用该事件流报告的标识（`--session-id`）在同一段对话上继续唤醒。退出码告诉你结果——任务完成时为 0，中止或出错时为 1。主要边界：每次调用只运行一个任务，没有交互式后续。

## 模型体验

无，因为 runner 把任务作为普通用户消息提交，提示词与工具由组合出的 base 与 headless 行提供。

#### KV Cache 影响

runner 不向请求前缀添加任何内容；它只是驱动组合出的配置树处理一条用户消息。

## 已知限制与暂缓事项

- **只提交一个任务**：runner 没有用于交互式后续输入的 surface；它会等待 Agent 在返回 idle 前完成的所有工作，并打印该区间内最后一条非空 assistant 消息。
- **`ctx.appExit` 由启动器持有**：在 `dsh` 启动器之外启动 headless profile 会在激活时明确报错，直到宿主提供该退出请求。
- **收养有范围限制**：`--session-id` 要求组合了 `sessionPersistence` 与 `sessionQuery` 服务，并拒绝记录在其他工作目录下、或运行在本 profile 未组合的 agent preset 下的 Session。
- **事件流是投影而非日志**：`--json` 将除结尾 `final` 外的每个字符串截断在 8 KiB、每行截断在 32 KiB，并省略投影未建模的事件，因此它不是 Session 日志的无损副本。
