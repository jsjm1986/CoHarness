---
description: "用户交互式终端：执行环境默认 shell、有界屏幕恢复和类型化 Remote 控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-terminal-controller

[English](README.md) | 中文

## 概述

从 Web 侧栏在会话工作区打开执行环境的默认 shell。重新连接已有进程，并关闭 provider 管理的完整进程范围。终端输出不进入 Agent 对话记录。保留终端会占用进程和有界屏幕缓存。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Client 插件拥有生成的 `remote.terminal` 命名空间，并在卸载时释放。共享 Remote 组装不挂载第二份副本。

Web bundle 挂载此包以及 subprocess 提供者、sandbox policy 和 Typert Gateway。Sandbox policy 仅为没有 cwd 的 Session 提供回退工作目录。`remote.terminal` 暴露 `environment`、`shells`、`list`、`create`、`retain`、`follow`、`write`、`resize`、`rename` 和 `close`；普通操作均按 Session 和创建者身份隔离。Gateway 个人工作区需要用户资格；项目还需要项目授权及可写成员身份。资格变化撤销保留的授权并等待进程清理。清单直接读取 Host 保留的终端，因此查看离线 Session 不会激活 Agent，也不会产生恢复错误。

Shell 探测结果首先列出执行环境声明的默认 shell。仅当 provider 未声明默认值时，才在 POSIX 使用 `/bin/sh`，在 Windows 使用 `cmd.exe`。可选的 `shell` profile 通过可执行路径 `path`、显示名称 `name` 和参数 `args`（默认 `[]`）覆盖这一选择。选择器还会通过执行 provider 探测 `shellCandidates`，仅省略确定未找到的候选。创建请求接受探测返回的 `shellPath` 并再次验证；解析或传输失败会直接报告，不启动其他 shell。环境查询只返回工作目录和限制，不解析 shell，因此默认 shell 不可用时仍可重新连接已有进程。POSIX 自动 profile 以交互模式启动，PowerShell 使用 `-NoLogo`，补全和启动配置仍由 shell 提供。初始目录来自 Session 工作区。用户终端使用执行环境中系统用户的权限，独立于 Agent 的沙箱模式和审批策略。操作系统和容器的限制仍然生效；DSH 不提升用户权限。Subprocess provider 继续清除环境中的凭据变量。

| 配置 | 默认值 | 含义 |
|---|---|---|
| `shell` | 省略 | 使用执行环境默认 shell，或指定一个 profile |
| `shellCandidates` | `zsh`、`bash`、`fish`、`pwsh`、`powershell`、`cmd` | 已安装时供用户选择的额外可执行名称或路径 |
| `maxTerminals` | `8` | 每个 Session 保留的终端和创建请求上限 |
| `maxCols`、`maxRows` | `500`、`200` | PTY 最大尺寸 |
| `scrollback` | `1000` | 屏幕历史行数 |
| `maxBufferedBytes` | `2097152` | 单个订阅者的输出排队上限 |
| `maxInputBytes` | `65536` | 单次输入请求的字节上限 |
| `disposeGraceMs` | `1000` | provider 终止宽限期，单位毫秒 |
| `unattendedTimeoutMs` | `7200000` | 无窗口持有且持续确认空闲后开始清理的时长；`0` 禁用自动回收 |
| `activityPollIntervalMs` | `30000` | 无窗口持有时的活动观察间隔 |
| `cleanupRetryMs` | `60000` | 清理失败后的重试间隔 |

任何已连接窗口中的打开标签页都会持有其终端，包括隐藏标签和非当前 Session。最后一个持有关系消失后，只有明确确认空闲的时间才计入回收期限。运行中、停止、等待输入和后台执行的任务都会受到保护；活动状态未知时清除空闲截止时间。任务完成后重新给予完整宽限期。Host 使用单调时钟，在清理前重新检查持有关系和当前活动；观察间隔超过轮询周期的两倍时丢弃旧证据。时间字段使用毫秒和安全整数，轮询及重试间隔必须为正数。

管理员通过 `/admin` 管理用户/项目资格，列出或关闭当前节点上的进程。这些操作仅暴露 Session、创建者、终端身份和进程状态，不暴露屏幕内容，也不允许输入。关闭要求已审阅的节点和 runtime 代次，等待清理并报告可重试的失败。参见[私有终端归属](../../../.agents/notes/implemented/architecture/2026-09-23-private-user-terminals.zh.md)。

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节</summary>

Host 使用 `ctx.subprocess.spawnTerminal` 并设置 `TERM=xterm-256color`，不会启动桌面终端应用。流式 UTF-8 解码保留跨块字符和开头的 BOM，并在 EOF 替换未完整结束的字节。一元控制经过 Gateway，`follow` 使用独立、有界的 NDJSON Remote 响应。每项输出重新核验保留的创建者授权；业务拒绝结束流，不会以另一身份重连。无界面的 xterm 及其序列化器在先前输出完成后生成初始屏幕，后续帧使用单调递增的输出序号。慢消费者明确失败；新连接恢复当前屏幕。

最新连接持有输入和尺寸控制权。断开连接只释放输入权，不结束进程。显式关闭等待进程清理和最后输出；清理失败时保留资源以便重试。Session 记住已关闭的标识并拒绝迟到或重复的创建请求，包括关闭到达时仍在进行的创建。新终端使用新标识。取消创建且清理失败时，已分配的进程仍有所有者。Session owner 和 controller 卸载也会终止所拥有的进程。改变 Session 的沙箱模式时，用户终端继续以原有权限运行。控制权转移或进程退出后被拒绝的输入和尺寸请求保留输出连接并禁用输入，不重发被拒绝的输入。

Client 在分配前，将每个 Session/content 到终端的关联写入自己的 `dsh.terminal.binding.v2.*` localStorage 键。记录包含经过核验的账号、runtime 和 Session；忽略没有归属信息的旧记录。账号变化和明确撤权清空活动屏幕模型。Content 身份全局唯一，布局内的 tab id 仅标识当前视图。独立记录的写入和删除保留其他窗口的关联。恢复视图复用原身份；侧栏终端提供者先恢复视图，再查询尚无视图的 Host 终端。新视图可以创建进程，恢复视图在目标缺失时报告错误而不重建。明确关闭先保存清理请求，再删除关联。Host 提供当前进程元数据和屏幕内容，浏览器不持久保存它们。Client 模型在浏览器模拟器处理输出后确认屏幕写入，串行发送输入并忽略陈旧连接响应。Client 错误使用本地化键。插件卸载等待活动和已经分离的输出流结束，但不关闭 Host 进程。

独立的 `retain(sessionId, id, signal)` Remote 流确认窗口持有关系，不激活 Agent、发送屏幕输出、转移输入权或创建进程。终端 provider 提供侧栏的完整打开标签清单，Client 将其与自己保存的身份取交集。同一窗口中的重复 occurrence 共用一个持有流；孤立的旧关联不会保活任何终端。恢复输出连接前必须等待当前持有关系确认。传输取消只释放对应的物理流代次；插件卸载等待全部持有流结束。清理失败时保留所有权并重试，不重新接受连接，也不重新计算空闲宽限期。

新视图自动启动终端，使用明确选择的 shell 或记住的可用 shell。最近选择的 shell 路径保存在按账号/runtime/Session 隔离的 `dsh.terminal.shell.v2.*` localStorage 键中。默认启动通过 Host 发现核验保存路径；不存在时回到当前默认值。引导页在打开标签前保存选择，每个新标签保留自己的路径和分配身份。存储失败不阻止启动。恢复已有终端不读取此偏好，也不重新发现 shell。

关闭操作先保存未完成的清理请求，再释放标签，并在后台等待 Host 清理。失败显示可重试通知。每个请求保留原始私有地址及终端 ID 的 localStorage 键，清理成功或收到确定的 `session/not-found` 后删除；启动时重试保存的请求。传输失败保留请求。清理请求独立于标签关联和侧栏布局持久化。浏览器存储不可用时，清理仍可在内存中进行，但刷新后无法恢复。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Subprocess](../../subprocess/subprocess/README.zh.md)
- [Right Sidebar](../../client/ui-sidebar-right/README.zh.md)
- [用户终端权限](../../../.agents/notes/implemented/architecture/2026-09-16-user-terminal-permissions.zh.md)
- [Web terminal decision](../../../.agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.zh.md)

<a id="model-experience"></a>
## 模型体验

无；此包只处理用户交互式终端，不向模型请求添加内容。

#### KV 缓存影响

无；终端输出只在浏览器与 Host 之间传输。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 浏览器刷新保留进程和屏幕；Host 或 Session owner 卸载不保留。不提供持久终端恢复或自动重启 shell。 已退出的终端仍计入 `maxTerminals`；关闭不用的标签页可释放其屏幕和名额。
- 原生 PTY 可用性和进程树清理保证由 subprocess provider 决定。找到可执行文件并不保证 PTY 分配成功。
- 自动回收依赖 provider [支持的 shell 活动观察](../../subprocess/subprocess-local/README.zh.md#running-terminal-sessions)。不支持的 shell、自定义启动参数和不确定的进程观察可能让资源一直保留到明确关闭或 owner 卸载。运行中的命令没有强制最长执行时间。
- 屏幕恢复只保留有界历史，不保留完整记录。同一时刻只有一个连接可输入或调整尺寸。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

不发布运行时 invariant companion。终端元数据与屏幕更新由同一对象按序写入，没有独立的进程尺寸观测可供比较。

</details>
