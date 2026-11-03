---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-dsh-sdk

[English](README.md) | 中文

SDK 提供方会在全新的子进程中把每个 subagent 作为完整的 DeepSeek Harness 运行时运行，并经由 [TypeScript SDK 客户端](../../sdk/client/README.zh.md) 通过 stdio JSON-RPC 驱动。它是 [`subagent-acp`](../subagent-acp/README.zh.md) 之外的第二个进程外后端，差异在协议格式（wire format）和子进程约定：ACP（Agent Client Protocol）后端能驱动任何 Agent Client Protocol agent（智能体）；本后端专门驱动 harness SDK 运行时（通过具名 `dsh` SDK profile 启动），因此子进程是一个完整的对等 harness，拥有由 `cordis.yml` 决定的组合、会话持久化、模型路由和工具。

## 概述

`dsh-subagent-dsh-sdk` 在全新的 DeepSeek Harness 子进程中运行每个委派任务，子进程拥有自己的 profile、会话、模型路由与工具。父级提供任务与工作目录，每个子进程使用其已配置的运行时，并与父级对话保持隔离。只有最终 assistant 文本或安全错误进入父对话。受管父级控制为授权和计量观察模型请求及流式块；子级保留自己的完整记录。当委派需要完整的 Harness 运行时而不是共享进程内状态时，选择此后端，并接受每次运行都要启动新进程的成本。

## 目录

- [启动与所有权](#start-and-ownership)
- [停止原因映射](#stop-reason-mapping)
- [能力与上下文](#capabilities-and-context)
- [配置](#configuration)
- [进程边界](#process-boundary)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="start-and-ownership"></a>
## 启动与所有权

`start(request)` 先解析子进程工作目录，通过 `DeepSeekHarness` spawn 运行时，并在履行前完成 `initialize` 握手（携带配置的 `provider`/`model` 路由及可选的 `maxTokens` 输出上限）。履行意味着子运行时已就绪、所有权已移交给调用方。启动失败时拥有回滚责任；无法确认的进程清理或许可确认仍由提供方持有。提供方在下一次启动前和卸载时重试原始清理；持续失败会拒绝替代启动。工作目录解析失败会在分配前拒绝。

Subagent 服务在 SDK 提供方启动前解析子进程工作目录。该目录成为子进程 cwd 和其生效 Session 目录；父 Session 头保留为原始目录。提供方没有 `cwd` 配置项。

返回的 run id 在父级命名空间中生成；子运行时的会话 id 只存在于子进程内部。发布后，提供方拥有一段 SDK 活动，并从子会话事件中读取答案：最后一条完整且非空的 `assistant/message`（记录 usage 的空内容消息会被跳过）；若没有这类消息，则取累积的 `text-delta` 流。取消或发生错误后，部分输出仍然可用。

`dispose()`（资源释放）是幂等的：先在本地把结果确定为 `aborted`（协议层面没有提示词取消机制），再关闭运行时，即先发出一次有界的协议 `shutdown` 请求，随后通过共享的 stdin-EOF → SIGTERM → SIGKILL 阶梯使进程实际退出。

模型策略、资源准入、父级 LLM 中间件与执行权限从发起 Agent 的 Context 解析，包含其隔离服务。提供方卸载仍持有全部待处理和已发布子级的生命周期所有权。

安装资源预算时，会在构造 SDK 客户端前，以执行归属和发起方 Session 申请 `kind: process` 许可。必需预算缺失或拒绝准入时不会启动。只有 SDK 清理确认运行时进程退出后才释放许可；无法确认时报告不确定占用。许可取消和提供方卸载会关闭待启动及已发布的子进程，提供方释放会等待清理。单次任务结束也会关闭子进程；`dispose()` 共用同一次清理。每次受管子模型请求和子级创建的进程分别申请父级准入。

SDK 启动在等待先前清理前保留发起方的资源提供方、必需标记与执行权限。排队许可或控制监听器等待不能把启动转交给替代所有者，也不能使其变为独立执行。原生启动前、初始化后、首个提示词前和发布前都会复核归属。失效启动归还未使用的容量或等待其原运行时清理；清理失败仍保留所有权。恢复归属后应请求新的委派。

父级安装资源准入、模型策略或执行权限服务时，私有引导插件先于子 profile 的全部插件执行。子模型调用在等待期间保留原始父级策略，准入后执行全部父级授权监听器，并通过 `llm/delegated-stream` 上报实际用量。父级重放游标保持独立。子级继续使用自己的适配器、凭据、附件和精确输入日志，原生模型操作也遵循该路径。子进程 Consumer 使用父级资源提供方。取消会停止排队及活跃工作；缺少清理确认时保留不确定占用。受管子级必须确认引导已激活，SDK 运行才会发布。

资源完成确认被拒绝后会重试原始许可。父级与子级串行执行报告，允许已确认的不确定状态在证明清理后推进为已释放，并保留该证明，不受迟到的不确定报告影响。父级与子级均保留不确定操作，直到静止状态得到确认；父级将其计入 `maxControlOperations`。不确定期间，子级继续观察原父级许可，使撤回仍能取消存活的原生工作。只有最终释放或子级提供方关闭才停止观察。父级控制关闭被拒绝后，可在监听器继续关闭的情况下重试记账（[决策](../../../.agents/notes/implemented/architecture/2026-10-24-sdk-managed-model-requests.zh.md)）。

子级从登记到完成确认始终保留每个操作，包括许可发布前被取消的准入，以及关闭确认失败的模型范围。后续模型或进程准入在请求更多容量前重试未完成的模型关闭；资源准入还会重试未完成的资源报告。关闭流程报告未确认的清理失败。完成消息通过私有 `settledRegistration` 元数据声明最后一个已结束的登记尝试，使连续取消无需穿插成功登记也能回收旧 id。已经登记的操作保留其许可与排队准入。

私有控制凭据在引导期间消费，从启动环境快照中隐藏，普通子进程不会继承它们。未安装父级资源准入、模型策略和执行权限服务的组合保留独立行为。

已认证的控制上传在读取正文时执行 `controlRequestTimeoutMs`，独立于 Node HTTP 超时扫描。未完成和超大上传会被拒绝；未完成请求在响应后关闭连接，并在后续准入前释放请求槽位。提供方关闭会取消待处理的正文读取。

控制 HTTP 并发上限为 `maxControlOperations` 的两倍，最大为安全整数上限。同一操作的模型输入与输出，或资源观察与完成报告，可以重叠。该传输额度不会提高模型范围或资源操作的准入上限。

模型取消只作用于它的模型许可。取消或受管提供方撤回会中止适配器并等待完成报告，即使流消费者暂停在两个输出块之间。模型清理、待处理准入、消费者关闭和最终报告共享 `controlCleanupTimeoutMs`，最终报告时间预留在其中。超时会拒绝清理，并保留未确认操作供原身份重试。子进程保留调用方自己的取消信号和资源许可；创建该进程的模型调用结束时，不会终止具有独立所有者的进程。

<a id="stop-reason-mapping"></a>
## 停止原因映射

SDK 客户端返回自有子活动，而不是提示词结果。提供方读取该活动内最后一个已持久化的 `turn/end`，并将其映射为 seam 词汇：`completed` → `completed`，`max-tokens` → `max-tokens`，`blocked` → `refusal`，`aborted` → `aborted`（子侧 `disposed` 原因会附带 `child-disposed` 诊断）；其余情况，包括 `error`、`interrupted`、未来变体或不含轮次的活动，均映射为 `error` 并在适用处携带固定的安全诊断，因此非正常停止绝不会报告为成功。发布后的传输层失败会通过 `onError` 诊断接收器（连接到 `ctx.logger.warn`）压平为 `stopReason: 'error'` 并附带诊断；seam 约定禁止 `result` 被拒绝。

<a id="capabilities-and-context"></a>
## 能力与上下文

Provider 宣告 `agentOptions: true`，而 `agentPreset`/`outputSchema`/`depthLimit` 全为 false，且 `inheritsParentContext: false`：子进程是另一进程里的全新运行时，唯一来自父方的输入是工作区 cwd。基于本 provider 的 `dsh-tool-subagent` 部署应设置 `maxDepth: 'provider-managed'`——子 harness 拥有自己的递归预算。

<a id="configuration"></a>
## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `providerName` | `dsh-sdk` | `ctx.subagents` 上的注册名。 |
| `dshBin` | SDK 的同版本依赖 | 可选的既有 CLI 模块；加载插件时按启动目录解析。 |
| `profile` | `sdk` | 子运行时 profile 名。 |
| `patches` | `[]` | 按顺序应用的 profile 补丁；加载时解析并检查文件。 |
| `dshHome` | 必填 | 子 profile 与持久数据使用的绝对独立 Harness home。 |
| `provider` | `deepseek-official` | 写入子进程 `initialize` 的提供方路由。 |
| `model` | `deepseek-v4-flash` | 写入子进程 `initialize` 的模型。 |
| `reasoningEffort` | 未设置 | 子进程默认推理强度；请求覆盖值优先。 |
| `maxTokens` | 适配器／提供方路由默认值 | 写入子进程 `initialize` 的单次请求输出 token 上限；对子运行时的根 agent 及其进程内后代生效。 |
| `env` | `{}` | 在凭据擦除后的父环境之上叠加的显式子环境（例如子进程自己的 `DEEPSEEK_API_KEY`，或 `DSH_CORDIS_CONFIG`）。 |
| `initializeTimeoutMs` | `10000` | 启动期间子进程协议 `initialize` 握手的时限。 |
| `shutdownTimeoutMs` | `1000` | dispose 期间协议 `shutdown` 交换的时限。 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、平台终止之前的宽限。 |
| `disposeGraceMs` | `3000` | 终止后的退出确认窗口；POSIX 在 SIGTERM 之后、SIGKILL 之前也等待同样时长。 |
| `maxControlBytes` | `8388608` | 私有控制请求或响应的最大字节数。 |
| `maxControlOperations` | `1024` | 每个子级的活跃模型流与资源操作上限。 |
| `controlRequestTimeoutMs` | `1000` | 单次私有控制交换时限。 |
| `controlPollMs` | `100` | 资源观察间隔与输出等待上限。 |
| `controlCleanupTimeoutMs` | `4000` | 等待控制清理完成的时限。 |

`controlPollMs < controlRequestTimeoutMs < controlCleanupTimeoutMs` 必须成立。EOF 关闭宽限应留足协作清理时间；强制终止时，缺失的资源报告保持为不确定占用。受管模型调用要求父级 LLM 服务和支持私有引导的 CLI。资源容量配置在父级，不在子级安装独立资源提供方。

```yaml
- id: subagent-dsh-sdk
  name: '@deepseek-ai/dsh-subagent-dsh-sdk'
  config:
    providerName: dsh-sdk
    profile: sdk
    dshHome: /absolute/path/to/child-harness-home
    patches: []
    maxTokens: 49152
    env:
      DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-sdk, toolName: subagent, maxDepth: 'provider-managed' }
```

<a id="process-boundary"></a>
## 进程边界

子进程环境以 [`dsh-subprocess`](../../subprocess/README.zh.md) seam 的 `scrubbedParentEnv()` 为基础，先移除疑似凭据和名称为 `DSH_*` 的环境变量，再合并显式 `config.env` 值。子进程由 SDK 客户端 spawn，而不是经由 `ctx.subprocess` spawn（这是 subprocess README 中记录的 SDK 托管传输例外），因此本后端会自行执行环境清理。JSON-RPC 协议格式才是真正的序列化边界。

本包没有默认导出。否则 Cordis loader 解包会隐藏具名 `inject` 元数据；见[事故复盘（postmortem）0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)。

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

子运行时的模型会收到作为用户消息的独立任务，以及该运行时自身配置的系统提示词、工具和全新会话。它不会收到父级对话。父级工具调用可以为本次运行选择子级提供方、模型与推理强度；所选路由和由部署控制的可选输出上限会固定到这个新子进程。独立 preset、深度强制与结构化输出仍不受支持，并会被拒绝而不是静默省略。

#### Token 影响

子运行时会为独立的完整上下文及其多步骤历史消耗 token。这些 token 绝不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。每个 SDK 子进程只能复用其自身提供方、模型、组合和历史均相同时的前缀；除此之外，子 agent 的步骤仅追加增长。

### 父级工具结果（间接）

#### 模型看到什么

经由 `dsh-tool-subagent`，父级只会收到子运行时最终的 assistant 文本（或累积的部分文本），或该消费方给出的精确停止原因错误；不会收到中间消息或工具流量。带诊断的非完成结果会先呈现安全诊断，再单独呈现保留的部分 assistant 输出；启动与 shutdown 错误使用同一固定事实，不公开原始 SDK 文本。

#### Token 影响

父级输入只增加最终结果或错误，其大小取决于数据，并保留到压缩（compaction）为止。本提供方自身不会向父级添加任何 schema。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项


- **每次运行都使用全新的运行时进程**：不使用进程池；harness 运行时需要启动完整的插件树，因此每次运行的 spawn 成本高于 ACP 后端通常使用的子进程。
- **不支持非路由的启动时能力**：父级可以选择子 agent 路由，但无法在子进程内强制执行 `agentPreset`、`outputSchema` 或深度限制；应改为配置子进程自身的 `cordis.yml`。
- **子进程的 transcript（文本记录）保留在其自身的会话根目录中**：父级保留自己的委派调用／结果、子级目录和后台任务生命周期记录。子级流式 `session.event` 通道只用于提取输出，不会复制到父级文本记录中。
- **仅支持本地子进程**：在准入前拒绝绑定 SSH 的父 Session，其执行目标不能变成宿主机工作目录。远程运行时需要独立后端。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
