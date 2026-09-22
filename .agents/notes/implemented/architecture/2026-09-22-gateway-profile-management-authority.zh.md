# Agent Note: Gateway 的 profile 管理授权

Status: implemented

[English](2026-09-22-gateway-profile-management-authority.md) | 中文

## 问题

Profile 操作会在工作区沙箱之外安装并执行 Host 代码。工具审批表达对单次调用的同意，却不能证明组织管理员资格。直接 Remote 调用也完全不经过工具审批。

## 决策

[Plugin Manager](../../../../packages/boot/plugin-manager/README.zh.md) 在每个公开操作前检查部署授权，并在进入排队的写入或配置操作后再次检查。工具在请求审批前检查同一策略。独立本机 profile 保留本机操作者权限；Gateway 启动 patch 要求授权提供者，并将其声明为 Loader 依赖。提供者缺失不能恢复本机权限。

[Gateway Execution](../../../../packages/context/gateway-execution/README.zh.md) 拥有该提供者。交互调用要求仍在处理中的、不受用途限制的 HTTP 主体，并接受 Gateway 的实时管理员检查。Agent 发起的操作则检查真正 Agent 的[完整已验证参与者集合](2026-09-22-verified-execution-participants.zh.md)；每位贡献者都必须保留管理员权限。尚未过期的旧断言、浏览器角色或继承的异步请求上下文都不能保留已经撤销的角色。认证、执行授权、协作、治理和隔离条目不能被直接关闭或通过组合包替换，针对其父条目的 patch 也受保护。

该策略补充[当前 profile 管理](2026-09-14-current-profile-plugin-management.zh.md)；原有写锁、HMR 串行化和部分执行结果规则继续生效。服务不从模型文本或历史消息作者推断权限。缺少当前已验证执行授权或交互授权的操作会被拒绝。

安装和移除操作接受调用工具或 Typert 传输的取消信号，并将其传给拥有的包管理器进程。安装在进程结束后、profile 激活前重新检查授权。安装期间取消或失权会恢复捕获的 manifest 和锁文件；已下载文件可以保留。移除继续遵循管理器明确的部分执行结果规则，不声称能撤销已完成的卸载。

## 考虑过的替代方案

**只检查管理页面或 Remote 路由。** 工具和直接服务消费者仍能到达管理器。授权必须由读取或修改 profile 的操作执行。

**把 Full access 或单次审批当作管理员资格。** 它们控制会话内的工具执行，不代表组织授予安装 Host 代码的权限。

**在断言过期前一直信任其中的角色。** 排队的变更可能晚于角色撤销。实时成员检查保留 Gateway 当前的判定。

## 影响

受管 profile 访问依赖可达的 Gateway，以及操作真正发起人的当前管理员权限。失败会明确报告。排队操作在修改 profile 文件前重新检查权限，工具或传输取消会传到包管理器子进程。本机 CLI 操作者保留原有 profile 工作流程。提供者测试证明身份拒绝与 Gateway 实时成员检查；管理器的真实 Loader 测试负责排队写入、取消、profile 保护和 manifest 恢复的证据。
