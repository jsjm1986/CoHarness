---
kind: upgrade-guide
description: "账号偏好保留当前资格，仅导入一次旧字体，并保留存储失败的重试能力。"
---

# 升级账号偏好授权与迁移

[English](guide.md) | 中文

## 变更

`GET` 与 `PATCH /account/api/preferences` 在数据库事务期间保留当前活跃组织、账号及成员资格。资格在准入前失效的请求返回403，不初始化或修改偏好。已接纳写入在冲突的撤销提交前完成。账号数据仍不要求电脑执行授权。

无法读取旧 `settings.yaml` 时返回503及 `account-preferences-unavailable`，在服务端日志保留原因，不提交初始化。存储修复后，新请求会导入真实旧值。缺失文件与格式错误的 YAML 仍初始化默认值。浏览器 actor 字段不能把偏好重定向到其他账号。

账号接口在 `ui-theme` 下接收 `fontSize`（10–22）、`codeFontSize`（10–16）、`terminalFontSize`（10–20），以及 `textFontFamily`、`codeFontFamily`、`terminalFontFamily`。共享项目中的 Gateway 字体控件仍通过账号接口写入。项目 Host 设置保留现有写入权限。首次账号读取从该账号个人 `settings.yaml` 导入合法且缺失的字体值，保留显式账号外观和字体值。独立标记使导入只执行一次，重置后也不会重新导入；读取失败时保留重试能力，旧文件保留。参见[字体归属决策](../../../../.agents/notes/implemented/bug-fix/2026-11-01-account-font-preferences.zh.md)。

## 迁移

1. 应用 PostgreSQL migration103，并升级匹配的 Gateway 与 Web 客户端构建。有效主题响应包含全部六项字体字段；override 省略已重置的字段。自定义 transport 与偏好服务需实现这些字段，并保留现有修订号栅栏。
2. 自定义账号偏好服务在初始化、查看与修改期间保留当前资格及账号身份；请求中的缓存角色或状态不足以授权。
3. 收到403时恢复账号资格并重新认证。收到503时修复服务端日志指出的旧设置路径，再次请求并确认返回预期值及版本。参见[账号偏好决策](../../../../.agents/notes/implemented/bug-fix/2026-10-29-account-preference-authority.zh.md)。
