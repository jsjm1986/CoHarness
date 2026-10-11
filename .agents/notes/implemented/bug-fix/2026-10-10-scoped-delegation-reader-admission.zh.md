# Agent Note：委派策略追加改经权限写入器落盘 scoped 作用域

Status: implemented

[English](2026-10-10-scoped-delegation-reader-admission.md) | 中文

## 问题

`appendDelegatedPolicyOverrides` 直接把 `gateway/execution { kind: 'inherit', scope }` 追加进子会话日志。当捕获的 `ExecutionInheritance` 带有 `scopeId` —— 受管 scoped 部署下的每个会话 —— `gateway-execution` 投影要求 `gateway/scoped-execution` 读者准入事件先于第一条 scoped 事件，而该事件从未被写入。子会话日志在首次折叠时即不可读，scoped 父级下的一切委派 —— `spawn_teammate`、一次性 subagent 启动与 continuable 子代 —— 都以 `scoped inheritance requires its reader admission event` 失败，表面上是 Team 成员 `failed` 或子运行被拒。

## 决策

`appendDelegatedPolicyOverrides` 现在接收子会话的 `Context`，把 scoped 写入委托给 `executionAuthorityOf(childCtx).inherit(session, scope)` —— 该服务方法的契约恰是"在尚未发布的子代 setup 窗口内持久化捕获的限制"。该写入器只在折叠日志缺少准入时才在首个 scoped 事件之前补发 `gateway/scoped-execution`，因此已带准入的 fork 种子不会被重复追加。未挂载 authority 提供者时，无作用域的捕获仍直接追加（非受管部署本就不会产生 `scopeId`）；而带作用域的捕获改为抛出错误，而不是持久化一条连自身投影都会拒绝的日志。

## 备选方案

**在 inherit 事件前无条件追加 `gateway/scoped-execution`。** 否决：它会给种子已带准入的 fork 子代重复写入准入标记，并且在第二个调用点重复实现同一条排序规则，日后可能与所属投影漂移。

**在本助手内部按 `scopeId` 是否存在来决定是否写准入。** 否决：重复实现的理由相同；"是否已准入"的判断需要只有 authority 写入器才做的投影折叠。

## 后果

scoped 父级恢复委派能力：子会话的持久化前缀依次是 `subagent/descriptor`、`gateway/scoped-execution`、`gateway/execution inherit` 及其余委派策略事件，成员/会话可通过自身投影折叠。fail-loud 分支把缺失 authority 提供者变成显式错误，而不是产出损坏的子会话日志。

## 验证

`child-agent.spec` 现在断言捕获经 `authority.inherit` 路由（记录精确的会话对象）、未挂载提供者时无作用域捕获仍直接追加、以及未挂载提供者时带作用域的捕获抛错且不写任何事件。in-process driver 规格挂载 authority 替身并断言启动期间 `inherit` 恰好执行一次。`gateway-execution` authority 套件已钉住准入写入与"种子已带准入不重复"用例。subagent 与 in-process-driver 全部 797 个测试通过。
