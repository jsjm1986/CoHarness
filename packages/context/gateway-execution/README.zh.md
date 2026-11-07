---
description: "由 Gateway 支持的共享与委派 Session 执行授权。配置撤权处理或追踪受管工作中的已验证参与者时阅读本页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-gateway-execution

[English](README.md) | 中文

## 概述

按已验证发起人的当前权限，为每次受管请求及其继承执行链授权。新的根请求不继承无关的历史参与人；编辑、子任务、排队投递和延迟回调保留各自的贡献者。Gateway PostgreSQL 记录拥有身份与权限，会话事件保留恢复后核验所需的引用。

## 目录

- [使用本包](#use-this-package)
- [执行授权](#execution-authorization)
- [撤权与取消](#revocation-and-cancellation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

在 Gateway 拥有的运行时中，将本提供者与 [Gateway Runtime](../gateway-runtime/README.zh.md)、Agent 和 Session 服务、Session Query、权限预设及沙箱策略组合。独立本机 profile 不加载它。Gateway Runtime 将应用标记为必须具有执行授权；销毁本提供者不会移除该要求。

受管 webhook 路由使用与 webhook 运行时相同的会话创建服务依赖。注册会等待这些服务就绪；任一服务卸载都会移除路由，并在提示词提交前取消尚未完成的接纳。

项目投递要求协作提供方，并按配置的项目可见或私有可见性创建根会话。Gateway 重新核验当前写入成员资格，将持久化归属绑定到执行账号；其他受限用途断言不能创建根会话。

人类消息和已继续问题的回复在准入时，还会将项目参与者元数据替换为已验证调用者快照。不可变输入凭据负责执行授权；参与者快照负责持久化显示和模型归属。个人输入不会新增项目归属提示。

Gateway 数据库需要执行身份迁移 030、031 和[不可变执行范围迁移 047](../../../gateway/deploy/postgres/migrations/047_execution_scopes.sql)。启动迁移处理由 [Gateway](../../../gateway/README.zh.md) 负责。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `reconnectDelayMs` | `1000` | 授权更新流断开后的重连等待时间；必须为不大于 `2147483647` 的正整数。 |
| `jobStopTimeoutMs` | `30000` | 等待被撤销任务与独立工具调用释放资源的最长时间；正整数，不超过 `2147483647`。 |
| `desktop` | 未设置 | 当前节点的桌面标识；未设置时拒绝受管驱动操作。需要迁移 032 和 033。 |
| `desktopPollMs` | `1000` | 队列轮询及租约续期的最大间隔，单位毫秒；必须为不大于 `2147483647` 的正整数。 |
| `desktopCleanupMs` | `30000` | 桌面清理请求超时，单位毫秒；必须为不大于 `2147483647` 的正整数。 |

节点通过 `HGW_DESKTOP_ID` 声明桌面时，Gateway 启动组合会写入 `desktop` 配置（见[托管桌面](../../../gateway/deploy/README.zh.md)）。配置桌面后挂载 `computerUseAuthorization`。资格与每位参与者的明确确认适用于实际活动根 Agent 树；历史父子关系不授予访问权。根、子 Agent 和自有任务在多次调用间保留同一租约。驱动操作串行执行，并在执行前及交付输出前验证当前租约。权限、确认或续期失效会取消工作。正常静止后释放租约；无法确认是否已停止的取消会将租约标记为停止中，必须独立确认输入已排空，或由管理员明确执行恢复操作。本提供者不能根据 MCP 取消响应证明原生操作系统输入已排空。

独立的 `@deepseek-ai/dsh-gateway-execution/desktop-availability` 插件只观察桌面会话证据，不启用驱动或策略。即使未设置 `HGW_DESKTOP_ID`，受管启动就绪检查也包含此插件。环境事实遵循[计算机操作可用性规则](../../computer-use/computer-use/README.zh.md)；已注册的外部或虚拟桌面提供方仍负责报告实际能力。

<a id="execution-authorization"></a>
## 执行授权

只有仍在处理中的、不受用途限制的 HTTP 主体可以为人工消息或问题答案作证。证明将精确输入绑定到 Gateway 的不可变记录。即使可信上下文插件随后渲染了引用，输入进入时仍核查其原始内容摘要。队列编辑保留先前编辑者；被认领的问题答案加入回答者。展示参与者和普通审批响应不会创建授权身份。

提供者在 `gateway/execution` 事件中记录不可变执行范围。新的根回合从本次接纳的输入开始；编辑保留所有编辑者，受管子 Agent 的输入保留真实继承链。Goal 回合、后台任务结果、Team 消息和 PTC 回调携带各自产生时捕获的范围。迟到结果不能替换新请求的身份。历史凭据引用仍用于审计与延迟计费。[服务定义](../execution-authority/README.zh.md) 规定消费者义务。

在模型请求或允许的工具调用之前，提供者核验该次执行范围中的每位参与人。普通执行要求当前写权限；Full 和 profile 管理要求管理员权限，Auto 要求独立资格。当前链中的未知输入会阻止特权执行，但新的已验证根请求可在未知历史输入之后继续。预设选择核验当前选择者，真实执行再次核验完整执行链。[权限预设](../../interaction/permission-presets/README.zh.md) 负责选择与默认值。

本提供者拥有 `pluginManagementAuthorization` 和 `permissionPresetAuthorization`。交互式 profile 操作使用 Gateway 的实时管理员检查；Agent 发起的操作使用该 Agent 的完整参与者集合。授权缺失不会回退到先前 HTTP 请求或浏览器自报角色。[Profile 管理授权](../../../.agents/notes/implemented/architecture/2026-09-22-gateway-profile-management-authority.zh.md) 定义受保护操作和取消行为。

<a id="revocation-and-cancellation"></a>
## 撤权与取消

授权要求 Gateway 更新流已就绪。参与人失效时逐个复核受影响的执行范围，停止对应当前回合、任务和工具调用，不取消其他合资格用户的独立请求。更新流中断时停止所有活跃范围。每次等待中的权限检查还会保留匹配的用户或项目失效通知，直到检查结束；空闲 Agent 发起的检查同样适用。旧流代次、已失效参与人、已变更范围、已释放 Agent 或已取消操作的响应不能授权执行。单个参与人引起的取消保留已接收队列项，但按原语义停放，直到新的唤醒发送；重连不重放效果。

空闲 Agent 拥有的运行中或停止中任务会保留所需资格，直到这些任务结算。最后一个自有任务结算后，提供者会清除该空闲 Agent 缓存的资格。撤权通过现有 Jobs 服务停止任务，并在 `jobStopTimeoutMs` 内等待；仍未停止的任务会产生清理失败，不会返回停止成功。

提供者销毁时取消其传输生命周期并排空拥有的检查。操作信号约束单次授权和转发请求，包括等待 Session 登记和继承恢复的阶段。取消某个调用者的等待不会取消其他调用者仍需要的共享登记。消息进入也会取消其自身的继承恢复。执行器仍负责在取消后终止并排空自己拥有的工作。

Gateway 拒绝响应和无效更新流会请求取消响应读取，但不等待取消确认。响应清理不能推迟撤权，也不能替换权限错误。终端撤权仍等待进程所有者确认清理完成。参见[响应与撤权决策](../../../.agents/notes/implemented/bug-fix/2026-11-01-gateway-revocation-response.zh.md)。


<a id="further-exploration"></a>
## 进一步阅读

- [已验证的执行参与者](../../../.agents/notes/implemented/architecture/2026-09-22-verified-execution-participants.zh.md) — 信任与委派决策。
- [Auto 审查授权与归因](../../../.agents/notes/implemented/bug-fix/2026-09-22-auto-review-execution-attribution.zh.md) — 审查器准入与计费归属。
- [当前账户权限 UI](../../client/ui-permission-presets/README.zh.md) — 账户资格的展示。

<a id="model-experience"></a>
## 模型体验

### 桌面环境说明

#### 模型看到什么

未注册桌面驱动时，`desktop-availability` 添加经日志记录的系统指令，说明缺少图形会话或未启用驱动，并禁止本机桌面操作。文件、终端与另行配置的无头浏览器工具保持独立。执行提供者不把身份元数据或工具 schema 添加到模型内容；已注册的桌面提供方负责自己的说明。

#### Token 影响

没有注册桌面驱动时，固定的环境指令增加系统提示词 token，不创建桌面工具。

#### KV Cache 影响

授权引用保留在模型请求内容之外。检测到的环境与提供方注册不变时，环境说明保持稳定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 授权依赖 Gateway、PostgreSQL 和已就绪的更新流。故障会停止受管工作，不会保留陈旧权限。
- 仅恢复 Session 或修改其已选预设，不能将未知历史输入提升为已验证的特权工作。
- 提供者和 PostgreSQL 测试证明身份与权限检查；全部恢复、委派和已部署 Web 路径的完整组装验收仍须单独完成。
- 已验证参与者集合可以授权操作，但不会隔离可信 Host 插件，也不会撤销取消前已经完成的副作用。
- 未登记到 Jobs 注册表的工作及非受管外部进程，需要单独审查取消与隔离。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
