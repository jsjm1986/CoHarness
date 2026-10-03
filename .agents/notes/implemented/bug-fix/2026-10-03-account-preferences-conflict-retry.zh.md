# Agent Note：账户偏好写入遇到过期 revision 栅栏时透明重试

状态：已实现

[English](2026-10-03-account-preferences-conflict-retry.md) | 中文

## 问题

由账户偏好驱动的设置行（工作步骤展示、繁忙时发送行为、对话显示宽高、性能统计）偶发显示"设置未能保存，请重试。"，尽管重试就能成功。四行共用一个 `conversationSettings` scope，一次 PATCH 失败会让所有行同时出现红字。

## 决定

**把 `account-preferences-conflict` 视为需要重读的栅栏，而不是需要上报的失败。** `AccountSettingsScopeController.write` 把"发起 mutate + 接受响应"提取为 `attempt` 闭包；冲突时清掉保留的响应栅栏、重载镜像（每次失败本来就会执行的恢复读），并仅按新 revision 重试一次。任何第二次拒绝——无论冲突与否——都走原先的 `failWrite` 路径上报。重试发生在既有的串行写队列里，不会与排队中的后续写入乱序。

## 备选方案

- **只恢复不重试。** 这本来就是既有行为：`mirror.load()` 刷新了 revision，但红字会一直显示到用户再次改动为止——正是用户看到的问题。
- **写入时去掉 `expectedRevision`。** 否决：该栅栏是阻止两个标签页互相静默覆盖的唯一保证；重试一次既保留了这个保证，又让单次竞态不再可见。

## 影响

输给其他标签页或排队兄弟写操作的 revision 竞态现在落在新的 revision 上而不再报错；真实的传输与校验失败仍按原样上报。共享 scope 的放大效应（一次失败 → 所有行飘红）这一呈现属性不变：瞬态冲突被静默消化后，剩余的红字意味着真实失败。
