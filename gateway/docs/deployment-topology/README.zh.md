---
description: "组织部署模式、浏览器入口范围与电脑的显式接入。"
---

# 部署模式与电脑连接

[English](README.md) | 中文

## 概述

同一组织在 PostgreSQL 中保存部署模式、主入口电脑、主入口地址和十进制修订号。新组织默认单电脑模式，继续支持多用户、多个个人 Runtime 和项目协作。每个项目仍固定在一台电脑，电脑使用权和现有 Runtime 身份继续有效。

## 入口范围

| 模式与入口 | 可访问资源 | 界面 |
| --- | --- | --- |
| 单机 | 仅本机 | 沿用个人空间、工作区和文档布局，不显示电脑标签或选择 |
| 多电脑，主入口 | 本机与已授权受管电脑 | 统一个人入口、电脑分组、轻量标识和项目位置选择 |
| 多电脑，其他入口 | 仅本机 | 显示当前电脑，不提供跨电脑选择 |

`GET /account/api/deployment/context` 在转发 Runtime 前返回浏览器入口的策略。`entry`、`primary`、`scope`、`role`、`revision` 和 `refreshAfterMs` 描述浏览器实际访问的 Gateway，与选中的 Runtime 分离。本机入口拒绝明确或解析出的远程电脑、Runtime、项目、文档和 WebSocket 目标，不替换成本机资源。目录在分页前过滤可见范围，电脑数量不决定模式。浏览器的后备图标请求（`GET/HEAD /favicon.ico`）由 Gateway 直接返回，不解析或启动 Runtime。

策略变化时，浏览器文档保留当前选择、草稿和未保存表单，已捕获的远程目标显示不可用。同源标签页只发送修订号失效通知，重新读取策略，不交换当前选择或草稿。可见页面按 `HGW_DEPLOYMENT_CONTEXT_REFRESH_MS` 刷新，默认30000毫秒，并在聚焦时刷新。后端立即使用 PostgreSQL 中的当前策略。入口元数据读取沿用连接配置的就绪超时和最大重试间隔，不启动 Runtime。

## 管理与配置

部署页沿用现有 Gateway 配置、公开访问和服务控制。在预期的主入口启用多电脑，填写已配置在 `HGW_PUBLIC_ORIGINS` 中的地址。主入口仍可运行本机 Runtime。其他电脑保留自己的 Gateway 地址，通过现有来源配置同时允许本机和主入口的浏览器来源。

Admin 中的项目模型分配、项目额度、项目用量和成员贡献报表，均跟随当前浏览器文档选择的电脑。带主入口电脑编号的链接使用选择器中具名的主入口选项，链接的管理目标保持不变。组织模型 Provider、角色／用户模型权限、角色／用户额度及组织总用量由主入口统一管理，不依赖当前选择的电脑。读取这些设置不会启动项目 Runtime。

Admin 部署页先加载入口策略，再加载状态与备份快照，同一时刻只保留一轮状态与备份读取，定时触发不叠加请求，页面卸载时取消读取。已有读取未结束时，显式刷新等待其后的新快照。入口模式元数据与用户端使用同一账号读取接口，配置写入继续核验管理员权限。

1. 在另一台电脑部署相同项目发布，使用同一组织数据库和部署已有的加密密钥。通过现有部署流程准备本地目录和所需服务。
2. 在主入口添加已部署电脑，或预登记新电脑名称。同组织电脑复用原组织和节点身份。一次性接入码只预留接入，不改变本机运行授权。
3. 打开该电脑自己的部署页，在“连接到主入口”填写中心地址和接入码。保存私有配置，核对允许来源；需要时按现有流程保存并应用配置，再启动已安装的接入服务。生成的代理配置绑定预期组织和电脑，服务连接核验 Gateway 身份和发布版本。
4. 确认主入口列表显示连接，再使用现有 Admin 功能配置电脑使用权、能力资格和 Runtime。项目邀请要求用户具备项目所在电脑的使用权限。

向导不安装软件，也不分发数据库凭据或主密钥。单独安装经过核对的 [Linux 服务](../../deploy/harness-node-agent.service) 或 [macOS LaunchAgent](../../deploy/macos/node-agent.plist)，使其操作系统账号、不可变发布路径、`HGW_STATE_ROOT` 和 `HGW_NODE_CONNECTION_FILE` 与 Gateway 一致。Linux 默认使用 `harness-node-agent.service`，可通过 `HGW_NODE_AGENT_SERVICE` 设置；macOS 默认使用 `com.maycran.harness-node-agent`，可通过 `HGW_NODE_AGENT_LABEL` 和 `HGW_LAUNCHD_DOMAIN` 设置。服务运行 `node lib/node-agent-main.js`，加载前需调整模板路径。Windows 通过[计划任务模板](../../deploy/windows/node-agent-task.ps1)注册同一编译入口：`HarnessNodeAgent` 任务（`HGW_NODE_AGENT_SERVICE`）开机即以 SYSTEM 身份运行并在失败时重启，读取同一私有配置文件并追加独立日志。缺少服务或来源配置时，页面显示准备步骤。

`HGW_NODE_CONNECTION_FILE` 默认位于 `<HGW_STATE_ROOT>/node-connection.json`。该私有文件保存修订号、准确电脑身份、主入口地址、本机回环 Gateway 地址、凭证文件路径及待消费接入码，仅文件属主及 SYSTEM、Administrators 可访问（macOS/Linux 为 0600 权限，Windows 为限定 ACL），采用原子写入，接入后清除接入码。重新接入使用新的凭证文件路径。接入码不写入 URL、命令参数或浏览器持久存储，节点代理不需要数据库凭据。没有私有配置文件时，仍可使用现有环境变量配置代理。

## 转换与恢复

接入状态为 `pending`、`managed` 或 `detached`；目录另外区分已连接、断开和已撤销的受管凭据。正式接入和退出受管状态都要求 Runtime 已确认停止，并且没有进行中的服务传输。离线或未知状态不能证明停止。主入口暂停新传输准入后提交退出，撤销凭据和租约，并关闭旧控制连接。文件、电脑授权、项目成员及 Runtime 身份保留。退出后的电脑以新进程代次独立运行，不依赖旧受管租约。重新开启模式不会自动接回电脑。

只有所有保留登记都已退出接入，主入口才可关闭聚合，已取消的待接入登记也需处理。模式更新和接入变更在组织策略行上串行化并比较修订号，主入口本机任务不受影响。更换主入口采用“退出接入→旧主入口关闭→新主入口直接启用→明确重新接入”，不支持运行中的主入口迁移。

迁移101保留历史受管执行授权，要求原转发 Gateway 在 Admin 明确初始化主入口身份。其原有的 `HGW_NODE_SERVICE_FORWARDING=on` 标识可执行兼容初始化的入口；该变量不能覆盖已保存的组织策略。用户元数据接口提示需要初始化。新部署不需要转发变量。参见[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/deployment-modes/guide.zh.md)。

数据库恢复保留目标部署当前的拓扑、代理和接入记录，使旧连接代次失效，并将本机连接控制文件排除在应用数据快照之外。备份不能换主入口、开启聚合或恢复旧授权。接入记录保留真实签发者 UUID 作为历史信息，即使恢复的应用数据中不存在该账号；签发仍要求当前组织管理员。迁移102之前的数据库备份需先在隔离恢复部署中升级，才能替换当前应用数据。现有完整备份检查仍要求覆盖所有数据库电脑的文件，本机备份不能证明多电脑数据覆盖。

<a id="api-reference"></a>

## API 参考

| 接口 | 用途 |
| --- | --- |
| `GET/PUT /admin/api/deployment/topology` | 读取入口策略，PUT 使用 `{ revision, enabled, primaryOrigin? }` |
| `GET /admin/api/deployment/topology/preflight` | 精确阻塞数量与有界电脑元数据 |
| `GET /admin/api/deployment/topology/candidates` | 已部署身份的有界列表，可选 UUID `cursor` |
| `GET/POST /admin/api/deployment/node-connection` | 无凭据的本机配置状态；POST 使用带 `values` 的 `save`，或 `start` |
| `POST /admin/api/deployment/nodes/access/<UUID>` | 现有修订号校验操作，以及 `detach` |

变更重新核验当前管理员权限，保留修订号检查并写入不含秘密的审计记录。节点接入与资源权限接口见[节点参考](../node-agent/README.zh.md)。此配置不包含独立部署导入、数据库拆分、自动安装或新增 Windows 执行能力。
