# Agent Note: DeepSeek 请求元数据使用显式启用的扩展提供方

Status: implemented

[English](2026-08-29-deepseek-request-metadata-opt-in.md) | 中文

## 问题

上游版本新增了活动插件包清单和增量 Session 日志后缀等提供方元数据字段。若直接把这些字段加入 DeepSeek 适配器，就会把字段所有权与 HTTP 传输混在一起，还可能在没有部署方明确选择时发送工作区或会话数据。

## 决策

`@deepseek-ai/dsh-deepseek-llm-api-extensions` 拥有官方 DeepSeek 请求顶层增量字段的 effect-scoped 注册表。贡献包各自拥有字段语义：`@deepseek-ai/dsh-plugin-package-inventory-deepseek` 生成 `dsh_plugin_packages`，`@deepseek-ai/dsh-session-log-deepseek` 生成 `dsh_session_log`。适配器先序列化基础请求，再准备脱离且冻结的扩展字段，遇到字段冲突立即拒绝；只有 HTTP 2xx 后才运行已捕获的接受回调。该注册表仅服务 DeepSeek，提供方无关的 LLM seam 与 pi-ai 适配器不消费它。

独立挂载插件包清单时默认启用；随附 base profile 会将其覆写为关闭，只有存在 `COHARNESS_SEND_PLUGIN_METADATA=1` 时才启用。清单只包含活动 Loader 包的名称／版本对，不包含路径、配置、凭据、普通依赖、松散文件或内存配置项。Session 日志贡献方默认关闭，随附 profile 只有在 `COHARNESS_UPLOAD_SESSION_LOG=1`、可选 endpoint allowlist 和 `COHARNESS_DISABLE_SESSION_LOG_UPLOAD` kill switch 的条件下才启用。它发送权威 Session header 以及最大持久 `delivery-accepted` 水位之后的后缀；成功响应会追加该水位，不确定交付在崩溃后至少重试一次。

两个字段都是位于消息、系统提示词和工具 schema 之外的提供方元数据，因此不增加模型输入 token，也不改变缓存前缀。已有的[遥测显式启用决策](../feature/2026-08-10-telemetry-default-off.zh.md)继续负责遥测数据流；这些请求扩展拥有独立的开关与审计。

## 考虑过的替代方案

**在每个官方请求中都发送字段。** 不采用：缺少配置不能等同于明确同意披露插件或 Session 信息。

**把元数据插入消息或系统提示词。** 不采用：这会改变模型可见历史、token 记账、回放要求和缓存行为。

**让每个贡献方直接修改适配器请求。** 不采用：贡献方会共享传输生命周期，可能覆盖基础字段，也无法在已知响应状态后可靠提交接受状态。

## 后果

普通 dsh profile 保持新字段缺省，不产生新的数据出口。显式部署得到确定且受 allowlist 约束的元数据，并且准备阶段 fail-closed、请求级开关可立即停用。扩展准备失败会阻止 HTTP 发送；接受失败会在提供方已接受响应后作为请求错误报告。Session 日志交付采用至少一次语义：服务器接受后到持久水位写入前发生崩溃可能重放后缀，但不会跳过事件。
