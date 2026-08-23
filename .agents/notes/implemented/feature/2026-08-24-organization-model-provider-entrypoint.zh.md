# Agent Note: 组织模型 Provider 入口

Status: implemented

[English](2026-08-24-organization-model-provider-entrypoint.md) | 中文

## 问题

共享 Models 分区在 Gateway Admin 组织编辑器中渲染了两个并列的新增操作：采用休眠的 Provider 路由，以及声明新的 Provider。组织 facade 只投影已经配置的 `org-*` profile，因此第一个操作没有目标，只能保持禁用。它的存在会让人误以为可以把适配器已有路由加入组织，而 Gateway 会拒绝 legacy catalog Provider，组织 profile 也必须显式创建。

## 决策

只有当当前管理作用域的 Models 联接快照包含未配置的 Provider 时，才渲染休眠路由操作。没有此类路由时，声明操作成为唯一入口并占满新增行。个人设置在适配器目录提供休眠路由时仍保留两个操作。组织编辑器继续传入 `managementScope: 'organization'` 和 `org-*` 路由模式；API 与 Provider 生命周期语义不变。

## 结果

Admin 用户看到的是唯一可执行的组织入口，不再看到禁用的兼容性占位操作；组织行也使用组织归属徽标，而不是个人界面的「自定义」徽标。共享个人界面仍可采用适配器所有的路由；未来组织 facade 如果合法地暴露休眠路由，会自动恢复双入口布局。既有的 Provider 编辑、凭据存储、模型发现、授权和运行时投影均不变。

## 验证

共享 Models 组件测试固定组织作用域隐藏通用操作并保留组织声明操作；样式测试固定单入口全宽规则。Gateway Admin `ModelsPage` 与 model-settings facade 测试通过，Admin 生产构建成功。
