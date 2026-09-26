---
description: "由 Gateway 支持的共享与委派 Session 执行授权。配置撤权处理或追踪受管工作中的已验证参与者时阅读本页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-gateway-execution

[English](README.md) | 中文

## 概述

按每位已验证人工贡献者的当前权限授权受管 Agent 工作。在编辑、委派、投递和恢复中保留这些贡献者，并在权限检查或授权更新不可用时停止活动工作。Gateway PostgreSQL 记录拥有身份与权限；Session 事件保留核查所需的引用。

## 目录

- [使用本包](#use-this-package)
- [执行授权](#execution-authorization)
- [撤权与取消](#revocation-and-cancellation)
- [不变量](#invariants)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

在 Gateway 拥有的运行时中，将本提供者与 [Gateway Runtime](../gateway-runtime/README.zh.md)、Agent 和 Session 服务、Session Query、权限预设及沙箱策略组合。独立本机 profile 不加载它。Gateway Runtime 将应用标记为必须具有执行授权；销毁本提供者不会移除该要求。

Gateway 数据库需要[执行身份迁移 030](../../../gateway/deploy/postgres/migrations/030_execution_identity.sql) 和 [Auto 资格迁移 031](../../../gateway/deploy/postgres/migrations/031_auto_review_eligibility.sql)。启动迁移处理由 [Gateway](../../../gateway/README.zh.md) 负责。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `reconnectDelayMs` | `1000` | 授权更新流断开后的重连等待时间；必须为不大于 `2147483647` 的正整数。 |
| `jobStopTimeoutMs` | `30000` | 等待被撤权后台任务释放资源的最长时间；必须为不大于 `2147483647` 的正整数。 |
| `desktop` | 未设置 | 当前节点的桌面标识；未设置时拒绝受管驱动操作。需要迁移 032 和 033。 |
| `desktopPollMs` | `1000` | 队列轮询及租约续期的最大间隔，单位毫秒；必须为不大于 `2147483647` 的正整数。 |
| `desktopCleanupMs` | `30000` | 桌面清理请求超时，单位毫秒；必须为不大于 `2147483647` 的正整数。 |

节点通过 `HGW_DESKTOP_ID` 声明桌面时，Gateway 启动组合会写入 `desktop` 配置（见[托管桌面](../../../gateway/deploy/README.zh.md)）。配置桌面后挂载 `computerUseAuthorization`。资格与每位参与者的明确确认适用于实际活动根 Agent 树；历史父子关系不授予访问权。根、子 Agent 和自有任务在多次调用间保留同一租约。驱动操作串行执行，并在执行前及交付输出前验证当前租约。权限、确认或续期失效会取消工作。正常静止后释放租约；无法确认是否已停止的取消会将租约标记为停止中，必须独立确认输入已排空，或由管理员明确执行恢复操作。本提供者不能根据 MCP 取消响应证明原生操作系统输入已排空。

<a id="execution-authorization"></a>
## 执行授权

只有仍在处理中的、不受用途限制的 HTTP 主体可以为人工消息或问题答案作证。证明将精确输入绑定到 Gateway 的不可变记录。即使可信上下文插件随后渲染了引用，输入进入时仍核查其原始内容摘要。队列编辑保留先前编辑者；被认领的问题答案加入回答者。展示参与者和普通审批响应不会创建授权身份。

提供者通过 `gateway/execution` 事件记录已确认的参与者集合和显式继承。捕获先于异步委派；恢复的继承资料和相邻转发则在执行前由 Gateway 验证。选择更短的分叉前缀或替换展示元数据不能移除历史参与者。消费者义务由[服务定义](../execution-authority/README.zh.md) 负责。

在模型请求或获准工具调用前，提供者向 Gateway 核查真正的活动 Agent。普通执行要求当前写入权限；Full 和 profile 管理还要求完整参与者集合都具有管理员权限，Auto 则要求每位参与者都拥有单独授予的资格。无法验证的历史输入会阻止特权执行。显式选择特权预设还会检查当前选择者。[权限预设](../../interaction/permission-presets/README.zh.md) 负责选择和默认设置规则。

本提供者拥有 `pluginManagementAuthorization` 和 `permissionPresetAuthorization`。交互式 profile 操作使用 Gateway 的实时管理员检查；Agent 发起的操作使用该 Agent 的完整参与者集合。授权缺失不会回退到先前 HTTP 请求或浏览器自报角色。[Profile 管理授权](../../../.agents/notes/implemented/architecture/2026-09-22-gateway-profile-management-authority.zh.md) 定义受保护操作和取消行为。

<a id="revocation-and-cancellation"></a>
## 撤权与取消

授权要求 Gateway 更新流已就绪。相关失效通知会重新核查活动工作；检查失败或更新流丢失都会取消工作。过期流代次、已销毁 Agent、已取消操作或较旧授权修订的响应都不能授权执行。重连恢复检查权限的能力，不会重放已取消的模型调用或工具副作用。

空闲 Agent 拥有的运行中或停止中任务会保留所需资格，直到这些任务结算。最后一个自有任务结算后，提供者会清除该空闲 Agent 缓存的资格。撤权通过现有 Jobs 服务停止任务，并在 `jobStopTimeoutMs` 内等待；仍未停止的任务会产生清理失败，不会返回停止成功。

提供者销毁时取消其传输生命周期并排空拥有的检查。操作信号约束单次授权和转发请求。执行器仍负责在取消后终止并排空自己拥有的工作。

<a id="invariants"></a>
## 不变量

本地镜像无法独立证明 PostgreSQL 中的当前权限，因此不发布不变量配套入口。提供者在记录 Gateway 响应时验证单调修订和参与者保留，并在执行准入时重新检查授权。

<a id="further-exploration"></a>
## 进一步阅读

- [已验证的执行参与者](../../../.agents/notes/implemented/architecture/2026-09-22-verified-execution-participants.zh.md) — 信任与委派决策。
- [Auto 审查授权与归因](../../../.agents/notes/implemented/bug-fix/2026-09-22-auto-review-execution-attribution.zh.md) — 审查器准入与计费归属。
- [当前账户权限 UI](../../client/ui-permission-presets/README.zh.md) — 账户资格的展示。

<a id="model-experience"></a>
## 模型体验

无直接影响；授权不添加提示词或工具 schema，各消费者拥有自己的拒绝输出。

#### KV Cache 影响

无；授权引用保留在模型请求内容之外，不改变其前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 授权依赖 Gateway、PostgreSQL 和已就绪的更新流。故障会停止受管工作，不会保留陈旧权限。
- 仅恢复 Session 或修改其已选预设，不能将未知历史输入提升为已验证的特权工作。
- 提供者和 PostgreSQL 测试证明身份与权限检查；全部恢复、委派和已部署 Web 路径的完整组装验收仍须单独完成。
- 已验证参与者集合可以授权操作，但不会隔离可信 Host 插件，也不会撤销取消前已经完成的副作用。
- 未登记到 Jobs 注册表的工作及非受管外部进程，需要单独审查取消与隔离。
