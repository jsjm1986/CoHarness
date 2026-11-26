---
kind: upgrade-guide
description: "故障恢复要求物理隔离源电脑并审核执行；治理重建默认拒绝旧权限。"
---

# 原电脑损坏后的恢复

[English](guide.md) | 中文

## 变更

计划恢复要求源端确认已停止。故障恢复要求记录整台源电脑的物理隔离证明，失联不能作为证明。恢复会撤销源凭据与租约，永久隔离该身份，并保留每个项目的身份及独立审批。

恢复的定时任务与待处理消息保持暂停，旧对话保持只读。检查已停止的目标后，可以允许新对话及逐项审核过的组件；无法检查的动态代码不能启用。检查不会停止活动任务。每次故障都需要新许可。计划迁移传递原冻结 Session 集合，保留后建对话，并要求目标重新审核。其恢复点必须在原写入端封存前包含源审核记录。日常升级保留既有许可。

个人和项目故障恢复会在目标副本中暂停旧 `HGW_*`、`DSH_*`、libpq 连接设置及 `DATABASE_URL`。Admin 显示设置名称供重新配置，源加密恢复点保留原值。业务设置、普通升级与计划迁移保持不变。

## 迁移

1. 运行新版 Gateway 前，应用[治理迁移 130–136](../../../../gateway/deploy/postgres/migrations)。所有参与方同步升级，旧版 worker 无法处理这些阶段。维护恢复必须保留当前隔离证明、电脑隔离、执行隔离和审批。
2. API 客户端处理 `recoveryMode: "planned" | "disaster"`（默认 `planned`）、`preparing`、`externally-fenced` 和 `disaster-ready`。将 `executionReviewRequired` 与数据激活分别展示。
3. 物理隔离源电脑前，独立演练无覆盖缺口的恢复点。核对策略修订、恢复点、源身份、进程代次及写入代次，记录不含凭据的证据引用。确认后不能重新开放源身份；当前服务中的主入口不能隔离自身。成员仍须具备目标电脑使用权。
4. 激活后检查已停止的目标，以 `new-conversations-only` 模式确认准确的审核修订。组件审批绑定摘要和证据引用，随后需要重新检查。核验新对话可用、旧历史只读。单电脑模式保留本机执行审核，不允许远程管理或新建接管。
5. `/admin/api/peer-backups/personal-recoveries` 要求已核验的 `native-personal-v3` 数据。处理 `preparing`、`prepared`、`externally-fenced`、`activating` 和 `published`，以及独立执行审核。保留账号与 Runtime ID、权限、配额、标签页身份和文档凭证。不能覆盖已占用目标；部分恢复点或不兼容路径只允许隔离演练。
6. 将节点私有 `recovery-execution` 与 `governance-rebuild-local` 文件纳入备份，并独立保管恢复密钥。文件缺失或篡改会阻止授权。旧版治理清单 1–7 仍为部分覆盖，不恢复凭据或写入权限。
7. 组织全损时，按[离线重建流程](../../../../gateway/docs/peer-backup/README.zh.md#governance-rebuild)使用 `governance-rebuild-v1` 导入空数据库。保留查重密钥，在 `/admin/governance-recovery` 使用新引导凭据。其他路由保持关闭，直到完成账号审核并放开；权限仍须明确配置。随后在各所属电脑的 `/admin/governance-recovery/local` 绑定保留数据并审核执行。核验原 Runtime 退役后，文档与新分配 Runtime 仍共享已接受的账号目录。新 Runtime 使用独立存储，不继承执行许可。缺少绑定时拒绝分配；保留根目录消失时不会重建。退役 Runtime 时保留已接受的私有证据。

8. 保留恢复点原有的密文接收电脑。新建计划迁移、故障恢复或个人恢复都要求替代电脑已装配对应范围的恢复 worker，即使接收电脑就是替代电脑也一样。独立替代电脑还要求双方 Gateway 支持恢复协议、全新的指纹读取审批、独立保管的凭据、在该替代电脑完成的演练及其已核验数据卷。分别处理 `repositoryNodeId` 和 `targetNodeId`；所选替代电脑不可用时，不能静默改选接收电脑。schema 135 重建包导入 136 时仍核验原校验和与字段，新增读取授权和协议心跳保持为空。

覆盖范围与恢复限制见[电脑间加密备份](../../../../gateway/docs/peer-backup/README.zh.md)。
