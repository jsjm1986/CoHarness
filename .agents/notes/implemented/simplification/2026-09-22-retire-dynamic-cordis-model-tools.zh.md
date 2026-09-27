# Agent Note: 退役动态 Cordis 模型执行工具

Status: implemented

[English](2026-09-22-retire-dynamic-cordis-model-tools.md) | 中文

## Problem

在 Host 内解释 JavaScript 的模型工具可以获得实时服务，绕过普通工具与服务授权。带有 Host 回调的 VM 不是隔离边界。保留此执行路径会破坏共享和委派任务所需的权限交集。

## Decision

`tool-cordis` 仅注册只读发现及会话所属 Package 检查。`cordis_define`、`cordis_run`、`cordis_stop` 和 `cordis_undefine` 没有工具注册或兼容分发入口。直接调用执行器会以未知工具拒绝这些名称，PTC 也不暴露这些名称的绑定。创造模式指导在工作区开发普通 Plugin，再经插件管理器授权安装；检查结果不能调用服务方法。

[原工具集决策](../feature/2026-07-08-self-referential-cordis-toolset.zh.md)被部分替代：生成式发现的依据、程序化运行器生命周期和历史展示仍有价值。[alpha2 Client 审计](../architecture/2026-09-20-upstream-alpha2-client-lane-audit.zh.md)保留其他对齐决策。已有动态 Package 记录和对话卡片仍可读取；读取不会重建其副作用。此变更移除模型执行 API，不删除运行器的程序化和浏览器消费者。这些消费者继续承担各自的授权要求。

保留的 Host 服务路径共用部署授权：求值、延迟 Plugin apply、动态工具执行、handler 调用和浏览器成功结算。敏感续接在等待之后重新检查当前策略。受管运行时缺少策略时拒绝执行；独立本机运行时保留本地权限。会话 ACL 继续生效，拒绝及所有者清理则可以在权限撤销后停止已有任务。

## Alternatives considered

**仅在提示词或默认 preset 中隐藏工具。** 直接分发、其他 preset 和 PTC 仍能调用它们。删除注册使执行器拒绝旧名称。

**为旧对话保留兼容执行。** 历史渲染需要已保存的参数与结果，不需要解释代码。重放代码会把读取变成特权修改。

**删除整个运行器与历史卡片。** 只读检查和现有程序化、浏览器消费者仍使用运行器。移除它们属于另一个产品决策，也会丢失有价值的源码与结果记录。

## Consequences

Web 所属场景通过正式 Session 解码器和持久化 API 加载[上游 alpha.2 的已发布 v3 录制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/snapshots/web/cordis-tool-round/session.v3.jsonl)。夹具完整保留原始字节；历史渲染不分发已退役调用。它替代了终态消息、工具调用与嵌入流不一致的本地录制；仅做结构解析未检测出该语义矛盾。

Agent 不能通过这些工具创建进程内动态 Plugin。持久化定制使用普通包工作流，遵循其权限和安装审查。运行独立本机 CLI 的用户仍保有操作系统能力；此次移除不代表操作系统隔离。

执行器回归覆盖正常检查、四个退役名称的拒绝、定义状态不变及插件卸载后的注册移除。PTC 和创造模式消费者要求只读工具列表。Web 所属场景验证历史可读性，不重新执行生成代码；打包 Python 冒烟保留检查、PTC、子 Agent 与 workflow 覆盖，不动态创建工具。将来若要重新引入模型控制的运行时扩展，必须先具备可执行的授权设计。
