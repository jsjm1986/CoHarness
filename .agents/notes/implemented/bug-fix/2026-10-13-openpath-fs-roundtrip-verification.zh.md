# Agent Note: host.openPath 经文件系统验证客户端路径

Status: implemented

[English](2026-10-13-openpath-fs-roundtrip-verification.md) | 中文

## 问题

`host.openPath` 与 `host.fileApplications` 接受浏览器载荷携带的任意绝对路径字符串，直接交给原生 opener 或处理器查询。`authorizePersonalConfiguration` 拦住了协作调用方，但受信任的本地客户端仍能指名组合文件系统无权管辖的路径——远程工作区路径、规范目标落在别处的符号链接、或任何部署从未担保过的 Host 路径。上游 `SessionController.verifyDesktopPath`（两个 alpha 发布均含）封堵了这个缺口。

## 决策

在 opener 或处理器查询接受客户端路径前，`verifyDesktopPath` 要求它经 `ctx.fs` 往返：`processPathFromHostPath` 必须把解析后的绝对路径映射进文件系统的执行世界，且 `fs.resolve` + `fs.processPath` 必须报告回相同的 Host 路径。未映射或重映射的路径以 `bad-request` 失败，文件系统故障呈现为 `internal`，中止呈现为 `cancelled`。没有 `fs` 能力的部署没有可验证的文件系统权威，其注入的 opener 保留原有信任。

两个携带客户端路径的表面——`host.openPath` 与 `host.fileApplications` RPC——执行验证；由服务端解析的目标（`agentPreset.openDocument` 的 preset 目录、`settings.openDocument` 的 provider 物化路径）不携带客户端路径，不做该检查。

## 考虑的替代方案

**在 `openTarget` 内部验证。** 已否决：`agentPreset.openDocument` 与 `settings.openDocument` 经同一 helper 携带服务端解析路径，这些路径合理存在于 fs 权威之外（随附 preset 目录）；边界应位于客户端路径进入的 RPC 表面，与上游的方法级验证一致。

**`ctx.fs` 缺席时拒绝。** 已否决：fs 在本组合中是可选能力（`ctx.get('fs')`），部署合理地可以只挂载注入 opener；移除其桌面手势是行为回退而非安全收益。

## 影响

指名组合文件系统无法担保路径的载荷会在任何原生命令执行前以 `bad-request` 失败；可往返的路径——包括经 `resolve` 规范化的相对路径——原样打开。spec 夹具必须使用规范路径：macOS 上 `/tmp/x` realpath 为 `/private/tmp/x`，这正是本检查所拒绝的。

## 验证

`packages/host/apiproxy/tests/native-open-policy.spec.ts` 覆盖验证后的绝对/相对路径交接、`open` 与 `reveal` 两种动作的未映射/重映射 `bad-request` 拒绝、空路径、文件系统往返失败的 `internal` 呈现，以及 `fileApplications` 的同等验证。`api-proxy-workspace.spec.ts` 在真实 `LocalFileSystem` 上以规范临时路径验证放行路径。

## 相关

- [文件系统能力 seam](../architecture/2026-06-17-filesystem-capability-seam.zh.md) — 拥有本检查使用的 `processPath`/`processPathFromHostPath` 词表。
