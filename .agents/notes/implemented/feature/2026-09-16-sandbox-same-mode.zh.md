# Agent Note: 重复沙箱模式无需审批

Status: implemented

[English](2026-09-16-sandbox-same-mode.md) | 中文

## 问题

模型可能在 `danger-full-access` 已生效时重复传入 `sandbox_permissions: danger-full-access`。拒绝该调用会阻止已获授权的工作，却没有阻止任何权限增加。

## 决策

当请求模式与生效模式相同时，`approveEscalation` 立即返回生效模式。bash 工具在该路径上保留一项成对校验豁免：精确重复可以省略 `justification`，但显式传入的空白或仅含空白的 `justification` 一律被拒绝（`invalid justification: expected a non-empty sentence`）。[文件系统家族](2026-07-14-cross-family-fs-sandbox.zh.md)在所有请求上仍要求参数成对出现。更宽模式仍需审批；更窄和不支持的目标仍然失败。这部分取代了[沙箱决策](../../archived/feature/2026-07-06-sandbox.md)中的非放宽请求拒绝规则；其约束与逐调用审批决策仍然有效。

## 考虑过的替代方案

**拒绝所有非放宽请求。** 即使没有请求额外权限，冗余参数也会导致调用失败。

**再次请求审批。** 现有权限已经足够，再次提示不会增加授权。

## 影响

Bash 和文件系统工具无需审批服务或 agent 即可接受重复生效模式。共享单元测试覆盖两个已公布目标，两个工具消费方均执行重复模式，`fs-same-mode` ACP 快照验证没有审批事件的无限制写入并检查生成文件。
