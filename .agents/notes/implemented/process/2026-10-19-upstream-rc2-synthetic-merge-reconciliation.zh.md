# Agent Note: 上游 rc.2 合成合并对账收口

Status: implemented

[English](2026-10-19-upstream-rc2-synthetic-merge-reconciliation.md) | 中文

## Problem

`dsh-v0.2.1-rc.2` 吸收以单个合成三方合并提交（`9221e43aee9`）落地，对账暴露出一类仅靠文件台账防不住的损伤：单侧覆盖。凡共享文件中上游副本赢得合并，我方那一半——package.json 依赖段、`dsh` 注入块、tsconfig 生成区标记、baseline 指纹、reference 清单——被整段丢弃；这些文件在读取被丢半边的门禁跑起来之前仍能编译。第二类是过期决策残留：`gen-upstream-alignment-matrix.ts` 手工覆盖行仍记录着 `not-carried` 判定，而对应包（`api/session-controller`、`boot/config-editor`）已被合并实际携带；主权清单也仍把 33 个盘上实存的包标为 `upstreamOnly`。

## Decision

按归属对账，不按 diff 文本对账。每件受损产物回到其所属契约裁决：

- package.json 依赖段取 HEAD~1 依赖区与上游有效新增条目的并集，绝不单侧直取；`verify-package-dependencies` 随后证明政策表。
- `dsh`/`dsh.client` 块恢复为 HEAD~1 形态，除非该包 `src` 确实吸收了需要新声明的上游代码。
- 与我方机制重复的 upstreamOnly 包（`schedule/tool-schedule` vs `dsh-schedule` 自注册、`client/store` vs `client/runtime`、`client/ui-chat` vs `client/ui-conversation`）摘除而非遮蔽。
- experimental 降级包按业主决策分流：仍以原位出货的 7 个保留原目录并在原位吸收上游增量；出货面无引用的 5 个跟随降级。
- 合并误删的我方独文件（119 个源码/规范/政策基线，含 1,542 个归档笔记三元组）从 HEAD~1 恢复；与 tag 核对过确属上游删除的维持删除。
- 生成目录、tsconfig paths、对齐矩阵在每次源侧修复后从源重新生成，不做手工补丁。
- 对齐矩阵中已携带的行必须与清单、磁盘一致；`verify-upgrade-records` 拒绝已携带却仍标 `not-carried` 的包，因此过期覆盖行是删除而非改字充数。

## Alternatives considered

**逐个文件修到最近的门禁过线。** 拒绝：这正是本笔记要防的残留形态——`not-carried` 行原地改字而不与清单对账、依赖被加在政策要求 peer+dev 的位置。每个修复必须指名其所属契约，否则下一轮审计会重新发现漂移。

**保留上游独物与我方机制并存。** 拒绝：两套会话状态源、两套 schedule 工具注册无论挂哪个都是正确性隐患，且 `verify-upstream-sovereignty` 无法对一个既携带又拒绝的包定级。

**以合并冲突标记为损伤边界。** 拒绝：有损伤的合并全是干净采纳——无标记——因此审计边界是"HEAD~1 半边消失且无业主决策的文件"，机械化枚举而非凭口味复审。

## Consequences

分支以全部记录门禁绿收口：`verify-upgrade-records`（22 份）、`verify-upstream-sovereignty`（44 tracked / 252 adapted / 51 owned / 2 replaced / 41 upstream-only）、`verify-package-dependencies`、`verify-cordis-config`、`verify-md-links`、全量 typecheck 与 lint、变更面聚焦测试集。[审计覆盖笔记](2026-10-15-upstream-alignment-coverage-gaps.zh.md)持有审计侧教训；本笔记持有合并侧教训——任何合成合并之后，第一轮验证是针对 HEAD~1 归属的损伤普查，而非代码评审。验收 runbook 继续把快照重录与生产健康检查放在发布时刻。
