# Agent Note: 带世代围栏读取的权限目录目录器

Status: implemented

[English](2026-09-24-permission-catalog-mirror.md) | 中文

## Problem

过去每个需要宿主权限预设目录的客户端界面各自拉取，并发消费方发出重复远端调用，而且在宿主侧变更前发出的响应仍可能把过期结果覆盖到更新的读取之上。随之而来还有两个更深的缺陷：被取代的响应仍会返回给命令式选择器调用方，打开的菜单可能展示宿主已撤下的选项；单一共享镜像服务所有池化 runtime，绑定到项目 runtime 的会话读到的是根连接的目录而非自己宿主的目录。

## Decision

客户端运行时的 [`PermissionCatalogDirectory`](../../../../packages/client/runtime/src/client/permission-catalog.ts) 为每个池化 runtime 连接各持有一个 `PermissionCatalogMirror`，按解析出的 `ConnectionHandle` 键控。`forSession(id)` 返回会话作用域门面，经 `connection.forSession` 解析所属 runtime，在会话归属重新发布时重绑，并暴露值快照、失效通道与命令式 `read()`。门面仅在持有监听者时附着到镜像，空闲会话从不拉取。

每个镜像在同一纪元内共享一次在途拉取：`read()` 等待当前拉取且只返回当前世代的值——被更新失效取代的响应会被丢弃，既不安装也不返回。`subscribeInvalidations` 在替换读取落定前每次失效发布一次刻度，持有已展示选项的消费方据此撤下选项而非信任保留值。`permission-presets/catalog-changed` 转发在各连接的帧汇聚点通过 `invalidateFor(connection)` 归属；每个镜像订阅自己连接的 `hostDescription`——撤回或替换即世代边界，先清空目录再重拉，因为新世代可能指向目录无关的另一个宿主。dispose 收回写权限，迟到的结算不能让已拆除的作用域复活。

## Alternatives considered

**让每个消费方按需拉取。** 重复调用会复现，也没有能识别过期响应的共享点。

**用 TTL 缓存。** TTL 无法区分"宿主目录未变"与"连接切到另一宿主"，过期时机也与宿主已发布的真实失效事件无关。

**按到达顺序安装每个完成的拉取。** 最后落地的响应胜出而不论发出先后，旧目录可能覆盖新目录——这正是纪元号要拒绝的缺陷。

**全进程共享一份目录。** 仅当所有会话共用同一宿主时成立；池化 runtime 拓扑让每个项目 runtime 拥有自己的连接，因而拥有自己的目录。

## Consequences

选择器与设置界面在每个 runtime 的每次失效间共享一次在途拉取，与失效赛跑的命令式读取会结算在替换值而非过期响应上。即使会话在其消费方订阅后才被索引，会话作用域门面也保持按 runtime 路由的正确性。目录器信任已归属的 `catalog-changed` 转发与各连接的世代边界作为其完整失效集合；新的失效来源必须在投递连接上调用 `invalidateFor`，而不是直接安装值。
