# Agent Note: Session-title provider strategy split

Status: implemented

[English](2026-10-18-session-title-provider-strategy.md) | 中文

## Problem

模型支持的会话标题最初以 `dsh-session-title-llm` 中的共享辅助组件交付：`registerSessionTitleLlmProvider` 代替调用方注册提供方，`generateSessionTitleWithLlm` 通过一个 `SessionTitleLlmMessageSelector` 为所有提供方统一负责提示词、JSON 封装、输出解析与标题长度目标。在两个已发布提供方需要相同措辞与解析时这样做尚可，但它使策略细节——all-prompts 节奏应如何锚定当前标题以保持稳定性、标题调用应使用哪种推理强度、输出解释中有多少属于模型约定——无法在不改动共享包的情况下变化。标题长度目标还是共享执行配置中仅有的提供方专属字段，使 `SessionTitleLlmConfig` 同时描述了两种不同的所有权。

## Decision

接缝在“策略”与“执行”之间重新划分。`@deepseek-ai/dsh-session-title-llm` 现在是执行模块：`SessionTitleLlmConfig` 只携带 `maxInputBytes`、`maxOutputTokens`、`timeoutMs` 以及可选的成对 `provider`/`model` 路由。每个提供方插件直接通过 `ctx.sessionTitle.register({ id, automatic, generate })` 自行注册，并在 `generate(request)` 内拥有自己的系统指令、用户输入、来源 `messageSeqs`、标题长度目标、输出解析与推理强度选择，再调用 `executeSessionTitleLlm(ctx, config, request, titleProvider, { system, input, messageSeqs, selectReasoningEffort })`。

执行器负责不得漂移的部分：未配置覆盖对时经已记录 `request/header` 的路由解析、对提供方最终输入的 `maxInputBytes` 计量、`maxOutputTokens` 上限、在流式消费期间与完成后反复检查的融合超时与调用方取消、分发前追加的精确纯日志 `session/title-llm-request` 记录、携带 `purpose: 'session-title'` 的 `ctx.llm.prepareCall` 分发，以及把流组装为内容块与最终结束原因。它返回 `{ blocks, finish, model }`，不评判输出：每个提供方各自拒绝 `tool-calls` 与 `max-tokens` 结束原因、组装出的工具调用块以及空标题。

推理强度由提供方选择。`selectReasoningEffort` 检查已解析的 `LlmResolvedModelInfo`；已发布的提供方返回路由支持的最低强度（`model.reasoning?.efforts[0]?.id`），当路由不提供强度时则不指定。由于本 fork 的 `ctx.llm.prepareCall` 只接受 `(config, signal)` 而没有元数据回调，执行器自行解析模型信息，把所选强度写入调用配置，并从 `call.config.reasoningEffort` 读回有效强度记入请求记录。`session/title-llm-request.reasoningEffort` 为可选字段，因此字段出现前写入的记录仍然可读。

`SessionTitleProviderRequest` 新增 `currentTitle`：最新已接受标题（包括回退与用户标题）的深度冻结快照，在每次提供方调用前从完整事件快照中捕获，而 `messages` 仍受已排定修订水位线的约束。all-prompts 提供方把提供方来源的 `currentTitle` 锚定在 `{ currentTitle, messages }` JSON 对象中，并附加“仍贴切则原样保留”的指令，使仍然贴切的标题可在重新生成中原样保留；回退与用户标题从不被锚定，first-prompt 提供方忽略该字段。

## Alternatives considered

- **保留共享注册辅助组件并扩充选项**——不予采纳：共享的提示词／解析策略正是要解除的耦合；每个新策略开关（锚定规则、强度选择、接纳策略）都会扩宽一个没有任何提供方完整拥有的配置面。
- **保留单个提供方插件并加 `SessionTitleLlmMessageSelector` 选项**——不予采纳：消息选择从来不是真正的变化点；节奏、封装、锚定与解析全都不同，而 selector 类型无法表达这些差异。
- **令新请求记录上的 `reasoningEffort` 必填**——不予采纳：已发布日志携带不含该字段的记录，读取端必填会破坏对已定稿世代的读取。可选字段保持加法演进。
- **由执行器选择强度**——不予采纳：标题调用是否应低成本推理属于提供方策略的模型约定决策，与其提示词对称。

## Consequences

- 两个已发布提供方有意重复少量封装惯用写法——`jscpd:ignore` 标记标明共享代码止于何处、各提供方策略始于何处。
- `SessionTitleLlmConfig` 收缩为纯执行控制项；`targetWords`/`targetCjkCharacters` 移入各提供方 `Config`，提供方无需改动共享 schema 即可调整或移除目标。
- 旧的 `session/title-llm-request` 记录仍然可读；新记录额外钉住生效的推理强度，因此变更后生成的快照 golden 携带 `reasoningEffort`，而更早的世代没有。
- 旧的辅助组件名称（`registerSessionTitleLlmProvider`、`generateSessionTitleWithLlm`、`SessionTitleLlmMessageSelector`）已不存在；预稳定消费者在仓库的同步更新规则下一起迁移。
- 本纪要部分取代[日志支持的会话标题](../feature/2026-07-21-log-backed-session-titles.zh.md)中的提供方一半；后者仍是事件归属、回退、注册生命周期与折叠的决策。

## Testing

- `pnpm vitest run packages/session` —— 106 个文件共 2716 项测试通过；`session-title-all-prompts-llm/tests/provider.spec.ts` 钉住锚点选择、预置历史、最低强度选择、首行解析、结束原因／工具调用拒绝以及逐字保留标题；`session-title-first-prompt-llm` 在 first-prompt 节奏下覆盖同样的执行路径。
