# 当前节点配置

[English](README.md) | 中文

## 概述

本参考说明 `/admin` → 部署与迁移 → 当前节点配置，以及独立的本机应用器。配置属于服务器确认的组织与节点。保存产生待审查候选，应用是单独的管理员操作。凭据保留在私有文件中，不返回浏览器。

## 目录

- [设置与应用](#settings-and-application)
- [安装独立工作进程](#install-the-independent-worker)
- [本机恢复](#local-recovery)
- [数据与验证](#data-and-verification)

<a id="settings-and-application"></a>
## 设置与应用

[字段定义](../../src/node-config-fields.ts) 负责可编辑的端口、公开 origin、受管路径、凭据位置、实例生命周期及 Linux 资源限制。每个字段显示生效值、来源、单位和前提。Gateway 监听地址保持仅回环。节点身份、鉴权、隔离、可执行文件路径及 shell 命令不属于可编辑字段。

`HGW_NODE_CONFIG_FILE` 指定私有 JSON 文件，默认位于启动器 `HGW_STATE_ROOT` 下的 `node-config.json`。文件位置属于引导配置，与表单独立。文件保存期望值、生效值、上一可用值、配置代次及当前操作。`GET /admin/api/deployment/configuration` 分别报告在服进程实际使用的值与已保存值。并发或错节点提交会失败，不覆盖他人的编辑。

选择**应用并重启**前，进入维护窗口并停止全部个人与项目实例。停止实例会中断其运行任务和终端，须先查看影响。独立工作进程获取数据库部署租约，核对请求的写纪元，验证路径及数据库身份，检查端口可用性，重启指定的 Gateway 服务，并等待健康端点确认准确的配置代次及 release。维护窗口保持开启，供运维核验。DNS、反向代理及证书须另行准备。

<a id="install-the-independent-worker"></a>
## 安装独立工作进程

工作进程必须与 Gateway 分开托管，确保重启 Gateway 不会终止应用器。Linux 上，将两项服务共用的私有引导配置放在 `/srv/harness/gateway-data/node-launch.env`，安装 [harness-gateway-config.service](../harness-gateway-config.service)，与 [harness-gateway.service](../harness-gateway.service) 并列。Gateway 首次初始化后启用配置服务。重启目标默认为 `harness-gateway.service`，`HGW_GATEWAY_SERVICE` 可更改这一宿主机管理的服务名。

macOS 上使用已安装的 [release 控制器](../macos/release-control.sh) 和 [配置 LaunchAgent 模板](../macos/config-agent.plist)。替换所有 `ACCOUNT`，按实际环境调整非默认服务标签或控制器路径，然后将 plist 以所有者私有权限保存为 `~/Library/LaunchAgents/com.maycran.harness-gateway-config.plist`。使用 `plutil -lint` 校验，再通过 `launchctl bootstrap gui/$(id -u) <plist-path>` 加载。独立 agent 使用与 Gateway 相同的稳定 `HOME` 和引导环境，标签为 `<Gateway 标签>-config`，参数为 `config watch`。日志放在私有宿主机配置目录中。控制器在 release 激活后重启已安装的配置 agent。配置应用与 release 激活共用激活锁。

`HGW_CONFIG_APPLIER_POLL_MS` 控制工作进程的串行探测间隔，默认 5000 毫秒，允许 1000–60000 毫秒。没有待处理操作时，探测不访问数据库，也不重启服务。失败请求需要新的显式应用操作，工作进程不会持续重试它们。

<a id="local-recovery"></a>
## 本机恢复

从 release 根目录运行以下命令，使用与服务相同的私有引导环境。macOS 控制器也通过 `config status`、`config apply` 和 `config recover` 暴露这些操作。

```sh
node gateway/lib/node-config-cli.js status
node gateway/lib/node-config-cli.js apply
node gateway/lib/node-config-cli.js recover
```

`apply` 消费显式排队的配置代次。Web 页面不可达时，`recover` 预检并重新安装保留的上一可用值。失败保留诊断，不退出维护。失去数据库租约后，中断的工作进程停止发布文件，由新的租约持有者核对已记录的应用中状态。崩溃进程可能遗留配置锁或激活锁：运维删除锁前，须停止竞争服务并核实锁中记录的进程已退出。仅凭文件时间不能判断锁已遗弃。

<a id="data-and-verification"></a>
## 数据与验证

修改 `HGW_USERS_ROOT` 或 `HGW_PROJECT_RUNTIMES_ROOT` 会改变运行时 `DSH_HOME`。数据库记录的用户 `HOME`、项目挂载、User Documents 和外部成员绑定保留原位置。应用器不复制项目源码或 SSH 工作区，也不改写自定义提供者路径。systemd 用户 HOME 位于候选 users 根之外时，必须先协调迁移，再应用该目录；local 运行时可保留原 HOME。项目分配设置仅影响新项目。

在维护窗口中停止所有写者，准备受管文件成员、字节、权限和所有权完全一致的目标。复制后的 `managed-data.jsonl` 仍包含旧绝对路径，不能原样作为通过依据。先保存期望设置，再将该运行时完整的候选根清单写入私有 `HGW_MANAGED_DATA_APPROVAL_FILE`，包括继续保留的自定义根和 HOME 所有的数据根。从 `gateway/` 为每个移动的运行时执行 `pnpm pg:deploy inventory adopt --runtime user:<public-id> --configuration-revision <已保存代次> --replace-reviewed`，也可指定 `project:<public-id>`。命令核对当前节点身份及已保存代次，把复制的原始清单保留到当前备份目录的 `inventory-adoptions/`，仅替换候选清单；不会应用设置，也不会改变数据库连接。未指定这些参数的普通采纳仍然追加历史记录。

准备完成后再应用并重启。预检将候选实际所有权与全部应移动及应保留的根比较，再核验数据字节和元数据；缺失、陈旧或额外认领均拒绝。环境、补丁、profile 或授权文件中的旧位置绝对引用，以及无法确定存储位置的可执行 YAML，需要单独审查的迁移，应用器不会猜测替换字符串。移动密钥文件要求字节一致，与密钥轮换分开。修改数据库凭据文件不能选择另一数据库，数据迁移使用[协调维护流程](../postgres/README.zh.md)。

备份恢复保留当前节点配置和数据库连接文件。备份中的节点设置可从备份列表查看，不会被应用。不兼容的存储位置会在数据库写入前拒绝恢复。恢复推进数据库写纪元，使针对旧数据代次批准的配置请求失效。

[应用器决策](../../../.agents/notes/implemented/architecture/2026-09-27-current-node-configuration.zh.md) 记录所有权与恢复依据。Linux 资源控制依赖 systemd，macOS local 运行时仍遵守已说明的可信宿主机限制。平台或服务管理器不可用属于验证失败，不计为成功应用。
