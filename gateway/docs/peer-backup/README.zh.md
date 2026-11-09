---
description: "在两台受管电脑间配置加密备份，并在隔离目录核验恢复点。"
---

# 电脑间加密备份

[English](README.md) | 中文

## 概述

在 **Admin → 部署** 中选择一个保护范围、源电脑与另一台受管接收电脑。源 Gateway 在后台导出、加密并提交。接收仓库通过检查后才会记录恢复点。个人和项目 Runtime 可以继续服务用户并执行后台任务。

## 目录

- [配置电脑](#provision)
- [查看保护状态](#coverage)
- [核验恢复](#recovery)
- [更换项目所在电脑](#takeover)
- [快照提供方](#providers)

<a id="provision"></a>

## 配置电脑

先开启[多电脑部署](../deployment-topology/README.zh.md)，并接入目标电脑。在源电脑和恢复演练电脑上安装运维认可的 restic 可执行文件。已验证的原生版本为 0.18.1。它通过现有 HTTPS Gateway 或已接入的转发通道使用 [restic REST 仓库协议](https://restic.readthedocs.io/en/stable/100_references.html#rest-backend)。

每条策略生成三个独立随机值。源电脑保管追加凭据与仓库密码，恢复凭据和仓库密码副本另外保管在两台工作电脑之外。接收电脑需要自己的私有密文目录。POSIX 下可用以下命令创建仅所有者可读的文件并输出 Admin 所需的两个指纹。Windows 上为同样三个文件设置仅所有者可读的 ACL。

```sh
umask 077
openssl rand -hex 32 > append.token
openssl rand -hex 32 > recovery.token
openssl rand -hex 32 > repository.key
node -e "for (const f of process.argv.slice(1)) console.log(f, require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(f,'utf8').trim()).digest('hex'))" append.token recovery.token
```

创建策略、指定仓库配额，然后从**部署标识**复制策略 ID。在每个参与的 Gateway 上保存以下私有 JSON 文件，把其绝对路径配置为 `HGW_PEER_BACKUP_CONFIG_FILE`。密文目录与暂存目录需互相独立，放在 Runtime 家目录、项目、Gateway 状态目录、部署备份及密钥目录之外。替换示例中的路径、地址和策略 ID。

```json
{
  "version": 1,
  "directory": "/srv/peer/encrypted",
  "stagingDirectory": "/srv/peer/staging",
  "resticExecutable": "/opt/restic/restic",
  "capacityBytes": 10737418240,
  "reserveBytes": 536870912,
  "maxExportBytes": 2147483648,
  "uploadKiBps": 2048,
  "downloadKiBps": 4096,
  "routes": [{
    "policyId": "11111111-1111-4111-8111-111111111111",
    "origin": "https://gateway.example",
    "appendTokenFile": "/secure/peer/append.token",
    "passwordFile": "/secure/peer/repository.key"
  }]
}
```

仅作接收端时，`routes` 填 `[]`。独立演练电脑使用同一仓库地址和策略 ID，并设置 `recoveryTokenFile` 与 `recoveryPasswordFile`。通过现有 Gateway 部署流程应用配置。Admin 会报告本机备份服务的配置状态。本地测试可使用数值回环地址的 HTTP。

<a id="coverage"></a>

## 查看保护状态

**已保护至**取最近一个持久确认恢复点的源端快照时间。重要数据的恢复点目标是 15 分钟，普通数据是一小时。断网、达到配额、缺少程序或上传未完成时，确认时间不会前移。下一次采集可复用传完的加密数据包。接收端同时检查单策略配额、仓库总容量、对象数和磁盘预留量。请预留上传、数据库日志和解压演练的临时空间。

| 内置导出器 | 已包含 | 覆盖缺口 |
|---|---|---|
| 协作项目 | 在已发布的节点卷上，以一个可重复读事务导出工作区、对话、执行和项目记录 | 工作区、附件和插件文件需要同一修订的快照提供方。 |
| 个人 Runtime | 已发布目录、标签页草稿、限定范围的 PostgreSQL Session 与插件记录，以及已发布的账号文档记录 | 原生文件快照按配置提供；独立数据域水位、后台投递及不支持的插件状态仍明确列为缺口。 |
| 组织治理 | 主入口上的账号、成员、项目、分配、拓扑和策略的指定字段 | 其他治理状态、审计、服务密钥和外部插件数据需要独立保护。 |

部分恢复点可以还原表中列出的数据域。Admin 显示缺口类别、接收端最近一次容量测量及最近演练。有覆盖缺口或演练失败时，正式恢复预检会被阻止。现有维护备份仍沿用自己的保护范围与还原检查。

个人文件通过 `HGW_PEER_PERSONAL_SNAPSHOTS_FILE` 指向仅所有者可读的 JSON，保存 `version: 1`、`organizationId`、`nodeId`、`provider: "btrfs"|"vss"` 及 `runtimes` 数组。每项声明 `runtimeId`、`source`、`snapshotDirectory`、以 `{id,path}` 记录的获准工作区 `workspaces`；VSS 另需卷 GUID `volume`。声明的 Runtime 存储与账号的三个 UserDoc 根目录需在所选原生快照内。恢复只写入新的隔离目录。文件覆盖不能证明定时投递或跨数据库检查点已一致。

<a id="recovery"></a>

## 核验恢复

选择恢复点和另一台受管电脑，再点**开始隔离演练**。工作器核对磁盘余量，解密到新建私有目录，核验哈希、归属和逻辑顺序，保存结果并清理本次演练的明文。完整演练需要无缺口的恢复点。停用策略或轮换凭据可撤销后续网络访问；已离线保管的仓库密码仍能解密已取得的密文副本。

主入口和源电脑不可用时，在隔离恢复机使用接收仓库及离线保管的密码。在独立卷中准备一个空白私有恢复目录，把离线保管的组织、源电脑、接收电脑、策略和恢复点 UUID 填入仅所有者可读的 JSON 文件。从 `gateway/` 下执行构建后的 Gateway 入口。

```json
{
  "version": 1, "kind": "project",
  "organizationId": "<organization UUID>", "sourceNodeId": "<source UUID>",
  "targetNodeId": "<receiver UUID>", "policyId": "<policy UUID>", "pointId": "<point UUID>",
  "repositoryDirectory": "/recover/encrypted", "recoveryDirectory": "/isolated/new-drill",
  "passwordFile": "/escrow/repository.key", "resticExecutable": "/opt/restic/restic",
  "maxBytes": 2147483648, "maxRows": 2000000, "reserveBytes": 536870912, "timeoutMs": 3600000
}
```

```sh
node lib/peer-backup-rehearse-main.js /escrow/selected-point.json
```

命令在隔离目录重建并校验密文仓库，验证恢复内容，移除临时仓库，并输出所保留的明文路径、覆盖情况和耗时。检查期间限制访问，结束后清理本次私有演练。正式接管另需核验原写入端确已停止、分配独占的新写入代次，并重新取得桌面授权。租约到期或旧电脑失联时仍会阻止发布。

<a id="takeover"></a>

## 更换项目所在电脑

在 Admin 打开已发布项目的备份策略。选择无覆盖缺口的恢复点，在指定接收电脑上完成独立演练。该电脑登记了多个数据卷时，需明确选择目标卷。点击**准备替换电脑**，在新分配的工作区和 Runtime 目录解密数据。替换机重建本机 UserDoc 存储身份，核验保存的 Session 事件和定时投递回执。准备期间原电脑可以继续工作。

原 Runtime 已经停止后，选择**审核原机退出**。原电脑的 Gateway 必须确认同一进程代次已停止、文件操作和项目记录投递均已结束，并核对受保护文件和数据库水位仍与恢复点一致。文件发生变化时需要新的备份和演练。原机忙碌或失联、缺少定时回执、插件存储未覆盖、目标路径已被占用时，系统会阻止切换。原机封存前可以取消接管并继续使用。

曾经封存本项目文件写入权的 Gateway 无法将自身确认为替换端。请选择其他满足条件的目标电脑，并保留原 Gateway 的退役记录。

原机封存后选择**审核切换**。主入口在一个事务中将现有 Runtime 和项目的归属更新至已核验的目标卷。替换机再次校验重建的文件，然后启用更高的写入代次。桌面控制需要重新授权。点击**刷新接管状态**查看结果，恢复的 Runtime 沿用正常授权和调度策略启动。

暂停策略或轮换凭据后，需按当前策略修订重新演练同一恢复点。**审核继续接管**确认该修订、原恢复点和既定目标，不会重新开放已封存的源端。常规配额及恢复点目标调整需等接管完成或取消。取消的候选需清理完成后，才能在该目标重新准备。

接管继续执行电脑使用权和项目权限。Admin 显示尚无目标电脑权限的成员数量。激活后，选择**为新电脑配置保护**，为该项目的新电脑建立策略。选择另一接收端、配置新凭据，并核对首个恢复点。原策略不会自动保护新源。

<a id="providers"></a>

## 快照提供方

在 Linux 上，`HGW_PEER_PROJECT_SNAPSHOTS_FILE` 指向仅所有者可读的 JSON 文件，保存 `version: 1`、组织和电脑 UUID、`provider: "btrfs"` 及 `projects` 数组。每条记录包含项目 UUID、源子卷 `subvolume` 和位于同一 Btrfs 文件系统的独立 `snapshotDirectory`。Gateway 需要在这些明确位置创建和释放只读快照的能力。工作区、Runtime 声明的存储、Gateway 的 UserDoc 元数据与保留对象目录都应位于源子卷中。出现未分类的数据或嵌套子卷时，将不能生成完整恢复点。Windows 和 macOS 接收机可以独立于源端快照提供方核验加密恢复点。Windows 源机使用专用 NTFS 数据卷和 VSS 提供方。Mac 源机需要检查专用 APFS 卷，并配置面向该项目的快照服务。详见[节点存储配置](../../deploy/node-content/README.zh.md)。

每条私有路由可设置 `snapshotExecutable` 来提供一致的文件和数据库版本，并对相应数据域做独立语义验证。在恢复机的还原数据目录之外安装同一受信任的提供方。三个独立参数依次是 `capture|validate`、私有请求文件路径和数据暂存路径。请求含范围标识、字节和行数限制、必检数据域，验证时另含已封存的采集说明。两种操作均无浏览器凭据。

采集返回版本、组织、源电脑、范围、写入代次、水位、UTC 快照时间、已覆盖数量及明确缺口。验证返回 `{"version":1,"checked":[…]}`。每个必检数据域都要通过验证，或记录对应的 `domain:reason` 缺口。需保留不可变 Session 代次、将附件引用核验到实际字节，并在不执行定时任务的情况下核对投递回执。受保护文件清单应排除快照程序与托管密钥。字段定义见[提供方实现](../../src/peer-backup-snapshot-owner.ts)。

## 开发说明

组织库迁移 109、115、119 和 120 保存策略指纹、恢复点、审批、原写入端封存及清理确认。节点迁移 012 和 016 保存封存、替换及暂存归属凭证。治理清单版本 2 不含项目名，并保存继续恢复的审批回执；版本 1 仍是隔离的部分清单。详见[恢复决策](../../../.agents/notes/implemented/architecture/2026-11-05-project-recovery-reauthorization.zh.md)。[接收端](../../src/peer-backup-repository.ts)拥有只可追加的密文仓库。[演练命令](../../src/peer-backup-rehearse-main.ts)在不连接源电脑或组织治理库的情况下核验指定恢复点。

[双机离线演练](../../tests/run-peer-backup-os-pair.py)会先删除合成源、关闭两条转发通道，再从接收仓库恢复。[在线更换写入电脑用例](../../tests/run-peer-backup-online.py)使用独立测试数据库和 Windows 专用测试磁盘。原电脑保持在线，以便出具已停止写入的凭证。端到端计时涵盖准入、传输、演练、审批、启用及一次定时投递。离线 restic 计时只覆盖解密和还原到私有检查目录。
