# Agent Note: 独立 Web 插件在应用挂载后加载

Status: implemented

[English](2026-11-20-web-plugin-startup-isolation.md) | 中文

## Problem

Web 内核曾在交给渲染器前检查完整插件名册。设置扩展不可用时，聊天界面可能停留在启动页。应用组合的预载也会在首次渲染前下载独立扩展的脚本。

## Decision

[客户端模块注册表](../../../../packages/client/modules/README.zh.md)允许独立应用插件通过 `dsh.client.optional: true` 声明延后加载。引导条目、默认条目，以及它们沿 `inject` 和 `external` 声明传递依赖的条目均为必需。Host 为其余可选条目各发布一个应用批次。收到混合必需条目和可选条目的组合时，浏览器使用单条目 URL。

[Web 内核](../../../../packages/client/web/README.zh.md)检查必需条目后挂载渲染器。持有渲染器挂载的 fiber 在后续浏览器任务中启动可选条目。[页面的条目控制器](2026-09-23-page-owned-client-entries.zh.md)在变更队列之外启动限时的可选脚本请求，所需工厂注册后才提交 Loader 变更，并在「插件」页逐条报告故障。模块图变更、重试和卸载会取消过期请求。已取消的经典脚本仍可能执行，模块系统在注册时检查该脚本的生命周期。[设置中的插件清单](../../../../packages/client/ui-settings-plugin-inventory/README.zh.md)采用此声明，用户选择对应标签页时才读取清单。会话、连接和输入区保留必需服务与授权检查。

## Alternatives considered

**只延后功能正文。** 适合提供共享服务或插槽声明的必需插件，但入口脚本请求或激活失败仍会阻塞整个名册。

**忽略启动时的所有条目故障。** 连接、会话或工作区组合失败时，必须显示错误并阻止挂载不完整的应用。

## Consequences

可选条目不可用时，核心应用仍可使用。必需消费方声明依赖的插件会成为必需条目。可选入口在挂载后以低优先级请求，按需分块使用浏览器的正常优先级。
