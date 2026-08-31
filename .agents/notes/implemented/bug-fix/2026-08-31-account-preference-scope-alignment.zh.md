# Agent Note: 对齐账户级对话偏好字段

Status: implemented

[English](2026-08-31-account-preference-scope-alignment.md) | 中文

## 问题

浏览器 conversation 插件把忙碌态 Enter、对话宽度和字号绑定到同一个 account-or-host scope。Gateway 账户接口在 `ui-conversation` namespace 中只接受忙碌态 Enter，因此显示设置写入会被作为无效账户字段拒绝。两个设置行共用一个 scope，显示写入被拒后，Enter 控件旁也会出现保存错误。

## 决策

Gateway 账户偏好契约现在存储 `ui-conversation` 的三个字段。迁移 `023_user_conversation_display_preferences.sql` 增加带范围约束的可空宽度和字号列；NULL 保留产品默认值。账户服务返回带有效默认值的结果、记录显式覆盖，并使用现有账户 revision 为每个字段提供并发栅栏。浏览器 transport 会解析并保留数值，Gateway 在选择 SQL 列之前校验支持的范围。账户行首次创建时，旧设置文件中的有效显示值也可以作为初始值。

## 曾考虑的替代方案

**把显示控件绑定到 Host scope。** 不采用，因为共享项目运行时会使账户显示选择变成只读，或让项目成员共享一个值，并把一个账户级 namespace 拆到不兼容的权威来源。

**让显示选择只保留在进程内。** 不采用，因为重新加载、切换端口和认证项目运行时都会丢失用户选择的阅读设置。

**在账户表中存储无类型 JSON 包。** 不采用，因为标量列保留数据库约束、可预测更新和现有脱敏账户响应，不需要引入另一种文档格式。

## 后果

现有账户行在用户选择新值前继续使用 748px 和 14px；迁移不会触碰对话事件，也不会重置语言、主题或 Enter 选择。显示写入不再改变 Enter 行的写入状态，快速编辑仍通过同一个 revision 串行化。独立 Host 继续通过自己的 settings 文档持久化该 namespace。账户偏好与 PostgreSQL 集成测试覆盖数值校验、带 revision 的写入、默认值和增量迁移。
