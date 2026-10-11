# Agent Note: Team 名册模型读取成员自身的持久选择，而非创建戳记

Status: implemented

[English](2026-10-10-team-roster-model-source.md) | 中文

## 问题

`TeamRoster.list` 与 `memberView` 将每个成员的模型报告为 `agent.options.model`。宿主在每次 Agent 创建/恢复时用 `ctx.agentDefaultModel.currentSelection()` 给 `options.model` 盖戳——那是部署级默认路由——而 Web 会话的真实模型经由持久化的 `model/selection` 事件与 `request/header` 配置流经 `ModelSelectionRef`。任何选择了非默认模型的会话，其所有名册行都显示部署默认值(`模型: <默认>`)，与成员实际服务的模型无关，因为声明的选项从不跟踪持久选择。

## 决策

名册模型现在经由与会话模型选择器相同的权威源解析：`sessionProjections.stateOf(member.session, 'modelSelection')` 产出 `pending`（尚未被匹配请求头消费的最新 `model/selection`）优先于 `lastUsed`（最近一次请求的路由）。`modelSelection` 键及其状态类型由宿主 API 层注册并声明类型，因此名册通过结构化的服务形态读取该单元，而不是把宿主类型引入实验包。在投影或该单元未挂载的组合中——非宿主组合、精简测试上下文——由成员自身的 `requestHeader()` 折叠提供最近使用路由，`agent.options.model` 则作为从未记录过两者的成员的声明兜底。没有驻留 Agent 的非活跃成员无法读其会话：激活时把成员的声明路由持久化进 `TeamMemberSnapshot.model`，非活跃行显示这份成员自身的印记。该字段出现之前激活的成员没有印记，名册对它们省略该字段，而不是借用 lead 的声明默认值——lead 印记正是被报告的错配来源。

## 已考虑的替代方案

**继续读 `agent.options.model` 并修正盖戳。** 否决：`options` 是不可变的创建配置；活路由被刻意设计为独立的可变选择通道，因此只要会话选择与默认值不一致，该字段仍会漂移。

**在名册内直接折叠 `session.events`。** 否决：同步原始事件读取(`events`、`snapshotEvents`、`eventAt`）对新调用方均已弃用；会话投影注册表才是受支持的增量折叠，且恰好已经算出 `pending ?? lastUsed`。

**只展示 `requestHeader()` 的最近使用路由。** 否决：记录于最近一次请求之后的选择才是成员下一次请求的真实路由——这正是用户对照会话模型选择器查看名册时会注意到的情形。

## 后果

`TeamMemberView.model` 现在报告成员下一次请求将使用的模型：Lead 行跟随会话自身的模型选择而非部署默认值，驻留 teammate 行跟随其自身会话的持久路由，非活跃 teammate 行显示激活时持久化进快照的声明路由。日志中既无选择也无请求头的成员仍显示其声明的创建模型；缺少宿主投影的组合保持"最近使用，再退回声明"的展示；`TeamMemberSnapshot.model` 存在之前激活的成员省略该字段。`team/member` 快照 schema 接纳可选的 `model` 字段，旧快照仍可解析。

## 验证

`team.spec` 新增用例，在已挂载的投影注册表上注册一个结构等价的 `modelSelection` 单元，覆盖完整解析链：日志为空时显示声明模型、仅有请求时显示最近使用路由、待决 `model/selection` 压过更早的请求头、不相关的后续请求头保留待决选择、匹配的请求头消费它使最新使用路由胜出，以及驻留 teammate 行读取其自身会话的选择。第二个用例断言成员声明路由在激活时写入 `TeamMemberSnapshot.model`，且 Agent 处置后非活跃行仍显示该值；既有的"provisioning 与从未激活成员省略该字段"断言保持。agent-team 全部测试通过。
