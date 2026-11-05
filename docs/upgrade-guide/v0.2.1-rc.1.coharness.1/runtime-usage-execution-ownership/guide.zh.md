---
kind: upgrade-guide
description: "Runtime 上报凭据在账号归账前验证其自身 Session 的执行输入凭据。"
---

# 升级 Runtime 用量归属

[English](guide.md) | 中文

## 变更

按 Runtime 签发的模型上报凭据会把持久 `RuntimeId` 保留到用量验证。提交的执行输入凭据必须属于登记在同一 Runtime 下的 Session。同一台电脑或另一台电脑上的其他 Runtime，即使属于同一账号，也不能复用这些输入凭据。事件正文中的身份字段不能替换已认证的上报身份。执行证明不匹配时，用量端点返回400，不为该报告记账。

个人账单仍按账号汇总；项目账单和贡献者归属保留现有主体。账号资格或电脑权限撤销后，原 Runtime 的有效延迟用量仍可接受。旧版主体级上报通过不可变输入 ID 解析唯一 Runtime，拒绝混合多个 Runtime 的输入凭据。PostgreSQL 迁移 096 将 Runtime 身份纳入会话、输入、转发、执行范围与桌面确认记录，允许独立 Runtime 保留相同的原始 Host Session ID。回填保留已记录的归属；未归属历史继续独立保留。上报 Token 文件与已发布 Session 代际不变。

资源范围选择同样使用已认证的精确 Runtime。另一 Runtime 在同名 Host Session ID 下创建不可变范围，不会阻止有效的旧版累积请求及其队列轮询。Session 自身已有不可变范围时仍须提交自身范围引用；外部范围继续被拒绝。此修正无需进一步改写数据。

## 迁移

1. 停止共享该数据库的所有 Gateway，保留已完成恢复校验的备份，并一同升级，包括受管电脑上的 Gateway。接收流量前，用相同发行版本应用迁移 096；不能让旧写入者访问升级后的数据库。
2. 将按 Runtime 签发的上报 Token 文件保留在所属 Runtime 中。报告被拒绝时，检查实际 Session 和已捕获输入的标识与参与者；不要删除证明字段以绕过验证。
3. 验证两个个人 Runtime 使用相同 Host Session ID 时可独立登记，正常上报、一个提交另一个输入凭据时被拒绝、共享账号汇总，以及撤销资格后的有效延迟上报。参见 [Gateway 参考](../../../../gateway/README.zh.md)。
