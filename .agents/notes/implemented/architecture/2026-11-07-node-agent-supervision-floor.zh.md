# Agent Note: Node agent supervision floor

Status: implemented

[English](2026-11-07-node-agent-supervision-floor.md) | 中文

## Problem

node agent 是节点唯一的出站控制通道：所有远程操作——Runtime RPC、文件修复、探针——都走它的连接，agent 一停，整台节点失联，而节点本地没有任何逻辑察觉这个状态。Windows 上 Scheduled Task 的 `RestartCount 3` 只在任务失败时生效，手动 `schtasks /end` 不在其内；`/end` 之后接 `/run` 又会撞上 `IgnoreNew` 竞态，可能让任务永远停在停止态——一次生产事故正是这样把节点挂掉的。Linux 上 `Restart=on-failure` 漏掉干净的 `exit 0` 退出，agent 单元比 gateway 单元的 `always` 弱。

## Decision

`gateway/deploy/windows/node-agent-task.ps1` 承载 Windows 侧的监督底线。`-Install` 额外注册 `<TaskName>-watchdog` 任务，每五分钟重复一次；每趟跑 `-Watchdog`，把每个被监督任务中状态既不是 `Running` 也不是 `Disabled`、且上次结果不是干净退出的重新拉起。`-AlsoWatch` 以单个逗号分隔参数的形式把监督范围扩到兄弟任务（如节点本地 Gateway 任务）——argv `string[]` 经 `-File` 绑定会塌缩成一个字面 token 而什么都看不到——兄弟进程死掉同样不能让节点搁浅。`-Restart` 是原子重启：停止→轮询直到任务确实离开 `Running` 否则响亮失败→启动→轮询等回来——整段序列在节点本机完成，远程发起方中途断线也不会把任务夹在两个操作之间。`Disabled` 视为故意停机，永不复活；`LastTaskResult` 为 0 表示进程主动停放（终态拒绝或信号停止），同样不动。节点 Gateway 的服务控制经此脚本调 `-Restart`，管理界面的启动动作因此是真重启而非只会启动的 `schtasks /Run`。

`gateway/deploy/harness-node-agent.service` 改为 `Restart=always` 加 `RestartPreventExitStatus=0`，与 gateway、config 单元对齐，同时保留全平台统一的干净退出语义：exit 0 永远是有意停放（`detached`/`mode-disabled` 终态拒绝或信号停止），所有异常退出都重启。macOS LaunchAgent 补上 `RunAtLoad`，agent 像兄弟平台一样重启后自恢复；其 `KeepAlive{SuccessfulExit:false}` 本就编码同一停放规则。故意的 `systemctl stop` 或 `Disable-ScheduledTask` 依然保持停止。这套底线服务的多机监督模型即 [Windows node enrollment](2026-11-04-windows-node-enrollment.zh.md) 注册任务所用的模型。

## Alternatives considered

**把 agent 改成 Windows Service 而不是 Scheduled Task。** SCM 的失败动作能覆盖任何进程退出，更接近 systemd，但 service 包装增加安装复杂度，而且既不管兄弟 Gateway 任务，也不提供原子的远程重启路径；watchdog 不换宿主模型就同时解决这两点。

**让中心发现 agent 死后通知节点自愈。** 恢复指令过不了死通道；监督必须在节点本地。

**watchdog 顺带校验通道活性。** 任务 `Running` 但拨不出去（凭证吊销、隧道死掉）时，任务状态看不出问题。识别这一类需要独立的第二通道，是另一个设计，不放进这条底线。

## Consequences

手动 `schtasks /end` 或 `RestartCount` 用尽，在 Windows 上最多让节点黑一个 watchdog 周期；Linux 上异常退出经 `Restart=always`、macOS 经 `KeepAlive` 重启。干净 exit 0 全平台停放，`detached`/`mode-disabled` 拒绝因此停止拨号环而不是无限重连；重新登记本身是操作者动作，同时会启动单元。要真正停住 agent 用 `Disable-ScheduledTask` 或 `systemctl stop`，所有监督都尊重这类故意状态。watchdog 任务自身不受监督；删除它属于操作者行为，等于撤掉底线。`<TaskName>-watchdog` 只往 `<StateRoot>\logs\node-agent-watchdog.log` 追加动作行，文件不会涨大。`Running` 但连不上中心的 agent 仍在这条底线之外，归第二通道设计处理。

## Verification

脚本通过 `pwsh` PSParser 解析；watchdog、restart、install、uninstall 各路径按 schtasks 语义（`IgnoreNew`、`RestartCount`、任务状态）逐项核对过，一轮审查在发布前抓出了 `-AlsoWatch` argv 塌缩、`-Restart` 缺停止闸门与 `/run` 结果未检查三处问题。已在生产 Windows 节点实机验证：恢复后的 agent 执行 `-Install`，watchdog 任务注册并把 `HarnessNodeGateway` 纳入监督集，心跳、`execution_ready` 与新日志路径全部正常。剩余实机待证项：`schtasks /end` 是否终结 agent 的 `node.exe` 孙进程——若不终结，停止的任务可能留下持有租约的孤儿 agent，直到 watchdog 拉起新实例。
