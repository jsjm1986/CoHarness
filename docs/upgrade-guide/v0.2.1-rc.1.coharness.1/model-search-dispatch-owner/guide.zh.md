---
kind: upgrade-guide
description: "独立模型搜索在异步凭据解析后、HTTP 前检查资源和策略归属。"
---

# 归属变化后重试独立模型搜索

[English](guide.md) | 中文

## 变更

独立 Messages 和 Sonar 搜索在模型准入和凭据解析期间保留资源提供者。提供者被移除、替换、新增准入或新增必需模型策略时，以 `WEB_PROVIDER_ERROR` 拒绝过期 HTTP。未使用的许可归还原提供者。此前，排队或等待凭据的搜索仍可能在这些变化后派发。

成功结果、Session 请求字段、逐用户授权和配置中的模型默认值保持兼容。缺少必需策略仍会拒绝默认受管路由。

## 迁移

1. 部署匹配的 `@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-web-search-deepseek` 和 `@deepseek-ai/dsh-web-search-perplexity` 产物。
2. 自定义 `ModelSearchImplementation.independent` 实现会接收第四个参数，即归属检查。应在异步准备后、HTTP 前调用，并在调用方持有的记录回调前后调用。
3. 被拒绝后恢复授权或准入，再重新搜索；不要转移旧许可。参见 [Web 参考](../../../../packages/web/web/README.zh.md)。
