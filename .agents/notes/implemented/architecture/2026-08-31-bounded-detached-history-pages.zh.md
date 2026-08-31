# Agent Note: 有界 detached 历史分页

Status: implemented

[English](2026-08-31-bounded-detached-history-pages.md) | 中文

## Problem

冷 `session.history` 请求会在 Host 执行消息和 wire 分页前实体化整个 detached 事件日志。大型项目对话因此会在浏览器收到第一页前消耗数据库、JSON、堆内存和 Gateway 响应预算，真实容量失败最终被包装成不透明的 internal 错误。

## Decision

`SessionPersistence` 暴露 `readHeader`、`readRevision` 和 `readPage`。页面具有明确的字节、事件和组数限制，不透明 cursor 绑定会话、源 revision 与读取方向。追加或修复会改变 revision 并使 cursor 失效。提供方把有界读取失败区分为 `too-large`、`aborted`、`timeout`、`dependency` 和 `protocol`。

PostgreSQL conversation repository 使用只读 repeatable-read 事务和 `(session_id, seq)` keyset 索引实现 `readHeader` 与 `readPage`。查询只在结果列中把 bigint 序号转换为文本，并在 `ORDER BY` 中限定底层 bigint 列，保持 keyset 的数值顺序。Gateway runtime 暴露元数据和分页 endpoint，在缓冲内部请求 body 前完成认证，应用响应预算并保留有类型的分页失败。没有带索引分页方法的兼容 repository 保留原有完整读取路径。

Host 对冷 session 和 subagent history 使用带索引的页面，只沿 revision 绑定的 older cursor 读取到覆盖请求消息窗口为止，让一次 detached 常规窗口低于 4 MiB，并在累计 512 MiB 或 1,024 次分页时 fail closed。Host 会在呈现页面前校验 continuation 元数据、字节统计和相邻序号范围。公共 RPC envelope 仍为 `{ events, hasMore, projections?, omittedSpans? }`；cursor 细节留在 persistence 与 Gateway 层。detached projection baseline 在可用时使用经过身份校验的 projection cache，兼容 inspection 可以折叠其完整事件区间。请求取消会传到分页读取和 response body 解码，并映射为现有 `cancelled` RPC 结果；其他有类型失败使用按类别区分的安全消息，同时在 Host 日志中保留诊断。

启用 preset roster 时，带索引的冷读取还会只遍历 blank 前缀以恢复日志中的 `agent-preset/selected` 事实，在遇到首个可见对话事件或达到小型前缀预算后停止。这样无需重新打开完整事件日志也能保持 presenter 选择；前缀不可用时降级到 header／全局 presenter。

浏览器 runtime 将 reconnect 后的历史重建限制为最多四个并发会话，并优先当前可见会话。空闲且处于舞台的阅读器接近顶部时会请求一页更早历史；可见控件在自动读取失败或触及上限时保留为无障碍重试入口。Session scope dispose 会取消未完成的 open 或 history 操作并注销订阅。HTTP carrier 在外层 Node bridge 与内层 Fetch parser 使用同一请求 body 上限，response reader 也可响应调用方取消。Gateway 生产 release 现在把 Gateway 源码图编译到 `gateway/lib/index.js`；systemd 与 launchd 通过纯 Node 执行该产物，`tsx` 入口只保留给开发。

Composer scope dispose 现在也会取消进行中的附件编码，命令图片序列化会接收提交尝试信号，因此放弃大型 payload 后不会继续进行 base64 工作。

支持取消的等待器会在注册监听器后再次检查信号；最后一个放弃等待器会取消 response reader 及共享的附件／文件工作，并在所有结算路径释放监听器。Session 和 manager dispose 也会在排队的 history fill 启动前使其失效。

带索引的 header 读取还会在冷 resume 执行重建记录组合所需的完整 inspection 前完成 ownership 与 cwd 校验。生产打包现在会创建编译 ESM 导入所需的 release 内 Gateway 包链接，macOS controller 仅为回滚保留旧源码入口回退。

后续首次引导密码通过仅所有者可读的一次性文件交付，不再插入 Gateway 日志。既有部署的凭据保持不变，需由运维人员自行轮换。

## Alternatives considered

**保留完整 inspection，只依赖 Fetch chunk 打包。** 否决，因为打包只会在 Host 已经加载并序列化完整日志后减少 wire 字节，无法限制数据库读取或 Host 内存。

**把 persistence cursor 暴露到公共浏览器 history contract。** 否决，因为现有 `beforeSeq` 与 `maxMessages` envelope 已足够支持浏览器分页，而后端 cursor 格式和 revision 身份应由提供方拥有。

**从持久存储中删除历史 assistant chunk。** 否决，因为 Trajectory、中断恢复、回放和模型历史仍需要无损事件日志。现有 conversation-history tier 仍然只是传输投影。

## Consequences

Gateway 冷历史现在读取有界的带索引区间，不会因普通大型会话跨过 64 MiB runtime 响应上限。单个超过页面预算的事件会以稳定安全消息 fail closed；源发生变化时 continuation 会失效，不会混合两个 revision。Gateway 提供方的 write-behind 默认上限为 48 MiB，为 64 MiB 请求上限预留 envelope 空间。无法 seek 的提供方仍有兼容回退，因此使用顺序存储的部署在增加索引实现前保留原有读取成本。

通过 wire-level cancel protocol 的 PostgreSQL 查询取消、segment 压缩表、批量 `COPY` 追加、完整观测 dashboard、迁移演练、WebSocket principal 续期、Chat 列表窗口化、持久化失败 admission 栅栏、凭据轮换以及生产 canary／回滚执行仍属于部署工作；本次变更不修改生产数据，也不执行迁移。公共 RPC 错误 schema 对取消之外的有类型 history 失败仍使用 `internal`，专用本地化错误码需要另一次协调协议变更。

## Verification

Host 聚焦测试证明大型 detached history 使用 `readPage` 而不调用 `inspect`；persistence 测试覆盖 cursor 的方向／会话／revision 绑定、字节／事件／组数限制、不可分割超大事件和取消；Gateway 测试覆盖带索引 keyset 页面、cursor 失效、runtime 分页响应、body 读取前认证和 supervisor survivor 重连。Client 测试覆盖 assistant 增量累加、reconnect resync admission、scope dispose、response body 取消和 listener 清理。`pnpm run typecheck`、Gateway 产物／类型检查、export-JSDoc、契约 lint 及受影响 Vitest 套件已在源码树通过。
