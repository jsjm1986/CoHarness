# Agent Note: 会话查询工具的参与方可读 ACL

Status: implemented

[English](2026-10-17-session-query-participant-acl.md) | 中文

## 问题

工作目录相等标识的是文件系统上下文，而不是参与方读取对话的权限。Gateway 项目运行时中的成员共享一个项目目录，因此仅检查 `cwd` 无法保护私密对话。在异步语料、事件、标题或辅助模型操作前取得的可读性检查结果，也可能在结果返回调用方之前失效。

## 决策

[`dsh-tool-session-query`](../../../../packages/session-query/tool-session-query/README.zh.md) 要求每个跨会话目标的 `cwd` 与调用方相同；组合了 `collaboration` 时，目标还必须出现在 `collaboration.capture().readableSessionIds(ids)` 中。个人参与方保留既有可读集合，未组合 collaboration 的组合保留目录规则。调用方记录操作开始时是否存在 collaboration；提供方在最终授权前消失时，操作拒绝跨会话输出，而不改用独立组合中仅检查目录的规则。主体捕获失败会拒绝跨会话访问，同时保留自身访问。可读性提供方失败通过面向模型的服务错误净化器传播。

[授权辅助函数](../../../../packages/session-query/tool-session-query/src/workspace-access.ts) 在每个操作阶段批量处理候选 id。搜索解析一份工作区准入集合，并在提供方分页、父会话过滤与标题观察中复用。会话跟踪批量检查完整血缘，遮蔽不可读的祖先与后代子树，不披露其 id。精确目标工具在读取目标前完成授权。

每个[操作](../../../../packages/session-query/tool-session-query/src/operations.ts) 都会在异步读取结束后、格式化结果前取得新的可读集合。最终批次覆盖全部要披露的跨会话 id，包括可见搜索命中的父会话、祖先、后代与标题；权限撤销会以 `SESSION_QUERY_TOOL_UNAUTHORIZED` 拒绝整个结果，不返回已读内容。Handoff 还会在辅助模型提取前与提取完成后检查。自身访问不需要跨会话检查，所有操作都不会逐条命中发起请求。

## 考虑过的替代方案

**保留 `cwd` 相等作为唯一检查。** 它不携带可见性信息，无法区分同一项目目录下的私密对话与共享对话。

**在同步过滤器中逐条授权。** 可读性检查是异步的；逐条检查会按结果数量放大 Gateway 请求数。批量准入与最终发布检查使工具级调用次数不随命中数量增长。

**只在搜索或目标查询前检查可读性。** 跟踪与事件读取可以触达相同数据，异步读取也可能在权限撤销后才结束。每个操作都负责准入和最终结果授权。

**未绑定主体时拒绝所有操作。** 环境轮次可以检查自己的 Session。对跨会话检查采取失败关闭，既保留自身路径，也不会授予相邻会话的访问权限。

## 后果

组合了 collaboration 的搜索会增加一次工作区语料枚举，并对实际披露的 id 增加一次最终可读性批量检查。跟踪与精确读取也增加一次最终批量检查；handoff 在辅助推理前还会检查一次。来源在调用期间变为不可读时，操作会整体拒绝，而不返回部分结果。

最终授权响应是发布检查；它不与其后的 ACL 变更组成跨进程事务。撤权前已发送给获授权辅助模型的数据无法撤回，但提取完成后观测到撤权会阻止结果返回调用方。

## 验证

[包回归测试](../../../../packages/session-query/tool-session-query/tests/tool-session-query.spec.ts) 覆盖被拒目标、搜索父会话与血缘遮蔽、主体缺失、提供方失败净化，以及在标题、提供方页面、表层或提取操作暂停时确定性撤权。[Headless 录制会话场景](../../../../snapshots/session/session-query-acl-revocation/snapshot.yml) 通过已发布 profile 启动真实查询工具，并控制外部 ACL 响应；其 transcript 记录拒绝且不包含私密来源正文。移除最终 ACL 验证会使该组装场景失败。
