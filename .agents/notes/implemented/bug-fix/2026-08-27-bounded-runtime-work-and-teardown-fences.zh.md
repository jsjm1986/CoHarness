# Agent Note: Bounded runtime work and teardown fences

Status: implemented

[English](2026-08-27-bounded-runtime-work-and-teardown-fences.md) | 中文

## Problem

Gateway 与 SDK 传输、提供方流、持久化写入器和文档 broker 可能在不受信任的对端或缓慢上游持续产出期间无限保留内存工作。若干异步所有者也会在 fiber、runtime 或 loader 条目开始 dispose（资源释放）后继续接纳新工作，因此迟到的完成可能泄漏子进程、重新挂载动态包，或在所有者离开后仍让请求存活。

## Decision

每个不受信任或节奏由外部控制的流，都在接纳点拥有一个正数上限。JSON-RPC 限制输入行字节数、待处理请求、并发入站处理器、输出缓冲、session 数量、提示词块数量和提示词字节数。DeepSeek 限制提供方错误体、未完成 SSE 帧、生成文本和流式工具参数。Code Mode、会话持久化与文档传输限制保留队列、计划和响应体。Gateway 代理操作拥有可配置的超时和响应字节上限。

运行时工作从授权开始一直持有 operation reference，直到响应最后一个字节完成，因此 idle 回收不会在活动请求下停止进程。就绪检查使用绑定启动 token、nonce 和精确运行时身份的 HMAC challenge。Settings 注册、客户端会话 scope、动态 Host/Client runner 和子进程所有者会在拆卸前关闭接纳，并等待已启动的工作；迟到的 loader 条目和进程树会获得显式清理。带 revision 的模型 projection 会在使用前刷新并异步重试，因此数据库变更已经提交时，不会仅因文件 projection 暂时不可用就被报告为事务失败。

运行时 lease 的接纳、活动 touch 和 idle 回收共享每个 runtime 的串行队列。若停止操作先赢得竞态，新 lease 会返回可重试拒绝；代理调用方启动新 generation，文档和归档 broker 则在不转发过期端口的情况下失败。Gateway 与 SDK 中由计时器驱动的配置会拒绝超过 Node 最大延迟的值。

文件系统和文档生命周期路径在每个破坏性操作或发布步骤重新检查真实路径包含关系和符号链接所有权。用户文档拥有由提供方持有的回收站生命周期、带元数据上限的分页和按保留期限清理。这些检查与[Gateway readiness](2026-08-26-document-scope-runtime-readiness.zh.md)、[会话写入批处理](../architecture/2026-08-08-bounded-session-persistence-write-batching.zh.md)和[子进程退出清理](2026-08-11-synchronous-subprocess-exit-cleanup.zh.md)等专门决策互相补充。

DeepSeek wire 转换器在修改状态前校验分片对象、usage 计数和有界工具调用元数据。Host 文档 Consumer 流式读取并限制 runtime JSON 响应，PostgreSQL overview 在 SQL 中筛选和分页，systemd 单元对 argv 字段进行显式转义。SDK 会释放完成的血缘和每会话锁映射；管理员永久清理文档必须确认，文档目录用户引用使用带企业范围的外键。

## Alternatives considered

**依赖一个进程级超时。** 不采用，因为传输分帧、提供方解析、持久化写入和文档流式 body 具有不同的进度与所有权语义；单一期限要么让队列无界，要么在没有释放所有者的情况下中止本来有效的慢工作。

**让垃圾回收或 Cordis dispose 自动发现迟到工作。** 不采用，因为两者都不能证明子进程、loader fiber、watcher 回调或响应体已经停止。接纳围栏和显式 join 让所有者负责达到完全停稳。

**只在浏览器或 SDK 边缘施加限制。** 不采用，因为 Gateway、runtime、提供方和持久化端点都可以独立调用；每个接纳边界都必须在保留超大或过量工作之前拒绝它。

## Consequences

超量工作会以稳定的本地错误或传输关闭失败，而不是无界增长内存。部署可以调整文档化的正数上限，协议常量和安全不变量保持固定。响应可能在已发送 header 后才超过预算并终止；取消流也可能留下外部副作用，具体协议明确不负责回滚。

拆卸会等待已接纳的工作，因此在配置 grace 内，协作式子进程或 watcher 需要多久，dispose 就可能等待多久。不合作的进程树仍使用本地提供方的同步退出兜底。已有专门 Agent Note 继续负责各自的 wire 格式和领域恢复规则。

## Verification

聚焦测试覆盖 Code Mode 调度器故障与队列准入、settings watcher 停稳与机密脱敏、动态 runner 超时与迟到条目移除、本地进程树终止、Gateway readiness 与响应预算、串行实例 lease、文档传输 lease 与回收站保留、JSON-RPC 与 SDK 队列／超时上限、DeepSeek 流与 wire 结构预算、持久化写入上限以及带 revision 的模型治理。TypeScript typecheck、合同 lint 和对应包测试均针对最新源码树执行。
