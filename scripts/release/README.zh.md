# 发布证据

[English](README.md) | 中文

## 概述

发布需要已经验收的上游决定，以及对应候选提交和已测试产物的 CI 证据。各发布家族的 workflow 负责打包和注册表写入。本参考定义就绪输入，不代表任何发行已经验收，也不能补足缺失的环境证明。

## 目录

- [候选与证据](#candidate-identity)
- [失败与恢复](#release-failures)
- [验证归属](#verification-owner)

<a id="candidate-identity"></a>

## 候选与证据

发布 workflow 的 `evidence_runs` 输入用逗号分隔同一提交的 CI run ID。认证后的准备步骤下载 `gate-evidence-*` 产物，写入 `.artifacts/release-evidence/readiness.json`。发布 job 还消费当前运行中已完成的打包或 wheel 包验证 job，不重新构建这些产物。

[验证要求](requirements.ts)从候选差异推导必需证明，报告不能删除检查。[守卫](readiness.ts)在注册表写入前核对实际 job 与运行、已下载报告原文、环境和产物 SHA-256 清单。报告稳定字段保留结论与身份；墙钟耗时、时间戳和 runner 实例属于观察字段。

上游对齐发行必须唯一匹配一份 manifest（元数据清单）：`targetVersion` 负责 dsh，`releaseVersions` 标识其他家族。普通产品发行需要一份已验收记录，其中 `accepted.upstreamCommit` 是上游基线，`accepted.localCommit` 是候选的祖先提交。当前上游目标必须仍等于已验收目标。变化路径必须有归属记录，包括重命名两侧和 vendor 输入。这些字段记录经过审查的事实，复制无关运行的字段不能满足守卫。

<a id="release-failures"></a>

## 失败与恢复

记录缺失或歧义、决定待审、验收为空、输入未认领、提交不符、产物变化、检查失败或环境无效都会阻止发布。修正记录或验证本身，然后产生新证据。存量失败和环境缺失不构成豁免。不得将上游目标变化改称普通产品发行。

改写时间戳版本的旧基线不能代替已提交的家族版本。旧发布器也调用共享守卫，已验收发布由受保护的家族 workflow 负责。Native 发行遵循[现有验证器](../../native/system/scripts/verify-release.mjs)中的版本与 tag 规则。

<a id="verification-owner"></a>

## 验证归属

Linux 源码审计、两个 SDK、Gateway、Admin UI 和 Android 消费方各自提供证据。Wine 不能替代原生 Windows。内核隔离和真实 Provider 调用必须由各自 workflow 证明。普通 debug APK 和模拟器桥接测试不能证明真实推送送达，后者需要指定测试设备及已启用的推送服务。发布维护者负责这些依赖环境的验收，以及受保护环境的最终批准。

[决策注记](../../.agents/notes/implemented/process/2026-09-21-candidate-bound-gate-evidence.zh.md)解释保留上游执行器和影子选检的原因。[就绪测试](readiness.spec.ts)中的单元测试和可执行拒绝案例不连接注册表即可验证守卫行为。
