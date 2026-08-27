# Agent Note: Stable document scope switching

Status: implemented

[English](2026-08-27-stable-document-scope-switching.md) | 中文

## Problem

冷启动或繁忙的项目 runtime 会让作用域列表等待 Gateway 授权、runtime readiness 和有界重试。每次访问作用域都重新请求最近刚获取的列表，会让用户在管理器已经持有可用元数据时仍感受到这段预期延迟。runtime 列表也可能早于账户上下文返回，此时作用域尚未确定；若在响应时直接归档或丢弃，可能造成跨作用域缓存污染或漏掉缓存条目。

## Decision

Documents 管理器在作用域、目录、分页或刷新读取进行期间保留最后一次已提交的列表。轻量刷新状态会标出待加载的目标；只有在首次列表尚未可用时才使用阻塞骨架。每个列表操作拥有一个 `AbortController` 并递增请求代际；开始新操作会取消旧操作，过期响应不能发布状态。

当前作用域和其他作用域读取共用按作用域、目录、筛选与排序索引的有界内存元数据缓存。条目在 30 秒内属于新鲜状态，切换时直接使用且不再发起列表请求。条目最多保留五分钟：旧条目会立即显示并由后台请求重新校验，校验失败仍保留这些行并显示错误；过期条目会被移除。显式刷新和文档变更会使列表缓存失效。缓存属于持续挂载的管理器，不含文档字节，也不会写入浏览器持久存储。

首次 runtime 列表会由当前请求持有，直到账户上下文确认其作用域。游标页面和旧版非分页响应都会在确认后进入按作用域隔离的缓存；上下文不可用时，临时列表只供当前请求使用。重新打开管理器会刷新账户上下文，但不会丢弃新鲜列表；若作用域身份变化，则加载新 runtime，不会继续使用原活动作用域的元数据。

Gateway 为指定作用域元数据转发使用 `HGW_UPSTREAM_TIMEOUT_MS`。上游停滞时返回 HTTP 504 和 `DOCUMENT_SCOPE_TIMEOUT`，并释放 runtime lease。成功的文档内容流不受元数据截止时间限制，并持续持有 lease 直到 EOF 或取消。

## Alternatives considered

**读取期间始终用骨架替换行。** 否决：冷项目的 runtime readiness 等待是可预期的，隐藏有效的已提交结果会把等待或可恢复错误变成空白面板。

**管理器打开时预热所有项目 runtime。** 否决：组织可能暴露很多项目，提前启动会为用户可能不会打开的作用域消耗进程和资源。

**只依赖请求代际而不取消请求。** 否决：代际检查能阻止过期响应发布，但不能停止用户已经替代的 runtime 启动、Gateway 工作或浏览器连接。

**把元数据持久化到本地存储。** 否决：文档名称和作用域成员关系不应在账户变化或浏览器刷新后脱离当前已认证页面生命周期继续保留。

## Consequences

首次访问冷 runtime 时，作用域切换仍可能等待其就绪；近期访问会直接从内存完成，旧缓存访问会在重新校验期间保留可用行。缓存容量、新鲜期、最大保留期、作用域键和变更失效共同限制内存占用与元数据生命周期。runtime 元数据响应停滞时会在配置的 Gateway 截止时间结束，不再无限占用浏览器请求和 runtime lease。

## Verification

客户端组件测试覆盖切换等待期间保留可见行、取消被替代的请求、失败后保留行、新鲜缓存不发请求、旧缓存后台校验、最大保留期淘汰、重新打开时账户作用域变化、早于作用域发现的旧版与游标响应，以及发现等待期间的游标分页。Gateway 测试分别让响应建立和 JSON body 读取停滞到元数据截止时间，并验证 504 错误码和成对的 runtime lease 调用。客户端与 Gateway TypeScript 检查覆盖修改后的聚合。

## Related

- [文档作用域 runtime readiness 与安全 Provider projection](2026-08-26-document-scope-runtime-readiness.zh.md) — 负责 Gateway readiness 响应和幂等元数据重试。
- [文档索引分页与可恢复回收站](../architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md) — 负责游标分页和有界页面契约。
