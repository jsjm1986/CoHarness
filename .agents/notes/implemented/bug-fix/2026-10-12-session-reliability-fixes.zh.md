# Agent Note: 会话可靠性修复——唤醒上限、可执行文件错误、Team opaque 内容、goal 撤回、计划评审取消

Status: implemented

[English](2026-10-12-session-reliability-fixes.md) | 中文

## 问题

五个相互独立的可靠性缺陷，全部由上游源码比对确认：

1. `tool-jobs` 把 `maxConsecutiveWakes` 默认上限设为 10，链式使用后台任务的无人值守 agent 在第十一次完成后静默停摆。
2. `terminal-controller` 的 shell 探测与 SSH helper 用 `instanceof` 识别 `SubprocessExecutableNotFoundError`，跨 peer realm 时失效，本该报"可执行文件缺失"的场景冒出了未分类错误。
3. `agent-team` 用 `z.object().loose()` 校验未知插件内容块，该校验会重建对象，mailbox 折叠时丢失 own `__proto__` 键与其他特殊 own 属性。
4. `goal-round-driver` 在取消后把已撤回 goal 尝试的排队 Round 提示词留在 agent inbox 中，之后的人类输入排在一条死消息后面等待。
5. `plan-mode` 把用户放弃的 `exit_plan_mode` 评审当作工具失败，轮次无法结算且产生错误结果。

## 决策

1. 移植上游 `b6775f6d4f5` 及 `2d653be7b0e`：去掉 `.default(10)`，唤醒投递默认不封顶，运维方仍可设置 `maxConsecutiveWakes`。
2. 移植上游 `f37f19ab43a`：两个消费方按 `name` 匹配可执行文件错误，把 `SubprocessExecutableNotFoundError` 移出 `peerRequiredHostExports`，并新增 `requiredServicePeers` 策略通道，让 `api-terminal-controller` 在只剩 type 导入的情况下保留 `dsh-subprocess` peer 声明。
3. 把上游 `1e6630a8568` 适配到 CoHarness fold 架构：对未知内容块只校验 `type` 标签、原样保留解码后的对象，已知变体仍走严格校验。上游的 projection checkpoint 版本提升不适用——CoHarness 每次 fold 都从日志重建状态，没有需要作废的 checkpoint 版本。
4. 移植上游 `9a8d21dfe75`：idle 检查点上，与已启用 goal revision 精确匹配的已取消尝试会暂停该 goal；仍排队的尝试消息从 `agent.inbox` 移除；结算失败时告警并撤防。
5. 移植上游 `18a4bc4093c`：`exit_plan_mode` 输出 schema 接受 `{ approved: boolean }`；`UserQuestionError` `ASK_CANCELLED` 结束当前轮次并返回 `{ approved: false }`，计划模式保持激活；其他错误继续抛出。

## 备选方案

**保留较小的默认唤醒上限。** 否决：上限会让依赖唤醒的无人值守链静默停摆，需要边界的运维方仍可显式设置；上游评审后收敛为默认不封顶。

**可执行文件错误继续用 `instanceof`。** 否决：peer realm 复制是受支持的组合方式，身份判断不可靠；依赖门禁现在用 `requiredServicePeers` 而非 peer-required export 记录同一规则。

**沿用上游的 projection checkpoint 版本提升。** 否决：CoHarness 没有需要作废的持久化 projection checkpoint——fold 是纯重放，校验标签并保留解码值就是完整移植。

## 影响

无人值守 agent 默认对每次完成都唤醒；配置了上限时保留其停摆语义。可执行文件缺失在所有 realm 上都报为缺失。Team mailbox fold 保留含 own `__proto__` 在内的 opaque 插件 JSON。取消排队中的 goal Round 会撤回其 inbox 提示词，人类输入紧随其后执行。放弃计划评审以否定结果结算轮次，而非报错。

## 验证

`tool-jobs`/`goal`/`plan`/`agent-team`/`terminal-controller`/`ssh` 共 799 个测试；`verify-package-dependencies` 44 个 spec 测试加上覆盖 63 个包的实际门禁；`exit_plan_mode` 集成测试证明放弃评审在不发起新模型请求的情况下结束轮次；goal 回归测试证明排队 Round 撤回后人类输入正常执行。

## 相关

- [持久化路径安全修复](2026-10-12-durable-path-safety-fixes.zh.md)——同一 alpha.2 对齐行动。
- 上游提交：`b6775f6d4f5`、`2d653be7b0e`、`f37f19ab43a`、`1e6630a8568`、`9a8d21dfe75`、`18a4bc4093c`。
