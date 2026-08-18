# Agent Note：运行时策略保留完整组织 Provider profile

Status: implemented

[English](2026-08-18-organization-provider-policy-preserves-profile.md) | 中文

## Problem

Gateway 会把已启用组织 Provider 的端点、协议、凭据引用、模型能力和完整 pi-ai profile 投影到每实例策略中。实例启动后唯一可持久读取的输入就是这份运行时策略，因此 LLM 适配器必须收到管理员保存的全部字段。

如果 Provider 行只保留路由 id 和显示名称，就会丢失上下文上限、图像支持、推理拼写、兼容开关、请求标头、传输方式、超时、缓存和重试设置。路由仍可能显示为已授权，但请求会使用适配器默认值或环境中的凭据，既改变模型行为，也可能越过组织与个人凭据的所有权规则。

## Decision

`loadPolicy` 会校验并克隆完整的组织 Provider 快照。顶层路由身份、协议、端点、凭据引用、模型列表和扁平化 Provider 选项都会解析为 `ManagedModelProviderProfile` 契约。每个嵌套 `profile` 都作为 JSON 数据保留，同时检查其中重复的身份字段是否与权威顶层值一致。

组织凭据引用必须匹配 `DSH_[A-Z0-9_]+`，嵌套的 `apiKeyEnv` 必须等于顶层 `credentialRef`。profile 不能引入个人或环境凭据引用。Gateway settings facade 与运行时加载器会执行同一组受管 pi-ai 子集规则：`compat` 只能包含 `thinkingFormat` 与 `supportsReasoningEffort`，非空 compat 只对 `openai-completions` 有效；推理映射必须包含非 `off` 档位，且每个思考档位都要有 wire 值；thinking budget 只接受 `minimal`、`low`、`medium` 与 `high`；重试策略键及退避值都有界；`streamIdleTimeoutMs` 必须是正的有限 Node 定时器延迟。无效设置会在持久化前拒绝；无效的运行中策略会进入既有的 fail-closed 重载路径，不会用不完整或不可服务的 Provider 集替换正在工作的集合。

组织路由会显式列出模型，因此只属于 catalog 路由的非空 `modelOverrides` 会在保存设置时以及运行时加载策略时再次拒绝。共享 schema 产生的空对象仍然接受，组织编辑器也不会显示这个字段。

加载器保留 Gateway 的完整 profile，不维护第二套删减版 Provider schema。`ReloadableModelProviderConfig` 会发布 structured clone，并在暴露前递归冻结每个嵌套对象与数组。适配器继续负责 pi-ai 物化和请求分派；治理插件负责策略文件解析、凭据所有权检查，以及交给适配器的不可变快照。

## Alternatives considered

**只保留路由和显示元数据。** 否决，因为授权看似成功时，模型容量、多模态输入、推理协议和部署专用的传输设置会静默回退到默认值。

**信任下游适配器拒绝坏投影。** 否决，因为错误的凭据引用可能触发环境凭据发现，适配器刷新失败也会让策略中的授权状态与实际 Provider 状态不一致。

**把 Gateway 校验器作为运行时依赖共享。** 否决，因为树外插件会获得 Gateway 持久化和管理端依赖。加载器在本地校验规模有限的 wire 契约，保持部署包与运行时包边界清晰。

**只冻结 Provider 与模型记录。** 否决，因为嵌套 profile 字典和数组仍可通过 Consumer 持有的引用修改。这样一来，标头、推理映射、重试退避、输入模态列表或 compat 块都可能在没有 revision 或 `model-provider-config/updated` 事件的情况下变化。

## Consequences

组织模型会使用管理员选择的容量、输入模态、推理映射、兼容开关、标头、传输、超时、缓存和重试行为。即使策略文件被手工修改或部分损坏，凭据解析仍只属于组织所有。已发布快照只有经过校验的替换和 revision 事件才能改变。加载器会重复一小组 Gateway 与适配器校验规则；新增受管 Provider 字段时，必须同时更新共享类型、Gateway 投影、加载器校验和回归 fixture。

## Testing

`plugins/dsh-model-governance/tests/policy.spec.ts` 会加载完整 Provider profile，并证明凭据所有权、compat 协议与字段名、推理映射、thinking budget、定时器、重试策略和组织 model override 无效时都会 fail closed。`plugins/dsh-model-governance/tests/provider-config.spec.ts` 证明来源对象修改和 Consumer 修改都无法改变已发布的嵌套值。Gateway settings 测试覆盖同等的保存时校验和编辑器 schema 投影。`packages/llm/llm-pi-ai/tests/managed-config.spec.ts` 会挂载真实 Service Definition 与 Consumer，再验证受管 profile 会控制模型能力、请求默认值、重试注册、凭据、标头和推理分派。
