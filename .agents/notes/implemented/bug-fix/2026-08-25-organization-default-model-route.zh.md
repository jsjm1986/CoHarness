# Agent Note: 组织默认模型解析为可服务路由

Status: implemented

[English](2026-08-25-organization-default-model-route.md) | 中文

## 问题

基础组合包携带旧的 `deepseek-official/deepseek-v4-flash` 默认值，而 Gateway 管理的运行时以 `org-*` 注册组织路由。没有个人 `agent-default-model` 设置的用户会从一个被模型治理正确拒绝的路由启动，即使当前存在获授权的组织模型。

## 决策

Gateway 模型策略投影会选择同时满足运行时主体授权、并且存在于启用 Provider 投影中的第一条路由，并将它写入运行时 home 配置中带标记的 `agent-default-model` patch。该 patch 属于组合默认值，因此 user 层的 `settings.yaml` 选择仍然优先，个人 Provider 与用户主动选择不会被覆盖。策略刷新和运行时启动都会重写带标记的区块；没有可用路由时会移除该区块，运行时继续保持 fail-closed。生成的模型策略与配置 patch 仍由 Gateway 负责投影，数据库授权行不变。

这项决策扩展了[默认模型说明](../feature/2026-08-07-default-model-follows-the-picker.zh.md)中定义的默认选择归属，但不改变用户选择的持久化契约。可服务路由的判断依赖[组织 Provider 归属](../feature/2026-08-17-organization-model-provider-ownership.zh.md)和[模型渠道健康状态](2026-08-21-model-channel-health-and-capability-claims.zh.md)。

## 考虑过的替代方案

- **把基础组合包默认值改成 `org-*` 路由。** 否决：基础组合包也服务于没有 Gateway 组织 Provider 的部署。
- **把管理路由持久化到每个用户的 settings 文档。** 否决：系统投影会和用户选择无法区分，并可能遮蔽后续组织配置变化。
- **在 ApiProxy 内静默替换无效选择。** 否决：显式用户选择必须保持可见，并在请求时返回授权说明，而不是被悄然改写。

## 结果

新建或重置的组织用户无需管理员逐个编辑 home 即可获得可用的托管模型。个人 Provider 选择继续通过 settings 层优先生效，运行中的实例也会通过现有 home-patch 监听器观察组织默认值变化。没有任何获授权且可服务路由的主体不会生成默认值，在管理员授予或启用模型前保持明确的不可用状态。
