# Agent Note: 授权流程的会话级凭据提交

Status: implemented

[English](2026-10-01-authorization-session-scoped-commit.md) | 中文

## Problem

`AuthorizationService` 在调用方可见结果确定的那一刻就释放了凭据 key。被撤销尝试的 flow 在 key 已释放的情况下继续无监管地运行：调用方取消后才走到存储写入的 pi-ai 登录仍会发布它刚拿到的授权，且第一次 flow 的写入尚未完成时第二个 `begin()` 就能开始。提交证据来自在运行期间观察 `credentials/record-updated`，因此任何同键写入——不一定是该 flow 自己的——都能满足 `NOT_COMMITTED` 检查。

## Decision

`AuthorizationSession` 携带 `commit(mutate)`：固定在该 flow 自己的 `CredentialKey` 上的串行化读改写，是 seam 认可的本次尝试唯一提交。尝试跟踪 `active | committing | committed` 阶段。准入在排入提交队列时、凭据 provider 独占 mutation 内部（写入可能排在无关操作之后）、以及替换值返回给存储之前各把关一次——此时阶段同步转为 `committing`。`committed` 只能由一次成功完成的存储操作取得：以 `undefined` 谢绝的 mutation 把 `undefined` 交还 provider，读路径返回当前记录而不产生写入，因此空操作无法冒充提交。

准入一旦关闭，撤销也随之关闭。请求 signal、`cancel(key)` 与 flow 注册的销毁只在阶段为 `active` 时中止尝试的 signal；已准入的写入按自身条件完成——存储成功时报告 `authorized`，失败时尝试以存储错误告终、cause 保留、settlement 为 `failed`。任何地方都不把"记录存在"当作成功，也不静默吞掉已准入写入的拒绝。

取消把调用方的答复与 key 的保留分开。被撤销的调用方立即得到 `cancelled`，但 `running` 保留该 key，直到孤儿流程与其排队的提交工作真正静止——已结束的流程不会提前放行仍在排队的写入——`authorization/settled` 在释放之后触发一次。被捕获的 session 在撤销、流程结束或释放之后不能再写：`commit` 在每个检查点以 `WITHDRAWN` 拒绝。

pi-ai 适配器的 `credentialStoreFrom(ctx, { modifyRecord })` 接受可选的串行写入委托；登录集合用一个闭包构造它，该闭包拒绝 flow 自身键以外的任何键并委托给 `session.commit`。`Models.login` 仍是唯一的登录编排者——其 `store.modify` 就是提交，而不是复制后再持久化一遍。适配器还在操作开始时与 `modify` 的 mutation 检查点处遵守 pi-ai 的 `AuthOperationOptions.signal`。

## Alternatives considered

**在调用方得到答复时就释放 key 并中止孤儿写入。** 已拒绝：seam 无法取消已进入凭据 provider 独占 mutation 的工作，而"写入仍在进行时第二次 begin"恰恰是 key 保留所要阻止的双写竞态。

**让 flow 交出凭据由 seam 持久化。** 已拒绝：通过自有 store 适配器持久化的库（pi-ai 的 `Models.login()`）会在库内写一次、再经 seam 写一次——两个写入方、两种次序，陈旧刷新还可能插入其间。

**保留 `credentials/record-updated` 监听作为提交证据。** 已拒绝：该事件只证明发生过写入，不能证明是本次尝试写入；对没有提交任何东西的 flow，无关的同键写入也会满足 `NOT_COMMITTED`。只有会话上的 committed 标记才是权威。

## Consequences

flow 必须通过 `session.commit` 提交——`run()` 中直接调用 `ctx.credentials.modifyRecord` 不再算数，以那种方式写入的 flow 在迁移前会以 `NOT_COMMITTED` 失败。忽略自身 signal 的不合作流程会一直持有 key 直到真正结束，而不是被放开；这是"绝不发布被撤销的写入"的代价。被撤销尝试的 `authorization/settled` 按设计迟到——借此启动后续尝试的监听者必须容忍这一延迟。

## Testing

[authorization.spec.ts](../../../../packages/credentials/authorization/tests/authorization.spec.ts) 覆盖准入拒绝、排队写入取消、mutation 中途撤销、存储被持有时已准入写入的完成与失败（请求 signal、`cancel`、注册销毁三种路径同样覆盖）、已结束流程的排队提交仍持有保留、空操作 mutation 行为、无关写入与销毁。[login-lifecycle.spec.ts](../../../../packages/llm/llm-pi-ai/tests/login-lifecycle.spec.ts) 通过带可门控凭据 provider 与受控 OAuth provider 的 Loader 组合端到端运行真实 `Models.login`，包括经证明的"排在另一操作之后"的写入与存储失败的已准入写入；[auth.spec.ts](../../../../packages/llm/llm-pi-ai/tests/auth.spec.ts) 钉住适配器的 signal 检查点与写入串行化。
