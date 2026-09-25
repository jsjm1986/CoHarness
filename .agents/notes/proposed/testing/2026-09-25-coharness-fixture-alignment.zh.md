# Agent Note：CoHarness 夹具对齐

Status: proposed

[English](2026-09-25-coharness-fixture-alignment.md) | 中文

## 问题

CoHarness 具有更新的 Session writer、Gateway 授权、额外的资源身份及自身产品构建。仅通过上游夹具准入，不能证明这些消费者保持了行为。宽泛的身份和提示词归一化还可能隐藏回放本应拒绝的变化。

## 提案

复用固定上游的 Session 快照基础，保留各接口的控制器。只有所有者写入录制输入；借用者只读回放。父子记录共用身份映射。任意业务标识、期限、引号、系统提示词和工具 schema 均保持可比较。Python 不依赖 Node，自行实现相同规则；共享的正反例数据检测实现差异。

分别处理物理代次、历史迁移输入、当前 writer 期望及数据库方言样本。语料政策允许保留十三个历史角色，并要求当前 writer 角色占多数。政策检查失败会阻止验收；复制上游 v3 录制内容不代表已完成本地 writer 迁移。只有真实应用执行可以生成后继代次，刷新时保留独立的最终工作区断言。

两个 SDK 和打包运行均使用发行的 `dsh` 运行 profile。构建 profile 单独处理：CoHarness 证据必须标识 `coharness`，`official` 保留为独立兼容目标。验证方独立于待验报告选择所需 profile。回放在启动子进程前剔除继承的凭据；真实验证使用显式模式。

每个网络夹具原子绑定监听器。验证 Gateway 固定端点分配的测试使用其持有的 TCP 转发监听器，将请求转发到真实子进程动态绑定的地址。InstanceManager、LocalLauncher、签名就绪检查及 HTTP/WebSocket 转发继续接受验证。清理等待子进程退出，并关闭全部转发连接及升级后的套接字。

这些变化保留[上游语料决策](../../implemented/testing/2026-08-24-session-log-snapshot-corpus.zh.md)、[单文件发行决策](../../implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.zh.md)和[客户端构建环境决策](../../implemented/architecture/2026-08-18-client-build-environment.zh.md)的依据。[临时夹具迁移器提案](../process/2026-07-26-remove-packed-session-fixture-migrator.zh.md)继续有效，直到全部消费者都有明确的夹具用途及替代检查。

节点本地的[工作区依赖安装器](../../../../packages/boot/workspace-dependencies/README.zh.md)承接 alpha.2 桌面载荷，但不要求桌面应用。既有 computer-use 资格、确认和租约保留原有所有者。固定构建输入覆盖 macOS、Windows 和 Linux；本机执行与路径迁移验证独立于异平台组装。工具在安装前拒绝无法映射路径的执行目标，不授予命令或桌面权限。刷新期间提示词别名保持只读；ACP 的额外编辑器工具需要独立 schema 期望，不能改写 headless 所有者的 schema。

回放模型目录显式声明路由图片 token 计价及历史内提示词更新。刷新在复用旧易变值前使用完整日志的身份映射，并在写入前校验生成的 Session。压缩生命周期标记与检查点来源保留同一身份；关联变化不能通过比较。

## 考虑过的替代方案

**放宽比较直至导入的录制内容通过。** 这可能合并无关身份、抹去缺失指令，或接受过时的 writer。应修复消费者，或审查其行为差异。

**一次替换全部夹具。** 这会丢失本地断言和历史证据。只有替代入口通过且验证归属对账完成，才切换所有权。

## 验收标准

- 真实命令拒绝失效引用、缺失提示词、变化的 schema、错误身份、不支持的代次及错误构建 profile。
- 当前 writer、历史读取、打包执行和数据库迁移分别具备证据。
- 每个场景都有实际执行的所有者；刷新不能修改历史输入或独立工作区期望。
- 两批代表性集成验证通过，不存在未解释的遗漏、重复执行或断言弱化。

## 风险

`pnpm deploy --legacy` 可能调整工作区依赖链接。部署与源码消费者必须串行运行，或使用独立检出目录。本机可执行文件构建成功，不能证明其他平台或安装后 wheel 行为。本提案在全部语料和必需环境通过之前仍为部分实施；个别检查通过不代表完成该义务。
