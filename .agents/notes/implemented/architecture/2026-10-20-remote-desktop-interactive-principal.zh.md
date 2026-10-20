# Agent Note：远程桌面 actor 解析自请求断言

状态：已实现

[English](2026-10-20-remote-desktop-interactive-principal.md) | 中文

## 问题

远程桌面控制器借用了终端授权缝：`RemoteDesktopAccess.authorize` 把身份委托给 `userTerminalAuthorization`，后者经 Gateway 的 `terminal-authorize` 端点铸造 `terminal_session_grants` 行。该端点执行终端资格检查——对 project runtime，要求 `harness.terminal_access_policies` 有 enabled 的项目级行——因此在没有终端权限的 project runtime 里，所有 `remoteDesktop/*` 调用都以 `terminal/forbidden` 失败，guide 呈现为读取失败。同一基座还带着两个潜在缺陷：`administrator()` 要求只有 `/api/terminal/admin*` 请求才携带的 `terminal-admin` purpose 断言，导致 `actor.admin` 恒为 false、管理方法在线缆上不可达；且 `String(authority.creator)` 产出的是终端 creator blob 而非管理员写进授权文件的用户名，授权匹配永远无法成功。

## 决定

`RemoteDesktopAccess.actor` 经 `gatewayRuntime.interactive()` 直接从请求自带的已验证 Gateway 断言解析调用者：`principal` 取断言的 `user.username`，`admin` 取 `user.role === 'admin'`。管理员签发的授权即全部产品权限——调用不再需要终端授权。受限 purpose 与非交互调用者（agent 驱动的请求、`webhook-dispatch`、过期断言）以 `remote-desktop/forbidden` 拒绝。独立部署保留 `local-operator` 管理员。控制器取消 authorize/administrator 两段解析；`adminActor` 断言声明角色。Provider 侧执行不变：授权仍闸住 `status`/`confirm`/`attach`，`requireAdmin` 仍闸住管理——即使线缆 actor 被伪造。

## 备选方案

**在部署中启用项目级终端策略。** 否决：保留了错误的依赖——远程桌面可用性仍会随无关产品的访问策略起伏，且 `creator` blob 依旧与授权 principal 不匹配。

**保留 `userTerminalAuthorization` 并补用户名映射。** 否决：读远程桌面授权仍会附带铸造终端授权的副作用，且恒 `admin: false` 的缺陷依旧。

**在 provider 内解析 actor。** 否决：控制器本就持有已验证断言作用域的线缆边界；把断言读取下沉到能力层会把传输知识扩散进服务层。

## 后果

guide 的 `listGrants`、同意、attach 与线缆级授权管理在任意 runtime 上对交互用户可用，不触碰终端策略。管理员授权现在能到达真正的管理员——此前这些方法对所有人不可达。终端缝保有自己的契约；远程桌面不再附带铸造终端授权。`tests/access.spec.ts` 固定独立部署、用户、管理员、非交互、受限 purpose 与过期断言的解析；[能力缝笔记](2026-10-19-remote-desktop-capability-seam.zh.md)继续持有本 actor 所供给的授权/同意/attach 设计。
