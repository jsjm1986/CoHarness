# Agent Note：会话绑定 SSH 执行

Status: implemented

[English](2026-09-24-session-bound-ssh-execution.md) | 中文

## Problem

[SSH 执行提供方](2026-09-23-ssh-execution-providers.zh.md)让 `fs`/`subprocess`/`sandbox`/`ssh` 可以解析到同一台受管远端主机，但挂在根 realm 上的提供方子树会把所有会话都放到那台主机上。会话需要一种耐用的逐会话绑定：能跨重启存活、在 preset 插件于注册期捕获 `ctx.fs` 之前完成远端 realm 组合、对每位加入的调用方重新授权，且不能让某个授权的撤销连带终止其他调用方的挂载。项目也需要能在不必每次共享都经管理员过手的情况下选用已登记的目标。

## Decision

`SessionHeader.sshTarget` 是在创建时记录、贯穿所有存储层持久化、并在 resume 时作为权威的耐用绑定。它在格式库中沿用 `draft` 扩展模式：在 v3 边界准入并做正安全整数校验，在 released-v2 检查前剥离，经由 v4/v5 迁移的展开保留、逻辑 catalog 白名单、JSONL 头和 gateway 持久化投影一路携带。旧 codec 依旧拒绝该字段。

`AgentPresets` 的 standing 挂载增加 realm 维度，键为 `ssh-target/<targetId>/u<userId>[/p<projectId>]`。已注册的 realm 钩子在新的 standing scope 内、组合挂载之前运行，因此 SSH 提供方遮蔽整个 preset 子树的 `fs`/`subprocess`/`sandbox`/`ssh`——包括在自身注册上下文上解析服务的工具，这是逐 agent isolate 遮蔽无法触及的。`packages/host/apiproxy/src/ssh-execution.ts` 注册该钩子；`packages/preset/agent-presets` 拥有 realm 机制。

准入按加入粒度执行：`composeAgent` 解析调用方自己的 `sshAuthorization` 授权，以该授权的主体作为 realm 键，并返回一个在 setup 全部 await 落定后重新执行 `signal.throwIfAborted()` 的发布提交——与挂载竞态的撤权能否决发布。钩子在所属授权的失效信号中止时退役该 realm 代次并销毁连接。Resume 读取存储的绑定、以 resume 调用方身份重新解析，并把不一致的请求拒绝为 `ssh-target-conflict`；fork 继承绑定，因为种子历史是在那台主机上产生的。

自助共享限定在项目管理权：`share` 与 `listForProject` 准入组织管理员或项目的 `owner_user_id`，并在同一写入事务内复查。`/account/api/projects/<id>/ssh-targets` 向项目管理者提供共享标志列表（GET）与共享开关（POST）；`capabilities.sshTargets` 显式汇报能力，UI 不必凭角色推断。目标登记、机密与带修订的变更仍归管理员在 `/admin` 管理。

## Alternatives considered

**逐 agent isolate 遮蔽**——在 `agentCtx` 上挂载四个提供方无法触及 preset 工具：工具在 standing 挂载的注册上下文上解析 `ctx.fs`，而 `provide` 写入构造上下文的 fiber store。realm 化 standing 挂载是唯一能为整个组合遮蔽服务的位置。

**realm 只按目标分键**——共享的 `ssh-target/<id>` realm 会让调用方 A 的撤权在调用方 B 的存活会话下销毁连接。按授权主体分键把每次撤权限定在该授权所准入的挂载内。

**resume 采用请求指定目标**——允许后续请求改绑会让会话历史对着它的轮次从未见过的文件系统重放。存储绑定胜出；不一致请求即冲突，与 `agentPreset` 同理。

**项目级目标 CRUD**——目标行携带 helper 摘要、主机密钥与凭据引用；登记它们是部署安全决策。只有共享决策——本项目可使用哪些已登记目标——下放给项目管理权。

## Consequences

按主体分键会在同一目标的不同用户间重复 standing 挂载——这是撤权隔离的 fail-closed 代价。被撤销的授权会退役它准入的全部挂载，并使在途提供方调用 fail-closed；`sshTarget` 会话同时要求 preset 花名册与 `sshAuthorization`，缺失时冷 resume 响亮失败。绑定目标的会话在创建时跳过 Host 侧 `mkdir`。本次 UI 改动面向用户可见，落地 PR 前仍欠真实服务器验收证据。

## Testing

`realm.spec.ts` 证明提供方在 realm 化 standing scope 内完成遮蔽，覆盖挂载、重组、失效与过期代次回滚。`ssh-execution.spec.ts` 钉住解析/提交/撤权契约。`api-proxy-ssh-target.spec.ts` 覆盖头部记录、主体域挂载、缺花名册与缺服务失败、发布提交门、存储绑定 resume 以及存活/持久化冲突拒绝；`api-proxy-fork.spec.ts` 覆盖 fork 继承。Codec 准入与迁移套件覆盖 `sshTarget` 往返、畸形拒绝与 v2 严格性；JSONL spec 覆盖 inspect/listHeaders 持久化。`password-channel.spec.ts` 覆盖 askpass 暂存与清理。`gateway/tests/ssh.spec.ts` 在 PostgreSQL 下覆盖 owner 对成员的共享权限与 `listForProject`；client spec 覆盖传输路由、畸形响应与不可用降级。
