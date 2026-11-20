# Agent Note: Admin cross-space plugin inventory

Status: implemented

[English](2026-11-17-admin-cross-space-plugin-inventory.md) | 中文

## Problem

`/admin/plugins` 一次只能管理一个空间的插件；管理员想回答"这台计算机上所有个人与项目空间各装了什么"，只能在各空间运行时逐个打开。`plugin_states` 只保存管理员写入的期望组合（受管理行与组合包名——没有版本、安装来源与加载结果），只覆盖被管理员改过的空间，文件驱动空间与 steward 空间永远没有记录。`pluginInventory/list` 远程入口只在实例存活时按单个空间应答。因此用户或项目自研的插件（本地 `file:`/`link:` 路径、git spec、tarball）作为整体不可见，"谁装了插件 X"也没有答案。

## Decision

为每个空间持久化一份运行时上报的**观测清单**，并在现有 `/admin/plugins` 页面顶部以跨空间区块呈现。

**存储。** `harness.plugin_inventory`（迁移 139）与 `node_content.plugin_inventory`（迁移 017）按运行时身份各存一行：`payload` jsonb、`generation`、`updated_at`。该表是观测数据，刻意与 `plugin_states` 期望态分离——管理员的文档与运行时的观测不共享生命周期。治理重建清单把 `organization_id,runtime_id` 标为 restore-safe、`payload,generation,updated_at` 标为 node-owned；`peerProjectTables` 与内容迁移关系表携带 node_content 副本，项目迁移与接管保留最近一次上报。

**上报。** `PluginManagementAuthorization` 新增可选 `reportInventory(snapshot)`；`PluginInventoryReport` 恰好是 `BundleInfo[]` + `PluginInfo[]` 目录投影——含本地化标题、安装来源与生命周期阶段——Admin UI 渲染的是用户看到的同一套卡片而非第二套格式。`gateway-execution` 将其转发到 `POST /internal/runtime/plugin-inventory`。`PluginManager` 在启动稳定后、每次已提交的变更后（经 `syncTail` 排在期望状态发布之后串行执行）、以及一轮 loader 条目 `internal/status` 状态变化平静后（1 秒去抖）调度上报；失败降级为警告，绝不阻塞管理操作；销毁时清除待执行的定时器。

**Gateway。** `PostgresPluginInventory.report` 复用 `resolvePluginRuntimeOwner`——实例行必须仍匹配凭据的所有者、运行时、节点与代次，陈旧进程不能覆盖其后继——然后按所有者内容归属 upsert 进 harness 或 node_content。线上报文解析对条数、字符串、图标做了上限约束并丢弃未知字段。`GET /admin/api/plugins/inventory` 列出本节点上每个实例行（用户、项目、steward；不限于持有 `plugin_states` 的空间），同时关联最近一次上报与已保存的期望组合；损坏的存储载荷降级为缺失而不是隐藏该空间。读取绝不启动已停止的运行时。

**呈现。** `SpacesInventory` 为每个空间渲染一张可展开卡片：运行/停止状态、上报时间、组合包/条目/失败数、带本地化标题与来源徽标（内置、npm、git、本地·自研、归档包）的组合包卡片、关联到存活 fiber 阶段的声明行，以及明确标注"已保存·非观测"的 `SavedComposition` 回退。筛选匹配空间名、组合包名、模块名与本地化标题，v1 即回答"谁装了 X"。管理按钮绑定现有目标选择器；steward 行沿用现有策略保持只读。

## Alternatives considered

- **经管理 invoke 通道做实时扇出查询** —— 否决：它只覆盖在线运行时，每次页面加载要发起 N 个带租约的调用，且用写通道回答只读问题。持久化观测让已停止与从未管理过的空间以一次查询的代价可答。
- **在 `plugin_states` 上扩展观测载荷** —— 否决：该表是乐观修订下的管理员可编辑文档，清空行即删除（[期望态投影](../architecture/2026-10-03-plugin-desired-state-projection.zh.md)）；混入运行时观测会将其生命周期绑在管理员编辑上，并混淆"期望"与"实际"。
- **只上报精简摘要（名称与计数）** —— 否决：管理员需要读本地化标题、版本、来源与阶段；第二个呈现模型需要独立的展示管线，而全量 `BundleInfo`/`PluginInfo` 目录的代价只是稍大的载荷，且复用现有渲染词汇。
- **随本改动引入按插件的 ACL** —— 否决：资格仍是空间级（`plugin_access_policies`）；按插件名的允许清单是另一个授权设计，不属于可观测性。

## Consequences

- 每个受 Gateway 管理的运行时——包括从未打开插件管理器的空间与常驻 steward——在启动与每次变更后记录其组成，`/admin/plugins` 展示整个节点的实际加载状态。
- 没有上报的空间仍会出现，以明确标注的已保存期望组合呈现；两个数据源不会混淆。
- 上报失败在运行时侧降级为警告；管理视图显示最后一次已存观测及其时间戳，而不是空页。
- 内容放置的项目经其 node_content 卷上报与列出；harness 行以 `(organization_id, runtime_id)` 为键。
- 陈旧代次或不匹配的上报在所有者解析检查内以 409 拒绝；载荷大小由线上解析器与 1 MiB 请求体上限约束。

## Verification

- `gateway/tests/plugin-inventory.spec.ts` 覆盖线上校验、上报/列出往返、陈旧代次拒绝与未上报项目的期望态回退（PostgreSQL 套件）。
- `packages/boot/plugin-manager/tests/manager.spec.ts` 覆盖启动上报、变更后上报与存储不可达降级。
- `packages/context/gateway-execution/tests/plugin-management.spec.ts` 覆盖转发契约。
- `gateway/admin-ui/src/plugins/SpacesInventory.spec.tsx` 覆盖列出、展开、来源与阶段徽标、筛选与目标绑定。
