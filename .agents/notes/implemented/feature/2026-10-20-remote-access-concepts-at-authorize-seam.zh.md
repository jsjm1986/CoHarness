# Agent Note：remote-access 概念落在协作授权接缝上

Status: implemented

[English](2026-10-20-remote-access-concepts-at-authorize-seam.md) | 中文

## Problem

上游 `api/remote-access` 是一个通用的端点/action/资源 RBAC 子系统，宿主服务判定非 owner 调用、过滤列表并提供每 peer 的访问快照。本分支已通过 `authorizeTypertRemote` 与协作 authority 授权同样的操作；问题是哪些上游概念缺失，而不是复制哪个包。

## Decision

保持 `apiproxy` 主权，把上游概念映射到现有的协作接缝上：

- **每个主体的访问快照** —— `CollaborationAuthority.capabilities()` 与 `collaborationCapabilities(participant)` 在本地推导 scope 允许的 action 类别（`personal` → 全部动词，`ro` → `read`，`rw` → `read`/`write`/`approve`，`manage` 取决于 scope 授权）。会话级规则仍由 `authorize()` 判定。
- **业务方自持的方法 ACL** —— `registerRemoteSessionPolicy(endpoint, policy)` 让 Host 扩展在内建 `REMOTE_SESSION_POLICIES` 表之外声明 Session 级 Remote 端点；`lookupRemoteSessionPolicy` 对分发、`remoteSessionId` 与 `mapRemoteSessionIds` 一并解析两者。重复声明会抛错——一个端点只有一个访问类所有者。
- **分发前的判定** —— `authorizeTypertRemote` 不变：进程级读取/操作、注册表授权端点、manager/personal 配置类别仍对已捕获 authority 做门禁，Session 级调用仍带着策略的执行归因走 `authority.authorize`。

## Alternatives considered

整体移植 `packages/api/remote-access` 会在协作 authority 旁边产生第二套授权栈——同一批操作出现两条判定路径，两者必然漂移。上游的快照帧与授权流（`follow()`/`REMOTE_ACCESS_SNAPSHOT_KEY`）与参与者已通过 `participant.scope` 和网关 `access` 响应获知的内容重复；上游按资源种类的 role 对象在这里没有对应物，因为本分支的资源模型是根继承的 Session ACL 与四个 action 类别。

## Consequences

Consumer 获得一个不经过 wire 的能力投影可用于 UI 门禁；Host 扩展无需修改中央表即可声明 Session 级 ACL。`capabilities()` 中的 `manage` 仅是 scope 级许可——需要确定性的调用方仍须调用 `authorize()`。

## Verification

`client-session-routing.spec` 覆盖注册、重复拒绝以及经由已注册策略的 wire 映射；`collaboration-gateway.spec` 覆盖 `capabilities()` 对 personal、`rw`、托管、`ro` 参与者的推导，且全程不接触网关。
