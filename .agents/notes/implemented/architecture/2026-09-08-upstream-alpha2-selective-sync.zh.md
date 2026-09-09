# Agent Note: 云端 CoHarness 对上游 alpha.2 的选择性同步

Status: implemented

[English](2026-09-08-upstream-alpha2-selective-sync.md) | 中文

## 问题

DSH v0.1.3-alpha.2 修改了提示词、Session、连接、subprocess、子代理、反馈和 Web 行为。CoHarness 的 Web Host 运行在云端，并且已经拥有 Gateway 授权、Workspace UI、反馈存储和多会话 Workbench，因此整仓文件合并会把桌面专用行为带入云端，并替换已有产品契约。
## 决定

CoHarness 按行为和能力 seam 同步 alpha.2。系统提示词 prefix/suffix、模型切换提示、pi-ai 0.85.1、live observation 懒加载、连接持续恢复、continuable 子代理人工控制、默认文件工具、定向 Windows 修复和普通 subprocess pid 移除跟随上游契约。现有 Workbench、Gateway、SQLite、Session generation 迁移和云端授权继续由本地实现负责。

上游 Open in App 包保留给桌面 Host 组合使用，但云端 Web bundle 不挂载它们。云端部署应使用未来的远程工作区桥接或复制路径操作；服务器启动器不能作为用户本机编辑器集成。

反馈继续使用 CoHarness sidecar、Gateway 授权、CAS 版本和现有数据。在线接受的变更另外记录显式 Session 反馈事件，使可选的 session-log 交付通道能够携带它们。普通聊天仍不参与反馈交付，OTel 继续显式启用。
## 考虑过的替代方案

**在云端 Web bundle 挂载 Open in App。** 否决：启动器会在服务器执行，用户无法看到本机应用，还可能暴露服务器路径或进程。

**用上游 Session 事件存储替换反馈 sidecar。** 否决：sidecar 是已经部署的数据和授权契约，已有记录不能要求迁移；事件记录作为交付兼容能力追加。

**继续公开 `SubprocessHandle.pid`。** 否决：普通进程身份属于 provider，公共 seam 不需要它；终端 handle 因为拥有不同的 provider 控制契约而保留 pid。

**整体引入上游 `ui-chat` 包。** 否决：CoHarness 的 `ui-conversation` 和 Workbench 拥有当前 slot、历史窗口和协作行为。
## 后果

本地架构能够表达的共享运行时行为与 alpha.2 保持一致。桌面打开能力成为明确的部署选择。现有反馈数据无需迁移即可继续读取。新增反馈事件要求同步生成 persistence catalog。依赖普通 pid 的公共 subprocess 消费者需要改用 provider 内部能力或 `waitForExit`/`done`。
