# Agent Note: 个人 Provider 与 model 登记审计

Status: implemented

[English](2026-08-24-personal-model-registration-audit.md) | 中文

## Problem

个人用户可以独立配置 Provider 路由和 model，但 Gateway 过去只记录模型调用，无法区分配置活动与使用量，也无法查看用户的登记历史。

## Decision

个人 settings 成功提交后，会为 Provider 和 model 的新增、修改、删除生成不含敏感信息的语义登记事件。model-governance 运行时使用现有崩溃安全 outbox 写入带 `model-registration` 判别字段的事件。经过认证的 intake 通过现有运行时令牌解析用户，以事件 ID 去重，并将事件写入 SQLite 或 PostgreSQL；事件不包含 API Key、凭据值、完整 profile 或请求内容。

管理员 API 和 Models 页面提供当前有效 Provider/model 数量，以及按用户、Provider、model、动作和时间筛选的永久历史。登记历史只读，不审批、拒绝、改写个人路由，也不会把个人路由转换为组织路由。模型使用量仍是独立的统计面。

个人 Provider ID 只需要是非空 settings 键，不再要求 shell 标识符格式。浏览器独立派生安全凭据引用，对特殊 ID 加入稳定后缀以避免冲突。适配器协议、端点、凭据传输、组织命名空间和 model 身份检查仍是技术要求。

## Alternatives considered

**复用模型使用量记录。** 不采用，因为 settings 变化不是模型调用，混用会破坏调用数和成本计算。

**在 settings 请求中同步写入 Gateway。** 不采用，因为 Gateway 临时不可用会让本地已经成功的设置看起来失败；现有 outbox 已提供持久重试和幂等性。

**保存完整 settings 快照。** 不采用，因为快照扩大秘密暴露风险，并使审计查询依赖每个 Provider 的 profile schema；语义身份事件已经足够支持统计和历史。

**把个人 ID 限制为凭据兼容的小写名称。** 不采用，因为凭据引用是实现细节，不应限制用户选择 Provider 路由。

## Consequences

管理员可以在不接触秘密或控制个人配置的前提下审计配置活动。事件采用至少一次投递，查询写入按事件 ID 幂等。运行时会为 user settings 层中已经存在的身份生成确定性的基线事件，因此重启不会重复当前数量。使用不受支持协议或无效端点的个人路由仍会在适配器/settings 校验处失败，组织保留路由仍不进入个人授权路径。

## Verification

登记 diff、outbox、intake、SQLite 持久化、Admin API、PostgreSQL migration 和自定义 Provider ID 测试覆盖新行为。Gateway、governance 和 Models settings 聚焦测试通过，Admin UI 生产构建完成。
