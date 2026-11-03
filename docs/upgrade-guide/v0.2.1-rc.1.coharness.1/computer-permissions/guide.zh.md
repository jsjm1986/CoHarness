---
kind: upgrade-guide
description: "电脑使用权与资源资格要求用户获准使用选定电脑。"
---

# 按电脑配置使用权与资格

[English](guide.md) | 中文

## 变更

Gateway 的账号／项目访问要求所在电脑的使用权。迁移保留现有个人空间电脑的授权；项目成员身份不授予电脑使用权。能力决定归属具体电脑。凭据、插件状态、执行记录及归档命令保留 Runtime UUID。模型回传凭据按 Runtime／电脑区分；计费和配额仍归属账号／项目。各电脑的账号路径及文档索引彼此独立。Admin 专用管理及所属清理保留原有权限。

## 迁移

1. 使用现有部署数据库配置运行 `npm run pg:migrate --prefix gateway`。迁移080拒绝没有实例分配的活跃属主保有已启用资格：恢复原分配，或明确关闭未分配资格，再重新运行。迁移084和086要求已保存插件配置及文档元数据保有原分配。重试前恢复这些分配；保留现有文件及 Session 代文件。
2. 沿用管理员会话及浏览器源站校验，读取 `GET /admin/api/users/<用户 ID>/computers`。通过 `PUT /admin/api/users/<用户 ID>/computers/<节点 UUID>` 提交 `enabled` 及所读取的十进制 `revision`，配置其他电脑。授权不分配 Runtime，也不授予项目成员身份。通过现有 Admin 端点及显式 `dshNode` 配置能力；资格、Session 确认和真实桌面独占彼此独立。
3. 一并升级所有 Gateway 和受管 Runtime。重新启动前，通过现有监督机制确认旧进程终止。已分配 Runtime 的凭据与签名请求凭证必须携带相同 UUID；只在一侧缺失会被拒绝。已接入电脑要求精确的有效启动连接及租约代次。重新连接不能恢复旧代次。保留仅用于清理的凭据及不确定资源占用。进程代次单调递增且允许跳号。
4. 保留现有个人 DSH_HOME 目录及账号偏好迁移来源。通过现有部署流程配置每台新增电脑的系统账号。私有 Profile、设置、Session 读取和监督进程名称使用已持久化的 Runtime 存储选择；工作文档仍归属账号／电脑。未分配历史记录不授权替代环境。用户列表消费者处理可为 null 的 `port` 及本机 `runtimeCount`。
5. 自定义组合提供 `GatewayDeps.computerAccess`，向执行服务提供节点 UUID、凭据复核和有界监听期限。本地使用 `scopeAccessMonitor`，转发使用原监听器。策略写入保留当前管理员。转发位置与空间 Cookie 修复一并组合。属主选择存在歧义时必须指定精确 Runtime；元数据读取不启动运行时。
6. 通过 `POST /admin/api/users/<id>/runtimes?dshNode=<节点 UUID>` 分配，携带新的 `requestId` UUID。保留它，用于查询 `/admin/api/runtime-allocations/<请求 UUID>` 或恢复准备中的分配。通过组织／账号策略及修订号校验配置分配限额。停止、重启和退役使用精确 UUID 及已审阅的代次；退役保留数据和回执。迁移094关闭无法定位的 Webhook 端点，需要明确重新绑定。参见[管理 API 参考](../../../../gateway/docs/node-agent/README.zh.md#runtime-isolation)。
7. 验证各电脑的权限、资源清理、文档索引及归档归属彼此独立。部署验收之前，转发继续关闭。完整备份保留原有要求：证明覆盖全部数据库节点；一台电脑的文件不能构成多电脑恢复集。

8. 随匹配的 Gateway 重新构建并部署用户端和 Admin 资源。受管浏览器链接使用 `/?dshRuntime=<UUID>`；其他标签页切换时，已有标签页保留自身目标。登录和必须设置密码时通过 `returnTo` 保留本地界面目标。停止页在重启表单和重定向中保留 `dshRuntime`；使用多个个人 Runtime 分配验证这一流程。应用 migration098 以保存工作区目录元数据。检查唯一个人入口及其电脑分组、选择固定电脑创建项目和按电脑权限筛选邀请用户。验证具体 Runtime 选择器，以及电脑元数据尚未获得时的会话文档上传。文档位置按账号和电脑归属，无需运行 Runtime；验证经预览的跨电脑复制，并撤销一台电脑的使用权限。参见[浏览器环境与文档位置](../../../../gateway/docs/node-agent/browser/README.zh.md)。
