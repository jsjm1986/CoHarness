# Agent Note: 项目作用域 Remote 授权覆盖与 catalog 外服务

Status: implemented

[English](2026-10-03-project-remote-authorization-coverage.md) | 中文

## Problem

项目协作 ACL 在查找前对每个 Typert Remote 端点分类：携带 Session 的端点在 `REMOTE_SESSION_POLICIES` 中声明参数路径，无身份端点必须落入某个项目作用域集合——进程级只读、注册表授权、管理配置、个人配置、用户终端或管理终端。此前没有任何机制枚举完整的 Remote 面，服务新增的方法可能静默落入 fail-closed 拒绝，过期的策略条目也可能随改名存留而不被察觉。两个具体缺口已经上线：`userQuestions/answer` 与 `userQuestions/attachWait` 携带 `agentId` 却无策略行；`workspace.pinSession`/`unpinSession` 在 Client 侧从未经过 `clientSessionKey` 路由，Workspace 投影中的固定 Session 身份仍是裸 Host id。

## Decision

端点面每次运行被枚举两次，两份清单在 `packages/host/apiproxy/tests/remote-policy-coverage.spec.ts` 中对账。`packages/` 与 `apps/` 下每个 `super(ctx, '<key>'[, { namespace }])` 绑定（排除 tests 与 `lib`）提供服务键及其 wire 命名空间——`namespace` 选项覆盖键名，这就是 `terminalController` 以 `terminal`、`speechController` 以 `speech` 应答的原因。catalog 收录的服务从生成的 `SERVICE_API` 签名提取 `@Remote` wire 名；catalog 投影未收录的服务（`dynamicCordisRunner`、`sessionFeedback`、`pluginInventory`）则由该 spec 从绑定所在源文件恢复 `@Remote` 名。spec 双向断言：每个发现的端点均已分类，每条分类条目都指向一个已发现的端点。

审计确定的分类现已显式落表。`userQuestions/answer` 与 `userQuestions/attachWait` 按 `['agentId']` 路由。`speech/catalog` 与 `speech/follow` 连同 `permissionPresets/catalog`、`pluginRegistryProbe/fastest` 加入进程级只读。新增的 `PROJECT_TYPERT_PROCESS_WIDE_OPERATIONS` 集合放行三个无 Session 的语音操作（`speech/prepare`、`speech/cancelPreparation`、`speech/transcribe`），全体参与者均可用；`speech/configure` 落入 `PROJECT_TYPERT_MANAGER_CONFIGURATION`，因为 provider 选择是共享可变状态。`terminal/adminList` 与 `terminal/adminClose` 从内联字面量迁出为导出的 `ADMIN_TERMINAL_ENDPOINTS` 集合，使覆盖 spec 可见。

## Alternatives considered

**仅信生成的 catalog 枚举端点面。** 否决：catalog 投影合理地排除了三个已绑定服务，会读作十四条过期策略条目并掩盖真实方法；从各绑定文件恢复其 wire 名能保持双向 fail-closed。

**所有端点一律按服务键派生命名空间。** 否决：两个服务绑定的 wire 命名空间与其服务键不同（`terminalController` → `terminal`、`speechController` → `speech`）；按键派生的名字会为不存在的端点索要策略，而真实端点仍处于未分类状态。

**`speech/*` 与上游一样保持未分类。** 就本 fork 的部署形态否决：项目作用域的语音采集会对所有参与者 fail-closed；按只读、参与者操作、管理配置三分与终端先例一致，且不扩大非管理员可变更的范围。

## Consequences

任何新增的 `@Remote` 方法或命名空间变更在决定其项目作用域分类之前都会使该 spec 失败——这是有意的编写成本，用以杜绝双向的静默 fail-closed 漂移。固定 Session 的 Client 代码现在从 `workspace.pinnedSessionIds` 收到 `ClientSessionKey` 身份，与其他 Session 投影一致；持有该字段裸 Host id 的消费方须迁往键化形态。

## Testing

覆盖 spec 本身就是门：只有当整个绑定面双向对账一致时它才通过。`client-session-routing.spec.ts` 固定 `userQuestions` 与 Schedule 路由行，`session-api.client.spec.ts` 覆盖 Client 侧 pin/unpin 路由。
