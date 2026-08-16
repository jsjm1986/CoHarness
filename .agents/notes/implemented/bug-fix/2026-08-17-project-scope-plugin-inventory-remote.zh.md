# Agent Note: 项目作用域放行插件清单远程调用

Status: implemented

[English](2026-08-17-project-scope-plugin-inventory-remote.md) | 中文

## 问题

`authorizeTypertRemote` 通过 `PROJECT_TYPERT_SESSION_AUTHORIZATION` 表对每个 Typert Remote 端点做项目协作 ACL 分类，该表的每一行都提取 Session 身份并按对应会话的根 ACL 授权。不在表内的端点一律落入 `manage` 级拒绝，因此在共享项目运行时里，`pluginInventory/list` —— 一个没有 Session 身份的 Loader 只读投影 —— 对所有参与者（包括管理员）返回 `collaboration-forbidden`。Web 设置 → 插件 → 插件列表标签在项目作用域显示"暂时无法读取插件"，而个人作用域同一页面正常。

## 决策

在会话表之外新增一个显式只读分类：`PROJECT_TYPERT_PROCESS_WIDE_READS` 在项目作用域放行 `pluginInventory/list`，不做会话 ACL。签名请求主体被捕获时项目成员身份已经确立 —— 运行时在 Host 代码观察到请求之前校验组织、用户、作用域、运行时 id 和世代 —— 因此 `ro` 与 `rw` 成员都可以读取这段不修改任何状态、也不携带会话内容的进程级诊断信息。未分类端点保持默认 `manage` 拒绝；拒绝测试改用 `commands/execute`，一个必须继续被拒绝的真实可变更进程级远程调用。

## 备选方案

**把 `pluginInventory/list` 归入会话表。** 拒绝：该表的约定要求 Session 身份提取器和按会话的 ACL；进程级只读调用两者皆无，伪造会话会授权错误的资源。

**拒绝该远程调用并在项目作用域隐藏插件列表标签。** 拒绝：Loader 清单是每个成员已接入的共享运行时的诊断状态；隐藏它只让项目会话更难检查，并未移除任何真实的保密性。

**按命名约定放行所有 `list` 形态的远程调用。** 拒绝：端点名称不编码资源或变更级别；`commands/list` 与 `dynamicCordisRunner/inventory` 需要逐个分类决策后才能放行。

## 结果

新增一个应对项目可见的进程级远程调用时，必须在 `PROJECT_TYPERT_PROCESS_WIDE_READS` 中显式登记；遗漏保持失败关闭默认。会话级远程调用继续走 `PROJECT_TYPERT_SESSION_AUTHORIZATION` 不变。`commands/execute` 与 `dynamicCordisRunner/*` 仍未分类，在被逐个分类之前在项目作用域保持拒绝。
