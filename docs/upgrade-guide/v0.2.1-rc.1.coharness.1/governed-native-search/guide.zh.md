---
kind: upgrade-guide
description: "受管原生网页搜索使用已配置 LLM 路由的授权、凭据、准入和用量记录。"
---

# 为受管原生搜索选择模型路由

[English](guide.md) | 中文

## 变更

安装或要求模型策略，或配置了搜索的 `provider` 时，原生 Messages 与 Sonar 搜索使用普通 LLM 授权、模型准入、执行归属与实际用量报告。默认受管路由分别为 Messages 的 `deepseek-official` 与 Sonar 的 `perplexity`。其预备适配器拥有端点和凭据；独立搜索的 `baseURL`、`apiKeyEnv` 与 `apiKey` 不覆盖它们。

DeepSeek API key 直连适配器和显式配置的 pi-ai Messages 路由实现原生 Messages 搜索。显式配置的 pi-ai `openai-completions` 路由实现 Sonar 搜索。不匹配的协议以 `MODEL_OPERATION_UNSUPPORTED` 失败。仅依靠提供方原生登录的目录路由以 `MODEL_OPERATION_AUTH_UNSUPPORTED` 失败，不将登录投射到另一请求协议。缺少必需模型策略，或等待时撤下策略提供方，会拒绝派发。

## 迁移

1. 确认受管运行时加载了支持对应 Messages 或 chat-completions 操作的 LLM 路由，并授权其精确模型。
2. 路由不同于默认值时，把 `web-search-deepseek.provider` 或 `web-search-perplexity.provider` 设为该路由。把搜索 `model` 设为同一路由提供的模型。保留 `maxTokens` 与协议特定的搜索控制项。
3. 将自定义搜索端点和凭据引用移入该 LLM 路由的连接配置。确认部署支持对应的原生搜索 API。
4. 执行搜索，检查其精确 Session 请求与实际用量。缺失提供方用量保持缺失，不能生成零成本成功记录。替换策略提供方时拒绝的请求可重试。

既无模型策略也未显式配置 `provider` 的独立组合保留独立端点与 API key 设置。挂载预算时，既有模型资源保护仍有效。
