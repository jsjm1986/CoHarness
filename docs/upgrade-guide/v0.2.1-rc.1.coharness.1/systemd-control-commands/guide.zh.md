---
kind: upgrade-guide
description: "Systemctl 客户端具有可配置期限，响应启动取消，并排除 Gateway 凭据。"
---

# Systemctl 客户端具有有界生命周期

[English](guide.md) | 中文

## 变更

原生 systemctl 客户端使用 `HGW_SYSTEMD_COMMAND_TIMEOUT_MS`，默认 120000 毫秒；启动取消会关闭 daemon-reload 与 restart 客户端。此前这些命令可能无限等待。命令排除 Gateway 与凭据环境变量，并禁用密码提示和分页器。restart 失败保留其代次清理句柄；CLI 终止不证明 systemd 已停止 Runtime。

## 迁移

1. 按 Gateway 的[部署流程](../../../../gateway/README.zh.md)部署。服务操作需要其他期限时设置 `HGW_SYSTEMD_COMMAND_TIMEOUT_MS`；取值必须为正数，且不超过 2,147,483,647。
2. 自定义 `SystemdLauncherOptions` 必须提供 `commandTimeoutMs`。自定义 `run(args, signal)` 实现必须响应取消，并等待其持有的命令关闭。
3. 运行 `npm --prefix gateway run test:built-systemd-control`，用惰性夹具检查原生 CLI 所有权。另行在 Linux 部署验证真实服务启动与停止；停止失败会保留 Runtime 预留以便重试。详见[控制命令所有权](../../../../.agents/notes/implemented/bug-fix/2026-10-25-systemd-control-command-ownership.zh.md)。
