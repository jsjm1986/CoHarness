# Agent Note: Gateway 的 profile 管理授权

Status: implemented

[English](2026-09-22-gateway-profile-management-authority.md) | 中文

## 问题

Profile 操作会在工作区沙箱之外安装并执行 Host 代码。工具审批表达对单次调用的同意，却不能证明组织管理员资格。直接 Remote 调用也完全不经过工具审批。

## 决策

[Plugin Manager](../../../../packages/boot/plugin-manager/README.zh.md) 在每个公开操作前检查部署授权，并在进入排队的写入或配置操作后再次检查。工具在请求审批前检查同一策略。独立本机 profile 保留本机操作者权限；Gateway 启动 patch 要求授权提供者，并将其声明为 Loader 依赖。提供者缺失不能恢复本机权限。

[Gateway Runtime](../../../../packages/context/gateway-runtime/README.zh.md) 从已验证的请求上下文提供策略。缺失、用途受限或过期的主体会被拒绝。私有 Gateway API 再检查当前有效的管理员成员资格，因此尚未过期的旧断言不能保留已经撤销的角色。认证、协作、治理和隔离条目不能被直接关闭或通过组合包替换，针对其父条目的 patch 也受保护。

该策略补充[当前 profile 管理](2026-09-14-current-profile-plugin-management.zh.md)；原有写锁、HMR 串行化和部分执行结果规则继续生效。服务不从模型文本或历史消息作者推断权限。缺少当前已验证请求授权的操作会被拒绝。

## 考虑过的替代方案

**只检查管理页面或 Remote 路由。** 工具和直接服务消费者仍能到达管理器。授权必须由读取或修改 profile 的操作执行。

**把 Full access 或单次审批当作管理员资格。** 它们控制会话内的工具执行，不代表组织授予安装 Host 代码的权限。

**在断言过期前一直信任其中的角色。** 排队的变更可能晚于角色撤销。实时成员检查保留 Gateway 当前的判定。

## 影响

受管 profile 访问依赖可达的 Gateway 和当前管理员身份。请求局部授权缺失等失败都会明确报告。排队操作在修改 profile 文件前重新检查权限。本机 CLI 操作者保留原有 profile 工作流程。测试覆盖真实 Loader 管理的 profile、服务与工具拒绝、受保护的组合包 patch、提供者缺失、过期主体以及 Gateway 的实时成员判定。
