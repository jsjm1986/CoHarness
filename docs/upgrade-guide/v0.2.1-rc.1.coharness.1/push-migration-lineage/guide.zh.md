---
kind: upgrade-guide
description: 曾以 130 和 131 登记推送迁移的部署须在激活前完成协调迁移。
---
# PostgreSQL 推送迁移记录升级

[English](guide.md) | 中文

## 变更

仅含推送迁移的发布版用 130 和 131 登记推送回执与 UnifiedPush。合并后的发布版用 144 和 145 承载相同 SQL。激活要求使用合并后的迁移记录。已使用合并序列的部署可以继续按常规流程升级。

## 迁移

1. 使用当前安装的仅含推送迁移的发布版进入维护，确认各写入方已收敛。保留已验证的升级前治理库备份及其匹配的发布版。
2. 在候选工作树运行 `npm --prefix gateway run pg:deploy -- status`，连接到同一个治理库。确认显示 `migration_relocations=130->144,131->145`。若只执行过 130，则显示 `migration_relocations=130->144`。
3. 在同一维护窗口，用候选运行 `npm --prefix gateway run pg:deploy -- apply`。输出分别列出重新登记的记录和本次执行的 SQL。推送迁移记录升级失败时，保持维护状态并排查。
4. 再次运行 status，确认没有待执行迁移或待重新登记的记录。按[部署流程](../../../../gateway/deploy/README.zh.md)激活候选，核对已登记设备和回执历史后再开放流量。恢复升级前备份时须使用匹配的发布版。备份资格参见[恢复前的 schema 检查](../restore-schema-preflight/guide.zh.md)。
