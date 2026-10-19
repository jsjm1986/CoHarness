# Agent Note: 后台 job id 采用随机短 UUID，而非按 kind 划分的计数器

Status: implemented

[English](2026-10-18-job-id-format.md) | 中文

## 问题

`LocalJobRegistry` 过去用按 kind 划分的计数器生成 job id：进程中的第一个 bash job 总是 `bash-1`。计数器使 id 在注册表生命周期之间可预测——重启后的注册表会重新发出 `bash-1`，而调用方可能仍持有上一轮 `bash-1` 的引用——也让每个消费方测试依赖生成顺序而非返回的句柄。同一个 `JobId` 必须在工具结果、注册表记录、`JobEvent` 载荷和每个控制工具中指代同一次执行；当注册表与调用方的生命周期不一致时，进程内序号无法保证这一点。

## 决策

`LocalJobRegistry.start()` 生成 `${spec.kind}-${randomUUID().replaceAll('-', '').slice(0, 16)}`，并在候选 id 已被同一注册表持有时重试。计数器 map 已移除。id 分配仍发生在生产方 starter 运行之前，因此 starter 抛出时不会留下任何注册记录，容量拒绝也仍先于分配。`JobId` 仍是不透明的品牌字符串；只有生成方式变了，`<kind>-<short-uuid>` 形态记录在品牌、`dsh-jobs` 契约与 [jobs 子系统页面](../../../../docs/subsystems/jobs.zh.md) 中。

同一个 `JobId` 在所有可见位置标识同一次执行：`start()` 返回值、生产方的 `JobHandle.id`、`registered`/`settled`/`output` `JobEvent` 载荷中的 `job.id`、`job_list`、`job_output`、`job_kill` 与完成通知。访问仍按所有者授权；id 的随机性不是保密边界。

有界完成通知不再发出被截断的 id。当连 `background job <id>\nDone; job_output.` 都超出生产方的 `outputLimitBytes` 时，`dsh-tool-jobs` 退化为 `background job ended; use job_list for id.`——预算更小时只剩 `job_list`——因为 16 位十六进制后缀的一部分无法标识 job。

Session 身份规范化识别 `<kind>-<16 位十六进制>` 的 job id：`redactSessionSnapshotIds` 从字面载荷中挖掘 job 复合标识，并与既有 uuid 类别一同折叠为 `{{id:N}}` 令牌，使录制的 session 保持规范化不动点。回放侧车文件通过 `{{fromRequest:(…-[0-9a-f]{16})}}` 占位符指名运行期 id；已提交的 session 夹具保留其录制文本，不做改写。

实时 job 从未从 Session 历史恢复——重新打开的会话不暴露任何 job——本次变更也未引入持久化。新建注册表上的 `jobs.list()` 为空。

## 考虑的替代方案

- **保留按 kind 划分的计数器**——已拒绝：id 空间随进程重置，重启冲突不可避免；消费方测试还必须复现生成顺序而不是读取返回的句柄。
- **完整 UUID**——已拒绝：36 字符的 id 会膨胀每一处模型可见文本（确认消息、`job_id` 参数、通知、`job_list` 行）；16 位十六进制后缀在冲突概率可忽略的同时还能放进有界通知。
- **把 job 记录持久化进 Session 日志**——超出范围而拒绝：没有消费方从历史重建实时工作，因此 id 只需要跨重启唯一的生成方式，不需要持久化记录。

## 后果

测试与消费方无法再预测 id：它们传递返回的 `JobId`，或从启动结果中复制 `job_id` 参数。编排 `job_output` 或 `job_kill` 的回放式 session 场景通过 `{{fromRequest:…}}` 占位符解析生成的 id。`snapshots/session/background-confinement-failure/` 与 `snapshots/session/background-job-admission/` 下已提交的 `session.v7.jsonl` 夹具仍携带录制的 `bash-1` 文本，在下一次重录前会与规范化回放输出不匹配；这是有意保留未改写的。面向用户的迁移步骤见 [v0.2.1-alpha.1 升级指南](../../../../docs/upgrade-guide/v0.2.1-alpha.1/job-id-identity/guide.zh.md)。

## 验证

`packages/jobs/jobs-local/tests/jobs.spec.ts` 按 kind 固定 `/^<kind>-[0-9a-f]{16}$/` 形态，证明第二个注册表不会重发相同的第一个 id，并通过强制 `randomUUID` 冲突验证重试不会替换存活 job。消费方 spec 从启动结果或 `jobs.list()` 捕获 id；`packages/test-support/session-snapshot/tests/identity.spec.ts` 覆盖结构化字段与字面文本中的 job 复合标识脱敏。

## 相关

- [通用长时间运行工具运行时](2026-06-20-generic-long-running-tool-runtime.zh.md)——该生成方式所服务的生产方/注册表约定。
- [job 注册表 seam](2026-07-26-job-registry-seam.zh.md)——注册表所在的三包布局。
