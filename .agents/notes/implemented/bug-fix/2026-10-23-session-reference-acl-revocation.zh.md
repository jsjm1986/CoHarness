# Agent Note：发布前重新检查会话引用权限

Status: implemented

[English](2026-10-23-session-reference-acl-revocation.md) | 中文

## 问题

引用准备可能在读取投影表层或保存完整快照时等待。会话若在这些异步操作期间变为不可读，只在准备开始时取得的准入结果可能让内容在撤权后仍被发布。

## 决策

[`dsh-session-reference`](../../../../packages/context/session-reference/README.zh.md) 在操作开始时记录是否需要协作权限。标题投影后再次过滤候选会话；读取前检查全部引用，读取结束后、保存溢出快照前再次检查，发布模型上下文前再检查一次。会话被撤权、授权失败或提供方消失都会拒绝整次准备。完整快照沿用相同的批量检查；授权错误不会携带提供方诊断信息。未组合 collaboration 的组合继续使用可信调用方行为。

最后一次成功授权响应是发布检查点。ACL 变更和会话日志发布并不组成跨进程事务。

## 考虑过的替代方案

**只在读取前授权。** 缓慢的会话读取或溢出文件保存可能在撤权后才结束，并暴露过期快照。最终批量检查会在这些等待阶段观察权限变化。

**逐个引用会话单独授权。** 这会让远程授权调用数随引用数量增长。每个阶段执行一次批量检查既能限制调用数量，也能在任一会话被拒绝时整体阻止结果。

## 后果

组合 collaboration 的引用准备最多进行三次批量授权调用，调用次数不随引用数量增长。异步读取或保存溢出快照期间观测到撤权后，所有引用内容都会被阻止进入模型请求，目标轮次失败。候选发现会在异步标题投影后增加一次最终批量检查。

## 验证

[`session-reference.spec.ts`](../../../../packages/context/session-reference/tests/session-reference.spec.ts) 暂停来源读取与溢出文件保存，同时撤销访问；测试也会卸载授权提供方并检查错误已净化。[Headless 快照](../../../../snapshots/session/session-reference-acl-revocation/snapshot.yml) 使用已发布 profile 和外部 ACL 夹具，在准备期间撤销权限；持久化 Session 必须在模型请求或引用上下文发布前结束。
