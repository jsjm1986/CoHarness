# Agent Note: Stable document scope switching

Status: implemented

[English](2026-08-27-stable-document-scope-switching.md) | 中文

## Problem

冷启动或繁忙的项目 runtime 会让作用域列表等待 Gateway 授权、runtime readiness 和有界重试。管理器在请求期间用阻塞骨架替换可见列表，并允许已被替代的请求继续运行，因此缓慢或失败的切换看起来像空白面板，过期响应也会争抢界面状态。

## Decision

Documents 管理器在作用域、目录、分页或刷新读取进行期间保留最后一次已提交的列表。轻量刷新状态会标出待加载的目标；只有在首次列表尚未可用时才使用阻塞骨架。每个列表操作拥有一个 `AbortController` 并递增请求代际；开始新操作会取消旧操作，过期响应不能发布状态。读取远程作用域时会按作用域、目录、筛选和排序使用有界的内存页面或列表缓存，并在保留缓存行可见的同时重新校验。重新校验失败会保留缓存或之前的行并显示错误。无法接收取消信号的旧版元数据客户端也使用同一个有界列表缓存。

## Alternatives considered

**读取期间始终用骨架替换行。** 否决：冷项目的 runtime readiness 等待是可预期的，隐藏有效的已提交结果会把等待或可恢复错误变成空白面板。

**管理器打开时预热所有项目 runtime。** 否决：组织可能暴露很多项目，提前启动会为用户可能不会打开的作用域消耗进程和资源。

**只依赖请求代际而不取消请求。** 否决：代际检查能阻止过期响应发布，但不能停止用户已经替代的 runtime 启动、Gateway 工作或浏览器连接。

## Consequences

作用域切换仍可能需要等待目标 runtime readiness，但管理器会保持可用并报告待加载目标，不再清空列表。再次访问作用域时，可以先立即显示有界缓存页面，再刷新 Gateway 结果。缓存只包含元数据并按作用域隔离，达到容量上限时淘汰；变更操作会在重新校验前清空列表缓存。

如果初始 runtime 页面早于账户作用域发现返回，其短生命周期游标链会一直附着在当前请求上，直到作用域得到确认。因此分页可以继续进行，而不会把尚未确认的 runtime 结果写入某个作用域缓存。

## Verification

客户端组件测试覆盖切换等待期间保留可见行、取消被替代的请求、切换失败后保留行、复用已缓存作用域，以及作用域发现等待期间的游标分页。现有游标分页、移动端、样式和 HTTP 客户端测试继续通过。修改后的客户端聚合通过 TypeScript 检查。

## Related

- [文档作用域 runtime readiness 与安全 Provider projection](2026-08-26-document-scope-runtime-readiness.zh.md) — 负责 Gateway readiness 响应和幂等元数据重试。
- [文档索引分页与可恢复回收站](../architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md) — 负责游标分页和有界页面契约。
