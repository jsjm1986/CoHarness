---
kind: upgrade-guide
description: "托管 Runtime 要求注册资源准入，并等待子进程分配。"
---

# 托管执行注册资源准入

[English](guide.md) | 中文

## 变更

Gateway 托管的 LLM 派发、已注册的 DeepSeek 原生 Messages 搜索、子进程分配、插件市场解析 Worker、JSONL 迁移校验器、Stagehand 连接 Worker 和自有 Chromium 进程范围、Inspector Worker、本地 SSH 传输进程、Python 解释器探测／程序及 MCP stdio 探测／服务要求已注册的资源提供方。没有完成注册的旧 supervisor Runtime 不能作为就绪实例复用。普通子进程 `spawn` 返回 Promise，资源完成报告需要等待。独立组合可以省略资源准入。 冷 Runtime 在分配之前还会等待新鲜的节点压力观测。

请随 Runtime 载荷重新构建 `dsh-commands`。等待中的命令准入与实际处理器清理会阻止自动空闲回收；原 Agent 已被释放或替换的调用不能进入其处理器。服务撤下会取消已接收的命令，并等待真实完成后再释放空闲保护。处理器取消同时包含 UI 请求和服务存续期。

一起重新构建 `dsh-user-questions`、`dsh-host-apiproxy` 及其 Typert 描述。直接 TypeScript 调用方需等待 `answer(agent, callId, batch, signal)`；Remote 客户端仍传入三个业务参数，取消由传输层承载。托管迟到回答在排队前以答题者身份登记实际消息。一起重建 GatewayExecution、UserQuestions、CollaborationContext 及生成的客户端描述，使项目答题者快照进入贡献记录和配对的模型提示。缺少身份登记的历史回复不能授权特权执行。会话数据无需迁移。

托管 `/compact` 需要配套的 `dsh-command-compact` 与 `dsh-execution-authority` 包。请一起重新构建消费者与提供者：命令在资源准入和摘要前登记当前调用者，拒绝执行权限已被撤销的请求，并为摘要归属保留该调用者。独立组合可以省略执行授权服务。

冷启动准入会同时检查显式 Runtime ID、归属、电脑和代次。过时或不匹配的环境引用不能消耗另一分配的压力额度或修改其分配状态。旧版仅含归属的选择器保留现有的代次查询；这项检查不需要迁移持久数据。

CLI 在 SDK 引导和 profile 条目运行前，根据继承的凭据通道标记声明托管模型、资源和执行要求。提供方启动失败不能让这些操作变成独立执行。环境文件中的值不能选择托管模式。请随 Runtime 载荷部署匹配的已编译 CLI，使这些要求在启动期间生效。

本地后台任务准入会在捕获执行身份和启动生产者前预留精确所有者的容量。重新构建 `dsh-jobs-local`，使同步授权回调不能突破配置的上限；捕获失败会释放预留且不启动工作。

斜杠命令在发布 run 事件之后、处理器入口之前再次检查取消。托管 `/plan` 的文本和附件必须先完成输入身份登记，才能修改模式或排入请求。使用匹配的执行授权 API 包重建 Commands 与 PlanMode；更新后的工作区清单和锁文件已声明该依赖。独立组合仍无需授权提供方，会话数据无需迁移。

## 迁移

本地启动环境继承会排除 Gateway 部署设置与凭据名称变量。负载设置通过显式运行时配置或运维选择的默认 env 文件提供；参见[运行时环境](../../../../gateway/README.zh.md#performance-and-runtime-admission)。监督不可达时返回 `503 INSTANCE_UNAVAILABLE` 并保留占用；恢复监督控制访问后再重试。

1. 通过既有部署流程部署同一发布版本的 Gateway 与 Runtime 产物，包括 PostgreSQL 迁移 062 至 072。重新开放流量前停止旧托管 Runtime；通过实例管理重新启动，让每个新代次注册其提供方。Linux 单元名称包含代次，已停止的单元保持屏蔽；保留这些文件，通过实例管理操作，避免手动重启监督单元。参见 [Runtime 准入](../../../../gateway/README.zh.md#performance-and-runtime-admission)。
2. 替换 Gateway 前确认旧本地 Runtime 已停止。macOS/Linux 本地执行包含私有独立监督进程；替换与恢复应用数据时保留 `HGW_STATE_ROOT/local-runtime-supervisors`，不要将其纳入自定义备份根目录。发布物包含完整的已编译 Gateway 目录（包括监督进程入口）与原生 flock 包。初始化保留活跃分配；旧版所有权缺失时，在确认停止前 Runtime 保持不可用。保留托管 patch 中的 `gateway-resource-budget` 项（`@deepseek-ai/dsh-gateway-runtime/resource-budget`），以及 `llm` 和 `subprocess` 的 `resourceBudget` 注入。注册必须先于就绪。参见[提供方参考](../../../../packages/context/gateway-runtime/README.zh.md#resource-admission)。 保留 `gateway-runtime.requiredPlugins`：模型治理、执行授权及启用的目录守卫必须激活后才就绪。
3. 等待每个 `ctx.subprocess.spawn(spec)` 调用。自定义子进程提供方实现 `spawnProcess` 与 `spawnTerminalProcess`，由共享服务负责准入。自定义资源消费方监听 `lease.signal`，等待完成报告，并在确认清理前保留不确定占用。执行权限提供方为捕获的异步工作实现 `current()`。
4. 按部署的迁移容量设置 JSONL 的 `verificationConcurrency` 与 `maxQueuedVerifications`。每个后端拥有自己的队列；过载会拒绝操作，不会将健康历史标记为损坏。提供者卸载会等待已接收的迁移完成。参见[存储配置](../../../../packages/session/session-persistence-jsonl/README.zh.md#config)。
5. 确认冷 Runtime 在缺少新鲜压力观测时等待，已取消的等待不会启动。`HGW_RUNTIME_MAX_RESIDENT` 默认为 `0`；需要时设置正数应急上限。该上限与压力准入相互独立。
6. 确认 Runtime 通过认证就绪，并验证排队的模型／子进程取消。仍存活的后代继续保留占用，直到其受管范围退出。其他直接 worker 接入仍独立处理；参见[资源参考](../../../../packages/context/resource-budget/README.zh.md#known-limitations-and-deferred-work)。

MCP stdio 提供 `processGraceMs`（2000）、`processCloseTimeoutMs`（5000）和 `startupTimeoutMs`（120000）。编程客户端可保留 `mountMcpClient(...).dispose()`；释放浏览器预留前应等待它完成。关闭失败会拒绝，并保留命名空间，直到清理成功。参见 [MCP 客户端参考](../../../../packages/mcp/mcp-client/README.zh.md)。

Stagehand 原生启动使用私有本地子进程准入，并提供 `processGraceMs`（2000）和 `processCloseTimeoutMs`（5000）。`operationTimeoutMs` 包含等待进程容量的时间；启动完成后，浏览器继续运行。确认进程范围退出后才移除配置目录。详见[原生浏览器参考](../../../../packages/experimental/browser-use-stagehand-native/README.zh.md)。

浏览器资源清理支持在终止或完成报告失败后显式重试。`SessionResources.dispose()` 在重试期间仍拒绝新获取；SDK 排空失败仍阻止连接复用。父所有者必须等待实际清理句柄，因为 Cordis effect 会保留第一次的拒绝结果。

Stagehand 的 `model` 配置使用已注册 Harness 路由的 `{ provider, model, maxTokens? }`。替换 `modelName`／`apiKey`／`headers`，将凭据和请求头放在模型提供方配置中。每次扩展推理都经过宿主准入、当前权限、取消和用量中间件，并在派发前记录确切输入。组合需要包含附件存储。不认识 `browser-use/stagehand-llm-request` 的旧构建会拒绝受影响的 Session；不含该事件的已有 Session 仍可读取。

Gateway 项目进展推理使用独立的、仅覆盖模型的进程代次，以及稳定目录 `HGW_STATE_ROOT/gateway-model-locks/<node-id>` 下的内核锁。进程运行期间须保留该私有目录。应用迁移 065–072 并以本版本重启前，先停止所有旧 Gateway 进程；旧版手动后台任务不参与新的等待机制。发布物须包含原生 flock 模块及其 Gateway 包链接。不可借用 Runtime 代次表示 Gateway HTTP 所有权。 项目进展纪要的候选选择、租约准入和模型发送，要求项目固定电脑与 Gateway 一致。其他电脑不会修改该项目的生成状态。

迁移 068 会将已有综合进展条目标记失效并重置素材水位；迁移 069 建立逐条来源消费记录并一次性重置选择状态。来源会话、失效行和用量历史仍被保存。面板从配置窗口内的当前共享来源重建，在自动门控通过时执行，或由写入者点击生成。来源可见性/删除变化同样触发重建。`HGW_PROGRESS_RESPONSE_LIMIT_BYTES` 默认 1048576，`HGW_PROGRESS_USAGE_REPLAY_BATCH` 默认 64。迁移 070 为新请求证据加入不可变的 Session 格式输入快照；更早的行保留请求 JSON。迁移 071 在项目永久删除时级联删除进展证据；归档仍保留证据。迁移 072 增加压力采样范围，并一次性清空未使用观测；活跃预留仍占用至其所有者结束。发布物须包含 Session 包入口及 Gateway 链接。中断请求持续保留资源记账，实际恢复后重放用量缺失。详见 [Gateway 进展参考](../../../../gateway/README.zh.md#project-progress)。

Gateway 异步解析文档账号。项目配置和文档的 UID/GID 查询使用现有的 `HGW_READINESS_TIMEOUT_MS` 期限，过滤继承凭据，并在报告失败或确认取消前等待子进程关闭。无需数据迁移或新增配置。

冷 Runtime 的 completion 在资源登记与就绪发布期间保留就绪期限和取消状态。期限采用单调时间，每次 HTTP 探测受剩余等待时间限制。后端拒绝保留结构化错误。启动失败会在释放常驻预留前确认物理回滚，终止未确认时继续占用。现有设置与存储记录无需重写。

终端后代与 Windows shell 的宽限期也采用进程单调时间，在墙上时钟调整时仍保持终止升级。仍须先确认会话已清理，才能释放资源。

已卸载的本地提供方在清理未确认时保留退出回调；最后一个自有进程、终端与控制端点排空后解除回调，也包括失败后重试完成的终端 close。
