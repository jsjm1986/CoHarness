# Agent Note: Gateway 本地文档 broker

Status: implemented

[English](2026-10-15-gateway-local-document-broker.md) | 中文

## 问题

文档是一个常驻的产品面，但此前每个面向作用域的浏览器操作——列表、预览、上传、回收站——都被代理进该作用域的运行时进程。空闲运行时三十分钟后被回收，因此打开文档面板要付出冷启动代价，而启动慢的插件可能把启动时间拖过就绪窗口，最终以可用性错误的形式暴露给用户。这种耦合是架构性的而非偶发的：`userdoc-local` 把文档以普通文件形式存放在 `<mount>/documents/` 下并以原子 rename 发布，但该文件系统只能通过一个正在运行的运行时 HTTP 端点访问。

## 决策

Gateway 通过 `LocalDocumentBroker`(`gateway/src/documents-local.ts`）自己服务文档路由。个人作用域解析为所有者的 `documents/` 目录；项目作用域解析为 `<projectPath>/documents`，并经过 `validateProjectRuntimePath`——与运行时启动时相同的包含校验。每个请求在任何文件系统访问之前仍要经过既有的作用域授权——读取要求成员身份，写入要求 `rw`，跨用户个人访问走管理员通道。

行为一致性来自共享代码而非重新实现。`dsh-userdoc-local` 导出 `LocalUserDocFs`——`LocalUserDocStore` 服务委托的无上下文文件系统引擎；broker 为每个文档根保留一个引擎，并随 Gateway 一起销毁。`dsh-host-userdoc-http` 导出 `handleUserDocHttp` 及 `UserDocHttpHost`、`UserDocRequest`、`UserDocResponse` 适配类型，使 broker 能在每个作用域根上运行运行时本体的路由表——列表、目录、内容、上传、文件夹、移动、回收、恢复、永久清理。内容下载带着运行时的响应头直接流式写入客户端响应；JSON 操作经内存响应捕获应答，其 body 通过运行时相同的路径脱敏。

目录集成走运行时调用的同一批处理器：broker 的 `gatewayRuntime` 门面把 `sync`、`authorize`、`history`、`overview` 和目录回调路由到 Gateway 自己的 PostgreSQL 处理器，变更权限携带按请求签发的签名 principal，在实例存活时附带其代次。由于底层存储是普通文件，Gateway 在运行时存活期间发布的文档会在运行时的下一次目录扫描中被读到，除引擎自身的原子发布外不需要额外的写序锁。

在未配置 broker 时，每条路由都保留运行时转发回退；活跃运行时内的 `/api/documents` 服务路径不变。跨作用域快照复制仍在运行时端点之间流式传输；只有其列表、上传和目录元数据改为本地处理。

## 曾考虑的替代方案

**重试与超时调参。** 更长的就绪窗口或请求重试只是掩盖冷启动，文档操作依然依赖进程可用性、插件健康和端口分配。

**运行时保温或登录预热。** 用内存换便利是倒置架构：文档是数据，为 N 个被浏览的作用域钉住 N 个运行时进程，等于用数 GB 内存服务文件系统读。

**独立文档守护进程。** 按作用域共享的文档进程可以集中同样的文件系统访问，但会引入第三种进程类型及其生命周期、端口分配和故障模式。Gateway 本来就终结文档请求且掌握每个作用域根，守护进程唯一能贡献的是该部署并不需要的隔离。

**只从 `document_catalog` 应答列表。** catalog 是同步索引而非存储本身；直接服务它会展示过期行、无法流式输出内容，还会制造语义不同的第二条读路径。broker 读取真实文件系统，catalog 只承担它已有的所有权与历史职责。

## 影响

任何已授权作用域上的浏览、上传与生命周期操作无需启动运行时即可完成；面板不会因作用域的运行时仅处于休眠而暴露 `INSTANCE_UNREACHABLE`。仅查看文档的访问在内存与冷启动上的开销降为零，启动慢的项目插件也脱离了文档可用性的依赖链。

Gateway 与运行时的并发写入通过存储层既有的原子 rename 与清单机制共用一个目录；没有跨进程锁，竞争失败会以命名冲突的形式干净报错而不会损坏状态。broker 必须始终处于与被替代的转发路径相同的授权、路径校验与脱敏规则之内——作用域检查仍是准入点，`publicDocumentBody` 负责把私有路径挡在浏览器 JSON 之外。

[索引分页与回收生命周期笔记](2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md)曾拒绝"不触碰字节、只改 catalog"的变更方案；本 broker 保留了该顺序，因为它先通过共享处理器修改真实文件，再由 catalog 记录结果。[可续传上传笔记](2026-08-25-resumable-user-document-upload.zh.md)的协议不变——Gateway 对本地引擎使用同一协议，而非把分片继续流式转发到运行时。

验证覆盖：不启动运行时的作用域列表、经异步校验完成的可续传上传、流式内容输出、个人与项目授权、catalog 同步与所有权检查、管理员生命周期访问、transfer 目录元数据，以及随 Gateway 关闭的 broker 销毁。
