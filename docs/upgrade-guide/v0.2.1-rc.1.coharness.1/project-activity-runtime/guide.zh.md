---
kind: upgrade-guide
description: "项目活动请求与会话链接保留所属 Runtime。"
---

# 升级项目活动的 Runtime 寻址

[English](guide.md) | 中文

项目活动与进展使用容纳面板的会话所属 Runtime。切换当前会话或由另一浏览器标签修改空间 cookie，都不能重定向该面板的读取、生成请求和会话链接。即使页面从个人空间启动，项目会话仍提供活动入口。[活动包](../../../../packages/client/ui-project-activity/README.zh.md) 说明当前行为。

活动分组在会话或成员改名后仍保留同一组，并始终区分不同 ID。

使用更新的部署载荷重启服务，并重新加载现有浏览器页面。现有会话数据与数据库结构无需迁移。直接调用源码级读取函数的消费方需要显式传入所属 Runtime；独立调用传入 `undefined`。
