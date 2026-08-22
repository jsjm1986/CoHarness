# Agent Note: 项目 UI Remote 使用会话级 ACL

Status: implemented

[English](2026-08-22-project-ui-remote-acl.md) | 中文

## 问题

项目协作只为较早的领域方法分类了 Typert Remote，因此浏览器输入框依赖的 Remote 在项目策略中全部被拒绝。命令发现、命令执行、文件引用查询和会话引用查询都在所属服务运行前失败，导致 `+` 菜单与 `@` 补全为空，也让权限命令无法到达管理员专属的 Full access 检查。

## 决策

`dsh-host-apiproxy` 将 `commands/list`、`fileReferences/list` 与 `sessionReferenceResolver/candidates` 分类为 Session `read` 操作，将 `commands/execute` 分类为 Session `write` 操作。现有 collaboration authority 仍是项目成员关系与根对话访问权限的唯一来源。Session-reference 的发现与准备也会应用该 authority 的 readable-session 过滤，因此项目私有会话既不会出现在候选项中，也不会被手工构造的 mention 读取。只读成员可以为可读会话发现候选项和命令，但只有得到 `write` 授权的成员才能执行命令。权限 preset 服务继续把 `danger-full-access` 限制给已认证管理员，项目运行时仍限制在项目目录内。

## 考虑过的替代方案

**在项目 scope 中放行所有进程级 Remote。** 不采用，因为命令执行与引用查询都携带 Session 身份，不能绕过私有对话 ACL；宽泛豁免还会让未来的进程级能力无需审查就获得授权。

**继续拒绝 UI Remote，并增加浏览器端回退实现。** 不采用，因为命令注册、文件发现和会话快照都由 Host 所属服务负责；回退实现会复制或削弱这些提供方，也无法安全地授权命令执行。

**把 `commands/execute` 当作 read 操作。** 不采用，因为命令处理器会追加持久生命周期事件，并可能修改 Session 状态，包括权限和 goal 命令。

## 后果

项目输入框现在通过与个人会话相同的生成 Remote 命名空间完成发现。只读参与者可以使用 `@` 并打开 `+` 查看可读会话的可用动作，但提交命令仍会收到协作 write 拒绝。对私有会话的直接引用会在快照读取前失败。管理员选择 Full access 时会进入既有角色检查，不再被通用项目 Remote 拒绝路径拦截。

## 测试

`packages/host/apiproxy/tests/api-proxy-collaboration.spec.ts` 覆盖新增分类的四个 endpoint、管理员可用的写入路径、只读成员可发现但不能写入，以及未分类 Remote 继续拒绝。`packages/context/session-reference/tests/session-reference.spec.ts` 覆盖不可读会话的候选过滤与直接引用拒绝。包 README 与 collaboration 子系统参考页列出相同 allowlist。
