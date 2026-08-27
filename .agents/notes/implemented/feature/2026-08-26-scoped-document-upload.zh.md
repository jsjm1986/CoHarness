# Agent Note: Target-scope document uploads

Status: implemented

[English](2026-08-26-scoped-document-upload.md) | 中文

## Problem

Web 文档管理器可以把其他已授权作用域作为元数据显示出来，但上传路由始终跟随当前运行时作用域。切换全局协作作用域会刷新页面并改变对话运行时，而向只读来源上传会破坏作用域权限语义。

## Decision

Gateway 在 `/api/documents/transfer/uploads` 下提供独立的可续传上传子树。浏览器在每个请求中携带紧凑的 `scope=personal` 或 `scope=project:<id>` query。Gateway 解析所选运行时，在每个生命周期请求中重新检查项目 `rw` 权限，签发目标运行时 principal，并在不缓存整个文件的情况下转发元数据和分片字节。会话响应只包含安全元数据；绝对路径和回环地址会被移除。

共享浏览器上传器接受请求 query 和恢复命名空间。命名空间参与 IndexedDB/localStorage 恢复键，因此同一个浏览器文件可以在多个文档作用域中独立续传。现有当前运行时上传继续使用原有路由和行为。

文档管理器把所选的非当前作用域视为上传目标，不改变当前对话。完整的已授权作用域浏览和回收站生命周期由[文档索引分页与可恢复回收站](../architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md)记录；本记录继续负责独立的可续传上传路由及其逐请求写权限检查。只读项目继续显示并明确禁用上传，全部作用域汇总视图必须先选择明确的可写目标。

这项决定扩展了[跨作用域文档快照](2026-08-23-cross-scope-document-snapshots.zh.md)和[用户文档可续传上传](../architecture/2026-08-25-resumable-user-document-upload.zh.md)中记录的决定；它们关于复制和当前运行时存储的保证保持不变。

## Alternatives considered

**切换全局协作作用域。** 放弃，因为 `/account/api/scope` 会刷新页面，并为一个文档操作改变当前对话运行时。

**先上传到当前运行时再复制临时文档。** 放弃，因为这会产生中间文件，在当前作用域只读时失败，还会增加清理和溯源复杂度。

**把所选运行时的上传端口或路径暴露给浏览器。** 放弃，因为运行时权限和文件系统路径属于 Gateway 私有事实；Gateway broker 已经提供了经过认证的 loopback 转发。

**上传时切换当前对话作用域。** 放弃，因为 `/account/api/scope` 会刷新页面并改变打开对话所使用的运行时；独立上传路由让文档操作保持在所选目标内。

## Consequences

目标上传不会刷新 Web 页面，并且可以按需启动项目运行时。每个上传请求都会执行授权查询，因此进行中的会话会立即感知成员权限变化。目标上传写入目标作用域根目录；当前作用域的文件夹上传继续遵循面包屑。Gateway 不新增数据库状态，但部署必须先提供目标上传路由，再发布调用它的客户端。
