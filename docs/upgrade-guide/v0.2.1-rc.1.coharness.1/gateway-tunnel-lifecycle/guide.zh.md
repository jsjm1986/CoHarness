---
kind: upgrade-guide
description: "受管隧道保留失败的关闭清理，命名配置从持久化标识继续。"
---

# 受管隧道保留清理与配置状态

[English](guide.md) | 中文

## 变更

隧道子进程排空输出，并排除 Gateway 部署凭据。选定的连接器令牌使用显式 `TUNNEL_TOKEN` 环境项，不会暴露在进程参数中。本地停止失败时报告 `502 tunnel-stop-unconfirmed` 并保留句柄；替换和清除等待确认关闭。关闭以 `503 tunnel-shutting-down` 拒绝新动作，并等待已接纳工作。命名配置规范化 DNS 输入，在破坏性工作前校验，并使用区域所属账号。创建隧道和获取连接器令牌是两个独立 Cloudflare 请求；令牌或配置失败时仍保留已确认的标识。

两种模式均等待私有注册证据。停止／清除以 `409 tunnel-start-cancelled` 取消此前接纳的启动，包括排队请求；关闭先取消注册，再等待 HTTP 写操作。`HGW_TUNNEL_STARTUP_TIMEOUT_MS` 默认 30000，`HGW_TUNNEL_CLOSE_TIMEOUT_MS` 默认 5000，`HGW_TUNNEL_PROBE_INTERVAL_MS` 默认 25。轮询间隔不能超过启动期限。编程调用 `spawnQuickTunnel`、`spawnNamedTunnel` 时传入显式启动选项，并立即取得所有权；发布可用状态前等待 `proc.ready`，终止成功前保留句柄。

取消还到达发现、版本探测、安装与 Cloudflare 请求。自定义 `resolveBinary` 和 `install` 实现会收到可选的 `AbortSignal`，等待外部工作时必须响应取消；`installCloudflared` 通过第三个参数接收该信号。原生辅助命令确认关闭。下载失败释放流并保留已安装二进制；发布使用在目标文件系统暂存并验证的可执行文件。关闭期间的管理读取报告 `503 tunnel-shutting-down`。

## 迁移

1. 替换 Gateway 产物前，通过部署页停止受管隧道。保留已有 PostgreSQL 隧道记录与 `HGW_TUNNEL_CREDENTIAL_KEY_FILE`；此变更无需数据库迁移。
2. 通过显式运行时配置提供负载设置；参见[子进程继承](../../../../gateway/README.zh.md#performance-and-runtime-admission)。连接器不会收到环境中的 Gateway 数据库和凭据变量。
3. 启动替代进程前重试失败的停止。令牌或入口配置失败后，再次执行启动命名隧道，以复用保留的标识。即使选择临时模式，清除仍会移除保留的命名资源。
4. 如果旧产物已经创建 Cloudflare 隧道却丢失标识，再次配置前先检查管理员的 Cloudflare 账号。外部创建响应丢失时，可能需要在提供方侧核对。参见[生命周期限制](../../../../.agents/notes/implemented/bug-fix/2026-10-25-gateway-tunnel-lifecycle.zh.md)。
