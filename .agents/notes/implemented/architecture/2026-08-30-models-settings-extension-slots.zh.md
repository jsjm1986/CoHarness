# Agent Note: Expose additive Models settings extension slots

Status: implemented

[English](2026-08-30-models-settings-extension-slots.md) | 中文

## 问题

提供方专属的登录或状态控件必须修改 Models 分区或依赖其编辑器实现。这样会把独立发布的提供方插件与页面的 ACL、凭据联接和布局耦合起来。

## 决策

`ui-settings-models` 声明两个增量子 slot：按提供方 settings namespace keyed 的 `settings.models.provider-card`，提供脱敏的提供方条目以及 configured/keyConfigured 事实；以及有序的 `settings.models.footer`，不携带可变页面状态。Models 分区会在 setup、已配置和新增提供方卡片中，以及添加控件之后渲染这些 slot。分区仍是提供方身份、授权和 settings／凭据写入的唯一所有者；slot owner 只接收数据型 props，并通过正常 slot effect 注册。

## 考虑过的替代方案

**让扩展导入并包装 `ModelsSection`。** 不采用：包装器会替换页面所有权，可能重复 ACL、加载或写入行为。

**把完整 settings store 暴露给每个提供方插件。** 不采用：这会把脱敏联接和 mutation 权限泄漏到页面所有者之外。

**为每个提供方家族建立独立 slot。** 不采用：settings namespace 是稳定的 owner key，也能覆盖手工声明的路由。

## 影响

提供方伴随插件无需拆包或 fork 页面就能增加控件。没有 occupant 时 slot 不渲染；Models 声明卸载后，子 slot 会随之移除。slot 契约不授予 secret 值或写权限；扩展必须通过自己的能力 seam 调用所属 transport。

## 测试

Models apply 和 component 测试断言子 slot 声明、提供方 owner 事实、已配置行的 keyed dispatch 以及 footer dispatch，并继续覆盖现有个人／项目设置行为。
