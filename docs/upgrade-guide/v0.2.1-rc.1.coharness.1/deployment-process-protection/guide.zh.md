---
kind: upgrade-guide
description: 手动 release 激活和节点代理控制要求确认 Gateway 与 Runtime 已停止。
---

# 部署时保护运行中的工作

[English](guide.md) | 中文

## 变更

macOS `release-control.sh activate` 要求 Gateway 和 Runtime 已停止，并对照 PostgreSQL 实时迁移记录校验候选。失败候选可能仍持有工作时保留其选择。确认退出后，回滚要求备用版本与已安装的治理库和所配置的节点内容库迁移完全匹配。校验失败时保留候选选择并暂停自动启动。Windows 手动代理重启或移除要求精确任务归属及同安装内工作已停止。

## 迁移

1. 将更新后的 release 控制器安装在 release 目录之外。不要执行杀死 Runtime supervisor 或使用 `taskkill /T /F` 的旧脚本。
2. 按[部署手册](../../../../gateway/deploy/README.zh.md)进入维护模式，检查长任务和定时任务，确认停止，并在停止 Gateway 进程前暂停其自动启动。工作无法停止时，使用独立数据库、身份、目录和端口运行候选。
3. 安装更新后的稳定 `release-control.sh`。准备包含 `gateway/lib/release-schema-check.js` 的 release，并保留与升级后数据库兼容的备用版本。运行 `release-control.sh preflight`，再运行 `activate <candidate> [--rollback-target <compatible-release>]`。
4. 若因数据库兼容性拒绝回滚，保持维护状态并激活与已安装迁移匹配的版本。退出维护前检查 `status`、`/healthz` 和精确 release。
4. Windows 使用代理任务实际注册的脚本，暂停同安装内其他已启用任务，并确认 Gateway/Runtime 已停止，再执行 `-Restart` 或 `-Uninstall`。被拒绝的操作不修改任务或进程。不要以页面空闲或数据库不可用推断已经停止。
