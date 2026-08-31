# Agent Note: Bounded runtime work and teardown fences

Status: implemented

[English](2026-08-27-bounded-runtime-work-and-teardown-fences.md) | 中文

## Problem

Gateway 与 SDK 传输、提供方流、持久化写入器和文档 broker 可能在不受信任的对端或缓慢上游持续产出期间无限保留内存工作。若干异步所有者也会在 fiber、runtime 或 loader 条目开始 dispose（资源释放）后继续接纳新工作，因此迟到的完成可能泄漏子进程、重新挂载动态包，或在所有者离开后仍让请求存活。

## Decision

每个不受信任或节奏由外部控制的流，都在接纳点拥有一个正数上限。JSON-RPC 限制输入行字节数、待处理请求、并发入站处理器、输出缓冲、session 数量、提示词块数量和提示词字节数；TypeScript 与 Python reader 会保留分片行，避免反复复制前缀。DeepSeek 限制提供方错误体、未完成 SSE 帧、生成文本和流式工具参数。Code Mode、会话持久化与文档传输限制保留队列、计划和响应体。Gateway 代理操作拥有可配置的超时和响应字节上限。

运行时工作从授权开始一直持有 operation reference，直到响应最后一个字节完成，因此 idle 回收不会在活动请求下停止进程。就绪检查使用绑定启动 token、nonce 和精确运行时身份的 HMAC challenge。Settings 注册、客户端会话 scope、动态 Host/Client runner 和子进程所有者会在拆卸前关闭接纳，并等待已启动的工作；迟到的 loader 条目和进程树会获得显式清理。带 revision 的模型 projection 会在使用前刷新并异步重试，因此数据库变更已经提交时，不会仅因文件 projection 暂时不可用就被报告为事务失败。

运行时 lease 的接纳、活动 touch 和 idle 回收共享每个 runtime 的串行队列。若停止操作先赢得竞态，新 lease 会返回可重试拒绝；代理调用方启动新 generation，文档和归档 broker 则在不转发过期端口的情况下失败。idle 回收会通过按 runtime 建立索引的谓词重新检查每个候选项，不再为每个候选项重复扫描完整的 idle 目录；lease 接纳会在按 generation 保存的引用映射之外维护每个 runtime 的 O(1) 汇总。Gateway 关闭时通过固定 worker pool 停止本地 runtime，不会一次为每个进程启动拆卸任务。Gateway 与 SDK 中由计时器驱动的配置会拒绝超过 Node 最大延迟的值。

JSONL 元数据读取会限制 header 字节数，并同时按重试次数与经过时间限制修订稳定性重试。Zstandard raw、load 与恢复读取会执行解压明文字节总预算；header 探测会按几何增长扩展输入缓冲区，而不是对每个分片重复拼接。

Workspace 归档枚举会先索引持久化 ID、谱系根和保留位置，再匹配已归档会话。运行时归档投影使用带 revision 的批次，并分别限制会话 ID、搜索记录、搜索字节数和每条索引文本；一个谱系跨批次时，最终根会话汇总会保留聚合消息数量，同时不改变文本记录。并发触发会合并为一次后续同步，命令响应会分页并持续取完，dispose 会中止并等待活动请求结束。清理成功后，被删除的会话树会在后续投影前从持久化归档集合移除，因此陈旧 ID 不会造成永久同步失败。Workspace 与 PostgreSQL 归档变更只接受非负安全整数 revision；到达 `Number.MAX_SAFE_INTEGER` 时拒绝变更，而不会发布重复值。个人归档读取器会在同步期间缓存标题，因此后续请求可以把每会话序号下限传给持久化，而不必重新读取所有前缀。Gateway 会话读取会在一个只读 `REPEATABLE READ` 事务内读取会话头、revision 和事件。

运行时归档同步器还会在带 generation 围栏的 LRU 中保留有界的标题、数量和搜索投影；连续的 live 事件会以常量队列工作扩展缓存会话，而序号缺口、标题事件或与异步读取竞争的事件只使对应会话失效，不能发布过期缓存数据。generation token 会随移除或淘汰的会话离开，不会形成无界的伴随映射。仅元数据的 transfer plan 另外携带进程、企业和操作者三级的数量及序列化字节额度；过期和提交会消费同一组索引计数，因此单个操作者不能用很长的文档 ID 占满进程 Map。

分离会话尾部缓存通过 `SessionPersistence.readRevision(id)`（并保留 `revision()` 兼容回退）校验，不列出每个持久化会话。第一方 JSONL、SQLite 与 Gateway 提供方会把该服务方法委托给按 id 的 revision 查询；Service Definition 为第三方提供方保留 `listSnapshots()` 回退。因此，缓存命中可以避免扫描目录，同时不削弱冷历史读取前后的 revision 复核。

可继续 subagent 物化会在创建或恢复 Agent 前，预留可配置的运行时全局及直接 parent Activation 配额。待处理物化与驻留 Activation 一起计数，回滚和最终 dispose 会释放确切配额；不活跃的持久化 child 会话不占用配额。[可继续 subagent 决策](../feature/2026-07-28-continuable-subagent-conversations.zh.md)规定驻留与容量语义。

文件系统和文档生命周期路径在每个破坏性操作或发布步骤重新检查真实路径包含关系和符号链接所有权。用户文档拥有由提供方持有的回收站生命周期、带元数据上限的分页和按保留期限清理。浏览器可续传上传元数据随服务端会话过期（旧记录使用有界兜底期限），并在两种存储后端中同时受记录数和序列化字节数限制。本地请求图片派生文件按访问时间执行带数量和字节上限的 TTL/LRU 清理，DeepSeek 适配器按固定批次准备这些文件，因此较慢的首项不会让已完成投影无限积累。这些检查与[Gateway readiness](2026-08-26-document-scope-runtime-readiness.zh.md)、[会话写入批处理](../architecture/2026-08-08-bounded-session-persistence-write-batching.zh.md)和[子进程退出清理](2026-08-11-synchronous-subprocess-exit-cleanup.zh.md)等专门决策互相补充。

DeepSeek wire 转换器在修改状态前校验分片对象、usage 计数和有界工具调用元数据。Host 文档 Consumer 流式读取并限制 runtime JSON 响应，PostgreSQL overview 在 SQL 中筛选和分页，systemd 单元对 argv 字段进行显式转义。归档 runtime-read 替换结果在覆盖索引数据前，会按 SQL 回退路径的相同子会话、事件和字节上限校验。SDK 会释放完成的血缘和每会话锁映射；管理员永久清理文档必须确认，文档目录用户引用使用带企业范围的外键。仅用于显示的客户端会话血缘投影使用迭代遍历，并设置固定的深度和展开节点上限；超过任一上限的摘要仍会以根行显示。

SDK 通知订阅会在带 head index 的 FIFO 中保存有界队列和等待者列表。投递与 close 语义保持不变，连续消费通知时不再移动整个保留尾部。浏览器 WebSocket 下行连接使用相同的 head index，并限制为 1,024 个 frame 和 8 MiB 突发数据；队列超限时关闭 socket，让 connection generation 重新连接。

LLM text-thinking、统一的 BlockAssembler 和 pi-ai 顺序缓冲区保留追加式分片，并在分类或块结束时合并，而不是反复复制累计前缀；提供方无关的 guard 也会增量检查待定 thinking 前缀，并在顺序积压超过固定分片数或字节安全上限时拒绝。大型构建期间的 profile 依赖发现和 Typert 可达性遍历使用相同的游标方式。

PostgreSQL 文档目录同步会在一次带作用域的更新和历史批处理中应用已校验的删除列表，避免每个删除文档各开一个事务，同时为旧提供方保留兼容回退。

PostgreSQL 项目邀请列表通过一次 join 查询返回全部已授权行，不再为每条邀请分别执行详情查询。

启动对账会在加锁完成首个可用端口分配后，通过一次 typed-array 语句批量插入缺失的项目 instance 行，项目 churn 不会让启动变成每个 runtime 一次数据库往返。

E2B collect 模式的输出尾部也使用带 head index 的分片队列，因此在远程回调高度碎片化时仍保持原有精确字节上限，不会产生 O(n²) 的 `shift()` 工作。

共享的 `TextRetainer` 也对 suffix 文本使用相同的游标方式；进程或 HTTP 分片高度碎片化时，tail 与 head-tail 保留仍有界，不会反复移动数组头部。

ACP prompt 重建与 spill-policy 文本扁平化也会保留文本分片并只合并一次，因此由许多小块组成的 prompt 或工具结果不会反复复制累计前缀。

按行的 terminal sanitizer 对每次 PTY 回调也使用分片累积，在转义序列切分输出时保持 prompt-tail 跟踪，同时避免字符串反复增长。

本地附件压缩限流器也会推进 FIFO 游标而不是移动等待列表，在大量排队突发下保持配置的图片工作并发上限。

工作线程 workflow 引擎使用 head cursor 推进并发等待者，在每个槽位释放时保持 FIFO 顺序而不移动保留的尾部。Subagent 冷列表在启动逐会话 inspection 前，会把接纳的候选限制为 10,000 个、序列化 session header 限制为 16 MiB；超过额度时返回稳定的容量错误，而不是保留无界的冷读取队列。本地用户文档清理间隔和任务终止记录保留间隔会拒绝超过 Node 最大计时器延迟的配置，防止溢出值变成一毫秒维护循环。

gateway-runtime 现在为内部 Consumer 提供统一的有字节预算 JSON reader；归档、协作和 PostgreSQL persistence 调用方会在 JSON 解析前取消超过各自领域上限的分块响应。Host SSE carrier 将分片 frame 文本以追加式片段保留，并在每个完整 frame 处合并一次，同时保留 8 MiB 的单 frame 上限。

Web 搜索提供方和 DeepSeek Files 客户端对成功及错误 JSON body 使用同一套严格字节计数，因此声明长度过大或分块增长的响应在解析前都不能超过配置上限。每个提供方都通过已校验的配置公开自己的响应预算。

Host API fetch 载体会在 envelope 和 value schema 解析前，对一元 JSON 响应施加 16 MiB（或调用方选择的）预算；其 SSE 分片预算保持独立。Gateway Admin 私有浏览器 API 也会对直接 JSON 调用施加相同的默认上限。

Gateway 推送发送方会在 Token 分类前把 FCM 和 JPush 错误 body 限制为 64 KiB，避免提供方失败保留无界诊断数据。

模型策略投影版本缓存最多保留最近 10,000 个主体/路径条目；淘汰只是性能缓存未命中，只会触发安全重写。

## Alternatives considered

**依赖一个进程级超时。** 不采用，因为传输分帧、提供方解析、持久化写入和文档流式 body 具有不同的进度与所有权语义；单一期限要么让队列无界，要么在没有释放所有者的情况下中止本来有效的慢工作。

**让垃圾回收或 Cordis dispose 自动发现迟到工作。** 不采用，因为两者都不能证明子进程、loader fiber、watcher 回调或响应体已经停止。接纳围栏和显式 join 让所有者负责达到完全停稳。

**只在浏览器或 SDK 边缘施加限制。** 不采用，因为 Gateway、runtime、提供方和持久化端点都可以独立调用；每个接纳边界都必须在保留超大或过量工作之前拒绝它。

**每个已归档事件后发送一个完整归档投影。** 不采用，因为运行时超过固定的会话或搜索上限后，payload 会整体失败，事件突发还会排队执行重复的全量日志扫描。可幂等重试的批次保留同一个 revision，有界合并最多接纳一次后续同步。

**通过列出所有会话 snapshot 校验一个分离尾部。** 不采用，因为缓存命中的工作量仍会随整个持久化目录增长。存储提供方已经拥有来源限定的按 id revision 原语，因此公开查询可以保留同一身份，又不执行无关发现工作。

**让归档 revision 继续使用普通 JavaScript 数值递增。** 不采用，因为超过安全整数范围后，加法不再保持单调。在最后一个精确值处失败，可以在不引入不兼容 wire 表示的前提下保留比较与确认语义。

## Consequences

超量工作会以稳定的本地错误或传输关闭失败，而不是无界增长内存。部署可以调整文档化的正数上限，协议常量和安全不变量保持固定。响应可能在已发送 header 后才超过预算并终止；取消流也可能留下外部副作用，具体协议明确不负责回滚。多批次归档同步失败时，派生索引可能保持不完整，直到相同 revision 重试；每个已接纳批次都可幂等重试，命令只在整次同步成功后执行。

拆卸会等待已接纳的工作，因此在配置 grace 内，协作式子进程或 watcher 需要多久，dispose 就可能等待多久。不合作的进程树仍使用本地提供方的同步退出兜底。已有专门 Agent Note 继续负责各自的 wire 格式和领域恢复规则。

## Verification

聚焦测试覆盖 Code Mode 调度器故障与队列准入、settings watcher 停稳与机密脱敏、动态 runner 超时与迟到条目移除、本地进程树终止、Gateway readiness 与响应预算、串行实例 lease、文档传输 lease 与回收站保留、有界浏览器上传元数据、JSON-RPC 与 SDK 队列／超时上限、DeepSeek 流与 wire 结构预算、持久化写入上限和按 id revision、带 revision 的模型治理、有界客户端血缘遍历、分离历史缓存校验、安全整数归档 revision 耗尽、可继续 Activation 配额的准入与释放、分批归档同步与读取序号下限，以及可重复读会话加载。TypeScript typecheck、合同 lint 和对应包测试均针对最新源码树执行。
