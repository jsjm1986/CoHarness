# Agent Note: 插件界面的项目作用域远程分类

Status: implemented

[English](2026-08-17-project-scope-plugin-inventory-remote.md) | 中文

## 问题

`authorizeTypertRemote` 通过 `PROJECT_TYPERT_SESSION_AUTHORIZATION` 表对每个 Typert Remote 端点做项目协作 ACL 分类，该表的每一行都提取 Session 身份并按对应会话的根 ACL 授权。不在表内的端点一律落入 `manage` 级拒绝，因此在共享项目运行时里，两个只读界面对所有参与者（包括管理员）失败：Web 设置 → 插件 → 插件列表标签（`pluginInventory/list`，无 Session 身份的 Loader 投影），以及整个动态 Cordis 面板与审批流（`dynamicCordisRunner/inventory` 加上全部运行、渲染与调用远程）。面板报 "Reading the plugin inventory failed: collaboration-forbidden"，审批门控的运行在项目作用域永远无法被应答。

## 决策

远程授权现在分为三个显式层级，遗漏一律失败关闭。

1. `PROJECT_TYPERT_SESSION_AUTHORIZATION` 分类所有线上参数以 `agentId` 携带目标会话的远程。动态 Cordis 运行界面与 `goals/*`、`messageFeedback/*` 一同进入该表：`runHostHalf` 与 `resolveRequestRun` 结算一次人工审批（`approve`，Gateway 仅授予 `rw` 参与者），`getClientCode` 渲染可读会话的运行卡片（`read`），`settleUserRun`、`stopFromPanel`、`undefineFromPanel`、`reportRenderFailure`、`reportClientGuardFailure` 变更会话级运行状态（`write`）。
2. `PROJECT_TYPERT_PROCESS_WIDE_READS` 在主体捕获已验证成员身份后放行无 Session 身份的进程级只读调用：`pluginInventory/list` 与 `dynamicCordisRunner/inventory`。由于清单行携带按会话的插件元数据，所属服务自行过滤：项目作用域下 `inventory()` 丢弃 Session 不在 `authority.readableSessionIds` 内的行，私有会话不会泄露其插件元数据；个人作用域与无协作组合保留全部行。
3. 注册表解析授权覆盖仅宿主注册表知道会话身份的两个远程：`resolveRequestRun` 按待决请求的所属会话授权 `approve`，`invoke` 按插件的所属会话授权 `write`，两者都在 `DynamicCordisRunnerService` 内部通过共享的 `collaborationRefusal`（现从 `dsh-collaboration` 导出，是该拒绝的 code/message/details 映射的唯一归属）执行。AsyncLocalStorage 把请求主体带进服务，`capture()` 解析出与 apiproxy 相同的授权。

未分类端点保持默认 `manage` 拒绝；拒绝测试使用 `commands/execute`，一个必须继续被拒绝的真实可变更进程级远程。`dynamicCordisRunner/syncInspectManifest`、`resolveInspectQuery` 与检查界面仍未分类，在被逐个分类之前在项目作用域保持拒绝。

## 备选方案

**把清单归入会话表。** 拒绝：该表的约定要求 Session 身份提取器和按会话的 ACL；进程级只读调用两者皆无，伪造会话会授权错误的资源。

**把所有 `dynamicCordisRunner/*` 远程按进程级只读放行。** 拒绝：`runHostHalf` 与 `invoke` 代表某个会话执行宿主代码；其授权必须指向该会话，而非仅仅成员身份。

**在 `resolveRequestRun` 与 `invoke` 的线上协议里透传 `agentId`。** 拒绝：客户端对会话的认知不是权威 —— 注册表才是。线上派生的身份属于 apiproxy 表；注册表派生的身份在注册表所在处授权。

**拒绝这些界面并在项目作用域隐藏标签。** 拒绝：插件清单与审批流是每个成员已接入的共享运行时的运维界面；隐藏它们只让项目会话更难检查，并让审批门控的运行无法应答。

## 结果

新增一个项目可见的远程需要在三个层级之一显式分类；遗漏保持失败关闭默认。`ro` 项目成员可以读取插件清单、渲染运行卡片并看到审批，但写入运行状态、结算审批与调用宿主方法需要 `rw`；因此在 `invoke` 获得更细的分类之前，运行中插件的浏览器面板无法以 `ro` 查看者身份调用其宿主方法。动态 Cordis 清单变为异步；宿主侧调用方需要 await。`dsh-cordis-host-runner` 新增对 `dsh-collaboration` 的 peer 依赖与项目引用。
