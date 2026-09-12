# Agent Note: 云端 Workspace 文件资源采用相对路径只读 RPC

Status: implemented

[English](2026-09-12-cloud-workspace-file-resources.md) | 中文

## Problem

远程浏览器需要查看已授权的云端 Workspace 文件，桌面应用启动无法交付这些内容。CoHarness 同时具有多个 runtime 连接、项目与私有 Session ACL，以及目录 grants；文件预览必须独立于 Agent 工具遵循这些规则。

## Decision

现有 ApiProxy 拥有 `workspaceFiles.list`、`stat`、`read` 和 `readBytes`。每个请求指明 Session 与相对路径。读取使用 live 或持久化 header，不实体化 Agent 或 Session 正文。Host 先解析 canonical containment，再检查路径各段、拒绝符号链接、执行 `workspace-files/authorize` 策略事件，并在返回响应前复核身份与授权。目录授权插件以原有 grants 消费该事件，任意 Session cwd 无法绕过目录授权。响应只携带相对路径和经哈希处理的 provider 版本标记。带版本保护的分页会拒绝读取期间被替换的文件。

本地字节窗口使用已打开的 descriptor、有界读取与版本复核。文本流在最后一次版本检查之后才释放 descriptor，包括分页消费方提前停止的情况。E2B adapter 只复制请求窗口并取消 SDK 流；SDK 仍会传输被跳过的前缀，并返回完整目录元数据。其读取前后元数据检查不具备本地 descriptor 的身份保证。

资源 provider 显式绑定 API client。Client key 包含 runtime 目标和 Session 相对地址；`base` 表示启动连接，不表示焦点面板。元数据记录受 Host 配置限制，共用读取，最后一个 pin 或 subscriber 释放后取消未完成请求。空闲记录可以淘汰，已保留的 source handle 仍可再次订阅。临时错误保留最后成功值，权限失效或 runtime 移除则清除它。预览内容只由视图持有。

Agent 观察通过现有 Host 流交付，发布前进行授权，文件资源不额外创建流。重连取消旧请求并复核元数据；版本变化会将预览标为 stale，直到显式重新加载。HTTP 失败保留状态码，与文件 RPC 错误分开。

Gateway 的访问变更 handler 在数据库操作提交后，关闭匹配的已接入通用代理响应与 WebSocket。该失效机制属于单个进程，其他 Gateway 进程和直接数据库变更仍依靠逐操作授权与 principal 到期；本变更未建立跨进程交付。

## Alternatives considered

**复制上游资源与 Session controller。** 隐式 current-Session 查询无法确定 CoHarness Workbench 面板所属的 runtime，现有 ApiProxy 与 runtime pool 继续拥有传输和生命周期。

**允许绝对地址或同源文件 HTTP 路由。** 二者都会扩大新 Session 相对协议之外的文件访问；可执行 HTML 还会共享已认证应用的 origin。

**将 Session 所有权当作文件授权。** 个人 Session 可以携带调用方选择的 cwd，因此目录授权插件必须独立检查文件访问。

**新增资源写入。** Agent 工具已拥有 CAS、审批、文件观察与审计；第二条写入路径会要求另一套冲突和授权模型。

## Consequences

Workbench 会为当前面板列出直接子项，打开文本分页，并为二进制文件回退到有界 Base64 窗口；它使用现有 slot 与有界资源 registry。User Documents 保留 catalog、传输和存储语义。本地应用交接要求 loopback 与 Host 明确声明能力；云端文件操作不能在服务器启动应用。

真实本地 provider 测试覆盖冷读取、路径拒绝、目录策略卸载、项目读取权限、读取中撤权、大小限制和版本变化。资源测试覆盖目标隔离、取消、淘汰、pin 与旧代次。完整浏览器撤权、Gateway PostgreSQL、E2B 传输测量、Windows descriptor 行为及生产回滚仍是[升级计划](../../../../upgrades/plans/UPGRADE-PLAN-dsh-v0.1.5-rc.2.md)中明确保留的验证缺口。
